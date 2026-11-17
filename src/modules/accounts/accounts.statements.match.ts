import { QueryTypes, UniqueConstraintError, type Transaction } from 'sequelize';
import {
  BankAccount,
  BankStatementImport,
  BankStatementLine,
  JournalEntry,
  JournalLine,
  sequelize,
} from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { settings } from '../society-setup/society-setup.public';
import { AUDIT, ERR, SETTING_DEFAULTS, type MatchMethod, type VoucherType } from './accounts.constants';
import { postJournal } from './accounts.engine';
import { ledgerAccountByCode } from './accounts.lookup';
import { n, societyIdOf } from './accounts.shared';
import {
  emitStatement,
  invalidState,
  lineDto,
  loadBank,
  lockImport,
  moneyTx,
  refreshMatchedCount,
  staleVersion,
  statementDto,
  lineNotFound,
  type StatementDto,
  type StatementLineDto,
} from './accounts.statements.shared';

/**
 * Matching of statement lines to journal lines on the bank's ledger (BR-13-41, BR-13-42, section 6.5). Lock order of every write
 * here: the import row, then the statement line, then (create-entry) the engine's own locks. A statement credit pairs with a ledger
 * debit and a statement debit with a ledger credit, for equal amounts. Entries of voucher type `OPENING_BALANCE` never appear on a
 * statement, so they are never candidates.
 */
export const PASS2_MAX_PAISE = 50_000_000; // ₹5,00,000 (BR-13-41)
const CAND_LIMIT = 20;
const DAY = 86_400_000;

const daysBetween = (a: string, b: string): number =>
  Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY));
const addDays = (ymd: string, d: number): string =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + d * DAY).toISOString().slice(0, 10);
const amountOf = (l: { debitPaise: unknown; creditPaise: unknown }): number =>
  Math.max(n(l.debitPaise), n(l.creditPaise));

interface JRow {
  id: number;
  journalEntryId: number;
  entryDate: string;
  debitPaise: number;
  creditPaise: number;
  voucherNo: string | null;
  narration: string;
  instrumentRef: string | null;
  voucherType: string;
}

/** Unmatched POSTED lines on the ledger between two dates (inclusive), as plain rows. */
async function openJournalLines(
  societyId: number,
  ledgerAccountId: number,
  from: string,
  to: string,
  t?: Transaction,
): Promise<JRow[]> {
  const rows = await sequelize.query<JRow>(
    `SELECT jl.id AS id, jl.journalEntryId AS journalEntryId, jl.entryDate AS entryDate, jl.debitPaise AS debitPaise,
            jl.creditPaise AS creditPaise, je.voucherNo AS voucherNo, je.narration AS narration,
            COALESCE(je.instrumentRef, pay.referenceNo) AS instrumentRef, je.voucherType AS voucherType
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journalEntryId
       LEFT JOIN payments pay ON pay.societyId = je.societyId
         AND pay.id = (CASE WHEN je.refType = 'payment' THEN CAST(je.refId AS UNSIGNED) END)
       LEFT JOIN bank_statement_lines sl ON sl.matchedJournalLineId = jl.id
      WHERE jl.societyId = :societyId AND jl.ledgerAccountId = :ledgerAccountId AND je.status = 'POSTED'
        AND je.voucherType <> 'OPENING_BALANCE' AND sl.id IS NULL AND jl.entryDate BETWEEN :from AND :to
      ORDER BY jl.entryDate, jl.id`,
    { replacements: { societyId, ledgerAccountId, from, to }, type: QueryTypes.SELECT, transaction: t },
  );
  return rows.map(r => ({
    ...r,
    id: n(r.id),
    journalEntryId: n(r.journalEntryId),
    debitPaise: n(r.debitPaise),
    creditPaise: n(r.creditPaise),
  }));
}

/** Statement credit ↔ ledger debit, statement debit ↔ ledger credit. */
const sameDirectionAsLedger = (l: BankStatementLine, j: JRow): boolean =>
  n(l.creditPaise) > 0 ? j.debitPaise > 0 : j.creditPaise > 0;

