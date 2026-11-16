import { createHash } from 'node:crypto';
import { QueryTypes, type Transaction } from 'sequelize';
import { BalanceHistory, Fund, JournalEntry, LedgerAccount, SocietyBalance, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { emitToRoom } from '../../lib/realtime';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, UnprocessableError } from '../../utils/errors';
import { settings } from '../society-setup/society-setup.public';
import type { Ctx } from '../../types/context';
import {
  ERR,
  KEY_BANK,
  KEY_COLLECTION_FUND,
  MAX_JOURNAL_LINES,
  MAX_LINE_PAISE,
  RT,
  SYSTEM_KEYS,
  roomFinance,
  roomPublic,
  type BalanceDirection,
} from './accounts.constants';
import { CODE_RE, collectionBank } from './accounts.lookup';
import { accountsPorts } from './accounts.ports';
import { n } from './accounts.shared';

/**
 * The shared steps of `journal.post`, `postDraft` and the reversal (BR-13-1 to BR-13-12): line validation, account and fund
 * resolution, balance and ledger maintenance, history, realtime. Nothing here opens a transaction.
 */

/** A line as callers give it: by code or system key, or (drafts, reversals) by ledger account id. */
export interface RawLine {
  ledgerAccountCode?: string;
  ledgerAccountId?: number;
  debitPaise: number;
  creditPaise: number;
  fundId?: number | null;
  lineNarration?: string | null;
}

export interface ResolvedLine {
  lineNo: number;
  account: LedgerAccount;
  fundId: number | null;
  debitPaise: number;
  creditPaise: number;
  lineNarration: string | null;
}

const bad = (message: string, field = 'lines') =>
  new UnprocessableError(ERR.journalLineInvalid, message, [{ field, message }]);

/** BR-13-1 and BR-13-2: shape of the lines, then the balance. Pure; nothing is read or written. */
export function validateLines(lines: readonly RawLine[]): { debitPaise: number; creditPaise: number } {
  if (!Array.isArray(lines) || lines.length < 2) throw bad('A journal needs at least 2 lines');
  if (lines.length > MAX_JOURNAL_LINES) throw bad(`A journal has at most ${MAX_JOURNAL_LINES} lines`);
  let debit = 0;
  let credit = 0;
  lines.forEach((l, i) => {
    const d = l.debitPaise;
    const c = l.creditPaise;
    const field = `lines[${i}]`;
    if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0)
      throw bad('Amounts are whole paise, zero or more', field);
    if (d > 0 === c > 0) throw bad('A line has either a debit or a credit, not both and not neither', field);
    if (d > MAX_LINE_PAISE || c > MAX_LINE_PAISE) throw bad('Amount is too large', field);
    debit += d;
    credit += c;
  });
  if (debit !== credit)
    throw new UnprocessableError(ERR.journalNotBalanced, 'Debits do not equal credits', [
      { field: 'lines', message: 'Debits do not equal credits', debitPaise: debit, creditPaise: credit },
    ]);
  return { debitPaise: debit, creditPaise: credit };
}

