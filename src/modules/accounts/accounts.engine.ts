import { Op, type Transaction } from 'sequelize';
import { JournalEntry, JournalLine } from '../../models';
import { now } from '../../lib/clock';
import { NotFoundError, ConflictError } from '../../utils/errors';
import { financialYearOf, nextNumber } from '../../utils/numberSequences';
import type { Ctx } from '../../types/context';
import { AUDIT, ERR, VOUCHER_SERIES, VOUCHER_TYPES } from './accounts.constants';
import { lockBooks } from './accounts.chart';
import {
  announce,
  applyBalances,
  auditEntry,
  hashLines,
  periodLocked,
  resolveLines,
  validateLines,
  type RawLine,
  type ResolvedLine,
} from './accounts.engine.core';
import { firstOpenDate, isLocked } from './accounts.engine.lock';
import { UnprocessableError } from '../../utils/errors';
import { invalidState, isSystemCtx, isYmd, n, societyIdOf, societyToday } from './accounts.shared';
import type { PostJournalInput, PostJournalResult, ReverseJournalInput } from './accounts.types';

export { isDateLocked } from './accounts.engine.lock';
export { ensureBooks } from './accounts.chart';

const lineError = (message: string, field: string) =>
  new UnprocessableError(ERR.journalLineInvalid, message, [{ field, message }]);

/**
 * `journal.post` (section 8.20, BR-13-1 to BR-13-15). Runs inside the caller's transaction `t`: nothing is committed here, and the
 * realtime event and the reports cache touch go out after that transaction commits. The entry is inserted as DRAFT, then its
 * lines, then set to POSTED (so the MySQL triggers see a draft while the lines go in).
 */
