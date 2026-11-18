import { randomUUID } from 'node:crypto';
import type { Transaction } from 'sequelize';
import { JournalEntry, JournalLine } from '../../models';
import { audit } from '../../utils/audit';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../utils/errors';
import { financialYearOf } from '../../utils/numberSequences';
import type { Ctx } from '../../types/context';
import { moneyTx } from '../payments/payments.shared';
import { AUDIT, ERR, MAX_JOURNAL_LINES, NOTIFY, PERM, ENTITY, APPROVAL_TYPES } from './accounts.constants';
import { lockBooks } from './accounts.chart';
import { hashLines, periodLocked, resolveLines, validateLines, type RawLine } from './accounts.engine.core';
import { postDraft, reverseEntry } from './accounts.engine';
import { isLocked } from './accounts.engine.lock';
import { CODE_RE } from './accounts.lookup';
import { accountsPorts, approvalOf } from './accounts.ports';
import { invalidState, n, societyIdOf, societyToday } from './accounts.shared';
import { getJournal } from './accounts.journal.read';
import type { CreateJournalBody, UpdateJournalBody } from './accounts.journal.validation';

/**
 * 13.1b manual journals (sections 5.1, 6.1, 8.11): drafts, submit through module 14 (`MANUAL_JOURNAL`), cancel, reverse. Money
 * is never written here: posting is `postDraft`, reversal is `reverseEntry(..., { viaManualRoute: true })`. Lines of a pending or
 * posted entry never change (triggers), draft lines are replaced as a set.
 */

const userId = (ctx: Ctx): number => {
  if (!ctx.user) throw new ForbiddenError('PERMISSION_DENIED', 'Sign in to continue');
  return ctx.user.id;
};
const stale = () =>
  new ConflictError(ERR.staleVersion, 'This journal was changed by someone else; reload it');
const lineBad = (message: string, field: string) =>
  new UnprocessableError(ERR.journalLineInvalid, message, [{ field, message }]);

/** Shape of draft lines (BR-13-1) and the manual-route rule that a line carries a numeric code, never a system key. */
function toRaw(lines: CreateJournalBody['lines']): RawLine[] {
  if (lines.length < 2) throw lineBad('A journal needs at least 2 lines', 'lines');
  if (lines.length > MAX_JOURNAL_LINES)
    throw lineBad(`A journal has at most ${MAX_JOURNAL_LINES} lines`, 'lines');
  return lines.map((l, i) => {
    if (l.debitPaise > 0 === l.creditPaise > 0)
      throw lineBad('Exactly one of debit and credit must be above zero', `lines[${i}]`);
    if (!CODE_RE.test(l.ledgerAccountCode))
      throw new UnprocessableError(ERR.unknownLedgerCode, `Unknown ledger code ${l.ledgerAccountCode}`, [
        { field: `lines[${i}].ledgerAccountCode`, message: 'Use a 4 digit code such as 5330 or 1110-001' },
      ]);
    return {
      ledgerAccountCode: l.ledgerAccountCode,
      debitPaise: l.debitPaise,
      creditPaise: l.creditPaise,
      fundId: l.fundId ?? null,
      lineNarration: l.lineNarration ?? null,
    };
  });
}

async function assertDate(societyId: number, date: string, books: Parameters<typeof isLocked>[0]) {
  const today = await societyToday(societyId);
  if (date > today)
    throw new ValidationError([{ field: 'date', message: 'The date cannot be in the future' }]);
  if (isLocked(books, date)) throw periodLocked(date);
}

async function insertLines(
  societyId: number,
  entryId: number,
  entryDate: string,
  lines: Awaited<ReturnType<typeof resolveLines>>,
  t: Transaction,
) {
  await JournalLine.bulkCreate(
    lines.map(l => ({
      societyId,
      journalEntryId: entryId,
      lineNo: l.lineNo,
      ledgerAccountId: n(l.account.id),
      fundId: l.fundId,
      debitPaise: l.debitPaise,
      creditPaise: l.creditPaise,
      entryDate,
      lineNarration: l.lineNarration,
    })),
    { transaction: t },
  );
}

