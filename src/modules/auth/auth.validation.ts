import { z } from 'zod';
import { LOCALES } from '../../models/user.model';
import { emailSchema, mobileSchema, nameSchema } from './auth.normalise';
import { normaliseRecoveryCode, RECOVERY_CODE_RE } from './auth.crypto';

/** Zod schemas for module 02 (section 8). Every body is `.strict()` (module 01 BR-01-4). */
const channel = z.enum(['SMS', 'WHATSAPP']);
const otpChallengeId = z.string().regex(/^otp_[a-z2-7]{24}$/, 'Invalid challenge');
const webauthnChallengeId = z.string().regex(/^wc_[A-Za-z0-9_-]{43}$/, 'Invalid challenge');
const challengeToken = z.string().regex(/^lc_[A-Za-z0-9_-]{43}$/, 'Invalid challenge token');
const linkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid link');
const sixDigits = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');
const b64 = (max: number) => z.string().min(1).max(max);
const emptyBody = z.object({}).strict();
const id = z.coerce.number().int().positive();

const authenticationCredential = z
  .object({
    id: b64(4096),
    rawId: b64(4096),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: b64(4096),
        authenticatorData: b64(4096),
        signature: b64(4096),
        userHandle: z.string().max(4096).nullish(),
      })
      .strict(),
    authenticatorAttachment: z.string().max(40).nullish(),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .transform(c => ({
    ...c,
    response: { ...c.response, userHandle: c.response.userHandle ?? undefined },
    authenticatorAttachment: (c.authenticatorAttachment ?? undefined) as never,
  }));

const registrationCredential = z
  .object({
    id: b64(8192),
    rawId: b64(8192),
    type: z.literal('public-key'),
    response: z
      .object({
        clientDataJSON: b64(8192),
        attestationObject: b64(8192),
        authenticatorData: z.string().max(8192).optional(),
        transports: z.array(z.string().max(20)).max(10).optional(),
        publicKeyAlgorithm: z.number().int().optional(),
        publicKey: z.string().max(8192).optional(),
      })
      .strict(),
    authenticatorAttachment: z.string().max(40).nullish(),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .transform(c => ({ ...c, authenticatorAttachment: (c.authenticatorAttachment ?? undefined) as never }));

const noControlChars = (s: string): boolean =>
  ![...s].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
const passwordInput = z.string().min(1, 'Required').max(1024);

export const authSchemas = {
  otpSend: z
    .object({
      mobile: mobileSchema,
      purpose: z.enum(['LOGIN', 'SIGNUP']).default('LOGIN'),
      channel: channel.default('SMS'),
    })
    .strict(),
  otpResend: z.object({ challengeId: otpChallengeId, channel: channel.optional() }).strict(),
  otpVerify: z.object({ challengeId: otpChallengeId, code: sixDigits }).strict(),
  passwordLogin: z.object({ email: emailSchema, password: z.string().min(1).max(128) }).strict(),
  passkeyOptions: emptyBody,
  passkeyVerify: z
    .object({ challengeId: webauthnChallengeId, credential: authenticationCredential })
    .strict(),
  mfaVerify: z
    .object({ challengeToken, method: z.enum(['TOTP', 'RECOVERY_CODE']), code: z.string().min(1).max(40) })
    .strict()
    .transform((v, ctx) => {
      const code = v.method === 'RECOVERY_CODE' ? normaliseRecoveryCode(v.code) : v.code;
      const ok = v.method === 'RECOVERY_CODE' ? RECOVERY_CODE_RE.test(code) : /^\d{6}$/.test(code);
      if (!ok)
        ctx.addIssue({
          code: 'custom',
          path: ['code'],
          message: v.method === 'TOTP' ? 'Enter the 6-digit code' : 'Enter a valid recovery code',
        });
      return { ...v, code };
    }),
  mfaEnrollStart: z.object({ challengeToken }).strict(),
  mfaEnrollConfirm: z.object({ challengeToken, code: sixDigits }).strict(),
  refresh: emptyBody,
  logout: emptyBody,
  patchMe: z
    .object({
      version: z.number().int().min(1),
      name: nameSchema.optional(),
      locale: z.enum(LOCALES).optional(),
      photoFileId: z.number().int().positive().nullable().optional(),
    })
    .strict()
    .refine(v => v.name !== undefined || v.locale !== undefined || v.photoFileId !== undefined, {
      message: 'Provide at least one of name, locale or photoFileId',
      path: ['name'],
    }),
  switchSociety: z.object({ societyId: z.number().int().positive() }).strict(),
  reauthOtp: z.object({ channel: channel.optional() }).strict(),
  reauth: z
    .object({
      method: z.enum(['TOTP', 'OTP', 'PASSKEY']),
      code: sixDigits.optional(),
      challengeId: z.string().max(80).optional(),
      credential: authenticationCredential.optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
      const need = (cond: boolean, path: string) => {
        if (!cond) ctx.addIssue({ code: 'custom', path: [path], message: 'Required' });
      };
      if (v.method === 'TOTP') need(v.code !== undefined, 'code');
      if (v.method === 'OTP') {
        need(v.code !== undefined, 'code');
        need(v.challengeId !== undefined && otpChallengeId.safeParse(v.challengeId).success, 'challengeId');
      }
      if (v.method === 'PASSKEY') {
        need(v.credential !== undefined, 'credential');
        need(
          v.challengeId !== undefined && webauthnChallengeId.safeParse(v.challengeId).success,
          'challengeId',
        );
      }
    }),
  supportHandoff: z.object({ grantId: z.number().int().positive() }).strict(),
  supportRedeem: z
    .object({ handoffToken: z.string().regex(/^sh_[A-Za-z0-9_-]{43}$/, 'Invalid token') })
    .strict(),
  forgot: z.object({ email: emailSchema }).strict(),
  linkStatus: z.object({ token: linkToken, purpose: z.enum(['PASSWORD_RESET', 'ACCOUNT_SETUP']) }),
  setPasswordViaLink: z.object({ token: linkToken, password: passwordInput }).strict(),
  emailVerify: z.object({ token: linkToken }).strict(),
};

export const meSecuritySchemas = {
  password: z
    .object({ currentPassword: z.string().min(1).max(128).optional(), newPassword: passwordInput })
    .strict(),
  totpSetup: emptyBody,
  totpConfirm: z.object({ code: sixDigits }).strict(),
  recoveryCodes: emptyBody,
  passkeyOptions: emptyBody,
  passkeyRegister: z
    .object({
      challengeId: webauthnChallengeId,
      credential: registrationCredential,
      name: z.string().trim().min(1).max(60).refine(noControlChars, 'No control characters').optional(),
    })
    .strict(),
  passkeyRename: z
    .object({
      name: z.string().trim().min(1).max(60).refine(noControlChars, 'No control characters'),
    })
    .strict(),
  idParams: z.object({ id }),
  sessionsQuery: z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: z.enum(['active', 'all']).default('active'),
    sortBy: z.enum(['lastSeenAt', 'createdAt']).default('lastSeenAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  }),
  revokeOthers: emptyBody,
  mobileStart: z.object({ newMobile: mobileSchema, channel: channel.default('SMS') }).strict(),
  mobileConfirm: z.object({ challengeId: otpChallengeId, code: sixDigits }).strict(),
  email: z.object({ newEmail: emailSchema }).strict(),
  deletion: z.object({ confirmText: z.literal('DELETE'), reason: z.string().max(500).optional() }).strict(),
};
