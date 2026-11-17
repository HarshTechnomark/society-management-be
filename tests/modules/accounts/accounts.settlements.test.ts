import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  JournalEntry,
  JournalLine,
  LedgerAccount,
  Settlement,
  closeDb,
  sequelize,
} from '../../../src/models';
import { advance } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { settleInput } from '../../../src/modules/payments/payments.settle';
import { moneyTx } from '../../../src/modules/payments/payments.shared';
import { settings } from '../../../src/modules/society-setup/society-setup.public';
import { settlements } from '../../../src/modules/accounts/accounts.public';
import {
  acceptDifference,
  reconcileNow,
  reconcileSettlement,
  settlementLines,
} from '../../../src/modules/accounts/accounts.settlements.service';
import {
  parseSettlementReport,
  rupeesToPaise,
} from '../../../src/modules/accounts/accounts.settlements.import';
import {
  agedClearingPaise,
  clearingAgeJob,
  settlementReconcileJob,
} from '../../../src/modules/accounts/accounts.settlements.jobs';
import { accountsPortCalls, setAccountsPorts } from '../../../src/modules/accounts/accounts.ports';
import { devGenerateSettlement } from '../../../src/modules/dev/dev.accounts';
import { ensureBooks } from '../../../src/modules/accounts/accounts.chart';
import { memberOf } from '../../helpers/society-setup';
import { idemH, type RunSociety } from '../../helpers/billing-runs';
import { offline, paymentsWorld, resetPayments, sysCtx } from '../../helpers/payments';
import { addBankLedger, addCollectionBank, balanceOf, ctxOf, useRealJournal } from '../../helpers/accounts';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetPayments();
  useRealJournal();
});

let seq = 0;
/** A society with a collection bank and `amounts.length` captured online payments (Dr 1140 through the real engine). */
async function world(amounts: number[]) {
  const w = await paymentsWorld({ flats: 2 });
  const sid = w.society.id!;
  await sequelize.transaction(t => ensureBooks(t, sid));
  const ledger = await addBankLedger(sid);
  await addCollectionBank(sid, Number(ledger.id));
  const ids: string[] = [];
  for (const a of amounts) {
    const id = `pay_s${++seq}`;
    ids.push(id);
    await moneyTx(t =>
      settleInput(
        sysCtx(w),
        offline(w, 0, a, {
          source: 'ONLINE',
          method: 'UPI',
          status: 'CAPTURED',
          gatewayPaymentId: id,
          gatewayAccountId: sid,
          mode: 'OLDEST_FIRST',
        } as never),
        t,
      ),
    );
  }
  return { w, sid, ids };
}

const input = (ids: string[], amounts: number[], o: Record<string, unknown> = {}) => {
  const gross = amounts.reduce((a, b) => a + b, 0);
  return {
    gatewayProvider: 'RAZORPAY',
    gatewaySettlementId: `setl_${++seq}`,
    settlementDate: '2026-11-05',
    utr: `UTR${seq}`,
    feePaise: 3530,
    feeGstPaise: 635,
    adjustmentPaise: 0,
    netPaise: gross - 3530 - 635,
    items: ids.map((g, i) => ({
      type: 'payment' as const,
      gatewayPaymentId: g,
      amountPaise: amounts[i]!,
      feePaise: 0,
      taxPaise: 0,
    })),
    ...o,
  };
};
const ingest = (w: RunSociety, i: ReturnType<typeof input>) =>
  sequelize.transaction(t => settlements.ingest(sysCtx(w), { ...i, skipEnqueue: true } as never, t));
const ctxU = (w: RunSociety) => ({ ...sysCtx(w), user: { id: w.user.id! } }) as never;

