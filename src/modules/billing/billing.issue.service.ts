import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import {
  BillingRun,
  BillingRunItem,
  ChargeHead,
  Invoice,
  InvoiceLine,
  Resident,
  Society,
  User,
  sequelize,
} from '../../models';
import { now } from '../../lib/clock';
import { emitToRoom } from '../../lib/realtime';
import { logger } from '../../lib/logger';
import type { Ctx } from '../../types/context';
import { systemCtx } from '../../types/context';
import { audit } from '../../utils/audit';
import { UnprocessableError } from '../../utils/errors';
import { financialYearOf, nextNumber } from '../../utils/numberSequences';
import { residents } from '../residents/residents.public';
import { isJobAllowed } from '../societies/societies.guard';
import { holidays, units as unitsApi } from '../society-setup/society-setup.public';
import { AUDIT, ISSUE_BATCH_ITEMS, REALTIME, type LineKind } from './billing.constants';
import { addDaysYmd, periodLabelOf } from './billing.calc.period';
import { touchDues } from './billing.dues.cache';
import { unitLedger } from './billing.ledger.service';
import { billingPorts, type JournalLine } from './billing.ports';
import { itemTotals } from './billing.runs.compute';
import { activeIssues, enqueueIssue } from './billing.runs.service';
import {
  emitRunUpdated,
  loadBillingSettings,
  societyToday,
  type BillingSettings,
} from './billing.runs.shared';

/**
 * The issue service (BR-11-37 to BR-11-39). The issue job takes the READY items ordered by unit label and issues each in its own
 * transaction: lock the unit, lock the item, dedupe, number, invoice and lines, ledger entry, journal, item ISSUED. A rolled-back
 * transaction gives its number back, so numbers stay gapless; a crash is resumed by running the job again (ISSUED items are
 * never touched twice). Side effects (realtime, notifications) run after commit.
 */
interface SnapshotLine {
  lineKind: LineKind;
  chargeHeadId: number | null;
  headKey: string | null;
  description: string;
  quantity: string | null;
  ratePaise: number | null;
  amountPaise: number;
  isTaxable: boolean;
  billingRuleVersionId: number | null;
  periodFrom: string | null;
  periodTo: string | null;
  prorationDays: number | null;
  periodDays: number | null;
  computation: { readingIds?: number[] } | null;
  ledgerAccountCode: string;
}

export type IssueOutcome = 'ISSUED' | 'EXCLUDED' | 'SKIPPED';

async function runCtx(run: BillingRun): Promise<Ctx> {
  const s = await Society.findByPk(run.societyId);
  return {
    ...systemCtx('issue-run'),
    society: {
      id: run.societyId,
      name: s?.name ?? '',
      status: s?.status ?? 'ACTIVE',
      timezone: s?.timezone ?? 'Asia/Kolkata',
      planKey: '',
    },
  };
}

async function approverActor(run: BillingRun) {
  const u = run.approvedBy ? await User.findByPk(run.approvedBy, { attributes: ['name'] }) : null;
  return { userId: run.approvedBy ?? null, name: u?.name ?? 'Run approver', role: 'approver' };
}

/** BR-11-37: invoice date is society-local today; the due date moves to the next working day when the setting is on. */
export async function dueDateFor(
  societyId: number,
  invoiceDate: string,
  s: BillingSettings,
): Promise<string> {
  const due = addDaysYmd(invoiceDate, s.dueDays);
  return s.shiftDueDateOnHoliday ? holidays.nextWorkingDay(societyId, due) : due;
}

