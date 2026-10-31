import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, okList } from '../../utils/response';
import * as otp from './auth.otp';
import * as signin from './auth.signin';
import * as passkey from './auth.passkey';
import * as pw from './auth.password.service';
import * as sec from './auth.security';
import * as meSvc from './auth.me';
import { refreshSession } from './auth.sessions';
import { clearSessionCookies, COOKIES, setSessionCookies } from './auth.tokens';

const ctxOf = (req: Request) => req.ctx;
const body = <T>(req: Request): T => req.valid.body as T;

/** Writes a sign-in result: cookies when a session was created (section 8.4). */
function sendSignIn(res: Response, o: signin.SignInOutcome): Response {
  if (o.cookies) setSessionCookies(res, o.cookies);
  return ok(res, o.result, o.message);
}

const handler = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);

export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

export const authController = {
  otpSend: handler(async (req, res) => {
    const d = await otp.sendOtp(ctxOf(req), body(req));
    ok(res, d, 'If this number is registered, a code has been sent', 202);
  }),
  otpResend: handler(async (req, res) => {
    const d = await otp.resendOtp(ctxOf(req), body(req));
    ok(res, d, 'If this number is registered, a code has been sent', 202);
  }),
  otpVerify: handler(async (req, res) => {
    const r = await otp.verifyOtp(ctxOf(req), body(req));
    if (r.kind === 'SIGNUP')
      return ok(
        res,
        { status: 'SIGNUP_VERIFIED', signupToken: r.signupToken, mobile: r.mobile, expiresAt: r.expiresAt },
        'Mobile number verified',
      );
    sendSignIn(res, r.outcome);
  }),
  passwordLogin: handler(async (req, res) => {
    sendSignIn(res, await signin.passwordLogin(ctxOf(req), body(req)));
  }),
  passkeyOptions: handler(async (req, res) => {
    ok(res, await passkey.passkeyLoginOptions(ctxOf(req)));
  }),
  passkeyVerify: handler(async (req, res) => {
    sendSignIn(res, await passkey.passkeyLogin(ctxOf(req), body(req)));
  }),
  mfaVerify: handler(async (req, res) => {
    sendSignIn(res, await signin.verifyMfa(ctxOf(req), body(req)));
  }),
  mfaEnrollStart: handler(async (req, res) => {
    ok(res, await signin.mfaEnrollStart(ctxOf(req), body(req)), 'Scan the code with your authenticator app');
  }),
  mfaEnrollConfirm: handler(async (req, res) => {
    sendSignIn(res, await signin.mfaEnrollConfirm(ctxOf(req), body(req)));
  }),
  refresh: handler(async (req, res) => {
    const r = await refreshSession(ctxOf(req), req.cookies?.[COOKIES.refresh]);
    setSessionCookies(res, r.cookies);
    ok(res, {
      accessExpiresAt: r.accessExpiresAt.toISOString(),
      absoluteExpiresAt: r.absoluteExpiresAt.toISOString(),
    });
  }),
  logout: handler(async (req, res) => {
    await meSvc.logout(ctxOf(req));
    clearSessionCookies(res);
    ok(res, null, 'Signed out');
  }),
  me: handler(async (req, res) => {
    ok(res, await meSvc.getMe(ctxOf(req)));
  }),
  patchMe: handler(async (req, res) => {
    ok(res, await meSvc.patchMe(ctxOf(req), body(req)));
  }),
  switchSociety: handler(async (req, res) => {
    ok(res, await meSvc.switchSociety(ctxOf(req), body<{ societyId: number }>(req).societyId));
  }),
  reauthOtp: handler(async (req, res) => {
    const d = await sec.reauthOtp(ctxOf(req), body<{ channel?: 'SMS' | 'WHATSAPP' }>(req).channel ?? 'SMS');
    ok(res, d, 'A code has been sent', 202);
  }),
  reauthPasskeyOptions: handler(async (req, res) => {
    ok(res, await passkey.reauthPasskeyOptions(ctxOf(req)));
  }),
  reauth: handler(async (req, res) => {
    ok(res, await sec.reauth(ctxOf(req), body(req)), 'Confirmed');
  }),
  supportHandoff: handler(async (req, res) => {
    created(
      res,
      await meSvc.issueSupportHandoff(ctxOf(req), body<{ grantId: number }>(req).grantId),
      'Hand-off ready',
    );
  }),
  supportRedeem: handler(async (req, res) => {
    const r = await meSvc.redeemSupportHandoff(ctxOf(req), body<{ handoffToken: string }>(req).handoffToken);
    setSessionCookies(res, r.cookies);
    ok(res, { status: 'SIGNED_IN', me: r.me }, 'Signed in');
  }),
  forgot: handler(async (req, res) => {
    await pw.forgotPassword(ctxOf(req), body<{ email: string }>(req).email);
    ok(res, null, 'If an account exists for this email, a reset link is on its way', 202);
  }),
  linkStatus: handler(async (req, res) => {
    const q = req.valid.query as { token: string; purpose: 'PASSWORD_RESET' | 'ACCOUNT_SETUP' };
    ok(res, await pw.linkStatus(q.token, q.purpose));
  }),
  reset: handler(async (req, res) => {
    const b = body<{ token: string; password: string }>(req);
    await pw.resetPassword(ctxOf(req), b.token, b.password);
    ok(res, null, 'Password updated');
  }),
  setup: handler(async (req, res) => {
    const b = body<{ token: string; password: string }>(req);
    await pw.setupPassword(ctxOf(req), b.token, b.password);
    ok(res, null, 'Password set');
  }),
  emailVerify: handler(async (req, res) => {
    ok(res, await pw.verifyEmail(ctxOf(req), body<{ token: string }>(req).token), 'Email confirmed');
  }),
};