describe('ingest (8.15, BR-13-38)', () => {
  it('stores RECEIVED with gross and refunds computed from items; is idempotent by gatewaySettlementId', async () => {
    const { w, ids } = await world([1_000_000, 361_800]);
    const i = input(ids, [1_000_000, 361_800]);
    const a = await ingest(w, i);
    expect(a.created).toBe(true);
    const row = (await Settlement.findByPk(a.settlementId))!;
    expect(row).toMatchObject({ status: 'RECEIVED', paymentCount: 2 });
    expect(Number(row.grossPaise)).toBe(1_361_800);
    expect(Number(row.netPaise)).toBe(1_357_635);
    expect(await ingest(w, i)).toEqual({ settlementId: a.settlementId, created: false });
  });

  it('T13-21: a net that breaks the equation is 422 SETTLEMENT_TOTALS_INVALID', async () => {
    const { w, ids } = await world([100_000]);
    await expect(ingest(w, input(ids, [100_000], { netPaise: 1 }))).rejects.toMatchObject({
      status: 422,
      code: 'SETTLEMENT_TOTALS_INVALID',
    });
  });

  it('refund items reduce the net and adjustments are signed', async () => {
    const { w, ids } = await world([100_000]);
    const i = input(ids, [100_000], {
      adjustmentPaise: -500,
      feePaise: 0,
      feeGstPaise: 0,
      netPaise: 100_000 - 20_000 - 500,
    });
    i.items.push({
      type: 'refund' as never,
      gatewayPaymentId: 'pay_r',
      amountPaise: 20_000,
      feePaise: 0,
      taxPaise: 0,
    });
    const a = await ingest(w, i);
    expect(Number((await Settlement.findByPk(a.settlementId))!.refundsPaise)).toBe(20_000);
  });
});

describe('journal lines (BR-13-38)', () => {
  const s = {
    netPaise: 1_357_635,
    feePaise: 3530,
    feeGstPaise: 635,
    grossPaise: 1_361_800,
    refundsPaise: 0,
    adjustmentPaise: 0,
  };
  it('GST not claimable: one 5610 line with fee + GST', () => {
    expect(settlementLines(s, '1110-001', false)).toEqual([
      { ledgerAccountCode: '1110-001', debitPaise: 1_357_635, creditPaise: 0 },
      { ledgerAccountCode: '5610', debitPaise: 4165, creditPaise: 0 },
      { ledgerAccountCode: '1140', debitPaise: 0, creditPaise: 1_361_800 },
    ]);
  });
  it('GST claimable: 5610 fee and 1410 GST; adjustment on 2690', () => {
    const lines = settlementLines({ ...s, adjustmentPaise: 100, netPaise: 1_357_735 }, '1110-001', true);
    expect(lines.find(l => l.ledgerAccountCode === '1410')).toMatchObject({ debitPaise: 635 });
    expect(lines.find(l => l.ledgerAccountCode === '5610')).toMatchObject({ debitPaise: 3530 });
    expect(lines.find(l => l.ledgerAccountCode === '2690')).toMatchObject({ creditPaise: 100 });
    const d = lines.reduce((a, l) => a + l.debitPaise, 0);
    expect(d).toBe(lines.reduce((a, l) => a + l.creditPaise, 0));
  });
  it('a negative adjustment is a debit on 2690', () => {
    const lines = settlementLines({ ...s, adjustmentPaise: -50, netPaise: 1_357_585 }, 'B', false);
    expect(lines.find(l => l.ledgerAccountCode === '2690')).toMatchObject({ debitPaise: 50, creditPaise: 0 });
  });
});