async function lockEntry(societyId: number, id: number, t: Transaction): Promise<JournalEntry> {
  const e = await JournalEntry.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!e) throw new NotFoundError(ERR.journalNotFound, 'Journal entry not found');
  return e;
}

/** Only a DRAFT can be edited, submitted or cancelled; a POSTED entry answers JOURNAL_IMMUTABLE. */
function requireDraft(e: JournalEntry, immutableForPosted: boolean): void {
  if (e.status === 'DRAFT') return;
  if (e.status === 'POSTED' && immutableForPosted)
    throw new ConflictError(ERR.journalImmutable, 'A posted journal cannot be changed; reverse it instead');
  throw invalidState(`A ${e.status} journal cannot be changed`);
}
function requireMaker(ctx: Ctx, e: JournalEntry): void {
  if (!e.createdBy || n(e.createdBy) !== userId(ctx))
    throw new ForbiddenError('NOT_DRAFT_MAKER', 'Only the person who created this draft can do this');
}

const auditDraft = (ctx: Ctx, action: string, e: JournalEntry, t: Transaction, reason?: string) =>
  audit(
    ctx,
    {
      action,
      entityType: ENTITY.journalEntry,
      entityId: n(e.id),
      entityLabel: e.voucherNo ?? e.narration.slice(0, 60),
      societyId: n(e.societyId),
      after: {
        status: e.status,
        voucherType: e.voucherType,
        entryDate: e.entryDate,
        totalPaise: n(e.totalPaise),
        version: n(e.version),
      },
      reason: reason ?? null,
    },
    t,
  );

/** `POST /accounts/journals`: a DRAFT manual journal (may be unbalanced). */
export async function createDraft(ctx: Ctx, body: CreateJournalBody) {
  const societyId = societyIdOf(ctx);
  const maker = userId(ctx);
  const id = await moneyTx(async t => {
    const books = await lockBooks(t, societyId);
    await assertDate(societyId, body.date, books);
    const lines = await resolveLines(societyId, toRaw(body.lines), t);
    const entry = await JournalEntry.create(
      {
        societyId,
        voucherNo: null,
        voucherType: body.voucherType,
        entryDate: body.date,
        documentDate: body.date,
        financialYear: financialYearOf(body.date),
        narration: body.narration,
        refType: 'manual_journal',
        refId: randomUUID(),
        linesHash: hashLines(lines),
        instrumentRef: body.instrumentRef ?? null,
        source: 'MANUAL',
        status: 'DRAFT',
        totalPaise: lines.reduce((s, l) => s + l.debitPaise, 0),
        reversalOfId: null,
        reversedByEntryId: null,
        reversedAt: null,
        reversalReason: null,
        approvalRequestId: null,
        rejectionReason: null,
        postedAt: null,
        postedBy: null,
        createdBy: maker,
        updatedBy: maker,
      },
      { transaction: t },
    );
    await insertLines(societyId, n(entry.id), body.date, lines, t);
    await auditDraft(ctx, AUDIT.journalDrafted, entry, t);
    return n(entry.id);
  });
  return getJournal(societyId, id);
}

