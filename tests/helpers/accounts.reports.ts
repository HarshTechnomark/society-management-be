import { Expense, JournalEntry, LedgerAccount } from '../../src/models';
import { reverseEntry } from '../../src/modules/accounts/accounts.engine';
import { sequelize } from '../../src/models';
import { fundIdByType, addBankLedger, post, type AccountsWorld } from './accounts';
import type { PostJournalInput } from '../../src/modules/accounts/accounts.types';
import type { Ctx } from '../../src/types/context';

/** Ledger account id by code. */
export const ledgerId = async (societyId: number, code: string): Promise<number> =>
  Number((await LedgerAccount.findOne({ where: { societyId, code } }))!.id);

export const entryOf = async (societyId: number, refType: string, refId: string | number) =>
  (await JournalEntry.findOne({ where: { societyId, refType, refId: String(refId), reversalOfId: null } }))!;

/** An expense row that points at an already posted journal (13.2 owns the real create flow). */
export async function expenseRow(
  societyId: number,
  userId: number,
  o: {
    journalEntryId?: number | null;
    status?: string;
    head?: string;
    type?: 'DIRECT' | 'STATUTORY_DUE';
    date: string;
    gross: number;
    tds?: number;
    gst?: number;
    section?: string | null;
    challan?: string | null;
    payee?: string;
    fundId?: number | null;
    bankLedgerId: number;
  },
) {
  const tds = o.tds ?? 0;
  return Expense.create({
    societyId,
    expenseType: o.type ?? 'DIRECT',
    expenseDate: o.date,
    payee: o.payee ?? 'Lift Co',
    ledgerAccountId: await ledgerId(societyId, o.head ?? '5330'),
    grossAmountPaise: o.gross,
    gstPaise: o.gst ?? 0,
    tdsPaise: tds,
    tdsSection: o.section ?? null,
    challanNo: o.challan ?? null,
    netPaidPaise: o.gross - tds,
    paidFromLedgerAccountId: o.bankLedgerId,
    paymentMode: 'NEFT',
    fundId: o.fundId ?? null,
    status: o.status ?? 'POSTED',
    journalEntryId: o.journalEntryId ?? null,
    createdBy: userId,
  } as never);
}

/**
 * The books used by the report tests (all FY 2026-27, paise in the comments):
 * A opening 1,000,000 to bank; B receipt 200,000; C expense with GST 18,000 and TDS 20,000 (bank pays 98,000); D TDS deposit 20,000;
 * E sinking fund contribution 300,000; F cash receipt 50,000 (reversed on 07-15); G contra cash from bank 10,000; H invoice 118,000
 * with CGST and SGST of 9,000; I spend of 25,000 tagged to the sinking fund with a fund release 25,000 to 3100.
 */
export async function reportBooks(w: AccountsWorld) {
  const bank = await addBankLedger(w.sid);
  const sinking = await fundIdByType(w.sid, 'SINKING');
  const p = (input: PostJournalInput) => post(w.user, input);
  const line = (code: string, d: number, c: number, fundId?: number) => ({
    ledgerAccountCode: code,
    debitPaise: d,
    creditPaise: c,
    ...(fundId ? { fundId } : {}),
  });
  await p({
    date: '2026-04-01',
    voucherType: 'OPENING_BALANCE',
    refType: 'opening',
    refId: 'all',
    narration: 'Opening balances',
    lines: [line('1110-001', 1_000_000, 0), line('3900', 0, 1_000_000)],
  });
  await p({
    date: '2026-05-10',
    voucherType: 'RECEIPT',
    refType: 'payment',
    refId: 1,
    narration: 'Maintenance receipt',
    lines: [line('1110-001', 200_000, 0), line('4100', 0, 200_000)],
  });
  const c = await p({
    date: '2026-05-20',
    voucherType: 'PAYMENT',
    refType: 'expense',
    refId: 'C',
    narration: 'Lift AMC with TDS',
    lines: [
      line('5330', 100_000, 0),
      line('1410', 18_000, 0),
      line('1110-001', 0, 98_000),
      line('2140', 0, 20_000),
    ],
  });
  const d = await p({
    date: '2026-06-05',
    voucherType: 'PAYMENT',
    refType: 'expense',
    refId: 'D',
    narration: 'TDS deposit',
    lines: [line('2140', 20_000, 0), line('1110-001', 0, 20_000)],
  });
  await p({
    date: '2026-06-10',
    voucherType: 'RECEIPT',
    refType: 'payment',
    refId: 2,
    narration: 'Sinking fund contribution',
    lines: [line('1110-001', 300_000, 0), line('2410', 0, 300_000)],
  });
  const f = await p({
    date: '2026-06-15',
    voucherType: 'RECEIPT',
    refType: 'payment',
    refId: 3,
    narration: 'Cash receipt',
    lines: [line('1120', 50_000, 0), line('4100', 0, 50_000)],
  });
  await p({
    date: '2026-06-20',
    voucherType: 'CONTRA',
    refType: 'cash_deposit',
    refId: 1,
    narration: 'Cash withdrawn',
    lines: [line('1120', 10_000, 0), line('1110-001', 0, 10_000)],
  });
  await p({
    date: '2026-07-01',
    voucherType: 'INVOICE',
    refType: 'invoice',
    refId: 1,
    narration: 'July bills',
    lines: [
      line('1300', 118_000, 0),
      line('4100', 0, 100_000),
      line('2310', 0, 9_000),
      line('2320', 0, 9_000),
    ],
  });
  const i = await p({
    date: '2026-07-10',
    voucherType: 'PAYMENT',
    refType: 'expense',
    refId: 'I',
    narration: 'Repair from sinking fund',
    lines: [line('5330', 25_000, 0, sinking), line('1110-001', 0, 25_000)],
  });
  await p({
    date: '2026-07-10',
    voucherType: 'JOURNAL',
    refType: 'fund_release',
    refId: 1,
    narration: 'Fund release',
    lines: [line('2410', 25_000, 0), line('3100', 0, 25_000)],
  });
  await sequelize.transaction(t =>
    reverseEntry(w.user as Ctx, f.id, { date: '2026-07-15', reason: 'Cash receipt reversed' }, t),
  );
  const ex = {
    C: await expenseRow(w.sid, w.userId, {
      journalEntryId: c.id,
      date: '2026-05-20',
      gross: 118_000,
      gst: 18_000,
      tds: 20_000,
      section: '194C',
      bankLedgerId: Number(bank.id),
    }),
    D: await expenseRow(w.sid, w.userId, {
      journalEntryId: d.id,
      date: '2026-06-05',
      type: 'STATUTORY_DUE',
      head: '2140',
      gross: 20_000,
      section: '194C',
      challan: 'CHALLAN123',
      payee: 'Income Tax Department',
      bankLedgerId: Number(bank.id),
    }),
    I: await expenseRow(w.sid, w.userId, {
      journalEntryId: i.id,
      date: '2026-07-10',
      gross: 25_000,
      fundId: sinking,
      bankLedgerId: Number(bank.id),
    }),
  };
  return { bank, sinking, ex };
}
