import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, DunningEvent, PlatformInvoice, Society, closeDb, sequelize } from '../../../src/models';
import { paymentGateway } from '../../../src/adapters';
import type { FakePaymentGateway } from '../../../src/adapters/payments/payment-gateway';
import { setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { runDunning } from '../../../src/modules/platform-billing/platform-billing.dunning';
import { setBillingSettingsSource } from '../../../src/modules/platform-billing/platform-billing.public';
import { inboxFor } from '../../helpers/auth';
import { billedSociety, idemKey, platformTeam, resetBilling } from '../../helpers/billing';
import { platformAs } from '../../helpers/societies';
import { as, login, memberUser } from '../../helpers/access';

/** Task 6.4: the dunning engine (BR-06-36 to BR-06-43, 8.16; T06-20, T06-21, T06-22, T06-24). */
beforeEach(async () => {
  await resetBilling();
});
afterAll(async () => {
  setBillingSettingsSource(undefined);
  await drainQueues();
  setNow(null);
  await closeDb();
});

// fixture invoice: issued 2026-11-01, due D = 2026-11-16, suspendOn D+15 = 2026-12-01, total 1,239,000 paise
const day = async (d: string) => {
  setNow(`${d}T04:00:00Z`); // 09:30 IST
  return runDunning(d);
};
const events = (invoiceId: number, step?: string) =>
  DunningEvent.findAll({ where: { invoiceId, ...(step ? { step } : {}) }, order: [['id', 'ASC']] });
const statusOf = async (id: number) => (await Society.findByPk(id))!.status;
const subjects = async (email: string | null) => (await inboxFor(email!)).map(m => m.subject ?? '');

async function setup() {
  const s = await billedSociety();
  return { ...s, ...(await platformTeam()) };
}

describe('the reminder ladder and the transitions', () => {
  it('T06-20 reminders on D-7, D, D+3, D+7; OVERDUE and PAST_DUE on D+1; SUSPENDED on D+15 through module 05; reruns do nothing', async () => {
    const { society, invoice, treasurer } = await setup();
    const id = invoice.id;

    expect(await day('2026-11-08')).toMatchObject({ reminders: 0 }); // before D-7
    expect(await day('2026-11-09')).toMatchObject({ reminders: 1 });
    expect(await day('2026-11-09')).toMatchObject({ reminders: 0 }); // rerun the same day
    await day('2026-11-16');
    expect(await statusOf(society.id!)).toBe('ACTIVE');
    expect((await PlatformInvoice.findByPk(id))!.status).toBe('ISSUED');

    await day('2026-11-17');
    expect((await PlatformInvoice.findByPk(id))!.status).toBe('OVERDUE');
    expect(await statusOf(society.id!)).toBe('PAST_DUE');
    await day('2026-11-19');
    await day('2026-11-23');
    expect(await statusOf(society.id!)).toBe('PAST_DUE');
    await day('2026-11-30');
    expect(await statusOf(society.id!)).toBe('PAST_DUE'); // suspendOn is 12-01
    const r = await day('2026-12-01');
    expect(r.suspended).toBe(1);
    expect(await statusOf(society.id!)).toBe('SUSPENDED');
    expect((await Society.findByPk(society.id!))!.suspensionCause).toBe('NON_PAYMENT');
    const again = await day('2026-12-01');
    expect(again).toMatchObject({ reminders: 0, pastDue: 0, suspended: 0 });
    await day('2026-12-02');

    const rows = await events(id!);
    expect(
      rows.filter(e => e.step === 'REMINDER').map(e => [e.offsetDays, e.outcome, e.templateKey]),
    ).toEqual([
      [-7, 'DONE', 'platform_billing.payment_reminder'],
      [0, 'DONE', 'platform_billing.payment_reminder'],
      [3, 'DONE', 'platform_billing.payment_reminder'],
      [7, 'DONE', 'platform_billing.suspension_warning'],
    ]);
    expect(rows.filter(e => e.step === 'PAST_DUE')).toHaveLength(1);
    expect(rows.filter(e => e.step === 'SUSPENDED')).toHaveLength(1);
    for (const a of [
      'platform_billing.dunning.reminder_sent',
      'platform_billing.invoice.overdue',
      'platform_billing.dunning.past_due',
      'platform_billing.dunning.suspended',
    ])
      expect(await AuditLog.count({ where: { action: a, societyId: society.id! } }), a).toBeGreaterThan(0);
    expect(await AuditLog.count({ where: { action: 'platform_billing.dunning.suspended' } })).toBe(1);
    const subs = await subjects(treasurer.email);
    expect(subs.filter(x => x.startsWith('Payment reminder'))).toHaveLength(3);
    expect(subs.some(x => x.includes('will be suspended on 2026-12-01'))).toBe(true);
  });

  it('T06-21 a payment on D+16 clears the society in the same transaction and writes CLEARED', async () => {
    const { society, invoice } = await setup();
    for (const d of ['2026-11-17', '2026-12-01']) await day(d);
    expect(await statusOf(society.id!)).toBe('SUSPENDED');
    setNow('2026-12-02T05:00:00Z');
    const pay = as(await login(await memberUser(society, 'treasurer', { name: 'Late Treasurer' }))); // a new sign-in at the new date
    const order = await pay(
      'post',
      `/subscription/invoices/${invoice.id}/payment-orders`,
      {},
      { headers: idemKey() },
    );
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    const o = order.body.data;
    const p = (paymentGateway() as FakePaymentGateway).payOrder(o.gatewayOrderId);
    const v = await pay('post', `/subscription/payments/${o.paymentId}/verify`, {
      gatewayPaymentId: p.paymentId,
    });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(await statusOf(society.id!)).toBe('ACTIVE');
    const cleared = await DunningEvent.findAll({ where: { societyId: society.id!, step: 'CLEARED' } });
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.invoiceId).toBeNull();
    expect(await AuditLog.count({ where: { action: 'platform_billing.dunning.cleared' } })).toBe(1);
  });

  it('T06-22 an active suspension hold skips the step with HOLD_ACTIVE; the next day without the hold suspends', async () => {
    const { society, invoice } = await setup();
    await day('2026-11-17');
    await Society.update(
      { suspensionHoldUntil: new Date('2026-12-05T00:00:00Z') },
      { where: { id: society.id! } },
    );
    const r = await day('2026-12-01');
    expect(r.suspended).toBe(0);
    expect(await statusOf(society.id!)).toBe('PAST_DUE');
    const s = await events(invoice.id!, 'SUSPENDED');
    expect(s.map(e => [e.outcome, e.skipReason])).toEqual([['SKIPPED', 'HOLD_ACTIVE']]);
    await day('2026-12-01'); // same day again: still one skip row
    expect(await events(invoice.id!, 'SUSPENDED')).toHaveLength(1);
    await Society.update({ suspensionHoldUntil: null }, { where: { id: society.id! } });
    await day('2026-12-02');
    expect(await statusOf(society.id!)).toBe('SUSPENDED');
    expect((await events(invoice.id!, 'SUSPENDED')).map(e => e.outcome)).toEqual(['SKIPPED', 'DONE']);
  });

  it('a pending manual payment that covers the overdue amount skips suspension (PENDING_MANUAL_PAYMENT) and approval clears the society', async () => {
    const { society, invoice, maker } = await setup();
    const rec = await maker.c(
      'post',
      '/platform/payments',
      {
        societyId: society.id,
        invoiceId: invoice.id,
        method: 'NEFT',
        amountPaise: 1239000,
        receivedOn: '2026-10-30',
        bankReference: 'UTR202611300001',
      },
      { headers: idemKey() },
    );
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    await day('2026-11-17');
    const r = await day('2026-12-01');
    expect(r.suspended).toBe(0);
    expect(await statusOf(society.id!)).toBe('PAST_DUE');
    expect((await events(invoice.id!, 'SUSPENDED')).map(e => e.skipReason)).toEqual([
      'PENDING_MANUAL_PAYMENT',
    ]);
    setNow('2026-12-02T05:00:00Z');
    const late = await platformAs('super_admin', 'Late Admin'); // a fresh sign-in for the step-up window
    const ch = await late.c('post', `/platform/payments/${rec.body.data.id}/approve`, { version: 1 });
    expect(ch.status, JSON.stringify(ch.body)).toBe(200);
    expect(await statusOf(society.id!)).toBe('ACTIVE');
    expect(await DunningEvent.count({ where: { societyId: society.id!, step: 'CLEARED' } })).toBe(1);
  });

  it('only the latest of several missed reminders is sent; earlier ones are SKIPPED SUPERSEDED (BR-06-37)', async () => {
    const { invoice } = await setup();
    await day('2026-11-24'); // D+8: -7, 0, +3, +7 are all due
    const rows = await events(invoice.id!, 'REMINDER');
    expect(rows.map(e => [e.offsetDays, e.outcome, e.skipReason])).toEqual([
      [-7, 'SKIPPED', 'SUPERSEDED'],
      [0, 'SKIPPED', 'SUPERSEDED'],
      [3, 'SKIPPED', 'SUPERSEDED'],
      [7, 'DONE', null],
    ]);
    expect(rows.map(e => e.dedupeKey)).toEqual([
      `REMINDER:${invoice.id}:-7`,
      `REMINDER:${invoice.id}:0`,
      `REMINDER:${invoice.id}:3`,
      `REMINDER:${invoice.id}:7`,
    ]);
  });

  it('a balance below dunningMinDuePaise still gets reminders but never PAST_DUE or SUSPENDED (BR-06-38)', async () => {
    const { society, invoice } = await setup();
    await sequelize.query(
      "UPDATE platform_invoices SET paidPaise = totalPaise - 5000, amountDuePaise = 5000, status = 'PARTIALLY_PAID' WHERE id = :id",
      { replacements: { id: invoice.id } },
    );
    const r = await day('2026-12-02');
    expect(r).toMatchObject({ reminders: 1, pastDue: 0, suspended: 0 });
    expect(await statusOf(society.id!)).toBe('ACTIVE');
    expect((await events(invoice.id!, 'PAST_DUE')).map(e => [e.outcome, e.skipReason])).toEqual([
      ['SKIPPED', 'BELOW_MINIMUM'],
    ]);
  });

  it('a CLOSED society gets no reminders and no transitions (BR-06-43)', async () => {
    const { society, invoice } = await setup();
    await Society.update(
      {
        status: 'CLOSED',
        closedAt: new Date(),
        closureReason: 'OTHER',
        purgeAfter: new Date('2027-03-01'),
        activatedAt: new Date(),
      } as never,
      { where: { id: society.id! } },
    );
    const r = await day('2026-12-02');
    expect(r.invoices).toBe(0);
    expect(await events(invoice.id!)).toHaveLength(0);
    expect((await PlatformInvoice.findByPk(invoice.id))!.status).toBe('ISSUED');
  });

  it('the offsets and the delays come from the settings', async () => {
    const { invoice } = await setup();
    setBillingSettingsSource(async key =>
      key === 'billing.reminderOffsetsDays' ? [-3, 2] : key === 'billing.pastDueAfterDays' ? 3 : undefined,
    );
    await day('2026-11-13');
    await day('2026-11-18');
    await day('2026-11-19');
    expect((await events(invoice.id!, 'REMINDER')).map(e => [e.offsetDays, e.templateKey])).toEqual([
      [-3, 'platform_billing.payment_reminder'],
      [2, 'platform_billing.suspension_warning'],
    ]);
    expect((await events(invoice.id!, 'PAST_DUE')).map(e => e.scheduledFor)).toEqual(['2026-11-19']);
  });

  it('T06-24 TDS rejected on a PAID invoice past its due date: OVERDUE again, the next dunning run marks PAST_DUE', async () => {
    const { society, invoice, maker, pay } = await setup();
    const o = (
      await pay(
        'post',
        `/subscription/invoices/${invoice.id}/payment-orders`,
        { amountPaise: 1218000 },
        { headers: idemKey() },
      )
    ).body.data;
    const p = (paymentGateway() as FakePaymentGateway).payOrder(o.gatewayOrderId);
    await pay('post', `/subscription/payments/${o.paymentId}/verify`, { gatewayPaymentId: p.paymentId });
    const c = await pay(
      'post',
      `/subscription/invoices/${invoice.id}/tds-claims`,
      { tdsSection: '194J', tdsRatePct: '2', amountPaise: 21000, deductedOn: '2026-10-31' },
      { headers: idemKey() },
    );
    expect(c.body.data.invoice.status).toBe('PAID');
    await sequelize.query(
      "UPDATE platform_invoices SET dueDate = '2026-10-20', suspendOn = '2026-11-04' WHERE id = :id",
      {
        replacements: { id: invoice.id },
      },
    );
    const rej = await maker.c('post', `/platform/payments/${c.body.data.id}/tds-decision`, {
      decision: 'REJECTED',
      reason: 'Certificate is not valid',
      version: 1,
    });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body.data.invoice.status).toBe('OVERDUE');
    expect(await statusOf(society.id!)).toBe('ACTIVE');
    const r = await day('2026-11-21');
    expect(r.pastDue).toBe(1);
    expect(await statusOf(society.id!)).toBe('PAST_DUE');
    // past suspendOn: the suspension comes with the following run
    expect(await statusOf(society.id!)).not.toBe('SUSPENDED');
    await day('2026-11-22');
    expect(await statusOf(society.id!)).toBe('SUSPENDED');
  });
});

