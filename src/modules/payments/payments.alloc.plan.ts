import { Op } from 'sequelize';
import { Collection, CollectionRequest, Invoice } from '../../models';
import { invoices } from '../billing/billing.public';
import { ERR, REQUEST_MAX_PAISE, type AllocationMode } from './payments.constants';
import { UnprocessableError } from '../../utils/errors';
import type { AllocationPlan, OpenTarget, PlanLine, Transaction } from './payments.types';
import { n } from './payments.shared';

/**
 * The allocation engine of section 5.3 (BR-12-15 to BR-12-18). `buildPlan` is a pure function: it turns the open targets
 * and the payer's intent into a plan (lines plus the part that goes to advance). `loadOpenTargets` reads the targets
 * inside the caller's transaction with row locks, so the plan is made from fresh outstanding amounts.
 */
export interface PlanInput {
  mode: AllocationMode;
  amountPaise: number;
  /** `OLDEST_FIRST`: paise to put against dues; default the whole amount. The rest is advance. */
  duesPaise?: number;
  selected?: { targetType: 'INVOICE' | 'COLLECTION_REQUEST'; id: number; amountPaise: number }[];
  /** Everything to advance (BR-12-13, BR-12-14). */
  advanceOnly?: boolean;
}

const byDueThenIssueThenId = (a: OpenTarget, b: OpenTarget) =>
  a.dueDate.localeCompare(b.dueDate) || a.issueDate.localeCompare(b.issueDate) || a.id - b.id;

export function buildPlan(open: OpenTarget[], input: PlanInput): AllocationPlan {
  const total = input.amountPaise;
  if (!Number.isSafeInteger(total) || total < 1)
    throw new UnprocessableError(ERR.nothingToPay, 'The amount must be at least 1 paise');
  if (input.advanceOnly) return { lines: [], advancePaise: total };
  const lines: PlanLine[] = [];
  if (input.mode === 'OLDEST_FIRST') {
    let left = Math.min(input.duesPaise ?? total, total);
    // collection requests are never chosen automatically (BR-12-15)
    const invs = open
      .filter(o => o.targetType === 'INVOICE' && o.outstandingPaise > 0)
      .sort(byDueThenIssueThenId);
    for (const o of invs) {
      if (left <= 0) break;
      const take = Math.min(left, o.outstandingPaise);
      lines.push({ targetType: 'INVOICE', id: o.id, label: o.label, amountPaise: take });
      left -= take;
    }
  } else {
    // SELECTED: honoured exactly, but never above what is still open (BR-12-16): the surplus goes to advance
    const seen = new Set<string>();
    for (const s of input.selected ?? []) {
      const key = `${s.targetType}:${s.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = open.find(o => o.targetType === s.targetType && o.id === s.id);
      const take = t ? Math.min(s.amountPaise, t.outstandingPaise) : 0;
      if (t && take > 0)
        lines.push({ targetType: s.targetType, id: s.id, label: t.label, amountPaise: take });
    }
  }
  const allocated = lines.reduce((a, l) => a + l.amountPaise, 0);
  if (allocated > total)
    throw new UnprocessableError(
      ERR.amountExceedsDue,
      'The chosen items add up to more than the amount paid',
    );
  return { lines, advancePaise: total - allocated };
}

/** Remaining ask of a collection request (BR-12-18): FIXED = ask minus paid; MIN and VOLUNTARY have only the per-payment cap. */
export function requestOutstanding(
  r: { amountPaise: number; paidPaise: number; status: string },
  mode: string,
): number {
  if (r.status !== 'OPEN' && r.status !== 'PART_PAID') return 0;
  if (mode === 'FIXED_PER_UNIT') return Math.max(0, r.amountPaise - r.paidPaise);
  return REQUEST_MAX_PAISE;
}

/**
 * Open invoices (not disputed, visible to the payer) and, for `SELECTED`, the named collection requests of the unit.
 * Rows are read with `FOR UPDATE` in id order. `visibilityUserId` limits invoices to what that user may pay (tenants).
 */
export async function loadOpenTargets(
  societyId: number,
  unitId: number,
  t: Transaction,
  opts: { visibilityUserId?: number; requestIds?: number[] } = {},
): Promise<OpenTarget[]> {
  const listed = await invoices.listOpen(
    societyId,
    unitId,
    opts.visibilityUserId ? { payerUserId: opts.visibilityUserId } : {},
  );
  const ids = listed.filter(i => !i.isDisputed).map(i => i.id);
  const out: OpenTarget[] = [];
  if (ids.length) {
    const rows = await Invoice.findAll({
      where: { id: { [Op.in]: ids }, societyId, unitId },
      order: [['id', 'ASC']],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    for (const i of rows) {
      if (i.status !== 'ISSUED' && i.status !== 'PARTIALLY_PAID') continue;
      const outstanding = n(i.outstandingPaise);
      if (outstanding <= 0) continue;
      out.push({
        targetType: 'INVOICE',
        id: n(i.id),
        label: i.invoiceNo,
        dueDate: i.dueDate,
        issueDate: i.invoiceDate,
        outstandingPaise: outstanding,
      });
    }
  }
  if (opts.requestIds?.length) {
    const reqs = await CollectionRequest.findAll({
      where: { id: { [Op.in]: opts.requestIds }, societyId, unitId },
      order: [['id', 'ASC']],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const cols = await Collection.findAll({
      where: { id: { [Op.in]: [...new Set(reqs.map(r => n(r.collectionId)))] }, societyId },
      transaction: t,
      paranoid: false,
    });
    for (const r of reqs) {
      const c = cols.find(x => n(x.id) === n(r.collectionId));
      if (!c) continue;
      const outstanding = requestOutstanding(
        { amountPaise: n(r.amountPaise), paidPaise: n(r.paidPaise), status: r.status },
        c.amountMode,
      );
      if (outstanding > 0)
        out.push({
          targetType: 'COLLECTION_REQUEST',
          id: n(r.id),
          label: c.title,
          dueDate: c.dueDate,
          issueDate: c.dueDate,
          outstandingPaise: outstanding,
        });
    }
  }
  return out;
}
