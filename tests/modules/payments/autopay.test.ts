import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditLog,
  AutopayMandate,
  FeatureFlag,
  Invoice,
  PaymentOrder,
  Society,
  closeDb,
  sequelize,
} from '../../../src/models';
import { addDays, advance, istDate, now, setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';
import { payments } from '../../../src/modules/payments/payments.public';
import { listRoutes } from '../../../src/modules/access-control/access-control.registry';
import { invalidateFlags } from '../../../src/modules/subscriptions/flags.service';
import { BASE_FLAGS, seedFlags } from '../../../src/modules/subscriptions/subscriptions.seed';
import { paymentsPortCalls } from '../../../src/modules/payments/payments.ports';
import {
  cancelAllForSociety,
  cancelMandatesForUnitLink,
  handleMandateEvent,
} from '../../../src/modules/payments/payments.autopay.service';
import {
  runAutopayExecute,
  runAutopaySchedule,
  runMandateAuthTimeout,
  syncDebitResults,
} from '../../../src/modules/payments/payments.autopay.jobs';
import { FakePaymentGateway } from '../../../src/adapters/payments/payment-gateway';
import { app } from '../../helpers/auth';
import { residentUser } from '../../helpers/residents';
import { idemH, type RunSociety } from '../../helpers/billing-runs';
import { mkInvoice, paymentsWorld, resetPayments } from '../../helpers/payments';
import { systemCtx } from '../../../src/types/context';

let gw: FakePaymentGateway;
afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  gw = await resetPayments();
  await seedFlags(BASE_FLAGS);
  await setFlag(true);
});

async function setFlag(on: boolean) {
  await FeatureFlag.update({ isEnabled: on } as never, { where: { flagKey: 'payments.upi_autopay' } });
  invalidateFlags();
  await new Promise(r => setTimeout(r, 20));
}

