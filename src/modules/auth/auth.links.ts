import type { Transaction } from 'sequelize';
import { AuthToken } from '../../models';
import type { TokenPurpose } from '../../models/auth-token.model';
import { addMs, now } from '../../lib/clock';
import { AppError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { hashToken, randomToken } from './auth.crypto';
import { consumeToken } from './auth.signin';

/** Single-use link tokens: reset, setup, email verify, signup, support hand-off (section 7.4). */
export type LinkProblem = 'INVALID' | 'EXPIRED' | 'USED';

export async function issueToken(
  ctx: Ctx,
  tx: Transaction,
  v: {
    purpose: TokenPurpose;
    prefix?: string;
    userId: number | null;
    sessionId?: number | null;
    payload?: Record<string, unknown> | null;
    expiresAt: Date;
    createdBy?: number | null;
    /** Revoke unused older tokens of the same user and purpose first (BR-02-18). */
    revokeOlder?: boolean;
  },
): Promise<{ raw: string; expiresAt: Date; id: number }> {
  if (v.revokeOlder && v.userId !== null)
    await AuthToken.update(
      { revokedAt: now() },
      { where: { userId: v.userId, purpose: v.purpose, consumedAt: null, revokedAt: null }, transaction: tx },
    );
  const raw = randomToken(v.prefix ?? '');
  const row = await AuthToken.create(
    {
      tokenHash: hashToken(raw),
      purpose: v.purpose,
      userId: v.userId,
      sessionId: v.sessionId ?? null,
      payload: v.payload ?? null,
      attemptCount: 0,
      expiresAt: v.expiresAt,
      consumedAt: null,
      revokedAt: null,
      ip: ctx.ip || null,
      userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 255) : null,
      createdBy: v.createdBy ?? null,
    },
    { transaction: tx },
  );
  return { raw, expiresAt: v.expiresAt, id: row.id! };
}

export const ttl = (ms: number): Date => addMs(now(), ms);

export function classify(token: AuthToken | null): LinkProblem | null {
  if (!token || token.revokedAt) return 'INVALID';
  if (token.consumedAt) return 'USED';
  if (token.expiresAt <= now()) return 'EXPIRED';
  return null;
}

export const linkError = (p: LinkProblem): AppError => {
  const code = `LINK_${p}`;
  const msg = {
    INVALID: 'This link is not valid',
    EXPIRED: 'This link has expired',
    USED: 'This link was already used',
  }[p];
  return new AppError(400, code, msg);
};

/** Finds a token of a purpose by its raw value. Returns the row (any state) or null. */
export async function findToken(
  raw: string,
  purpose: TokenPurpose,
  tx?: Transaction,
  lock = false,
): Promise<AuthToken | null> {
  return AuthToken.findOne({
    where: { tokenHash: hashToken(raw), purpose },
    transaction: tx,
    ...(lock && tx ? { lock: tx.LOCK.UPDATE } : {}),
  });
}

/** Validates a token and throws the matching `LINK_*` error. */
export async function requireValidToken(
  raw: string,
  purpose: TokenPurpose,
  tx?: Transaction,
  lock = false,
): Promise<AuthToken> {
  const token = await findToken(raw, purpose, tx, lock);
  const problem = classify(token);
  if (problem) throw linkError(problem);
  return token!;
}

/** Consumes a validated token; 0 affected rows means it was already used (section 7.4). */
export async function consumeOrThrow(tx: Transaction, token: AuthToken): Promise<void> {
  if (!(await consumeToken(tx, token.id!))) throw linkError('USED');
}