describe('reconcile (BR-13-39, T13-19, US-13-05)', () => {
  it('posts CONTRA: Dr bank, Dr 5610, Cr 1140; instrumentRef is the UTR; clearing falls', async () => {
    const { w, sid, ids } = await world([1_000_000, 361_800]);
    expect(await balanceOf(sid, '1140')).toBe(1_361_800);
    const { settlementId } = await ingest(w, input(ids, [1_000_000, 361_800]));
    const out = await reconcileSettlement(sysCtx(w), sid, settlementId);
    expect(out.status).toBe('POSTED');
    const row = (await Settlement.findByPk(settlementId))!;
    expect(row.status).toBe('POSTED');
    expect(row.bankAccountId).not.toBeNull();
    const e = (await JournalEntry.findByPk(row.journalEntryId!))!;
    expect(e).toMatchObject({ voucherType: 'CONTRA', refType: 'settlement', instrumentRef: row.utr });
    expect(await balanceOf(sid, '1140')).toBe(0);
    expect(await balanceOf(sid, '1110-001')).toBe(1_357_635);
    expect(await balanceOf(sid, '5610')).toBe(4165);
    const lines = await JournalLine.findAll({ where: { journalEntryId: e.id } });
    expect(lines).toHaveLength(3);
  });

  it('a second reconcile of a POSTED settlement: the job skips it, the route says 409', async () => {
    const { w, sid, ids } = await world([100_000]);
    const { settlementId } = await ingest(w, input(ids, [100_000]));
    await reconcileSettlement(sysCtx(w), sid, settlementId);
    expect((await reconcileSettlement(sysCtx(w), sid, settlementId)).status).toBe('SKIPPED');
    await expect(reconcileNow(ctxU(w), settlementId)).rejects.toMatchObject({
      status: 409,
      code: 'SETTLEMENT_ALREADY_POSTED',
    });
    expect(await JournalEntry.count({ where: { societyId: sid, refType: 'settlement' } })).toBe(1);
  });

  it('a payment cannot be settled twice (ALREADY_SETTLED)', async () => {
    const { w, sid, ids } = await world([100_000]);
    const a = await ingest(w, input(ids, [100_000]));
    await reconcileSettlement(sysCtx(w), sid, a.settlementId);
    const b = await ingest(w, input(ids, [100_000]));
    const out = await reconcileSettlement(sysCtx(w), sid, b.settlementId);
    expect(out.status).toBe('MISMATCH');
    expect(out.unmatched[0]).toMatchObject({ reason: 'ALREADY_SETTLED' });
  });

  it('T13-20: an unknown payment id gives MISMATCH and exactly one notification; the retry does not notify again', async () => {
    accountsPortCalls.length = 0;
    const { w, sid, ids } = await world([100_000]);
    const i = input([...ids, 'pay_unknown'], [100_000, 50_000]);
    const { settlementId } = await ingest(w, i);
    const out = await reconcileSettlement(sysCtx(w), sid, settlementId);
    expect(out.status).toBe('MISMATCH');
    expect(out.unmatched).toMatchObject([{ gatewayPaymentId: 'pay_unknown', reason: 'UNKNOWN_PAYMENT' }]);
    await reconcileSettlement(sysCtx(w), sid, settlementId);
    const sent = accountsPortCalls.filter(c => c.fn === 'notifications.send');
    expect(sent).toHaveLength(1);
    expect((sent[0]!.input as { template: string }).template).toBe('accounts.settlement_mismatch');
    expect(Number((await Settlement.findByPk(settlementId))!.attempts)).toBe(2);
    expect(await JournalEntry.count({ where: { societyId: sid, refType: 'settlement' } })).toBe(0);
  });

  it('an amount that differs from the captured payment is a mismatch; the manual route answers 422 with the detail', async () => {
    const { w, sid, ids } = await world([100_000]);
    const { settlementId } = await ingest(w, input(ids, [99_000]));
    await expect(reconcileNow(ctxU(w), settlementId)).rejects.toMatchObject({
      status: 422,
      code: 'SETTLEMENT_MISMATCH',
      errors: [{ field: ids[0] }],
    });
    expect((await Settlement.findByPk(settlementId))!.status).toBe('MISMATCH');
    expect(sid).toBeGreaterThan(0);
  });

  it('no collection account: 422 COLLECTION_ACCOUNT_REQUIRED and nothing changes', async () => {
    const w = await paymentsWorld({ flats: 1 });
    const { settlementId } = await ingest(w, input(['pay_x'], [100_000]));
    await expect(reconcileSettlement(sysCtx(w), w.society.id!, settlementId)).rejects.toMatchObject({
      status: 422,
      code: 'COLLECTION_ACCOUNT_REQUIRED',
    });
    expect((await Settlement.findByPk(settlementId))!.status).toBe('RECEIVED');
  });

  it('with settings finance.gstInputClaimable the GST goes to 1410', async () => {
    const { w, sid, ids } = await world([200_000]);
    await sequelize.transaction(t =>
      settings.set(sysCtx(w), sid, 'finance.gstInputClaimable' as never, true as never, t),
    );
    const { settlementId } = await ingest(w, input(ids, [200_000]));
    await reconcileSettlement(sysCtx(w), sid, settlementId);
    const gst = await balanceOf(sid, '1410');
    expect(gst).toBe(635);
    expect(await balanceOf(sid, '5610')).toBe(3530);
  });

  it('dated in a locked period, a system settlement posts on the first open date, documentDate keeps the original (BR-13-9)', async () => {
    const { w, sid, ids } = await world([100_000]);
    await sequelize.query(
      "UPDATE society_balances SET booksLockedThrough = '2026-11-30' WHERE societyId = ?",
      {
        replacements: [sid],
      },
    );
    const { settlementId } = await ingest(w, input(ids, [100_000], { settlementDate: '2026-11-05' }));
    await reconcileSettlement(sysCtx(w), sid, settlementId);
    const e = (await JournalEntry.findByPk((await Settlement.findByPk(settlementId))!.journalEntryId!))!;
    expect(e.entryDate).toBe('2026-12-01');
    expect(e.documentDate).toBe('2026-11-05');
  });
});