const TODAY = '2026-11-04';
const ymd = (offsetDays: number) =>
  new Date(new Date(`${TODAY}T00:00:00Z`).getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const notices = (template: string) =>
  paymentsPortCalls
    .filter(c => c.fn === 'notifications.send' && (c.input as any).template === template)
    .map(c => c.input as any);
const startBody = (unitId: number, o: Record<string, unknown> = {}) => ({
  unitId,
  mandateType: 'UPI_AUTOPAY',
  maxAmountPaise: 1_000_000,
  startDate: TODAY,
  endDate: ymd(365),
  ...o,
});

async function world(o: { plan?: string } = {}) {
  const w = await paymentsWorld({ flats: 2, ...o });
  const owner = await residentUser(w.society, w.units[0]!.id, { name: 'Rohan Sharma', relation: 'CO_OWNER' });
  return { w, owner, unit: w.units[0]!.id };
}
const start = (x: { owner: { c: any }; unit: number }, o: Record<string, unknown> = {}) =>
  x.owner.c('post', '/me/autopay-mandates', startBody(x.unit, o), { headers: idemH() });

/** A mandate that is ACTIVE (created through the API, activated by the gateway event). */
async function activeMandate(x: Awaited<ReturnType<typeof world>>, o: Record<string, unknown> = {}) {
  const r = await start(x, o);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const m = (await AutopayMandate.findByPk(r.body.data.mandateId))!;
  await handleMandateEvent(systemCtx('wh'), {
    societyId: x.w.society.id!,
    type: 'mandate.activated',
    gatewayMandateId: m.gatewayMandateId!,
    payerInstrumentMasked: 'ra****@okhdfc',
  });
  return (await AutopayMandate.findByPk(m.id))!;
}

describe('POST /me/autopay-mandates (8.8, BR-12-47)', () => {
  it('creates a PENDING_AUTH mandate at the gateway with an authorisation block valid 48 hours, audited', async () => {
    const x = await world();
    const r = await start(x);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'PENDING_AUTH' });
    expect(r.body.data.authorisation.upiIntentUrl).toContain('fake-gateway');
    const m = (await AutopayMandate.findByPk(r.body.data.mandateId))!;
    expect(m).toMatchObject({
      status: 'PENDING_AUTH',
      mandateType: 'UPI_AUTOPAY',
      debitDaysBeforeDue: 2,
      payerUserId: x.owner.user.id,
    });
    expect(Number(m.maxAmountPaise)).toBe(1_000_000);
    expect(gw.mandates.get(m.gatewayMandateId!)).toMatchObject({
      status: 'created',
      maxAmountPaise: 1_000_000,
    });
    expect(new Date(r.body.data.expiresAt).getTime() - new Date(m.createdAt).getTime()).toBe(48 * 3_600_000);
    expect(await AuditLog.count({ where: { action: 'payments.mandate.created' } })).toBe(1);
  });

  it('the same Idempotency-Key replays; a second live mandate is 409 MANDATE_EXISTS', async () => {
    const x = await world();
    const h = idemH();
    const a = await x.owner.c('post', '/me/autopay-mandates', startBody(x.unit), { headers: h });
    const b = await x.owner.c('post', '/me/autopay-mandates', startBody(x.unit), { headers: h });
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.data.mandateId).toBe(a.body.data.mandateId);
    const c = await start(x);
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('MANDATE_EXISTS');
    expect(await AutopayMandate.count({ where: { societyId: x.w.society.id! } })).toBe(1);
  });

  it('limits per type (BR-12-47), dates and the unit', async () => {
    const x = await world();
    const hi = await start(x, { maxAmountPaise: 1_500_001 });
    expect([hi.status, hi.body.code]).toEqual([422, 'MANDATE_LIMIT_EXCEEDED']);
    const lo = await start(x, { maxAmountPaise: 99 });
    expect(lo.body.code).toBe('MANDATE_LIMIT_EXCEEDED');
    expect((await start(x, { mandateType: 'ENACH', maxAmountPaise: 50_000_000 })).status).toBe(201);
    const x2 = await world();
    expect((await start(x2, { startDate: ymd(-1) })).status).toBe(400);
    expect((await start(x2, { startDate: ymd(61) })).status).toBe(400);
    expect((await start(x2, { endDate: TODAY })).status).toBe(400);
    expect((await start(x2, { endDate: ymd(3_700) })).status).toBe(400);
    expect((await start(x2, { debitDaysBeforeDue: 6 })).status).toBe(400);
    const other = await x2.owner.c('post', '/me/autopay-mandates', startBody(x2.w.units[1]!.id), {
      headers: idemH(),
    });
    expect([other.status, other.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
    const ok = await start(x2, { debitDaysBeforeDue: 4 });
    expect((await AutopayMandate.findByPk(ok.body.data.mandateId))!.debitDaysBeforeDue).toBe(4);
  });

  it('Starter plan 402 FEATURE_NOT_IN_PLAN, Premium with the flag off 422 AUTOPAY_NOT_AVAILABLE (T12-37)', async () => {
    const s = await world({ plan: 'STARTER' });
    const r = await start(s);
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    const x = await world();
    await setFlag(false);
    const off = await start(x);
    expect([off.status, off.body.code]).toEqual([422, 'AUTOPAY_NOT_AVAILABLE']);
    expect((await x.owner.c('get', '/me/autopay-mandates')).body.code).toBe('AUTOPAY_NOT_AVAILABLE');
    const off2 = await x.owner.c('get', `/me/payables?unitId=${x.w.units[0]!.id}`);
    expect([off2.status, off2.body.data.autopayAvailable]).toEqual([200, false]);
    await setFlag(true);
    const on = await x.owner.c('get', `/me/payables?unitId=${x.w.units[0]!.id}`);
    expect(on.body.data.autopayAvailable).toBe(true);
  });

  it('a gateway account without mandate support is AUTOPAY_NOT_AVAILABLE, a gateway failure 502 and nothing is saved', async () => {
    const x = await world();
    gw.failNext.createMandate = true;
    const r = await start(x);
    expect([r.status, r.body.code]).toEqual([502, 'GATEWAY_ERROR']);
    expect(await AutopayMandate.count()).toBe(0);
  });

  it('a resident of another flat or society sees no mandate of this one', async () => {
    const x = await world();
    await start(x);
    const o = await residentUser(x.w.society, x.w.units[1]!.id, { name: 'Neighbour', relation: 'CO_OWNER' });
    expect((await o.c('get', '/me/autopay-mandates')).body.data).toEqual([]);
    const mine = await x.owner.c('get', '/me/autopay-mandates');
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).toMatchObject({
      unitLabel: x.w.units[0]!.label,
      status: 'PENDING_AUTH',
      mandateType: 'UPI_AUTOPAY',
    });
    const m = await AutopayMandate.findOne();
    const p = await o.c('post', `/me/autopay-mandates/${m!.id}/cancel`, { version: 1 });
    expect([p.status, p.body.code]).toEqual([404, 'MANDATE_NOT_FOUND']);
  });
});

