import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  Permission,
  Role,
  RolePermission,
  Session,
  Society,
  SupportAccessGrant,
  closeDb,
} from '../../../src/models';
import { kv } from '../../../src/lib/kv';
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';
import { addMinutes, advance, now, setNow } from '../../../src/lib/clock';
import { setAuthPorts } from '../../../src/modules/auth/auth.ports';
import {
  expireDue,
  flushRequestCounts,
  validateForHandoff,
} from '../../../src/modules/societies/societies.support-access';
import { as, idem, login, memberUser, resetLogins } from '../../helpers/access';
import { events } from '../../helpers/auth';
import { probeAs } from '../../helpers/probe';
import {
  activeGrant,
  enterAsSupport,
  lifecycleSociety,
  platformAs,
  resetSocieties,
  settle,
} from '../../helpers/societies';

afterAll(closeDb);
beforeEach(async () => {
  setNow('2026-10-30T05:42:00Z');
  await resetSocieties();
  resetLogins();
  setNow('2026-10-30T05:42:00Z');
});

const request = (societyId: number, o: Record<string, unknown> = {}) => ({
  societyId,
  scope: 'READ_ONLY',
  durationMinutes: 60,
  reason: 'Check bank statement import errors in TKT-2041',
  ticketRef: 'TKT-2041',
  ...o,
});