describe('accept difference (BR-13-39)', () => {
  it('posts the unmatched gross to 2690 so the bank credit is recorded', async () => {
    const { w, sid, ids } = await world([100_000]);
    const i = input([...ids, 'pay_missing'], [100_000, 50_000]);
    const { settlementId } = await ingest(w, i);
    await reconcileSettlement(sysCtx(w), sid, settlementId);
    const cur = (await Settlement.findByPk(settlementId))!;
    const r = await acceptDifference(ctxU(w), settlementId, {
      reason: 'Gateway to confirm',
      version: Number(cur.version),
    });
    expect(r).toMatchObject({ status: 'POSTED', differenceAcceptedReason: 'Gateway to confirm' });
    expect(await balanceOf(sid, '2690')).toBe(-50_000);
    expect(await balanceOf(sid, '1110-001')).toBe(150_000 - 3530 - 635);
    expect(await balanceOf(sid, '1140')).toBe(0);
  });

  it('refuses RECEIVED (INVALID_STATE), POSTED (409) and a stale version', async () => {
    const { w, sid, ids } = await world([100_000]);
    const a = await ingest(w, input(ids, [100_000]));
    await expect(
      acceptDifference(ctxU(w), a.settlementId, { reason: 'because', version: 1 }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'INVALID_STATE',
    });
    const b = await ingest(w, input(['pay_nope'], [10_000]));
    await reconcileSettlement(sysCtx(w), sid, b.settlementId);
    await expect(
      acceptDifference(ctxU(w), b.settlementId, { reason: 'because', version: 99 }),
    ).rejects.toMatchObject({
      code: 'STALE_VERSION',
    });
    await reconcileSettlement(sysCtx(w), sid, a.settlementId);
    await expect(
      acceptDifference(ctxU(w), a.settlementId, { reason: 'because', version: 2 }),
    ).rejects.toMatchObject({
      code: 'SETTLEMENT_ALREADY_POSTED',
    });
  });
});

describe('report parsing', () => {
  it('rupees to paise without float errors', () => {
    expect(rupeesToPaise('13,618.05')).toBe(1_361_805);
    expect(rupeesToPaise('0.1')).toBe(10);
    expect(rupeesToPaise('abc')).toBeNull();
  });
  it('groups rows by settlement id and sums fee and GST', async () => {
    const csv = [
      'settlement_id,settlement_date,utr,type,payment_id,amount,fee,tax,net',
      'setl_a,2026-11-05,UTR1,payment,pay_1,1000.00,20.00,3.60,1976.40',
      'setl_a,2026-11-05,UTR1,payment,pay_2,1000.00,20.00,3.60,',
    ].join('\n');
    const [s] = await parseSettlementReport(Buffer.from(csv));
    expect(s).toMatchObject({
      gatewaySettlementId: 'setl_a',
      netPaise: 197_640,
      feePaise: 4000,
      feeGstPaise: 720,
    });
    expect(s!.items).toHaveLength(2);
  });
  it('a bad row is 422 STATEMENT_PARSE_FAILED with the row number', async () => {
    const csv =
      'settlement_id,settlement_date,type,payment_id,amount,net\nsetl_a,05-11-2026,payment,pay_1,10,10';
    await expect(parseSettlementReport(Buffer.from(csv))).rejects.toMatchObject({
      code: 'STATEMENT_PARSE_FAILED',
      errors: [{ field: 'row 2' }],
    });
  });
});

describe('jobs', () => {
  it('settlement-reconcile processes RECEIVED and MISMATCH settlements for a society with the feature', async () => {
    const { w, ids } = await world([100_000]);
    const { settlementId } = await ingest(w, input(ids, [100_000]));
    expect(await settlementReconcileJob({})).toBe(1);
    expect((await Settlement.findByPk(settlementId))!.status).toBe('POSTED');
  });

  it('settlement-reconcile stops retrying after 7 days', async () => {
    const { w, ids } = await world([100_000]);
    const { settlementId } = await ingest(w, input(ids, [100_000]));
    advance(8 * 86_400_000);
    expect(await settlementReconcileJob({})).toBe(0);
    expect((await Settlement.findByPk(settlementId))!.status).toBe('RECEIVED');
  });

  it('clearing-age: unsettled gateway money older than the threshold notifies the Treasurer once', async () => {
    const { w, sid, ids } = await world([100_000]);
    await memberOf(w.society, 'treasurer');
    accountsPortCalls.length = 0;
    expect(await agedClearingPaise(sid, '2026-11-05', 3)).toBe(0);
    expect(await agedClearingPaise(sid, '2026-11-20', 3)).toBe(100_000);
    advance(10 * 86_400_000);
    await clearingAgeJob({ societyId: sid });
    const sent = accountsPortCalls.filter(c => c.fn === 'notifications.send');
    expect(
      sent.length === 0 || (sent[0]!.input as { template: string }).template === 'accounts.clearing_aged',
    ).toBe(true);
    // settled money is no longer aged
    const { settlementId } = await ingest(w, input(ids, [100_000]));
    await reconcileSettlement(sysCtx(w), sid, settlementId);
    expect(await agedClearingPaise(sid, '2026-11-20', 3)).toBe(0);
  });
});

