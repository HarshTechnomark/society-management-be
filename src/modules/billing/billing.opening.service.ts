import { Op } from 'sequelize';
import { Invoice, OpeningBalance, Unit, sequelize } from '../../models';
import { istDate, now } from '../../lib/clock';
import { emitToRoom } from '../../lib/realtime';
import { audit } from '../../utils/audit';
import { pageMeta, type PageMeta } from '../../utils/pagination';
import { ConflictError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { residents } from '../residents/residents.public';
import { units } from '../society-setup/society-setup.public';
import { AUDIT, REALTIME, type OpeningStatus } from './billing.constants';
import { unitLedger } from './billing.ledger.service';
import {
  ACCOUNT,
  LEDGER_ENTITY,
  OPENING_POST_BATCH,
  type OpeningBalanceRowDto,
  type OpeningTotals,
} from './billing.ledger.types';
import { cancelOpeningArrearsInvoice, createOpeningArrearsInvoice } from './billing.opening.invoice';
import {
  assertAsOfDate,
  invalidState,
  openingNotFound,
  openingTotals,
  staleVersion,
} from './billing.opening.shared';
import { billingPorts } from './billing.ports';
import type { Transaction } from './billing.types';

export { importOpening, openingTemplate } from './billing.opening.import';

/** Opening balances (section 8.23, BR-11-65, BR-11-66, BR-11-71): list, post at go-live, reverse and delete. */

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toDto(r: OpeningBalance, label: string | undefined): OpeningBalanceRowDto {
  return {
    id: Number(r.id),
    unitId: r.unitId === null ? null : Number(r.unitId),
    unitLabel: label ?? r.unitLabelInput,
    unitLabelInput: r.unitLabelInput,
    importRowNo: Number(r.importRowNo),
    asOfDate: r.asOfDate,
    arrearsPrincipalPaise: Number(r.arrearsPrincipalPaise),
    arrearsInterestPaise: Number(r.arrearsInterestPaise),
    advancePaise: Number(r.advancePaise),
    status: r.status,
    validationError: r.validationError,
    invoiceId: r.invoiceId === null ? null : Number(r.invoiceId),
    postedAt: iso(r.postedAt),
    reversedAt: iso(r.reversedAt),
    version: Number(r.version),
  };
}

export async function listOpening(
  societyId: number,
  q: { status?: OpeningStatus; page: number; limit: number },
): Promise<{ items: OpeningBalanceRowDto[]; totals: OpeningTotals; pagination: PageMeta }> {
  const where = { societyId, ...(q.status ? { status: q.status } : {}) };
  const { rows, count } = await OpeningBalance.findAndCountAll({
    where,
    order: [
      ['importRowNo', 'ASC'],
      ['id', 'ASC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const ids = [
    ...new Set(
      rows
        .map(r => r.unitId)
        .filter((x): x is number => x !== null)
        .map(Number),
    ),
  ];
  const labels = new Map(
    (ids.length
      ? await Unit.findAll({ where: { societyId, id: ids }, attributes: ['id', 'label'] })
      : []
    ).map(u => [Number(u.id), u.label]),
  );
  return {
    items: rows.map(r => toDto(r, r.unitId === null ? undefined : labels.get(Number(r.unitId)))),
    totals: await openingTotals(societyId),
    pagination: pageMeta(q.page, q.limit, count),
  };
}

// ------------------------------------------------------------------ post
const noBillTo = (label: string) =>
  new UnprocessableError('NO_BILL_TO', `No owner or tenant to bill for ${label}`, [
    { field: 'unit', message: `${label} has no owner or tenant on record` },
  ]);

const periodLocked = (date: string) =>
  new UnprocessableError('PERIOD_LOCKED', 'The books are locked for this date', [
    { field: 'asOfDate', message: `Books are locked on ${date}` },
  ]);

interface BatchResult {
  posted: number;
  arrearsPaise: number;
  advancePaise: number;
}

/** One batch in its own transaction; only rows that are still `DRAFT` are taken (so a re-run skips what is done). */
async function postBatch(ctx: Ctx, societyId: number, ids: number[]): Promise<BatchResult> {
  const out: BatchResult = { posted: 0, arrearsPaise: 0, advancePaise: 0 };
  const ports = billingPorts();
  const userId = ctx.user?.id ?? null;
  const today = istDate(now());
  await sequelize.transaction(async t => {
    const rows = await OpeningBalance.findAll({
      where: { societyId, id: { [Op.in]: ids }, status: 'DRAFT' },
      order: [['id', 'ASC']],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const advanceUnits: number[] = [];
    const touched: number[] = [];
    for (const row of rows) {
      const unit = await units.lockActive(societyId, Number(row.unitId), t); // lock order: unit first (section 13)
      const principal = Number(row.arrearsPrincipalPaise);
      const interest = Number(row.arrearsInterestPaise);
      const advance = Number(row.advancePaise);
      const arrears = principal + interest;
      if (arrears > 0) {
        const bill =
          (await residents.billToFor(unit.id, row.asOfDate)) ?? (await residents.billToFor(unit.id, today));
        if (!bill) throw noBillTo(unit.label);
        const inv = await createOpeningArrearsInvoice(
          ctx,
          societyId,
          {
            openingBalanceId: Number(row.id),
            unit: { id: unit.id, label: unit.label },
            principalPaise: principal,
            interestPaise: interest,
            asOfDate: row.asOfDate,
            billTo: { residentId: bill.residentId, name: bill.name, relation: bill.relation },
          },
          t,
        );
        await ports.journal.post(
          ctx,
          {
            date: row.asOfDate,
            voucherType: 'OPENING_BALANCE',
            refType: 'opening_balance',
            refId: Number(row.id),
            narration: `Opening arrears ${inv.invoiceNo}`,
            lines: [
              { accountCode: ACCOUNT.receivable, debitPaise: arrears, creditPaise: 0, unitId: unit.id },
              {
                accountCode: ACCOUNT.openingAdjustment,
                debitPaise: 0,
                creditPaise: arrears,
                unitId: unit.id,
              },
            ],
          },
          t,
        );
        row.invoiceId = inv.invoiceId;
        out.arrearsPaise += arrears;
      } else {
        await unitLedger.post(
          ctx,
          {
            unitId: unit.id,
            entryType: 'OPENING_BALANCE',
            refType: 'opening_balance',
            refId: Number(row.id),
            debitPaise: 0,
            creditPaise: advance,
            date: row.asOfDate,
            narration: `Advance brought forward as of ${row.asOfDate}`,
          },
          t,
        );
        await ports.journal.post(
          ctx,
          {
            date: row.asOfDate,
            voucherType: 'OPENING_BALANCE',
            refType: 'opening_balance',
            refId: Number(row.id),
            narration: `Opening advance of ${unit.label}`,
            lines: [
              {
                accountCode: ACCOUNT.openingAdjustment,
                debitPaise: advance,
                creditPaise: 0,
                unitId: unit.id,
              },
              { accountCode: ACCOUNT.advances, debitPaise: 0, creditPaise: advance, unitId: unit.id },
            ],
          },
          t,
        );
        await ports.payments.creditOpeningAdvance(
          ctx,
          { unitId: unit.id, amountPaise: advance, asOfDate: row.asOfDate, openingBalanceId: Number(row.id) },
          t,
        );
        advanceUnits.push(unit.id);
        out.advancePaise += advance;
      }
      row.status = 'POSTED';
      row.postedAt = now();
      row.postedBy = userId;
      row.updatedBy = userId;
      row.version = Number(row.version) + 1;
      await row.save({ transaction: t });
      await audit(
        ctx,
        {
          action: AUDIT.openingPosted,
          entityType: LEDGER_ENTITY.openingBalance,
          entityId: Number(row.id),
          entityLabel: unit.label,
          societyId,
          after: {
            unitId: unit.id,
            asOfDate: row.asOfDate,
            arrearsPrincipalPaise: principal,
            arrearsInterestPaise: interest,
            advancePaise: advance,
            invoiceId: row.invoiceId,
          },
        },
        t,
      );
      touched.push(unit.id);
      out.posted++;
    }
    t.afterCommit(() => {
      for (const unitId of touched) emitToRoom(`unit:${unitId}`, REALTIME.duesChanged, { unitId });
      if (advanceUnits.length)
        void ports.payments.queueAdvanceApply(societyId, advanceUnits).catch(() => undefined);
    });
  });
  return out;
}

/**
 * `POST /billing/opening-balances/post` (BR-11-65, BR-11-71): posts every `DRAFT` row in batches of 200, each batch in its
 * own transaction. `confirmTotalPaise` must equal Σ arrears − Σ advance of the draft rows. A run that stops halfway can
 * be repeated: rows already posted are not taken again (the typed total is then the remaining draft total).
 */
export async function postOpening(
  ctx: Ctx,
  societyId: number,
  input: { confirmTotalPaise: number },
): Promise<{ posted: number; totalArrearsPaise: number; totalAdvancePaise: number }> {
  const [invalidCount, drafts] = await Promise.all([
    OpeningBalance.count({ where: { societyId, status: 'INVALID' } }),
    OpeningBalance.findAll({ where: { societyId, status: 'DRAFT' }, order: [['id', 'ASC']] }),
  ]);
  if (invalidCount > 0)
    throw new UnprocessableError(
      'OPENING_BALANCE_HAS_INVALID_ROWS',
      `${invalidCount} rows are invalid. Fix the file and import again, or delete those rows.`,
      [{ field: 'status', message: `${invalidCount} invalid rows` }],
    );
  if (!drafts.length) throw invalidState('There are no draft opening balances to post');
  const net = drafts.reduce(
    (s, r) => s + Number(r.arrearsPrincipalPaise) + Number(r.arrearsInterestPaise) - Number(r.advancePaise),
    0,
  );
  if (input.confirmTotalPaise !== net)
    throw new UnprocessableError(
      'OPENING_BALANCE_TOTAL_MISMATCH',
      'The total you typed does not match the draft rows',
      [
        {
          field: 'confirmTotalPaise',
          message: 'Check the net total (arrears minus advances) and type it again',
        },
      ],
    );
  const dates = new Set(drafts.map(r => r.asOfDate));
  for (const d of dates) {
    await assertAsOfDate(societyId, d);
    if (await billingPorts().journal.isDateLocked(societyId, d)) throw periodLocked(d);
  }
  const total: BatchResult = { posted: 0, arrearsPaise: 0, advancePaise: 0 };
  const ids = drafts.map(r => Number(r.id));
  for (let i = 0; i < ids.length; i += OPENING_POST_BATCH) {
    const r = await postBatch(ctx, societyId, ids.slice(i, i + OPENING_POST_BATCH));
    total.posted += r.posted;
    total.arrearsPaise += r.arrearsPaise;
    total.advancePaise += r.advancePaise;
  }
  return {
    posted: total.posted,
    totalArrearsPaise: total.arrearsPaise,
    totalAdvancePaise: total.advancePaise,
  };
}

// ------------------------------------------------------------------ reverse and delete
const hasPayments = () =>
  new UnprocessableError(
    'OPENING_BALANCE_HAS_PAYMENTS',
    'This arrears invoice has a payment, a credit note or a debit note and can no longer be reversed',
    [{ field: 'id', message: 'Paid, credited or debited arrears cannot be reversed' }],
  );

async function lockRow(
  societyId: number,
  id: number,
  version: number,
  t: Transaction,
): Promise<OpeningBalance> {
  const row = await OpeningBalance.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!row) throw openingNotFound();
  if (Number(row.version) !== version) throw staleVersion();
  return row;
}

/** `POST /billing/opening-balances/:id/reverse` (BR-11-66). Advances are never reversed here. */
export async function reverseOpening(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { reason: string; version: number },
): Promise<OpeningBalanceRowDto> {
  const today = istDate(now());
  const ports = billingPorts();
  const dto = await sequelize.transaction(async t => {
    const peek = await OpeningBalance.findOne({ where: { id, societyId }, transaction: t });
    if (!peek) throw openingNotFound();
    if (peek.status !== 'POSTED') throw invalidState('Only a posted opening balance can be reversed');
    if (Number(peek.advancePaise) > 0)
      throw new UnprocessableError(
        'OPENING_ADVANCE_NOT_REVERSIBLE',
        'An opening advance cannot be reversed. Correct it with an ad-hoc invoice or a refund.',
        [{ field: 'id', message: 'Advance rows are not reversible' }],
      );
    if (await ports.journal.isDateLocked(societyId, today)) throw periodLocked(today);
    // lock order (section 13): open approval, unit, invoice, number sequence, ledger
    const open = peek.invoiceId
      ? await ports.approvals.lockOpenForEntity(societyId, 'invoice', Number(peek.invoiceId), t)
      : null;
    if (open)
      throw new ConflictError(
        'INVOICE_CANCEL_PENDING',
        'A cancellation request is open on this arrears invoice',
      );
    const unit = await units.lockActive(societyId, Number(peek.unitId), t);
    const row = await lockRow(societyId, id, input.version, t);
    if (row.status !== 'POSTED') throw invalidState('Only a posted opening balance can be reversed');
    const invoice = await Invoice.findOne({
      where: { id: row.invoiceId!, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!invoice) throw openingNotFound();
    if (
      Number(invoice.paidPaise) > 0 ||
      Number(invoice.creditedPaise) > 0 ||
      Number(invoice.debitedPaise) > 0 ||
      invoice.status !== 'ISSUED'
    )
      throw hasPayments();
    const total = Number(invoice.totalPaise);
    const { noteNo } = await cancelOpeningArrearsInvoice(ctx, invoice, input.reason, t);
    await unitLedger.post(
      ctx,
      {
        unitId: unit.id,
        entryType: 'ADJUSTMENT',
        refType: 'opening_balance',
        refId: Number(row.id),
        debitPaise: 0,
        creditPaise: total,
        date: today,
        narration: `Opening balance ${invoice.invoiceNo} reversed (${noteNo})`,
      },
      t,
    );
    await ports.journal.post(
      ctx,
      {
        date: today,
        voucherType: 'OPENING_BALANCE',
        refType: 'opening_balance_reversal',
        refId: Number(row.id),
        narration: `Reversal of opening arrears ${invoice.invoiceNo}`,
        lines: [
          { accountCode: ACCOUNT.openingAdjustment, debitPaise: total, creditPaise: 0, unitId: unit.id },
          { accountCode: ACCOUNT.receivable, debitPaise: 0, creditPaise: total, unitId: unit.id },
        ],
      },
      t,
    );
    row.status = 'REVERSED';
    row.activeKey = null;
    row.reversedAt = now();
    row.reversedBy = ctx.user?.id ?? null;
    row.reverseReason = input.reason;
    row.updatedBy = ctx.user?.id ?? null;
    row.version = Number(row.version) + 1;
    await row.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.openingReversed,
        entityType: LEDGER_ENTITY.openingBalance,
        entityId: Number(row.id),
        entityLabel: unit.label,
        societyId,
        reason: input.reason,
        after: { unitId: unit.id, invoiceId: Number(invoice.id), creditNoteNo: noteNo, reversedPaise: total },
      },
      t,
    );
    t.afterCommit(() => emitToRoom(`unit:${unit.id}`, REALTIME.duesChanged, { unitId: unit.id }));
    return toDto(row, unit.label);
  });
  return dto;
}

/** `DELETE /billing/opening-balances/:id`: only a `DRAFT` or `INVALID` row. */
export async function deleteOpening(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number },
): Promise<void> {
  await sequelize.transaction(async t => {
    const row = await lockRow(societyId, id, input.version, t);
    if (row.status !== 'DRAFT' && row.status !== 'INVALID')
      throw invalidState('Only a draft or invalid row can be deleted');
    await row.destroy({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.openingDeleted,
        entityType: LEDGER_ENTITY.openingBalance,
        entityId: id,
        entityLabel: row.unitLabelInput,
        societyId,
        before: {
          status: row.status,
          importRowNo: Number(row.importRowNo),
          arrearsPrincipalPaise: Number(row.arrearsPrincipalPaise),
          arrearsInterestPaise: Number(row.arrearsInterestPaise),
          advancePaise: Number(row.advancePaise),
        },
      },
      t,
    );
  });
}