describe('extend grace (BR-06-41, 8.16)', () => {
  it('moves suspendOn of one invoice, so the suspension waits; writes GRACE_EXTENDED, audit and a notification; rejects bad ranges', async () => {
    const { society, invoice, maker, view, treasurer } = await setup();
    const bad = (days: number, version = 1) =>
      maker.c('post', `/platform/invoices/${invoice.id}/extend-grace`, {
        days,
        reason: 'Waiting for the board meeting',
        version,
      });
    // a society user cannot do it
    expect((await view('post', `/platform/invoices/${invoice.id}/extend-grace`, {})).status).toBe(403);
    expect((await bad(0)).body.code).toBe('GRACE_EXTENSION_INVALID');
    expect((await bad(31)).body.code).toBe('GRACE_EXTENSION_INVALID');
    expect((await bad(5, 9)).body.code).toBe('STALE_VERSION');
    const short = await maker.c('post', `/platform/invoices/${invoice.id}/extend-grace`, {
      days: 5,
      reason: 'short',
      version: 1,
    });
    expect([short.status, short.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const r = await bad(5);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ suspendOn: '2026-12-06', dueDate: '2026-11-16', version: 2 });
    const ev = (await events(invoice.id!, 'GRACE_EXTENDED'))[0]!;
    expect([ev.suspendOnBefore, ev.suspendOnAfter, ev.dedupeKey]).toEqual(['2026-12-01', '2026-12-06', null]);
    expect(await AuditLog.count({ where: { action: 'platform_billing.invoice.grace_extended' } })).toBe(1);
    expect((await subjects(treasurer.email)).some(x => x.startsWith('More time to pay'))).toBe(true);

    await day('2026-11-17');
    await day('2026-12-01');
    expect(await statusOf(society.id!)).toBe('PAST_DUE');
    await day('2026-12-06');
    expect(await statusOf(society.id!)).toBe('SUSPENDED');

    // due date + 60 days is the limit: 2027-01-15; 12-06 + 30 = 01-05 is fine, another 30 is not
    const late = await platformAs('super_admin', 'Late Admin'); // a fresh sign-in at the new date
    const more = (days: number, version: number) =>
      late.c('post', `/platform/invoices/${invoice.id}/extend-grace`, {
        days,
        reason: 'Waiting for the board meeting',
        version,
      });
    const v = (await PlatformInvoice.findByPk(invoice.id))!.version;
    expect((await more(30, v)).status).toBe(200);
    expect((await more(30, v + 1)).body.code).toBe('GRACE_EXTENSION_INVALID');
  });

  it('an invoice that is not open is INVALID_STATE', async () => {
    const { invoice, maker } = await setup();
    await sequelize.query("UPDATE platform_invoices SET status = 'PAID', amountDuePaise = 0 WHERE id = :id", {
      replacements: { id: invoice.id },
    });
    const r = await maker.c('post', `/platform/invoices/${invoice.id}/extend-grace`, {
      days: 3,
      reason: 'Not needed anymore',
      version: 1,
    });
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
  });
});
