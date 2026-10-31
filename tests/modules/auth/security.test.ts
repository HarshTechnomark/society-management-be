import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditLog,
  AuthToken,
  Session,
  User,
  UserPasskey,
  UserRecoveryCode,
  closeDb,
} from '../../../src/models';
import { advance, nowMs, setNow } from '../../../src/lib/clock';
import { setAuthPorts } from '../../../src/modules/auth/auth.ports';
import type { MembershipView } from '../../../src/modules/auth/auth.types';
import { verifyPassword } from '../../../src/modules/auth/auth.crypto';
import {
  PASSWORD,
  cookiesFrom,
  events,
  fullSignIn,
  get,
  inboxFor,
  lastOtp,
  makeUser,
  otpSignIn,
  post,
  resetAll,
  totpNow,
  call,
  type Cookies,
  type TestUser,
} from '../../helpers/auth';

afterAll(closeDb);
beforeEach(async () => {
  await resetAll();
  setAuthPorts({ authAccess: { hasAppAccess: async () => true, userRequiresMfa: async () => false } });
  setNow('2026-11-01T04:30:00Z');
});

const member = (societyId: number, o: Partial<MembershipView> = {}): MembershipView => ({
  societyId,
  societyName: `Society ${societyId}`,
  city: 'Pune',
  societyStatus: 'ACTIVE',
  memberId: societyId * 10,
  roleKey: 'secretary',
  roleName: 'Secretary',
  roleScope: 'society',
  status: 'ACTIVE',
  ...o,
});
const withMemberships = (list: MembershipView[], requiresMfa = false) =>
  setAuthPorts({
    authAccess: {
      hasAppAccess: async () => true,
      userRequiresMfa: async () => requiresMfa,
      listMemberships: async () => list,
      getPermissions: async (_u: number, s: number) => [`perm.${s}`],
    },
    entitlements: { getFeatures: async (s: number) => [`feature.${s}`] },
  });

const as = async (
  o: Parameters<typeof makeUser>[0] = {},
  app: 'ADMIN' | 'RESIDENT' = 'ADMIN',
): Promise<{ u: TestUser; cookies: Cookies; app: 'ADMIN' | 'RESIDENT' }> => {
  const u = await makeUser(o);
  return { u, cookies: await fullSignIn(u, app), app };
};
const body = (r: { body: any }) => r.body;

describe('GET /auth/me (8.13)', () => {
  it('returns user, session and the module 03 and 04 placeholders', async () => {
    const { u, cookies } = await as({ email: 'office@skyheights.in', name: 'Neha Joshi' });
    const r = await get('/auth/me', { cookies });
    expect(r.status).toBe(200);
    const d = body(r).data;
    expect(d.user).toMatchObject({
      id: u.id,
      name: 'Neha Joshi',
      mobile: u.mobile,
      email: 'office@skyheights.in',
      emailVerified: true,
      status: 'ACTIVE',
      hasPassword: true,
      mfaEnabled: false,
      mfaMandatory: false,
      passkeyCount: 0,
      recoveryCodesRemaining: 0,
      needsProfile: false,
      deletionScheduledFor: null,
      version: 1,
    });
    expect(d.session).toMatchObject({
      clientApp: 'ADMIN',
      idleTimeoutMinutes: 30,
      stepUpMinutes: 5,
      amr: ['OTP'],
    });
    expect(d).toMatchObject({
      memberships: [],
      activeSocietyId: null,
      needsSocietyPick: false,
      platformRole: null,
      permissions: [],
      platformPermissions: [],
      features: [],
      supportGrant: null,
    });
    expect(JSON.stringify(d)).not.toMatch(/passwordHash|totpSecret/);
  });

  it('two memberships and no last society: needsSocietyPick; one membership: active society picked (BR-02-44)', async () => {
    withMemberships([member(1), member(2, { roleKey: 'chairman' })]);
    const a = await as({ mobile: '9820000001' });
    const me = (await get('/auth/me', { cookies: a.cookies })).body.data;
    expect(me.needsSocietyPick).toBe(true);
    expect(me.activeSocietyId).toBeNull();
    expect(me.memberships).toHaveLength(2);

    withMemberships([member(7)]);
    const b = await as({ mobile: '9820000002' });
    const me2 = (await get('/auth/me', { cookies: b.cookies })).body.data;
    expect(me2.activeSocietyId).toBe(7);
    expect(me2.needsSocietyPick).toBe(false);
    expect(me2.permissions).toEqual(['perm.7']);
    expect(me2.features).toEqual(['feature.7']);
  });

  it('memberships are filtered to roles that fit the app', async () => {
    withMemberships([member(1), member(2, { roleScope: 'gate', roleKey: 'guard' })]);
    const a = await as({ mobile: '9820000001' });
    expect(
      (await get('/auth/me', { cookies: a.cookies })).body.data.memberships.map(
        (m: MembershipView) => m.societyId,
      ),
    ).toEqual([1]);
  });

  it('bumps lastSeenAt even inside the 60 second window ("Stay signed in")', async () => {
    const { cookies } = await as();
    advance(10_000);
    await get('/auth/me', { cookies });
    expect((await Session.findOne())!.lastSeenAt.getTime()).toBe(nowMs());
  });
});

