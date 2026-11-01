import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  AuditLog,
  Invitation,
  Organization,
  Role,
  Society,
  SocietyLifecycleEvent,
  Subscription,
  closeDb,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { as, idem, login, makeSociety, memberUser, resetLogins } from '../../helpers/access';
import { makeUser } from '../../helpers/auth';
import { lifecycleSociety, platformAs, resetSocieties } from '../../helpers/societies';

afterAll(closeDb);
beforeEach(async () => {
  setNow('2026-10-30T06:30:00Z');
  await resetSocieties();
  resetLogins();
  setNow('2026-10-30T06:30:00Z');
});

const wizard = (
  o: {
    slug?: string;
    name?: string;
    startAs?: 'TRIAL' | 'ACTIVE';
    flats?: number;
    plan?: string;
    org?: number;
    mobile?: string;
  } = {},
) => ({
  society: {
    name: o.name ?? 'Lotus Residency CHS',
    ...(o.slug ? { slug: o.slug } : {}),
    addressLine1: 'Plot 7, Aundh Road',
    city: 'Pune',
    state: 'Maharashtra',
    pincode: '411007',
    approxFlats: o.flats ?? 120,
    ...(o.org ? { organizationId: o.org } : {}),
  },
  firstAdmin: {
    name: 'Aarav Mehta',
    mobile: o.mobile ?? '9820011111',
    email: `aarav${o.mobile ?? ''}@example.in`,
    roleKey: 'chairman',
  },
  plan: { planKey: o.plan ?? 'STANDARD', billingCycle: 'MONTHLY', startAs: o.startAs ?? 'TRIAL' },
});