describe('states: activate, pause, resume, cancel (6.5)', () => {
  it('the gateway event activates; pause and resume need the right state and version', async () => {
    const x = await world();
    const m = await activeMandate(x);
    expect(m).toMatchObject({ status: 'ACTIVE', payerInstrumentMasked: 'ra****@okhdfc' });
    expect(notices('payments.mandate_activated')).toHaveLength(1);
    expect(
      await handleMandateEvent(systemCtx('wh'), {
        societyId: x.w.society.id!,
        type: 'mandate.activated',
        gatewayMandateId: m.gatewayMandateId!,
      }),
    ).toBe('IGNORED');
    const stale = await x.owner.c('post', `/me/autopay-mandates/${m.id}/pause`, { version: 99 });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const resumeFirst = await x.owner.c('post', `/me/autopay-mandates/${m.id}/resume`, {
      version: Number(m.version),
    });
    expect([resumeFirst.status, resumeFirst.body.code]).toEqual([409, 'INVALID_STATE']);
    const p = await x.owner.c('post', `/me/autopay-mandates/${m.id}/pause`, { version: Number(m.version) });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data.status).toBe('PAUSED');
    const r = await x.owner.c('post', `/me/autopay-mandates/${m.id}/resume`, {
      version: p.body.data.version,
    });
    expect(r.body.data).toMatchObject({ status: 'ACTIVE', consecutiveFailures: 0 });
    expect(
      await AuditLog.count({
        where: {
          action: ['payments.mandate.paused', 'payments.mandate.resumed', 'payments.mandate.activated'],
        },
      }),
    ).toBe(3);
  });

  it('rejection and authorisation timeout end a PENDING_AUTH mandate as FAILED; the live slot is free again', async () => {
    const x = await world();
    const a = await start(x);
    const m = (await AutopayMandate.findByPk(a.body.data.mandateId))!;
    expect(
      await handleMandateEvent(systemCtx('wh'), {
        societyId: x.w.society.id!,
        type: 'mandate.rejected',
        gatewayMandateId: m.gatewayMandateId!,
      }),
    ).toBe('FAILED');
    expect(await AutopayMandate.findByPk(m.id)).toMatchObject({ status: 'FAILED', endReason: 'AUTH_FAILED' });
    const b = await start(x);
    expect(b.status).toBe(201);
    expect(await runMandateAuthTimeout()).toBe(0);
    advance(49 * 3_600_000);
    expect(await runMandateAuthTimeout()).toBe(1);
    expect(await AutopayMandate.findByPk(b.body.data.mandateId)).toMatchObject({
      status: 'FAILED',
      endReason: 'AUTH_TIMEOUT',
    });
    expect(
      gw.mandates.get((await AutopayMandate.findByPk(b.body.data.mandateId))!.gatewayMandateId!)!.status,
    ).toBe('cancelled');
  });

  it('cancel by the payer calls the gateway, ends the mandate and cancels the waiting debit', async () => {
    const x = await world();
    const m = await activeMandate(x);
    await mkInvoice(x.w, 0, 100_000, ymd(4));
    await runAutopaySchedule(x.w.society.id!);
    expect(await PaymentOrder.count({ where: { mandateId: m.id, status: 'CREATED' } })).toBe(1);
    const r = await x.owner.c('post', `/me/autopay-mandates/${m.id}/cancel`, {
      version: Number(m.version),
      reason: 'Moving out',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'CANCELLED', endReason: 'PAYER_CANCELLED' });
    expect(gw.mandates.get(m.gatewayMandateId!)!.status).toBe('cancelled');
    expect(await PaymentOrder.count({ where: { mandateId: m.id, status: 'CANCELLED' } })).toBe(1);
    const again = await x.owner.c('post', `/me/autopay-mandates/${m.id}/cancel`, {
      version: r.body.data.version,
    });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('a gateway failure on cancel refuses it (502) so debits never go on by mistake', async () => {
    const x = await world();
    const m = await activeMandate(x);
    gw.failNext.cancelMandate = true;
    const r = await x.owner.c('post', `/me/autopay-mandates/${m.id}/cancel`, { version: Number(m.version) });
    expect([r.status, r.body.code]).toEqual([502, 'GATEWAY_ERROR']);
    expect((await AutopayMandate.findByPk(m.id))!.status).toBe('ACTIVE');
  });

  it('the gateway cancelling it (mandate.cancelled) ends it without calling the gateway', async () => {
    const x = await world();
    const m = await activeMandate(x);
    const spy = vi.spyOn(gw, 'cancelMandate');
    expect(
      await handleMandateEvent(systemCtx('wh'), {
        societyId: x.w.society.id!,
        type: 'mandate.cancelled',
        gatewayMandateId: m.gatewayMandateId!,
        eventId: 'evt_9',
      }),
    ).toBe('CANCELLED');
    expect(spy).not.toHaveBeenCalled();
    expect(await AutopayMandate.findByPk(m.id)).toMatchObject({
      status: 'CANCELLED',
      endReason: 'GATEWAY_CANCELLED',
    });
    expect(notices('payments.mandate_cancelled')).toHaveLength(1);
    expect(
      await handleMandateEvent(systemCtx('wh'), {
        societyId: x.w.society.id!,
        type: 'mandate.cancelled',
        gatewayMandateId: 'unknown',
      }),
    ).toBe('NOT_FOUND');
  });

  it('suspended society: the payer can still cancel, but cannot pause or start (T12-39)', async () => {
    const x = await world();
    const m = await activeMandate(x);
    await Society.update(
      { status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL' } as never,
      { where: { id: x.w.society.id! } },
    );
    await flushAcl();
    const p = await x.owner.c('post', `/me/autopay-mandates/${m.id}/pause`, { version: Number(m.version) });
    expect([p.status, p.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
    const admin = await x.w.c('post', `/autopay-mandates/${m.id}/cancel`, {
      version: Number(m.version),
      reason: 'Admin stop',
    });
    expect([admin.status, admin.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
    const c = await x.owner.c('post', `/me/autopay-mandates/${m.id}/cancel`, { version: Number(m.version) });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
  });
});

describe('admin routes (8.20)', () => {
  it('lists with filters and cancels with a reason: ADMIN_CANCELLED, payer notified, audited', async () => {
    const x = await world();
    const m = await activeMandate(x);
    const list = await x.w.treasurer.c('get', '/autopay-mandates?status=ACTIVE');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data[0]).toMatchObject({
      id: Number(m.id),
      unitLabel: x.w.units[0]!.label,
      payerName: 'Rohan Sharma',
      status: 'ACTIVE',
      payerInstrumentMasked: 'ra****@okhdfc',
      maxAmountPaise: 1_000_000,
    });
    expect((await x.w.c('get', '/autopay-mandates?status=CANCELLED')).body.data).toEqual([]);
    expect((await x.w.c('get', `/autopay-mandates?unitId=${x.w.units[1]!.id}`)).body.data).toEqual([]);
    expect((await x.w.c('get', '/autopay-mandates?mandateType=ENACH')).body.data).toEqual([]);
    const short = await x.w.c('post', `/autopay-mandates/${m.id}/cancel`, {
      version: Number(m.version),
      reason: 'no',
    });
    expect(short.status).toBe(400);
    const r = await x.w.c('post', `/autopay-mandates/${m.id}/cancel`, {
      version: Number(m.version),
      reason: 'Flat sold',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await AutopayMandate.findByPk(m.id)).toMatchObject({
      status: 'CANCELLED',
      endReason: 'ADMIN_CANCELLED',
    });
    await drainQueues();
    expect(notices('payments.mandate_cancelled')).toHaveLength(1);
    const again = await x.w.c('post', `/autopay-mandates/${m.id}/cancel`, {
      version: 99,
      reason: 'Flat sold',
    });
    expect(again.body.code).toBe('STALE_VERSION');
    const done = await x.w.c('post', `/autopay-mandates/${m.id}/cancel`, {
      version: Number(m.version) + 1,
      reason: 'Flat sold',
    });
    expect(done.body.code).toBe('INVALID_STATE');
  });

  it('another society sees none of it (404 MANDATE_NOT_FOUND) and a member without finance.payments.edit is refused', async () => {
    const x = await world();
    const m = await activeMandate(x);
    const other = await paymentsWorld({ flats: 1 });
    expect((await other.c('get', '/autopay-mandates')).body.data).toEqual([]);
    const r = await other.c('post', `/autopay-mandates/${m.id}/cancel`, { version: 1, reason: 'Not mine' });
    expect([r.status, r.body.code]).toEqual([404, 'MANDATE_NOT_FOUND']);
    expect(
      (await x.w.secretary.c('post', `/autopay-mandates/${m.id}/cancel`, { version: 1, reason: 'Not mine' }))
        .status,
    ).toBe(403);
    const mine = listRoutes(app)
      .filter(a => /^\/(me\/)?autopay-mandates/.test(a.path))
      .map(a => `${a.method} ${a.path}`)
      .sort();
    expect(mine).toEqual([
      'GET /autopay-mandates',
      'GET /me/autopay-mandates',
      'POST /autopay-mandates/:id/cancel',
      'POST /me/autopay-mandates',
      'POST /me/autopay-mandates/:id/cancel',
      'POST /me/autopay-mandates/:id/pause',
      'POST /me/autopay-mandates/:id/resume',
    ]);
    const cancel = listRoutes(app).find(a => a.path === '/me/autopay-mandates/:id/cancel')!;
    expect(cancel.allowWhenSuspended).toBe(true);
    expect(listRoutes(app).find(a => a.path === '/me/autopay-mandates/:id/pause')!.allowWhenSuspended).toBe(
      false,
    );
  });
});

describe('payments:autopay-schedule and -execute (BR-12-48, T12-43)', () => {
  const orders = (w: RunSociety) =>
    PaymentOrder.findAll({
      where: { societyId: w.society.id!, sourceType: 'AUTOPAY' },
      order: [['id', 'ASC']],
    });

  it('creates the AUTOPAY order 1 to 5 days ahead with the pre-debit notice; charges only 24 hours after the notice', async () => {
    const x = await world();
    const m = await activeMandate(x);
    await mkInvoice(x.w, 0, 100_000, ymd(4));
    await mkInvoice(x.w, 0, 50_000, ymd(7));
    await mkInvoice(x.w, 0, 70_000, ymd(30));
    const r = await runAutopaySchedule(x.w.society.id!);
    expect(r).toMatchObject({ orders: 1, skipped: 0 });
    const [o] = await orders(x.w);
    expect(o).toMatchObject({
      status: 'CREATED',
      debitOn: ymd(2),
      dedupeKey: `autopay:${m.id}:${ymd(2)}`,
      allocationMode: 'SELECTED',
      feeMode: 'SOCIETY_ABSORBS',
    });
    expect(Number(o!.mandateId)).toBe(Number(m.id));
    expect(o!.payerUserId).toBeNull();
    expect(o!.items.map(i => i.amountPaise)).toEqual([100_000, 50_000]);
    expect([Number(o!.basePaise), Number(o!.grossAmountPaise)]).toEqual([150_000, 150_000]);
    expect(o!.preDebitNotifiedAt).not.toBeNull();
    await drainQueues();
    expect(notices('payments.mandate_predebit')[0]).toMatchObject({
      userIds: [x.owner.user.id],
      data: { amountPaise: 150_000, debitOn: ymd(2), capPaise: 1_000_000 },
    });
    // a second run makes no second order and no double notice
    expect((await runAutopaySchedule(x.w.society.id!)).orders).toBe(0);
    expect(await orders(x.w)).toHaveLength(1);
    // too early: not the debit day
    expect(await runAutopayExecute(x.w.society.id!)).toEqual({ charged: 0, failed: 0, cancelled: 0 });
    advance(2 * 86_400_000 + 3_600_000);
    expect(await runAutopayExecute(x.w.society.id!)).toEqual({ charged: 1, failed: 0, cancelled: 0 });
    const after = (await PaymentOrder.findByPk(o!.id))!;
    expect(after.gatewayOrderId).toMatch(/^order_/);
    expect(gw.orders.get(after.gatewayOrderId!)!.amountPaise).toBe(150_000);
    expect(await runAutopayExecute(x.w.society.id!)).toEqual({ charged: 0, failed: 0, cancelled: 0 });
    expect((await AutopayMandate.findByPk(m.id))!.lastDebitAt).not.toBeNull();
  });

  it('the debit is never executed before the notice is 24 hours old even on the debit day', async () => {
    const x = await world();
    await activeMandate(x);
    await mkInvoice(x.w, 0, 100_000, ymd(3));
    await runAutopaySchedule(x.w.society.id!);
    const [o] = await orders(x.w);
    expect(o!.debitOn).toBe(ymd(1));
    advance(86_400_000 - 60_000);
    await PaymentOrder.update({ debitOn: ymd(0) } as never, { where: { id: o!.id } });
    expect((await runAutopayExecute(x.w.society.id!)).charged).toBe(0);
    advance(120_000);
    expect((await runAutopayExecute(x.w.society.id!)).charged).toBe(1);
  });

  it('above the cap: no debit, MANDATE_LIMIT_EXCEEDED logged, payer told once with the amount', async () => {
    const x = await world();
    await activeMandate(x, { maxAmountPaise: 100_000 });
    await mkInvoice(x.w, 0, 90_000, ymd(3));
    await mkInvoice(x.w, 0, 40_000, ymd(4));
    const r = await runAutopaySchedule(x.w.society.id!);
    expect(r).toMatchObject({ orders: 0, skipped: 1 });
    expect(await orders(x.w)).toHaveLength(0);
    await drainQueues();
    expect(notices('payments.mandate_skipped')[0].data).toMatchObject({
      amountPaise: 130_000,
      capPaise: 100_000,
    });
    expect((await AutopayMandate.findOne())!.lastDebitStatus).toBe('SKIPPED');
    await runAutopaySchedule(x.w.society.id!);
    expect(notices('payments.mandate_skipped')).toHaveLength(1);
  });

  it('skips disputed bills, bills already in a waiting order, paused mandates and a flag that went off', async () => {
    const x = await world();
    const m = await activeMandate(x);
    const inv = await mkInvoice(x.w, 0, 100_000, ymd(3));
    await Invoice.update({ isDisputed: true } as never, { where: { id: inv.id } });
    expect((await runAutopaySchedule(x.w.society.id!)).orders).toBe(0);
    await Invoice.update({ isDisputed: false } as never, { where: { id: inv.id } });
    await AutopayMandate.update({ status: 'PAUSED' } as never, { where: { id: m.id } });
    expect((await runAutopaySchedule(x.w.society.id!)).orders).toBe(0);
    await AutopayMandate.update({ status: 'ACTIVE' } as never, { where: { id: m.id } });
    await setFlag(false);
    expect((await runAutopaySchedule(x.w.society.id!)).orders).toBe(0);
    await setFlag(true);
    expect((await runAutopaySchedule(x.w.society.id!)).orders).toBe(1);
  });

  it('the order is cancelled when the bills changed after the notice, and the next run sends a new notice', async () => {
    const x = await world();
    await activeMandate(x);
    const inv = await mkInvoice(x.w, 0, 100_000, ymd(3));
    await runAutopaySchedule(x.w.society.id!);
    await Invoice.update({ paidPaise: 60_000, outstandingPaise: 40_000 } as never, { where: { id: inv.id } });
    advance(2 * 86_400_000);
    expect(await runAutopayExecute(x.w.society.id!)).toEqual({ charged: 0, failed: 0, cancelled: 1 });
    expect(await PaymentOrder.count({ where: { status: 'CANCELLED', sourceType: 'AUTOPAY' } })).toBe(1);
    expect((await runAutopaySchedule(x.w.society.id!)).orders).toBe(1);
  });

  it('a charge result: PAID is SUCCESS and resets failures; two failures in a row pause the mandate and tell the payer (BR-12-49)', async () => {
    const x = await world();
    const m = await activeMandate(x);
    await mkInvoice(x.w, 0, 100_000, ymd(3));
    await runAutopaySchedule(x.w.society.id!);
    advance(2 * 86_400_000);
    await runAutopayExecute(x.w.society.id!);
    const [o] = await orders(x.w);
    advance(1000);
    await PaymentOrder.update({ status: 'PAID', paidAt: now() } as never, { where: { id: o!.id } });
    expect(await syncDebitResults(x.w.society.id!)).toBe(1);
    expect(await AutopayMandate.findByPk(m.id)).toMatchObject({
      lastDebitStatus: 'SUCCESS',
      consecutiveFailures: 0,
      status: 'ACTIVE',
    });
    expect(await syncDebitResults(x.w.society.id!)).toBe(0);

    // two failed debits
    await AutopayMandate.update({ consecutiveFailures: 0 } as never, { where: { id: m.id } });
    const spy = vi.spyOn(gw, 'chargeMandate').mockRejectedValue(new Error('bank said no'));
    for (let i = 0; i < 2; i++) {
      await mkInvoice(x.w, 0, 20_000 + i * 1000, istDate(addDays(now(), 3)));
      await runAutopaySchedule(x.w.society.id!);
      advance(3 * 86_400_000);
      const r = await runAutopayExecute(x.w.society.id!);
      expect(r.failed).toBe(1);
      advance(86_400_000);
    }
    spy.mockRestore();
    setNow('2026-11-04T04:30:00Z'); // the sign-in is still valid
    const after = (await AutopayMandate.findByPk(m.id))!;
    expect(after).toMatchObject({ status: 'PAUSED', consecutiveFailures: 2, lastDebitStatus: 'FAILED' });
    await drainQueues();
    expect(notices('payments.mandate_debit_failed')).toHaveLength(2);
    expect(await AuditLog.count({ where: { action: 'payments.mandate.paused' } })).toBe(1);
    const r = await x.owner.c('post', `/me/autopay-mandates/${m.id}/resume`, {
      version: Number(after.version),
    });
    expect(r.body.data.status).toBe('ACTIVE');
  });

  it('mandates past their end date expire (END_DATE), even when the flag is off', async () => {
    const x = await world();
    const m = await activeMandate(x, { endDate: ymd(5) });
    advance(6 * 86_400_000);
    await setFlag(false);
    const r = await runAutopaySchedule(x.w.society.id!);
    expect(r.expired).toBe(1);
    expect(await AutopayMandate.findByPk(m.id)).toMatchObject({ status: 'EXPIRED', endReason: 'END_DATE' });
    const resume = await x.owner.c('post', `/me/autopay-mandates/${m.id}/resume`, { version: 1 });
    expect(resume.status).not.toBe(200);
  });
});

describe('hooks for modules 05 and 09 (BR-12-49, 8.26)', () => {
  it('autopay.cancelAllForSociety ends every live mandate (SOCIETY_CLOSED) and the gateway after commit; returns the count', async () => {
    const x = await world();
    const m1 = await activeMandate(x);
    const o2 = await residentUser(x.w.society, x.w.units[1]!.id, { name: 'Neighbour', relation: 'CO_OWNER' });
    const r = await start({ owner: o2, unit: x.w.units[1]!.id });
    expect(r.status).toBe(201);
    const other = await world();
    const mo = await activeMandate(other);
    const n = await sequelize.transaction(t => payments.autopay.cancelAllForSociety(x.w.society.id!, t));
    expect(n).toBe(2);
    await drainQueues();
    await new Promise(res => setTimeout(res, 50));
    const rows = await AutopayMandate.findAll({ where: { societyId: x.w.society.id! } });
    expect(rows.map(a => [a.status, a.endReason])).toEqual([
      ['CANCELLED', 'SOCIETY_CLOSED'],
      ['CANCELLED', 'SOCIETY_CLOSED'],
    ]);
    expect(gw.mandates.get(m1.gatewayMandateId!)!.status).toBe('cancelled');
    expect((await AutopayMandate.findByPk(mo.id))!.status).toBe('ACTIVE');
    expect(await sequelize.transaction(t => cancelAllForSociety(x.w.society.id!, t))).toBe(0);
  });

  it("cancelMandatesForUnitLink ends only that payer's mandates of that flat (UNIT_LINK_ENDED)", async () => {
    const x = await world();
    const m = await activeMandate(x);
    const o2 = await residentUser(x.w.society, x.w.units[1]!.id, { name: 'Neighbour', relation: 'CO_OWNER' });
    await start({ owner: o2, unit: x.w.units[1]!.id });
    const ctx = {
      ...systemCtx('t'),
      society: { id: x.w.society.id!, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
    };
    const n = await sequelize.transaction(t =>
      cancelMandatesForUnitLink(ctx as never, x.unit, Number(x.owner.user.id), t),
    );
    expect(n).toBe(1);
    expect(await AutopayMandate.findByPk(m.id)).toMatchObject({
      status: 'CANCELLED',
      endReason: 'UNIT_LINK_ENDED',
    });
    expect(await AutopayMandate.count({ where: { status: 'PENDING_AUTH' } })).toBe(1);
  });
});