describe('PATCH /auth/me (8.14)', () => {
  it('T02-36 a stale version is STALE_VERSION; a good one updates, bumps the version and audits before and after', async () => {
    const { u, cookies } = await as({ name: 'Old Name' });
    const stale = await call('patch', '/auth/me', { version: 5, name: 'New Name' }, { cookies });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    const ok = await call(
      'patch',
      '/auth/me',
      { version: 1, name: '  Meera   Iyer ', locale: 'hi-IN' },
      { cookies },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ name: 'Meera Iyer', locale: 'hi-IN', version: 2 });
    const a = await AuditLog.findOne({ where: { action: 'auth.user.updated', entityId: String(u.id) } });
    expect(a?.before).toEqual({ name: 'Old Name', locale: 'en-IN' });
    expect(a?.after).toEqual({ name: 'Meera Iyer', locale: 'hi-IN' });
    expect(events.some(e => e.event === 'auth.profile.updated' && e.payload.version === 2)).toBe(true);
    expect((await call('patch', '/auth/me', { version: 1, name: 'Again Name' }, { cookies })).body.code).toBe(
      'STALE_VERSION',
    );
  });

  it('validation: needs at least one field, valid name and locale, no unknown keys; a new resident can complete the profile', async () => {
    const { cookies } = await as();
    expect((await call('patch', '/auth/me', { version: 1 }, { cookies })).status).toBe(400);
    expect((await call('patch', '/auth/me', { version: 1, name: 'R2' }, { cookies })).status).toBe(400);
    expect((await call('patch', '/auth/me', { version: 1, locale: 'fr-FR' }, { cookies })).status).toBe(400);
    expect(
      (await call('patch', '/auth/me', { version: 1, name: 'Ok Name', role: 'admin' }, { cookies })).status,
    ).toBe(400);
    const { res, cookies: rc } = await otpSignIn('9123456789', { app: 'RESIDENT' });
    expect(res.body.data.me.user.needsProfile).toBe(true);
    const p = await call(
      'patch',
      '/auth/me',
      { version: 1, name: 'New Resident' },
      { app: 'RESIDENT', cookies: rc },
    );
    expect(p.body.data.needsProfile).toBe(false);
  });

  it('a photo cannot be linked until the files service exists (FILE_NOT_LINKABLE); null needs no file', async () => {
    const { cookies } = await as();
    const r = await call('patch', '/auth/me', { version: 1, photoFileId: 5 }, { cookies });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('FILE_NOT_LINKABLE');
    expect((await call('patch', '/auth/me', { version: 1, photoFileId: null }, { cookies })).status).toBe(
      200,
    );
  });
});

describe('POST /auth/switch-society (8.15)', () => {
  it('switches, stores the last society, audits with societyId and then lists the new permissions', async () => {
    withMemberships([member(1), member(2, { roleKey: 'chairman' })]);
    const { u, cookies } = await as();
    const r = await post('/auth/switch-society', { societyId: 2 }, { cookies });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.activeSocietyId).toBe(2);
    expect(r.body.data.permissions).toEqual(['perm.2']);
    expect((await User.findByPk(u.id))?.lastSocietyId).toBe(2);
    expect((await Session.findOne())!.activeSocietyId).toBe(2);
    const a = await AuditLog.findOne({ where: { action: 'auth.session.society_switched' } });
    expect(a?.societyId).toBe(2);
    // the next sign-in lands on the last society
    const again = await fullSignIn(u);
    expect((await get('/auth/me', { cookies: again })).body.data.activeSocietyId).toBe(2);
  });

  it('T02-23 a society without a membership is SOCIETY_NOT_FOUND and the active society is unchanged', async () => {
    withMemberships([member(1), member(2)]);
    const { cookies } = await as();
    await post('/auth/switch-society', { societyId: 1 }, { cookies });
    const r = await post('/auth/switch-society', { societyId: 3 }, { cookies });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('SOCIETY_NOT_FOUND');
    expect((await Session.findOne())!.activeSocietyId).toBe(1);
  });

  it('a suspended membership or a role that does not fit the app is MEMBERSHIP_NOT_ACTIVE', async () => {
    withMemberships([member(1), member(2, { status: 'SUSPENDED' }), member(3, { roleScope: 'gate' })]);
    const { cookies } = await as();
    expect((await post('/auth/switch-society', { societyId: 2 }, { cookies })).body.code).toBe(
      'MEMBERSHIP_NOT_ACTIVE',
    );
    expect((await post('/auth/switch-society', { societyId: 3 }, { cookies })).body.code).toBe(
      'MEMBERSHIP_NOT_ACTIVE',
    );
  });

  it('a role that requires MFA for a user without MFA is MFA_ENROLLMENT_REQUIRED', async () => {
    withMemberships([member(1), member(2)]);
    const { cookies } = await as();
    withMemberships([member(1), member(2)], true);
    const r = await post('/auth/switch-society', { societyId: 2 }, { cookies });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('MFA_ENROLLMENT_REQUIRED');
  });

  it('is refused on the platform app', async () => {
    setAuthPorts();
    const u = await makeUser({ email: 'super@societyapp.in', platformRoleId: 1, mfa: true });
    const cookies = await (async () => {
      const r = await post(
        '/auth/password/login',
        { email: u.email, password: PASSWORD },
        { app: 'PLATFORM' },
      );
      const v = await post(
        '/auth/mfa/verify',
        { challengeToken: r.body.data.challengeToken, method: 'TOTP', code: totpNow(u.totpSecret!) },
        { app: 'PLATFORM' },
      );
      return cookiesFrom(v);
    })();
    const r = await post('/auth/switch-society', { societyId: 1 }, { app: 'PLATFORM', cookies });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('LOGIN_METHOD_NOT_ALLOWED');
    const me = await get('/auth/me', { app: 'PLATFORM', cookies });
    expect(me.body.data.session.idleTimeoutMinutes).toBe(30);
    expect(me.body.data.platformRole).toEqual({ id: 1 });
    expect(me.body.data.session.amr).toEqual(['PASSWORD', 'TOTP']);
  });

  it('T02-27 a suspended society does not block sign-in, switch or password change (no 402 or 423)', async () => {
    withMemberships([
      member(1, { societyStatus: 'SUSPENDED', roleKey: 'chairman' }),
      member(2, { societyStatus: 'SUSPENDED' }),
    ]);
    const { cookies } = await as();
    const sw = await post('/auth/switch-society', { societyId: 2 }, { cookies });
    expect(sw.status).toBe(200);
    const pw = await post(
      '/me/security/password',
      { currentPassword: PASSWORD, newPassword: 'Brand@NewPass2026' },
      { cookies },
    );
    expect(pw.status).toBe(200);
  });
});

