import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditLog,
  AuthLockout,
  AuthOtp,
  AuthToken,
  Session,
  User,
  UserPasskey,
  UserRecoveryCode,
  closeDb,
  sequelize,
} from '../../../src/models';
import { advance, nowMs, setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../../src/utils/errors';
import { auth, sessions, users } from '../../../src/modules/auth/auth.public';
import { setAuthPorts } from '../../../src/modules/auth/auth.ports';
import {
  cleanup,
  deletionReminders,
  expireIdleSessions,
  processAccountDeletions,
  registerAuthJobs,
} from '../../../src/modules/auth/auth.jobs';
import { systemCtx } from '../../../src/types/context';
import { seedSystemUser } from '../../../seeders/system-user';
import { DEMO_USERS, DEMO_PASSWORD, demoTotpSecret, seedDemoUsers } from '../../../seeders/demo-users';
import {
  PASSWORD,
  cookiesFrom,
  events,
  get,
  inboxFor,
  makeUser,
  otpSignIn,
  post,
  resetAll,
  totpNow,
  fullSignIn,
  type Cookies,
} from '../../helpers/auth';

afterAll(closeDb);
registerAuthJobs();
beforeEach(async () => {
  await resetAll();
  setAuthPorts({ authAccess: { hasAppAccess: async () => true } });
  setNow('2026-11-01T04:30:00Z');
});

const ctx = systemCtx('test');
const tx = <T>(fn: (t: import('sequelize').Transaction) => Promise<T>) => sequelize.transaction(fn);
const errorOf = async (p: Promise<unknown>): Promise<AppError> => {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected an error');
};
const fakeRes = () => ({ cookie: vi.fn() });
const mkSession = async (userId: number, o: Record<string, unknown> = {}) => {
  const t = new Date(nowMs());
  return Session.create({
    userId,
    clientApp: 'ADMIN',
    activeSocietyId: 1,
    refreshTokenHash: Math.random().toString(16).slice(2).padEnd(64, '0'),
    amr: ['OTP'],
    mfaVerified: false,
    authTime: t,
    lastSeenAt: t,
    idleTimeoutMinutes: 30,
    absoluteExpiresAt: new Date(nowMs() + 12 * 3_600_000),
    deviceLabel: 'Test',
    ...o,
  } as never);
};

describe('users service (8.30)', () => {
  it('T02-33 enableUser on an ACTIVE user and disableUser on a DELETED user are INVALID_STATE', async () => {
    const active = await makeUser();
    const deleted = await makeUser({ status: 'DELETED' });
    expect((await errorOf(tx(t => users.enableUser(ctx, active.id, 'x', t)))).code).toBe('INVALID_STATE');
    expect((await errorOf(tx(t => users.disableUser(ctx, deleted.id, 'x', t)))).code).toBe('INVALID_STATE');
  });

  it('disableUser revokes every session (USER_DISABLED), audits with the reason; enableUser restores', async () => {
    const u = await makeUser();
    await mkSession(u.id);
    await mkSession(u.id, { clientApp: 'RESIDENT', activeSocietyId: null });
    await tx(t =>
      users.disableUser(
        {
          ...ctx,
          user: { id: 99, name: 'Admin', mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' },
        },
        u.id,
        'left the society',
        t,
      ),
    );
    const rows = await Session.findAll({ where: { userId: u.id } });
    expect(rows.every(r => r.revokeReason === 'USER_DISABLED')).toBe(true);
    const a = await AuditLog.findOne({ where: { action: 'auth.user.disabled' } });
    expect(a).toMatchObject({ entityId: String(u.id), reason: 'left the society', actorUserId: 99 });
    expect(events.filter(e => e.event === 'auth.session.revoked')).toHaveLength(2);
    await tx(t => users.enableUser(ctx, u.id, 'back', t));
    expect((await User.findByPk(u.id))!.status).toBe('ACTIVE');
    expect(await AuditLog.count({ where: { action: 'auth.user.enabled' } })).toBe(1);
  });

  it('T02-47 findOrCreateByMobile: creates ACTIVE, activates INVITED, refuses DISABLED, 10 parallel calls make one row', async () => {
    const created = await tx(t =>
      users.findOrCreateByMobile(t, '+91 91234 56789', { name: 'New Person', email: 'New@X.in' }),
    );
    expect(created.created).toBe(true);
    const row = (await User.findByPk(created.userId))!;
    expect(row).toMatchObject({
      status: 'ACTIVE',
      mobile: '9123456789',
      email: 'new@x.in',
      name: 'New Person',
      emailVerifiedAt: null,
    });
    expect(row.mobileVerifiedAt).not.toBeNull();
    expect((await AuditLog.findOne({ where: { action: 'auth.user.created' } }))?.after).toEqual({
      source: 'SIGNUP',
    });

    const again = await tx(t =>
      users.findOrCreateByMobile(t, '9123456789', { name: 'Other Name', email: 'other@x.in' }),
    );
    expect(again).toEqual({ userId: created.userId, created: false });
    expect((await User.findByPk(created.userId))!.name).toBe('New Person'); // not overwritten

    const invited = await makeUser({ status: 'INVITED', mobile: '9222222222' });
    await tx(t => users.findOrCreateByMobile(t, '9222222222', { name: 'Whoever' }));
    expect((await User.findByPk(invited.id))!.status).toBe('ACTIVE');
    expect(await AuditLog.count({ where: { action: 'auth.user.activated' } })).toBe(1);

    await makeUser({ status: 'DISABLED', mobile: '9333333333' });
    expect(
      (await errorOf(tx(t => users.findOrCreateByMobile(t, '9333333333', { name: 'Whoever' })))).code,
    ).toBe('ACCOUNT_DISABLED');
    await makeUser({ status: 'PENDING_DELETION', mobile: '9444444444' });
    expect(
      (await errorOf(tx(t => users.findOrCreateByMobile(t, '9444444444', { name: 'Whoever' })))).code,
    ).toBe('INVALID_STATE');

    expect((await errorOf(tx(t => users.findOrCreateByMobile(t, '12345', { name: 'Whoever' })))).code).toBe(
      'VALIDATION_FAILED',
    );
    expect((await errorOf(tx(t => users.findOrCreateByMobile(t, '9555555555', { name: 'R2' })))).code).toBe(
      'VALIDATION_FAILED',
    );
    await makeUser({ email: 'taken@x.in' });
    expect(
      (
        await errorOf(
          tx(t => users.findOrCreateByMobile(t, '9555555555', { name: 'Fresh Person', email: 'taken@x.in' })),
        )
      ).code,
    ).toBe('EMAIL_IN_USE');

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        tx(t => users.findOrCreateByMobile(t, '9666666666', { name: 'Parallel One' })),
      ),
    );
    expect(await User.count({ where: { mobile: '9666666666' } })).toBe(1);
    expect(results.filter(r => r.created)).toHaveLength(1);
    expect(new Set(results.map(r => r.userId)).size).toBe(1);
  });

  it('ensureInvitedUser creates INVITED, returns an existing user unchanged, and refuses a duplicate email', async () => {
    const a = await tx(t =>
      users.ensureInvitedUser(
        ctx,
        { mobile: '9820088888', name: 'Kavita Rao', email: 'admin@tulipgardens.in' },
        t,
      ),
    );
    expect(a.created).toBe(true);
    expect((await User.findByPk(a.userId))!.status).toBe('INVITED');
    expect(
      await tx(t => users.ensureInvitedUser(ctx, { mobile: '9820088888', name: 'Other Name' }, t)),
    ).toEqual({ userId: a.userId, created: false });
    expect(
      (
        await errorOf(
          tx(t =>
            users.ensureInvitedUser(
              ctx,
              { mobile: '9820099999', name: 'Someone Else', email: 'admin@tulipgardens.in' },
              t,
            ),
          ),
        )
      ).code,
    ).toBe('EMAIL_IN_USE');
    await makeUser({ status: 'DISABLED', mobile: '9777777777' });
    expect(
      (await errorOf(tx(t => users.ensureInvitedUser(ctx, { mobile: '9777777777', name: 'Some One' }, t))))
        .code,
    ).toBe('ACCOUNT_DISABLED');
  });

  it('createPlatformUser, getUserSummary and getSystemUserId', async () => {
    const id = await tx(t =>
      users.createPlatformUser(
        { mobile: '9000000001', email: 'super@societyapp.in', name: 'Platform Admin', password: PASSWORD },
        t,
      ),
    );
    const summary = await users.getUserSummary(id);
    expect(summary).toMatchObject({
      id,
      name: 'Platform Admin',
      mobile: '9000000001',
      email: 'super@societyapp.in',
      status: 'ACTIVE',
      mfaEnabled: false,
    });
    expect((await errorOf(users.getSystemUserId())).code).toBe('INTERNAL_ERROR');
    const sys = await seedSystemUser();
    expect(await users.getSystemUserId()).toBe(sys.id);
    expect((await errorOf(users.getUserSummary(999999))).code).toBe('NOT_FOUND');
  });

  it('T02-54 setPlatformRole(null) revokes PLATFORM sessions only and writes no auth audit row; a role change keeps sessions', async () => {
    const u = await makeUser({ platformRoleId: 1 });
    await mkSession(u.id, { clientApp: 'PLATFORM', activeSocietyId: null, mfaVerified: true });
    await mkSession(u.id, { clientApp: 'PLATFORM', activeSocietyId: null, mfaVerified: true });
    await mkSession(u.id, { clientApp: 'RESIDENT', activeSocietyId: null });
    const before = await AuditLog.count();
    const r = await tx(t => users.setPlatformRole(t, u.id, null));
    expect(r).toEqual({ before: 1, after: null });
    const rows = await Session.findAll({ where: { userId: u.id }, order: [['id', 'ASC']] });
    expect(rows.map(s => s.revokeReason)).toEqual(['ADMIN_REVOKED', 'ADMIN_REVOKED', null]);
    expect(await AuditLog.count()).toBe(before);
    expect((await User.findByPk(u.id))!.version).toBe(2);
    const live = await mkSession(u.id, { clientApp: 'PLATFORM', activeSocietyId: null });
    expect(await tx(t => users.setPlatformRole(t, u.id, 5))).toEqual({ before: null, after: 5 });
    expect(await tx(t => users.setPlatformRole(t, u.id, 6))).toEqual({ before: 5, after: 6 });
    expect((await Session.findByPk(live.id))!.revokedAt).toBeNull();
    expect((await User.findByPk(u.id))!.version).toBe(4);
    expect(await tx(t => users.setPlatformRole(t, u.id, 6))).toEqual({ before: 6, after: 6 }); // no-op
    expect((await User.findByPk(u.id))!.version).toBe(4);
    const sys = await seedSystemUser();
    expect((await errorOf(tx(t => users.setPlatformRole(t, sys.id, 1)))).code).toBe('INVALID_STATE');
    const pd = await makeUser({ status: 'PENDING_DELETION' });
    expect((await errorOf(tx(t => users.setPlatformRole(t, pd.id, 1)))).code).toBe('INVALID_STATE');
    expect((await errorOf(tx(t => users.setPlatformRole(t, 987654, 1)))).code).toBe('NOT_FOUND');
  });
});

