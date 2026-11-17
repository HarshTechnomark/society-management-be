import { LedgerAccount, SocietyBalance } from '../../models';
import { audit } from '../../utils/audit';
import { ConflictError, ValidationError } from '../../utils/errors';
import { assertFeature } from '../subscriptions/entitlements.service';
import { moneyTx } from '../payments/payments.shared';
import { AUDIT, CODE, ERR, KEY_BANK, KEY_COLLECTION_FUND, SYSTEM_KEYS } from './accounts.constants';
import { ensureBooks } from './accounts.chart';
import { postJournal } from './accounts.engine';
import { n, societyIdOf, societyToday, startOfYearAfter } from './accounts.shared';
import type { OpeningInput } from './accounts.opening.validation';
import type { Ctx, JournalLineInput } from './accounts.types';
import { ENT } from './accounts.constants';

/** BR-13-51: opening lines on these subtypes are "simple" and allowed on every plan. */
const SIMPLE_SUBTYPES = new Set(['BANK', 'CASH', 'PETTY_CASH', 'FUND']);

export interface OpeningResult {
  journalEntryId: number;
  voucherNo: string;
  entryDate: string;
  replayed: boolean;
  totalPaise: number;
  balancingLine: { ledgerAccountCode: string; debitPaise: number; creditPaise: number } | null;
}

/** True when every line is on a bank, cash, petty cash or fund ledger. Unknown codes count as simple: the engine reports them as 422. */
async function isSimple(societyId: number, lines: OpeningInput['lines'], t: import('sequelize').Transaction) {
  const codes = lines
    .map(l => l.ledgerAccountCode)
    .filter(c => c !== KEY_BANK && c !== KEY_COLLECTION_FUND)
    .map(c => SYSTEM_KEYS[c] ?? c);
  if (!codes.length) return true;
  const found = await LedgerAccount.findAll({
    where: { societyId, code: [...new Set(codes)] },
    attributes: ['code', 'subtype', 'isGroup'],
    transaction: t,
  });
  return found.every(a => a.isGroup || SIMPLE_SUBTYPES.has(a.subtype));
}

/** 8.12: one `OPENING_BALANCE` voucher through the engine, `refType 'opening'`, `refId` = the Idempotency-Key. */
export async function postOpeningBalances(
  ctx: Ctx,
  input: OpeningInput,
  idemKey: string,
): Promise<OpeningResult> {
  const societyId = societyIdOf(ctx);
  if (input.asOfDate > (await societyToday(societyId)))
    throw new ValidationError([{ field: 'asOfDate', message: 'The date must not be in the future' }]);
  return moneyTx(async t => {
    await ensureBooks(t, societyId);
    const books = await SocietyBalance.findOne({ where: { societyId }, transaction: t });
    const closed = books?.lastClosedFinancialYear;
    if (closed && input.asOfDate < startOfYearAfter(closed))
      throw new ConflictError(ERR.periodLocked, `The financial year ${closed} is closed; use a later date`);

    const simple = await isSimple(societyId, input.lines, t);
    if (!simple) {
      await assertFeature(ctx, ENT.openingBalanceImport);
      if (input.autoBalance === true)
        throw new ValidationError([
          { field: 'autoBalance', message: 'Auto balancing is only for bank, cash and fund lines' },
        ]);
    }
    const autoBalance = simple ? (input.autoBalance ?? true) : false;

    const lines: JournalLineInput[] = input.lines.map(l => ({
      ledgerAccountCode: l.ledgerAccountCode,
      debitPaise: l.debitPaise,
      creditPaise: l.creditPaise,
      ...(l.fundId ? { fundId: l.fundId } : {}),
    }));
    let balancingLine: OpeningResult['balancingLine'] = null;
    if (autoBalance) {
      const debit = lines.reduce((s, l) => s + (Number.isFinite(l.debitPaise) ? l.debitPaise : 0), 0);
      const credit = lines.reduce((s, l) => s + (Number.isFinite(l.creditPaise) ? l.creditPaise : 0), 0);
      if (debit !== credit) {
        balancingLine = {
          ledgerAccountCode: CODE.openingAdjustment,
          debitPaise: credit > debit ? credit - debit : 0,
          creditPaise: debit > credit ? debit - credit : 0,
        };
        lines.push(balancingLine);
      }
    }
    const narration = input.narration ?? `Opening balances as of ${input.asOfDate}`;
    const posted = await postJournal(
      ctx,
      {
        date: input.asOfDate,
        voucherType: 'OPENING_BALANCE',
        refType: 'opening',
        refId: idemKey,
        narration,
        label: 'Opening balances',
        lines,
      },
      t,
    );
    const totalPaise = lines.reduce((s, l) => s + l.debitPaise, 0);
    if (!posted.replayed)
      await audit(
        ctx,
        {
          action: AUDIT.openingBalancePosted,
          entityType: 'journal_entry',
          entityId: n(posted.id),
          entityLabel: posted.voucherNo,
          societyId,
          after: {
            asOfDate: input.asOfDate,
            lines: lines.length,
            totalPaise,
            autoBalanced: balancingLine !== null,
          },
        },
        t,
      );
    return {
      journalEntryId: n(posted.id),
      voucherNo: posted.voucherNo,
      entryDate: posted.entryDate,
      replayed: posted.replayed,
      totalPaise,
      balancingLine,
    };
  });
}