export async function postJournal(
  ctx: Ctx,
  input: PostJournalInput,
  t: Transaction,
): Promise<PostJournalResult> {
  const societyId = societyIdOf(ctx);
  // 1. cheap checks, nothing read or written (BR-13-1, BR-13-2)
  if (!isYmd(input.date)) throw lineError('date must be YYYY-MM-DD', 'date');
  if (!(VOUCHER_TYPES as readonly string[]).includes(input.voucherType))
    throw lineError('Unknown voucher type', 'voucherType');
  if (!/^[a-z][a-z_]{1,39}$/.test(input.refType))
    throw lineError('refType must be snake_case, 2 to 40 letters', 'refType');
  const refId = String(input.refId);
  if (!refId || refId.length > 60) throw lineError('refId is required, at most 60 characters', 'refId');
  const raw: RawLine[] = input.lines.map(l => ({ ...l }));
  const totals = validateLines(raw);

  // 2. books: lock the society row, seed the chart once (BR-13-15, lock order of BR-13-10)
  const books = await lockBooks(t, societyId);
  const system = isSystemCtx(ctx);

  // 3. accounts, funds, hash
  const lines = await resolveLines(societyId, raw, t);
  const linesHash = hashLines(lines);

  // 4. idempotency by source (BR-13-6)
  const existing = await JournalEntry.findOne({
    where: { societyId, refType: input.refType, refId, reversalOfId: null, status: { [Op.ne]: 'CANCELLED' } },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (existing) {
    if (existing.status === 'POSTED' && existing.linesHash === linesHash)
      return {
        id: n(existing.id),
        voucherNo: existing.voucherNo!,
        entryDate: existing.entryDate,
        replayed: true,
      };
    throw new ConflictError(
      ERR.journalDuplicateRef,
      `${input.refType} ${refId} was already posted with other lines`,
    );
  }

  // 5. period lock (BR-13-8, BR-13-9)
  let entryDate = input.date;
  if (!input.skipLockCheck && isLocked(books, entryDate)) {
    if (!system) throw periodLocked(entryDate);
    entryDate = firstOpenDate(books, entryDate);
  }
  const narrationRaw = input.narration.trim();
  const narration = (
    narrationRaw.length >= 3 ? narrationRaw : `${narrationRaw} ${input.refType}`.trim()
  ).slice(0, 500);

  // 6. entry, lines, number, POSTED
  const source = input.source ?? (input.refType === 'manual_journal' ? 'MANUAL' : 'SYSTEM');
  const entry = await JournalEntry.create(
    {
      societyId,
      voucherNo: null,
      voucherType: input.voucherType,
      entryDate,
      documentDate: input.date,
      financialYear: financialYearOf(entryDate),
      narration,
      refType: input.refType,
      refId,
      linesHash,
      instrumentRef: input.instrumentRef ?? null,
      source,
      status: 'DRAFT',
      totalPaise: 0,
      reversalOfId: null,
      reversedByEntryId: null,
      reversedAt: null,
      reversalReason: null,
      approvalRequestId: null,
      rejectionReason: null,
      postedAt: null,
      postedBy: null,
      createdBy: ctx.user?.id ?? null,
      updatedBy: ctx.user?.id ?? null,
    },
    { transaction: t },
  );
  await insertLines(societyId, n(entry.id), entryDate, lines, t);
  return finalize(
    ctx,
    books,
    entry,
    lines,
    totals.debitPaise,
    { label: input.label, enforceFundBalance: input.enforceFundBalance },
    t,
    false,
  );
}

async function insertLines(
  societyId: number,
  entryId: number,
  entryDate: string,
  lines: readonly ResolvedLine[],
  t: Transaction,
): Promise<void> {
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

/** Number the entry, set POSTED, apply balances, audit, announce. */
async function finalize(
  ctx: Ctx,
  books: Parameters<typeof applyBalances>[1],
  entry: JournalEntry,
  lines: readonly ResolvedLine[],
  total: number,
  opts: { label?: string; enforceFundBalance?: boolean },
  t: Transaction,
  reversal: boolean,
): Promise<PostJournalResult> {
  const societyId = n(entry.societyId);
  const voucherNo = await nextNumber(societyId, VOUCHER_SERIES[entry.voucherType], {
    date: entry.entryDate,
    transaction: t,
  });
  await entry.update(
    { voucherNo, status: 'POSTED', totalPaise: total, postedAt: now(), postedBy: ctx.user?.id ?? null },
    { transaction: t },
  );
  const label = (opts.label ?? entry.narration).slice(0, 160);
  const effect = await applyBalances(
    ctx,
    books,
    {
      id: n(entry.id),
      entryDate: entry.entryDate,
      refType: entry.refType,
      narration: entry.narration,
      label,
    },
    lines,
    { enforceFundBalance: opts.enforceFundBalance },
    t,
  );
  await auditEntry(ctx, reversal ? AUDIT.journalReversed : AUDIT.journalPosted, entry, societyId, t);
  await announce(books, { id: n(entry.id), label }, effect, t);
  return { id: n(entry.id), voucherNo, entryDate: entry.entryDate, replayed: false };
}

/**
 * Posts a DRAFT or PENDING_APPROVAL manual journal in place (module 14 `onApproved`, 13.1): reads its stored lines, re-validates
 * balance, accounts and the lock date with the approver's context, numbers it, applies balances. The draft's lines must already carry
 * their `fundId` (13.1 creates them with `resolveLines`), because lines of a pending entry cannot be changed.
 */
export async function postDraft(
  ctx: Ctx,
  entryId: number,
  t: Transaction,
  opts: { enforceFundBalance?: boolean } = {},
): Promise<PostJournalResult> {
  const societyId = societyIdOf(ctx);
  const books = await lockBooks(t, societyId);
  const entry = await JournalEntry.findOne({
    where: { id: entryId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!entry) throw new NotFoundError(ERR.journalNotFound, 'Journal entry not found');
  if (entry.status === 'POSTED')
    return { id: n(entry.id), voucherNo: entry.voucherNo!, entryDate: entry.entryDate, replayed: true };
  if (entry.status !== 'DRAFT' && entry.status !== 'PENDING_APPROVAL')
    throw invalidState(`A ${entry.status} journal cannot be posted`);
  const stored = await JournalLine.findAll({
    where: { journalEntryId: entryId },
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
  const totals = validateLines(raw);
  const lines = await resolveLines(societyId, raw, t);
  if (!isSystemCtx(ctx) || entry.source === 'MANUAL')
    if (isLocked(books, entry.entryDate)) throw periodLocked(entry.entryDate);
  await entry.update({ linesHash: hashLines(lines) }, { transaction: t });
  return finalize(
    ctx,
    books,
    entry,
    lines,
    totals.debitPaise,
    { enforceFundBalance: opts.enforceFundBalance },
    t,
    false,
  );
}

export interface ReverseEntryOptions {
  date?: string;
  reason: string;
  /** The manual route (13.1) may not reverse system entries, opening or closing entries (BR-13-5). */
  viaManualRoute?: boolean;
}

/** BR-13-5: posts the reversal of a POSTED entry (lines swapped, `reversalOfId` set, same voucher type) and marks the original. */
export async function reverseEntry(
  ctx: Ctx,
  entryId: number,
  opts: ReverseEntryOptions,
  t: Transaction,
): Promise<{ id: number; voucherNo: string }> {
  const societyId = societyIdOf(ctx);
  const books = await lockBooks(t, societyId);
  const original = await JournalEntry.findOne({
    where: { id: entryId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!original) throw new NotFoundError(ERR.journalNotFound, 'Journal entry not found');
  return reverseLoaded(ctx, books, original, opts, t);
}

async function reverseLoaded(
  ctx: Ctx,
  books: Parameters<typeof applyBalances>[1],
  original: JournalEntry,
  opts: ReverseEntryOptions,
  t: Transaction,
): Promise<{ id: number; voucherNo: string }> {
  const societyId = n(original.societyId);
  if (original.status !== 'POSTED') throw invalidState('Only a posted entry can be reversed');
  if (original.reversalOfId)
    throw new UnprocessableError(ERR.reversalNotAllowed, 'A reversal cannot be reversed');
  if (original.reversedByEntryId)
    throw new ConflictError(ERR.journalAlreadyReversed, 'The entry is already reversed');
  if (
    opts.viaManualRoute &&
    (original.source === 'SYSTEM' || ['OPENING_BALANCE', 'CLOSING'].includes(original.voucherType))
  )
    throw new UnprocessableError(ERR.reversalNotAllowed, 'This entry cannot be reversed by hand');
  if (!opts.reason || opts.reason.trim().length < 3) throw lineError('A reason is required', 'reason');

  const requested = opts.date ?? (await societyToday(societyId));
  let entryDate = requested;
  if (isLocked(books, entryDate)) {
    if (!isSystemCtx(ctx)) throw periodLocked(entryDate);
    entryDate = firstOpenDate(books, entryDate);
  }
  const stored = await JournalLine.findAll({
    where: { journalEntryId: n(original.id) },
    order: [['lineNo', 'ASC']],
    transaction: t,
  });
  const swapped: RawLine[] = stored.map(l => ({
    ledgerAccountId: n(l.ledgerAccountId),
    debitPaise: n(l.creditPaise),
    creditPaise: n(l.debitPaise),
    fundId: l.fundId ? n(l.fundId) : null,
    lineNarration: l.lineNarration,
  }));
  const lines = await resolveLines(societyId, swapped, t, { checkActive: false });
  const reason = opts.reason.trim();
  const entry = await JournalEntry.create(
    {
      societyId,
      voucherNo: null,
      voucherType: original.voucherType,
      entryDate,
      documentDate: requested,
      financialYear: financialYearOf(entryDate),
      narration: `Reversal of ${original.voucherNo}: ${reason}`.slice(0, 500),
      refType: original.refType,
      refId: original.refId,
      linesHash: hashLines(lines),
      instrumentRef: null,
      source: original.source,
      status: 'DRAFT',
      totalPaise: 0,
      reversalOfId: n(original.id),
      reversedByEntryId: null,
      reversedAt: null,
      reversalReason: null,
      approvalRequestId: null,
      rejectionReason: null,
      postedAt: null,
      postedBy: null,
      createdBy: ctx.user?.id ?? null,
      updatedBy: ctx.user?.id ?? null,
    },
    { transaction: t },
  );
  await insertLines(societyId, n(entry.id), entryDate, lines, t);
  const res = await finalize(ctx, books, entry, lines, n(original.totalPaise), {}, t, true);
  await original.update(
    { reversedByEntryId: res.id, reversedAt: now(), reversalReason: reason },
    { transaction: t },
  );
  return { id: res.id, voucherNo: res.voucherNo };
}

/** Section 8.20 `journal.reverse`: reverses the non-reversal entry of `(refType, refId)` (used by module 11 invoice cancel). */
export async function reverseByRef(
  ctx: Ctx,
  input: ReverseJournalInput,
  t: Transaction,
): Promise<{ id: number; voucherNo: string }> {
  const societyId = societyIdOf(ctx);
  const books = await lockBooks(t, societyId);
  const original = await JournalEntry.findOne({
    where: {
      societyId,
      refType: input.refType,
      refId: String(input.refId),
      reversalOfId: null,
      status: 'POSTED',
    },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!original) throw new NotFoundError(ERR.journalNotFound, 'Journal entry not found');
  return reverseLoaded(ctx, books, original, { date: input.date, reason: input.reason }, t);
}