export interface AutoMatchResult {
  matched: number;
  byReference: number;
  byAmountDate: number;
  unmatched: number;
}

/** Job `accounts:auto-match` and `POST …/auto-match`: BR-13-41 passes over the UNMATCHED lines of one import. Safe to re-run. */
export async function runAutoMatch(ctx: Ctx, importId: number): Promise<AutoMatchResult | null> {
  const societyId = societyIdOf(ctx);
  const window = await Promise.resolve(settings.get(societyId, 'finance.autoMatchWindowDays' as never))
    .then(v => (typeof v === 'number' ? v : SETTING_DEFAULTS['finance.autoMatchWindowDays']))
    .catch(() => SETTING_DEFAULTS['finance.autoMatchWindowDays'] as number);
  return moneyTx(async t => {
    const imp = await lockImport(societyId, importId, t);
    if (imp.status !== 'PARSED') return null;
    const bank = await loadBank(societyId, n(imp.bankAccountId), t);
    const lines = await BankStatementLine.findAll({
      where: { importId, societyId, matchStatus: 'UNMATCHED' },
      order: [['lineNo', 'ASC']],
      transaction: t,
    });
    const result: AutoMatchResult = { matched: 0, byReference: 0, byAmountDate: 0, unmatched: lines.length };
    if (lines.length) {
      const dates = lines.map(l => l.txnDate).sort();
      const jrows = await openJournalLines(
        societyId,
        n(bank.ledgerAccountId),
        addDays(dates[0]!, -window),
        addDays(dates[dates.length - 1]!, window),
        t,
      );
      const used = new Set<number>();
      const plan: { line: BankStatementLine; j: JRow; method: MatchMethod; confidence: number }[] = [];
      const open = new Set(lines.map(l => n(l.id)));
      const fits = (l: BankStatementLine, j: JRow): boolean =>
        !used.has(j.id) &&
        sameDirectionAsLedger(l, j) &&
        amountOf(l) === amountOf(j) &&
        daysBetween(l.txnDate, j.entryDate) <= window;
      // pass 1: reference, settlement UTR or cheque number equals the entry's instrumentRef
      for (const l of lines) {
        const refs = [l.reference, l.chequeNumber].filter(Boolean).map(r => String(r).toUpperCase());
        if (!refs.length) continue;
        const hits = jrows
          .filter(j => j.instrumentRef && refs.includes(j.instrumentRef.toUpperCase()) && fits(l, j))
          .sort(
            (a, b) =>
              daysBetween(l.txnDate, a.entryDate) - daysBetween(l.txnDate, b.entryDate) || a.id - b.id,
          );
        const j = hits[0];
        if (!j) continue;
        used.add(j.id);
        open.delete(n(l.id));
        plan.push({ line: l, j, method: 'AUTO_REFERENCE', confidence: 100 });
      }
      // pass 2: exactly one candidate each way, amount up to ₹5,00,000
      const rest = lines.filter(l => open.has(n(l.id)) && amountOf(l) <= PASS2_MAX_PAISE);
      const candsOf = new Map<number, JRow[]>();
      const linesOf = new Map<number, number[]>();
      for (const l of rest) {
        const c = jrows.filter(j => fits(l, j));
        candsOf.set(n(l.id), c);
        for (const j of c) linesOf.set(j.id, [...(linesOf.get(j.id) ?? []), n(l.id)]);
      }
      for (const l of rest) {
        const c = candsOf.get(n(l.id))!;
        if (c.length === 1 && linesOf.get(c[0]!.id)!.length === 1) {
          used.add(c[0]!.id);
          plan.push({ line: l, j: c[0]!, method: 'AUTO_AMOUNT_DATE', confidence: 80 });
        }
      }
      for (const p of plan) {
        try {
          const [count] = await BankStatementLine.update(
            {
              matchStatus: 'MATCHED',
              matchMethod: p.method,
              matchConfidence: p.confidence,
              matchedJournalLineId: p.j.id,
              matchedBy: null,
              matchedAt: now(),
              version: n(p.line.version) + 1,
            },
            { where: { id: p.line.id, matchStatus: 'UNMATCHED' }, transaction: t },
          );
          if (!count) continue;
          result.matched += 1;
          if (p.method === 'AUTO_REFERENCE') result.byReference += 1;
          else result.byAmountDate += 1;
        } catch (err) {
          if (!(err instanceof UniqueConstraintError)) throw err; // a journal line taken meanwhile: leave the line unmatched
        }
      }
      result.unmatched = lines.length - result.matched;
    }
    await refreshMatchedCount(imp, t);
    await audit(
      ctx,
      {
        action: AUDIT.statementAutoMatched,
        entityType: 'bank_statement_import',
        entityId: n(imp.id),
        after: { ...result },
      },
      t,
    );
    emitStatement(t, societyId, imp);
    return result;
  });
}

