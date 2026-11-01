import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  DataExport,
  Invitation,
  Society,
  SocietyLifecycleEvent,
  Subscription,
  SupportAccessGrant,
  closeDb,
  sequelize,
} from '../../../src/models';
import { addDays, advance, now, setNow } from '../../../src/lib/clock';
import { listInbox } from '../../../src/lib/inbox';
import { createInvitationCore } from '../../../src/modules/access-control/access-control.invitations.service';
import {
  applyCancellation,
  cancelForClosure,
} from '../../../src/modules/subscriptions/subscriptions.service';
import { integrationCalls } from '../../../src/modules/subscriptions/subscriptions.integrations';
import {
  getStatusAt,
  onAccountCleared,
  onFirstInvoicePaid,
  onGraceExpired,
  onInvoiceOverdue,
  trialConversionStats,
} from '../../../src/modules/societies/societies.lifecycle';
import { autoClose, expireTrials } from '../../../src/modules/societies/societies.jobs';
import { portCalls, setSocietyPorts } from '../../../src/modules/societies/societies.ports';
import { systemCtx } from '../../../src/types/context';
import { as, idem, makeSociety, memberUser, platformLogin, resetLogins } from '../../helpers/access';
import { activeGrant, lifecycleSociety, platformAs, resetSocieties, settle } from '../../helpers/societies';

afterAll(closeDb);
beforeEach(async () => {
  setNow('2026-10-30T06:30:00Z');
  await resetSocieties();
  resetLogins();
  setNow('2026-10-30T06:30:00Z');
});

const reload = async (id: number) => (await Society.findByPk(id))!;
const events = async (societyId: number, eventType = 'STATUS_CHANGED') =>
  SocietyLifecycleEvent.findAll({ where: { societyId, eventType }, order: [['id', 'ASC']] });
const BILLING = systemCtx('billing');

describe('manual suspension (8.10, BR-05-3, BR-05-16)', () => {
  it('T05-13 without a fresh step-up is 401 REAUTH_REQUIRED; after signing in again it suspends with one event and one audit row', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const sa = await platformAs('super_admin');
    advance(6 * 60_000);
    const body = {
      reasonCategory: 'POLICY_VIOLATION',
      reason: 'Repeated policy violations reported',
      version: 1,
    };
    const r = await sa.c('post', `/platform/societies/${s.id}/suspend`, body);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('REAUTH_REQUIRED');
    resetLogins();
    const fresh = await platformLogin(sa.user);
    const ok = await as(fresh, 'PLATFORM')('post', `/platform/societies/${s.id}/suspend`, body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'SUSPENDED', suspensionCause: 'MANUAL', version: 2 });
    const ev = await events(s.id!);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      triggerCode: 'MANUAL_SUSPEND',
      reasonCategory: 'POLICY_VIOLATION',
      actorName: 'Asha Admin',
    });
    expect(await AuditLog.count({ where: { action: 'societies.society.suspended', societyId: s.id! } })).toBe(
      1,
    );
    // BR-05-16: paying does not lift a manual suspension (no event)
    await sequelize.transaction(t => onAccountCleared(BILLING, s.id!, t));
    expect((await reload(s.id!)).status).toBe('SUSPENDED');
    expect(await events(s.id!)).toHaveLength(1);
  });

  it('T05-14 stale version is 409; a short reason is 400; CLOSED → suspend is 409 INVALID_LIFECYCLE_TRANSITION', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const { c } = await platformAs('super_admin');
    const stale = await c('post', `/platform/societies/${s.id}/suspend`, {
      reasonCategory: 'OTHER',
      reason: 'Some long reason',
      version: 5,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    const short = await c('post', `/platform/societies/${s.id}/suspend`, {
      reasonCategory: 'OTHER',
      reason: 'short',
      version: 1,
    });
    expect(short.status).toBe(400);
    const closed = await lifecycleSociety('CLOSED', { name: 'Closed CHS' });
    const bad = await c('post', `/platform/societies/${closed.id}/suspend`, {
      reasonCategory: 'OTHER',
      reason: 'Some long reason',
      version: closed.version,
    });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('INVALID_LIFECYCLE_TRANSITION');
  });
});

