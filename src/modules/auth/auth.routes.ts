import { Router } from 'express';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { authController as c, meSecurityController as m, noStore } from './auth.controller';
import { authSchemas as s, meSecuritySchemas as ms } from './auth.validation';
import { sessionIdFromRefresh } from './auth.sessions';
import { COOKIES } from './auth.tokens';

const ip = (req: { ip?: string }) => req.ip ?? 'unknown';

export const authRoutes = Router();
authRoutes.use(noStore);

// ---- public sign-in (listed in public.routes.ts)
authRoutes.post(
  '/otp/send',
  validate({ body: s.otpSend }),
  rateLimit({ name: 'otp-send-ip', limit: 20, windowSeconds: 900, key: ip, failClosed: true }),
  rateLimit({
    name: 'otp-send-mobile',
    limit: 5,
    windowSeconds: 900,
    key: req => req.valid.body.mobile,
    failClosed: true,
  }),
  c.otpSend,
);
authRoutes.post(
  '/otp/resend',
  validate({ body: s.otpResend }),
  rateLimit({ name: 'otp-send-ip', limit: 20, windowSeconds: 900, key: ip, failClosed: true }),
  c.otpResend,
);
authRoutes.post(
  '/otp/verify',
  validate({ body: s.otpVerify }),
  rateLimit({ name: 'otp-verify-ip', limit: 30, windowSeconds: 900, key: ip }),
  c.otpVerify,
);
authRoutes.post(
  '/password/login',
  validate({ body: s.passwordLogin }),
  rateLimit({ name: 'login-ip', limit: 50, windowSeconds: 900, key: ip, failClosed: true }),
  c.passwordLogin,
);
authRoutes.post(
  '/passkey/options',
  validate({ body: s.passkeyOptions }),
  rateLimit({ name: 'passkey-options-ip', limit: 30, windowSeconds: 900, key: ip }),
  c.passkeyOptions,
);
authRoutes.post(
  '/passkey/verify',
  validate({ body: s.passkeyVerify }),
  rateLimit({ name: 'passkey-verify-ip', limit: 30, windowSeconds: 900, key: ip }),
  c.passkeyVerify,
);
authRoutes.post('/mfa/verify', validate({ body: s.mfaVerify }), c.mfaVerify);
authRoutes.post('/mfa/enroll/start', validate({ body: s.mfaEnrollStart }), c.mfaEnrollStart);
authRoutes.post('/mfa/enroll/confirm', validate({ body: s.mfaEnrollConfirm }), c.mfaEnrollConfirm);
authRoutes.post(
  '/password/forgot',
  validate({ body: s.forgot }),
  rateLimit({
    name: 'forgot-email',
    limit: 3,
    windowSeconds: 3600,
    key: req => req.valid.body.email,
    failClosed: true,
  }),
  rateLimit({ name: 'forgot-ip', limit: 20, windowSeconds: 3600, key: ip, failClosed: true }),
  c.forgot,
);
authRoutes.get(
  '/password/link-status',
  validate({ query: s.linkStatus }),
  rateLimit({ name: 'link-status-ip', limit: 30, windowSeconds: 900, key: ip }),
  c.linkStatus,
);
authRoutes.post(
  '/password/reset',
  validate({ body: s.setPasswordViaLink }),
  rateLimit({ name: 'password-link-ip', limit: 30, windowSeconds: 900, key: ip }),
  c.reset,
);
authRoutes.post(
  '/password/setup',
  validate({ body: s.setPasswordViaLink }),
  rateLimit({ name: 'password-link-ip', limit: 30, windowSeconds: 900, key: ip }),
  c.setup,
);
authRoutes.post('/email/verify', validate({ body: s.emailVerify }), c.emailVerify);
authRoutes.post(
  '/support-handoff/redeem',
  validate({ body: s.supportRedeem }),
  rateLimit({ name: 'handoff-redeem-ip', limit: 30, windowSeconds: 900, key: ip }),
  c.supportRedeem,
);