/** BR-13-6: SHA-256 of the canonical lines (resolved ledger id, fund, debit, credit), order independent. */
export function hashLines(lines: readonly ResolvedLine[]): string {
  const canon = lines
    .map(l => `${n(l.account.id)}|${l.fundId ?? ''}|${l.debitPaise}|${l.creditPaise}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(canon).digest('hex');
}

/**
 * BR-13-3: resolves codes and system keys, checks leaf, active, fund; locks the touched ledger rows `FOR UPDATE` (the caller holds the
 * `society_balances` lock, so lock order is the one of BR-13-10) and returns fresh balances. `checkActive = false` for reversals.
 */
export async function resolveLines(
  societyId: number,
  lines: readonly RawLine[],
  t: Transaction,
  opts: { checkActive?: boolean } = {},
): Promise<ResolvedLine[]> {
  const checkActive = opts.checkActive ?? true;
  // funds named on lines
  const explicitFundIds = [...new Set(lines.map(l => l.fundId).filter((v): v is number => Boolean(v)))];
  const fundsById = new Map<number, Fund>();
  if (explicitFundIds.length)
    for (const f of await Fund.findAll({
      where: { societyId, id: explicitFundIds },
      transaction: t,
      lock: t.LOCK.UPDATE,
    }))
      fundsById.set(n(f.id), f);
  explicitFundIds.forEach(id => {
    if (!fundsById.has(id)) throw bad('Fund not found in this society', 'lines.fundId');
  });

  // code of every line
  let collection: Awaited<ReturnType<typeof collectionBank>> | undefined;
  const codes: (string | null)[] = [];
  const ids: (number | null)[] = [];
  for (const [i, l] of lines.entries()) {
    const field = `lines[${i}].ledgerAccountCode`;
    if (l.ledgerAccountId) {
      codes.push(null);
      ids.push(l.ledgerAccountId);
      continue;
    }
    const raw = String(l.ledgerAccountCode ?? '');
    ids.push(null);
    if (raw === KEY_COLLECTION_FUND) {
      if (!l.fundId) throw bad('COLLECTION_FUND needs a fundId', `lines[${i}].fundId`);
      const lid = fundsById.get(n(l.fundId))!.ledgerAccountId;
      codes.push(null);
      ids[i] = n(lid);
    } else if (raw === KEY_BANK) {
      collection ??= await collectionBank(societyId, t);
      if (!collection)
        throw new UnprocessableError(
          ERR.collectionAccountRequired,
          'The society has no collection bank account',
        );
      codes.push(collection.ledgerCode);
    } else {
      const code = SYSTEM_KEYS[raw] ?? raw;
      if (!CODE_RE.test(code))
        throw new UnprocessableError(ERR.unknownLedgerCode, `Unknown ledger code ${raw}`, [
          { field, message: `Unknown ledger code ${raw}` },
        ]);
      codes.push(code);
    }
  }

  const wantedCodes = [...new Set(codes.filter((c): c is string => c !== null))];
  const wantedIds = [...new Set(ids.filter((v): v is number => v !== null))];
  const byCode = new Map<string, LedgerAccount>();
  const byId = new Map<number, LedgerAccount>();
  const loaded: LedgerAccount[] = [];
  if (wantedCodes.length)
    loaded.push(
      ...(await LedgerAccount.findAll({
        where: { societyId, code: wantedCodes },
        order: [['id', 'ASC']],
        transaction: t,
        lock: t.LOCK.UPDATE,
      })),
    );
  const extraIds = wantedIds.filter(id => !loaded.some(a => n(a.id) === id));
  if (extraIds.length)
    loaded.push(
      ...(await LedgerAccount.findAll({
        where: { societyId, id: extraIds },
        order: [['id', 'ASC']],
        transaction: t,
        lock: t.LOCK.UPDATE,
      })),
    );
  for (const a of loaded) {
    byCode.set(a.code, a);
    byId.set(n(a.id), a);
  }

  // the fund each fund ledger belongs to
  const fundLedgerIds = loaded.filter(a => a.subtype === 'FUND' && !a.isGroup).map(a => n(a.id));
  const fundsByLedger = new Map<number, Fund>();
  if (fundLedgerIds.length)
    for (const f of await Fund.findAll({
      where: { societyId, ledgerAccountId: fundLedgerIds },
      transaction: t,
      lock: t.LOCK.UPDATE,
    }))
      fundsByLedger.set(n(f.ledgerAccountId), f);

  return lines.map((l, i) => {
    const field = `lines[${i}].ledgerAccountCode`;
    const account = ids[i] ? byId.get(ids[i]!) : byCode.get(codes[i]!);
    if (!account)
      throw new UnprocessableError(
        ERR.unknownLedgerCode,
        `Unknown ledger code ${l.ledgerAccountCode ?? l.ledgerAccountId}`,
        [{ field, message: 'Unknown ledger code' }],
      );
    if (account.isGroup)
      throw new UnprocessableError(ERR.accountNotPostable, `${account.code} is a group account`, [
        { field, message: 'Group accounts take no postings' },
      ]);
    if (checkActive && !account.isActive)
      throw new UnprocessableError(ERR.accountInactive, `${account.code} is inactive`, [
        { field, message: 'Account is inactive' },
      ]);
    let fundId: number | null = l.fundId ? n(l.fundId) : null;
    const own = fundsByLedger.get(n(account.id));
    if (own) {
      if (fundId && fundId !== n(own.id))
        throw bad('A line on a fund ledger cannot carry another fund', `lines[${i}].fundId`);
      fundId = n(own.id);
    }
    if (checkActive && fundId) {
      const f = fundsById.get(fundId) ?? own;
      if (f && f.status !== 'ACTIVE')
        throw new UnprocessableError(ERR.fundInactive, `Fund ${f.name} is closed`, [
          { field: `lines[${i}].fundId`, message: 'Fund is closed' },
        ]);
    }
    return {
      lineNo: i + 1,
      account,
      fundId,
      debitPaise: l.debitPaise,
      creditPaise: l.creditPaise,
      lineNarration: l.lineNarration ? String(l.lineNarration).slice(0, 200) : null,
    };
  });
}

export interface BalanceEffect {
  direction: BalanceDirection | null;
  deltaTotalPaise: number;
  entryDate: string;
}

/**
 * BR-13-11: ledger balances, `society_balances` figures and one `balance_history` row, in the caller's transaction. Returns the effect
 * so the caller can emit `balance.updated` after commit. `books` is the row locked by `lockBooks`.
 */
export async function applyBalances(
  ctx: Ctx,
  books: SocietyBalance,
  entry: { id: number; entryDate: string; refType: string; narration: string; label?: string },
  lines: readonly ResolvedLine[],
  opts: { enforceFundBalance?: boolean },
  t: Transaction,
): Promise<BalanceEffect> {
  const societyId = n(books.societyId);
  const at = now();
  const delta = new Map<number, { account: LedgerAccount; delta: number }>();
  for (const l of lines) {
    const cur = delta.get(n(l.account.id)) ?? { account: l.account, delta: 0 };
    cur.delta += l.debitPaise - l.creditPaise;
    delta.set(n(l.account.id), cur);
  }
  const fig = { inBank: 0, clearing: 0, cash: 0, cheques: 0, investments: 0, earmarked: 0 };
  for (const { account, delta: d } of [...delta.values()].sort((a, b) => n(a.account.id) - n(b.account.id))) {
    if (d === 0) continue;
    const next = n(account.balancePaise) + d;
    switch (account.subtype) {
      case 'BANK':
        fig.inBank += d;
        break;
      case 'CLEARING':
        fig.clearing += d;
        break;
      case 'CASH':
      case 'PETTY_CASH':
        fig.cash += d;
        break;
      case 'CHEQUES':
        fig.cheques += d;
        break;
      case 'INVESTMENT':
        fig.investments += d;
        break;
      case 'FUND':
        fig.earmarked -= d;
        if (opts.enforceFundBalance && ctx.user && d > 0 && -next < 0)
          throw new UnprocessableError(
            ERR.fundBalanceInsufficient,
            `${account.name} has too little balance`,
            [{ field: 'lines', message: 'The fund balance would go below zero' }],
          );
        break;
      default:
    }
    await sequelize.query(
      'UPDATE ledger_accounts SET balancePaise = balancePaise + :d, lastPostedAt = :at, updatedAt = :at WHERE id = :id',
      { replacements: { d, at, id: n(account.id) }, transaction: t },
    );
  }

  const moneyMoved = fig.inBank !== 0 || fig.clearing !== 0 || fig.cash !== 0 || fig.cheques !== 0;
  const touched = moneyMoved || fig.investments !== 0 || fig.earmarked !== 0;
  const deltaTotal = fig.inBank + fig.clearing + fig.cash + fig.cheques;
  if (!touched) return { direction: null, deltaTotalPaise: 0, entryDate: entry.entryDate };

  books.inBankPaise = n(books.inBankPaise) + fig.inBank;
  books.clearingPaise = n(books.clearingPaise) + fig.clearing;
  books.cashPaise = n(books.cashPaise) + fig.cash;
  books.chequesPaise = n(books.chequesPaise) + fig.cheques;
  books.totalPaise =
    n(books.inBankPaise) + n(books.clearingPaise) + n(books.cashPaise) + n(books.chequesPaise);
  books.investmentsPaise = n(books.investmentsPaise) + fig.investments;
  books.earmarkedFundsPaise = n(books.earmarkedFundsPaise) + fig.earmarked;
  books.lastJournalEntryId = entry.id;
  books.lastChangedAt = at;
  await books.save({ transaction: t });

  const direction: BalanceDirection =
    deltaTotal > 0 ? 'IN' : deltaTotal < 0 ? 'OUT' : moneyMoved ? 'MOVE' : 'FUND_ONLY';
  await BalanceHistory.create(
    {
      societyId,
      journalEntryId: entry.id,
      changedAt: at,
      entryDate: entry.entryDate,
      direction,
      deltaTotalPaise: deltaTotal,
      inBankPaise: n(books.inBankPaise),
      clearingPaise: n(books.clearingPaise),
      cashPaise: n(books.cashPaise),
      chequesPaise: n(books.chequesPaise),
      totalPaise: n(books.totalPaise),
      earmarkedFundsPaise: n(books.earmarkedFundsPaise),
      label: (entry.label ?? entry.narration).slice(0, 160),
      refType: entry.refType,
      createdBy: ctx.user?.id ?? null,
    },
    { transaction: t },
  );
  return { direction, deltaTotalPaise: deltaTotal, entryDate: entry.entryDate };
}

/** Realtime and cache after commit (BR-13-12, 9.4, 8.21): `balance.updated` on the finance room and, when allowed, the public room. */
export async function announce(
  books: SocietyBalance,
  entry: { id: number; label: string },
  effect: BalanceEffect,
  t: Transaction,
): Promise<void> {
  const societyId = n(books.societyId);
  let publicFunds: { id: number; balancePaise: number }[] | null = null;
  if (effect.direction) {
    const visible = await Promise.resolve(settings.get(societyId, 'finance.showFinancesToResidents' as never))
      .then(Boolean)
      .catch(() => false);
    if (visible) {
      const rows = await sequelize.query<{ id: number; balancePaise: string }>(
        `SELECT f.id, -l.balancePaise AS balancePaise FROM funds f JOIN ledger_accounts l ON l.id = f.ledgerAccountId
          WHERE f.societyId = :societyId AND f.showToResidents = 1 AND f.status = 'ACTIVE' ORDER BY f.id`,
        { replacements: { societyId }, type: QueryTypes.SELECT, transaction: t },
      );
      publicFunds = rows.map(r => ({ id: n(r.id), balancePaise: n(r.balancePaise) }));
    }
  }
  const changedAt = (books.lastChangedAt ?? now()).toISOString();
  const figures = {
    totalPaise: n(books.totalPaise),
    inBankPaise: n(books.inBankPaise),
    clearingPaise: n(books.clearingPaise),
    cashPaise: n(books.cashPaise),
    chequesPaise: n(books.chequesPaise),
  };
  const earmarked = n(books.earmarkedFundsPaise);
  t.afterCommit(() => {
    if (effect.direction) {
      emitToRoom(roomFinance(societyId), RT.balanceUpdated, {
        ...figures,
        earmarkedFundsPaise: earmarked,
        changedAt,
        journalEntryId: entry.id,
        direction: effect.direction,
        deltaTotalPaise: effect.deltaTotalPaise,
        label: entry.label,
      });
      if (publicFunds)
        emitToRoom(roomPublic(societyId), RT.balanceUpdated, { ...figures, funds: publicFunds, changedAt });
    }
    try {
      void Promise.resolve(accountsPorts().reportsCache.touch(societyId, 'finance')).catch(() => undefined);
    } catch {
      /* the cache touch never fails a posting */
    }
  });
}

export async function auditEntry(
  ctx: Ctx,
  action: string,
  entry: JournalEntry,
  societyId: number,
  t: Transaction,
  reason?: string,
): Promise<void> {
  await audit(
    ctx,
    {
      action,
      entityType: 'journal_entry',
      entityId: n(entry.id),
      entityLabel: entry.voucherNo,
      societyId,
      after: {
        voucherNo: entry.voucherNo,
        voucherType: entry.voucherType,
        entryDate: entry.entryDate,
        refType: entry.refType,
        refId: entry.refId,
        totalPaise: n(entry.totalPaise),
      },
      reason: reason ?? null,
    },
    t,
  );
}

export const periodLocked = (date: string): AppError =>
  new ConflictError(ERR.periodLocked, `The books are locked for ${date}`);