describe('requesting and deciding (8.19, 8.23, BR-05-25 to BR-05-28)', () => {
  it('T05-27 consent required: PENDING_CONSENT, then the Chairman approves and it is ACTIVE until approval + duration', async () => {
    const s = await lifecycleSociety('ACTIVE', { name: 'Lake View CHS' });
    const chair = await memberUser(s, 'chairman', { name: 'Aarav Mehta', mobile: '9820011111' });
    const ps = await platformAs('platform_support');
    const r = await ps.c('post', '/platform/support-access', request(s.id!), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.message).toBe('Support access requested');
    expect(r.body.data).toMatchObject({
      code: `G-${String(r.body.data.id).padStart(4, '0')}`,
      society: { id: s.id, name: 'Lake View CHS' },
      requester: { id: ps.user.id, name: 'Isha Kapoor' },
      status: 'PENDING_CONSENT',
      consentStatus: 'PENDING',
      consentExpiresAt: '2026-10-31T05:42:00.000Z',
      endsAt: null,
    });
    await settle();
    expect(
      events.some(e => e.event === 'support_access.requested' && e.room === `society:${s.id}:admin`),
    ).toBe(true);
    const cc = as(await login(chair, { societyId: s.id! }));
    const list = await cc('get', '/support-access');
    expect(list.body.data[0]).toMatchObject({
      id: r.body.data.id,
      canDecide: true,
      requester: { name: 'Isha Kapoor' },
    });
    expect(list.body.data[0].requester.id).toBeUndefined();
    expect((await cc('get', '/society-status')).body.data.pendingSupportRequests).toBe(1);
    advance(2 * 60_000);
    const a = await cc('post', `/support-access/${r.body.data.id}/approve`, { version: 1 });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.data).toMatchObject({
      status: 'ACTIVE',
      consentStatus: 'APPROVED',
      startedAt: '2026-10-30T05:44:00.000Z',
      endsAt: '2026-10-30T06:44:00.000Z',
      decidedBy: { name: 'Aarav Mehta' },
    });
    const again = await cc('post', `/support-access/${r.body.data.id}/approve`, { version: 2 });
    expect(again.body.code).toBe('INVALID_STATE');
    const cur = await ps.c('get', '/platform/support-access/current');
    expect(cur.body.data).toMatchObject({ id: r.body.data.id, status: 'ACTIVE', secondsLeft: 3600 });
    const st = await cc('get', '/society-status');
    expect(st.body.data.supportAccess).toMatchObject({
      active: true,
      scope: 'READ_ONLY',
      staffFirstName: 'Isha',
    });
  });

  it('T05-28 without consent the grant is ACTIVE at once and audited as started', async () => {
    const s = await lifecycleSociety('ACTIVE', { consent: false });
    const ps = await platformAs('platform_support');
    const r = await ps.c('post', '/platform/support-access', request(s.id!), { headers: idem() });
    expect(r.body.data).toMatchObject({
      status: 'ACTIVE',
      consentStatus: 'NOT_REQUIRED',
      endsAt: '2026-10-30T06:42:00.000Z',
    });
    expect(await AuditLog.count({ where: { action: 'societies.support_grant.started' } })).toBe(1);
  });

  it('T05-29 two parallel requests by the same user: exactly one 201, the other 409', async () => {
    const a = await lifecycleSociety('ACTIVE', { name: 'A CHS' });
    const b = await lifecycleSociety('ACTIVE', { name: 'B CHS' });
    const ps = await platformAs('platform_support');
    const [x, y] = await Promise.all([
      ps.c('post', '/platform/support-access', request(a.id!), { headers: idem() }),
      ps.c('post', '/platform/support-access', request(b.id!), { headers: idem() }),
    ]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect([x.body.code, y.body.code]).toContain('SUPPORT_GRANT_ALREADY_OPEN');
    expect(await SupportAccessGrant.count()).toBe(1);
  });

  it('T05-30 durations 14, 250 and 50 are 400; 240 is accepted', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const ps = await platformAs('platform_support');
    for (const d of [14, 250, 50]) {
      const r = await ps.c('post', '/platform/support-access', request(s.id!, { durationMinutes: d }), {
        headers: idem(),
      });
      expect(r.status, String(d)).toBe(400);
    }
    const ok = await ps.c('post', '/platform/support-access', request(s.id!, { durationMinutes: 240 }), {
      headers: idem(),
    });
    expect(ok.status).toBe(201);
    const short = await ps.c('post', '/platform/support-access', request(s.id!, { reason: 'too short' }), {
      headers: idem(),
    });
    expect(short.status).toBe(400);
  });

  it('T05-31 emergency READ_WRITE by a Super Admin is 422; emergency by Platform Support is 403; READ_ONLY emergency skips consent', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const sa = await platformAs('super_admin');
    const rw = await sa.c(
      'post',
      '/platform/support-access',
      request(s.id!, { isEmergency: true, scope: 'READ_WRITE' }),
      { headers: idem() },
    );
    expect(rw.status).toBe(422);
    expect(rw.body.code).toBe('EMERGENCY_SCOPE_READ_ONLY');
    const ps = await platformAs('platform_support');
    const no = await ps.c('post', '/platform/support-access', request(s.id!, { isEmergency: true }), {
      headers: idem(),
    });
    expect(no.status).toBe(403);
    expect(no.body.code).toBe('PERMISSION_DENIED');
    const ok = await sa.c('post', '/platform/support-access', request(s.id!, { isEmergency: true }), {
      headers: idem(),
    });
    expect(ok.body.data).toMatchObject({
      status: 'ACTIVE',
      consentStatus: 'BYPASSED_EMERGENCY',
      isEmergency: true,
    });
  });

  it('READ_WRITE needs a fresh step-up; a CLOSED society is 423; an unknown society 404', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const ps = await platformAs('platform_support');
    advance(6 * 60_000);
    const rw = await ps.c('post', '/platform/support-access', request(s.id!, { scope: 'READ_WRITE' }), {
      headers: idem(),
    });
    expect(rw.body.code).toBe('REAUTH_REQUIRED');
    const closed = await lifecycleSociety('CLOSED', { name: 'Closed CHS' });
    const c = await ps.c('post', '/platform/support-access', request(closed.id!), { headers: idem() });
    expect([c.status, c.body.code]).toEqual([423, 'SOCIETY_CLOSED']);
    const nf = await ps.c('post', '/platform/support-access', request(999999), { headers: idem() });
    expect(nf.body.code).toBe('SOCIETY_NOT_FOUND');
  });

  it('T05-35 approving after the consent window is 409 CONSENT_WINDOW_EXPIRED and the grant is CONSENT_EXPIRED', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const chair = await memberUser(s, 'chairman');
    const ps = await platformAs('platform_support');
    const r = await ps.c('post', '/platform/support-access', request(s.id!), { headers: idem() });
    setNow(addMinutes(now(), 24 * 60 + 1));
    const cc = as(await login(chair, { societyId: s.id! }));
    const a = await cc('post', `/support-access/${r.body.data.id}/approve`, { version: 1 });
    expect(a.status).toBe(409);
    expect(a.body.code).toBe('CONSENT_WINDOW_EXPIRED');
    expect((await SupportAccessGrant.findByPk(r.body.data.id))!.status).toBe('CONSENT_EXPIRED');
  });

  it('deny with a reason; Treasurer cannot decide (403); the requester can cancel a pending request', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const chair = await memberUser(s, 'chairman');
    const treasurer = await memberUser(s, 'treasurer');
    const ps = await platformAs('platform_support');
    const r = await ps.c('post', '/platform/support-access', request(s.id!), { headers: idem() });
    const tc = as(await login(treasurer, { societyId: s.id! }));
    expect(
      (await tc('post', `/support-access/${r.body.data.id}/deny`, { reason: 'Not now please', version: 1 }))
        .status,
    ).toBe(403);
    expect((await tc('get', '/support-access')).status).toBe(403);
    const cc = as(await login(chair, { societyId: s.id! }));
    const d = await cc('post', `/support-access/${r.body.data.id}/deny`, {
      reason: 'Not now please',
      version: 1,
    });
    expect(d.body.data).toMatchObject({
      status: 'DENIED',
      consentStatus: 'DENIED',
      decisionNote: 'Not now please',
    });
    const r2 = await ps.c('post', '/platform/support-access', request(s.id!), { headers: idem() });
    const cn = await ps.c('post', `/platform/support-access/${r2.body.data.id}/cancel`, {});
    expect(cn.body.data).toMatchObject({ status: 'CANCELLED', consentStatus: 'CANCELLED' });
    expect((await ps.c('post', `/platform/support-access/${r2.body.data.id}/end`, {})).body.code).toBe(
      'INVALID_STATE',
    );
  });
});

