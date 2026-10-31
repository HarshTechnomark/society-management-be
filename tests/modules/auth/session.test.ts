import jwt from 'jsonwebtoken';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, Session, closeDb } from '../../../src/models';
import { advance, nowMs, setNow } from '../../../src/lib/clock';
import { setAuthPorts } from '../../../src/modules/auth/auth.ports';
import { csrfTokenFor } from '../../../src/modules/auth/auth.crypto';
import { env } from '../../../src/lib/env';
import {
  cookiesFrom,
  fullSignIn,
  get,
  inboxFor,
  makeUser,
  otpSignIn,
  post,
  resetAll,
  type Cookies,
} from '../../helpers/auth';

afterAll(closeDb);
beforeEach(async () => {
  await resetAll();
  setAuthPorts({ authAccess: { hasAppAccess: async () => true } });
  setNow('2026-11-01T04:30:00Z');
});

const signIn = async (o: { app?: 'ADMIN' | 'RESIDENT' | 'GATE' | 'WORK'; mobile?: string } = {}) => {
  const u = await makeUser({ mobile: o.mobile });
  const cookies = await fullSignIn(u, o.app ?? 'ADMIN');
  return { u, cookies, app: o.app ?? 'ADMIN' };
};
const refresh = (cookies: Cookies, app: 'ADMIN' | 'RESIDENT' = 'ADMIN') =>
  post('/auth/refresh', {}, { app, cookies });