// ------------------------------------------------------------------------------------------------ candidates
export interface CandidateDto {
  journalLineId: number;
  journalEntryId: number;
  voucherNo: string | null;
  entryDate: string;
  narration: string;
  instrumentRef: string | null;
  debitPaise: number;
  creditPaise: number;
  amountPaise: number;
  exactAmount: boolean;
  score: number;
}

export function scoreCandidate(l: BankStatementLine, j: JRow): number {
  const a = amountOf(l);
  const b = amountOf(j);
  const exact = a === b;
  const pct = a ? (Math.abs(a - b) / a) * 100 : 100;
  const days = daysBetween(l.txnDate, j.entryDate);
  const amountScore = exact ? 60 : Math.max(0, 40 * (1 - pct / 10));
  const dateScore = Math.max(0, 30 * (1 - days / 15));
  const refs = [l.reference, l.chequeNumber].filter(Boolean).map(r => String(r).toUpperCase());
  const refScore = j.instrumentRef && refs.includes(j.instrumentRef.toUpperCase()) ? 10 : 0;
  return Math.min(100, Math.round(amountScore + dateScore + refScore));
}

/** Up to 20 unmatched POSTED lines on the account's ledger: equal amount first, then within ±10% and ±15 days. */
export async function candidatesFor(societyId: number, lineId: number): Promise<CandidateDto[]> {
  const line = await BankStatementLine.findOne({ where: { id: lineId, societyId } });
  if (!line) throw lineNotFound();
  const bank = await loadBank(societyId, n(line.bankAccountId));
  const rows = await openJournalLines(
    societyId,
    n(bank.ledgerAccountId),
    addDays(line.txnDate, -60),
    addDays(line.txnDate, 60),
  );
  const a = amountOf(line);
  const out = rows
    .filter(j => sameDirectionAsLedger(line, j))
    .filter(j => {
      const b = amountOf(j);
      if (b === a) return true;
      return Math.abs(a - b) * 10 <= a && daysBetween(line.txnDate, j.entryDate) <= 15;
    })
    .map<CandidateDto>(j => ({
      journalLineId: j.id,
      journalEntryId: j.journalEntryId,
      voucherNo: j.voucherNo,
      entryDate: j.entryDate,
      narration: j.narration,
      instrumentRef: j.instrumentRef,
      debitPaise: j.debitPaise,
      creditPaise: j.creditPaise,
      amountPaise: amountOf(j),
      exactAmount: amountOf(j) === a,
      score: scoreCandidate(line, j),
    }))
    .sort(
      (x, y) =>
        Number(y.exactAmount) - Number(x.exactAmount) ||
        y.score - x.score ||
        x.journalLineId - y.journalLineId,
    );
  return out.slice(0, CAND_LIMIT);
}

