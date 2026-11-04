import { QueryTypes, UniqueConstraintError } from 'sequelize';
import { Unit, UnitLedgerEntry, sequelize } from '../../models';
import { ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { LedgerEntryType, LedgerRefType } from './billing.constants';
import type { Ctx, LedgerPostInput, SystemCtx, Transaction } from './billing.types';

/**
 * `unitLedger.*` of section 8.24 (BR-11-57 to BR-11-60). The ledger is append-only: entries are inserted here and nowhere
 * else, never updated or deleted (the model hooks throw).
 */

/** BR-11-58 and section 8.24: the `refType` each entry type may use. */
export const LEDGER_REF_PAIRS: Record<LedgerEntryType, readonly LedgerRefType[]> = {
  OPENING_BALANCE: ['opening_balance'],
  INVOICE: ['invoice'],
  DEBIT_NOTE: ['billing_note'],
  CREDIT_NOTE: ['billing_note'],
  PAYMENT: ['payment'],
  PAYMENT_REVERSAL: ['payment'],
  REFUND: ['refund'],
  ADJUSTMENT: ['opening_balance'],
};

const invalid = (field: string, message: string) =>
  new UnprocessableError('LEDGER_ENTRY_INVALID', 'The ledger entry is not valid', [{ field, message }]);

const isPaise = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isRealDate = (v: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

function checkInput(e: LedgerPostInput): void {
  if (!Number.isSafeInteger(e.unitId) || e.unitId <= 0)
    throw invalid('unitId', 'Unit id must be a positive integer');
  if (!Number.isSafeInteger(e.refId) || e.refId <= 0)
    throw invalid('refId', 'Reference id must be a positive integer');
  const pairs = LEDGER_REF_PAIRS[e.entryType];
  if (!pairs) throw invalid('entryType', 'Unknown entry type');
  if (!pairs.includes(e.refType))
    throw invalid('refType', `Entry type ${e.entryType} cannot use reference type ${String(e.refType)}`);
  if (!isPaise(e.debitPaise) || !isPaise(e.creditPaise))
    throw invalid('debitPaise', 'Amounts must be whole paise, zero or more');
  if (e.debitPaise > 0 === e.creditPaise > 0)
    throw invalid('debitPaise', 'Exactly one of debit and credit must be above zero');
  if (!isRealDate(e.date)) throw invalid('date', 'Date must be a real YYYY-MM-DD date');
  if (typeof e.narration !== 'string' || !e.narration.trim() || e.narration.length > 300)
    throw invalid('narration', 'Narration must be 1 to 300 characters');
}

const sameEntry = (row: UnitLedgerEntry, e: LedgerPostInput): boolean =>
  Number(row.unitId) === e.unitId &&
  Number(row.debitPaise) === e.debitPaise &&
  Number(row.creditPaise) === e.creditPaise;

const conflict = () =>
  new ConflictError(
    'LEDGER_ENTRY_CONFLICT',
    'This reference is already in the ledger with different amounts',
  );

/**
 * Appends one ledger entry inside the caller's transaction (BR-11-57). Idempotent by `(refType, refId, entryType)` of the
 * society: the same key with the same unit and amounts returns the existing row, different amounts are
 * `409 LEDGER_ENTRY_CONFLICT`. The society is `ctx.society.id` when the context has one (the unit must belong to it,
 * else `404 UNIT_NOT_FOUND`); a system context without a society takes the unit's own society. No audit: the caller
 * audits its own action.
 */
async function post(ctx: Ctx | SystemCtx, e: LedgerPostInput, t: Transaction): Promise<{ id: number }> {
  checkInput(e);
  const unit = await Unit.findOne({
    where: { id: e.unitId },
    attributes: ['id', 'societyId'],
    transaction: t,
  });
  const societyId = ctx.society?.id ?? unit?.societyId;
  if (!unit || !societyId || Number(unit.societyId) !== Number(societyId))
    throw new NotFoundError('UNIT_NOT_FOUND', 'Unit not found');
  const where = { societyId, refType: e.refType, refId: e.refId, entryType: e.entryType };
  const existing = await UnitLedgerEntry.findOne({ where, transaction: t });
  if (existing) {
    if (!sameEntry(existing, e)) throw conflict();
    return { id: Number(existing.id) };
  }
  try {
    const row = await UnitLedgerEntry.create(
      {
        societyId,
        unitId: e.unitId,
        entryDate: e.date,
        entryType: e.entryType,
        refType: e.refType,
        refId: e.refId,
        debitPaise: e.debitPaise,
        creditPaise: e.creditPaise,
        narration: e.narration.trim(),
        createdBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
    return { id: Number(row.id) };
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err;
    // a concurrent post of the same reference won the unique index; a locking read sees its committed row (a plain read
    // would show this transaction's older snapshot)
    const winner = await UnitLedgerEntry.findOne({ where, transaction: t, lock: t.LOCK.SHARE });
    if (winner && sameEntry(winner, e)) return { id: Number(winner.id) };
    throw conflict();
  }
}

/** BR-11-59: `Σ debitPaise − Σ creditPaise` of the flat; positive = dues, negative = advance. Pass `t` to read inside a transaction. */
async function balance(societyId: number, unitId: number, t?: Transaction): Promise<number> {
  const [row] = await sequelize.query<{ balance: string | number | null }>(
    `SELECT COALESCE(SUM(debitPaise), 0) - COALESCE(SUM(creditPaise), 0) AS balance
       FROM unit_ledger_entries WHERE societyId = :societyId AND unitId = :unitId`,
    { replacements: { societyId, unitId }, type: QueryTypes.SELECT, transaction: t },
  );
  return Number(row?.balance ?? 0);
}

export const unitLedger = {
  /** Appends one ledger entry inside the caller's transaction; exactly one of debit or credit is > 0. No audit. */
  post,
  /** Paise: positive = dues, negative = advance (Σ debit − Σ credit of the flat's ledger entries). */
  balance,
};
