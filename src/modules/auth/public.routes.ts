/**
 * Routes reachable without a session (module 02 section 2). Everything else passes `authMiddleware`.
 * Paths are relative to `/api/v1`. Anything under `/webhooks/` is signature-verified by its own module.
 */
interface Rule {
  method: string;
  path: string | RegExp;
}

export const PUBLIC_ROUTES: Rule[] = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/health/ready' },
  { method: 'GET', path: '/dev/inbox' },
  { method: 'DELETE', path: '/dev/inbox' },
  { method: 'POST', path: '/auth/otp/send' },
  { method: 'POST', path: '/auth/otp/resend' },
  { method: 'POST', path: '/auth/otp/verify' },
  { method: 'POST', path: '/auth/password/login' },
  { method: 'POST', path: '/auth/password/forgot' },
  { method: 'GET', path: '/auth/password/link-status' },
  { method: 'POST', path: '/auth/password/reset' },
  { method: 'POST', path: '/auth/password/setup' },
  { method: 'POST', path: '/auth/passkey/options' },
  { method: 'POST', path: '/auth/passkey/verify' },
  { method: 'POST', path: '/auth/mfa/verify' },
  { method: 'POST', path: '/auth/mfa/enroll/start' },
  { method: 'POST', path: '/auth/mfa/enroll/confirm' },
  { method: 'POST', path: '/auth/email/verify' },
  { method: 'POST', path: '/auth/support-handoff/redeem' },
  { method: 'GET', path: /^\/dev\/exports\/\d+$/ },
  { method: 'GET', path: /^\/dev\/files\/\d+$/ },
  { method: 'POST', path: '/public/signups' },
  { method: 'GET', path: '/public/status' },
  { method: 'GET', path: /^\/public\/invitations\/[^/]+$/ },
  { method: 'POST', path: /^\/public\/invitations\/[^/]+\/decline$/ },
  { method: 'POST', path: /^\/dev\/payments\/[^/]+\/pay$/ },
  { method: 'POST', path: /^\/webhooks\// },
];

/** The refresh route authenticates with the refresh cookie, not the access token, but still needs the CSRF token. */
export const REFRESH_ROUTE: Rule = { method: 'POST', path: '/auth/refresh' };

const matches = (r: Rule, method: string, path: string): boolean =>
  r.method === method && (typeof r.path === 'string' ? r.path === path : r.path.test(path));

const clean = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

export const isPublicRoute = (method: string, path: string): boolean =>
  PUBLIC_ROUTES.some(r => matches(r, method, clean(path)));
export const isRefreshRoute = (method: string, path: string): boolean =>
  matches(REFRESH_ROUTE, method, clean(path));