describe('sessions service (8.30)', () => {
  it('T02-56 a PIN session for GATE: idle 840 minutes, absolute 14 hours, no MFA step; other combinations are INVALID_STATE', async () => {
    const u = await makeUser();
    const res = fakeRes();
    const out = await tx(t =>
      sessions.issueForUser(ctx, t, res as never, {
        userId: u.id,
        clientApp: 'GATE',
        amr: ['PIN'],
        mfaVerified: false,
      }),
    );
    const s = (await Session.findByPk(out.sessionId))!;
    expect(s.idleTimeoutMinutes).toBe(840);
    expect(s.absoluteExpiresAt.getTime() - s.createdAt!.getTime()).toBe(14 * 3_600_000);
    expect(s.amr).toEqual(['PIN']);
    expect(s.mfaVerified).toBe(false);
    expect(res.cookie).toHaveBeenCalledTimes(4);
    expect(out.me.session.clientApp).toBe('GATE');
    const shorter = await tx(t =>
      sessions.issueForUser(ctx, t, fakeRes() as never, {
        userId: u.id,
        clientApp: 'GATE',
        amr: ['PIN'],
        mfaVerified: false,
        expiresAt: new Date(nowMs() + 3_600_000),
      }),
    );
    expect((await Session.findByPk(shorter.sessionId))!.absoluteExpiresAt.getTime()).toBe(
      nowMs() + 3_600_000,
    );
    const longer = await tx(t =>
      sessions.issueForUser(ctx, t, fakeRes() as never, {
        userId: u.id,
        clientApp: 'GATE',
        amr: ['PIN'],
        mfaVerified: false,
        expiresAt: new Date(nowMs() + 48 * 3_600_000),
      }),
    );
    expect((await Session.findByPk(longer.sessionId))!.absoluteExpiresAt.getTime()).toBe(
      nowMs() + 14 * 3_600_000,
    );
    for (const bad of [
      { clientApp: 'ADMIN' as const, amr: ['PIN' as const], mfaVerified: false },
      { clientApp: 'GATE' as const, amr: ['PIN' as const], mfaVerified: true },
      { clientApp: 'GATE' as const, amr: ['OTP' as const, 'PIN' as const], mfaVerified: false },
    ])
      expect(
        (await errorOf(tx(t => sessions.issueForUser(ctx, t, fakeRes() as never, { userId: u.id, ...bad }))))
          .code,
      ).toBe('INVALID_STATE');
  });

  it('a PIN session cannot step up: REAUTH_REQUIRED on a route needing it (BR-02-61)', async () => {
    const u = await makeUser();
    const res = fakeRes();
    const out = await tx(t =>
      sessions.issueForUser(ctx, t, res as never, {
        userId: u.id,
        clientApp: 'GATE',
        amr: ['PIN'],
        mfaVerified: false,
      }),
    );
    const cookies: Cookies = Object.fromEntries(res.cookie.mock.calls.map(c => [c[0], c[1]]));
    expect(out.sessionId).toBeGreaterThan(0);
    const r = await post(
      '/me/security/password',
      { newPassword: 'Brand@NewPass2026' },
      { app: 'GATE', cookies },
    );
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('REAUTH_REQUIRED');
    expect((await post('/auth/reauth/otp', {}, { app: 'GATE', cookies })).body.code).toBe(
      'LOGIN_METHOD_NOT_ALLOWED',
    );
  });

  it('T02-52 issueForUser refuses the system user and non-active users; supportGrantId is not accepted here', async () => {
    const sys = await seedSystemUser();
    expect(
      (
        await errorOf(
          tx(t =>
            sessions.issueForUser(ctx, t, fakeRes() as never, {
              userId: sys.id,
              clientApp: 'ADMIN',
              amr: ['OTP'],
              mfaVerified: false,
            }),
          ),
        )
      ).code,
    ).toBe('INVALID_STATE');
    const d = await makeUser({ status: 'DISABLED' });
    expect(
      (
        await errorOf(
          tx(t =>
            sessions.issueForUser(ctx, t, fakeRes() as never, {
              userId: d.id,
              clientApp: 'ADMIN',
              amr: ['OTP'],
              mfaVerified: false,
            }),
          ),
        )
      ).code,
    ).toBe('INVALID_STATE');
    expect((await errorOf(tx(t => users.disableUser(ctx, sys.id, 'x', t)))).code).toBe('INVALID_STATE');
    expect((await errorOf(tx(t => users.enableUser(ctx, sys.id, 'x', t)))).code).toBe('INVALID_STATE');
    const u = await makeUser();
    expect(
      (
        await errorOf(
          tx(t =>
            sessions.issueForUser(
              ctx,
              t,
              fakeRes() as never,
              {
                userId: u.id,
                clientApp: 'ADMIN',
                amr: ['OTP'],
                mfaVerified: false,
                activeSocietyId: 1,
                supportGrantId: 41,
              } as never,
            ),
          ),
        )
      ).code,
    ).toBe('INVALID_STATE');
  });

  it('issueForUser for module 05 sign-up: ADMIN session with the new society as active society', async () => {
    const u = await makeUser();
    const out = await tx(t =>
      sessions.issueForUser(ctx, t, fakeRes() as never, {
        userId: u.id,
        clientApp: 'ADMIN',
        amr: ['OTP'],
        mfaVerified: false,
        activeSocietyId: 9,
      }),
    );
    expect(out.me.activeSocietyId).toBe(9);
    expect((await User.findByPk(u.id))!.lastSocietyId).toBe(9);
  });

  it('setActiveSociety recomputes idle minutes from the society policy and refuses PLATFORM', async () => {
    const u = await makeUser();
    const s = await mkSession(u.id);
    setAuthPorts({
      societySettings: { getSessionPolicy: async () => ({ adminIdleMinutes: 15, stepUpMinutes: 10 }) },
    });
    await sessions.setActiveSociety(s.id!, 4, {});
    const row = (await Session.findByPk(s.id))!;
    expect(row).toMatchObject({ activeSocietyId: 4, idleTimeoutMinutes: 15 });
    expect((await User.findByPk(u.id))!.lastSocietyId).toBe(4);
    const p = await mkSession(u.id, { clientApp: 'PLATFORM', activeSocietyId: null });
    expect((await errorOf(sessions.setActiveSociety(p.id!, 4, {}))).code).toBe('INVALID_STATE');
    expect((await errorOf(sessions.setActiveSociety(987654, 4, {}))).code).toBe('SESSION_NOT_FOUND');
  });

  it('T02-57 onSessionRevoked is called once per revoked session after commit; a failing hook does not undo the revoke and is retried', async () => {
    const calls: number[] = [];
    let fail = true;
    setAuthPorts({
      communicationHooks: {
        onSessionRevoked: async (id: number) => {
          calls.push(id);
          if (fail) {
            fail = false;
            throw new Error('hook down');
          }
        },
      },
    });
    const u = await makeUser();
    const s = [await mkSession(u.id), await mkSession(u.id), await mkSession(u.id)];
    let insideTx = 0;
    await tx(async t => {
      await sessions.revokeUserSessions(ctx, u.id, { reason: 'ADMIN_REVOKED' }, t);
      insideTx = calls.length;
    });
    expect(insideTx).toBe(0); // not before commit
    await drainQueues();
    expect(
      calls.filter(id => id === s[0].id).length +
        calls.filter(id => id === s[1].id).length +
        calls.filter(id => id === s[2].id).length,
    ).toBe(4); // 3 plus one retry
    expect(new Set(calls)).toEqual(new Set(s.map(x => x.id)));
    expect(
      (await Session.findAll({ where: { userId: u.id } })).every(r => r.revokeReason === 'ADMIN_REVOKED'),
    ).toBe(true);
  });

  it('logout calls the hook once; revokeUserSessions with clientApp limits the scope and MFA_POLICY_CHANGED is accepted', async () => {
    const hook = vi.fn(async () => {});
    setAuthPorts({ communicationHooks: { onSessionRevoked: hook } });
    const u = await makeUser();
    const cookies = await fullSignIn(u);
    await post('/auth/logout', {}, { cookies });
    expect(hook).toHaveBeenCalledTimes(1);
    const a = await mkSession(u.id, { clientApp: 'GATE', activeSocietyId: null });
    const b = await mkSession(u.id);
    expect(
      await tx(t =>
        sessions.revokeUserSessions(ctx, u.id, { reason: 'MFA_POLICY_CHANGED', clientApp: 'GATE' }, t),
      ),
    ).toBe(1);
    expect((await Session.findByPk(a.id))!.revokeReason).toBe('MFA_POLICY_CHANGED');
    expect((await Session.findByPk(b.id))!.revokedAt).toBeNull();
  });

  it('auth.resetMfa clears TOTP and codes and revokes every session (MFA_RESET)', async () => {
    const u = await makeUser({ mfa: true, email: 'a@x.in' });
    await mkSession(u.id);
    await tx(t =>
      auth.resetMfa(
        {
          ...ctx,
          user: { id: 5, name: 'Admin', mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' },
        },
        u.id,
        'lost phone',
        t,
      ),
    );
    const row = (await User.scope('withSecrets').findByPk(u.id))!;
    expect(row).toMatchObject({ mfaEnabledAt: null, totpSecretEnc: null, totpLastUsedStep: null });
    expect(await UserRecoveryCode.count({ where: { userId: u.id } })).toBe(0);
    expect((await Session.findOne({ where: { userId: u.id } }))!.revokeReason).toBe('MFA_RESET');
    expect((await AuditLog.findOne({ where: { action: 'auth.mfa.reset' } }))?.reason).toBe('lost phone');
    await vi.waitFor(async () =>
      expect((await inboxFor('a@x.in')).some(m => m.subject === 'Two-step sign-in was reset')).toBe(true),
    );
  });
});

describe('counting active users (BR-02-59, BR-02-60)', () => {
  const dayAgo = (d: number) => new Date(nowMs() - d * 86_400_000);
  it('T02-48 countActiveUsers counts only the 10-day user; support sessions, platform users and the system user are excluded', async () => {
    const recent = await makeUser();
    const old = await makeUser();
    const support = await makeUser({ platformRoleId: 1 });
    const other = await makeUser();
    await mkSession(recent.id, { lastSeenAt: dayAgo(10) });
    await mkSession(recent.id, { lastSeenAt: dayAgo(2) });
    await mkSession(old.id, { lastSeenAt: dayAgo(40) });
    await mkSession(support.id, { lastSeenAt: dayAgo(1), supportGrantId: 41 });
    await mkSession(support.id, { lastSeenAt: dayAgo(1), clientApp: 'ADMIN' });
    await mkSession(other.id, { lastSeenAt: dayAgo(1), activeSocietyId: 2 });
    expect(await auth.countActiveUsers(1, 30)).toBe(1);
    expect(await auth.countActiveUsers(1, 90)).toBe(2);
    for (const days of [0, 91, 1.5])
      expect((await errorOf(auth.countActiveUsers(1, days))).code).toBe('VALIDATION_FAILED');
  });

  it('T02-55 countActiveUsersPlatform counts residents of both societies; bad `since` values are VALIDATION_FAILED', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const platform = await makeUser({ platformRoleId: 1 });
    const supportAgent = await makeUser();
    const stale = await makeUser();
    await mkSession(a.id, { lastSeenAt: dayAgo(5), activeSocietyId: 1 });
    await mkSession(b.id, { lastSeenAt: dayAgo(5), activeSocietyId: 2, clientApp: 'RESIDENT' });
    await mkSession(platform.id, { lastSeenAt: dayAgo(5), clientApp: 'PLATFORM', activeSocietyId: null });
    await mkSession(supportAgent.id, { lastSeenAt: dayAgo(5), supportGrantId: 41 });
    await mkSession(stale.id, { lastSeenAt: dayAgo(40) });
    expect(await auth.countActiveUsersPlatform(dayAgo(30))).toBe(2);
    expect((await errorOf(auth.countActiveUsersPlatform(dayAgo(91)))).code).toBe('VALIDATION_FAILED');
    expect((await errorOf(auth.countActiveUsersPlatform(new Date(nowMs() + 60_000)))).code).toBe(
      'VALIDATION_FAILED',
    );
    expect((await errorOf(auth.countActiveUsersPlatform('x' as never))).code).toBe('VALIDATION_FAILED');
  });
});

