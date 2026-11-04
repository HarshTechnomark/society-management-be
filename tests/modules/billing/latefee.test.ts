import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BillingNote, Invoice, Society, closeDb } from '../../../src/models';
import { drainQueues, enqueue, tickScheduler } from '../../../src/lib/queue';
import { BILLING_QUEUE, JOBS } from '../../../src/modules/billing/billing.constants';
import { billingPortCalls } from '../../../src/modules/billing/billing.ports';
import {
  planFlatFee,
  planInterest,
  previousMonthEnd,
  simpleInterestPaise,
  type BalanceEvent,
  type InterestPolicy,
  type LateFeeInvoice,
} from '../../../src/modules/billing/billing.latefee.calc';
import { runLateFeesAll, runLateFeesForSociety } from '../../../src/modules/billing/billing.latefee.service';
import { setNow } from '../../../src/lib/clock';
import { lifecycleColumns } from '../../helpers/access';
import { featureOff } from '../../helpers/society-setup';
import {
  duesWorld,
  interestPolicy,
  makeInvoice,
  makePolicy,
  resetDues,
  useFakeNoteIssuer,
} from '../../helpers/billing-dues';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetDues);
let restore: (() => void) | undefined;
afterEach(() => restore?.());

const ev = (date: string, dOutstanding: number, dNonInterestBearing = 0, dPaid = 0): BalanceEvent => ({
  date,
  dOutstanding,
  dNonInterestBearing,
  dPaid,
});
const policy = (o: Partial<InterestPolicy> = {}): InterestPolicy => ({
  policyType: 'SIMPLE_INTEREST',
  interestRatePct: '21.0000',
  interestFrom: 'DUE_DATE',
  flatFeePaise: null,
  graceDays: 15,
  minChargePaise: 100,
  ...o,
});
const inv = (o: Partial<LateFeeInvoice> = {}): LateFeeInvoice => ({
  invoiceType: 'REGULAR',
  status: 'ISSUED',
  isDisputed: false,
  invoiceDate: '2026-09-01',
  dueDate: '2026-09-10',
  settledOn: null,
  interestPostedToDate: null,
  lateFeeChargedAt: null,
  hasInterestBearingCharge: true,
  ...o,
});

