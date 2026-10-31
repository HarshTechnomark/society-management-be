import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../../src/models';
import { PUBLIC_ROUTES, isPublicRoute, isRefreshRoute } from '../../../src/modules/auth/public.routes';
import { call, makeUser, fullSignIn, resetAll } from '../../helpers/auth';
import { setAuthPorts } from '../../../src/modules/auth/auth.ports';

afterAll(closeDb);
beforeEach(async () => {
  await resetAll();
  setAuthPorts({ authAccess: { hasAppAccess: async () => true } });
});

type M = 'get' | 'post' | 'patch' | 'delete';
/** Section 8 route table. `pub` marks routes in public.routes.ts (an empty body is a 400, not a 401). */
const ROUTES: [M, string, boolean][] = [
  ['post', '/auth/otp/send', true],
  ['post', '/auth/otp/resend', true],
  ['post', '/auth/otp/verify', true],
  ['post', '/auth/password/login', true],
  ['post', '/auth/passkey/options', true],
  ['post', '/auth/passkey/verify', true],
  ['post', '/auth/mfa/verify', true],
  ['post', '/auth/mfa/enroll/start', true],
  ['post', '/auth/mfa/enroll/confirm', true],
  ['post', '/auth/refresh', false],
  ['post', '/auth/logout', false],
  ['get', '/auth/me', false],
  ['patch', '/auth/me', false],
  ['post', '/auth/switch-society', false],
  ['post', '/auth/reauth/otp', false],
  ['post', '/auth/reauth/passkey-options', false],
  ['post', '/auth/reauth', false],
  ['post', '/auth/support-handoff', false],
  ['post', '/auth/support-handoff/redeem', true],
  ['post', '/auth/password/forgot', true],
  ['get', '/auth/password/link-status', true],
  ['post', '/auth/password/reset', true],
  ['post', '/auth/password/setup', true],
  ['post', '/auth/email/verify', true],
  ['get', '/me/security', false],
  ['post', '/me/security/password', false],
  ['post', '/me/security/totp/setup', false],
  ['post', '/me/security/totp/confirm', false],
  ['delete', '/me/security/totp', false],
  ['post', '/me/security/recovery-codes', false],
  ['get', '/me/security/passkeys', false],
  ['post', '/me/security/passkeys/options', false],
  ['post', '/me/security/passkeys', false],
  ['patch', '/me/security/passkeys/1', false],
  ['delete', '/me/security/passkeys/1', false],
  ['get', '/me/security/sessions', false],
  ['delete', '/me/security/sessions/1', false],
  ['post', '/me/security/sessions/revoke-others', false],
  ['post', '/me/security/mobile/start', false],
  ['post', '/me/security/mobile/confirm', false],
  ['post', '/me/security/email', false],
  ['post', '/me/security/deletion-request', false],
  ['delete', '/me/security/deletion-request', false],
];

describe('route table (section 8)', () => {
  it('has 43 module 02 routes and public.routes.ts lists exactly the public ones (plus health, dev and webhooks)', () => {
    expect(ROUTES).toHaveLength(43);
    const declared = ROUTES.filter(r => r[2]).map(r => `${r[0].toUpperCase()} ${r[1]}`);
    const listed = PUBLIC_ROUTES.filter(r => typeof r.path === 'string' && r.path.startsWith('/auth/')).map(
      r => `${r.method} ${r.path}`,
    );
    expect(listed.sort()).toEqual(declared.sort());
    expect(isRefreshRoute('POST', '/auth/refresh')).toBe(true);
    expect(isPublicRoute('POST', '/auth/refresh')).toBe(false);
    expect(isPublicRoute('GET', '/auth/me')).toBe(false);
    expect(isPublicRoute('POST', '/webhooks/razorpay')).toBe(true);
    expect(isPublicRoute('GET', '/auth/password/link-status/')).toBe(true);
  });

  it.each(ROUTES)('%s %s exists and is protected as declared', async (method, path, pub) => {
    const r = await call(method, path, method === 'get' || method === 'delete' ? undefined : {});
    expect(r.status, `${method} ${path}`).not.toBe(404);
    if (pub)
      expect(
        r.status === 400 || r.status === 401 || r.status === 202 || r.status === 429 || r.status === 200,
        `${method} ${path} -> ${r.status}`,
      ).toBe(true);
    else
      expect(
        r.body.code === 'UNAUTHENTICATED' || r.body.code === 'REFRESH_TOKEN_INVALID',
        `${method} ${path} -> ${r.body.code}`,
      ).toBe(true);
    if (path !== '/auth/passkey/options') {
      expect(r.body.success).toBe(false);
      expect(r.body.requestId).toBe(r.headers['x-request-id']);
    }
  });

  it('every state-changing authenticated route refuses a request without the CSRF header', async () => {
    const cookies = await fullSignIn(await makeUser());
    for (const [method, path, pub] of ROUTES) {
      if (pub || method === 'get') continue;
      const r = await call(method, path, method === 'delete' ? undefined : {}, { cookies, csrf: false });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.code).toBe('CSRF_FAILED');
    }
  });

  it('every body is strict: an unknown key is a 400 listing the key', async () => {
    const cookies = await fullSignIn(await makeUser());
    for (const [path, body] of [
      ['/auth/logout', { x: 1 }],
      ['/auth/refresh', { x: 1 }],
      ['/auth/switch-society', { societyId: 1, x: 1 }],
      ['/auth/reauth', { method: 'TOTP', code: '123456', x: 1 }],
      ['/me/security/totp/setup', { x: 1 }],
      ['/me/security/password', { newPassword: 'abc', x: 1 }],
      ['/me/security/deletion-request', { confirmText: 'DELETE', x: 1 }],
    ] as const) {
      const r = await call('post', path, body, { cookies });
      expect(r.status, path).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
      expect(
        r.body.errors.some(
          (e: { field: string; message: string }) => e.field === 'x' && e.message === 'Unknown field',
        ),
        path,
      ).toBe(true);
    }
  });

  it('all auth responses carry Cache-Control: no-store (section 13)', async () => {
    for (const [m, p] of [
      ['get', '/auth/password/link-status'],
      ['post', '/auth/otp/send'],
      ['get', '/me/security'],
    ] as const) {
      const r = await call(m, p, m === 'get' ? undefined : {});
      expect(r.headers['cache-control'], p).toBe('no-store');
    }
  });
});
