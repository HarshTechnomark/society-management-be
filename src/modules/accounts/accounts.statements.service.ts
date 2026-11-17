import { createHash } from 'node:crypto';
import { Op, QueryTypes, UniqueConstraintError, type Order, type WhereOptions } from 'sequelize';
import { BankStatementImport, BankStatementLine, sequelize } from '../../models';
import { logger } from '../../lib/logger';
import { enqueueAfterCommit } from '../../lib/queue';
import { audit } from '../../utils/audit';
import { AppError, ConflictError } from '../../utils/errors';
import { pageMeta, type PageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { setupPorts } from '../society-setup/society-setup.ports';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { ACCOUNTS_QUEUE, AUDIT, ENT, ERR, JOBS, NOTIFY, STATEMENT_FORMATS } from './accounts.constants';
import { accountsPorts } from './accounts.ports';
import { n, societyIdOf } from './accounts.shared';
import { StatementParseError, parseStatementFile, type ParsedLine } from './accounts.statements.parse';
import {
  emitStatement,
  lineDto,
  loadBank,
  lockImport,
  moneyTx,
  statementDto,
  statementNotFound,
  type StatementDto,
  type StatementLineDto,
} from './accounts.statements.shared';

/**
 * Bank statement import, parse and reads (section 8.16, BR-13-40, section 6.5). The file comes from the module 01 placeholder file
 * store (`setupPorts().files.getImportFile`, purpose `IMPORT_FILE`). The import row is created `UPLOADED` and the job
 * `accounts:statement-parse` reads the file, skips duplicate lines (BR-13-40), inserts the rest in batches of 500, sets PARSED or
 * FAILED and queues `accounts:auto-match`. CSV and XLSX are both read (`exceljs` is a project dependency).
 */
const BATCH = 500;

export interface ImportInput {
  bankAccountId: number;
  fileId: number;
  parserKey?: string;
}

/** `POST /accounts/bank-statements` (202). */
export async function importStatement(ctx: Ctx, input: ImportInput): Promise<StatementDto> {
  const societyId = societyIdOf(ctx);
  const userId = ctx.user!.id;
  const bank = await loadBank(societyId, input.bankAccountId);
  if (bank.status !== 'ACTIVE') throw new AppError(404, ERR.bankAccountNotFound, 'Bank account not found');
  const file = await setupPorts().files.getImportFile(societyId, userId, input.fileId);
  const sha = createHash('sha256').update(file.content).digest('hex');
  const parserKey = input.parserKey ?? bank.statementFormat;
  const isZip = file.content[0] === 0x50 && file.content[1] === 0x4b;
  return moneyTx(async t => {
    const dup = await BankStatementImport.findOne({
      where: { bankAccountId: bank.id, fileSha256: sha },
      transaction: t,
    });
    if (dup)
      throw new ConflictError(
        ERR.statementAlreadyImported,
        'This file was already imported for this bank account',
      );
    let row: BankStatementImport;
    try {
      row = await BankStatementImport.create(
        {
          societyId,
          bankAccountId: n(bank.id),
          fileId: input.fileId,
          fileSha256: sha,
          fileFormat: isZip ? 'XLSX' : 'CSV',
          parserKey,
          periodFrom: null,
          periodTo: null,
          openingBalancePaise: null,
          closingBalancePaise: null,
          errorMessage: null,
          reconciledBy: null,
          reconciledAt: null,
          createdBy: userId,
          updatedBy: userId,
        },
        { transaction: t },
      );
    } catch (err) {
      if (err instanceof UniqueConstraintError)
        throw new ConflictError(
          ERR.statementAlreadyImported,
          'This file was already imported for this bank account',
        );
      throw err;
    }
    await audit(
      ctx,
      {
        action: AUDIT.statementImported,
        entityType: 'bank_statement_import',
        entityId: n(row.id),
        after: { bankAccountId: n(bank.id), fileId: input.fileId, parserKey },
      },
      t,
    );
    emitStatement(t, societyId, row);
    enqueueAfterCommit(t, ACCOUNTS_QUEUE, JOBS.statementParse, {
      societyId,
      importId: n(row.id),
      requestId: ctx.requestId,
    });
    return statementDto(row);
  });
}

function balances(lines: ParsedLine[]): { opening: number | null; closing: number | null } {
  const first = lines[0]!;
  const last = lines[lines.length - 1]!;
  const descending = first.txnDate > last.txnDate;
  const top = descending ? last : first; // the earliest line of the statement
  const bottom = descending ? first : last; // the latest line
  const opening =
    top.runningBalancePaise === null ? null : top.runningBalancePaise - top.creditPaise + top.debitPaise;
  return { opening, closing: bottom.runningBalancePaise };
}

async function failImport(societyId: number, importId: number, message: string): Promise<void> {
  await moneyTx(async t => {
    const imp = await lockImport(societyId, importId, t);
    if (imp.status !== 'UPLOADED') return;
    await imp.update(
      { status: 'FAILED', errorMessage: message.slice(0, 500), version: n(imp.version) + 1 },
      { transaction: t },
    );
    emitStatement(t, societyId, imp);
    await notifyImporter(t, imp);
  });
}

async function notifyImporter(t: import('sequelize').Transaction, imp: BankStatementImport): Promise<void> {
  if (!imp.createdBy) return;
  const data = {
    societyId: n(imp.societyId),
    statementId: n(imp.id),
    status: imp.status,
    lineCount: n(imp.lineCount),
    duplicateCount: n(imp.duplicateCount),
    errorMessage: imp.errorMessage,
  };
  t.afterCommit(async () => {
    await accountsPorts().notifications.send(NOTIFY.statementImported, [n(imp.createdBy)], data);
  });
}

/** Job `accounts:statement-parse`: does nothing unless the import is UPLOADED (idempotent). */
export async function processStatementParse(societyId: number, importId: number): Promise<void> {
  const imp = await BankStatementImport.findOne({ where: { id: importId, societyId } });
  if (!imp || imp.status !== 'UPLOADED') return;
  if (!(await isFeatureOn(societyId, ENT.statementImport))) {
    logger.info({ societyId, importId }, 'statement parse skipped: feature not in plan');
    return;
  }
  let lines: ParsedLine[];
  try {
    const file = await setupPorts().files.getImportFile(societyId, n(imp.createdBy), n(imp.fileId));
    lines = (await parseStatementFile(file.content)).lines;
  } catch (err) {
    if (err instanceof StatementParseError || err instanceof AppError) {
      await failImport(societyId, importId, err.message);
      return;
    }
    throw err;
  }
  const { opening, closing } = balances(lines);
  const dates = lines.map(l => l.txnDate).sort();
  await moneyTx(async t => {
    const row = await lockImport(societyId, importId, t);
    if (row.status !== 'UPLOADED') return;
    const known = new Set<string>();
    for (let i = 0; i < lines.length; i += 1000) {
      const hashes = lines.slice(i, i + 1000).map(l => l.dedupeHash);
      const found = await sequelize.query<{ dedupeHash: string }>(
        'SELECT dedupeHash FROM bank_statement_lines WHERE bankAccountId = :b AND dedupeHash IN (:h)',
        { replacements: { b: row.bankAccountId, h: hashes }, type: QueryTypes.SELECT, transaction: t },
      );
      for (const f of found) known.add(f.dedupeHash);
    }
    const fresh = lines.filter(l => !known.has(l.dedupeHash));
    for (let i = 0; i < fresh.length; i += BATCH) {
      await BankStatementLine.bulkCreate(
        fresh.slice(i, i + BATCH).map(l => ({
          societyId,
          importId,
          bankAccountId: n(row.bankAccountId),
          lineNo: l.lineNo,
          txnDate: l.txnDate,
          valueDate: l.valueDate,
          description: l.description,
          reference: l.reference,
          chequeNumber: l.chequeNumber,
          debitPaise: l.debitPaise,
          creditPaise: l.creditPaise,
          runningBalancePaise: l.runningBalancePaise,
          dedupeHash: l.dedupeHash,
          matchMethod: null,
          matchConfidence: null,
          matchedJournalLineId: null,
          matchedBy: null,
          matchedAt: null,
          ignoredReason: null,
          createdBy: row.createdBy,
          updatedBy: row.createdBy,
        })),
        { transaction: t },
      );
    }
    await row.update(
      {
        status: 'PARSED',
        periodFrom: dates[0]!,
        periodTo: dates[dates.length - 1]!,
        openingBalancePaise: opening,
        closingBalancePaise: closing,
        lineCount: fresh.length,
        duplicateCount: lines.length - fresh.length,
        creditTotalPaise: fresh.reduce((s, l) => s + l.creditPaise, 0),
        debitTotalPaise: fresh.reduce((s, l) => s + l.debitPaise, 0),
        matchedCount: 0,
        errorMessage: null,
        version: n(row.version) + 1,
      },
      { transaction: t },
    );
    emitStatement(t, societyId, row);
    await notifyImporter(t, row);
    enqueueAfterCommit(t, ACCOUNTS_QUEUE, JOBS.autoMatch, {
      societyId,
      importId,
      requestId: `parse:${importId}`,
    });
  });
}

// ------------------------------------------------------------------------------------------------ reads
export interface StatementListQuery {
  bankAccountId?: number;
  status?: string;
  page: number;
  limit: number;
  sortBy: 'createdAt' | 'periodTo';
  sortOrder: 'asc' | 'desc';
}

export async function listStatements(
  societyId: number,
  q: StatementListQuery,
): Promise<{ items: StatementDto[]; pagination: PageMeta }> {
  const where: WhereOptions = { societyId };
  const w = where as Record<string, unknown>;
  if (q.bankAccountId) w.bankAccountId = q.bankAccountId;
  if (q.status) w.status = q.status;
  const { rows, count } = await BankStatementImport.findAndCountAll({
    where,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ] as Order,
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { items: rows.map(statementDto), pagination: pageMeta(q.page, q.limit, count) };
}

export async function getStatement(societyId: number, id: number): Promise<StatementDto> {
  const i = await BankStatementImport.findOne({ where: { id, societyId } });
  if (!i) throw statementNotFound();
  return statementDto(i);
}

export interface LineListQuery {
  matchStatus?: 'UNMATCHED' | 'MATCHED' | 'IGNORED';
  direction?: 'CREDIT' | 'DEBIT';
  from?: string;
  to?: string;
  q?: string;
  page: number;
  limit: number;
  sortBy: 'txnDate' | 'lineNo' | 'amount';
  sortOrder: 'asc' | 'desc';
}

export async function listLines(
  societyId: number,
  importId: number,
  q: LineListQuery,
): Promise<{ items: StatementLineDto[]; pagination: PageMeta }> {
  if (!(await BankStatementImport.findOne({ where: { id: importId, societyId }, attributes: ['id'] })))
    throw statementNotFound();
  const and: Record<string | symbol, unknown>[] = [{ societyId, importId }];
  if (q.matchStatus) and.push({ matchStatus: q.matchStatus });
  if (q.direction)
    and.push(q.direction === 'CREDIT' ? { creditPaise: { [Op.gt]: 0 } } : { debitPaise: { [Op.gt]: 0 } });
  if (q.from) and.push({ txnDate: { [Op.gte]: q.from } });
  if (q.to) and.push({ txnDate: { [Op.lte]: q.to } });
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    and.push({ [Op.or]: [{ description: { [Op.like]: like } }, { reference: { [Op.like]: like } }] });
  }
  const dir = q.sortOrder.toUpperCase();
  const order: Order =
    q.sortBy === 'amount'
      ? [
          [sequelize.literal('GREATEST(debitPaise, creditPaise)'), dir],
          ['lineNo', 'ASC'],
        ]
      : [
          [q.sortBy, dir],
          ['lineNo', 'ASC'],
        ];
  const { rows, count } = await BankStatementLine.findAndCountAll({
    where: { [Op.and]: and },
    order,
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { items: rows.map(lineDto), pagination: pageMeta(q.page, q.limit, count) };
}

export const STATEMENT_PARSER_KEYS: readonly string[] = STATEMENT_FORMATS;