describe('late fee calculation (pure, BR-11-52 to BR-11-55)', () => {
  it('T11-11 example G: 9,205 for 20 days on 800,000, then 11,424 after a payment on 15 Oct', () => {
    const base = [ev('2026-09-01', 800_000)];
    expect(simpleInterestPaise(base, '2026-09-11', '2026-09-30', '21.0000')).toBe(9205);
    const second = [...base, ev('2026-10-01', 9_200, 9_200), ev('2026-10-15', -300_000, 0, 300_000)];
    expect(simpleInterestPaise(second, '2026-10-01', '2026-10-31', '21.0000')).toBe(11_424);
  });

  it('a payment on day d stops interest for day d; a year is 365 days also in a leap year', () => {
    const e = [ev('2027-01-01', 1_000_000), ev('2028-03-01', -1_000_000, 0, 1_000_000)];
    // 2028-02-01..2028-02-29 is 29 days at 21 %
    expect(simpleInterestPaise(e, '2028-02-01', '2028-02-29', '21.0000')).toBe(
      Math.round((1_000_000 * 29 * 21) / 100 / 365),
    );
    expect(simpleInterestPaise(e, '2028-03-01', '2028-03-31', '21.0000')).toBe(0);
  });

  it('the plan: window 11 to 30 Sep, interest 9,205 (the note rounds to 9,200)', () => {
    const p = planInterest(inv(), policy(), [ev('2026-09-01', 800_000)], '2026-09-30', '2026-10-01');
    expect(p).toEqual({ skip: null, from: '2026-09-11', to: '2026-09-30', interestPaise: 9205 });
  });

  it('T11-32 settled on or before due + grace: never any interest; open invoice still in grace waits', () => {
    const e = [ev('2026-09-01', 800_000)];
    expect(planInterest(inv({ settledOn: '2026-09-25' }), policy(), e, '2026-09-30', '2026-10-01')).toEqual({
      skip: 'WITHIN_GRACE',
    });
    expect(planInterest(inv({ dueDate: '2026-09-25' }), policy(), e, '2026-09-30', '2026-10-01')).toEqual({
      skip: 'IN_GRACE',
    });
  });

  it('GRACE_END starts accrual after the grace period; OPENING accrues from asOfDate + 1', () => {
    const e = [ev('2026-09-01', 800_000)];
    const g = planInterest(inv(), policy({ interestFrom: 'GRACE_END' }), e, '2026-09-30', '2026-10-01');
    expect(g).toMatchObject({ skip: null, from: '2026-09-26' });
    const o = planInterest(
      inv({ invoiceType: 'OPENING', invoiceDate: '2026-08-31', dueDate: '2026-08-31' }),
      policy({ graceDays: 0 }),
      [ev('2026-08-31', 800_000)],
      '2026-09-30',
      '2026-10-01',
    );
    expect(o).toMatchObject({ skip: null, from: '2026-09-01' });
  });

  it('interest below the minimum posts nothing and the window is not advanced; settled invoices stop at settledOn - 1', () => {
    const small = planInterest(
      inv(),
      policy({ minChargePaise: 100 }),
      [ev('2026-09-01', 1_000)],
      '2026-09-30',
      '2026-10-01',
    );
    expect(small).toEqual({ skip: 'BELOW_MINIMUM' });
    const settled = planInterest(
      inv({ settledOn: '2026-09-21' }),
      policy({ graceDays: 5 }),
      [ev('2026-09-01', 800_000), ev('2026-09-21', -800_000, 0, 800_000)],
      '2026-09-30',
      '2026-10-01',
    );
    expect(settled).toMatchObject({ skip: null, to: '2026-09-20' });
  });

  it('later windows start after interestPostedToDate; disputed and cancelled invoices are skipped', () => {
    const e = [ev('2026-09-01', 800_000)];
    const p = planInterest(
      inv({ interestPostedToDate: '2026-09-30' }),
      policy(),
      e,
      '2026-10-31',
      '2026-11-01',
    );
    expect(p).toMatchObject({ skip: null, from: '2026-10-01', to: '2026-10-31' });
    expect(planInterest(inv({ isDisputed: true }), policy(), e, '2026-09-30', '2026-10-01')).toEqual({
      skip: 'DISPUTED',
    });
    expect(planInterest(inv({ status: 'CANCELLED' }), policy(), e, '2026-09-30', '2026-10-01')).toEqual({
      skip: 'CANCELLED',
    });
  });

  it('flat fee: once, only with an interest-bearing charge line, never on OPENING, not within grace', () => {
    const f = policy({ policyType: 'FLAT', flatFeePaise: 50_000, interestRatePct: null, interestFrom: null });
    expect(planFlatFee(inv(), f, '2026-10-01')).toEqual({ skip: null, feePaise: 50_000 });
    expect(planFlatFee(inv({ lateFeeChargedAt: '2026-10-01' }), f, '2026-11-01')).toEqual({
      skip: 'ALREADY_CHARGED',
    });
    expect(planFlatFee(inv({ hasInterestBearingCharge: false }), f, '2026-10-01')).toEqual({
      skip: 'NO_INTEREST_BEARING_LINE',
    });
    expect(planFlatFee(inv({ invoiceType: 'OPENING' }), f, '2026-10-01')).toEqual({
      skip: 'OPENING_NO_FLAT_FEE',
    });
    expect(planFlatFee(inv({ settledOn: '2026-09-25' }), f, '2026-10-01')).toEqual({ skip: 'WITHIN_GRACE' });
  });

  it('previousMonthEnd', () => {
    expect(previousMonthEnd('2026-10-01')).toBe('2026-09-30');
    expect(previousMonthEnd('2027-01-01')).toBe('2026-12-31');
    expect(previousMonthEnd('2028-03-01')).toBe('2028-02-29');
  });
});