/** `PATCH /accounts/journals/:id`: maker only, DRAFT only, `version` must match. */
export async function updateDraft(ctx: Ctx, id: number, body: UpdateJournalBody) {
  const societyId = societyIdOf(ctx);
  await moneyTx(async t => {
    const books = await lockBooks(t, societyId);
    const e = await lockEntry(societyId, id, t);
    requireDraft(e, true);
    requireMaker(ctx, e);
    if (n(e.version) !== body.version) throw stale();
    const date = body.date ?? e.entryDate;
    if (body.date || body.lines) await assertDate(societyId, date, books);
    const patch: Partial<JournalEntry> = {
      entryDate: date,
      documentDate: date,
      financialYear: financialYearOf(date),
      voucherType: body.voucherType ?? e.voucherType,
      narration: body.narration ?? e.narration,
      instrumentRef: body.instrumentRef === undefined ? e.instrumentRef : body.instrumentRef,
      version: n(e.version) + 1,
      updatedBy: userId(ctx),
    };
    // draft lines are never updated (trigger): replace them as a set when the lines or the date change
    if (body.lines || date !== e.entryDate) {
      const raw = body.lines
        ? toRaw(body.lines)
        : (
            await JournalLine.findAll({
              where: { journalEntryId: id },
              order: [['lineNo', 'ASC']],
              transaction: t,
            })
          ).map(l => ({
            ledgerAccountId: n(l.ledgerAccountId),
            debitPaise: n(l.debitPaise),
            creditPaise: n(l.creditPaise),
            fundId: l.fundId ? n(l.fundId) : null,
            lineNarration: l.lineNarration,
          }));
      const lines = await resolveLines(societyId, raw, t);
      await JournalLine.destroy({ where: { journalEntryId: id }, transaction: t });
      await insertLines(societyId, id, date, lines, t);
      patch.linesHash = hashLines(lines);
      patch.totalPaise = lines.reduce((s, l) => s + l.debitPaise, 0);
    }
    await e.update(patch, { transaction: t });
    await auditDraft(ctx, AUDIT.journalUpdated, e, t);
  });
  return getJournal(societyId, id);
}

/**
 * `POST /accounts/journals/:id/submit`: balanced, date open, then `approvals.request(MANUAL_JOURNAL)`. A draft that came back
 * with changes requested is resubmitted on the same request. When module 14 auto-approves, the draft is posted in place.
 */
export async function submitDraft(ctx: Ctx, id: number, version: number) {
  const societyId = societyIdOf(ctx);
  const ports = accountsPorts();
  await moneyTx(async t => {
    // lock order (BR-14-14): the open approval request of the entity first, then the books, then the rows
    const open = await ports.approvals.lockOpenForEntity(societyId, ENTITY.journalEntry, id, t);
    const books = await lockBooks(t, societyId);
    const e = await lockEntry(societyId, id, t);
    // the draft's own request, sent back for changes, is resubmitted below; any other open request blocks
    if (open && open.id !== n(e.approvalRequestId ?? 0))
      throw invalidState('This journal is already waiting for approval');
    requireDraft(e, false);
    requireMaker(ctx, e);
    if (n(e.version) !== version) throw stale();
    const stored = await JournalLine.findAll({
      where: { journalEntryId: id },
      order: [['lineNo', 'ASC']],
      transaction: t,
    });
    const raw: RawLine[] = stored.map(l => ({
      ledgerAccountId: n(l.ledgerAccountId),
      debitPaise: n(l.debitPaise),
      creditPaise: n(l.creditPaise),
      fundId: l.fundId ? n(l.fundId) : null,
      lineNarration: l.lineNarration,
    }));
    const totals = validateLines(raw); // 422 JOURNAL_NOT_BALANCED with errors[0] = { field: 'lines', debitPaise, creditPaise }
    await resolveLines(societyId, raw, t); // accounts and funds still postable
    if (isLocked(books, e.entryDate)) throw periodLocked(e.entryDate);
    const input = {
      title: e.narration.slice(0, 200),
      amountPaise: totals.debitPaise,
      payload: { date: e.entryDate },
    };
    // PENDING_APPROVAL first: when module 14 auto-approves, `onApproved` posts the draft inside `request` (BR-14-4)
    await e.update(
      {
        totalPaise: totals.debitPaise,
        version: n(e.version) + 1,
        updatedBy: userId(ctx),
        rejectionReason: null,
        status: 'PENDING_APPROVAL',
      },
      { transaction: t },
    );
    await auditDraft(ctx, AUDIT.journalSubmitted, e, t);
    if (e.approvalRequestId) await ports.approvals.resubmit(ctx, n(e.approvalRequestId), input, t);
    else {
      const r = await ports.approvals.request(
        ctx,
        { type: APPROVAL_TYPES.manualJournal, entityType: ENTITY.journalEntry, entityId: id, ...input },
        t,
      );
      // an auto-approved draft is posted (immutable) and got its request id from `onJournalApproved`
      if (r.status === 'PENDING')
        await JournalEntry.update({ approvalRequestId: r.id }, { where: { id }, transaction: t });
    }
  });
  return getJournal(societyId, id);
}