// ---- refresh: refresh cookie + CSRF header, 60 per minute per session
authRoutes.post(
  '/refresh',
  validate({ body: s.refresh }),
  rateLimit({
    name: 'refresh-session',
    limit: 60,
    windowSeconds: 60,
    key: req => String(sessionIdFromRefresh(req.cookies?.[COOKIES.refresh]) ?? ip(req)),
  }),
  c.refresh,
);

// ---- authenticated
authRoutes.post('/logout', validate({ body: s.logout }), c.logout);
authRoutes.get('/me', c.me);
authRoutes.patch('/me', validate({ body: s.patchMe }), c.patchMe);
authRoutes.post('/switch-society', validate({ body: s.switchSociety }), c.switchSociety);
authRoutes.post(
  '/reauth/otp',
  validate({ body: s.reauthOtp }),
  rateLimit({
    name: 'reauth-otp-user',
    limit: 5,
    windowSeconds: 900,
    key: req => String(req.ctx.user?.id),
    failClosed: true,
  }),
  c.reauthOtp,
);
authRoutes.post('/reauth/passkey-options', validate({ body: s.passkeyOptions }), c.reauthPasskeyOptions);
authRoutes.post('/reauth', validate({ body: s.reauth }), c.reauth);
authRoutes.post(
  '/support-handoff',
  validate({ body: s.supportHandoff }),
  rateLimit({ name: 'handoff-user', limit: 20, windowSeconds: 900, key: req => String(req.ctx.user?.id) }),
  c.supportHandoff,
);

// ---- /me/security
export const meSecurityRoutes = Router();
meSecurityRoutes.use(noStore);
const stepUp = requireRecentAuth();
meSecurityRoutes.get('/', m.overview);
meSecurityRoutes.post('/password', stepUp, validate({ body: ms.password }), m.password);
meSecurityRoutes.post('/totp/setup', stepUp, validate({ body: ms.totpSetup }), m.totpSetup);
meSecurityRoutes.post('/totp/confirm', validate({ body: ms.totpConfirm }), m.totpConfirm);
meSecurityRoutes.delete('/totp', stepUp, m.totpDisable);
meSecurityRoutes.post('/recovery-codes', stepUp, validate({ body: ms.recoveryCodes }), m.recoveryCodes);
meSecurityRoutes.get('/passkeys', m.passkeyList);
meSecurityRoutes.post('/passkeys/options', stepUp, validate({ body: ms.passkeyOptions }), m.passkeyOptions);
meSecurityRoutes.post('/passkeys', validate({ body: ms.passkeyRegister }), m.passkeyRegister);
meSecurityRoutes.patch(
  '/passkeys/:id',
  validate({ params: ms.idParams, body: ms.passkeyRename }),
  m.passkeyRename,
);
meSecurityRoutes.delete('/passkeys/:id', validate({ params: ms.idParams }), m.passkeyRemove);
meSecurityRoutes.get('/sessions', validate({ query: ms.sessionsQuery }), m.sessions);
meSecurityRoutes.post('/sessions/revoke-others', validate({ body: ms.revokeOthers }), m.sessionsRevokeOthers);
meSecurityRoutes.delete('/sessions/:id', validate({ params: ms.idParams }), m.sessionRevoke);
meSecurityRoutes.post(
  '/mobile/start',
  stepUp,
  validate({ body: ms.mobileStart }),
  rateLimit({ name: 'otp-send-ip', limit: 20, windowSeconds: 900, key: ip, failClosed: true }),
  rateLimit({
    name: 'otp-send-mobile',
    limit: 5,
    windowSeconds: 900,
    key: req => req.valid.body.newMobile,
    failClosed: true,
  }),
  m.mobileStart,
);
meSecurityRoutes.post('/mobile/confirm', validate({ body: ms.mobileConfirm }), m.mobileConfirm);
meSecurityRoutes.post('/email', stepUp, validate({ body: ms.email }), m.email);
meSecurityRoutes.post('/deletion-request', stepUp, validate({ body: ms.deletion }), m.deletionRequest);
meSecurityRoutes.delete('/deletion-request', m.deletionCancel);