describe('module 06 hooks (8.25, BR-05-1, BR-05-2)', () => {
  it('T05-17 overdue → grace expired → cleared: ACTIVE → PAST_DUE → SUSPENDED(NON_PAYMENT) → ACTIVE, three events', async () => {
    const s = await lifecycleSociety('ACTIVE');
    await sequelize.transaction(t => onInvoiceOverdue(BILLING, s.id!, t));
    let r = await reload(s.id!);
    expect(r.status).toBe('PAST_DUE');
    expect(r.pastDueSince).not.toBeNull();
    await sequelize.transaction(t => onGraceExpired(BILLING, s.id!, t));
    r = await reload(s.id!);
    expect([r.status, r.suspensionCause]).toEqual(['SUSPENDED', 'NON_PAYMENT']);
    await sequelize.transaction(t => onAccountCleared(BILLING, s.id!, t));
    r = await reload(s.id!);
    expect([r.status, r.suspensionCause, r.pastDueSince]).toEqual(['ACTIVE', null, null]);
    const ev = await events(s.id!);
    expect(ev.map(e => [e.triggerCode, e.triggerSource, e.actorName])).toEqual([
      ['INVOICE_OVERDUE', 'BILLING', 'billing'],
      ['GRACE_EXPIRED', 'BILLING', 'billing'],
      ['ACCOUNT_CLEARED', 'BILLING', 'billing'],
    ]);
  });

  it('T05-18 / T05-19 no-ops: cleared on a MANUAL suspension, overdue twice', async () => {
    const m = await lifecycleSociety('SUSPENDED', { cause: 'MANUAL' });
    await sequelize.transaction(t => onAccountCleared(BILLING, m.id!, t));
    expect((await reload(m.id!)).status).toBe('SUSPENDED');
    expect(await events(m.id!)).toHaveLength(0);
    const s = await lifecycleSociety('ACTIVE', { name: 'Second CHS' });
    await sequelize.transaction(t => onInvoiceOverdue(BILLING, s.id!, t));
    await sequelize.transaction(t => onInvoiceOverdue(BILLING, s.id!, t));
    expect(await events(s.id!)).toHaveLength(1);
  });

  it('T05-19a the hook runs in the caller transaction: lock first, hook, roll back → nothing changed', async () => {
    const s = await lifecycleSociety('ACTIVE');
    await expect(
      sequelize.transaction(async t => {
        await Society.findByPk(s.id!, { transaction: t, lock: t.LOCK.UPDATE });
        await onInvoiceOverdue(BILLING, s.id!, t);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await reload(s.id!)).status).toBe('ACTIVE');
    expect(await events(s.id!)).toHaveLength(0);
  });

  it('onFirstInvoicePaid: TRIAL → ACTIVE and SUSPENDED(TRIAL_EXPIRED) → ACTIVE', async () => {
    const t1 = await lifecycleSociety('TRIAL');
    await sequelize.transaction(t => onFirstInvoicePaid(BILLING, t1.id!, t));
    const r = await reload(t1.id!);
    expect([r.status, r.trialEndsAt]).toEqual(['ACTIVE', null]);
    expect(r.activatedAt).not.toBeNull();
    const t2 = await lifecycleSociety('SUSPENDED', { cause: 'TRIAL_EXPIRED', name: 'Expired CHS' });
    await sequelize.transaction(t => onFirstInvoicePaid(BILLING, t2.id!, t));
    expect((await reload(t2.id!)).status).toBe('ACTIVE');
  });

  it('T05-19b getStatusAt reads the history in Asia/Kolkata days', async () => {
    const s = await makeSociety('History CHS');
    const add = (toStatus: string, at: string) =>
      SocietyLifecycleEvent.create({
        societyId: s.id!,
        eventType: 'STATUS_CHANGED',
        fromStatus: null,
        toStatus: toStatus as never,
        triggerSource: 'BILLING',
        triggerCode: 'INVOICE_OVERDUE',
        actorName: 'billing',
        createdAt: new Date(at),
      } as never);
    await add('ACTIVE', '2026-10-01T05:00:00Z');
    await add('PAST_DUE', '2026-11-17T04:30:00Z'); // 10:00 IST
    await add('SUSPENDED', '2026-12-01T05:00:00Z');
    expect(await getStatusAt(s.id!, '2026-11-16')).toBe('ACTIVE');
    expect(await getStatusAt(s.id!, '2026-11-17')).toBe('PAST_DUE');
    expect(await getStatusAt(s.id!, '2026-12-01')).toBe('SUSPENDED');
    expect(await getStatusAt(s.id!, '2026-09-01')).toBeNull();
    expect(await getStatusAt(s.id!, new Date('2026-11-17T04:29:00Z'))).toBe('ACTIVE');
  });
});

describe('reactivation (8.11, BR-05-17)', () => {
  it('T05-20 overdue without graceUntil is 422; with 10 days it is PAST_DUE with a hold; onGraceExpired before the hold is a no-op', async () => {
    setSocietyPorts({ billing: { hasOverdueInvoice: async () => true } });
    const s = await lifecycleSociety('SUSPENDED', { cause: 'NON_PAYMENT' });
    const { c } = await platformAs('super_admin');
    const no = await c('post', `/platform/societies/${s.id}/reactivate`, {
      reason: 'Promised to pay this week',
      version: 1,
    });
    expect(no.status).toBe(422);
    expect(no.body.code).toBe('GRACE_DATE_REQUIRED');
    const graceUntil = addDays(now(), 10).toISOString();
    const ok = await c('post', `/platform/societies/${s.id}/reactivate`, {
      reason: 'Promised to pay this week',
      graceUntil,
      version: 1,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'PAST_DUE', suspensionHoldUntil: graceUntil, version: 2 });
    expect(await events(s.id!, 'GRACE_GRANTED')).toHaveLength(1);
    await sequelize.transaction(t => onGraceExpired(BILLING, s.id!, t));
    expect((await reload(s.id!)).status).toBe('PAST_DUE');
    setNow(addDays(now(), 11));
    await sequelize.transaction(t => onGraceExpired(BILLING, s.id!, t));
    expect((await reload(s.id!)).status).toBe('SUSPENDED');
  });

  it('no overdue: ACTIVE, and graceUntil is refused; TRIAL_EXPIRED without a paid plan is 422 NO_PAID_SUBSCRIPTION', async () => {
    const s = await lifecycleSociety('SUSPENDED', { cause: 'MANUAL' });
    const { c } = await platformAs('super_admin');
    const g = await c('post', `/platform/societies/${s.id}/reactivate`, {
      reason: 'Policy issue resolved now',
      graceUntil: addDays(now(), 5).toISOString(),
      version: 1,
    });
    expect(g.status).toBe(400);
    const ok = await c('post', `/platform/societies/${s.id}/reactivate`, {
      reason: 'Policy issue resolved now',
      version: 1,
    });
    expect(ok.body.data).toMatchObject({ status: 'ACTIVE', suspensionHoldUntil: null });
    const e = await lifecycleSociety('SUSPENDED', { cause: 'TRIAL_EXPIRED', name: 'Expired CHS' });
    const r = await c('post', `/platform/societies/${e.id}/reactivate`, {
      reason: 'Please let them in',
      version: 1,
    });
    expect(r.body.code).toBe('NO_PAID_SUBSCRIPTION');
  });
});

describe('closure and reopen (8.12, 8.13, BR-05-18, BR-05-20)', () => {
  it('T05-21 wrong name is 422; the right name closes: CLOSURE export, grants revoked, subscription cancelled, guard devices and invitations', async () => {
    const s = await lifecycleSociety('ACTIVE', { name: 'Sky Heights CHS' });
    const sa = await platformAs('super_admin');
    const ps = await platformAs('platform_support');
    const g = await activeGrant(s.id!, ps.user.id);
    await sequelize.transaction(t =>
      createInvitationCore(
        systemCtx('t'),
        { societyId: s.id!, name: 'Pending One', mobile: '9820055501', roleKey: 'secretary' },
        t,
      ),
    );
    const body = { closureReason: 'CUSTOMER_REQUEST', reason: 'The committee asked to close', version: 1 };
    const bad = await sa.c('post', `/platform/societies/${s.id}/close`, {
      ...body,
      confirmName: 'sky heights chs',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('CONFIRM_NAME_MISMATCH');
    const noRes = await sa.c('post', `/platform/societies/${s.id}/close`, {
      ...body,
      confirmName: 'Sky Heights CHS',
      notifyResidents: false,
    });
    expect(noRes.status).toBe(400);
    const ok = await sa.c('post', `/platform/societies/${s.id}/close`, {
      ...body,
      confirmName: ' Sky Heights CHS ',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      status: 'CLOSED',
      closedAt: '2026-10-30T06:30:00.000Z',
      purgeAfter: '2027-01-28T06:30:00.000Z',
      version: 2,
    });
    const r = await reload(s.id!);
    expect(r.financialRetainUntil).toBe('2035-03-31');
    expect(r.healthScore).toBe(0);
    const exp = (await DataExport.findByPk(ok.body.data.closureExportId))!;
    expect([exp.kind, exp.requestedVia]).toEqual(['CLOSURE', 'SYSTEM']);
    expect((await SupportAccessGrant.findByPk(g.id!))!).toMatchObject({
      status: 'REVOKED',
      endReason: 'SOCIETY_CLOSED',
    });
    expect((await Subscription.findOne({ where: { societyId: s.id! } }))!.status).toBe('CANCELLED');
    expect(await Invitation.count({ where: { societyId: s.id!, status: 'PENDING' } })).toBe(0);
    expect(portCalls.map(p => p.fn)).toEqual([
      'guardDevices.revokeAllForSociety',
      'autopay.cancelAllForSociety',
    ]);
    expect(portCalls.every(p => p.t)).toBe(true);
    await settle();
    expect((await DataExport.findByPk(exp.id!))!.status).toBe('READY');
  });

  it('T05-22 reopen after purge is 409 SOCIETY_PURGED; before purge it reopens with a new paid subscription', async () => {
    const { c } = await platformAs('super_admin');
    const p = await lifecycleSociety('CLOSED', { name: 'Purged CHS' });
    await Society.update({ purgedAt: now() }, { where: { id: p.id! } });
    const body = { planKey: 'STANDARD', billingCycle: 'MONTHLY', reason: 'They came back to us', version: 1 };
    const r = await c('post', `/platform/societies/${p.id}/reopen`, body, { headers: idem() });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SOCIETY_PURGED');
    const s = await lifecycleSociety('ACTIVE', { name: 'Back Again CHS' });
    await sequelize.transaction(async t => {
      await cancelForClosure(systemCtx('t'), s.id!, t);
    });
    await Society.update(
      {
        status: 'CLOSED',
        closedAt: now(),
        closureReason: 'OTHER',
        purgeAfter: addDays(now(), 90),
        financialRetainUntil: '2035-03-31',
      } as never,
      { where: { id: s.id! } },
    );
    const ok = await c(
      'post',
      `/platform/societies/${s.id}/reopen`,
      { ...body, version: (await reload(s.id!)).version },
      { headers: idem() },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await reload(s.id!);
    expect([after.status, after.closedAt, after.purgeAfter, after.financialRetainUntil]).toEqual([
      'ACTIVE',
      null,
      null,
      null,
    ]);
    expect(await Subscription.count({ where: { societyId: s.id!, status: 'ACTIVE' } })).toBe(1);
  });

  it('module 04 cancelling a trial closes the society (SUBSCRIPTION_CANCELLED)', async () => {
    const s = await lifecycleSociety('TRIAL');
    const sub = (await Subscription.findOne({ where: { societyId: s.id! } }))!;
    const chair = await memberUser(s, 'chairman');
    await sequelize.transaction(t =>
      applyCancellation(
        systemCtx('t'),
        { subscriptionId: sub.id!, requestedBy: chair.id, reason: 'Not for us' },
        t,
      ),
    );
    const r = await reload(s.id!);
    expect([r.status, r.closureReason]).toEqual(['CLOSED', 'CUSTOMER_REQUEST']);
    expect((await events(s.id!))[0]!.triggerCode).toBe('SUBSCRIPTION_CANCELLED');
    expect(integrationCalls.filter(c => c.fn === 'closeForSubscriptionCancellation')).toHaveLength(0);
  });
});

describe('trial extension and conversion (8.8, 8.9, BR-05-5)', () => {
  it('T05-23 extend twice, the third is 422 TRIAL_EXTENSION_LIMIT; from SUSPENDED(TRIAL_EXPIRED) it returns to TRIAL', async () => {
    const s = await lifecycleSociety('TRIAL');
    const { c } = await platformAs('super_admin');
    const end0 = (await reload(s.id!)).trialEndsAt!;
    const r1 = await c('post', `/platform/societies/${s.id}/extend-trial`, {
      days: 7,
      reason: 'They need one more week',
      version: 1,
    });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body.data).toMatchObject({ status: 'TRIAL', trialExtendedCount: 1, version: 2 });
    expect(new Date(r1.body.data.trialEndsAt).getTime()).toBe(addDays(end0, 7).getTime());
    expect((await Subscription.findOne({ where: { societyId: s.id! } }))!.trialEndsAt!.toISOString()).toBe(
      r1.body.data.trialEndsAt,
    );
    expect(
      (
        await c('post', `/platform/societies/${s.id}/extend-trial`, {
          days: 30,
          reason: 'They need one more week',
          version: 2,
        })
      ).status,
    ).toBe(200);
    const r3 = await c('post', `/platform/societies/${s.id}/extend-trial`, {
      days: 1,
      reason: 'They need one more week',
      version: 3,
    });
    expect(r3.status).toBe(422);
    expect(r3.body.code).toBe('TRIAL_EXTENSION_LIMIT');
    expect(await events(s.id!, 'TRIAL_EXTENDED')).toHaveLength(2);
    const e = await lifecycleSociety('SUSPENDED', { cause: 'TRIAL_EXPIRED', name: 'Expired CHS' });
    const back = await c('post', `/platform/societies/${e.id}/extend-trial`, {
      days: 5,
      reason: 'Second chance to try',
      version: 1,
    });
    expect(back.body.data).toMatchObject({ status: 'TRIAL', trialEndsAt: addDays(now(), 5).toISOString() });
    expect((await events(e.id!)).map(x => x.toStatus)).toEqual(['TRIAL']);
    const active = await lifecycleSociety('ACTIVE', { name: 'Active CHS' });
    const no = await c('post', `/platform/societies/${active.id}/extend-trial`, {
      days: 5,
      reason: 'Second chance to try',
      version: 1,
    });
    expect(no.body.code).toBe('INVALID_LIFECYCLE_TRANSITION');
  });

  it('convert TRIAL → ACTIVE issues the first invoice in the same transaction', async () => {
    const s = await lifecycleSociety('TRIAL');
    const { c } = await platformAs('super_admin');
    const r = await c(
      'post',
      `/platform/societies/${s.id}/convert`,
      { billingCycle: 'ANNUAL', reason: 'Signed the annual contract', version: 1 },
      { headers: idem() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      status: 'ACTIVE',
      planKey: 'STANDARD',
      billingCycle: 'ANNUAL',
      version: 2,
    });
    expect(integrationCalls.filter(x => x.fn === 'issuePeriodInvoice')).toHaveLength(1);
    expect((await events(s.id!))[0]!.triggerCode).toBe('MANUAL_CONVERT');
    expect(await AuditLog.count({ where: { action: 'societies.society.converted', societyId: s.id! } })).toBe(
      1,
    );
    const st = await trialConversionStats(addDays(now(), -1), addDays(now(), 1));
    expect(st).toEqual({ converted: 1, ended: 1, ratePct: 100 });
  });
});

describe('jobs (9.1)', () => {
  it('T05-24 trial expiry job suspends with TRIAL_EXPIRED and notifies billing admins', async () => {
    const s = await lifecycleSociety('TRIAL');
    await memberUser(s, 'chairman', { mobile: '9820012345' });
    setNow(addDays(now(), 15));
    expect(await expireTrials()).toBe(1);
    await settle();
    const r = await reload(s.id!);
    expect([r.status, r.suspensionCause]).toEqual(['SUSPENDED', 'TRIAL_EXPIRED']);
    expect(
      (await listInbox()).some(m => m.templateKey === 'societies.trial_expired' && m.to === '9820012345'),
    ).toBe(true);
    expect(await expireTrials()).toBe(0);
  });

  it('T05-25 auto-close at suspendedAt + 60 days for NON_PAYMENT; MANUAL untouched; warnings once at 7 days left', async () => {
    const np = await lifecycleSociety('SUSPENDED', { cause: 'NON_PAYMENT', name: 'Unpaid CHS' });
    const man = await lifecycleSociety('SUSPENDED', { cause: 'MANUAL', name: 'Manual CHS' });
    await Society.update({ suspendedAt: addDays(now(), -53) }, { where: { id: [np.id!, man.id!] } });
    expect(await autoClose()).toEqual({ warned: 1, closed: 0 });
    expect(await autoClose()).toEqual({ warned: 0, closed: 0 });
    const w = await events(np.id!, 'AUTO_CLOSE_WARNED');
    expect(w[0]!.metadata).toEqual({ daysLeft: 7 });
    setNow(addDays(now(), 7));
    expect(await autoClose()).toEqual({ warned: 0, closed: 1 });
    expect([(await reload(np.id!)).status, (await reload(np.id!)).closureReason]).toEqual([
      'CLOSED',
      'NON_PAYMENT',
    ]);
    expect((await reload(man.id!)).status).toBe('SUSPENDED');
    setSocietyPorts({ settings: { get: async () => 0 } });
    expect(await autoClose()).toEqual({ warned: 0, closed: 0 });
  });
});

describe('purge hold (8.14)', () => {
  it('PUT sets, DELETE clears, DELETE without a hold is 409 INVALID_STATE', async () => {
    const s = await lifecycleSociety('CLOSED');
    const { c } = await platformAs('super_admin');
    const put = await c('put', `/platform/societies/${s.id}/purge-hold`, {
      reason: 'Legal dispute pending',
      version: s.version,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data.purgeHoldReason).toBe('Legal dispute pending');
    const del = await c('delete', `/platform/societies/${s.id}/purge-hold`, {
      reason: 'Dispute settled now',
      version: put.body.data.version,
    });
    expect(del.body.data.purgeHoldReason).toBeNull();
    const again = await c('delete', `/platform/societies/${s.id}/purge-hold`, {
      reason: 'Dispute settled now',
      version: del.body.data.version,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_STATE');
    expect(
      (await events(s.id!, 'PURGE_HOLD_SET')).length + (await events(s.id!, 'PURGE_HOLD_CLEARED')).length,
    ).toBe(2);
  });
});