/** `DELETE /accounts/journals/:id`: cancels a DRAFT (maker, or a holder of `finance.accounts.approve`). */
export async function cancelDraft(ctx: Ctx, id: number) {
  const societyId = societyIdOf(ctx);
  await moneyTx(async t => {
    await lockBooks(t, societyId);
    const e = await lockEntry(societyId, id, t);
    requireDraft(e, true);
    if (n(e.createdBy) !== userId(ctx) && !ctx.permissions?.has(PERM.accountsApprove))
      throw new ForbiddenError('PERMISSION_DENIED', 'Only the maker or an approver can cancel this draft');
    // a draft that came back with changes requested still has its module 14 request: close it too
    if (e.approvalRequestId)
      await accountsPorts().approvals.cancel(ctx, n(e.approvalRequestId), 'Draft cancelled', t);
    await e.reload({ transaction: t });
    if (e.status !== 'CANCELLED')
      await e.update({ status: 'CANCELLED', updatedBy: userId(ctx) }, { transaction: t });
    await auditDraft(ctx, AUDIT.journalCancelled, e, t);
  });
  return getJournal(societyId, id);
}

/** `POST /accounts/journals/:id/reverse`: BR-13-5 through the engine; the reverser is never the maker of the original. */
/**
 * Cheap checks of a reversal that can never succeed (missing, not posted, a reversal, already reversed, system or opening or closing
 * entry, own manual entry), run before the step-up so nobody is asked for a code for a request that is bound to fail.
 */
export async function precheckReverse(ctx: Ctx, id: number): Promise<void> {
  const societyId = societyIdOf(ctx);
  const original = await JournalEntry.findOne({ where: { id, societyId } });
  if (!original) throw new NotFoundError(ERR.journalNotFound, 'Journal entry not found');
  if (original.status !== 'POSTED') throw invalidState('Only a posted journal can be reversed');
  if (original.reversalOfId)
    throw new UnprocessableError(ERR.reversalNotAllowed, 'A reversal cannot be reversed');
  if (original.reversedByEntryId)
    throw new ConflictError(ERR.journalAlreadyReversed, 'The entry is already reversed');
  if (original.source === 'SYSTEM' || ['OPENING_BALANCE', 'CLOSING'].includes(original.voucherType))
    throw new UnprocessableError(ERR.reversalNotAllowed, 'This entry cannot be reversed by hand');
  if (original.source === 'MANUAL' && original.createdBy && n(original.createdBy) === userId(ctx))
    throw new ConflictError(ERR.makerChecker, 'The person who created this journal cannot reverse it');
}

export async function reverseManual(
  ctx: Ctx,
  id: number,
  body: { reversalDate?: string; reason: string; version: number },
) {
  const societyId = societyIdOf(ctx);
  const me = userId(ctx);
  const res = await moneyTx(async t => {
    const original = await JournalEntry.findOne({ where: { id, societyId }, transaction: t });
    if (!original) throw new NotFoundError(ERR.journalNotFound, 'Journal entry not found');
    if (original.status !== 'POSTED') throw invalidState('Only a posted journal can be reversed');
    if (original.reversalOfId)
      throw new UnprocessableError(ERR.reversalNotAllowed, 'A reversal cannot be reversed');
    if (original.reversedByEntryId)
      throw new ConflictError(ERR.journalAlreadyReversed, 'The entry is already reversed');
    if (n(original.version) !== body.version) throw stale();
    if (original.source === 'MANUAL' && original.createdBy && n(original.createdBy) === me)
      throw new ConflictError(ERR.makerChecker, 'The person who created this journal cannot reverse it');
    if (body.reversalDate && body.reversalDate > (await societyToday(societyId)))
      throw new ValidationError([{ field: 'reversalDate', message: 'The date cannot be in the future' }]);
    return reverseEntry(ctx, id, { date: body.reversalDate, reason: body.reason, viaManualRoute: true }, t);
  });
  return { ...(await getJournal(societyId, id)), reversalEntryId: res.id, reversalVoucherNo: res.voucherNo };
}

