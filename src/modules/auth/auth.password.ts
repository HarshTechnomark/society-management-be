import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { env } from '../../lib/env';
import { logger } from '../../lib/logger';
import { UnprocessableError } from '../../utils/errors';

/** Password policy (BR-02-13) and breached-password check (BR-02-14). */
export const PASSWORD_RULES = ['len', 'case', 'num', 'sym', 'breach', 'email'] as const;
export type PasswordRule = (typeof PASSWORD_RULES)[number];

let breached: Set<string> | undefined;
/**
 * Loaded once into a Set. The bundled file holds lowercase SHA-1 hex lines. The spec names a 100,000-entry list;
 * this build ships a smaller list of the most common passwords in `breached-common.txt` (see the module notes).
 */
export function breachedSet(): Set<string> {
  if (!breached) {
    const file = path.join(__dirname, 'data', 'breached-common.txt');
    breached = new Set(
      readFileSync(file, 'utf8')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean),
    );
  }
  return breached;
}

export const sha1Hex = (s: string): string => createHash('sha1').update(s).digest('hex');

async function hibpPwned(sha1: string): Promise<boolean> {
  try {
    const r = await fetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5).toUpperCase()}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) throw new Error(`HIBP ${r.status}`);
    const suffix = sha1.slice(5).toUpperCase();
    return (await r.text()).split('\n').some(l => l.split(':')[0].trim() === suffix);
  } catch (err) {
    logger.warn({ err }, 'HIBP check failed; relying on the local list');
    return false;
  }
}

export interface PolicyOptions {
  email?: string | null;
  /** Skip the network call even when PASSWORD_BREACH_CHECK=hibp (unit tests). */
  localOnly?: boolean;
}

/** The keys of the rules the password fails; empty means it passes. */
export async function checkPasswordPolicy(
  password: string,
  opts: PolicyOptions = {},
): Promise<PasswordRule[]> {
  const p = password.normalize('NFC');
  const failed: PasswordRule[] = [];
  const len = [...p].length;
  if (len < 12 || len > 128) failed.push('len');
  if (!(/\p{Ll}/u.test(p) && /\p{Lu}/u.test(p))) failed.push('case');
  if (!/\p{Nd}/u.test(p)) failed.push('num');
  if (!/[^\p{L}\p{Nd}]/u.test(p)) failed.push('sym');
  const sha = sha1Hex(p.toLowerCase());
  let isBreached = breachedSet().has(sha);
  if (!isBreached && !opts.localOnly && env().PASSWORD_BREACH_CHECK === 'hibp')
    isBreached = await hibpPwned(sha1Hex(p));
  if (isBreached) failed.push('breach');
  const local = opts.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 3 && p.toLowerCase().includes(local)) failed.push('email');
  return failed;
}

/** Throws `422 PASSWORD_POLICY_FAILED` with one `errors[]` item per failed rule. */
export async function assertPasswordPolicy(password: string, opts: PolicyOptions = {}): Promise<void> {
  const failed = await checkPasswordPolicy(password, opts);
  if (failed.length)
    throw new UnprocessableError(
      'PASSWORD_POLICY_FAILED',
      'Password does not meet the rules',
      failed.map(rule => ({ field: 'password', message: rule })),
    );
}
