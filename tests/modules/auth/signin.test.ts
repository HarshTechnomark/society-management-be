import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditLog,
  AuthLockout,
  AuthToken,
  Session,
  User,
  UserRecoveryCode,
  closeDb,
  sequelize,
} from '../../../src/models';
import { auth } from '../../../src/modules/auth/auth.public';
import { advance, setNow } from '../../../src/lib/clock';
import { listInbox } from '../../../src/lib/inbox';
import { setAuthPorts } from '../../../src/modules/auth/auth.ports';
import { decryptSecret } from '../../../src/modules/auth/auth.crypto';
import {
  PASSWORD,
  events,
  cookiesFrom,
  get,
  inboxFor,
  makeUser,
  otpSignIn,
  post,
  resetAll,
  totpNow,
} from '../../helpers/auth';
import { seedSystemUser } from '../../../seeders/system-user';

afterAll(closeDb);
beforeEach(async () => {
  await resetAll();
  setAuthPorts({ authAccess: { hasAppAccess: async () => true, userRequiresMfa: async () => false } });
});

const login = (email: string, password: string, o = {}) =>
  post('/auth/password/login', { email, password }, { app: 'ADMIN', ...o });

describe('password sign-in (8.5)', () => {
  it('signs in with email and password when MFA is off', async () => {
    const u = await makeUser({ email: 'office@skyheights.in' });
    const r = await login('Office@SkyHeights.in ', PASSWORD);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('SIGNED_IN');
    expect(r.body.data.me.user.id).toBe(u.id);
    expect(r.body.data.me.session.amr).toEqual(['PASSWORD']);
    expect(r.body.data.me.session.clientApp).toBe('ADMIN');
    expect((await User.findByPk(u.id))?.lastLoginAt).not.toBeNull();
    const a = await AuditLog.findOne({ where: { action: 'auth.session.created' } });
    expect(a?.after).toMatchObject({
      clientApp: 'ADMIN',
      amr: ['PASSWORD'],
      deviceLabel: 'Chrome on Android',
    });
  });

  it('unknown email, unverified email, no password and wrong password all give the same 401', async () => {
    await makeUser({ email: 'a@x.in' });
    await makeUser({ email: 'unverified@x.in', emailVerified: false });
    await makeUser({ email: 'nopass@x.in', password: null });
    const results = [
      await login('nobody@x.in', 'Whatever1234!'),
      await login('unverified@x.in', PASSWORD),
      await login('nopass@x.in', PASSWORD),
      await login('a@x.in', 'Wrong@Password1'),
    ];
    for (const r of results) {
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('INVALID_CREDENTIALS');
      expect(r.body.message).toBe('Email or password is not correct');
    }
  });

  it('the dummy hash keeps timing close for unknown emails (BR-02-16)', async () => {
    await makeUser({ email: 'a@x.in' });
    await login('warm@x.in', 'x'); // warms the dummy hash
    const time = async (email: string) => {
      const t = Date.now();
      await login(email, 'Wrong@Password1');
      return Date.now() - t;
    };
    const known = await time('a@x.in');
    const unknown = await time('ghost@x.in');
    expect(unknown).toBeGreaterThan(known * 0.4);
  });

  it('T02-11 ten wrong passwords lock for 30 minutes; the right one then gets ACCOUNT_LOCKED; the owner is emailed once', async () => {
    setNow('2026-11-01T04:00:00Z');
    const u = await makeUser({ email: 'chairman@skyheights.in' });
    for (let i = 0; i < 10; i++) {
      const r = await login('chairman@skyheights.in', 'Wrong@Password1');
      expect(r.status).toBe(401);
    }
    const good = await login('chairman@skyheights.in', PASSWORD);
    expect(good.status).toBe(429);
    expect(good.body.code).toBe('ACCOUNT_LOCKED');
    expect(Number(good.headers['retry-after'])).toBe(1800);
    await vi.waitFor(async () =>
      expect(
        (await inboxFor('chairman@skyheights.in')).filter(m => m.subject === 'Your account was locked'),
      ).toHaveLength(1),
    );
    // a further attempt does not send another message
    await login('chairman@skyheights.in', PASSWORD);
    expect(
      (await inboxFor('chairman@skyheights.in')).filter(m => m.subject === 'Your account was locked'),
    ).toHaveLength(1);
    expect(await AuditLog.count({ where: { action: 'auth.lockout.started', entityId: String(u.id) } })).toBe(
      1,
    );
    advance(30 * 60_000 + 2_000);
    expect((await login('chairman@skyheights.in', PASSWORD)).status).toBe(200);
  });

  it('a locked password does not revoke existing sessions (BR-02-28)', async () => {
    await makeUser({ email: 'a@x.in' });
    const ok = await login('a@x.in', PASSWORD);
    const cookies = cookiesFrom(ok);
    for (let i = 0; i < 10; i++) await login('a@x.in', 'Wrong@Password1');
    expect((await get('/auth/me', { cookies })).status).toBe(200);
  });

  it('T02-52 the system user cannot sign in by password, forgot-password sends nothing', async () => {
    const sys = await seedSystemUser();
    await User.update({ passwordHash: null }, { where: { id: sys.id } });
    const r = await login('system@societyapp.in', PASSWORD);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('INVALID_CREDENTIALS');
    expect((await post('/auth/password/forgot', { email: 'system@societyapp.in' })).status).toBe(202);
    expect(await listInbox()).toHaveLength(0);
    expect((await seedSystemUser()).created).toBe(false);
    expect(await User.count({ where: { status: 'SYSTEM' } })).toBe(1);
  });

  it('platform users always need the second step (BR-02-23)', async () => {
    setAuthPorts();
    const withMfa = await makeUser({ email: 'super@societyapp.in', platformRoleId: 1, mfa: true });
    const r = await post(
      '/auth/password/login',
      { email: 'super@societyapp.in', password: PASSWORD },
      { app: 'PLATFORM' },
    );
    expect(r.body.data.status).toBe('MFA_REQUIRED');
    expect(r.body.data.methods).toEqual(['TOTP', 'RECOVERY_CODE']);
    expect(r.body.data.challengeToken).toMatch(/^lc_[A-Za-z0-9_-]{43}$/);
    expect(r.headers['set-cookie']).toBeUndefined();
    await makeUser({ email: 'new@societyapp.in', platformRoleId: 2 });
    const e = await post(
      '/auth/password/login',
      { email: 'new@societyapp.in', password: PASSWORD },
      { app: 'PLATFORM' },
    );
    expect(e.body.data.status).toBe('MFA_ENROLL_REQUIRED');
    expect(e.body.data.methods).toEqual(['TOTP_ENROLL']);
    expect(withMfa.id).toBeGreaterThan(0);
  });

  it('a platform user cannot reach the platform app without a platform role (BR-02-42)', async () => {
    setAuthPorts();
    await makeUser({ email: 'a@x.in' });
    const r = await post(
      '/auth/password/login',
      { email: 'a@x.in', password: PASSWORD },
      { app: 'PLATFORM' },
    );
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('NO_ACCESS_FOR_APP');
  });

  it('a disabled user who passes the first factor gets ACCOUNT_DISABLED', async () => {
    await makeUser({ email: 'd@x.in', status: 'DISABLED' });
    const r = await login('d@x.in', PASSWORD);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('second factor at sign-in (8.8 to 8.10)', () => {
  const requireMfa = () =>
    setAuthPorts({ authAccess: { hasAppAccess: async () => true, userRequiresMfa: async () => true } });

  it('T02-12 a treasurer without MFA is sent to enrolment; start and confirm sign in with 10 recovery codes', async () => {
    requireMfa();
    const u = await makeUser({ email: 'treasurer@skyheights.in' });
    const { res } = await otpSignIn(u.mobile);
    expect(res.body.data.status).toBe('MFA_ENROLL_REQUIRED');
    const token = res.body.data.challengeToken;

    const early = await post('/auth/mfa/enroll/confirm', { challengeToken: token, code: '123456' });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('MFA_SETUP_NOT_STARTED');

    const start = await post('/auth/mfa/enroll/start', { challengeToken: token });
    expect(start.status).toBe(200);
    expect(start.body.data.secret).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
    expect(start.body.data.accountLabel).toBe('treasurer@skyheights.in');
    expect(start.body.data.otpauthUri).toContain(
      'otpauth://totp/SocietyApp:treasurer%40skyheights.in?secret=',
    );
    expect(start.body.data.otpauthUri).toContain('&issuer=SocietyApp&algorithm=SHA1&digits=6&period=30');
    expect((await User.findByPk(u.id))?.mfaEnabledAt).toBeNull(); // still off until confirmed

    const restart = await post('/auth/mfa/enroll/start', { challengeToken: token });
    const secret = restart.body.data.secret.replace(/ /g, '');
    expect(restart.body.data.secret).not.toBe(start.body.data.secret);

    const bad = await post('/auth/mfa/enroll/confirm', { challengeToken: token, code: '000000' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('TOTP_INVALID');

    const ok = await post('/auth/mfa/enroll/confirm', { challengeToken: token, code: totpNow(secret) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('SIGNED_IN');
    expect(ok.body.data.recoveryCodes).toHaveLength(10);
    expect(new Set(ok.body.data.recoveryCodes).size).toBe(10);
    expect(ok.body.data.me.session.amr).toEqual(['OTP', 'TOTP']);
    expect(ok.body.data.me.user.mfaEnabled).toBe(true);
    expect(ok.body.data.me.user.recoveryCodesRemaining).toBe(10);
    const after = (await User.scope('withSecrets').findByPk(u.id))!;
    expect(after.mfaEnabledAt).not.toBeNull();
    expect(decryptSecret(after.totpSecretEnc!)).toBe(secret);
    expect(after.totpLastUsedStep).not.toBeNull();
    expect(await UserRecoveryCode.count({ where: { userId: u.id } })).toBe(10);
    expect(await AuditLog.count({ where: { action: 'auth.mfa.enabled' } })).toBe(1);
    expect(await AuditLog.count({ where: { action: 'auth.recovery_codes.generated' } })).toBe(1);
    // the token is consumed
    expect((await post('/auth/mfa/enroll/start', { challengeToken: token })).body.code).toBe(
      'CHALLENGE_INVALID',
    );
  });

  it('TOTP sign-in; the same code cannot be replayed (BR-02-20, T02-04)', async () => {
    const u = await makeUser({ mfa: true });
    const first = await otpSignIn(u.mobile);
    expect(first.res.body.data.status).toBe('MFA_REQUIRED');
    const code = totpNow(u.totpSecret!);
    const ok = await post('/auth/mfa/verify', {
      challengeToken: first.res.body.data.challengeToken,
      method: 'TOTP',
      code,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.me.session.amr).toEqual(['OTP', 'TOTP']);
    expect(ok.body.data.me.session.clientApp).toBe('ADMIN');
    const second = await otpSignIn(u.mobile, { ip: '10.4.0.1' });
    const replay = await post(
      '/auth/mfa/verify',
      { challengeToken: second.res.body.data.challengeToken, method: 'TOTP', code },
      { ip: '10.4.0.1' },
    );
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('TOTP_REUSED');
    // a code from the next step works
    const next = await post('/auth/mfa/verify', {
      challengeToken: second.res.body.data.challengeToken,
      method: 'TOTP',
      code: totpNow(u.totpSecret!, 1),
    });
    expect(next.status).toBe(200);
  });

  it('T02-13 a recovery code works once; the second use is RECOVERY_CODE_INVALID; the owner is told', async () => {
    const u = await makeUser({ mfa: true, email: 'secretary@skyheights.in' });
    const a = await otpSignIn(u.mobile);
    const code = u.recoveryCodes[0].toLowerCase().replace(/-/g, ' ');
    const ok = await post('/auth/mfa/verify', {
      challengeToken: a.res.body.data.challengeToken,
      method: 'RECOVERY_CODE',
      code,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.me.session.amr).toEqual(['OTP', 'RECOVERY_CODE']);
    const used = (await UserRecoveryCode.findAll({ where: { userId: u.id } })).filter(r => r.usedAt);
    expect(used).toHaveLength(1);
    expect(used[0].usedSessionId).toBe(ok.body.data.me.session.id);
    expect(await AuditLog.count({ where: { action: 'auth.recovery_code.used' } })).toBe(1);
    await vi.waitFor(async () =>
      expect(
        (await inboxFor('secretary@skyheights.in')).some(m => m.subject === 'A recovery code was used'),
      ).toBe(true),
    );
    const b = await otpSignIn(u.mobile, { ip: '10.5.0.1' });
    const again = await post('/auth/mfa/verify', {
      challengeToken: b.res.body.data.challengeToken,
      method: 'RECOVERY_CODE',
      code: u.recoveryCodes[0],
    });
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('RECOVERY_CODE_INVALID');
    expect(again.body.errors[0].field).toBe('attemptsLeft');
    // a malformed recovery code is a validation error
    expect(
      (
        await post('/auth/mfa/verify', {
          challengeToken: b.res.body.data.challengeToken,
          method: 'RECOVERY_CODE',
          code: 'nope',
        })
      ).status,
    ).toBe(400);
  });

  it('wrong codes count down on the token and the lock; five revoke the token (BR-02-30)', async () => {
    const u = await makeUser({ mfa: true });
    const a = await otpSignIn(u.mobile);
    const token = a.res.body.data.challengeToken;
    const left: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await post('/auth/mfa/verify', { challengeToken: token, method: 'TOTP', code: '000000' });
      expect(r.body.code).toBe('TOTP_INVALID');
      left.push(r.body.errors[0].message);
    }
    expect(left).toEqual(['4', '3', '2', '1', '0']);
    const locked = await post('/auth/mfa/verify', {
      challengeToken: token,
      method: 'TOTP',
      code: totpNow(u.totpSecret!),
    });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    const b = await otpSignIn(u.mobile, { ip: '10.6.0.1' });
    expect(b.res.body.data.status).toBe('MFA_REQUIRED');
    const still = await post('/auth/mfa/verify', {
      challengeToken: b.res.body.data.challengeToken,
      method: 'RECOVERY_CODE',
      code: u.recoveryCodes[1],
    });
    expect(still.status).toBe(429); // the MFA lock covers recovery codes too
    await vi.waitFor(async () =>
      expect((await listInbox()).some(m => m.subject === 'Your account was locked')).toBe(true),
    );
  });

  it('T02-38 30 parallel wrong TOTP codes: the lock is set after the 5th, never more than 5 are counted, the rest get 429', async () => {
    const u = await makeUser({ mfa: true });
    const a = await otpSignIn(u.mobile);
    const token = a.res.body.data.challengeToken;
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        post('/auth/mfa/verify', { challengeToken: token, method: 'TOTP', code: '000000' }),
      ),
    );
    const by = (s: number) => results.filter(r => r.status === s).length;
    expect(by(401)).toBe(5);
    expect(by(429)).toBe(25);
    const lock = await AuthLockout.findOne({ where: { scope: 'MFA' } });
    expect(lock?.failedCount).toBe(5);
    expect(lock?.lockCount).toBe(1);
    expect(await AuditLog.count({ where: { action: 'auth.lockout.started' } })).toBe(1);
  });

  it('a challenge token from another app or an unknown one is CHALLENGE_INVALID', async () => {
    const u = await makeUser({ mfa: true });
    const a = await otpSignIn(u.mobile);
    const r = await post(
      '/auth/mfa/verify',
      { challengeToken: a.res.body.data.challengeToken, method: 'TOTP', code: totpNow(u.totpSecret!) },
      { app: 'RESIDENT' },
    );
    expect(r.body.code).toBe('CHALLENGE_INVALID');
    const bogus = await post('/auth/mfa/verify', {
      challengeToken: 'lc_' + 'A'.repeat(43),
      method: 'TOTP',
      code: '123456',
    });
    expect(bogus.body.code).toBe('CHALLENGE_INVALID');
  });

  it('a challenge token expires after 5 minutes', async () => {
    setNow('2026-11-01T04:00:00Z');
    const u = await makeUser({ mfa: true });
    const a = await otpSignIn(u.mobile);
    advance(5 * 60_000 + 1000);
    const r = await post('/auth/mfa/verify', {
      challengeToken: a.res.body.data.challengeToken,
      method: 'TOTP',
      code: totpNow(u.totpSecret!),
    });
    expect(r.body.code).toBe('CHALLENGE_INVALID');
  });
});

describe('forgot and reset password (8.17 to 8.20)', () => {
  const forgot = (email: string, o = {}) => post('/auth/password/forgot', { email }, { app: 'ADMIN', ...o });
  const tokenFromInbox = async (email: string) => {
    const m = (await inboxFor(email)).find(x => x.link);
    return new URL(m!.link!).searchParams.get('token')!;
  };

  it('T02-28 unknown and known emails both get 202; only the known one gets a link; it works once; at 15:01 it has expired', async () => {
    setNow('2026-11-01T04:00:00Z');
    await makeUser({ email: 'office@skyheights.in' });
    const a = await forgot('nobody@x.in');
    const b = await forgot('office@skyheights.in');
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.body).toEqual(a.body);
    expect(b.body.message).toBe('If an account exists for this email, a reset link is on its way');
    expect(await listInbox()).toHaveLength(1);
    const token = await tokenFromInbox('office@skyheights.in');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await inboxFor('office@skyheights.in'))[0].link).toBe(
      `https://admin.societyapp.in/reset?token=${token}`,
    );

    const status = await get('/auth/password/link-status', { query: { token, purpose: 'PASSWORD_RESET' } });
    expect(status.body.data).toMatchObject({ valid: true, email: 'office@skyheights.in' });

    const weak = await post('/auth/password/reset', { token, password: 'short' });
    expect(weak.status).toBe(422);
    expect(weak.body.code).toBe('PASSWORD_POLICY_FAILED');
    expect(weak.body.errors.map((e: { message: string }) => e.message)).toEqual([
      'len',
      'case',
      'num',
      'sym',
    ]);
    expect(
      (await get('/auth/password/link-status', { query: { token, purpose: 'PASSWORD_RESET' } })).body.data
        .valid,
    ).toBe(true); // not consumed

    const ok = await post('/auth/password/reset', { token, password: 'Brand@NewPass2026' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.message).toBe('Password updated');
    const reuse = await post('/auth/password/reset', { token, password: 'Another@Pass2026x' });
    expect(reuse.status).toBe(400);
    expect(reuse.body.code).toBe('LINK_USED');
    expect(
      (await get('/auth/password/link-status', { query: { token, purpose: 'PASSWORD_RESET' } })).body.data,
    ).toEqual({ valid: false, reason: 'USED' });
    expect((await login('office@skyheights.in', 'Brand@NewPass2026')).status).toBe(200);
    expect((await login('office@skyheights.in', PASSWORD)).status).toBe(401);
    await vi.waitFor(async () =>
      expect(
        (await inboxFor('office@skyheights.in')).some(
          m => m.subject === 'Your SocietyApp password was changed',
        ),
      ).toBe(true),
    );

    await forgot('office@skyheights.in', { ip: '10.7.0.1' });
    const t2 = (await inboxFor('office@skyheights.in')).filter(m => m.link)[0];
    const token2 = new URL(t2.link!).searchParams.get('token')!;
    advance(15 * 60_000 + 1000);
    const late = await post('/auth/password/reset', { token: token2, password: 'Brand@NewPass2027' });
    expect(late.body.code).toBe('LINK_EXPIRED');
    expect(
      (await get('/auth/password/link-status', { query: { token: token2, purpose: 'PASSWORD_RESET' } })).body
        .data.reason,
    ).toBe('EXPIRED');
  });

  it('a new reset request revokes the older link', async () => {
    await makeUser({ email: 'a@x.in' });
    await forgot('a@x.in');
    const first = await tokenFromInbox('a@x.in');
    await forgot('a@x.in', { ip: '10.7.1.1' });
    const second = (await inboxFor('a@x.in'))
      .filter(m => m.link)
      .map(m => new URL(m.link!).searchParams.get('token')!)[0];
    expect(second).not.toBe(first);
    expect(
      (await post('/auth/password/reset', { token: first, password: 'Brand@NewPass2026' })).body.code,
    ).toBe('LINK_INVALID');
    expect(
      (await post('/auth/password/reset', { token: second, password: 'Brand@NewPass2026' })).status,
    ).toBe(200);
  });

  it('forgot-password is limited to 3 per hour per email', async () => {
    for (let i = 0; i < 3; i++) expect((await forgot('a@x.in', { ip: `10.8.0.${i}` })).status).toBe(202);
    expect((await forgot('a@x.in', { ip: '10.8.0.9' })).status).toBe(429);
  });

  it('forgot password is not offered on the resident host', async () => {
    expect((await post('/auth/password/forgot', { email: 'a@x.in' }, { app: 'RESIDENT' })).body.code).toBe(
      'LOGIN_METHOD_NOT_ALLOWED',
    );
  });

  it('T02-29 reset signs out every session of the user and emits the realtime events', async () => {
    const u = await makeUser({ email: 'a@x.in' });
    const s1 = cookiesFrom(await login('a@x.in', PASSWORD));
    await otpSignIn(u.mobile, { app: 'RESIDENT', ip: '10.9.0.1' });
    await forgot('a@x.in');
    const token = await tokenFromInbox('a@x.in');
    await post('/auth/password/reset', { token, password: 'Brand@NewPass2026' });
    const rows = await Session.findAll({ where: { userId: u.id } });
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.revokeReason).toBe('PASSWORD_RESET');
    const emitted = events.filter(e => e.event === 'auth.session.revoked');
    expect(emitted.map(e => e.room)).toEqual([`user:${u.id}`, `user:${u.id}`]);
    expect(emitted[0].payload).toMatchObject({ reason: 'PASSWORD_RESET' });
    expect(events.filter(e => e.event === 'disconnect')).toHaveLength(2);
    expect((await get('/auth/me', { cookies: s1 })).body.code).toBe('SESSION_REVOKED');
    expect(await AuditLog.count({ where: { action: 'auth.password.reset' } })).toBe(1);
  });

  it('a successful reset clears the password lock', async () => {
    await makeUser({ email: 'a@x.in' });
    for (let i = 0; i < 10; i++) await login('a@x.in', 'Wrong@Password1');
    expect((await login('a@x.in', PASSWORD)).status).toBe(429);
    await forgot('a@x.in', { ip: '10.9.9.9' });
    const token = await tokenFromInbox('a@x.in');
    await post('/auth/password/reset', { token, password: 'Brand@NewPass2026' });
    expect((await login('a@x.in', 'Brand@NewPass2026')).status).toBe(200);
  });

  it('T02-30 a setup link activates an INVITED user, verifies the email and then sign-in needs MFA enrolment', async () => {
    setAuthPorts({ authAccess: { hasAppAccess: async () => true, userRequiresMfa: async () => true } });
    const kavita = await makeUser({
      status: 'INVITED',
      email: 'admin@tulipgardens.in',
      password: null,
      emailVerified: false,
      mobile: '9820088888',
    });
    const issued = await sequelize.transaction(tx =>
      auth.issueAccountSetupToken({ requestId: 'x', ip: '', userAgent: '' }, kavita.id, {}, tx),
    );
    expect(issued.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const st = await get('/auth/password/link-status', {
      query: { token: issued.rawToken, purpose: 'ACCOUNT_SETUP' },
    });
    expect(st.body.data).toMatchObject({ valid: true, email: 'admin@tulipgardens.in' });
    const ok = await post('/auth/password/setup', { token: issued.rawToken, password: 'Kavita@Tulip2026' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.message).toBe('Password set');
    expect(ok.headers['set-cookie']).toBeUndefined(); // does not sign in
    const u = (await User.findByPk(kavita.id))!;
    expect(u.status).toBe('ACTIVE');
    expect(u.emailVerifiedAt).not.toBeNull();
    expect(await AuditLog.count({ where: { action: 'auth.user.activated' } })).toBe(1);
    expect(await AuditLog.count({ where: { action: 'auth.password.set' } })).toBe(1);
    const si = await login('admin@tulipgardens.in', 'Kavita@Tulip2026');
    expect(si.body.data.status).toBe('MFA_ENROLL_REQUIRED');
    expect(
      (await post('/auth/password/setup', { token: issued.rawToken, password: 'Kavita@Tulip2027' })).body
        .code,
    ).toBe('LINK_USED');
    expect(await AuthToken.count({ where: { purpose: 'ACCOUNT_SETUP', consumedAt: null as never } })).toBe(0);
  });
});
