import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { JournalEntry, JournalLine, LedgerAccount, sequelize, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import {
  billingPorts,
  fakePortsInUse as billingFakes,
  setBillingPorts,
} from '../../../src/modules/billing/billing.ports';
import {
  fakePortsInUse as paymentsFakes,
  paymentsPorts,
  setPaymentsPorts,
} from '../../../src/modules/payments/payments.ports';
import { settleInput } from '../../../src/modules/payments/payments.settle';
import { reversePaymentCore } from '../../../src/modules/payments/payments.reverse.core';
import { moneyTx } from '../../../src/modules/payments/payments.shared';
import { registerAccounts } from '../../../src/modules/accounts/accounts.public';
import { readSocietyBalance } from '../../../src/modules/accounts/accounts.lookup';
import { realBankAccountsPort, realFundsPort } from '../../../src/modules/accounts/accounts.ports-wiring';
import { mkInvoice, offline, paymentsWorld, resetPayments, sysCtx } from '../../helpers/payments';
import {
  addBankLedger,
  addCollectionBank,
  balanceOf,
  fundIdByType,
  useRealJournal,
} from '../../helpers/accounts';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetPayments();
  setBillingPorts();
  useRealJournal();
});

describe('modules 11 and 12 post through the real engine', () => {
  it('registerAccounts installs the journal behind both ports and the production guard accepts it', async () => {
    setBillingPorts();
    setPaymentsPorts();
    expect(billingFakes()).toContain('journal');
    expect(paymentsFakes()).toContain('journal');
    registerAccounts();
    expect(billingFakes()).not.toContain('journal');
    expect(paymentsFakes()).not.toContain('journal');
    expect(billingFakes()).toEqual(['approvals', 'notifications']); // the guard stays for approvals and notifications
    expect(paymentsFakes()).toEqual(['approvals', 'gateways', 'notifications']); // and gateways
  });

  it('an invoice debits 1300 and credits its heads; the voucher is an INVOICE entry', async () => {
    const w = await paymentsWorld({ flats: 2 });
    const inv = await mkInvoice(w, 0, 120_000, '2026-11-10', 77);
    const e = (await JournalEntry.findOne({ where: { societyId: w.society.id!, refType: 'invoice' } }))!;
    expect([e.voucherType, e.status, Number(e.totalPaise), e.voucherNo]).toEqual([
      'INVOICE',
      'POSTED',
      120_000,
      'JV/2026-27/000001',
    ]);
    expect(e.refId).toBe(String(inv.id));
    expect(await balanceOf(w.society.id!, '1300')).toBe(120_000);
    expect(await balanceOf(w.society.id!, '4130')).toBe(-120_000); // WATER head
    expect((await readSocietyBalance(w.society.id!)).totalPaise).toBe(0); // dues are not money
  });

  it('a bank receipt, its journal lines and the live balance (keys BANK, MEMBER_RECEIVABLE, MEMBER_ADVANCES)', async () => {
    const w = await paymentsWorld({ flats: 2 });
    const sid = w.society.id!;
    await mkInvoice(w, 0, 120_000, '2026-11-10');
    const bank = await addBankLedger(sid);
    await addCollectionBank(sid, Number(bank.id));
    const { payment } = await moneyTx(t => settleInput(sysCtx(w), offline(w, 0, 150_000), t));
    const e = (await JournalEntry.findOne({
      where: { societyId: sid, refType: 'payment', refId: String(payment.id) },
    }))!;
    expect([e.voucherType, Number(e.totalPaise), e.voucherNo]).toEqual([
      'RECEIPT',
      150_000,
      'VCH/2026-27/000001',
    ]);
    const lines = await JournalLine.findAll({
      where: { journalEntryId: e.id },
      include: [LedgerAccount],
      order: [['lineNo', 'ASC']],
    });
    expect(
      lines.map(l => [(l as any).LedgerAccount.code, Number(l.debitPaise), Number(l.creditPaise)]),
    ).toEqual([
      ['1110-001', 150_000, 0],
      ['1300', 0, 120_000],
      ['2210', 0, 30_000],
    ]);
    const b = await readSocietyBalance(sid);
    expect([b.inBankPaise, b.totalPaise]).toEqual([150_000, 150_000]);
    expect(paymentsFakes).toBeTypeOf('function');
    expect((await paymentsPorts().societyBalance.get(sid)).balancePaise).toBe(150_000);
  });

  it('a bank receipt without a collection account fails with COLLECTION_ACCOUNT_REQUIRED and rolls back', async () => {
    const w = await paymentsWorld({ flats: 2 });
    await mkInvoice(w, 0, 120_000, '2026-11-10');
    const err = await moneyTx(t => settleInput(sysCtx(w), offline(w, 0, 150_000), t)).catch(e => e);
    expect(err.code).toBe('COLLECTION_ACCOUNT_REQUIRED');
  });

  it('a cash receipt goes to 1120 and reversing the payment mirrors the journal', async () => {
    const w = await paymentsWorld({ flats: 2 });
    const sid = w.society.id!;
    await mkInvoice(w, 0, 120_000, '2026-11-10');
    const { payment } = await moneyTx(t =>
      settleInput(
        sysCtx(w),
        offline(w, 0, 120_000, { method: 'CASH', referenceNo: null, referenceKey: null } as never),
        t,
      ),
    );
    expect(await balanceOf(sid, '1120')).toBe(120_000);
    expect((await readSocietyBalance(sid)).cashPaise).toBe(120_000);
    await moneyTx(t =>
      reversePaymentCore(
        sysCtx(w),
        Number(payment.id),
        { newStatus: 'REVERSED', reason: 'entered twice' },
        t,
      ),
    );
    expect(await balanceOf(sid, '1120')).toBe(0);
    expect(await balanceOf(sid, '1300')).toBe(120_000);
    expect((await readSocietyBalance(sid)).totalPaise).toBe(0);
  });

  it('isDateLocked and accountExists of module 11 and 12 are the real ones', async () => {
    const w = await paymentsWorld({ flats: 1 });
    const sid = w.society.id!;
    expect(await billingPorts().journal.accountExists(sid, '4100')).toBe(true);
    expect(await billingPorts().journal.accountExists(sid, '1110')).toBe(false);
    expect(await paymentsPorts().journal.accountExists(sid, 'MEMBER_RECEIVABLE')).toBe(true);
    await sequelize.query('UPDATE society_balances SET booksLockedThrough = ? WHERE societyId = ?', {
      replacements: ['2026-09-30', sid],
    });
    expect(await billingPorts().journal.isDateLocked(sid, '2026-09-15')).toBe(true);
    expect(await paymentsPorts().journal.isDateLocked(sid, '2026-10-15')).toBe(false);
  });

  it('the fund and bank account lookups of 13.2 are ready but not installed yet', async () => {
    const w = await paymentsWorld({ flats: 1 });
    const sid = w.society.id!;
    await sequelize.transaction(async t =>
      (await import('../../../src/modules/accounts/accounts.chart')).ensureBooks(t, sid),
    );
    const fundId = await fundIdByType(sid, 'REPAIR');
    expect(await realFundsPort.exists(sid, fundId)).toBe(true);
    expect(await realFundsPort.name(sid, fundId)).toBe('Repair and maintenance fund');
    expect(await realFundsPort.exists(sid, 999_999)).toBe(false);
    expect(await realBankAccountsPort.get(sid, 999_999)).toBeNull();
    const bank = await addBankLedger(sid);
    const bankAccountId = await addCollectionBank(sid, Number(bank.id));
    expect(await realBankAccountsPort.get(sid, bankAccountId)).toEqual({
      id: bankAccountId,
      label: 'Test bank (XXXXXX4821)',
    });
    // module 12 keeps its permissive placeholders until 13.2 swaps them
    expect(await paymentsPorts().funds.exists(sid, 999_999)).toBe(true);
    expect(await paymentsPorts().bankAccounts.get(sid, 999_999)).not.toBeNull();
  });
});
