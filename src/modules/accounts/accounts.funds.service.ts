import { QueryTypes } from 'sequelize';
import { Fund, LedgerAccount, SocietyBalance, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { assertFeature } from '../subscriptions/entitlements.service';
import { financialYearOf } from '../../utils/numberSequences';
import { ConflictError, UnprocessableError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { moneyTx } from '../payments/payments.shared';
import { ensureBooks } from './accounts.chart';
import { AUDIT, CODE, ENT, ERR, type FundType } from './accounts.constants';
import { addDaysYmd, n, societyIdOf, societyToday, invalidState } from './accounts.shared';
import { fundNotFound, groupLedger, nextLedgerCode, staleVersion } from './accounts.bank.shared';
import type {
  FundCreateInput,
  FundListQuery,
  FundPatchInput,
  FundStatementQuery,
} from './accounts.funds.validation';

/** 13.2 funds (section 5.4 and 8.13): list, statement, create, edit and close. Money moves only through `POST /accounts/fund-transfers`. */
export interface FundItemDto {
  id: number;
  name: string;
  fundType: FundType;
  ledgerCode: string;
  balancePaise: number;
  /** Contributions and other credits of the financial year, fund transfers left out. */
  inflowFyPaise: number;
  /** Spending of the financial year (expenses paid from the fund), fund transfers left out. */
  outflowFyPaise: number;
  movedInFyPaise: number;
  movedOutFyPaise: number;
  purpose: string | null;
  usageRequiresResolution: boolean;
  showToResidents: boolean;
  status: string;
  version: number;
}

const startOfFy = (today: string): string => {
  const fy = financialYearOf(today);
  return `${fy.slice(0, 4)}-04-01`;
};

/** A society that has never touched the books gets its chart and the three standard funds on the first read (BR-13-15, as the lookups do). */
async function seedIfNeeded(societyId: number): Promise<void> {
  const books = await SocietyBalance.findOne({ where: { societyId }, attributes: ['chartSeededAt'] });
  if (!books?.chartSeededAt) await sequelize.transaction(t => ensureBooks(t, societyId));
}

export async function listFunds(societyId: number, q: FundListQuery): Promise<FundItemDto[]> {
  await seedIfNeeded(societyId);
  const today = await societyToday(societyId);
  const rows = await sequelize.query<Record<string, unknown>>(
    `SELECT f.id, f.name, f.fundType, f.purpose, f.usageRequiresResolution, f.showToResidents, f.status, f.version,
            l.code AS ledgerCode, -l.balancePaise AS balancePaise,
            COALESCE((SELECT SUM(jl.creditPaise) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journalEntryId
                       WHERE jl.ledgerAccountId = l.id AND je.status = 'POSTED' AND je.entryDate BETWEEN :fyStart AND :today AND je.refType <> 'fund_transfer'), 0) AS inflowFyPaise,
            COALESCE((SELECT SUM(jl.debitPaise) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journalEntryId
                       WHERE jl.ledgerAccountId = l.id AND je.status = 'POSTED' AND je.entryDate BETWEEN :fyStart AND :today AND je.refType <> 'fund_transfer'), 0) AS outflowFyPaise,
            COALESCE((SELECT SUM(jl.creditPaise) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journalEntryId
                       WHERE jl.ledgerAccountId = l.id AND je.status = 'POSTED' AND je.entryDate BETWEEN :fyStart AND :today AND je.refType = 'fund_transfer'), 0) AS movedInFyPaise,
            COALESCE((SELECT SUM(jl.debitPaise) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journalEntryId
                       WHERE jl.ledgerAccountId = l.id AND je.status = 'POSTED' AND je.entryDate BETWEEN :fyStart AND :today AND je.refType = 'fund_transfer'), 0) AS movedOutFyPaise
       FROM funds f JOIN ledger_accounts l ON l.id = f.ledgerAccountId
      WHERE f.societyId = :societyId AND (:status = 'ALL' OR f.status = :status) AND (:fundType IS NULL OR f.fundType = :fundType)
      ORDER BY f.id`,
    {
      replacements: {
        societyId,
        status: q.status,
        fundType: q.fundType ?? null,
        fyStart: startOfFy(today),
        today,
      },
      type: QueryTypes.SELECT,
    },
  );
  return rows.map(r => ({
    id: n(r.id),
    name: String(r.name),
    fundType: r.fundType as FundType,
    ledgerCode: String(r.ledgerCode),
    balancePaise: n(r.balancePaise),
    inflowFyPaise: n(r.inflowFyPaise),
    outflowFyPaise: n(r.outflowFyPaise),
    movedInFyPaise: n(r.movedInFyPaise),
    movedOutFyPaise: n(r.movedOutFyPaise),
    purpose: (r.purpose as string | null) ?? null,
    usageRequiresResolution: Boolean(r.usageRequiresResolution),
    showToResidents: Boolean(r.showToResidents),
    status: String(r.status),
    version: n(r.version),
  }));
}

async function oneFund(societyId: number, id: number): Promise<FundItemDto> {
  const f = (await listFunds(societyId, { status: 'ALL' })).find(x => x.id === id);
  if (!f) throw fundNotFound();
  return f;
}

export interface FundStatementRow {
  date: string;
  voucherNo: string | null;
  narration: string;
  inPaise: number;
  outPaise: number;
  runningPaise: number;
  /** CONTRIBUTION, EXPENSE (spending), TRANSFER_IN or TRANSFER_OUT. */
  kind: 'CONTRIBUTION' | 'EXPENSE' | 'TRANSFER_IN' | 'TRANSFER_OUT';
}

export async function fundStatement(societyId: number, id: number, q: FundStatementQuery) {
  const fund = await Fund.findOne({ where: { id, societyId } });
  if (!fund) throw fundNotFound();
  const today = await societyToday(societyId);
  const from = q.from ?? startOfFy(today);
  const to = q.to ?? today;
  if (from > to) throw new ValidationError([{ field: 'from', message: 'From must not be after To' }]);
  if (addDaysYmd(from, 366) < to)
    throw new ValidationError([{ field: 'to', message: 'The range is at most 366 days' }]);
  const [open] = await sequelize.query<{ s: string | null }>(
    `SELECT COALESCE(SUM(jl.creditPaise - jl.debitPaise), 0) AS s FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journalEntryId
      WHERE jl.ledgerAccountId = :ledgerId AND je.status = 'POSTED' AND je.entryDate < :from`,
    { replacements: { ledgerId: n(fund.ledgerAccountId), from }, type: QueryTypes.SELECT },
  );
  const lines = await sequelize.query<Record<string, unknown>>(
    `SELECT je.entryDate AS date, je.voucherNo, COALESCE(jl.lineNarration, je.narration) AS narration,
            jl.creditPaise AS inPaise, jl.debitPaise AS outPaise, je.refType AS refType
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journalEntryId
      WHERE jl.ledgerAccountId = :ledgerId AND je.status = 'POSTED' AND je.entryDate BETWEEN :from AND :to
      ORDER BY je.entryDate, je.id, jl.lineNo`,
    { replacements: { ledgerId: n(fund.ledgerAccountId), from, to }, type: QueryTypes.SELECT },
  );
  let running = n(open?.s);
  const openingPaise = running;
  const rows: FundStatementRow[] = lines.map(l => {
    running += n(l.inPaise) - n(l.outPaise);
    return {
      date: String(l.date).slice(0, 10),
      voucherNo: (l.voucherNo as string | null) ?? null,
      narration: String(l.narration ?? ''),
      inPaise: n(l.inPaise),
      outPaise: n(l.outPaise),
      runningPaise: running,
      kind:
        l.refType === 'fund_transfer'
          ? n(l.inPaise) > 0
            ? ('TRANSFER_IN' as const)
            : ('TRANSFER_OUT' as const)
          : n(l.outPaise) > 0
            ? ('EXPENSE' as const)
            : ('CONTRIBUTION' as const),
    };
  });
  return {
    fundId: n(fund.id),
    name: fund.name,
    from,
    to,
    openingPaise,
    closingPaise: running,
    rows,
  };
}

const duplicateName = () => new ConflictError(ERR.duplicateFundName, 'A fund with this name already exists');
const keyOf = (name: string) => name.trim().toLowerCase();

export async function createFund(ctx: Ctx, input: FundCreateInput): Promise<FundItemDto> {
  const societyId = societyIdOf(ctx);
  if (input.fundType === 'CUSTOM') await assertFeature(ctx, ENT.funds);
  const id = await moneyTx(async t => {
    await ensureBooks(t, societyId);
    const nameKey = keyOf(input.name);
    if (await Fund.findOne({ where: { societyId, nameKey }, transaction: t })) throw duplicateName();
    const groupCode = input.fundType === 'CUSTOM' ? CODE.customFundsGroup : CODE.collectionFundsGroup;
    const group = await groupLedger(societyId, groupCode, t);
    const code = await nextLedgerCode(societyId, groupCode, t);
    const ledger = await LedgerAccount.create(
      {
        societyId,
        code,
        name: input.name,
        accountType: 'FUND',
        subtype: 'FUND',
        parentId: n(group.id),
        isSystem: true,
        createdBy: ctx.user?.id ?? null,
      } as never,
      { transaction: t },
    );
    const f = await Fund.create(
      {
        societyId,
        fundType: input.fundType,
        name: input.name,
        nameKey,
        ledgerAccountId: n(ledger.id),
        purpose: input.purpose ?? null,
        usageRequiresResolution: input.usageRequiresResolution ?? false,
        showToResidents: input.showToResidents ?? true,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
      } as never,
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.fundCreated,
        entityType: 'fund',
        entityId: n(f.id),
        entityLabel: f.name,
        societyId,
        before: null,
        after: { id: n(f.id), name: f.name, fundType: f.fundType, ledgerCode: code },
      },
      t,
    );
    return n(f.id);
  });
  return oneFund(societyId, id);
}

export async function patchFund(ctx: Ctx, id: number, input: FundPatchInput): Promise<FundItemDto> {
  const societyId = societyIdOf(ctx);
  await moneyTx(async t => {
    await ensureBooks(t, societyId);
    const f = await Fund.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!f) throw fundNotFound();
    if (n(f.version) !== input.version) throw staleVersion();
    if (f.status !== 'ACTIVE') throw invalidState('This fund is closed');
    const ledger = (await LedgerAccount.findByPk(n(f.ledgerAccountId), {
      transaction: t,
      lock: t.LOCK.UPDATE,
    }))!;
    const before = {
      name: f.name,
      purpose: f.purpose,
      usageRequiresResolution: Boolean(f.usageRequiresResolution),
      showToResidents: Boolean(f.showToResidents),
      status: f.status,
    };
    if (input.status === 'CLOSED') {
      if (f.fundType !== 'COLLECTION' && f.fundType !== 'CUSTOM')
        throw new UnprocessableError(ERR.systemAccountLocked, 'The standard funds cannot be closed');
      if (n(ledger.balancePaise) !== 0)
        throw new UnprocessableError(ERR.fundBalanceNotZero, 'The fund balance must be zero to close it');
    }
    if (input.name !== undefined && keyOf(input.name) !== f.nameKey) {
      if (await Fund.findOne({ where: { societyId, nameKey: keyOf(input.name) }, transaction: t }))
        throw duplicateName();
      f.name = input.name;
      f.nameKey = keyOf(input.name);
      ledger.name = input.name;
      await ledger.save({ transaction: t });
    }
    if (input.purpose !== undefined) f.purpose = input.purpose;
    if (input.usageRequiresResolution !== undefined)
      f.usageRequiresResolution = input.usageRequiresResolution;
    if (input.showToResidents !== undefined) f.showToResidents = input.showToResidents;
    if (input.status === 'CLOSED') {
      f.status = 'CLOSED';
      f.closedAt = new Date();
    }
    f.updatedBy = ctx.user?.id ?? null;
    f.version = n(f.version) + 1;
    await f.save({ transaction: t });
    await audit(
      ctx,
      {
        action: input.status === 'CLOSED' ? AUDIT.fundClosed : AUDIT.fundUpdated,
        entityType: 'fund',
        entityId: n(f.id),
        entityLabel: f.name,
        societyId,
        before,
        after: {
          name: f.name,
          purpose: f.purpose,
          usageRequiresResolution: Boolean(f.usageRequiresResolution),
          showToResidents: Boolean(f.showToResidents),
          status: f.status,
        },
      },
      t,
    );
  });
  return oneFund(societyId, id);
}