describe('signup token and setup tokens', () => {
  const signupToken = async (mobile = '9123456789') => {
    const s = await post(
      '/auth/otp/send',
      { mobile, purpose: 'SIGNUP' },
      { ip: `10.${Math.floor(Math.random() * 200)}.0.1` },
    );
    const code = (await inboxFor(mobile))[0].body.match(/^(\d{6})/)![1];
    return (await post('/auth/otp/verify', { challengeId: s.body.data.challengeId, code })).body.data
      .signupToken as string;
  };

  it('T02-45 consumeSignupToken twice is LINK_USED; at 15:01 LINK_EXPIRED; for another app LINK_INVALID; audited', async () => {
    const token = await signupToken();
    expect((await errorOf(tx(t => auth.consumeSignupToken(t, token, { clientApp: 'RESIDENT' })))).code).toBe(
      'LINK_INVALID',
    );
    expect(await tx(t => auth.consumeSignupToken(t, token, { clientApp: 'ADMIN' }))).toEqual({
      mobile: '9123456789',
    });
    expect((await errorOf(tx(t => auth.consumeSignupToken(t, token, { clientApp: 'ADMIN' })))).code).toBe(
      'LINK_USED',
    );
    expect(await AuditLog.count({ where: { action: 'auth.signup.token_consumed' } })).toBe(1);
    const t2 = await signupToken('9123456780');
    advance(15 * 60_000 + 1000);
    expect((await errorOf(tx(t => auth.consumeSignupToken(t, t2, { clientApp: 'ADMIN' })))).code).toBe(
      'LINK_EXPIRED',
    );
    expect(
      (await errorOf(tx(t => auth.consumeSignupToken(t, 'su_' + 'A'.repeat(43), { clientApp: 'ADMIN' }))))
        .code,
    ).toBe('LINK_INVALID');
  });

  it('a consumed signup token plus findOrCreateByMobile in one transaction creates the user once', async () => {
    const token = await signupToken();
    const out = await tx(async t => {
      const { mobile } = await auth.consumeSignupToken(t, token, { clientApp: 'ADMIN' });
      return users.findOrCreateByMobile(t, mobile, { name: 'Society Creator' });
    });
    expect(out.created).toBe(true);
  });

  it('T02-53 setup token with an invitation expiry works 6 days later and expires after 7; 72 hours without an invitation; bad expiresAt is VALIDATION_FAILED', async () => {
    const u = await makeUser({ status: 'INVITED', email: 'inv@x.in', password: null });
    const expiresAt = new Date(nowMs() + 7 * 86_400_000);
    const t1 = await tx(t => auth.issueAccountSetupToken(ctx, u.id, { invitationId: 88, expiresAt }, t));
    expect(t1.expiresAt).toEqual(expiresAt);
    const status = (token: string) =>
      get('/auth/password/link-status', { query: { token, purpose: 'ACCOUNT_SETUP' } }).then(
        r => r.body.data,
      );
    advance(6 * 86_400_000);
    expect(await status(t1.rawToken)).toMatchObject({ valid: true });
    advance(86_400_000 + 1000);
    expect(await status(t1.rawToken)).toEqual({ valid: false, reason: 'EXPIRED' });
    expect(
      (await post('/auth/password/setup', { token: t1.rawToken, password: 'Invited@Pass2026' })).body.code,
    ).toBe('LINK_EXPIRED');

    setNow('2026-11-01T04:30:00Z');
    const t2 = await tx(t => auth.issueAccountSetupToken(ctx, u.id, {}, t));
    expect(t2.expiresAt.getTime()).toBe(nowMs() + 72 * 3_600_000);
    expect(
      (await AuthToken.findOne({ where: { purpose: 'ACCOUNT_SETUP' }, order: [['id', 'ASC']] }))!.revokedAt,
    ).not.toBeNull(); // older token revoked

    for (const bad of [new Date(nowMs() - 1000), new Date(nowMs() + 31 * 86_400_000), undefined])
      expect(
        (
          await errorOf(
            tx(t => auth.issueAccountSetupToken(ctx, u.id, { invitationId: 5, expiresAt: bad } as never, t)),
          )
        ).code,
      ).toBe('VALIDATION_FAILED');
    const active = await makeUser();
    expect((await errorOf(tx(t => auth.issueAccountSetupToken(ctx, active.id, {}, t)))).code).toBe(
      'INVALID_STATE',
    );
  });

  it('revokeAccountSetupTokens revokes the tokens of one invitation only', async () => {
    const u = await makeUser({ status: 'INVITED', email: 'inv@x.in', password: null });
    const t = await tx(t =>
      auth.issueAccountSetupToken(
        ctx,
        u.id,
        { invitationId: 7, expiresAt: new Date(nowMs() + 86_400_000) },
        t,
      ),
    );
    expect(await tx(x => auth.revokeAccountSetupTokens(u.id, 8, x))).toBe(0);
    expect(await tx(x => auth.revokeAccountSetupTokens(u.id, 7, x))).toBe(1);
    expect(
      (await post('/auth/password/setup', { token: t.rawToken, password: 'Invited@Pass2026' })).body.code,
    ).toBe('LINK_INVALID');
  });
});

