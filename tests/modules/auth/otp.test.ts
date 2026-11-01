import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, AuthOtp, AuthToken, Session, User, closeDb } from '../../../src/models';
import { advance, now, setNow } from '../../../src/lib/clock';
import { listInbox } from '../../../src/lib/inbox';
import { setMinResponseMs } from '../../../src/modules/auth/auth.util';
import { setAuthPorts } from '../../../src/modules/auth/auth.ports';
import { hashOtp } from '../../../src/modules/auth/auth.crypto';
import {
  cookiesFrom,
  get,
  inboxFor,
  lastOtp,
  makeUser,
  otpSignIn,
  post,
  resetAll,
  sendOtp,
} from '../../helpers/auth';

afterAll(closeDb);
beforeEach(resetAll);

describe('OTP request (8.1)', () => {
  it('T02-07 registered and unregistered mobiles get an identical response; only the registered one gets an SMS', async () => {
    const u = await makeUser({ mobile: '9820011111' });
    setAuthPorts({ authAccess: { hasAppAccess: async () => true } });
    const a = await sendOtp(u.mobile);
    const b = await sendOtp('9820099999');
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body.message).toBe('If this number is registered, a code has been sent');
    expect(b.body.message).toBe(a.body.message);
    const strip = (r: typeof a) => ({
      ...r.body.data,
      challengeId: 'x',
      expiresAt: 'x',
      resendAvailableAt: 'x',
      maskedMobile: r.body.data.maskedMobile.length,
    });
    expect(strip(a)).toEqual(strip(b));
    expect(a.body.data.maskedMobile).toBe('98XXXXX111');
    expect(a.body.data.resendsLeft).toBe(3);
    const inbox = await listInbox();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].to).toBe('9820011111');
    // the unregistered number still has a challenge row, flagged undeliverable
    const row = await AuthOtp.findOne({ where: { mobile: '9820099999' } });
    expect(row?.isDeliverable).toBe(false);
  });

  it('SMS follows the DLT template with the Web OTP last line (BR-02-11)', async () => {
    const u = await makeUser();
    await sendOtp(u.mobile, { app: 'RESIDENT' });
    const sms = (await inboxFor(u.mobile))[0];
    const code = await lastOtp(u.mobile);
    expect(sms.body).toBe(
      `${code} is your SocietyApp login code. It expires in 5 minutes. Do not share it.\n@my.societyapp.in #${code}`,
    );
  });

  it('the code is stored only as an HMAC and never in an audit row (BR-02-10)', async () => {
    const u = await makeUser();
    const s = await sendOtp(u.mobile, { app: 'RESIDENT' });
    const code = await lastOtp(u.mobile);
    const row = (await AuthOtp.findOne({ where: { challengeId: s.body.data.challengeId } }))!;
    expect(row.codeHash).toBe(hashOtp(row.challengeId, code));
    expect(JSON.stringify(row.toJSON())).not.toContain(code + '"');
    await post('/auth/otp/verify', { challengeId: row.challengeId, code }, { app: 'RESIDENT' });
    expect(JSON.stringify(await AuditLog.findAll())).not.toContain(`"${code}"`);
  });

  it('timing: every outcome takes at least 400 ms (BR-02-12)', async () => {
    setMinResponseMs(400);
    const u = await makeUser();
    for (const mobile of [u.mobile, '9820099999']) {
      const t = Date.now();
      await sendOtp(mobile, { app: 'RESIDENT' });
      expect(Date.now() - t).toBeGreaterThanOrEqual(395);
    }
  });

  it('validation: bad mobile, unknown field, bad channel', async () => {
    expect((await sendOtp('12345')).status).toBe(400);
    const r = await post('/auth/otp/send', { mobile: '9820011111', extra: 1 });
    expect(r.status).toBe(400);
    expect(r.body.errors).toEqual([{ field: 'extra', message: 'Unknown field' }]);
    expect((await post('/auth/otp/send', { mobile: '9820011111', channel: 'FAX' })).status).toBe(400);
  });

  it('a +91 formatted number is accepted', async () => {
    const u = await makeUser({ mobile: '9820011111' });
    const r = await post('/auth/otp/send', { mobile: '+91 98200 11111' }, { app: 'RESIDENT' });
    expect(r.status).toBe(202);
    expect(await inboxFor(u.mobile)).toHaveLength(1);
  });

  it('rate limits: 5 per 15 minutes per mobile, 20 per IP, with Retry-After (BR-02-9)', async () => {
    for (let i = 0; i < 5; i++)
      expect((await sendOtp('9820011111', { app: 'RESIDENT', ip: '10.0.0.1' })).status).toBe(202);
    const r = await sendOtp('9820011111', { app: 'RESIDENT', ip: '10.0.0.1' });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('RATE_LIMITED');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    for (let i = 0; i < 19; i++)
      expect((await sendOtp(`98200${String(20000 + i)}`, { app: 'RESIDENT', ip: '10.0.0.2' })).status).toBe(
        202,
      );
    expect((await sendOtp('9820077777', { app: 'RESIDENT', ip: '10.0.0.2' })).status).toBe(202);
    const over = await sendOtp('9820077778', { app: 'RESIDENT', ip: '10.0.0.2' });
    expect(over.status).toBe(429);
  });
});

