import { Op } from 'sequelize';
import { Invoice, Society, sequelize } from '../../models';
import { logger } from '../../lib/logger';
import { systemCtx, type Ctx } from '../../types/context';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { isJobAllowed } from '../societies/societies.guard';
import { FEATURES } from './billing.constants';
import { touchDuesAfterBatch } from './billing.dues.cache';
import { interestBearingInvoiceIds, balanceEventsFor } from './billing.latefee.events';
import {
  interestDedupeKey,
  lateFeeDedupeKey,
  planFlatFee,
  planInterest,
  previousMonthEnd,
  type InterestPolicy,
  type LateFeeInvoice,
} from './billing.latefee.calc';
import { lockInvoice, lockUnitRow } from './billing.invoices.shared';
import { policyFor } from './billing.latefee-policy.service';
import { debitNotes } from './billing.latefee.notes';
import { societyToday } from './billing.setup.shared';
import { formatRupees } from '../../lib/money';

/**
 * The monthly late fee job (F15, BR-11-51 to BR-11-56). On day 1 of the month it charges, for every society whose status allows
 * ordinary jobs, simple interest for the window up to the end of the previous month or the flat fee, as an issued debit note
 * with reason `INTEREST` or `LATE_FEE` (`dedupeKey` `INT:<invoiceId>:<windowEnd>` or `LFEE:<invoiceId>`). Each invoice is its own
 * transaction under the invoice lock, so a crash leaves the others done and a repeat run changes nothing (idempotent by dedupe
 * key, `interestPostedToDate` and `lateFeeChargedAt`).
 */
export interface LateFeeResult {
  windowEnd: string;
  checked: number;
  interestNotes: number;
  lateFeeNotes: number;
  skipped: Record<string, number>;
  failed: number;
}

const emptyResult = (windowEnd: string): LateFeeResult => ({
  windowEnd,
  checked: 0,
  interestNotes: 0,
  lateFeeNotes: 0,
  skipped: {},
  failed: 0,
});
const bump = (r: LateFeeResult, reason: string) => {
  r.skipped[reason] = (r.skipped[reason] ?? 0) + 1;
};

const policyOf = (p: Awaited<ReturnType<typeof policyFor>>): InterestPolicy | null =>
  p
    ? {
        policyType: p.policyType,
        interestRatePct: p.interestRatePct,
        interestFrom: (p.interestFrom as InterestPolicy['interestFrom']) ?? null,
        flatFeePaise: p.flatFeePaise === null ? null : Number(p.flatFeePaise),
        graceDays: Number(p.graceDays),
        minChargePaise: Number(p.minChargePaise),
      }
    : null;

const factsOf = (inv: Invoice, hasIb: boolean): LateFeeInvoice => ({
  invoiceType: inv.invoiceType,
  status: inv.status,
  isDisputed: Boolean(inv.isDisputed),
  invoiceDate: inv.invoiceDate,
  dueDate: inv.dueDate,
  settledOn: inv.settledOn,
  interestPostedToDate: inv.interestPostedToDate,
  lateFeeChargedAt: inv.lateFeeChargedAt,
  hasInterestBearingCharge: hasIb,
});

/**
 * Charges one society for the month that ended before `today` (society-local date, default now). Returns what it did.
 * `ctx` is the system context of the job.
 */
export async function runLateFeesForSociety(
  societyId: number,
  opts: { today?: string; ctx?: Ctx } = {},
): Promise<LateFeeResult> {
  const today = opts.today ?? (await societyToday(societyId));
  const windowEnd = previousMonthEnd(today);
  const result = emptyResult(windowEnd);
  if (!(await isFeatureOn(societyId, FEATURES.lateFeeAndInterest))) {
    bump(result, 'FEATURE_OFF');
    return result;
  }
  const ctx = opts.ctx ?? systemCtx('billing-late-fees');
  const policyRow = await policyFor(societyId, windowEnd);
  const policy = policyOf(policyRow);
  const policyId = policyRow?.id ?? null;
  if (!policy || policy.policyType === 'NONE') {
    bump(result, 'POLICY_NONE');
    return result;
  }
  const candidates = await Invoice.findAll({
    where: {
      societyId,
      status: { [Op.ne]: 'CANCELLED' },
      isDisputed: false,
      dueDate: { [Op.lt]: windowEnd },
      ...(policy.policyType === 'FLAT'
        ? { lateFeeChargedAt: null, invoiceType: { [Op.ne]: 'OPENING' } }
        : {
            [Op.and]: [
              sequelize.literal(
                '(outstandingPaise > 0 OR (settledOn > dueDate AND (interestPostedToDate IS NULL OR interestPostedToDate < DATE_SUB(settledOn, INTERVAL 1 DAY))))',
              ),
              sequelize.literal(`(interestPostedToDate IS NULL OR interestPostedToDate < '${windowEnd}')`),
            ],
          }),
    },
    attributes: ['id'],
    order: [['id', 'ASC']],
  });
  let issued = 0;
  for (const c of candidates) {
    result.checked += 1;
    try {
      const outcome = await chargeInvoice(ctx, societyId, Number(c.id), policy, policyId, windowEnd, today);
      if (outcome === 'INTEREST') result.interestNotes += 1;
      else if (outcome === 'LATE_FEE') result.lateFeeNotes += 1;
      else bump(result, outcome);
      if (outcome === 'INTEREST' || outcome === 'LATE_FEE') issued += 1;
    } catch (err) {
      result.failed += 1;
      logger.error({ err, invoiceId: Number(c.id) }, 'billing:late-fees failed for an invoice');
    }
  }
  if (issued) await touchDuesAfterBatch(societyId); // 8.26: once per committed batch
  return result;
}