describe('support hand-off (8.31, 8.32)', () => {
  const GRANT = {
    grantId: 41,
    societyId: 2,
    scope: 'READ_ONLY' as const,
    endsAt: new Date('2026-11-01T06:30:00Z'),
  };
  let entered: number[] = [];
  const setGrantPorts = (over: Record<string, unknown> = {}) => {
    entered = [];
    setAuthPorts({
      authAccess: {
        hasAppAccess: async () => true,
        getPlatformPermissions: async () => ['platform.support_access.create'],
      },
      supportAccess: {
        validateForHandoff: async (userId: number, grantId: number) => {
          if (grantId !== GRANT.grantId) throw new NotFoundError('NOT_FOUND', 'No such grant');
          return { ...GRANT, ...over };
        },
        markEntered: async (id: number) => {
          entered.push(id);
        },
        isGrantActive: async () => true,
        getGrantSummary: async () => ({ id: 41, scope: 'READ_ONLY', endsAt: GRANT.endsAt }),
      },
    } as never);
  };
  const platformCookies = async (o: { mfa?: boolean } = {}) => {
    const u = await makeUser({ email: 'support@societyapp.in', platformRoleId: 2, mfa: o.mfa ?? true });
    const r = await post('/auth/password/login', { email: u.email, password: PASSWORD }, { app: 'PLATFORM' });
    const v = await post(
      '/auth/mfa/verify',
      { challengeToken: r.body.data.challengeToken, method: 'TOTP', code: totpNow(u.totpSecret!) },
      { app: 'PLATFORM' },
    );
    return { u, cookies: cookiesFrom(v) };
  };
  const issue = (cookies: Cookies, grantId = 41) =>
    post('/auth/support-handoff', { grantId }, { app: 'PLATFORM', cookies });
  const redeem = (token: string) =>
    post('/auth/support-handoff/redeem', { handoffToken: token }, { app: 'ADMIN' });

  it('T02-49 issue on the platform host, redeem on the admin host', async () => {
    setGrantPorts();
    const { u, cookies } = await platformCookies();
    const i = await issue(cookies);
    expect(i.status, JSON.stringify(i.body)).toBe(201);
    expect(i.body.data.handoffToken).toMatch(/^sh_[A-Za-z0-9_-]{43}$/);
    expect(i.body.data.redeemUrl).toBe(
      `https://admin.societyapp.in/support/enter#token=${i.body.data.handoffToken}`,
    );
    expect(i.body.data.societyId).toBe(2);
    expect(i.body.data.expiresAt).toBe('2026-11-01T04:31:00.000Z');
    expect(
      await AuditLog.count({
        where: { action: 'auth.support_handoff.issued', societyId: 2, supportGrantId: 41 },
      }),
    ).toBe(1);
    expect(await AuthToken.count({ where: { purpose: 'SUPPORT_HANDOFF' } })).toBe(1);

    const r = await redeem(i.body.data.handoffToken);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('SIGNED_IN');
    expect(r.body.data.me.supportGrant).toEqual({
      id: 41,
      scope: 'READ_ONLY',
      endsAt: '2026-11-01T06:30:00.000Z',
    });
    expect(r.body.data.me.memberships).toEqual([]);
    expect(r.body.data.me.activeSocietyId).toBe(2);
    const sess = (await Session.findOne({ where: { clientApp: 'ADMIN' } }))!;
    expect(sess).toMatchObject({ userId: u.id, activeSocietyId: 2, supportGrantId: 41, mfaVerified: true });
    expect(sess.amr).toEqual(['PASSWORD', 'TOTP']);
    expect(sess.absoluteExpiresAt.getTime()).toBe(GRANT.endsAt.getTime()); // min(endsAt, now + 12 h)
    expect(sess.authTime.getTime()).toBe(
      (await Session.findOne({ where: { clientApp: 'PLATFORM' } }))!.authTime.getTime(),
    );
    expect(entered).toEqual([41]);
    expect(
      await AuditLog.count({
        where: { action: 'auth.support_handoff.redeemed', societyId: 2, supportGrantId: 41 },
      }),
    ).toBe(1);
    expect(
      await AuditLog.findOne({ where: { action: 'auth.session.created', supportGrantId: 41 } }),
    ).not.toBeNull();
    expect((await User.findByPk(u.id))!.lastSocietyId).toBeNull(); // a support session never becomes a membership

    expect((await redeem(i.body.data.handoffToken)).body.code).toBe('LINK_USED');

    const j = await issue(cookies);
    advance(61_000);
    const late = await redeem(j.body.data.handoffToken);
    expect(late.status).toBe(400);
    expect(late.body.code).toBe('LINK_EXPIRED');
  });

  it('two hand-offs for one grant both work and make two ADMIN sessions', async () => {
    setGrantPorts();
    const { cookies } = await platformCookies();
    const a = await redeem((await issue(cookies)).body.data.handoffToken);
    const b = await redeem((await issue(cookies)).body.data.handoffToken);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await Session.count({ where: { supportGrantId: 41 } })).toBe(2);
    expect(entered).toEqual([41, 41]);
  });

  it('T02-50 refusals: no permission, PENDING grant, expired grant, closed society, other user grant, wrong app, no MFA', async () => {
    setGrantPorts();
    const { cookies } = await platformCookies();
    setAuthPorts({ authAccess: { getPlatformPermissions: async () => [] } });
    expect(await issue(cookies).then(r => [r.status, r.body.code])).toEqual([403, 'PERMISSION_DENIED']);
    setGrantPorts();
    expect(await issue(cookies, 99).then(r => [r.status, r.body.code])).toEqual([404, 'NOT_FOUND']);
    for (const [err, status, code] of [
      [new ConflictError('INVALID_STATE', 'Grant is pending'), 409, 'INVALID_STATE'],
      [new ForbiddenError('SUPPORT_ACCESS_EXPIRED', 'Expired'), 403, 'SUPPORT_ACCESS_EXPIRED'],
      [new AppError(423, 'SOCIETY_CLOSED', 'Closed'), 423, 'SOCIETY_CLOSED'],
    ] as const) {
      setAuthPorts({
        supportAccess: {
          validateForHandoff: async () => {
            throw err;
          },
        },
      } as never);
      const r = await issue(cookies);
      expect([r.status, r.body.code]).toEqual([status, code]);
    }
    setGrantPorts();
    expect((await post('/auth/support-handoff', { grantId: 41 }, { app: 'ADMIN', cookies })).status).toBe(
      401,
    ); // platform cookies on the admin host
    await Session.update({ mfaVerified: false }, { where: { clientApp: 'PLATFORM' } });
    expect(await issue(cookies).then(r => [r.status, r.body.code])).toEqual([403, 'MFA_ENROLLMENT_REQUIRED']);
    expect(await redeem('sh_' + 'B'.repeat(43)).then(r => r.body.code)).toBe('LINK_INVALID');
  });

  it('redeem is refused for hosts other than admin, and when the platform session was revoked or the grant ended', async () => {
    setGrantPorts();
    const { cookies } = await platformCookies();
    const token = (await issue(cookies)).body.data.handoffToken;
    const wrong = await post('/auth/support-handoff/redeem', { handoffToken: token }, { app: 'RESIDENT' });
    expect(wrong.body.code).toBe('LOGIN_METHOD_NOT_ALLOWED');
    await Session.update(
      { revokedAt: new Date(nowMs()), revokeReason: 'LOGOUT' },
      { where: { clientApp: 'PLATFORM' } },
    );
    const gone = await redeem(token);
    expect(gone.status).toBe(401);
    expect(gone.body.code).toBe('SESSION_REVOKED');
    // the failed redeem did not consume the token
    expect((await AuthToken.findOne({ where: { purpose: 'SUPPORT_HANDOFF' } }))!.consumedAt).toBeNull();
  });

  it('T02-51 revokeBySupportGrant revokes every hand-off session then returns 0; switch society is locked; admin logout leaves the platform session', async () => {
    setGrantPorts();
    const { cookies } = await platformCookies();
    const a = await redeem((await issue(cookies)).body.data.handoffToken);
    const b = await redeem((await issue(cookies)).body.data.handoffToken);
    const adminCookies = cookiesFrom(a);
    const sw = await post('/auth/switch-society', { societyId: 3 }, { cookies: adminCookies });
    expect(sw.status).toBe(403);
    expect(sw.body.code).toBe('SUPPORT_SESSION_LOCKED');
    const me = await get('/auth/me', { cookies: adminCookies });
    expect(me.body.data.supportGrant.id).toBe(41);
    expect(me.body.data.memberships).toEqual([]);
    const out = await post('/auth/logout', {}, { cookies: adminCookies });
    expect(out.status).toBe(200);
    expect((await get('/auth/me', { app: 'PLATFORM', cookies })).status).toBe(200);
    expect(await sessions.revokeBySupportGrant(41)).toBe(1); // only b was still active
    expect(await sessions.revokeBySupportGrant(41)).toBe(0);
    const rows = await Session.findAll({ where: { supportGrantId: 41 }, order: [['id', 'ASC']] });
    expect(rows.map(r => r.revokeReason)).toEqual(['LOGOUT', 'SUPPORT_GRANT_ENDED']);
    expect((await get('/auth/me', { cookies: cookiesFrom(b) })).body.code).toBe('SESSION_REVOKED');
    expect((await get('/auth/me', { app: 'PLATFORM', cookies })).status).toBe(200);
  });

  it('a support session dies when the grant is no longer active (safety net) and at its absolute limit', async () => {
    setGrantPorts();
    const { cookies } = await platformCookies();
    const adminCookies = cookiesFrom(await redeem((await issue(cookies)).body.data.handoffToken));
    setAuthPorts({ supportAccess: { isGrantActive: async () => false } });
    const r = await get('/auth/me', { cookies: adminCookies });
    expect(r.body.code).toBe('SESSION_REVOKED');
    expect((await Session.findOne({ where: { clientApp: 'ADMIN' } }))!.revokeReason).toBe(
      'SUPPORT_GRANT_ENDED',
    );
    setGrantPorts();
    const second = cookiesFrom(await redeem((await issue(cookies)).body.data.handoffToken));
    await Session.update(
      { absoluteExpiresAt: new Date(nowMs() - 1000) },
      { where: { supportGrantId: 41, revokedAt: null } },
    );
    const late = await get('/auth/me', { cookies: second });
    expect(late.status).toBe(401);
    expect(late.body.code).toBe('SESSION_EXPIRED');
    expect(late.body.errors).toEqual([{ field: 'reason', message: 'ABSOLUTE' }]);
    expect(
      (await Session.findAll({ where: { supportGrantId: 41 }, order: [['id', 'DESC']] }))[0].revokeReason,
    ).toBe('SUPPORT_GRANT_ENDED');
  });
});