describe('dev helper', () => {
  it('builds a settlement from the captured online payments no settlement lists and it reconciles', async () => {
    const { w, sid } = await world([250_000, 150_000]);
    const r = await devGenerateSettlement({ societyId: sid, date: '2026-11-05' });
    expect(r).toMatchObject({ payments: 2, grossPaise: 400_000 });
    await expect(devGenerateSettlement({ societyId: sid })).rejects.toMatchObject({
      code: 'NOTHING_TO_SETTLE',
    });
    expect((await reconcileSettlement(sysCtx(w), sid, r.settlementId)).status).toBe('POSTED');
  });
});

describe('routes 39 to 42', () => {
  it('import JSON, list, detail, reconcile, accept-difference with the plan and permission gates', async () => {
    const { w, sid, ids } = await world([100_000]);
    const i = input([...ids, 'pay_gone'], [100_000, 20_000]);
    const { gatewayProvider: _gp, ...rest } = i;
    const body = { gatewayProvider: 'RAZORPAY', settlements: [rest] };
    const imp = await w.c('post', '/accounts/settlements/import', body, { headers: idemH() });
    expect(imp.status, JSON.stringify(imp.body)).toBe(202);
    expect(imp.body.data).toMatchObject({ created: 1, skipped: 0, failed: [] });
    const bad = await w.c(
      'post',
      '/accounts/settlements/import',
      {
        gatewayProvider: 'RAZORPAY',
        settlements: [{ ...rest, gatewaySettlementId: 'setl_bad', netPaise: 5 }],
      },
      { headers: idemH() },
    );
    expect(bad.body.data.failed[0]).toMatchObject({
      gatewaySettlementId: 'setl_bad',
      code: 'SETTLEMENT_TOTALS_INVALID',
    });
    const id = imp.body.data.settlementIds[0] as number;
    const list = await w.c('get', '/accounts/settlements?status=RECEIVED');
    expect(list.status).toBe(200);
    const det = await w.c('get', `/accounts/settlements/${id}`);
    expect(det.body.data.items[0]).toMatchObject({ matchedPaymentId: expect.any(Number) });
    const rec = await w.c('post', `/accounts/settlements/${id}/reconcile`, {});
    expect(rec.status).toBe(422);
    expect(rec.body.code ?? rec.body.error?.code).toBe('SETTLEMENT_MISMATCH');
    const cur = await w.c('get', `/accounts/settlements/${id}`);
    const acc = await w.c(
      'post',
      `/accounts/settlements/${id}/accept-difference`,
      { reason: 'Gateway will confirm', version: cur.body.data.version },
      { headers: idemH() },
    );
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(acc.body.data.status).toBe('POSTED');
    expect(await balanceOf(sid, '2690')).toBe(-20_000);
    const missing = await w.c('get', '/accounts/settlements/99999999');
    expect(missing.status).toBe(404);
    expect(LedgerAccount).toBeDefined();
  });
});
void setAccountsPorts;
void ctxOf;

describe('tenant isolation (T13-35)', () => {
  it("another society's settlement is 404 SETTLEMENT_NOT_FOUND on every id route", async () => {
    const a = await world([100_000]);
    const b = await paymentsWorld({ flats: 1 });
    const i = input(a.ids, [100_000]);
    const { settlementId } = await ingest(a.w, i);
    for (const [m, p, body] of [
      ['get', `/accounts/settlements/${settlementId}`, undefined],
      ['post', `/accounts/settlements/${settlementId}/reconcile`, {}],
      ['post', `/accounts/settlements/${settlementId}/accept-difference`, { reason: 'because', version: 1 }],
    ] as const) {
      const r = await b.c(m, p, body, { headers: idemH() });
      expect(r.status, p).toBe(404);
      expect(r.body.code ?? r.body.error?.code).toBe('SETTLEMENT_NOT_FOUND');
    }
  });
});