describe('using a grant (6.3, 6.4, BR-05-30 to BR-05-33, BR-05-37)', () => {
  it('T05-32 READ_ONLY: writes are 403 SUPPORT_SCOPE_READ_ONLY; reads work and are logged once per route per 5 minutes', async () => {
    const s = await lifecycleSociety('ACTIVE');
    await memberUser(s, 'chairman');
    const ps = await platformAs('platform_support');
    const g = await activeGrant(s.id!, ps.user.id, 'READ_ONLY');
    const sup = await enterAsSupport(ps.cookies, g.id!);
    const w = await probeAs(sup.cookies)('patch', '/tickets/1', {});
    expect(w.status).toBe(403);
    expect(w.body.code).toBe('SUPPORT_SCOPE_READ_ONLY');
    expect((await sup.c('get', '/members')).status).toBe(403); // settings.members.* is never derived (6.4)
    expect((await sup.c('get', '/roles')).status).toBe(403);
    const st = await sup.c('get', '/society-status');
    expect(st.status).toBe(200);
    expect(st.body.data.viewerIsSupport).toBe(true);
    expect(st.body.data.supportAccess).toMatchObject({ active: true, viewerIsSupport: true });
    await sup.c('get', '/society-status');
    await settle();
    const viewed = await AuditLog.findAll({
      where: { action: 'societies.support_grant.viewed', supportGrantId: g.id! },
    });
    expect(viewed).toHaveLength(1);
    expect(viewed[0]!.actorRole).toBe('support:READ_ONLY');
    expect(viewed[0]!.after).toEqual({ method: 'GET', route: '/society-status' });
    await flushRequestCounts();
    expect((await SupportAccessGrant.findByPk(g.id!))!.requestCount).toBeGreaterThanOrEqual(2);
    const ex = await sup.c('get', '/data-exports');
    expect([ex.status, ex.body.code]).toEqual([403, 'SUPPORT_ROUTE_FORBIDDEN']);
    const sa = await sup.c('get', '/support-access');
    expect(sa.body.code).toBe('SUPPORT_ROUTE_FORBIDDEN');
    expect((await SupportAccessGrant.findByPk(g.id!))!.enteredAt).not.toBeNull();
  });

  it('T05-33 READ_WRITE: a write is audited with supportGrantId and actorRole support:READ_WRITE; writeCount 1; KYC is forbidden', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const ps = await platformAs('platform_support');
    const g = await activeGrant(s.id!, ps.user.id, 'READ_WRITE');
    const sup = await enterAsSupport(ps.cookies, g.id!);
    const w = await probeAs(sup.cookies)('patch', '/tickets/1', {});
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    await settle();
    const row = (await AuditLog.findOne({ where: { action: 'probe.write' } }))!;
    expect([row.supportGrantId, row.actorRole, row.actorUserId]).toEqual([
      g.id,
      'support:READ_WRITE',
      ps.user.id,
    ]);
    expect((await SupportAccessGrant.findByPk(g.id!))!.writeCount).toBe(1);
    const kyc = await probeAs(sup.cookies)('get', '/residents/1/kyc/1/download');
    expect(kyc.body.code).toBe('SUPPORT_ROUTE_FORBIDDEN');
    const log = await ps.c('get', `/platform/support-access/${g.id}`);
    expect(log.body.data.readLog.some((x: { action: string }) => x.action === 'probe.write')).toBe(true);
  });

  it('T05-34 after endsAt (job not run, session check stubbed) the request is 403 SUPPORT_ACCESS_EXPIRED and the grant EXPIRED', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const ps = await platformAs('platform_support');
    const g = await activeGrant(s.id!, ps.user.id, 'READ_ONLY', 15);
    const sup = await enterAsSupport(ps.cookies, g.id!);
    expect((await sup.c('get', '/society-status')).status).toBe(200);
    // the window has passed (moved in the database so the session and access token stay valid); expiry job not run
    await SupportAccessGrant.update(
      { startedAt: addMinutes(now(), -16), endsAt: addMinutes(now(), -1) },
      { where: { id: g.id! } },
    );
    await kv().cacheDel(`sag:${ps.user.id}:${s.id}`);
    setAuthPorts({ supportAccess: { isGrantActive: async () => true } });
    const r = await sup.c('get', '/society-status');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SUPPORT_ACCESS_EXPIRED');
    expect((await SupportAccessGrant.findByPk(g.id!))!).toMatchObject({
      status: 'EXPIRED',
      endReason: 'EXPIRED',
    });
  });

  it('T05-34a validateForHandoff: other user 404, pending 409, expired 403, closed society 423', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const ps = await platformAs('platform_support');
    const other = await platformAs('platform_support', 'Other Person');
    const g = await activeGrant(s.id!, ps.user.id, 'READ_ONLY', 15);
    await expect(validateForHandoff(other.user.id, g.id!)).rejects.toMatchObject({
      code: 'SUPPORT_GRANT_NOT_FOUND',
    });
    const pending = await other.c('post', '/platform/support-access', request(s.id!), { headers: idem() });
    await expect(validateForHandoff(other.user.id, pending.body.data.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    setNow(addMinutes(now(), 16));
    await expect(validateForHandoff(ps.user.id, g.id!)).rejects.toMatchObject({
      code: 'SUPPORT_ACCESS_EXPIRED',
      status: 403,
    });
    expect((await SupportAccessGrant.findByPk(g.id!))!.status).toBe('EXPIRED');
    const c = await lifecycleSociety('ACTIVE', { name: 'Soon Closed CHS' });
    const g2 = await activeGrant(c.id!, ps.user.id);
    await Society.update({ status: 'CLOSED', closedAt: now() } as never, { where: { id: c.id! } });
    await expect(validateForHandoff(ps.user.id, g2.id!)).rejects.toMatchObject({
      code: 'SOCIETY_CLOSED',
      status: 423,
    });
  });

  it('T05-34b the hand-off session carries the grant and ends no later than endsAt; a Chairman revoke kills it (next request 401)', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const chair = await memberUser(s, 'chairman');
    const ps = await platformAs('platform_support');
    const g = await activeGrant(s.id!, ps.user.id, 'READ_ONLY', 30);
    const sup = await enterAsSupport(ps.cookies, g.id!);
    const sess = (await Session.findOne({ where: { supportGrantId: g.id! } }))!;
    expect(sess.activeSocietyId).toBe(s.id);
    expect(sess.absoluteExpiresAt.getTime()).toBeLessThanOrEqual(g.endsAt!.getTime());
    const cc = as(await login(chair, { societyId: s.id! }));
    const rv = await cc('post', `/support-access/${g.id}/revoke`, { reason: 'We are done here', version: 1 });
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    expect(rv.body.data).toMatchObject({
      status: 'REVOKED',
      endReason: 'REVOKED_BY_SOCIETY',
      endNote: 'We are done here',
    });
    await settle();
    expect((await Session.findByPk(sess.id!))!.revokedAt).not.toBeNull();
    expect((await sup.c('get', '/society-status')).status).toBe(401);
  });

  it('T05-42 a hand-off session for society A cannot switch to society B', async () => {
    const a = await lifecycleSociety('ACTIVE', { name: 'A CHS' });
    const b = await lifecycleSociety('ACTIVE', { name: 'B CHS' });
    const ps = await platformAs('platform_support');
    const g = await activeGrant(a.id!, ps.user.id);
    const sup = await enterAsSupport(ps.cookies, g.id!);
    const sw = await sup.c('post', '/auth/switch-society', { societyId: b.id });
    expect(sw.status).toBeGreaterThanOrEqual(400);
    expect((await sup.c('get', '/society-status')).body.data.societyId).toBe(a.id);
  });

  it('BR-05-33 a user who lost platform.support_access.create has the grant revoked (USER_DISABLED) on the next request', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const ps = await platformAs('platform_support');
    const g = await activeGrant(s.id!, ps.user.id);
    const sup = await enterAsSupport(ps.cookies, g.id!);
    const perm = (await Permission.findOne({ where: { key: 'platform.support_access.create' } }))!;
    const role = (await Role.findOne({ where: { societyId: null, key: 'platform_support' } }))!;
    await RolePermission.destroy({ where: { roleId: role.id!, permissionId: perm.id! } });
    await flushAcl();
    setAuthPorts({ supportAccess: { isGrantActive: async () => true } });
    const r = await sup.c('get', '/society-status');
    expect(r.status).toBe(403);
    expect((await SupportAccessGrant.findByPk(g.id!))!).toMatchObject({
      status: 'REVOKED',
      endReason: 'USER_DISABLED',
    });
  });
});