/** Issues one READY item. Exported so that tests can run items in parallel. */
export async function issueItem(
  run: BillingRun,
  itemId: number,
  s: BillingSettings,
  ctx: Ctx,
  actor: { userId: number | null; name: string; role: string },
): Promise<IssueOutcome> {
  const societyId = run.societyId;
  const afterCommit: (() => Promise<void> | void)[] = [];
  const outcome = await sequelize.transaction(async (t): Promise<IssueOutcome> => {
    const peek = await BillingRunItem.findOne({
      where: { id: itemId, billingRunId: run.id!, societyId },
      transaction: t,
    });
    if (!peek || peek.status !== 'READY') return 'SKIPPED';
    try {
      await unitsApi.lockActive(societyId, peek.unitId, t);
    } catch (err) {
      if ((err as { code?: string }).code !== 'UNIT_NOT_FOUND') throw err;
      await peek.update(
        { status: 'EXCLUDED', excludedReason: 'UNIT_ARCHIVED', version: peek.version + 1 },
        { transaction: t },
      );
      await BillingRun.update(await itemTotals(run.id!, t), { where: { id: run.id! }, transaction: t });
      return 'EXCLUDED';
    }
    const item = await BillingRunItem.findOne({ where: { id: itemId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!item || item.status !== 'READY') return 'SKIPPED';
    if (item.billToResidentId === null || item.billToRelation === null)
      throw new UnprocessableError('NO_BILL_TO', `No bill-to party for ${item.unitLabel}`);

    const dedupeKey =
      run.runType === 'REGULAR'
        ? `REG:${item.unitId}:${run.periodStart}:${item.billToResidentId}`
        : `SUP:${run.id}:${item.unitId}:${item.billToResidentId}`;
    if (await Invoice.findOne({ where: { societyId, dedupeKey }, attributes: ['id'], transaction: t })) {
      await item.update(
        { status: 'EXCLUDED', excludedReason: 'ALREADY_BILLED', version: item.version + 1 },
        { transaction: t },
      );
      await BillingRun.update(await itemTotals(run.id!, t), { where: { id: run.id! }, transaction: t });
      return 'EXCLUDED';
    }

    const today = await societyToday(societyId);
    const invoiceDate = today < run.billDate ? run.billDate : today;
    const dueDate = await dueDateFor(societyId, invoiceDate, s);
    const lines = (
      typeof item.linesSnapshot === 'string' ? JSON.parse(item.linesSnapshot) : item.linesSnapshot
    ) as SnapshotLine[];
    if (await billingPorts().journal.isDateLocked(societyId, invoiceDate))
      throw new UnprocessableError('PERIOD_LOCKED', 'The books are locked for the invoice date');

    const previousDues =
      Number(
        await Invoice.sum('outstandingPaise', {
          where: {
            societyId,
            unitId: item.unitId,
            billToResidentId: item.billToResidentId,
            status: { [Op.in]: ['ISSUED', 'PARTIALLY_PAID'] },
          },
          transaction: t,
        }),
      ) || 0;
    const invoiceNo = await nextNumber(societyId, 'INVOICE', {
      date: invoiceDate,
      prefix: s.invoicePrefix,
      transaction: t,
    });

    const sum = (kind: LineKind) =>
      lines.filter(l => l.lineKind === kind).reduce((a, l) => a + l.amountPaise, 0);
    const cgst = sum('CGST');
    const sgst = sum('SGST');
    const taxable = lines.filter(l => l.isTaxable).reduce((a, l) => a + l.amountPaise, 0);
    const total = Number(item.totalPaise);
    const society =
      cgst + sgst > 0 ? await Society.findByPk(societyId, { attributes: ['gstin'], transaction: t }) : null;
    const invoice = await Invoice.create(
      {
        societyId,
        invoiceNo,
        financialYear: financialYearOf(invoiceDate),
        invoiceType: run.runType,
        billingRunId: run.id!,
        dedupeKey,
        unitId: item.unitId,
        unitLabel: item.unitLabel,
        billToResidentId: item.billToResidentId,
        billToRelation: item.billToRelation,
        billToName: item.billToName ?? '',
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        invoiceDate,
        dueDate,
        description: null,
        refType: null,
        refId: null,
        societyGstin: society?.gstin ?? null,
        gstApplied: item.gstApplied,
        thresholdBasePaise: Number(item.thresholdBasePaise),
        taxableValuePaise: taxable,
        subtotalPaise: Number(item.subtotalPaise),
        cgstPaise: cgst,
        sgstPaise: sgst,
        taxPaise: cgst + sgst,
        roundOffPaise: Number(item.roundOffPaise),
        totalPaise: total,
        previousDuesPaise: previousDues,
        debitedPaise: 0,
        creditedPaise: 0,
        writtenOffPaise: 0,
        paidPaise: 0,
        outstandingPaise: total,
        nonInterestBearingPaise: 0,
        status: 'ISSUED',
        settledOn: null,
        isDisputed: false,
        interestPostedToDate: null,
        lateFeeChargedAt: null,
        reminderCount: 0,
        lastReminderAt: null,
        pdfFileId: null,
        pdfStatus: 'PENDING',
        issuedAt: now(),
        cancelledAt: null,
        createdBy: run.approvedBy,
        updatedBy: run.approvedBy,
        version: 1,
      } as never,
      { transaction: t },
    );
    await InvoiceLine.bulkCreate(
      lines.map((l, i) => ({
        societyId,
        invoiceId: invoice.id!,
        billingNoteId: null,
        lineNo: i + 1,
        lineKind: l.lineKind,
        chargeHeadId: l.chargeHeadId,
        headKey: l.headKey,
        description: l.description,
        quantity: l.quantity,
        ratePaise: l.ratePaise,
        amountPaise: l.amountPaise,
        isTaxable: l.isTaxable,
        billingRuleVersionId: l.billingRuleVersionId,
        periodFrom: l.periodFrom,
        periodTo: l.periodTo,
        prorationDays: l.prorationDays,
        periodDays: l.periodDays,
        refInvoiceLineId: null,
        computation: l.computation,
        ledgerAccountCode: l.ledgerAccountCode,
        creditedPaise: 0,
        createdBy: run.approvedBy,
        updatedBy: run.approvedBy,
      })) as never,
      { transaction: t },
    );
    await unitLedger.post(
      ctx,
      {
        unitId: item.unitId,
        entryType: 'INVOICE',
        refType: 'invoice',
        refId: invoice.id!,
        debitPaise: total,
        creditPaise: 0,
        date: invoiceDate,
        narration: `Invoice ${invoiceNo}`,
      },
      t,
    );
    await billingPorts().journal.post(
      ctx,
      {
        date: invoiceDate,
        voucherType: 'INVOICE',
        refType: 'invoice',
        refId: invoice.id!,
        narration: `Invoice ${invoiceNo} ${item.unitLabel}`,
        lines: await journalLines(societyId, item.unitId, lines, total),
      },
      t,
    );
    const readingIds = lines.flatMap(l => l.computation?.readingIds ?? []);
    if (readingIds.length) await billingPorts().meters.markBilled(ctx, readingIds, run.runLabel, t);

    await item.update(
      { status: 'ISSUED', invoiceId: invoice.id!, version: item.version + 1 },
      { transaction: t },
    );
    await BillingRun.increment('issuedCount', { by: 1, where: { id: run.id! }, transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.invoiceIssued,
        entityType: 'invoice',
        entityId: invoice.id!,
        entityLabel: invoiceNo,
        societyId,
        actor,
        after: { runId: run.id, unitId: item.unitId, totalPaise: total },
      },
      t,
    );
    afterCommit.push(() => {
      emitToRoom(`society:${societyId}:finance`, REALTIME.invoiceUpdated, {
        invoiceId: invoice.id,
        unitId: item.unitId,
        status: 'ISSUED',
        outstandingPaise: total,
      });
      emitToRoom(`unit:${item.unitId}`, REALTIME.duesChanged, { unitId: item.unitId });
    });
    afterCommit.push(() =>
      notifyIssued(societyId, item.unitId, item.billToResidentId!, item.billToRelation!, invoiceDate, {
        invoiceNo,
        amountPaise: total,
        dueDate,
        periodLabel: periodLabelOf(run.cycle, run.periodStart),
      }),
    );
    return 'ISSUED';
  });
  if (outcome === 'ISSUED' || outcome === 'EXCLUDED')
    for (const f of afterCommit)
      try {
        await f();
      } catch (err) {
        logger.error({ err }, 'billing after-issue side effect failed');
      }
  return outcome;
}

/** Journal of BR-11-70 / example I: Dr 1300 total; Cr each charge to its head account; Cr 2310 and 2320; round-off Cr or Dr 4990. */
async function journalLines(
  societyId: number,
  unitId: number,
  lines: SnapshotLine[],
  total: number,
): Promise<JournalLine[]> {
  const headIds = [...new Set(lines.map(l => l.chargeHeadId).filter((x): x is number => x !== null))];
  const funds = new Map(
    (
      await ChargeHead.findAll({
        where: { societyId, id: { [Op.in]: headIds } },
        attributes: ['id', 'fundId'],
      })
    ).map(h => [h.id!, h.fundId]),
  );
  const out: JournalLine[] = [{ accountCode: '1300', debitPaise: total, creditPaise: 0, unitId }];
  for (const l of lines) {
    if (l.lineKind === 'ROUND_OFF' && l.amountPaise < 0)
      out.push({ accountCode: l.ledgerAccountCode, debitPaise: -l.amountPaise, creditPaise: 0, unitId });
    else
      out.push({
        accountCode: l.ledgerAccountCode,
        debitPaise: 0,
        creditPaise: l.amountPaise,
        unitId,
        ...(l.chargeHeadId ? { fundId: funds.get(l.chargeHeadId) ?? null } : {}),
      });
  }
  return out;
}

/** Notification placeholders (section 10): the bill-to resident, plus the other owners with a login for an owner invoice. */
async function notifyIssued(
  societyId: number,
  unitId: number,
  residentId: number,
  relation: string,
  date: string,
  data: Record<string, unknown>,
): Promise<void> {
  const ids = new Set<number>();
  const r = await Resident.findOne({
    where: { id: residentId, societyId },
    attributes: ['userId'],
    paranoid: false,
  });
  if (r?.userId) ids.add(r.userId);
  if (relation !== 'TENANT') {
    const owners = await residents.listForUnit(societyId, unitId, { relation: ['OWNER', 'CO_OWNER'], date });
    for (const o of owners) if (o.userId) ids.add(o.userId);
  }
  if (ids.size) await billingPorts().notifications.send('billing.invoice_issued', [...ids], data);
}

/** The issue job (`billing:issue-run`). Throws after recording `lastError` so that the queue retries. */
export async function issueRun(runId: number): Promise<void> {
  let run = await BillingRun.findByPk(runId);
  if (!run || run.status !== 'ISSUING') return;
  activeIssues.add(runId);
  try {
    const s = await loadBillingSettings(run.societyId);
    const ctx = await runCtx(run);
    const actor = await approverActor(run);
    const ids = await BillingRunItem.findAll({
      where: { billingRunId: runId, status: 'READY' },
      attributes: ['id'],
      order: [
        ['unitLabel', 'ASC'],
        ['id', 'ASC'],
      ],
      raw: true,
    });
    for (let i = 0; i < ids.length; i += ISSUE_BATCH_ITEMS) {
      let issuedInBatch = 0;
      try {
        for (const row of ids.slice(i, i + ISSUE_BATCH_ITEMS))
          if ((await issueItem(run, row.id!, s, ctx, actor)) === 'ISSUED') issuedInBatch += 1;
      } finally {
        if (issuedInBatch) touchDues(run.societyId); // 8.26: once per committed batch
      }
      run = (await BillingRun.findByPk(runId))!;
      emitRunUpdated(run);
    }
    await finishRun(runId, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Issue failed';
    logger.error({ err, runId }, 'billing issue failed');
    await BillingRun.update({ lastError: message.slice(0, 500) }, { where: { id: runId } });
    throw err;
  } finally {
    activeIssues.delete(runId);
  }
}

/** ISSUING to ISSUED when no item is left READY (BR-11-37). */
async function finishRun(runId: number, ctx: Ctx): Promise<void> {
  const done = await sequelize.transaction(async t => {
    const run = await BillingRun.findByPk(runId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!run || run.status !== 'ISSUING') return null;
    if (await BillingRunItem.count({ where: { billingRunId: runId, status: 'READY' }, transaction: t }))
      return null;
    const totals = await itemTotals(runId, t);
    const issued = await BillingRunItem.count({
      where: { billingRunId: runId, status: 'ISSUED' },
      transaction: t,
    });
    await run.update(
      {
        ...totals,
        issuedCount: issued,
        status: 'ISSUED',
        issuedAt: now(),
        lastError: null,
        version: run.version + 1,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.runIssued,
        entityType: 'billing_run',
        entityId: run.id!,
        entityLabel: run.runLabel,
        societyId: run.societyId,
        actor: { userId: null, name: 'System', role: 'system' },
        after: { issued, totalPaise: totals.totalPaise },
      },
      t,
    );
    emitRunUpdated(run, t);
    return run;
  });
  if (!done) return;
  const to = [...new Set([done.createdBy, done.approvedBy].filter((x): x is number => x !== null))];
  if (to.length)
    await billingPorts().notifications.send('billing.run_issued', to, {
      runLabel: done.runLabel,
      issuedCount: done.issuedCount,
      totalPaise: Number(done.totalPaise),
    });
}

/** `billing:start-scheduled-issues`: APPROVED runs whose bill date has come become ISSUING and the issue job is enqueued. */
export async function startScheduledIssues(societyId?: number): Promise<number[]> {
  const where: Record<string, unknown> = { status: 'APPROVED' };
  if (societyId) where.societyId = societyId;
  const candidates = await BillingRun.findAll({ where, attributes: ['id', 'societyId', 'billDate'] });
  const started: number[] = [];
  for (const c of candidates) {
    const soc = await Society.findByPk(c.societyId, { attributes: ['status'] });
    if (!soc || !isJobAllowed(soc.status, 'normal') || soc.status === 'CLOSED') continue;
    if ((await societyToday(c.societyId)) < c.billDate) continue;
    const run = await sequelize.transaction(async (t: Transaction) => {
      const r = await BillingRun.findByPk(c.id!, { transaction: t, lock: t.LOCK.UPDATE });
      if (!r || r.status !== 'APPROVED') return null;
      await r.update(
        { status: 'ISSUING', issueStartedAt: now(), version: r.version + 1 },
        { transaction: t },
      );
      await audit(
        systemCtx('start-scheduled-issues'),
        {
          action: AUDIT.runUpdated,
          entityType: 'billing_run',
          entityId: r.id!,
          entityLabel: r.runLabel,
          societyId: r.societyId,
          actor: { userId: null, name: 'System', role: 'system' },
          after: { status: 'ISSUING' },
        },
        t,
      );
      emitRunUpdated(r, t);
      enqueueIssue(r, t);
      return r;
    });
    if (run) started.push(run.id!);
  }
  return started;
}
