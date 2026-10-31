import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, AuthToken, Session, User, UserPasskey, closeDb } from '../../../src/models';
import { advance, setNow } from '../../../src/lib/clock';
import { setAuthPorts } from '../../../src/modules/auth/auth.ports';
import {
  ORIGINS,
  call,
  cookiesFrom,
  fullSignIn,
  get,
  inboxFor,
  makeUser,
  post,
  resetAll,
  totpNow,
  type Cookies,
} from '../../helpers/auth';
import { FakeAuthenticator } from '../../helpers/webauthn';

afterAll(closeDb);
beforeEach(async () => {
  await resetAll();
  setAuthPorts({ authAccess: { hasAppAccess: async () => true, userRequiresMfa: async () => false } });
  setNow('2026-11-01T04:30:00Z');
});

const register = async (cookies: Cookies, auth: FakeAuthenticator, name?: string) => {
  const opts = await post('/me/security/passkeys/options', {}, { cookies });
  expect(opts.status, JSON.stringify(opts.body)).toBe(200);
  return post(
    '/me/security/passkeys',
    {
      challengeId: opts.body.data.challengeId,
      credential: auth.register(opts.body.data.publicKey.challenge),
      ...(name ? { name } : {}),
    },
    { cookies },
  );
};
const passkeyLogin = async (
  auth: FakeAuthenticator,
  o: { app?: keyof typeof ORIGINS; counter?: number; tamper?: boolean; origin?: string } = {},
) => {
  const app = o.app ?? 'ADMIN';
  const opts = await post('/auth/passkey/options', {}, { app });
  expect(opts.status, JSON.stringify(opts.body)).toBe(200);
  return post(
    '/auth/passkey/verify',
    {
      challengeId: opts.body.data.challengeId,
      credential: auth.assert(opts.body.data.publicKey.challenge, o),
    },
    { app },
  );
};