describe('background jobs (9.1)', () => {
  it('auth:cleanup deletes old rows by time predicates and is safe to repeat', async () => {
    const u = await makeUser();
    const old = new Date(nowMs() - 3 * 86_400_000);
    const mkOtp = (id: string, o: Record<string, unknown>) =>
      AuthOtp.create({
        challengeId: id,
        userId: null,
        mobile: '9820011111',
        purpose: 'LOGIN',
        channel: 'SMS',
        codeHash: 'a'.repeat(64),
        isDeliverable: true,
        status: 'PENDING',
        attemptCount: 0,
        resendCount: 0,
        expiresAt: new Date(nowMs() + 60_000),
        resendAvailableAt: new Date(nowMs()),
        createdAt: new Date(nowMs()),
        ...o,
      } as never);
    await mkOtp('otp_aaaaaaaaaaaaaaaaaaaaaaaa', { expiresAt: new Date(nowMs() - 60_000) }); // pending and expired: becomes EXPIRED
    await mkOtp('otp_bbbbbbbbbbbbbbbbbbbbbbbb', { createdAt: old, expiresAt: old }); // older than 24 h: deleted
    await AuthToken.create({
      tokenHash: 'a'.repeat(64),
      purpose: 'PASSWORD_RESET',
      userId: u.id,
      payload: null,
      attemptCount: 0,
      expiresAt: old,
      consumedAt: null,
      revokedAt: null,
    } as never);
    await AuthToken.create({
      tokenHash: 'b'.repeat(64),
      purpose: 'PASSWORD_RESET',
      userId: u.id,
      payload: null,
      attemptCount: 0,
      expiresAt: new Date(nowMs() + 60_000),
    } as never);
    await AuthLockout.create({
      scope: 'OTP',
      subjectHash: 'c'.repeat(64),
      failedCount: 5,
      windowStartedAt: old,
      lastFailedAt: old,
      lockedUntil: old,
      lockCount: 1,
    } as never);
    await AuthLockout.create({
      scope: 'OTP',
      subjectHash: 'd'.repeat(64),
      failedCount: 2,
      windowStartedAt: new Date(nowMs()),
      lastFailedAt: new Date(nowMs()),
      lockedUntil: null,
      lockCount: 0,
    } as never);
    const ancient = new Date(nowMs() - 91 * 86_400_000);
    await mkSession(u.id, { revokedAt: ancient, revokeReason: 'LOGOUT' });
    const keep = await mkSession(u.id, {
      revokedAt: new Date(nowMs() - 10 * 86_400_000),
      revokeReason: 'LOGOUT',
    });
    await cleanup();
    await cleanup();
    expect((await AuthOtp.findOne({ where: { challengeId: 'otp_aaaaaaaaaaaaaaaaaaaaaaaa' } }))!.status).toBe(
      'EXPIRED',
    );
    expect(await AuthOtp.count({ where: { challengeId: 'otp_bbbbbbbbbbbbbbbbbbbbbbbb' } })).toBe(0);
    expect(await AuthToken.count()).toBe(1);
    expect(await AuthLockout.count()).toBe(1);
    expect(await Session.count()).toBe(1);
    expect((await Session.findOne())!.id).toBe(keep.id);
  });

  it('auth:expire-idle-sessions revokes IDLE_TIMEOUT and EXPIRED sessions and leaves live ones', async () => {
    const u = await makeUser();
    const idle = await mkSession(u.id, { lastSeenAt: new Date(nowMs() - 31 * 60_000) });
    const expired = await mkSession(u.id, { absoluteExpiresAt: new Date(nowMs() - 1000) });
    const live = await mkSession(u.id);
    const gate = await mkSession(u.id, {
      clientApp: 'GATE',
      idleTimeoutMinutes: 840,
      lastSeenAt: new Date(nowMs() - 600 * 60_000),
    });
    expect(await expireIdleSessions()).toBe(2);
    expect(await expireIdleSessions()).toBe(0);
    expect((await Session.findByPk(idle.id))!.revokeReason).toBe('IDLE_TIMEOUT');
    expect((await Session.findByPk(expired.id))!.revokeReason).toBe('EXPIRED');
    expect((await Session.findByPk(live.id))!.revokedAt).toBeNull();
    expect((await Session.findByPk(gate.id))!.revokedAt).toBeNull();
  });

  const pending = async (o: Record<string, unknown> = {}) => {
    const u = await makeUser({
      status: 'PENDING_DELETION',
      mfa: true,
      email: `del${Math.random().toString(36).slice(2, 8)}@x.in`,
      ...o,
    });
    await User.update(
      {
        deletionScheduledFor: new Date(nowMs() - 1000),
        deletionRequestedAt: new Date(nowMs() - 30 * 86_400_000),
        name: 'Real Name',
      },
      { where: { id: u.id } },
    );
    await UserPasskey.create({
      userId: u.id,
      credentialId: `c-${u.id}`,
      publicKey: Buffer.from('k'),
      signCount: 0,
      transports: null,
      aaguid: null,
      deviceType: 'SINGLE_DEVICE',
      isBackedUp: false,
      name: 'pk',
      lastUsedAt: null,
    });
    await AuthToken.create({
      tokenHash: String(u.id).padStart(64, 'e'),
      purpose: 'PASSWORD_RESET',
      userId: u.id,
      payload: null,
      attemptCount: 0,
      expiresAt: new Date(nowMs() + 60_000),
    } as never);
    await mkSession(u.id);
    return u;
  };

  it('T02-34 auth:process-account-deletions anonymises per BR-02-52; the mobile can sign up again on RESIDENT', async () => {
    const sys = await seedSystemUser();
    const calls: string[] = [];
    setAuthPorts({
      authAccess: {
        onUserAnonymised: async () => {
          calls.push('03');
        },
      },
      residentsHooks: {
        onUserAnonymised: async () => {
          calls.push('09');
        },
      },
      communicationHooks: {
        onUserAnonymised: async () => {
          calls.push('16');
        },
      },
      residentApp: {
        onUserAnonymised: async () => {
          calls.push('25');
        },
      },
    } as never);
    const u = await pending({ mobile: '9820011111' });
    expect(await processAccountDeletions()).toBe(1);
    const row = (await User.scope('withSecrets').findByPk(u.id))!;
    expect(row).toMatchObject({
      mobile: null,
      email: null,
      name: 'Deleted user',
      photoFileId: null,
      passwordHash: null,
      totpSecretEnc: null,
      mfaEnabledAt: null,
      status: 'DELETED',
    });
    expect(row.anonymisedAt).not.toBeNull();
    expect(await UserRecoveryCode.count({ where: { userId: u.id } })).toBe(0);
    expect(await UserPasskey.count({ where: { userId: u.id } })).toBe(0);
    expect(await AuthToken.count({ where: { userId: u.id } })).toBe(0);
    expect((await Session.findOne({ where: { userId: u.id } }))!.revokeReason).toBe('ACCOUNT_DELETED');
    expect(calls.sort()).toEqual(['03', '09', '16', '25']);
    const a = await AuditLog.findOne({ where: { action: 'auth.account.anonymised' } });
    expect(a).toMatchObject({ actorUserId: sys.id, actorRole: 'system', entityId: String(u.id) });
    await vi.waitFor(async () =>
      expect(
        (await inboxFor('9820011111')).some(m => m.body === 'Your SocietyApp account was deleted.'),
      ).toBe(true),
    );
    expect(await processAccountDeletions()).toBe(0); // idempotent
    const again = await otpSignIn('9820011111', { app: 'RESIDENT' });
    expect(again.res.body.data.status).toBe('SIGNED_IN');
    expect(again.res.body.data.me.user.id).not.toBe(u.id);
  });

  it('T02-58 a failing module hook rolls back the anonymisation of that user (the job retries)', async () => {
    let fail = true;
    setAuthPorts({
      residentApp: {
        onUserAnonymised: async () => {
          if (fail) throw new Error('module 25 down');
        },
      },
    } as never);
    const u = await pending();
    await expect(processAccountDeletions()).rejects.toThrow('module 25 down');
    const row = (await User.findByPk(u.id))!;
    expect(row.status).toBe('PENDING_DELETION');
    expect(row.mobile).toBe(u.mobile);
    expect(await UserPasskey.count({ where: { userId: u.id } })).toBe(1);
    expect((await Session.findOne({ where: { userId: u.id } }))!.revokedAt).toBeNull();
    fail = false;
    expect(await processAccountDeletions()).toBe(1);
    expect((await User.findByPk(u.id))!.status).toBe('DELETED');
  });

  it('a blocker that appeared during the grace period stops the anonymisation and emails the user; users not yet due are skipped', async () => {
    const u = await pending({ email: 'chair@x.in' });
    setAuthPorts({ authAccess: { deletionBlockers: async () => ['COMMITTEE_ROLE:Sky Heights CHS'] } });
    expect(await processAccountDeletions()).toBe(0);
    expect((await User.findByPk(u.id))!.status).toBe('PENDING_DELETION');
    await vi.waitFor(async () =>
      expect((await inboxFor('chair@x.in')).some(m => /COMMITTEE_ROLE/.test(m.body))).toBe(true),
    );
    setAuthPorts();
    const later = await pending();
    await User.update({ deletionScheduledFor: new Date(nowMs() + 86_400_000) }, { where: { id: later.id } });
    await User.update({ status: 'ACTIVE', deletionScheduledFor: null }, { where: { id: u.id } }); // cancelled in the meantime
    expect(await processAccountDeletions()).toBe(0);
  });

  it('auth:deletion-reminders enqueues one reminder 7 days and 1 day before, once each', async () => {
    const u = await makeUser({ status: 'PENDING_DELETION', email: 'rem@x.in' });
    await User.update(
      { deletionScheduledFor: new Date(nowMs() + 7 * 86_400_000 - 3_600_000) },
      { where: { id: u.id } },
    );
    expect(await deletionReminders()).toBe(1);
    expect(await deletionReminders()).toBe(1); // same jobId: the second run adds nothing to send
    await drainQueues();
    await vi.waitFor(async () =>
      expect((await inboxFor('rem@x.in')).filter(m => /in 7 day/.test(m.body))).toHaveLength(1),
    );
    await User.update(
      { deletionScheduledFor: new Date(nowMs() + 86_400_000 - 3_600_000) },
      { where: { id: u.id } },
    );
    await deletionReminders();
    await drainQueues();
    await vi.waitFor(async () =>
      expect((await inboxFor('rem@x.in')).filter(m => /in 1 day/.test(m.body))).toHaveLength(1),
    );
  });
});