describe('platform end, revoke, list and expiry jobs (8.18, 8.21, 9.1)', () => {
  it('end own grant; revoke by Super Admin needs version; list filters; expiry job and summary', async () => {
    const s = await lifecycleSociety('ACTIVE', { consent: false });
    const ps = await platformAs('platform_support');
    const sa = await platformAs('super_admin');
    const r = await ps.c('post', '/platform/support-access', request(s.id!), { headers: idem() });
    const notMine = await sa.c('post', `/platform/support-access/${r.body.data.id}/end`, {});
    expect(notMine.body.code).toBe('SUPPORT_GRANT_NOT_FOUND');
    const end = await ps.c('post', `/platform/support-access/${r.body.data.id}/end`, {});
    expect(end.body.data).toMatchObject({ status: 'ENDED', endReason: 'ENDED_BY_REQUESTER' });
    const r2 = await ps.c('post', '/platform/support-access', request(s.id!), { headers: idem() });
    const stale = await sa.c('post', `/platform/support-access/${r2.body.data.id}/revoke`, {
      reason: 'Policy check',
      version: 9,
    });
    expect(stale.body.code).toBe('STALE_VERSION');
    const rv = await sa.c('post', `/platform/support-access/${r2.body.data.id}/revoke`, {
      reason: 'Policy check',
      version: 1,
    });
    expect(rv.body.data).toMatchObject({ status: 'REVOKED', endReason: 'REVOKED_BY_PLATFORM' });
    const list = await sa.c('get', '/platform/support-access', undefined, {
      query: { status: 'ENDED,REVOKED', societyId: String(s.id) },
    });
    expect(list.body.data.map((x: { status: string }) => x.status).sort()).toEqual(['ENDED', 'REVOKED']);
    expect(
      (
        await sa.c('get', '/platform/support-access', undefined, {
          query: { from: '2026-01-01', to: '2027-12-31' },
        })
      ).status,
    ).toBe(400);
    const r3 = await ps.c('post', '/platform/support-access', request(s.id!, { durationMinutes: 15 }), {
      headers: idem(),
    });
    expect((await ps.c('get', '/platform/support-access/current')).body.data.id).toBe(r3.body.data.id);
    setNow(addMinutes(now(), 16));
    expect(await expireDue()).toBe(1);
    expect((await SupportAccessGrant.findByPk(r3.body.data.id))!.status).toBe('EXPIRED');
  });
});