describe('passkeys (8.6, 8.7, 8.26, BR-02-27)', () => {
  it('T02-35 register, sign in with it, then a replayed counter is PASSKEY_INVALID with a counter_mismatch audit', async () => {
    const u = await makeUser({ email: 'a@x.in' });
    const cookies = await fullSignIn(u);
    const auth = new FakeAuthenticator(ORIGINS.ADMIN, true);

    const opts = await post('/me/security/passkeys/options', {}, { cookies });
    const pk = opts.body.data.publicKey;
    expect(pk.rp).toEqual({ id: 'localhost', name: 'SocietyApp' });
    expect(pk.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    });
    expect(pk.attestation).toBe('none');
    expect(pk.pubKeyCredParams.map((p: { alg: number }) => p.alg)).toEqual([-7, -257]);
    expect(pk.timeout).toBe(120000);
    expect(opts.body.data.challengeId).toMatch(/^wc_[A-Za-z0-9_-]{43}$/);

    const r = await post(
      '/me/security/passkeys',
      { challengeId: opts.body.data.challengeId, credential: auth.register(pk.challenge) },
      { cookies },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      name: 'Passkey on Chrome on Android',
      deviceType: 'MULTI_DEVICE',
      lastUsedAt: null,
    });
    expect(await AuditLog.count({ where: { action: 'auth.passkey.added' } })).toBe(1);
    await vi.waitFor(async () =>
      expect((await inboxFor('a@x.in')).some(m => m.subject === 'A passkey was added')).toBe(true),
    );
    const list = await get('/me/security/passkeys', { cookies });
    expect(list.body.data).toHaveLength(1);
    expect((await get('/auth/me', { cookies })).body.data.user.passkeyCount).toBe(1);
    expect((await get('/me/security', { cookies })).body.data.passkeys[0].name).toBe(
      'Passkey on Chrome on Android',
    );
    // the same challenge cannot be reused
    expect(
      (
        await post(
          '/me/security/passkeys',
          { challengeId: opts.body.data.challengeId, credential: auth.register(pk.challenge) },
          { cookies },
        )
      ).body.code,
    ).toBe('CHALLENGE_INVALID');

    // sign in with it
    const ok = await passkeyLogin(auth);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('SIGNED_IN');
    expect(ok.body.data.me.session.amr).toEqual(['PASSKEY']);
    expect(ok.body.data.me.user.id).toBe(u.id);
    const row = (await UserPasskey.findOne())!;
    expect(row.signCount).toBe(1);
    expect(row.lastUsedAt).not.toBeNull();
    expect((await Session.findAll({ where: { userId: u.id }, order: [['id', 'DESC']] }))[0].mfaVerified).toBe(
      true,
    );

    // replay: same counter again
    const replay = await passkeyLogin(auth, { counter: 1 });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('PASSKEY_INVALID');
    expect(
      await AuditLog.count({ where: { action: 'auth.passkey.counter_mismatch', entityId: String(u.id) } }),
    ).toBe(1);
    expect(await AuditLog.count({ where: { action: 'auth.login.failed' } })).toBe(1);
    expect((await passkeyLogin(auth, { counter: 5 })).status).toBe(200);
    expect((await UserPasskey.findOne())!.signCount).toBe(5);
  });

  it('a challenge is single use and expires after 5 minutes', async () => {
    const u = await makeUser();
    const cookies = await fullSignIn(u);
    const auth = new FakeAuthenticator(ORIGINS.ADMIN);
    expect((await register(cookies, auth)).status).toBe(201);
    const opts = await post('/auth/passkey/options', {}, { app: 'ADMIN' });
    const cred = auth.assert(opts.body.data.publicKey.challenge);
    expect(
      (
        await post(
          '/auth/passkey/verify',
          { challengeId: opts.body.data.challengeId, credential: cred },
          { app: 'ADMIN' },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          '/auth/passkey/verify',
          { challengeId: opts.body.data.challengeId, credential: cred },
          { app: 'ADMIN' },
        )
      ).body.code,
    ).toBe('CHALLENGE_INVALID');
    const o2 = await post('/auth/passkey/options', {}, { app: 'ADMIN' });
    advance(5 * 60_000 + 1000);
    expect(
      (
        await post(
          '/auth/passkey/verify',
          {
            challengeId: o2.body.data.challengeId,
            credential: auth.assert(o2.body.data.publicKey.challenge),
          },
          { app: 'ADMIN' },
        )
      ).body.code,
    ).toBe('CHALLENGE_INVALID');
    expect(await AuthToken.count({ where: { purpose: 'WEBAUTHN_CHALLENGE' } })).toBeGreaterThan(0);
  });

  it('unknown credential, tampered signature and wrong origin are PASSKEY_INVALID', async () => {
    const u = await makeUser();
    const cookies = await fullSignIn(u);
    const auth = new FakeAuthenticator(ORIGINS.ADMIN);
    await register(cookies, auth);
    expect((await passkeyLogin(new FakeAuthenticator(ORIGINS.ADMIN))).body.code).toBe('PASSKEY_INVALID');
    expect((await passkeyLogin(auth, { tamper: true })).body.code).toBe('PASSKEY_INVALID');
    expect((await passkeyLogin(auth, { origin: 'https://evil.example' })).body.code).toBe('PASSKEY_INVALID');
    expect((await passkeyLogin(auth)).status).toBe(200);
  });

  it('a registration with the wrong origin or a bad credential is PASSKEY_INVALID; a duplicate credential is PASSKEY_ALREADY_REGISTERED', async () => {
    const cookies = await fullSignIn(await makeUser({ mobile: '9820000001' }));
    const evil = new FakeAuthenticator('https://evil.example');
    expect((await register(cookies, evil)).body.code).toBe('PASSKEY_INVALID');
    const auth = new FakeAuthenticator(ORIGINS.ADMIN);
    expect((await register(cookies, auth)).status).toBe(201);
    const second = await register(cookies, auth);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('PASSKEY_ALREADY_REGISTERED');
    const other = await fullSignIn(await makeUser({ mobile: '9820000002' }));
    expect((await register(other, auth)).body.code).toBe('PASSKEY_ALREADY_REGISTERED'); // credential ids are global
  });

  it('at most 10 passkeys per user', async () => {
    const u = await makeUser();
    const cookies = await fullSignIn(u);
    for (let i = 0; i < 10; i++)
      await UserPasskey.create({
        userId: u.id,
        credentialId: `cred-${i}`,
        publicKey: Buffer.from('k'),
        signCount: 0,
        transports: null,
        aaguid: null,
        deviceType: 'SINGLE_DEVICE',
        isBackedUp: false,
        name: `Key ${i}`,
        lastUsedAt: null,
      });
    const r = await post('/me/security/passkeys/options', {}, { cookies });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PASSKEY_LIMIT_REACHED');
  });

  it('rename and remove audit and notify; the name rules apply', async () => {
    const u = await makeUser({ email: 'a@x.in' });
    const cookies = await fullSignIn(u);
    const created = await register(cookies, new FakeAuthenticator(ORIGINS.ADMIN), 'My laptop');
    expect(created.body.data.name).toBe('My laptop');
    const id = created.body.data.id;
    const rn = await call('patch', `/me/security/passkeys/${id}`, { name: 'Work laptop' }, { cookies });
    expect(rn.body.data.name).toBe('Work laptop');
    expect(await AuditLog.count({ where: { action: 'auth.passkey.renamed' } })).toBe(1);
    expect((await call('patch', `/me/security/passkeys/${id}`, { name: '' }, { cookies })).status).toBe(400);
    expect(
      (await call('patch', `/me/security/passkeys/${id}`, { name: 'x'.repeat(61) }, { cookies })).status,
    ).toBe(400);
    expect((await call('patch', '/me/security/passkeys/abc', { name: 'x' }, { cookies })).status).toBe(400);
    expect((await call('delete', `/me/security/passkeys/${id}`, undefined, { cookies })).status).toBe(200);
    expect(await AuditLog.count({ where: { action: 'auth.passkey.removed' } })).toBe(1);
    await vi.waitFor(async () =>
      expect((await inboxFor('a@x.in')).some(m => m.subject === 'A passkey was removed')).toBe(true),
    );
    expect((await call('delete', `/me/security/passkeys/${id}`, undefined, { cookies })).body.code).toBe(
      'PASSKEY_NOT_FOUND',
    );
  });

  it('GATE has no passkeys; PLATFORM and RESIDENT do', async () => {
    const g = await post('/auth/passkey/options', {}, { app: 'GATE' });
    expect(g.status).toBe(400);
    expect(g.body.code).toBe('LOGIN_METHOD_NOT_ALLOWED');
    expect((await post('/auth/passkey/options', {}, { app: 'PLATFORM' })).status).toBe(200);
    expect((await post('/auth/passkey/options', {}, { app: 'RESIDENT' })).status).toBe(200);
    expect((await post('/auth/passkey/options', {}, { app: 'WORK' })).body.data.publicKey).toMatchObject({
      rpId: 'localhost',
      userVerification: 'required',
      allowCredentials: [],
      timeout: 120000,
    });
  });

  it('a user who must have MFA and has no TOTP is still sent to enrolment; a user with TOTP is signed in directly', async () => {
    const a = await makeUser({ mobile: '9820000001' });
    const ca = await fullSignIn(a);
    const authA = new FakeAuthenticator(ORIGINS.ADMIN);
    await register(ca, authA);
    setAuthPorts({ authAccess: { hasAppAccess: async () => true, userRequiresMfa: async () => true } });
    const r = await passkeyLogin(authA);
    expect(r.body.data.status).toBe('MFA_ENROLL_REQUIRED');
    expect(r.headers['set-cookie']).toBeUndefined();
    const start = await post('/auth/mfa/enroll/start', { challengeToken: r.body.data.challengeToken });
    const done = await post('/auth/mfa/enroll/confirm', {
      challengeToken: r.body.data.challengeToken,
      code: totpNow(start.body.data.secret.replace(/ /g, '')),
    });
    expect(done.body.data.status).toBe('SIGNED_IN');
    expect(done.body.data.me.session.amr).toEqual(['PASSKEY', 'TOTP']);
    expect(done.body.data.recoveryCodes).toHaveLength(10);
    // now MFA is on: the passkey counts as both factors
    const again = await passkeyLogin(authA);
    expect(again.body.data.status).toBe('SIGNED_IN');
    expect(again.body.data.me.session.amr).toEqual(['PASSKEY']);
  });

  it('a disabled user or a user without access to the app is refused after a valid assertion', async () => {
    const u = await makeUser();
    const auth = new FakeAuthenticator(ORIGINS.ADMIN);
    await register(await fullSignIn(u), auth);
    setAuthPorts({ authAccess: { hasAppAccess: async () => false } });
    expect((await passkeyLogin(auth)).body.code).toBe('NO_ACCESS_FOR_APP');
    setAuthPorts({ authAccess: { hasAppAccess: async () => true } });
    await User.update({ status: 'DISABLED' }, { where: { id: u.id } });
    expect((await passkeyLogin(auth)).body.code).toBe('ACCOUNT_DISABLED');
  });

  it('step-up with a passkey (8.16)', async () => {
    const u = await makeUser({ mfa: true });
    const cookies = await fullSignIn(u);
    const auth = new FakeAuthenticator(ORIGINS.ADMIN);
    await register(cookies, auth);
    advance(6 * 60_000);
    const fresh = cookiesFrom(await post('/auth/refresh', {}, { cookies }), cookies);
    expect((await post('/me/security/passkeys/options', {}, { cookies: fresh })).body.code).toBe(
      'REAUTH_REQUIRED',
    );
    const opts = await post('/auth/reauth/passkey-options', {}, { cookies: fresh });
    expect(opts.status, JSON.stringify(opts.body)).toBe(200);
    expect(opts.body.data.publicKey.allowCredentials).toHaveLength(1);
    const bad = await post(
      '/auth/reauth',
      {
        method: 'PASSKEY',
        challengeId: opts.body.data.challengeId,
        credential: auth.assert(opts.body.data.publicKey.challenge, { tamper: true }),
      },
      { cookies: fresh },
    );
    expect(bad.body.code).toBe('PASSKEY_INVALID');
    const opts2 = await post('/auth/reauth/passkey-options', {}, { cookies: fresh });
    const ok = await post(
      '/auth/reauth',
      {
        method: 'PASSKEY',
        challengeId: opts2.body.data.challengeId,
        credential: auth.assert(opts2.body.data.publicKey.challenge),
      },
      { cookies: fresh },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await Session.findOne({ where: { userId: u.id } }))!.amr).toEqual(['OTP', 'TOTP', 'PASSKEY']);
    expect((await post('/me/security/passkeys/options', {}, { cookies: fresh })).status).toBe(200);
  });

  it("a step-up challenge issued to one session cannot be used by another user's session", async () => {
    const a = await makeUser({ mobile: '9820000001' });
    const b = await makeUser({ mobile: '9820000002' });
    const ca = await fullSignIn(a);
    const cb = await fullSignIn(b);
    const authA = new FakeAuthenticator(ORIGINS.ADMIN);
    await register(ca, authA);
    const opts = await post('/auth/reauth/passkey-options', {}, { cookies: ca });
    const r = await post(
      '/auth/reauth',
      {
        method: 'PASSKEY',
        challengeId: opts.body.data.challengeId,
        credential: authA.assert(opts.body.data.publicKey.challenge),
      },
      { cookies: cb },
    );
    expect(r.body.code).toBe('CHALLENGE_INVALID');
  });
});