describe('refresh rotation (8.11, BR-02-32, BR-02-33)', () => {
  it('rotates both tokens and keeps the CSRF cookie value', async () => {
    const { cookies } = await signIn();
    advance(60_000);
    const r = await refresh(cookies);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.accessExpiresAt).toBe(new Date(nowMs() + 900_000).toISOString());
    expect(r.body.data.absoluteExpiresAt).toBe('2026-11-01T16:30:00.000Z');
    const next = cookiesFrom(r, { ...cookies });
    expect(next.sa_refresh).not.toBe(cookies.sa_refresh);
    expect(next.sa_access).not.toBe(cookies.sa_access);
    expect(next.sa_csrf).toBe(cookies.sa_csrf);
    expect(next.sa_refresh).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    const s = (await Session.findOne())!;
    expect(s.rotationCount).toBe(1);
    expect(s.previousTokenHash).not.toBeNull();
    expect((await get('/auth/me', { cookies: next })).status).toBe(200);
  });

  it('refresh does not bump lastSeenAt (BR-02-39)', async () => {
    const { cookies } = await signIn();
    const before = (await Session.findOne())!.lastSeenAt.getTime();
    advance(120_000);
    await refresh(cookies);
    expect((await Session.findOne())!.lastSeenAt.getTime()).toBe(before);
  });

  it('T02-14 an old token presented 11 s after rotation revokes the session; audit and notification are written', async () => {
    const { u, cookies } = await signIn();
    const rotated = cookiesFrom(await refresh(cookies), { ...cookies });
    advance(11_000);
    const reuse = await refresh(cookies);
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');
    const s = (await Session.findOne())!;
    expect(s.revokeReason).toBe('TOKEN_REUSE');
    expect(s.revokedAt).not.toBeNull();
    expect(
      await AuditLog.count({ where: { action: 'auth.session.reuse_detected', entityId: String(s.id) } }),
    ).toBe(1);
    await vi.waitFor(async () =>
      expect((await inboxFor(u.mobile)).some(m => /copied your SocietyApp sign-in/.test(m.body))).toBe(true),
    );
    // the thief and the owner are both signed out
    expect((await refresh(rotated)).body.code).toBe('REFRESH_TOKEN_INVALID');
    expect((await get('/auth/me', { cookies: rotated })).body.code).toBe('SESSION_REVOKED');
  });

  it('T02-15 the old token within 10 s is REFRESH_SUPERSEDED and the session stays active', async () => {
    const { cookies } = await signIn();
    await refresh(cookies);
    advance(9_000);
    const r = await refresh(cookies);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('REFRESH_SUPERSEDED');
    expect((await Session.findOne())!.revokedAt).toBeNull();
    expect(await AuditLog.count({ where: { action: 'auth.session.reuse_detected' } })).toBe(0);
  });

  it('T02-16 twenty parallel refreshes with one token: exactly one 200, the rest REFRESH_SUPERSEDED, session intact', async () => {
    const { cookies } = await signIn();
    const results = await Promise.all(Array.from({ length: 20 }, () => refresh(cookies)));
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    const others = results.filter(r => r.status !== 200);
    expect(others).toHaveLength(19);
    for (const r of others) expect(r.body.code).toBe('REFRESH_SUPERSEDED');
    expect((await Session.findOne())!.revokedAt).toBeNull();
    expect((await Session.findOne())!.rotationCount).toBe(1);
  });

  it('refresh needs the CSRF header; without cookies the token is invalid', async () => {
    const { cookies } = await signIn();
    expect((await post('/auth/refresh', {}, { cookies, csrf: false })).body.code).toBe('CSRF_FAILED');
    expect((await post('/auth/refresh', {}, { cookies, csrf: 'wrong' })).body.code).toBe('CSRF_FAILED');
    expect((await post('/auth/refresh', {}, { cookies: { sa_csrf: cookies.sa_csrf } })).body.code).toBe(
      'REFRESH_TOKEN_INVALID',
    );
    expect((await post('/auth/refresh', {}, {})).body.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it("a refresh token cannot be used on another user's session (prefix and hash)", async () => {
    const a = await signIn({ mobile: '9820000001' });
    const b = await signIn({ mobile: '9820000002' });
    const sidB = Number(b.cookies.sa_refresh.split('.')[0]);
    const forged = { ...a.cookies, sa_refresh: `${sidB}.${a.cookies.sa_refresh.split('.')[1]}` };
    // the CSRF token of A does not match session B, so the request never reaches the service
    expect((await refresh(forged)).body.code).toBe('CSRF_FAILED');
    expect((await get('/auth/me', { cookies: b.cookies })).status).toBe(200);
  });

  it('idle: a refresh after the idle limit signs out with reason IDLE', async () => {
    const { cookies } = await signIn();
    advance(31 * 60_000);
    const r = await refresh(cookies);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('SESSION_EXPIRED');
    expect(r.body.errors).toEqual([{ field: 'reason', message: 'IDLE' }]);
    expect((await Session.findOne())!.revokeReason).toBe('IDLE_TIMEOUT');
  });

  it('absolute lifetime: a refresh after 12 hours signs out with reason ABSOLUTE', async () => {
    const { cookies } = await signIn();
    for (let i = 0; i < 24; i++) {
      advance(29 * 60_000);
      await get('/auth/me', { cookies: cookiesFrom(await refresh(cookies), cookies) }); // keep the session busy
    }
    advance(60 * 60_000);
    const r = await refresh(cookies);
    expect(r.body.code).toBe('SESSION_EXPIRED');
  });

  it('a disabled user cannot refresh', async () => {
    const { u, cookies } = await signIn();
    await (await import('../../../src/models')).User.update({ status: 'DISABLED' }, { where: { id: u.id } });
    const r = await refresh(cookies);
    expect(r.body.code).toBe('SESSION_REVOKED');
  });
});

describe('authMiddleware (BR-02-38)', () => {
  it('T02-18 an ADMIN session idle for 31 minutes is SESSION_EXPIRED with reason IDLE and revoked IDLE_TIMEOUT', async () => {
    const { cookies } = await signIn();
    await Session.update({ lastSeenAt: new Date(nowMs() - 31 * 60_000) }, { where: {} });
    const r = await get('/auth/me', { cookies });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('SESSION_EXPIRED');
    expect(r.body.errors).toEqual([{ field: 'reason', message: 'IDLE' }]);
    expect((await Session.findOne())!.revokeReason).toBe('IDLE_TIMEOUT');
    expect((await get('/auth/me', { cookies })).body.code).toBe('SESSION_REVOKED');
  });

  it('the absolute limit revokes with EXPIRED and reason ABSOLUTE', async () => {
    const { cookies } = await signIn();
    await Session.update({ absoluteExpiresAt: new Date(nowMs() - 1000) }, { where: {} });
    const r = await get('/auth/me', { cookies });
    expect(r.body.errors).toEqual([{ field: 'reason', message: 'ABSOLUTE' }]);
    expect((await Session.findOne())!.revokeReason).toBe('EXPIRED');
  });

  it('lastSeenAt is bumped at most once per 60 seconds and never by X-User-Activity: 0', async () => {
    const { cookies } = await signIn();
    const seen = async () => (await Session.findOne())!.lastSeenAt.getTime();
    const t0 = await seen();
    advance(61_000);
    await get('/me/security/sessions', { cookies, headers: { 'X-User-Activity': '0' } });
    expect(await seen()).toBe(t0);
    await get('/me/security/sessions', { cookies });
    const t1 = await seen();
    expect(t1).toBeGreaterThan(t0);
    advance(30_000);
    await get('/me/security/sessions', { cookies });
    expect(await seen()).toBe(t1);
    advance(31_000);
    await get('/me/security/sessions', { cookies });
    expect(await seen()).toBeGreaterThan(t1);
  });

  it('T02-19 only background polls (X-User-Activity: 0) for 31 minutes: lastSeenAt is not bumped and the session expires', async () => {
    const { cookies } = await signIn();
    const quiet = { 'X-User-Activity': '0' };
    const start = (await Session.findOne())!.lastSeenAt.getTime();
    let c = cookies;
    for (let i = 0; i < 2; i++) {
      advance(11 * 60_000);
      c = cookiesFrom(await refresh(c), c);
      expect((await get('/me/security/sessions', { cookies: c, headers: quiet })).status).toBe(200);
    }
    expect((await Session.findOne())!.lastSeenAt.getTime()).toBe(start);
    advance(11 * 60_000);
    const r = await get('/me/security/sessions', { cookies: c, headers: quiet });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('SESSION_EXPIRED');
    expect(r.body.errors).toEqual([{ field: 'reason', message: 'IDLE' }]);
  });

  it('T02-20 POST without X-CSRF-Token and with a foreign Origin are CSRF_FAILED', async () => {
    const { cookies } = await signIn();
    expect((await post('/auth/logout', {}, { cookies, csrf: false })).body.code).toBe('CSRF_FAILED');
    const evil = await post('/auth/logout', {}, { cookies, origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect(evil.body.code).toBe('CSRF_FAILED');
    expect((await post('/auth/logout', {}, { cookies, csrf: 'AAAA' })).body.code).toBe('CSRF_FAILED');
    // a Referer works when Origin is absent
    const viaReferer = await post(
      '/auth/logout',
      {},
      { cookies, origin: null, headers: { Referer: 'https://admin.societyapp.in/today' } },
    );
    expect(viaReferer.status).toBe(200);
  });

  it("the CSRF token of one session does not work for another session's cookies", async () => {
    const a = await signIn({ mobile: '9820000001' });
    const b = await signIn({ mobile: '9820000002' });
    expect((await post('/auth/logout', {}, { cookies: a.cookies, csrf: b.cookies.sa_csrf })).body.code).toBe(
      'CSRF_FAILED',
    );
    expect(b.cookies.sa_csrf).toBe(csrfTokenFor(Number(b.cookies.sa_refresh.split('.')[0])));
  });

  it('requests with no cookie at all get 401 rather than CSRF_FAILED; webhooks skip CSRF', async () => {
    expect((await post('/auth/logout', {}, {})).body.code).toBe('UNAUTHENTICATED');
    const w = await post('/webhooks/x', {}, { origin: null });
    expect(w.status).toBe(404);
  });

  it('T02-21 forged tokens: alg none, wrong secret, other app, wrong typ, expired are all UNAUTHENTICATED', async () => {
    const { u, cookies } = await signIn();
    const sid = cookies.sa_refresh.split('.')[0];
    const iat = Math.floor(nowMs() / 1000);
    const base = { sub: String(u.id), sid, app: 'ADMIN', typ: 'access', iat, exp: iat + 900 };
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(base)).toString('base64url')}.`;
    const tokens = [
      none,
      jwt.sign(base, 'x'.repeat(40)),
      jwt.sign({ ...base, app: 'PLATFORM' }, env().JWT_ACCESS_SECRET),
      jwt.sign({ ...base, typ: 'refresh' }, env().JWT_ACCESS_SECRET),
      jwt.sign({ ...base, iat: iat - 2000, exp: iat - 1000 }, env().JWT_ACCESS_SECRET),
      jwt.sign(base, env().JWT_ACCESS_SECRET, { algorithm: 'HS512' }),
      'garbage',
    ];
    for (const t of tokens) {
      const r = await get('/auth/me', { cookies: { sa_access: t } });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe('UNAUTHENTICATED');
    }
    // the genuine claims signed correctly work
    expect(
      (await get('/auth/me', { cookies: { sa_access: jwt.sign(base, env().JWT_ACCESS_SECRET) } })).status,
    ).toBe(200);
  });

  it('an access token of the admin app does not work on the resident host (BR-02-31)', async () => {
    const { cookies } = await signIn();
    const r = await get('/auth/me', { cookies, app: 'RESIDENT' });
    expect(r.body.code).toBe('UNAUTHENTICATED');
  });

  it('a revoked session fails at once even though the JWT is still valid', async () => {
    const { cookies } = await signIn();
    await Session.update({ revokedAt: new Date(), revokeReason: 'ADMIN_REVOKED' }, { where: {} });
    const r = await get('/auth/me', { cookies });
    expect(r.body.code).toBe('SESSION_REVOKED');
  });

  it('every route outside public.routes.ts needs a session', async () => {
    for (const path of [
      '/auth/me',
      '/me/security',
      '/me/security/sessions',
      '/me/security/passkeys',
      '/nope',
    ]) {
      const r = await get(path, {});
      expect(r.status, path).toBe(401);
      expect(r.body.code).toBe('UNAUTHENTICATED');
    }
    const unknown = await get('/nope', { cookies: (await signIn()).cookies });
    expect(unknown.status).toBe(404);
  });

  it('idle and absolute limits follow the app (BR-02-36)', async () => {
    const r = await otpSignIn((await makeUser()).mobile, { app: 'RESIDENT' });
    const s = (await Session.findOne())!;
    expect(s.idleTimeoutMinutes).toBe(10080);
    expect(s.absoluteExpiresAt.getTime() - s.createdAt!.getTime()).toBe(90 * 24 * 3_600_000);
    expect(r.res.body.data.me.session.idleTimeoutMinutes).toBe(10080);
  });
});