export const meSecurityController = {
  overview: handler(async (req, res) => {
    ok(res, await sec.securityOverview(ctxOf(req)));
  }),
  password: handler(async (req, res) => {
    ok(res, await sec.changePassword(ctxOf(req), body(req)), 'Password updated');
  }),
  totpSetup: handler(async (req, res) => {
    ok(res, await sec.totpSetup(ctxOf(req)), 'Scan the code with your authenticator app');
  }),
  totpConfirm: handler(async (req, res) => {
    ok(res, await sec.totpConfirm(ctxOf(req), body<{ code: string }>(req).code), 'Two-step sign-in is on');
  }),
  totpDisable: handler(async (req, res) => {
    await sec.totpDisable(ctxOf(req));
    ok(res, null, 'Two-step sign-in is off');
  }),
  recoveryCodes: handler(async (req, res) => {
    created(res, await sec.regenerateRecoveryCodes(ctxOf(req)), 'New codes generated');
  }),
  passkeyList: handler(async (req, res) => {
    ok(res, await sec.listPasskeys(ctxOf(req)));
  }),
  passkeyOptions: handler(async (req, res) => {
    ok(res, await passkey.passkeyRegisterOptions(ctxOf(req)));
  }),
  passkeyRegister: handler(async (req, res) => {
    created(res, await passkey.passkeyRegister(ctxOf(req), body(req)), 'Passkey added');
  }),
  passkeyRename: handler(async (req, res) => {
    ok(
      res,
      await sec.renamePasskey(ctxOf(req), req.valid.params.id, body<{ name: string }>(req).name),
      'Passkey renamed',
    );
  }),
  passkeyRemove: handler(async (req, res) => {
    await sec.removePasskey(ctxOf(req), req.valid.params.id);
    ok(res, null, 'Passkey removed');
  }),
  sessions: handler(async (req, res) => {
    const r = await sec.listSessions(ctxOf(req), req.valid.query);
    okList(res, r.items, r.pagination);
  }),
  sessionRevoke: handler(async (req, res) => {
    await sec.revokeOwnSession(ctxOf(req), req.valid.params.id);
    ok(res, null, 'Session signed out');
  }),
  sessionsRevokeOthers: handler(async (req, res) => {
    ok(res, await sec.revokeOtherSessions(ctxOf(req)), 'Other devices signed out');
  }),
  mobileStart: handler(async (req, res) => {
    ok(res, await sec.startMobileChange(ctxOf(req), body(req)), 'A code has been sent', 202);
  }),
  mobileConfirm: handler(async (req, res) => {
    ok(res, await sec.confirmMobileChange(ctxOf(req), body(req)), 'Mobile number updated');
  }),
  email: handler(async (req, res) => {
    await sec.startEmailChange(ctxOf(req), body<{ newEmail: string }>(req).newEmail);
    ok(res, null, 'A confirmation link has been sent', 202);
  }),
  deletionRequest: handler(async (req, res) => {
    ok(
      res,
      await sec.requestDeletion(ctxOf(req), body<{ reason?: string }>(req).reason),
      'Account deletion scheduled',
    );
  }),
  deletionCancel: handler(async (req, res) => {
    await sec.cancelDeletion(ctxOf(req));
    ok(res, null, 'Account deletion cancelled');
  }),
};
