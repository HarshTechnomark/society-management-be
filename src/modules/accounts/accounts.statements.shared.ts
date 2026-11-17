import { Transaction as SequelizeTransaction, type Transaction } from 'sequelize';
import { BankAccount, BankStatementImport, BankStatementLine, sequelize } from '../../models';
import { emitToRoom } from '../../lib/realtime';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { systemCtx, type Ctx } from '../../types/context';
import { ERR, RT, roomFinance } from './accounts.constants';
import { n } from './accounts.shared';

/** Statements and matching run in READ_COMMITTED transactions (like the money paths of module 12). */
export const moneyTx = <T>(fn: (t: Transaction) => Promise<T>): Promise<T> =>
  sequelize.transaction({ isolationLevel: SequelizeTransaction.ISOLATION_LEVELS.READ_COMMITTED }, fn);

export const statementNotFound = () => new NotFoundError(ERR.statementNotFound, 'Bank statement not found');
export const lineNotFound = () => new NotFoundError(ERR.statementLineNotFound, 'Statement line not found');
export const bankNotFound = () => new NotFoundError(ERR.bankAccountNotFound, 'Bank account not found');
export const staleVersion = () =>
  new ConflictError(ERR.staleVersion, 'Someone else changed this statement. Reload to see the change.');
export const invalidState = (message: string) => new ConflictError(ERR.invalidState, message);

/** A context for jobs of one society. */
export function jobCtx(societyId: number, requestId = 'job'): Ctx {
  return {
    ...systemCtx(requestId),
    society: { id: societyId, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
  };
}

export interface StatementDto {
  id: number;
  bankAccountId: number;
  fileId: number;
  fileFormat: string;
  parserKey: string;
  periodFrom: string | null;
  periodTo: string | null;
  openingBalancePaise: number | null;
  closingBalancePaise: number | null;
  lineCount: number;
  duplicateCount: number;
  creditTotalPaise: number;
  debitTotalPaise: number;
  matchedCount: number;
  unmatchedCount: number;
  status: string;
  errorMessage: string | null;
  reconciledAt: string | null;
  reconciledBy: number | null;
  createdBy: number | null;
  createdAt: string;
  version: number;
}

const nn = (v: unknown): number | null => (v === null || v === undefined ? null : n(v));

export const statementDto = (i: BankStatementImport): StatementDto => ({
  id: n(i.id),
  bankAccountId: n(i.bankAccountId),
  fileId: n(i.fileId),
  fileFormat: i.fileFormat,
  parserKey: i.parserKey,
  periodFrom: i.periodFrom,
  periodTo: i.periodTo,
  openingBalancePaise: nn(i.openingBalancePaise),
  closingBalancePaise: nn(i.closingBalancePaise),
  lineCount: n(i.lineCount),
  duplicateCount: n(i.duplicateCount),
  creditTotalPaise: n(i.creditTotalPaise),
  debitTotalPaise: n(i.debitTotalPaise),
  matchedCount: n(i.matchedCount),
  unmatchedCount: Math.max(0, n(i.lineCount) - n(i.matchedCount)),
  status: i.status,
  errorMessage: i.errorMessage,
  reconciledAt: i.reconciledAt ? new Date(i.reconciledAt).toISOString() : null,
  reconciledBy: nn(i.reconciledBy),
  createdBy: nn(i.createdBy),
  createdAt: new Date(i.createdAt).toISOString(),
  version: n(i.version),
});

export interface StatementLineDto {
  id: number;
  importId: number;
  bankAccountId: number;
  lineNo: number;
  txnDate: string;
  valueDate: string | null;
  description: string;
  reference: string | null;
  chequeNumber: string | null;
  debitPaise: number;
  creditPaise: number;
  direction: 'CREDIT' | 'DEBIT';
  runningBalancePaise: number | null;
  matchStatus: string;
  matchMethod: string | null;
  matchConfidence: number | null;
  matchedJournalLineId: number | null;
  matchedAt: string | null;
  ignoredReason: string | null;
  version: number;
}

export const lineDto = (l: BankStatementLine): StatementLineDto => ({
  id: n(l.id),
  importId: n(l.importId),
  bankAccountId: n(l.bankAccountId),
  lineNo: n(l.lineNo),
  txnDate: l.txnDate,
  valueDate: l.valueDate,
  description: l.description,
  reference: l.reference,
  chequeNumber: l.chequeNumber,
  debitPaise: n(l.debitPaise),
  creditPaise: n(l.creditPaise),
  direction: n(l.creditPaise) > 0 ? 'CREDIT' : 'DEBIT',
  runningBalancePaise: nn(l.runningBalancePaise),
  matchStatus: l.matchStatus,
  matchMethod: l.matchMethod,
  matchConfidence: nn(l.matchConfidence),
  matchedJournalLineId: nn(l.matchedJournalLineId),
  matchedAt: l.matchedAt ? new Date(l.matchedAt).toISOString() : null,
  ignoredReason: l.ignoredReason,
  version: n(l.version),
});

export async function loadBank(
  societyId: number,
  bankAccountId: number,
  t?: Transaction,
): Promise<BankAccount> {
  const b = await BankAccount.findOne({ where: { id: bankAccountId, societyId }, transaction: t });
  if (!b) throw bankNotFound();
  return b;
}

/** Realtime `statement.updated` once the transaction has committed. */
export function emitStatement(t: Transaction, societyId: number, i: BankStatementImport): void {
  const payload = {
    id: n(i.id),
    status: i.status,
    lineCount: n(i.lineCount),
    matchedCount: n(i.matchedCount),
  };
  t.afterCommit(() => emitToRoom(roomFinance(societyId), RT.statementUpdated, payload));
}

/** Locks the import row of a society (first lock of every matching write: import, then line). */
export async function lockImport(
  societyId: number,
  importId: number,
  t: Transaction,
): Promise<BankStatementImport> {
  const i = await BankStatementImport.findOne({
    where: { id: importId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!i) throw statementNotFound();
  return i;
}

/** Keeps `matchedCount` (MATCHED + IGNORED) current. */
export async function refreshMatchedCount(imp: BankStatementImport, t: Transaction): Promise<void> {
  const [rows] = (await sequelize.query(
    `SELECT COUNT(*) AS c FROM bank_statement_lines WHERE importId = :id AND matchStatus IN ('MATCHED','IGNORED')`,
    { replacements: { id: imp.id }, transaction: t },
  )) as [{ c: number }[], unknown];
  await imp.update({ matchedCount: n(rows[0]?.c) }, { transaction: t });
}