describe('OTP verification (8.3)', () => {
  it('T02-08 five wrong codes: the 5th shows 0 left and locks; the 6th is ACCOUNT_LOCKED with Retry-After about 900', async () => {
    const u = await makeUser();
    const s = await sendOtp(u.mobile, { app: 'RESIDENT' });
    const id = s.body.data.challengeId;
    const left: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await post('/auth/otp/verify', { challengeId: id, code: '000000' }, { app: 'RESIDENT' });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('OTP_INVALID');
      left.push(r.body.errors[0].message);
    }
    expect(left).toEqual(['4', '3', '2', '1', '0']);
    const sixth = await sendOtp(u.mobile, { app: 'RESIDENT' });
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('ACCOUNT_LOCKED');
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(890);
    expect(Number(sixth.headers['retry-after'])).toBeLessThanOrEqual(900);
    expect(sixth.body.errors[0].field).toBe('retryAfterSeconds');
    // the lock sends nothing to the owner (BR-02-29)
    expect((await inboxFor(u.mobile)).filter(m => !/login code/.test(m.body))).toHaveLength(0);
    const verify = await post('/auth/otp/verify', { challengeId: id, code: '000000' }, { app: 'RESIDENT' });
    expect(verify.body.code).toBe('OTP_EXPIRED'); // the challenge is FAILED after five attempts
  });

  it('an unknown number is locked after five tries exactly like a real one', async () => {
    const s = await sendOtp('6000000001', { app: 'ADMIN' });
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await post('/auth/otp/verify', { challengeId: s.body.data.challengeId, code: '123456' });
      codes.push(`${r.status}:${r.body.code}`);
    }
    expect(codes).toEqual(Array(5).fill('401:OTP_INVALID'));
    expect((await sendOtp('6000000001')).status).toBe(429);
    expect(await listInbox()).toHaveLength(0);
  });

  it('T02-09 resend at 29 s is too soon, at 31 s works; the old challenge is SUPERSEDED and its code fails', async () => {
    setNow('2026-11-01T04:30:00Z');
    const u = await makeUser();
    const s = await sendOtp(u.mobile, { app: 'RESIDENT' });
    const oldCode = await lastOtp(u.mobile);
    advance(29_000);
    const early = await post(
      '/auth/otp/resend',
      { challengeId: s.body.data.challengeId },
      { app: 'RESIDENT' },
    );
    expect(early.status).toBe(429);
    expect(early.body.code).toBe('OTP_RESEND_TOO_SOON');
    expect(early.body.errors[0]).toEqual({ field: 'retryAfterSeconds', message: '1' });
    advance(2_000);
    const ok = await post(
      '/auth/otp/resend',
      { challengeId: s.body.data.challengeId, channel: 'WHATSAPP' },
      { app: 'RESIDENT' },
    );
    expect(ok.status).toBe(202);
    expect(ok.body.data.channel).toBe('WHATSAPP');
    expect(ok.body.data.resendsLeft).toBe(2);
    expect((await AuthOtp.findOne({ where: { challengeId: s.body.data.challengeId } }))?.status).toBe(
      'SUPERSEDED',
    );
    const stale = await post(
      '/auth/otp/verify',
      { challengeId: s.body.data.challengeId, code: oldCode },
      { app: 'RESIDENT' },
    );
    expect(stale.body.code).toBe('OTP_EXPIRED');
    const wa = (await listInbox()).find(m => m.channel === 'WHATSAPP');
    expect(wa?.to).toBe(u.mobile);
  });

  it('at most 3 resends per chain', async () => {
    setNow('2026-11-01T04:30:00Z');
    const u = await makeUser();
    let id = (await sendOtp(u.mobile, { app: 'RESIDENT' })).body.data.challengeId;
    for (let i = 0; i < 3; i++) {
      advance(31_000);
      const r = await post('/auth/otp/resend', { challengeId: id }, { app: 'RESIDENT', ip: `10.1.1.${i}` });
      expect(r.status).toBe(202);
      id = r.body.data.challengeId;
    }
    advance(31_000);
    const r = await post('/auth/otp/resend', { challengeId: id }, { app: 'RESIDENT', ip: '10.1.1.9' });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('OTP_RESEND_LIMIT_REACHED');
  });

  it('T02-10 verify at 4:59 succeeds and at 5:01 the code has expired', async () => {
    setNow('2026-11-01T04:30:00Z');
    const u = await makeUser();
    const s = await sendOtp(u.mobile, { app: 'RESIDENT' });
    const code = await lastOtp(u.mobile);
    advance(4 * 60_000 + 59_000);
    const ok = await post(
      '/auth/otp/verify',
      { challengeId: s.body.data.challengeId, code },
      { app: 'RESIDENT' },
    );
    expect(ok.status).toBe(200);
    setNow('2026-11-01T05:30:00Z');
    const s2 = await sendOtp(u.mobile, { app: 'RESIDENT', ip: '10.2.2.2' });
    const code2 = await lastOtp(u.mobile);
    advance(5 * 60_000 + 1_000);
    const late = await post(
      '/auth/otp/verify',
      { challengeId: s2.body.data.challengeId, code: code2 },
      { app: 'RESIDENT' },
    );
    expect(late.status).toBe(401);
    expect(late.body.code).toBe('OTP_EXPIRED');
    expect((await AuthOtp.findOne({ where: { challengeId: s2.body.data.challengeId } }))?.status).toBe(
      'EXPIRED',
    );
  });

  it('a double tap: the second verify of a VERIFIED challenge gets OTP_EXPIRED (section 14)', async () => {
    const u = await makeUser();
    const s = await sendOtp(u.mobile, { app: 'RESIDENT' });
    const code = await lastOtp(u.mobile);
    const [a, b] = await Promise.all([
      post('/auth/otp/verify', { challengeId: s.body.data.challengeId, code }, { app: 'RESIDENT' }),
      post('/auth/otp/verify', { challengeId: s.body.data.challengeId, code }, { app: 'RESIDENT' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect(await Session.count()).toBe(1);
  });

  it('a successful sign-in sets the four cookies with the right attributes (BR-02-34)', async () => {
    const u = await makeUser();
    const { res } = await otpSignIn(u.mobile, { app: 'RESIDENT' });
    const raw = res.headers['set-cookie'] as unknown as string[];
    const by = (n: string) => raw.find(c => c.startsWith(`${n}=`))!;
    expect(by('sa_access')).toMatch(/HttpOnly/);
    expect(by('sa_access')).toMatch(/Secure/);
    expect(by('sa_access')).toMatch(/SameSite=Lax/);
    expect(by('sa_access')).toMatch(/Max-Age=900/);
    expect(by('sa_access')).not.toMatch(/Domain/i);
    expect(by('sa_refresh')).toMatch(/Path=\/api\/v1\/auth/);
    expect(by('sa_refresh')).toMatch(/SameSite=Strict/);
    expect(by('sa_csrf')).not.toMatch(/HttpOnly/);
    expect(by('sa_csrf')).toMatch(/SameSite=Strict/);
    expect(by('sa_device')).toMatch(/Max-Age=34560000/);
    expect(res.body.data.me.user.id).toBe(u.id);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('wrong code audits auth.login.failed without the code (8.3 step 3)', async () => {
    const u = await makeUser();
    const s = await sendOtp(u.mobile, { app: 'RESIDENT' });
    await post(
      '/auth/otp/verify',
      { challengeId: s.body.data.challengeId, code: '111111' },
      { app: 'RESIDENT' },
    );
    const a = await AuditLog.findOne({ where: { action: 'auth.login.failed', entityId: String(u.id) } });
    expect(a?.after).toEqual({ method: 'OTP', reason: 'BAD_CODE' });
  });
});

describe('app rules', () => {
  it('T02-25 a resident-only user signing in with OTP on the admin host gets NO_ACCESS_FOR_APP and no session', async () => {
    const u = await makeUser();
    const { res } = await otpSignIn(u.mobile, { app: 'ADMIN' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NO_ACCESS_FOR_APP');
    expect(await Session.count()).toBe(0);
  });

  it('T02-26 password sign-in on RESIDENT and OTP request on PLATFORM are LOGIN_METHOD_NOT_ALLOWED', async () => {
    const a = await post('/auth/password/login', { email: 'a@b.in', password: 'x' }, { app: 'RESIDENT' });
    expect(a.status).toBe(400);
    expect(a.body.code).toBe('LOGIN_METHOD_NOT_ALLOWED');
    const b = await sendOtp('9820011111', { app: 'PLATFORM' });
    expect(b.status).toBe(400);
    expect(b.body.code).toBe('LOGIN_METHOD_NOT_ALLOWED');
  });

  it('a LOGIN challenge cannot be verified on the platform host (password only there)', async () => {
    const u = await makeUser();
    const s = await sendOtp(u.mobile, { app: 'RESIDENT' });
    const code = await lastOtp(u.mobile);
    const r = await post(
      '/auth/otp/verify',
      { challengeId: s.body.data.challengeId, code },
      { app: 'PLATFORM' },
    );
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('LOGIN_METHOD_NOT_ALLOWED');
    expect(await Session.count()).toBe(0);
  });

  it('an unknown or missing Origin is CSRF_FAILED', async () => {
    expect((await sendOtp('9820011111', { origin: 'https://evil.example' })).body.code).toBe('CSRF_FAILED');
    expect((await sendOtp('9820011111', { origin: null })).body.code).toBe('CSRF_FAILED');
  });

  it('a new mobile on the resident host creates an account with name null; needsProfile is true (US-02-10)', async () => {
    const { res, cookies } = await otpSignIn('9123456789', { app: 'RESIDENT' });
    expect(res.status).toBe(200);
    expect(res.body.data.me.user.needsProfile).toBe(true);
    expect(res.body.data.me.memberships).toEqual([]);
    const u = await User.findOne({ where: { mobile: '9123456789' } });
    expect(u?.status).toBe('ACTIVE');
    expect(u?.mobileVerifiedAt).not.toBeNull();
    expect((await AuditLog.findOne({ where: { action: 'auth.user.created' } }))?.after).toEqual({
      source: 'RESIDENT_SIGNUP',
    });
    expect(cookies.sa_access).toBeTruthy();
  });

  it('an INVITED user becomes ACTIVE on the first OTP verify', async () => {
    const u = await makeUser({ status: 'INVITED' });
    const { res } = await otpSignIn(u.mobile, { app: 'RESIDENT' });
    expect(res.status).toBe(200);
    expect((await User.findByPk(u.id))?.status).toBe('ACTIVE');
    expect(await AuditLog.count({ where: { action: 'auth.user.activated' } })).toBe(1);
  });

  it('a DISABLED user: no SMS, same 202, verify never succeeds', async () => {
    const u = await makeUser({ status: 'DISABLED' });
    const s = await sendOtp(u.mobile, { app: 'RESIDENT' });
    expect(s.status).toBe(202);
    expect(await listInbox()).toHaveLength(0);
    const v = await post(
      '/auth/otp/verify',
      { challengeId: s.body.data.challengeId, code: '123456' },
      { app: 'RESIDENT' },
    );
    expect(v.body.code).toBe('OTP_INVALID');
  });

  it('a PENDING_DELETION user can still sign in (BR-02-51)', async () => {
    const u = await makeUser({ status: 'PENDING_DELETION' });
    const { res } = await otpSignIn(u.mobile, { app: 'RESIDENT' });
    expect(res.status).toBe(200);
    expect(res.body.data.me.user.deletionScheduledFor).not.toBeNull();
  });
});

describe('public sign-up OTP (BR-02-53)', () => {
  it('T02-43 SIGNUP send is identical for registered and unregistered mobiles; the registered owner is told once', async () => {
    const u = await makeUser({ mobile: '9820011111' });
    const a = await post('/auth/otp/send', { mobile: '9123456789', purpose: 'SIGNUP' });
    const b = await post('/auth/otp/send', { mobile: u.mobile, purpose: 'SIGNUP' });
    await post('/auth/otp/send', { mobile: u.mobile, purpose: 'SIGNUP' });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.body.message).toBe(a.body.message);
    const mine = await inboxFor('9123456789');
    expect(mine).toHaveLength(1);
    expect(mine[0].body).toMatch(/is your SocietyApp login code/);
    const theirs = await inboxFor(u.mobile);
    expect(theirs).toHaveLength(1); // twice requested, notified once in 24 h
    expect(theirs[0].body).toBe('You already have a SocietyApp account. Sign in instead.');
  });

  it('T02-44 SIGNUP verify returns a hashed single-use token, with no user, session or cookies', async () => {
    setNow('2026-11-01T04:30:00Z');
    const s = await post('/auth/otp/send', { mobile: '9123456789', purpose: 'SIGNUP' });
    const code = await lastOtp('9123456789');
    const v = await post('/auth/otp/verify', { challengeId: s.body.data.challengeId, code });
    expect(v.status).toBe(200);
    expect(v.body.data.status).toBe('SIGNUP_VERIFIED');
    expect(v.body.data.signupToken).toMatch(/^su_[A-Za-z0-9_-]{43}$/);
    expect(v.body.data.mobile).toBe('9123456789');
    expect(v.headers['set-cookie']).toBeUndefined();
    expect(await User.count()).toBe(0);
    expect(await Session.count()).toBe(0);
    const t = (await AuthToken.findOne({ where: { purpose: 'SIGNUP' } }))!;
    expect(t.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.tokenHash).not.toContain(v.body.data.signupToken);
    expect(t.expiresAt.getTime() - now().getTime()).toBeGreaterThan(0);
    expect(t.expiresAt.toISOString()).toBe('2026-11-01T04:45:00.000Z');
    expect(t.payload).toMatchObject({ mobile: '9123456789', clientApp: 'ADMIN' });
    expect(t.userId).toBeNull();
    const a = await AuditLog.findOne({ where: { action: 'auth.signup.mobile_verified' } });
    expect(a?.entityId).toBe('91XXXXX789');
  });

  it('a second signup token for the same mobile revokes the first', async () => {
    const mk = async (ip: string) => {
      const s = await post('/auth/otp/send', { mobile: '9123456789', purpose: 'SIGNUP' }, { ip });
      const code = await lastOtp('9123456789');
      return (await post('/auth/otp/verify', { challengeId: s.body.data.challengeId, code }, { ip })).body
        .data.signupToken as string;
    };
    await mk('10.3.0.1');
    await mk('10.3.0.2');
    const tokens = await AuthToken.findAll({ where: { purpose: 'SIGNUP' }, order: [['id', 'ASC']] });
    expect(tokens[0].revokedAt).not.toBeNull();
    expect(tokens[1].revokedAt).toBeNull();
  });

  it('SIGNUP verify for a number that got an account after the code was sent is MOBILE_IN_USE', async () => {
    const s = await post('/auth/otp/send', { mobile: '9123456789', purpose: 'SIGNUP' });
    const code = await lastOtp('9123456789');
    await makeUser({ mobile: '9123456789' });
    const v = await post('/auth/otp/verify', { challengeId: s.body.data.challengeId, code });
    expect(v.status).toBe(409);
    expect(v.body.code).toBe('MOBILE_IN_USE');
  });

  it('T02-46 SIGNUP on RESIDENT, GATE and PLATFORM hosts is LOGIN_METHOD_NOT_ALLOWED', async () => {
    for (const app of ['RESIDENT', 'GATE', 'PLATFORM'] as const) {
      const r = await post('/auth/otp/send', { mobile: '9123456789', purpose: 'SIGNUP' }, { app });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('LOGIN_METHOD_NOT_ALLOWED');
    }
  });
});

describe('cookies for logout', () => {
  it('logout clears the cookies except sa_device', async () => {
    const u = await makeUser();
    const { cookies } = await otpSignIn(u.mobile, { app: 'RESIDENT' });
    const r = await post('/auth/logout', {}, { app: 'RESIDENT', cookies });
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Signed out');
    const out = cookiesFrom(r, { ...cookies });
    expect(out.sa_access).toBeUndefined();
    expect(out.sa_refresh).toBeUndefined();
    expect(out.sa_csrf).toBeUndefined();
    expect(out.sa_device).toBe(cookies.sa_device);
    expect((await get('/auth/me', { app: 'RESIDENT', cookies })).body.code).toBe('SESSION_REVOKED');
  });
});
