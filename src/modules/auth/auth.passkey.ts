import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Transaction } from 'sequelize';
import { AuthToken, Session, User, UserPasskey, sequelize } from '../../models';
import { env } from '../../lib/env';
import { now } from '../../lib/clock';
import { notify } from '../../lib/notify';
import { AppError, ConflictError, NotFoundError } from '../../utils/errors';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { assertMethod, requireApp } from './auth.apps';
import { issueToken, ttl } from './auth.links';
import { completeFirstFactor, consumeToken, isError, type OrError, type SignInOutcome } from './auth.signin';
import { hashToken } from './auth.crypto';
import { MAX_PASSKEYS } from './auth.types';
import { safeAfterCommit, txOutcome } from './auth.util';

const CHALLENGE_TTL = 5 * 60_000;
const invalidChallenge = () => new AppError(401, 'CHALLENGE_INVALID', 'Start again');
const invalidPasskey = (msg = 'That passkey could not be verified') =>
  new AppError(401, 'PASSKEY_INVALID', msg);

const expectedOrigins = (ctx: Ctx): string[] => (ctx.origin ? [ctx.origin] : env().appOrigins);

async function newChallenge(
  ctx: Ctx,
  tx: Transaction,
  kind: 'LOGIN' | 'REGISTER' | 'REAUTH',
  challenge: string,
  bind: { userId?: number | null; sessionId?: number | null },
): Promise<string> {
  const t = await issueToken(ctx, tx, {
    purpose: 'WEBAUTHN_CHALLENGE',
    prefix: 'wc_',
    userId: bind.userId ?? null,
    sessionId: bind.sessionId ?? null,
    payload: { challenge, kind, clientApp: ctx.clientApp },
    expiresAt: ttl(CHALLENGE_TTL),
  });
  return t.raw;
}

/** Single use: consumes the challenge and returns the stored challenge value, or throws `CHALLENGE_INVALID`. */
async function takeChallenge(
  ctx: Ctx,
  tx: Transaction,
  raw: string,
  kind: 'LOGIN' | 'REGISTER' | 'REAUTH',
  bind: { userId?: number; sessionId?: number } = {},
): Promise<string> {
  const token = await AuthToken.findOne({
    where: { tokenHash: hashToken(raw), purpose: 'WEBAUTHN_CHALLENGE' },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  const p = token?.payload ?? {};
  if (
    !token ||
    token.consumedAt ||
    token.revokedAt ||
    token.expiresAt <= now() ||
    p.kind !== kind ||
    p.clientApp !== ctx.clientApp ||
    (bind.userId !== undefined && token.userId !== bind.userId) ||
    (bind.sessionId !== undefined && token.sessionId !== bind.sessionId)
  )
    throw invalidChallenge();
  if (!(await consumeToken(tx, token.id!))) throw invalidChallenge();
  return String(p.challenge);
}

const credentialOf = (p: UserPasskey) => ({
  id: p.credentialId,
  publicKey: new Uint8Array(p.publicKey),
  counter: p.signCount,
  transports: (p.transports ?? undefined) as never,
});

export interface PasskeyView {
  id: number;
  name: string;
  deviceType: string;
  createdAt: string;
  lastUsedAt: string | null;
}
export const passkeyView = (p: UserPasskey): PasskeyView => ({
  id: p.id!,
  name: p.name,
  deviceType: p.deviceType,
  createdAt: p.createdAt!.toISOString(),
  lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
});

// ------------------------------------------------------------------ sign-in (8.6, 8.7)
export async function passkeyLoginOptions(ctx: Ctx) {
  const app = requireApp(ctx.clientApp);
  assertMethod(app, 'passkey');
  const o = await generateAuthenticationOptions({
    rpID: env().WEBAUTHN_RP_ID,
    timeout: 120_000,
    userVerification: 'required',
    allowCredentials: [],
  });
  const challengeId = await sequelize.transaction(tx => newChallenge(ctx, tx, 'LOGIN', o.challenge, {}));
  return {
    challengeId,
    publicKey: {
      challenge: o.challenge,
      rpId: env().WEBAUTHN_RP_ID,
      timeout: 120_000,
      userVerification: 'required',
      allowCredentials: [],
    },
  };
}

/** Runs the WebAuthn assertion check. Returns the new counter; throws `PASSKEY_INVALID` (and audits a cloned key). */
async function checkAssertion(
  ctx: Ctx,
  tx: Transaction,
  passkey: UserPasskey,
  credential: AuthenticationResponseJSON,
  expectedChallenge: string,
  actor: { userId: number; name: string; role: string },
): Promise<void> {
  try {
    const v = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: expectedOrigins(ctx),
      expectedRPID: env().WEBAUTHN_RP_ID,
      credential: credentialOf(passkey),
      requireUserVerification: true,
    });
    if (!v.verified) throw new Error('not verified');
    passkey.signCount = v.authenticationInfo.newCounter;
    passkey.lastUsedAt = now();
    await passkey.save({ transaction: tx });
  } catch (err) {
    if (/counter/i.test((err as Error).message))
      await audit(
        ctx,
        {
          action: 'auth.passkey.counter_mismatch',
          entityType: 'user',
          entityId: passkey.userId,
          after: { passkeyId: passkey.id },
          actor,
        },
        tx,
      );
    throw invalidPasskey();
  }
}