describe('billing:late-fees job (T11-31, T11-32, US-11-08)', () => {
  it('US-11-08: 800,000 due 10 Sep, 21 % with 15 grace days: debit note of 9,200 on 1 Oct; a second run the same day adds none', async () => {
    restore = useFakeNoteIssuer();
    const w = await duesWorld(1);
    await interestPolicy(w.society.id!);
    const i = await makeInvoice(w, { unit: w.units[0]!, billTo: w.owners['A-101']! });
    const r = await runLateFeesForSociety(w.society.id!, { today: '2026-10-01' });
    expect(r).toMatchObject({ interestNotes: 1, failed: 0, windowEnd: '2026-09-30' });
    const notes = await BillingNote.findAll({ where: { invoiceId: i.id! } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ reasonCode: 'INTEREST', dedupeKey: `INT:${i.id}:2026-09-30` });
    expect(Number(notes[0]!.totalPaise)).toBe(9200);
    const fresh = (await Invoice.findByPk(i.id!))!;
    expect(fresh.interestPostedToDate).toBe('2026-09-30');
    expect(Number(fresh.outstandingPaise)).toBe(809_200);
    const again = await runLateFeesForSociety(w.society.id!, { today: '2026-10-01' });
    expect(again.interestNotes).toBe(0);
    expect(await BillingNote.count({ where: { invoiceId: i.id! } })).toBe(1);
  });

  it('the dedupe key alone stops a repeat even when the invoice marker is behind', async () => {
    restore = useFakeNoteIssuer();
    const w = await duesWorld(1);
    await interestPolicy(w.society.id!);
    const i = await makeInvoice(w, { unit: w.units[0]!, billTo: w.owners['A-101']! });
    await runLateFeesForSequence();
    async function runLateFeesForSequence() {
      await runLateFeesForSociety(w.society.id!, { today: '2026-10-01' });
    }
    await Invoice.update({ interestPostedToDate: null }, { where: { id: i.id! } });
    const r = await runLateFeesForSociety(w.society.id!, { today: '2026-10-01' });
    expect(r.interestNotes).toBe(0);
    expect(await BillingNote.count({ where: { invoiceId: i.id! } })).toBe(1);
  });

  it('T11-32 an invoice paid within grace gets no note; a disputed one is skipped; a cancelled one too', async () => {
    restore = useFakeNoteIssuer();
    const w = await duesWorld(3);
    await interestPolicy(w.society.id!);
    const [a, b, c] = w.units;
    await makeInvoice(w, {
      unit: a!,
      billTo: w.owners['A-101']!,
      paidPaise: 800_000,
      settledOn: '2026-09-20',
    });
    await makeInvoice(w, { unit: b!, billTo: w.owners['A-102']!, isDisputed: true });
    await makeInvoice(w, { unit: c!, billTo: w.owners['A-103']!, status: 'CANCELLED', totalPaise: 100_000 });
    await Invoice.update({ creditedPaise: 100_000, outstandingPaise: 0 }, { where: { unitId: c!.id } });
    const r = await runLateFeesForSociety(w.society.id!, { today: '2026-10-01' });
    expect(r.interestNotes).toBe(0);
    expect(await BillingNote.count()).toBe(0);
  });

  it('interest below the minimum accumulates into the next month (window not advanced)', async () => {
    restore = useFakeNoteIssuer();
    const w = await duesWorld(1);
    await interestPolicy(w.society.id!, { graceDays: 0 });
    const i = await makeInvoice(w, {
      unit: w.units[0]!,
      billTo: w.owners['A-101']!,
      totalPaise: 10_000,
      dueDate: '2026-09-25',
    });
    const r1 = await runLateFeesForSociety(w.society.id!, { today: '2026-10-01' });
    expect(r1.skipped.BELOW_MINIMUM).toBe(1);
    expect((await Invoice.findByPk(i.id!))!.interestPostedToDate).toBeNull();
    const r2 = await runLateFeesForSociety(w.society.id!, { today: '2026-11-01' });
    expect(r2.interestNotes).toBe(1);
    const n = (await BillingNote.findOne({ where: { invoiceId: i.id! } }))!;
    expect(n.interestFromDate).toBe('2026-09-26');
    expect(n.interestToDate).toBe('2026-10-31');
  });

  it('FLAT policy: one debit note with reason LATE_FEE per invoice, never twice (LFEE dedupe)', async () => {
    restore = useFakeNoteIssuer();
    const w = await duesWorld(2);
    await makePolicy(w.society.id!, { policyType: 'FLAT', flatFeePaise: 50_000, graceDays: 5 });
    const a = await makeInvoice(w, { unit: w.units[0]!, billTo: w.owners['A-101']! });
    await makeInvoice(w, { unit: w.units[1]!, billTo: w.owners['A-102']!, headKey: 'WATER' });
    await Invoice.update({}, { where: { id: a.id! } });
    const r = await runLateFeesForSociety(w.society.id!, { today: '2026-10-01' });
    expect(r.lateFeeNotes).toBe(2);
    const again = await runLateFeesForSociety(w.society.id!, { today: '2026-11-01' });
    expect(again.lateFeeNotes).toBe(0);
    expect(await BillingNote.count({ where: { reasonCode: 'LATE_FEE' } })).toBe(2);
    expect((await Invoice.findByPk(a.id!))!.lateFeeChargedAt).toBe('2026-10-01');
  });

  it('a society without a policy, with policy NONE, or without the plan feature is not charged', async () => {
    restore = useFakeNoteIssuer();
    const w = await duesWorld(1);
    await makeInvoice(w, { unit: w.units[0]!, billTo: w.owners['A-101']! });
    expect((await runLateFeesForSociety(w.society.id!, { today: '2026-10-01' })).skipped.POLICY_NONE).toBe(1);
    await makePolicy(w.society.id!, { policyType: 'NONE', effectiveFrom: '2026-05-01' });
    expect((await runLateFeesForSociety(w.society.id!, { today: '2026-10-01' })).interestNotes).toBe(0);
    await interestPolicy(w.society.id!, { effectiveFrom: '2026-06-01' });
    await featureOff(w.society.id!, 'billing.late_fee_and_interest');
    expect((await runLateFeesForSociety(w.society.id!, { today: '2026-10-01' })).skipped.FEATURE_OFF).toBe(1);
    expect(await BillingNote.count()).toBe(0);
  });

  it('T11-47 BR-11-56: a SUSPENDED society is skipped; the next run covers the whole pending window', async () => {
    restore = useFakeNoteIssuer();
    const w = await duesWorld(1);
    await interestPolicy(w.society.id!, { graceDays: 0 });
    const i = await makeInvoice(w, { unit: w.units[0]!, billTo: w.owners['A-101']! });
    await Society.update(lifecycleColumns('SUSPENDED') as never, { where: { id: w.society.id! } });
    expect(await runLateFeesAll('2026-10-01')).toEqual({});
    expect(await BillingNote.count()).toBe(0);
    await Society.update(lifecycleColumns('ACTIVE') as never, { where: { id: w.society.id! } });
    await runLateFeesAll('2026-11-01');
    const n = (await BillingNote.findOne({ where: { invoiceId: i.id! } }))!;
    expect([n.interestFromDate, n.interestToDate]).toEqual(['2026-09-11', '2026-10-31']);
  });

  it('the job runs only on day 1 at 02:00 IST and touches the dues cache once per society', async () => {
    restore = useFakeNoteIssuer();
    const w = await duesWorld(2);
    await interestPolicy(w.society.id!);
    await makeInvoice(w, { unit: w.units[0]!, billTo: w.owners['A-101']! });
    await makeInvoice(w, { unit: w.units[1]!, billTo: w.owners['A-102']! });
    setNow('2026-11-03T20:30:00Z'); // 4 Nov 02:00 IST: not day 1
    expect(await tickScheduler()).toContain(JOBS.lateFees);
    await drainQueues();
    expect(await BillingNote.count()).toBe(0);
    setNow('2026-10-31T20:30:00Z'); // 1 Nov 02:00 IST
    await tickScheduler();
    await drainQueues();
    expect(await BillingNote.count()).toBe(2);
    expect(billingPortCalls.filter(c => c.fn === 'reports.touch')).toHaveLength(1);
  });

  it('the job can be enqueued on demand', async () => {
    restore = useFakeNoteIssuer();
    const w = await duesWorld(1);
    await interestPolicy(w.society.id!);
    await makeInvoice(w, { unit: w.units[0]!, billTo: w.owners['A-101']! });
    await enqueue(BILLING_QUEUE, JOBS.lateFees, { today: '2026-10-01' });
    await drainQueues();
    expect(await BillingNote.count()).toBe(1);
  });
});