describe('step-up (8.16, BR-02-40)', () => {
  it('T02-17 authTime 6 minutes old on POST /me/security/password is REAUTH_REQUIRED; after reauth with TOTP it succeeds', async () => {
    const { u, cookies } = await as({ mfa: true });
    advance(6 * 60_000);
    const fresh = cookiesFrom(await post('/auth/refresh', {}, { cookies }), cookies);
    const attempt = { currentPassword: PASSWORD, newPassword: 'Brand@NewPass2026' };
    const denied = await post('/me/security/password', attempt, { cookies: fresh });
    expect(denied.status).toBe(401);
    expect(denied.body.code).toBe('REAUTH_REQUIRED');
    const bad = await post('/auth/reauth', { method: 'TOTP', code: '000000' }, { cookies: fresh });
    expect(bad.body.code).toBe('TOTP_INVALID');
    const ok = await post(
      '/auth/reauth',
      { method: 'TOTP', code: totpNow(u.totpSecret!) },
      { cookies: fresh },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.authTime).toBe(new Date(nowMs()).toISOString());
    expect((await Session.findOne())!.amr).toEqual(['OTP', 'TOTP']);
    expect(await AuditLog.count({ where: { action: 'auth.session.reauthenticated' } })).toBe(1);
    const retried = await post('/me/security/password', attempt, { cookies: fresh });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
  });

  it('a step-up TOTP code that was already used is TOTP_REUSED', async () => {
    const { u, cookies } = await as({ mfa: true });
    advance(6 * 60_000);
    const code = totpNow(u.totpSecret!);
    expect(
      (
        await post(
          '/auth/reauth',
          { method: 'TOTP', code },
          { cookies: cookiesFrom(await post('/auth/refresh', {}, { cookies }), cookies) },
        )
      ).status,
    ).toBe(200);
    const again = await post('/auth/reauth', { method: 'TOTP', code }, { cookies });
    expect(again.body.code).toBe('TOTP_REUSED');
  });

  it('users without MFA step up with an OTP to their own number; a user with MFA may not use OTP', async () => {
    const { u, cookies } = await as();
    advance(6 * 60_000);
    const c2 = cookiesFrom(await post('/auth/refresh', {}, { cookies }), cookies);
    expect((await post('/me/security/totp/setup', {}, { cookies: c2 })).body.code).toBe('REAUTH_REQUIRED');
    const send = await post('/auth/reauth/otp', {}, { cookies: c2 });
    expect(send.status).toBe(202);
    expect(send.body.data.maskedMobile).toBe(`${u.mobile.slice(0, 2)}XXXXX${u.mobile.slice(-3)}`);
    const code = await lastOtp(u.mobile);
    const bad = await post(
      '/auth/reauth',
      {
        method: 'OTP',
        code: code === '000000' ? '111111' : '000000',
        challengeId: send.body.data.challengeId,
      },
      { cookies: c2 },
    );
    expect(bad.body.code).toBe('OTP_INVALID');
    const ok = await post(
      '/auth/reauth',
      { method: 'OTP', code, challengeId: send.body.data.challengeId },
      { cookies: c2 },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await post('/me/security/totp/setup', {}, { cookies: c2 })).status).toBe(200);

    const m = await as({ mfa: true, mobile: '9820000077' });
    expect((await post('/auth/reauth/otp', {}, { cookies: m.cookies })).body.code).toBe(
      'LOGIN_METHOD_NOT_ALLOWED',
    );
    expect(
      (
        await post(
          '/auth/reauth',
          { method: 'OTP', code: '123456', challengeId: send.body.data.challengeId },
          { cookies: m.cookies },
        )
      ).body.code,
    ).toBe('LOGIN_METHOD_NOT_ALLOWED');
    expect((await post('/auth/reauth', { method: 'TOTP', code: '123456' }, { cookies: c2 })).body.code).toBe(
      'LOGIN_METHOD_NOT_ALLOWED',
    );
    expect((await post('/auth/reauth/passkey-options', {}, { cookies: m.cookies })).body.code).toBe(
      'PASSKEY_NOT_FOUND',
    );
  });

  it('a step-up OTP challenge of another session cannot be used', async () => {
    const a = await as({ mobile: '9820000001' });
    const b = await as({ mobile: '9820000002' });
    const send = await post('/auth/reauth/otp', {}, { cookies: a.cookies });
    const code = await lastOtp('9820000001');
    const r = await post(
      '/auth/reauth',
      { method: 'OTP', code, challengeId: send.body.data.challengeId },
      { cookies: b.cookies },
    );
    expect(r.body.code).toBe('OTP_EXPIRED');
  });

  it('validation of the reauth body', async () => {
    const { cookies } = await as();
    expect((await post('/auth/reauth', { method: 'TOTP' }, { cookies })).status).toBe(400);
    expect((await post('/auth/reauth', { method: 'OTP', code: '123456' }, { cookies })).status).toBe(400);
    expect((await post('/auth/reauth', { method: 'PASSKEY' }, { cookies })).status).toBe(400);
  });
});