describe('seeders (7.10)', () => {
  it('system-user is idempotent; demo-users creates the 12 demo accounts once and the demo password works', async () => {
    const a = await seedSystemUser();
    const b = await seedSystemUser();
    expect(a.created).toBe(true);
    expect(b).toEqual({ created: false, id: a.id });
    const sys = (await User.findByPk(a.id))!;
    expect(sys).toMatchObject({
      status: 'SYSTEM',
      mobile: null,
      email: 'system@societyapp.in',
      name: 'System',
    });

    const r = await seedDemoUsers();
    expect(r.created).toHaveLength(12);
    expect(Object.keys(r.totp)).toHaveLength(10);
    expect(Object.keys(r.setupLinks).sort()).toEqual(['admin@tulipgardens.in', 'dev.malhotra@societyapp.in']);
    expect((await seedDemoUsers()).created).toHaveLength(0);
    expect(DEMO_USERS).toHaveLength(12);
    const treasurer = (await User.findOne({ where: { email: 'treasurer@skyheights.in' } }))!;
    expect(treasurer).toMatchObject({ mobile: '9820022222', name: 'Meera Iyer', status: 'ACTIVE' });
    expect(treasurer.mfaEnabledAt).not.toBeNull();
    expect((await User.findOne({ where: { email: 'dev.malhotra@societyapp.in' } }))!.status).toBe('INVITED');
    const login = await post(
      '/auth/password/login',
      { email: 'treasurer@skyheights.in', password: DEMO_PASSWORD },
      { app: 'ADMIN' },
    );
    expect(login.body.data.status).toBe('MFA_REQUIRED');
    const v = await post(
      '/auth/mfa/verify',
      {
        challengeToken: login.body.data.challengeToken,
        method: 'TOTP',
        code: totpNow(demoTotpSecret('treasurer@skyheights.in')),
      },
      { app: 'ADMIN' },
    );
    expect(v.status).toBe(200);
  });

  it('demo-users refuses to run in production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(seedDemoUsers()).rejects.toThrow(/production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