type Outcome = 'INTEREST' | 'LATE_FEE' | string;

async function chargeInvoice(
  ctx: Ctx,
  societyId: number,
  invoiceId: number,
  policy: InterestPolicy,
  policyId: number | null,
  windowEnd: string,
  today: string,
): Promise<Outcome> {
  return sequelize.transaction(async t => {
    // lock order (section 13): the unit row, then the invoice
    const peek = await Invoice.findOne({
      where: { id: invoiceId, societyId },
      attributes: ['unitId'],
      transaction: t,
    });
    if (!peek) return 'NOT_FOUND';
    await lockUnitRow(societyId, Number(peek.unitId), t);
    const inv = await lockInvoice(societyId, invoiceId, t);
    if (policy.policyType === 'FLAT') {
      const hasIb = (await interestBearingInvoiceIds(societyId, [invoiceId])).has(invoiceId);
      const plan = planFlatFee(factsOf(inv, hasIb), policy, today);
      if (plan.skip) return plan.skip;
      const dedupeKey = lateFeeDedupeKey(invoiceId);
      const note = await debitNotes.issueForLateFee(
        ctx,
        {
          societyId,
          invoice: inv,
          reasonCode: 'LATE_FEE',
          amountPaise: plan.feePaise,
          dedupeKey,
          interestFromDate: null,
          interestToDate: null,
          lateFeePolicyId: policyId,
          remarks: `Late fee ${formatRupees(plan.feePaise)} for ${inv.invoiceNo}`,
        },
        t,
      );
      inv.lateFeeChargedAt = today;
      await inv.save({ transaction: t });
      return note.created ? 'LATE_FEE' : 'ALREADY_CHARGED';
    }
    const events = (await balanceEventsFor(societyId, [inv])).get(invoiceId) ?? [];
    const plan = planInterest(factsOf(inv, true), policy, events, windowEnd, today);
    if (plan.skip) return plan.skip;
    const note = await debitNotes.issueForLateFee(
      ctx,
      {
        societyId,
        invoice: inv,
        reasonCode: 'INTEREST',
        amountPaise: plan.interestPaise,
        dedupeKey: interestDedupeKey(invoiceId, plan.to),
        interestFromDate: plan.from,
        interestToDate: plan.to,
        lateFeePolicyId: policyId,
        remarks: `Interest ${policy.interestRatePct}% p.a. from ${plan.from} to ${plan.to} on ${inv.invoiceNo}`,
      },
      t,
    );
    inv.interestPostedToDate = plan.to;
    await inv.save({ transaction: t });
    return note.created ? 'INTEREST' : 'ALREADY_CHARGED';
  });
}

/** The job: every society whose status allows ordinary jobs (BR-11-56), one after the other; a failure never stops the rest. */
export async function runLateFeesAll(today?: string): Promise<Record<number, LateFeeResult>> {
  const out: Record<number, LateFeeResult> = {};
  const societies = await Society.findAll({ attributes: ['id', 'status'], order: [['id', 'ASC']] });
  for (const s of societies) {
    if (!isJobAllowed(s.status, 'normal')) continue;
    try {
      out[s.id!] = await runLateFeesForSociety(s.id!, today ? { today } : {});
    } catch (err) {
      logger.error({ err, societyId: s.id }, 'billing:late-fees failed for a society');
    }
  }
  return out;
}