// ------------------------------------------------------------------ module 14 callbacks (section 9.3)

/** `onApproved`: posts the draft in place with the approver's context; the approver is never the maker. */
export async function onJournalApproved(ctx: Ctx, entityId: number, t: Transaction): Promise<void> {
  const societyId = societyIdOf(ctx);
  const e = await JournalEntry.findOne({ where: { id: entityId, societyId }, transaction: t });
  if (!e) throw new NotFoundError(ERR.journalNotFound, 'Journal entry not found');
  const a = approvalOf(ctx);
  // module 14 enforces maker-checker (BR-14-7); on auto-approval (no decider) the requester's context runs this
  if (!a && ctx.user && e.createdBy && n(e.createdBy) === ctx.user.id)
    throw new ConflictError(ERR.makerChecker, 'The person who created this journal cannot approve it');
  if (a && !e.approvalRequestId) await e.update({ approvalRequestId: a.requestId }, { transaction: t });
  await postDraft(ctx, entityId, t);
}

async function lockPending(ctx: Ctx, entityId: number, t: Transaction): Promise<JournalEntry | null> {
  const societyId = societyIdOf(ctx);
  const e = await lockEntry(societyId, entityId, t);
  return e.status === 'PENDING_APPROVAL' ? e : null;
}

/** `onRejected`: REJECTED with the reason, audited, the maker is told after commit. */
export async function onJournalRejected(
  ctx: Ctx,
  entityId: number,
  reason: string,
  t: Transaction,
): Promise<void> {
  const e = await lockPending(ctx, entityId, t);
  if (!e) return;
  await e.update({ status: 'REJECTED', rejectionReason: reason.slice(0, 500) }, { transaction: t });
  await auditDraft(ctx, AUDIT.journalRejected, e, t, reason);
  if (e.createdBy)
    t.afterCommit(() =>
      accountsPorts().notifications.send(NOTIFY.journalRejected, [n(e.createdBy)], {
        entryId: n(e.id),
        narration: e.narration,
        date: e.entryDate,
        reason,
      }),
    );
}

/** `onChangesRequested`: back to DRAFT (the maker edits and resubmits on the same request). */
export async function onJournalChangesRequested(ctx: Ctx, entityId: number, t: Transaction): Promise<void> {
  const e = await lockPending(ctx, entityId, t);
  if (!e) return;
  await e.update({ status: 'DRAFT', version: n(e.version) + 1 }, { transaction: t });
  await auditDraft(ctx, AUDIT.journalUpdated, e, t, 'Changes requested');
}

/** `onCancelled` (maker withdrew the request, or the draft was cancelled): CANCELLED. */
export async function onJournalCancelled(ctx: Ctx, entityId: number, t: Transaction): Promise<void> {
  const societyId = societyIdOf(ctx);
  const e = await lockEntry(societyId, entityId, t);
  if (e.status !== 'PENDING_APPROVAL' && e.status !== 'DRAFT') return;
  await e.update({ status: 'CANCELLED' }, { transaction: t });
  await auditDraft(ctx, AUDIT.journalCancelled, e, t);
}

/** `describe`: the facts module 14 shows in the inbox. */
export async function describeJournal(entityId: number) {
  const e = await JournalEntry.findByPk(entityId);
  if (!e) return [];
  const count = await JournalLine.count({ where: { journalEntryId: entityId } });
  return [
    { label: 'Narration', value: e.narration, kind: 'text' as const },
    { label: 'Date', value: e.entryDate, kind: 'date' as const },
    { label: 'Voucher type', value: e.voucherType, kind: 'text' as const },
    { label: 'Total', value: String(n(e.totalPaise)), kind: 'money' as const },
    { label: 'Lines', value: String(count), kind: 'text' as const },
  ];
}