describe('Add society wizard (8.4)', () => {
  it('T05-06 Platform Support creates a TRIAL society with roles, subscription, invitation, event and audit', async () => {
    const { c } = await platformAs('platform_support');
    const r = await c('post', '/platform/societies', wizard(), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.message).toBe('Society created. Invite sent to the chairman.');
    const d = r.body.data;
    expect(d).toMatchObject({
      name: 'Lotus Residency CHS',
      slug: 'lotus-residency-chs',
      status: 'TRIAL',
      planKey: 'STANDARD',
      version: 1,
    });
    expect(d.trialEndsAt).toBe('2026-11-13T06:30:00.000Z');
    expect(await Role.count({ where: { societyId: d.id } })).toBe(15);
    expect((await Subscription.findOne({ where: { societyId: d.id } }))!.status).toBe('TRIALING');
    const inv = (await Invitation.findByPk(d.invitationId))!;
    expect(inv.mobile).toBe('9820011111');
    expect((await Role.findByPk(inv.roleId))!.key).toBe('chairman');
    const ev = await SocietyLifecycleEvent.findAll({ where: { societyId: d.id } });
    expect(ev.map(e => [e.eventType, e.triggerCode, e.toStatus])).toEqual([
      ['CREATED', 'ASSISTED_CREATE', 'TRIAL'],
    ]);
    expect(await AuditLog.count({ where: { action: 'societies.society.created', societyId: d.id } })).toBe(1);
  });

  it('T05-07 paid start or custom price by Platform Support is 403 and creates nothing', async () => {
    const { c } = await platformAs('platform_support');
    const r = await c('post', '/platform/societies', wizard({ startAs: 'ACTIVE' }), { headers: idem() });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PERMISSION_DENIED');
    expect(await Society.count()).toBe(0);
  });

  it('Super Admin may start ACTIVE: first invoice through module 06 and activatedAt set', async () => {
    const { c } = await platformAs('super_admin');
    const r = await c('post', '/platform/societies', wizard({ startAs: 'ACTIVE' }), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const s = (await Society.findByPk(r.body.data.id))!;
    expect(s.status).toBe('ACTIVE');
    expect(s.activatedAt).not.toBeNull();
    expect((await Subscription.findOne({ where: { societyId: s.id! } }))!.status).toBe('ACTIVE');
  });

  it('T05-08 approxFlats 9 and 20001 are 400; 10 and 20000 are accepted', async () => {
    const { c } = await platformAs('platform_support');
    for (const flats of [9, 20001]) {
      const r = await c('post', '/platform/societies', wizard({ flats }), { headers: idem() });
      expect(r.status).toBe(400);
      expect(r.body.errors[0].field).toBe('society.approxFlats');
    }
    expect(
      (
        await c('post', '/platform/societies', wizard({ flats: 10, name: 'Ten Flats CHS' }), {
          headers: idem(),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await c(
          'post',
          '/platform/societies',
          wizard({ flats: 20000, name: 'Big Flats CHS', mobile: '9820011112' }),
          { headers: idem() },
        )
      ).status,
    ).toBe(201);
  });

  it('T05-09 organization on a Standard plan is 422; inactive organization is 422', async () => {
    const { c } = await platformAs('super_admin');
    const org = await Organization.create({
      name: 'Raheja Group',
      slug: 'raheja',
      status: 'ACTIVE',
    } as never);
    const r = await c('post', '/platform/societies', wizard({ org: org.id! }), { headers: idem() });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('ORGANIZATION_REQUIRES_ENTERPRISE');
    await org.update({ status: 'SUSPENDED' });
    const e = await c(
      'post',
      '/platform/societies',
      {
        ...wizard({ org: org.id!, plan: 'ENTERPRISE', startAs: 'ACTIVE' }),
        plan: {
          planKey: 'ENTERPRISE',
          billingCycle: 'MONTHLY',
          startAs: 'ACTIVE',
          customPricePerFlatPaise: 2000,
        },
      },
      { headers: idem() },
    );
    expect(e.body.code).toBe('ORGANIZATION_NOT_ACTIVE');
    const cp = await c(
      'post',
      '/platform/societies',
      {
        ...wizard(),
        plan: {
          planKey: 'STANDARD',
          billingCycle: 'MONTHLY',
          startAs: 'TRIAL',
          customPricePerFlatPaise: 2000,
        },
      },
      { headers: idem() },
    );
    expect(cp.body.code).toBe('CUSTOM_PRICE_ENTERPRISE_ONLY');
  });

  it('T05-10 the same Idempotency-Key twice creates one society and replays', async () => {
    const { c } = await platformAs('platform_support');
    const key = randomUUID();
    const a = await c('post', '/platform/societies', wizard(), { headers: { 'Idempotency-Key': key } });
    const b = await c('post', '/platform/societies', wizard(), { headers: { 'Idempotency-Key': key } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await Society.count()).toBe(1);
  });

  it('slug taken is 409 with three suggestions, reserved is 422, duplicates are 409 with ids, then confirmNotDuplicate', async () => {
    const { c } = await platformAs('platform_support');
    expect(
      (await c('post', '/platform/societies', wizard({ slug: 'lotus-residency' }), { headers: idem() }))
        .status,
    ).toBe(201);
    const taken = await c(
      'post',
      '/platform/societies',
      wizard({ slug: 'lotus-residency', name: 'Other CHS' }),
      { headers: idem() },
    );
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('SLUG_TAKEN');
    expect(taken.body.errors[0].suggestions).toEqual([
      'lotus-residency-pune',
      'lotus-residency-2',
      'lotus-residency-3',
    ]);
    const reserved = await c('post', '/platform/societies', wizard({ slug: 'admin', name: 'Admin CHS' }), {
      headers: idem(),
    });
    expect(reserved.status).toBe(422);
    expect(reserved.body.code).toBe('SLUG_RESERVED');
    const dup = await c(
      'post',
      '/platform/societies',
      wizard({ name: 'Lotus Residency Co-op Hsg Society Ltd', mobile: '9820011113' }),
      { headers: idem() },
    );
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('POSSIBLE_DUPLICATE_SOCIETY');
    expect(dup.body.errors[0]).toMatchObject({ name: 'Lotus Residency CHS', city: 'Pune' });
    expect(dup.body.errors[0].societyId).toBeTypeOf('number');
    const ok = await c(
      'post',
      '/platform/societies',
      {
        ...wizard({ name: 'Lotus Residency Co-op Hsg Society Ltd', mobile: '9820011113' }),
        confirmNotDuplicate: true,
      },
      { headers: idem() },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const avail = await c('get', '/platform/societies/slug-availability', undefined, {
      query: { slug: 'lotus-residency' },
    });
    expect(avail.body.data).toMatchObject({ slug: 'lotus-residency', available: false, reason: 'TAKEN' });
    expect(avail.body.data.suggestions).toHaveLength(3);
    const free = await c('get', '/platform/societies/slug-availability', undefined, {
      query: { slug: 'brand-new-place' },
    });
    expect(free.body.data).toEqual({
      slug: 'brand-new-place',
      available: true,
      reason: null,
      suggestions: [],
    });
  });

  it('an invitation module 03 refuses is mapped to 409 INVITATION_CONFLICT and nothing is created', async () => {
    await makeUser({ mobile: '9820099999', status: 'DISABLED' });
    const { c } = await platformAs('platform_support');
    const r = await c('post', '/platform/societies', wizard({ mobile: '9820099999' }), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.code).toBe('INVITATION_CONFLICT');
    expect(await Society.count()).toBe(0);
  });
});

describe('list, detail, edit, events, CSV (8.2 to 8.7)', () => {
  it('lists with filters, sort and pagination; units and plan come from snapshots and module 04', async () => {
    const { c } = await platformAs('platform_support');
    const a = await lifecycleSociety('TRIAL', { name: 'Tulip Gardens CHS' });
    await lifecycleSociety('ACTIVE', { name: 'Sky Heights CHS', plan: 'PREMIUM' });
    await Society.update({ approxFlats: 60, healthScore: 40 }, { where: { id: a.id! } });
    const r = await c('get', '/platform/societies');
    expect(r.status).toBe(200);
    expect(r.body.pagination).toMatchObject({ page: 1, limit: 20, total: 2 });
    expect(r.body.data.map((x: { name: string }) => x.name)).toEqual([
      'Sky Heights CHS',
      'Tulip Gardens CHS',
    ]);
    const t = r.body.data[1];
    expect(t).toMatchObject({
      status: 'TRIAL',
      planKey: 'STANDARD',
      units: 60,
      healthScore: 40,
      healthBand: 'AT_RISK',
      mrrPaise: 0,
    });
    const f = await c('get', '/platform/societies', undefined, {
      query: { status: 'TRIAL', healthBand: 'AT_RISK' },
    });
    expect(f.body.data).toHaveLength(1);
    const p = await c('get', '/platform/societies', undefined, { query: { planKey: 'PREMIUM' } });
    expect(p.body.data.map((x: { name: string }) => x.name)).toEqual(['Sky Heights CHS']);
    const q = await c('get', '/platform/societies', undefined, {
      query: { q: 'tul', sortBy: 'healthScore', sortOrder: 'desc' },
    });
    expect(q.body.data).toHaveLength(1);
    expect(
      (await c('get', '/platform/societies', undefined, { query: { trialEndingWithinDays: '31' } })).status,
    ).toBe(400);
    expect((await c('get', '/platform/societies', undefined, { query: { unknown: 'x' } })).status).toBe(400);
  });

  it('detail has lifecycle, allowedActions by permission, and 404 for an unknown id', async () => {
    const s = await lifecycleSociety('TRIAL', { name: 'Tulip Gardens CHS' });
    const sa = await platformAs('super_admin');
    const d = await sa.c('get', `/platform/societies/${s.id}`);
    expect(d.status).toBe(200);
    expect(d.body.data.lifecycle).toMatchObject({ status: 'TRIAL', trialExtensionsLeft: 2 });
    expect(d.body.data.lifecycle.allowedActions).toEqual(['CONVERT', 'EXTEND_TRIAL', 'SUSPEND', 'CLOSE']);
    expect(d.body.data.subscription).toMatchObject({ planKey: 'STANDARD' });
    expect(d.body.data.openSupportGrant).toBeNull();
    const ps = await platformAs('platform_support');
    expect((await ps.c('get', `/platform/societies/${s.id}`)).body.data.lifecycle.allowedActions).toEqual([]);
    const nf = await ps.c('get', '/platform/societies/999999');
    expect(nf.status).toBe(404);
    expect(nf.body.code).toBe('SOCIETY_NOT_FOUND');
    expect((await ps.c('get', '/platform/societies/abc')).status).toBe(400);
  });

  it('PATCH edits fields with version, audits the changed fields, refuses stale versions and purged societies', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const { c } = await platformAs('super_admin');
    const r = await c('patch', `/platform/societies/${s.id}`, { city: 'Mumbai', version: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ city: 'Mumbai', version: 2 });
    const a = await AuditLog.findOne({ where: { action: 'societies.society.updated', societyId: s.id! } });
    expect(a!.after).toEqual({ city: 'Mumbai' });
    const stale = await c('patch', `/platform/societies/${s.id}`, { city: 'Thane', version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    expect((await c('patch', `/platform/societies/${s.id}`, { slug: 'x', version: 2 })).status).toBe(400);
    await Society.update({ status: 'CLOSED', closedAt: new Date(), purgedAt: new Date() } as never, {
      where: { id: s.id! },
    });
    const purged = await c('patch', `/platform/societies/${s.id}`, { city: 'Thane', version: 2 });
    expect(purged.body.code).toBe('SOCIETY_PURGED');
  });

  it('CSV export of the filtered list, audited', async () => {
    await lifecycleSociety('ACTIVE', { name: 'Sky Heights CHS' });
    const { c } = await platformAs('super_admin');
    const r = await c('get', '/platform/societies/export');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    const lines = r.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'ID,Name,Slug,City,State,Plan,Status,Units,Active users 30d,MRR (INR),Health,Created',
    );
    expect(lines).toHaveLength(2);
    expect(await AuditLog.count({ where: { action: 'societies.society.list_exported' } })).toBe(1);
    const ps = await platformAs('platform_support');
    expect((await ps.c('get', '/platform/societies/export')).status).toBe(403);
  });

  it('lifecycle events list (8.7)', async () => {
    const { c } = await platformAs('platform_support');
    const r = await c('post', '/platform/societies', wizard(), { headers: idem() });
    const e = await c('get', `/platform/societies/${r.body.data.id}/lifecycle-events`);
    expect(e.status).toBe(200);
    expect(e.body.data[0]).toMatchObject({
      eventType: 'CREATED',
      triggerSource: 'PLATFORM_USER',
      triggerCode: 'ASSISTED_CREATE',
      toStatus: 'TRIAL',
    });
    expect(e.body.data[0].actorName).toBe('Isha Kapoor');
  });
});

describe('T05-43 / T05-44 permissions and plans', () => {
  it('Platform Support cannot suspend, close, reopen, revoke grants or set a purge hold', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const { c } = await platformAs('platform_support');
    const cases: [string, string, unknown][] = [
      [
        'post',
        `/platform/societies/${s.id}/suspend`,
        { reasonCategory: 'OTHER', reason: 'Policy violation found', version: 1 },
      ],
      [
        'post',
        `/platform/societies/${s.id}/close`,
        { closureReason: 'OTHER', reason: 'Closing the society', confirmName: s.name, version: 1 },
      ],
      ['post', `/platform/societies/${s.id}/reactivate`, { reason: 'Reactivating it now', version: 1 }],
      [
        'post',
        `/platform/societies/${s.id}/extend-trial`,
        { days: 7, reason: 'More time to decide', version: 1 },
      ],
      ['put', `/platform/societies/${s.id}/purge-hold`, { reason: 'Legal dispute pending', version: 1 }],
      ['patch', `/platform/societies/${s.id}`, { city: 'X City', version: 1 }],
      ['post', '/platform/support-access/1/revoke', { reason: 'Not needed', version: 1 }],
    ];
    for (const [m, path, body] of cases) {
      const r = await c(m as 'post', path, body, { headers: idem() });
      expect(r.status, path).toBe(403);
      expect(r.body.code, path).toBe('PERMISSION_DENIED');
    }
  });

  it('a society user without a platform role gets 403 on platform routes', async () => {
    const s = await makeSociety();
    const chair = await memberUser(s, 'chairman');
    const r = await as(await login(chair))('get', '/platform/societies');
    expect(r.status).toBe(403);
  });

  it('T05-44 module 05 routes never answer 402 for a Starter society', async () => {
    const s = await lifecycleSociety('ACTIVE', { plan: 'STARTER' });
    const chair = await memberUser(s, 'chairman');
    const c = as(await login(chair, { societyId: s.id! }));
    for (const path of ['/society-status', '/support-access', '/support-access/settings', '/data-exports'])
      expect((await c('get', path)).status, path).toBe(200);
  });
});