// ------------------------------------------------------------------------------------------------ manual changes
/** Locks the import, then the line, checks the version and that the import still accepts changes. */
async function lockLine(
  societyId: number,
  lineId: number,
  version: number,
  t: Transaction,
): Promise<{ imp: BankStatementImport; line: BankStatementLine; bank: BankAccount }> {
  const probe = await BankStatementLine.findOne({
    where: { id: lineId, societyId },
    attributes: ['id', 'importId'],
    transaction: t,
  });
  if (!probe) throw lineNotFound();
  const imp = await lockImport(societyId, n(probe.importId), t);
  const line = await BankStatementLine.findOne({
    where: { id: lineId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!line) throw lineNotFound();
  if (n(line.version) !== version)
    throw new ConflictError(ERR.staleVersion, 'Someone else changed this line. Reload to see the change.');
  if (imp.status === 'RECONCILED' || imp.status === 'FAILED')
    throw invalidState(`The statement is ${imp.status}; its lines can no longer change`);
  const bank = await loadBank(societyId, n(imp.bankAccountId), t);
  return { imp, line, bank };
}

const alreadyMatchedJournal = () =>
  new ConflictError(ERR.journalLineAlreadyMatched, 'That ledger line is matched to another statement line');

async function applyMatch(
  ctx: Ctx,
  imp: BankStatementImport,
  line: BankStatementLine,
  journalLineId: number,
  method: MatchMethod,
  confidence: number | null,
  t: Transaction,
): Promise<void> {
  const taken = await BankStatementLine.findOne({
    where: { matchedJournalLineId: journalLineId },
    attributes: ['id'],
    transaction: t,
  });
  if (taken) throw alreadyMatchedJournal();
  try {
    await line.update(
      {
        matchStatus: 'MATCHED',
        matchMethod: method,
        matchConfidence: confidence,
        matchedJournalLineId: journalLineId,
        matchedBy: ctx.user?.id ?? null,
        matchedAt: now(),
        ignoredReason: null,
        version: n(line.version) + 1,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw alreadyMatchedJournal();
    throw err;
  }
  await refreshMatchedCount(imp, t);
  emitStatement(t, n(imp.societyId), imp);
}

/** `POST /accounts/bank-statement-lines/:id/match` (BR-13-42). */
export async function matchLine(
  ctx: Ctx,
  lineId: number,
  input: { journalLineId: number; version: number },
): Promise<StatementLineDto> {
  const societyId = societyIdOf(ctx);
  return moneyTx(async t => {
    const { imp, line, bank } = await lockLine(societyId, lineId, input.version, t);
    if (line.matchStatus !== 'UNMATCHED')
      throw new ConflictError(ERR.lineAlreadyMatched, 'This statement line is already matched or ignored');
    const jl = await JournalLine.findOne({ where: { id: input.journalLineId, societyId }, transaction: t });
    if (!jl) throw new NotFoundError(ERR.journalNotFound, 'Journal line not found');
    const entry = await JournalEntry.findByPk(jl.journalEntryId, { transaction: t });
    const wrong = (msg: string) => new UnprocessableError(ERR.matchWrongAccount, msg);
    if (!entry || entry.status !== 'POSTED') throw wrong('Only lines of posted entries can be matched');
    if (n(jl.ledgerAccountId) !== n(bank.ledgerAccountId))
      throw wrong('That line is not on this bank account');
    const credit = n(line.creditPaise) > 0;
    if (credit ? n(jl.debitPaise) === 0 : n(jl.creditPaise) === 0)
      throw wrong('A statement credit matches a ledger debit and a statement debit a ledger credit');
    const taken = await BankStatementLine.findOne({
      where: { matchedJournalLineId: n(jl.id) },
      attributes: ['id'],
      transaction: t,
    });
    if (taken) throw alreadyMatchedJournal();
    if (amountOf(line) !== amountOf(jl))
      throw new UnprocessableError(ERR.matchAmountMismatch, 'The amounts of the two lines differ', [
        { field: 'journalLineId', message: 'Amounts must be equal' },
      ]);
    await applyMatch(ctx, imp, line, n(jl.id), 'MANUAL', null, t);
    await audit(
      ctx,
      {
        action: AUDIT.statementLineMatched,
        entityType: 'bank_statement_line',
        entityId: n(line.id),
        after: { journalLineId: n(jl.id), method: 'MANUAL' },
      },
      t,
    );
    return lineDto(line);
  });
}

/** `POST …/unmatch`: MATCHED or IGNORED back to UNMATCHED while the import is not RECONCILED. */
export async function unmatchLine(
  ctx: Ctx,
  lineId: number,
  input: { version: number },
): Promise<StatementLineDto> {
  const societyId = societyIdOf(ctx);
  return moneyTx(async t => {
    const { imp, line } = await lockLine(societyId, lineId, input.version, t);
    if (line.matchStatus === 'UNMATCHED') throw invalidState('This statement line is not matched or ignored');
    const before = { matchStatus: line.matchStatus, journalLineId: line.matchedJournalLineId };
    await line.update(
      {
        matchStatus: 'UNMATCHED',
        matchMethod: null,
        matchConfidence: null,
        matchedJournalLineId: null,
        matchedBy: null,
        matchedAt: null,
        ignoredReason: null,
        version: n(line.version) + 1,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
    await refreshMatchedCount(imp, t);
    emitStatement(t, societyId, imp);
    await audit(
      ctx,
      {
        action: AUDIT.statementLineUnmatched,
        entityType: 'bank_statement_line',
        entityId: n(line.id),
        before,
      },
      t,
    );
    return lineDto(line);
  });
}

/** `POST …/ignore`: UNMATCHED to IGNORED with a reason of 5 to 200 characters. */
export async function ignoreLine(
  ctx: Ctx,
  lineId: number,
  input: { reason: string; version: number },
): Promise<StatementLineDto> {
  const societyId = societyIdOf(ctx);
  return moneyTx(async t => {
    const { imp, line } = await lockLine(societyId, lineId, input.version, t);
    if (line.matchStatus !== 'UNMATCHED')
      throw new ConflictError(ERR.lineAlreadyMatched, 'This statement line is already matched or ignored');
    await line.update(
      {
        matchStatus: 'IGNORED',
        ignoredReason: input.reason,
        version: n(line.version) + 1,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
    await refreshMatchedCount(imp, t);
    emitStatement(t, societyId, imp);
    await audit(
      ctx,
      {
        action: AUDIT.statementLineIgnored,
        entityType: 'bank_statement_line',
        entityId: n(line.id),
        reason: input.reason,
      },
      t,
    );
    return lineDto(line);
  });
}

const CASH_CODES = new Set(['1120', '1130']);

/** `POST …/create-entry`: posts CONTRA, RECEIPT or PAYMENT through the engine (refType `statement_line`) and matches it. */
export async function createEntryFromLine(
  ctx: Ctx,
  lineId: number,
  input: { ledgerAccountCode: string; narration?: string; version: number },
): Promise<{ line: StatementLineDto; entry: { id: number; voucherNo: string; entryDate: string } }> {
  const societyId = societyIdOf(ctx);
  return moneyTx(async t => {
    const { imp, line, bank } = await lockLine(societyId, lineId, input.version, t);
    if (line.matchStatus !== 'UNMATCHED')
      throw new ConflictError(ERR.lineAlreadyMatched, 'This statement line is already matched or ignored');
    const other = await ledgerAccountByCode(societyId, input.ledgerAccountCode, t);
    const field = [{ field: 'ledgerAccountCode', message: 'Pick another account' }];
    if (!other) throw new UnprocessableError(ERR.unknownLedgerCode, 'Unknown account code', field);
    if (other.isGroup) throw new UnprocessableError(ERR.accountNotPostable, 'That account is a group', field);
    if (!other.isActive) throw new UnprocessableError(ERR.accountInactive, 'That account is inactive', field);
    if (n(other.id) === n(bank.ledgerAccountId) || other.subtype === 'FUND')
      throw new UnprocessableError(
        ERR.accountNotPostable,
        'Pick an account other than the bank or a fund',
        field,
      );
    const bankCode = (
      await sequelize.query<{ code: string }>('SELECT code FROM ledger_accounts WHERE id = :id', {
        replacements: { id: bank.ledgerAccountId },
        type: QueryTypes.SELECT,
        transaction: t,
      })
    )[0]!.code;
    const credit = n(line.creditPaise) > 0;
    const amount = amountOf(line);
    const contra = other.subtype === 'BANK' || CASH_CODES.has(other.code);
    const voucherType: VoucherType = contra ? 'CONTRA' : credit ? 'RECEIPT' : 'PAYMENT';
    const posted = await postJournal(
      ctx,
      {
        date: line.txnDate,
        voucherType,
        refType: 'statement_line',
        refId: n(line.id),
        narration: (input.narration ?? line.description).slice(0, 200),
        instrumentRef: line.reference ?? line.chequeNumber,
        lines: credit
          ? [
              { ledgerAccountCode: bankCode, debitPaise: amount, creditPaise: 0 },
              { ledgerAccountCode: other.code, debitPaise: 0, creditPaise: amount },
            ]
          : [
              { ledgerAccountCode: other.code, debitPaise: amount, creditPaise: 0 },
              { ledgerAccountCode: bankCode, debitPaise: 0, creditPaise: amount },
            ],
      },
      t,
    );
    const jl = await JournalLine.findOne({
      where: { journalEntryId: posted.id, ledgerAccountId: n(bank.ledgerAccountId) },
      transaction: t,
    });
    if (!jl) throw new Error('create-entry: the posted entry has no line on the bank ledger');
    await applyMatch(ctx, imp, line, n(jl.id), 'CREATED_ENTRY', 100, t);
    await audit(
      ctx,
      {
        action: AUDIT.statementLineEntryCreated,
        entityType: 'bank_statement_line',
        entityId: n(line.id),
        after: { journalEntryId: posted.id, voucherNo: posted.voucherNo, ledgerAccountCode: other.code },
      },
      t,
    );
    return {
      line: lineDto(line),
      entry: { id: posted.id, voucherNo: posted.voucherNo, entryDate: posted.entryDate },
    };
  });
}

/** `POST /accounts/bank-statements/:id/mark-reconciled` (BR-13-43). */
export async function markReconciled(
  ctx: Ctx,
  importId: number,
  input: { version: number },
): Promise<StatementDto> {
  const societyId = societyIdOf(ctx);
  return moneyTx(async t => {
    const imp = await lockImport(societyId, importId, t);
    if (n(imp.version) !== input.version) throw staleVersion();
    if (imp.status !== 'PARSED')
      throw invalidState(`The statement is ${imp.status}; only a parsed statement can be reconciled`);
    const [row] = await sequelize.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM bank_statement_lines WHERE importId = :id AND matchStatus = 'UNMATCHED'`,
      { replacements: { id: importId }, type: QueryTypes.SELECT, transaction: t },
    );
    const open = n(row?.c);
    if (open > 0)
      throw new UnprocessableError(
        ERR.reconciliationIncomplete,
        `${open} statement lines are still unmatched`,
        [{ field: 'lines', message: 'Match or ignore every line first', unmatchedCount: open }],
      );
    const bank = await BankAccount.findOne({
      where: { id: imp.bankAccountId, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!bank) throw new NotFoundError(ERR.bankAccountNotFound, 'Bank account not found');
    await imp.update(
      {
        status: 'RECONCILED',
        reconciledBy: ctx.user?.id ?? null,
        reconciledAt: now(),
        version: n(imp.version) + 1,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
    // BR-13-43; an older statement signed off later never moves the date backwards
    if (imp.periodTo && (!bank.lastReconciledDate || imp.periodTo >= bank.lastReconciledDate))
      await bank.update(
        {
          lastReconciledDate: imp.periodTo,
          lastReconciledBalancePaise:
            imp.closingBalancePaise === null ? bank.lastReconciledBalancePaise : n(imp.closingBalancePaise),
        },
        { transaction: t },
      );
    await audit(
      ctx,
      {
        action: AUDIT.statementReconciled,
        entityType: 'bank_statement_import',
        entityId: n(imp.id),
        after: { periodTo: imp.periodTo, closingBalancePaise: imp.closingBalancePaise },
      },
      t,
    );
    emitStatement(t, societyId, imp);
    return statementDto(imp);
  });
}