describe('consent setting (8.23)', () => {
  it('GET and PATCH with step-up and version; Secretary may read but not change', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const chair = await memberUser(s, 'chairman');
    const sec = await memberUser(s, 'secretary');
    const sc = as(await login(sec, { societyId: s.id! }));
    expect((await sc('get', '/support-access/settings')).body.data).toEqual({
      requiresSupportConsent: true,
      version: 1,
    });
    expect(
      (await sc('patch', '/support-access/settings', { requiresSupportConsent: false, version: 1 })).status,
    ).toBe(403);
    const cc = as(await login(chair, { societyId: s.id! }));
    const r = await cc('patch', '/support-access/settings', { requiresSupportConsent: false, version: 1 });
    expect(r.body.data).toEqual({ requiresSupportConsent: false, version: 2 });
    expect(await AuditLog.count({ where: { action: 'societies.society.support_consent_changed' } })).toBe(1);
    expect(
      (await cc('patch', '/support-access/settings', { requiresSupportConsent: true, version: 1 })).body.code,
    ).toBe('STALE_VERSION');
  });
});

describe('T05-41 isolation', () => {
  it("a Chairman of society A gets 404 for society B's grant", async () => {
    const a = await lifecycleSociety('ACTIVE', { name: 'A CHS' });
    const b = await lifecycleSociety('ACTIVE', { name: 'B CHS' });
    const chairA = await memberUser(a, 'chairman');
    const ps = await platformAs('platform_support');
    const g = await ps.c('post', '/platform/support-access', request(b.id!), { headers: idem() });
    const c = as(await login(chairA, { societyId: a.id! }));
    for (const [m, path, body] of [
      ['get', `/support-access/${g.body.data.id}`, undefined],
      ['post', `/support-access/${g.body.data.id}/approve`, { version: 1 }],
      ['post', `/support-access/${g.body.data.id}/deny`, { reason: 'Not ours at all', version: 1 }],
      ['post', `/support-access/${g.body.data.id}/revoke`, { reason: 'Not ours at all', version: 1 }],
    ] as const) {
      const r = await c(m, path, body);
      expect(r.status, path).toBe(404);
      expect(r.body.code).toBe('SUPPORT_GRANT_NOT_FOUND');
    }
    expect((await SupportAccessGrant.findByPk(g.body.data.id))!.status).toBe('PENDING_CONSENT');
  });
});