export async function passkeyLogin(
  ctx: Ctx,
  input: { challengeId: string; credential: AuthenticationResponseJSON },
): Promise<SignInOutcome> {
  const app = requireApp(ctx.clientApp);
  assertMethod(app, 'passkey');
  return txOutcome<SignInOutcome>(async tx => {
    let expected: string;
    try {
      expected = await takeChallenge(ctx, tx, input.challengeId, 'LOGIN');
    } catch (e) {
      return { error: e as AppError };
    }
    const passkey = await UserPasskey.findOne({
      where: { credentialId: input.credential.id },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!passkey) return { error: invalidPasskey() };
    const user = await User.scope('withSecrets').findByPk(passkey.userId, { transaction: tx });
    if (!user || user.status === 'SYSTEM' || user.status === 'DELETED') return { error: invalidPasskey() };
    const actor = { userId: user.id!, name: user.name ?? 'User', role: 'user' };
    try {
      await checkAssertion(ctx, tx, passkey, input.credential, expected, actor);
    } catch (e) {
      await audit(
        ctx,
        {
          action: 'auth.login.failed',
          entityType: 'user',
          entityId: user.id!,
          after: { method: 'PASSKEY' },
          actor,
        },
        tx,
      );
      return { error: e as AppError };
    }
    const out = await completeFirstFactor(ctx, tx, user, 'PASSKEY');
    if (isError(out)) return out;
    return out;
  });
}

// ------------------------------------------------------------------ step-up (8.16)
export async function reauthPasskeyOptions(ctx: Ctx) {
  const userId = ctx.user!.id;
  const list = await UserPasskey.findAll({ where: { userId } });
  if (!list.length) throw new NotFoundError('PASSKEY_NOT_FOUND', 'No passkey on this account');
  const o = await generateAuthenticationOptions({
    rpID: env().WEBAUTHN_RP_ID,
    timeout: 120_000,
    userVerification: 'required',
    allowCredentials: list.map(p => ({
      id: p.credentialId,
      transports: (p.transports ?? undefined) as never,
    })),
  });
  const challengeId = await sequelize.transaction(tx =>
    newChallenge(ctx, tx, 'REAUTH', o.challenge, { userId, sessionId: ctx.session!.id }),
  );
  return {
    challengeId,
    publicKey: {
      challenge: o.challenge,
      rpId: env().WEBAUTHN_RP_ID,
      timeout: 120_000,
      userVerification: 'required',
      allowCredentials: o.allowCredentials,
    },
  };
}

/** Verifies a step-up passkey assertion for the signed-in user and session. */
export async function verifyReauthPasskey(
  ctx: Ctx,
  tx: Transaction,
  input: { challengeId: string; credential: AuthenticationResponseJSON },
): Promise<OrError<true>> {
  let expected: string;
  try {
    expected = await takeChallenge(ctx, tx, input.challengeId, 'REAUTH', {
      userId: ctx.user!.id,
      sessionId: ctx.session!.id,
    });
  } catch (e) {
    return { error: e as AppError };
  }
  const passkey = await UserPasskey.findOne({
    where: { credentialId: input.credential.id, userId: ctx.user!.id },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  if (!passkey) return { error: invalidPasskey() };
  try {
    await checkAssertion(ctx, tx, passkey, input.credential, expected, {
      userId: ctx.user!.id,
      name: ctx.user!.name ?? 'User',
      role: 'user',
    });
  } catch (e) {
    return { error: e as AppError };
  }
  return true;
}

// ------------------------------------------------------------------ registration (8.26)
export async function passkeyRegisterOptions(ctx: Ctx) {
  const userId = ctx.user!.id;
  const user = (await User.findByPk(userId))!;
  const list = await UserPasskey.findAll({ where: { userId } });
  if (list.length >= MAX_PASSKEYS)
    throw new ConflictError('PASSKEY_LIMIT_REACHED', 'You can have up to 10 passkeys');
  const label = user.email ?? user.mobile ?? String(userId);
  const o = await generateRegistrationOptions({
    rpName: env().WEBAUTHN_RP_NAME,
    rpID: env().WEBAUTHN_RP_ID,
    userID: new TextEncoder().encode(String(userId)),
    userName: label,
    userDisplayName: user.name ?? label,
    attestationType: 'none',
    timeout: 120_000,
    excludeCredentials: list.map(p => ({
      id: p.credentialId,
      transports: (p.transports ?? undefined) as never,
    })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -257],
  });
  const challengeId = await sequelize.transaction(tx =>
    newChallenge(ctx, tx, 'REGISTER', o.challenge, { userId, sessionId: ctx.session!.id }),
  );
  return { challengeId, publicKey: o };
}

export async function passkeyRegister(
  ctx: Ctx,
  input: { challengeId: string; credential: RegistrationResponseJSON; name?: string },
): Promise<PasskeyView> {
  const userId = ctx.user!.id;
  return txOutcome<PasskeyView>(async tx => {
    let expected: string;
    try {
      expected = await takeChallenge(ctx, tx, input.challengeId, 'REGISTER', {
        userId,
        sessionId: ctx.session!.id,
      });
    } catch (e) {
      return { error: e as AppError };
    }
    if ((await UserPasskey.count({ where: { userId }, transaction: tx })) >= MAX_PASSKEYS)
      return { error: new ConflictError('PASSKEY_LIMIT_REACHED', 'You can have up to 10 passkeys') };
    let info;
    try {
      const v = await verifyRegistrationResponse({
        response: input.credential,
        expectedChallenge: expected,
        expectedOrigin: expectedOrigins(ctx),
        expectedRPID: env().WEBAUTHN_RP_ID,
        requireUserVerification: true,
      });
      if (!v.verified || !v.registrationInfo) throw new Error('not verified');
      info = v.registrationInfo;
    } catch {
      return { error: invalidPasskey('That passkey could not be registered') };
    }
    if (await UserPasskey.findOne({ where: { credentialId: info.credential.id }, transaction: tx }))
      return { error: new ConflictError('PASSKEY_ALREADY_REGISTERED', 'This passkey is already registered') };
    const s = await Session.findByPk(ctx.session!.id, { transaction: tx });
    const row = await UserPasskey.create(
      {
        userId,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey),
        signCount: info.credential.counter,
        transports: (info.credential.transports as string[] | undefined) ?? null,
        aaguid: info.aaguid ?? null,
        deviceType: info.credentialDeviceType === 'multiDevice' ? 'MULTI_DEVICE' : 'SINGLE_DEVICE',
        isBackedUp: info.credentialBackedUp,
        name: (input.name ?? `Passkey on ${s?.deviceLabel ?? 'this device'}`).slice(0, 60),
        lastUsedAt: null,
      },
      { transaction: tx },
    );
    await audit(
      ctx,
      {
        action: 'auth.passkey.added',
        entityType: 'user',
        entityId: userId,
        after: { passkeyId: row.id, name: row.name },
      },
      tx,
    );
    safeAfterCommit(tx, () => notify('auth.passkey_added', [{ userId }], { name: row.name }));
    return passkeyView(row);
  });
}