describe('GET /me/security and sessions (8.22, 8.27)', () => {
  it('overview', async () => {
    const { cookies } = await as({ mfa: true, email: 'treasurer@skyheights.in' });
    const d = (await get('/me/security', { cookies })).body.data;
    expect(d).toMatchObject({
      email: 'treasurer@skyheights.in',
      emailVerified: true,
      hasPassword: true,
      mfaEnabled: true,
      recoveryCodesRemaining: 3,
      passkeys: [],
      activeSessions: 1,
      deletionScheduledFor: null,
    });
    expect(d.passwordChangedAt).toBe('2026-11-01T04:30:00.000Z');
  });

  it('lists sessions with pagination and marks the current one; T02-22 revoking another user session is 404', async () => {
    const a = await as({ mobile: '9820000001' });
    const b = await as({ mobile: '9820000002' });
    await fullSignIn(a.u);
    await fullSignIn(a.u);
    const r = await get('/me/security/sessions', { cookies: a.cookies, query: { limit: '2', page: '1' } });
    expect(r.body.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(r.body.data).toHaveLength(2);
    expect(r.body.data[0]).toMatchObject({
      clientApp: 'ADMIN',
      deviceLabel: 'Chrome on Android',
      revokedAt: null,
      revokeReason: null,
    });
    const all = await get('/me/security/sessions', { cookies: a.cookies });
    expect(all.body.data.filter((s: { isCurrent: boolean }) => s.isCurrent)).toHaveLength(1);
    const bSession = (await Session.findOne({ where: { userId: b.u.id } }))!;
    const denied = await call('delete', `/me/security/sessions/${bSession.id}`, undefined, {
      cookies: a.cookies,
    });
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe('SESSION_NOT_FOUND');
    expect((await Session.findByPk(bSession.id))!.revokedAt).toBeNull();
    expect(
      (await get('/me/security/sessions', { cookies: a.cookies, query: { sortBy: 'password' } })).status,
    ).toBe(400);
  });

  it('revoke one (not the current): audit, realtime, the revoked session is out at once; current is CANNOT_REVOKE_CURRENT_SESSION', async () => {
    const a = await as({ mobile: '9820000001' });
    const second = await fullSignIn(a.u);
    const secondId = Number(second.sa_refresh.split('.')[0]);
    const currentId = Number(a.cookies.sa_refresh.split('.')[0]);
    expect(
      (await call('delete', `/me/security/sessions/${currentId}`, undefined, { cookies: a.cookies })).body
        .code,
    ).toBe('CANNOT_REVOKE_CURRENT_SESSION');
    const ok = await call('delete', `/me/security/sessions/${secondId}`, undefined, { cookies: a.cookies });
    expect(ok.status).toBe(200);
    expect((await Session.findByPk(secondId))!.revokeReason).toBe('USER_REVOKED');
    expect(events.find(e => e.event === 'auth.session.revoked')?.payload).toEqual({
      sessionId: secondId,
      reason: 'USER_REVOKED',
    });
    expect((await get('/auth/me', { cookies: second })).body.code).toBe('SESSION_REVOKED');
    expect(
      (await call('delete', `/me/security/sessions/${secondId}`, undefined, { cookies: a.cookies })).body
        .code,
    ).toBe('SESSION_NOT_FOUND');
    const hidden = await get('/me/security/sessions', { cookies: a.cookies });
    expect(hidden.body.data).toHaveLength(1);
    const withRevoked = await get('/me/security/sessions', { cookies: a.cookies, query: { status: 'all' } });
    expect(withRevoked.body.data).toHaveLength(2);
  });

  it('revoke-others signs out every other session in every app', async () => {
    const a = await as({ mobile: '9820000001' });
    const other = await fullSignIn(a.u);
    const resident = await fullSignIn(a.u, 'RESIDENT');
    const r = await post('/me/security/sessions/revoke-others', {}, { cookies: a.cookies });
    expect(r.body.data).toEqual({ revoked: 2 });
    expect((await get('/auth/me', { cookies: other })).body.code).toBe('SESSION_REVOKED');
    expect((await get('/auth/me', { cookies: resident, app: 'RESIDENT' })).body.code).toBe('SESSION_REVOKED');
    expect((await get('/auth/me', { cookies: a.cookies })).status).toBe(200);
    expect(await AuditLog.count({ where: { action: 'auth.session.revoked_all' } })).toBe(1);
  });

  it('a new device (new sa_device) signing in later triggers the new-device alert (BR-02-45)', async () => {
    const a = await as({ mobile: '9820000001' });
    await vi.waitFor(async () =>
      expect((await inboxFor(a.u.mobile)).filter(m => /New SocietyApp sign-in/.test(m.body))).toHaveLength(0),
    );
    await fullSignIn(a.u); // no sa_device cookie sent: a new device
    await vi.waitFor(async () =>
      expect(
        (await inboxFor(a.u.mobile)).filter(m => /New SocietyApp sign-in on Chrome on Android/.test(m.body)),
      ).toHaveLength(1),
    );
    // the same device again: no alert
    const r = await otpSignIn(a.u.mobile, { cookies: { sa_device: a.cookies.sa_device }, ip: '10.1.2.3' });
    expect(r.res.body.data.status).toBe('SIGNED_IN');
    await new Promise(res => setTimeout(res, 100));
    expect((await inboxFor(a.u.mobile)).filter(m => /New SocietyApp sign-in/.test(m.body))).toHaveLength(1);
  });
});

describe('password change (8.23)', () => {
  it('sets a password for a user without one, changes it with the current one and revokes other sessions', async () => {
    const { u, cookies } = await as({ password: null, email: 'a@x.in' });
    expect((await get('/me/security', { cookies })).body.data.hasPassword).toBe(false);
    const set = await post('/me/security/password', { newPassword: 'First@Password2026' }, { cookies });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(await AuditLog.count({ where: { action: 'auth.password.set' } })).toBe(1);
    const other = await fullSignIn(u);
    const c = await post(
      '/me/security/password',
      { currentPassword: 'First@Password2026', newPassword: 'Second@Password2026' },
      { cookies },
    );
    expect(c.body.data).toEqual({ otherSessionsRevoked: 1 });
    expect(await AuditLog.count({ where: { action: 'auth.password.changed' } })).toBe(1);
    expect((await get('/auth/me', { cookies: other })).body.code).toBe('SESSION_REVOKED');
    expect(await Session.findOne({ where: { revokeReason: 'PASSWORD_CHANGED' } })).not.toBeNull();
    const row = await User.scope('withSecrets').findByPk(u.id);
    expect(await verifyPassword(row!.passwordHash!, 'Second@Password2026')).toBe(true);
    await vi.waitFor(async () =>
      expect((await inboxFor('a@x.in')).some(m => m.subject === 'Your SocietyApp password was changed')).toBe(
        true,
      ),
    );
  });

  it('wrong current password, same password and policy failures', async () => {
    const { cookies } = await as({ email: 'chairman@skyheights.in' });
    const wrong = await post(
      '/me/security/password',
      { currentPassword: 'Nope@Nope12345', newPassword: 'Brand@NewPass2026' },
      { cookies },
    );
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('CURRENT_PASSWORD_INCORRECT');
    const same = await post(
      '/me/security/password',
      { currentPassword: PASSWORD, newPassword: PASSWORD },
      { cookies },
    );
    expect(same.body.code).toBe('PASSWORD_SAME_AS_CURRENT');
    const policy = await post(
      '/me/security/password',
      { currentPassword: PASSWORD, newPassword: 'Chairman@12345678' },
      { cookies },
    );
    expect(policy.body.code).toBe('PASSWORD_POLICY_FAILED');
    expect(policy.body.errors).toEqual([{ field: 'password', message: 'email' }]);
    const missing = await post('/me/security/password', { newPassword: 'Brand@NewPass2026' }, { cookies });
    expect(missing.status).toBe(400);
  });

  it('wrong current passwords count toward the password lock (10 then ACCOUNT_LOCKED)', async () => {
    const { cookies } = await as({ email: 'a@x.in' });
    for (let i = 0; i < 10; i++) {
      const r = await post(
        '/me/security/password',
        { currentPassword: 'Nope@Nope12345', newPassword: 'Brand@NewPass2026' },
        { cookies },
      );
      expect(r.status).toBe(422);
    }
    const r = await post(
      '/me/security/password',
      { currentPassword: PASSWORD, newPassword: 'Brand@NewPass2026' },
      { cookies },
    );
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('ACCOUNT_LOCKED');
  });
});

describe('TOTP, recovery codes (8.24, 8.25)', () => {
  it('setup, confirm (codes shown once, session marked mfaVerified), regenerate, turn off', async () => {
    const { u, cookies } = await as({ email: 'a@x.in' });
    expect((await post('/me/security/totp/confirm', { code: '123456' }, { cookies })).body.code).toBe(
      'MFA_SETUP_NOT_STARTED',
    );
    const setup = await post('/me/security/totp/setup', {}, { cookies });
    expect(setup.status).toBe(200);
    const secret = setup.body.data.secret.replace(/ /g, '');
    expect((await post('/me/security/totp/confirm', { code: '000000' }, { cookies })).body.code).toBe(
      'TOTP_INVALID',
    );
    const confirm = await post('/me/security/totp/confirm', { code: totpNow(secret) }, { cookies });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
    expect(confirm.body.data.recoveryCodes).toHaveLength(10);
    expect((await Session.findOne())!.mfaVerified).toBe(true);
    expect((await User.findByPk(u.id))!.mfaEnabledAt).not.toBeNull();
    expect((await post('/me/security/totp/setup', {}, { cookies })).body.code).toBe('MFA_ALREADY_ENABLED');
    expect(
      (await post('/me/security/totp/confirm', { code: totpNow(secret, 1) }, { cookies })).body.code,
    ).toBe('MFA_ALREADY_ENABLED');

    const regen = await post('/me/security/recovery-codes', {}, { cookies });
    expect(regen.status).toBe(201);
    expect(regen.body.data.recoveryCodes).toHaveLength(10);
    expect(regen.body.data.recoveryCodes).not.toEqual(confirm.body.data.recoveryCodes);
    expect(await UserRecoveryCode.count({ where: { userId: u.id } })).toBe(10); // the old batch is gone
    expect((await get('/me/security', { cookies })).body.data.recoveryCodesRemaining).toBe(10);

    const off = await call('delete', '/me/security/totp', undefined, { cookies });
    expect(off.status).toBe(200);
    const after = (await User.scope('withSecrets').findByPk(u.id))!;
    expect(after.mfaEnabledAt).toBeNull();
    expect(after.totpSecretEnc).toBeNull();
    expect(await UserRecoveryCode.count({ where: { userId: u.id } })).toBe(0);
    expect((await call('delete', '/me/security/totp', undefined, { cookies })).body.code).toBe(
      'MFA_NOT_ENABLED',
    );
    expect((await post('/me/security/recovery-codes', {}, { cookies })).body.code).toBe('MFA_NOT_ENABLED');
    for (const a of ['auth.mfa.enabled', 'auth.mfa.disabled', 'auth.recovery_codes.generated'])
      expect(await AuditLog.count({ where: { action: a } })).toBeGreaterThan(0);
  });

  it('T02-31 DELETE /me/security/totp for a user whose role requires MFA is MFA_MANDATORY', async () => {
    setAuthPorts({ authAccess: { hasAppAccess: async () => true, userRequiresMfa: async () => true } });
    const { cookies } = await as({ mfa: true });
    const r = await call('delete', '/me/security/totp', undefined, { cookies });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('MFA_MANDATORY');
  });

  it('turning MFA off, setup and recovery regeneration need a fresh authentication', async () => {
    const { cookies } = await as({ mfa: true });
    advance(6 * 60_000);
    const c = cookiesFrom(await post('/auth/refresh', {}, { cookies }), cookies);
    expect((await call('delete', '/me/security/totp', undefined, { cookies: c })).body.code).toBe(
      'REAUTH_REQUIRED',
    );
    expect((await post('/me/security/recovery-codes', {}, { cookies: c })).body.code).toBe('REAUTH_REQUIRED');
    expect((await post('/me/security/email', { newEmail: 'n@x.in' }, { cookies: c })).body.code).toBe(
      'REAUTH_REQUIRED',
    );
    expect(
      (await post('/me/security/mobile/start', { newMobile: '9111111111' }, { cookies: c })).body.code,
    ).toBe('REAUTH_REQUIRED');
    expect(
      (await post('/me/security/deletion-request', { confirmText: 'DELETE' }, { cookies: c })).body.code,
    ).toBe('REAUTH_REQUIRED');
    expect((await post('/me/security/passkeys/options', {}, { cookies: c })).body.code).toBe(
      'REAUTH_REQUIRED',
    );
  });
});

describe('mobile and email change (8.28, 8.21)', () => {
  it('mobile change: OTP to the new number, other sessions revoked, SMS to the old number, hook called', async () => {
    const hook = vi.fn(async () => {});
    setAuthPorts({ residentsHooks: { onUserMobileChanged: hook } });
    const { u, cookies } = await as({ mobile: '9820000001' });
    const other = await fullSignIn(u);
    const start = await post('/me/security/mobile/start', { newMobile: '+91 98200 00099' }, { cookies });
    expect(start.status, JSON.stringify(start.body)).toBe(202);
    expect(start.body.data.maskedMobile).toBe('98XXXXX099');
    const code = await lastOtp('9820000099');
    expect(
      (
        await post(
          '/me/security/mobile/confirm',
          { challengeId: start.body.data.challengeId, code: '000000' },
          { cookies },
        )
      ).body.code,
    ).toBe('OTP_INVALID');
    const ok = await post(
      '/me/security/mobile/confirm',
      { challengeId: start.body.data.challengeId, code },
      { cookies },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.mobile).toBe('9820000099');
    expect(ok.body.data.version).toBe(2);
    expect(hook).toHaveBeenCalledWith(u.id, '9820000001', '9820000099', expect.anything());
    expect((await get('/auth/me', { cookies: other })).body.code).toBe('SESSION_REVOKED');
    expect(await Session.findOne({ where: { revokeReason: 'MOBILE_CHANGED' } })).not.toBeNull();
    const a = await AuditLog.findOne({ where: { action: 'auth.user.mobile_changed' } });
    expect(a?.before).toEqual({ mobile: '98XXXXX001' });
    expect(a?.after).toEqual({ mobile: '98XXXXX099' });
    await vi.waitFor(async () =>
      expect((await inboxFor('9820000001')).some(m => /mobile number was changed/.test(m.body))).toBe(true),
    );
  });

  it('T02-37 a number used by another user is MOBILE_IN_USE; the same number is MOBILE_UNCHANGED', async () => {
    const other = await makeUser({ mobile: '9820000002' });
    const { cookies } = await as({ mobile: '9820000001' });
    const used = await post('/me/security/mobile/start', { newMobile: other.mobile }, { cookies });
    expect(used.status).toBe(409);
    expect(used.body.code).toBe('MOBILE_IN_USE');
    const same = await post('/me/security/mobile/start', { newMobile: '9820000001' }, { cookies });
    expect(same.status).toBe(422);
    expect(same.body.code).toBe('MOBILE_UNCHANGED');
  });

  it('a number taken between start and confirm is MOBILE_IN_USE at confirm', async () => {
    const { cookies } = await as({ mobile: '9820000001' });
    const start = await post('/me/security/mobile/start', { newMobile: '9820000099' }, { cookies });
    const code = await lastOtp('9820000099');
    await makeUser({ mobile: '9820000099' });
    const r = await post(
      '/me/security/mobile/confirm',
      { challengeId: start.body.data.challengeId, code },
      { cookies },
    );
    expect(r.body.code).toBe('MOBILE_IN_USE');
  });

  it('email change: link to the new address, confirm sets email and notifies the old one; EMAIL_IN_USE and EMAIL_UNCHANGED', async () => {
    await makeUser({ email: 'taken@x.in' });
    const { u, cookies } = await as({ email: 'old@x.in' });
    expect((await post('/me/security/email', { newEmail: 'OLD@x.in' }, { cookies })).body.code).toBe(
      'EMAIL_UNCHANGED',
    );
    expect((await post('/me/security/email', { newEmail: 'taken@x.in' }, { cookies })).body.code).toBe(
      'EMAIL_IN_USE',
    );
    const r = await post('/me/security/email', { newEmail: 'New@X.in' }, { cookies });
    expect(r.status).toBe(202);
    const link = (await inboxFor('new@x.in'))[0].link!;
    expect(link).toMatch(/^https:\/\/admin\.societyapp\.in\/verify-email\?token=[A-Za-z0-9_-]{43}$/);
    expect((await User.findByPk(u.id))!.email).toBe('old@x.in'); // not changed yet
    const token = new URL(link).searchParams.get('token')!;
    const ok = await post('/auth/email/verify', { token }, { app: 'ADMIN' });
    expect(ok.body.data).toEqual({ email: 'new@x.in' });
    expect((await User.findByPk(u.id))!.email).toBe('new@x.in');
    await vi.waitFor(async () =>
      expect((await inboxFor('old@x.in')).some(m => m.subject === 'Your SocietyApp email was changed')).toBe(
        true,
      ),
    );
    expect(await AuditLog.count({ where: { action: 'auth.user.email_changed' } })).toBe(1);
    expect((await post('/auth/email/verify', { token }, { app: 'ADMIN' })).body.code).toBe('LINK_USED');
  });

  it('an email link goes invalid if someone else takes the address first (EMAIL_IN_USE)', async () => {
    const { cookies } = await as({ email: 'old@x.in' });
    await post('/me/security/email', { newEmail: 'race@x.in' }, { cookies });
    const token = new URL((await inboxFor('race@x.in'))[0].link!).searchParams.get('token')!;
    await makeUser({ email: 'race@x.in' });
    const r = await post('/auth/email/verify', { token }, { app: 'ADMIN' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('EMAIL_IN_USE');
    expect(
      await AuthToken.count({ where: { purpose: 'EMAIL_VERIFY', consumedAt: null as never } }),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('account deletion (8.29)', () => {
  it('T02-32 cancel when nothing is pending; request twice', async () => {
    const { cookies } = await as({ email: 'a@x.in' });
    expect((await call('delete', '/me/security/deletion-request', undefined, { cookies })).body.code).toBe(
      'DELETION_NOT_REQUESTED',
    );
    expect((await post('/me/security/deletion-request', { confirmText: 'delete' }, { cookies })).status).toBe(
      400,
    );
    const r = await post(
      '/me/security/deletion-request',
      { confirmText: 'DELETE', reason: 'Moving away' },
      { cookies },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.deletionScheduledFor).toBe('2026-12-01T04:30:00.000Z');
    expect(
      (await post('/me/security/deletion-request', { confirmText: 'DELETE' }, { cookies })).body.code,
    ).toBe('DELETION_ALREADY_REQUESTED');
    const me = await get('/auth/me', { cookies });
    expect(me.body.data.user).toMatchObject({
      status: 'PENDING_DELETION',
      deletionScheduledFor: '2026-12-01T04:30:00.000Z',
    });
    const a = await AuditLog.findOne({ where: { action: 'auth.account.deletion_requested' } });
    expect(a?.reason).toBe('Moving away');
    await vi.waitFor(async () =>
      expect((await inboxFor('a@x.in')).some(m => m.subject === 'Account deletion requested')).toBe(true),
    );
    const cancel = await call('delete', '/me/security/deletion-request', undefined, { cookies });
    expect(cancel.status).toBe(200);
    const after = (await get('/auth/me', { cookies })).body.data.user;
    expect(after).toMatchObject({ status: 'ACTIVE', deletionScheduledFor: null });
    expect(await AuditLog.count({ where: { action: 'auth.account.deletion_cancelled' } })).toBe(1);
  });

  it('other sessions are signed out; blockers refuse with one errors[] item per reason', async () => {
    const a = await as({ mobile: '9820000001' });
    const other = await fullSignIn(a.u);
    setAuthPorts({
      authAccess: { deletionBlockers: async () => ['PLATFORM_USER', 'COMMITTEE_ROLE:Sky Heights CHS'] },
    });
    const blocked = await post(
      '/me/security/deletion-request',
      { confirmText: 'DELETE' },
      { cookies: a.cookies },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('ACCOUNT_DELETION_BLOCKED');
    expect(blocked.body.errors.map((e: { message: string }) => e.message)).toEqual([
      'PLATFORM_USER',
      'COMMITTEE_ROLE:Sky Heights CHS',
    ]);
    expect((await User.findByPk(a.u.id))!.status).toBe('ACTIVE');
    setAuthPorts({ authAccess: { deletionBlockers: async () => [] } });
    expect(
      (await post('/me/security/deletion-request', { confirmText: 'DELETE' }, { cookies: a.cookies })).status,
    ).toBe(200);
    expect((await get('/auth/me', { cookies: other })).body.code).toBe('SESSION_REVOKED');
    expect(await Session.findOne({ where: { revokeReason: 'DELETION_REQUESTED' } })).not.toBeNull();
  });
});

describe('isolation of passkeys (T02-24)', () => {
  it('user A cannot rename, delete or list user B passkey', async () => {
    const a = await as({ mobile: '9820000001' });
    const b = await makeUser({ mobile: '9820000002' });
    const pk = await UserPasskey.create({
      userId: b.id,
      credentialId: 'cred-b',
      publicKey: Buffer.from('k'),
      signCount: 0,
      transports: null,
      aaguid: null,
      deviceType: 'MULTI_DEVICE',
      isBackedUp: true,
      name: 'B phone',
      lastUsedAt: null,
    });
    const del = await call('delete', `/me/security/passkeys/${pk.id}`, undefined, { cookies: a.cookies });
    expect(del.status).toBe(404);
    expect(del.body.code).toBe('PASSKEY_NOT_FOUND');
    expect(
      (await call('patch', `/me/security/passkeys/${pk.id}`, { name: 'x' }, { cookies: a.cookies })).body
        .code,
    ).toBe('PASSKEY_NOT_FOUND');
    expect((await get('/me/security/passkeys', { cookies: a.cookies })).body.data).toEqual([]);
    expect(await UserPasskey.count({ where: { id: pk.id } })).toBe(1);
  });
});
