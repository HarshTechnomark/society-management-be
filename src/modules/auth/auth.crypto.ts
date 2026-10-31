import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import argon2 from 'argon2';
import { env } from '../../lib/env';

/** Hashing, encryption and one-time-code helpers for module 02 (section 13: secrets at rest). */
export const hmacHex = (key: string, data: string): string =>
  createHmac('sha256', key).update(data).digest('hex');
export const sha256Hex = (data: string): string => createHash('sha256').update(data).digest('hex');

/** HMAC of tokens, links and challenges with AUTH_TOKEN_PEPPER. */
export const hashToken = (raw: string): string => hmacHex(env().AUTH_TOKEN_PEPPER, raw);
/** HMAC of refresh tokens with JWT_REFRESH_PEPPER (BR-02-32). */
export const hashRefreshToken = (raw: string): string => hmacHex(env().JWT_REFRESH_PEPPER, raw);
/** BR-02-10: HMAC-SHA256(pepper, challengeId + ':' + code). */
export const hashOtp = (challengeId: string, code: string): string =>
  hmacHex(env().AUTH_TOKEN_PEPPER, `${challengeId}:${code}`);
export const hashRecoveryCode = (userId: number, normalisedCode: string): string =>
  hmacHex(env().AUTH_TOKEN_PEPPER, `${userId}:${normalisedCode}`);
/** BR-02-28: the lockout table holds no plain identifiers. */
export const lockoutSubjectHash = (scope: string, subject: string): string =>
  hmacHex(env().AUTH_TOKEN_PEPPER, `${scope}:${subject}`);
/** BR-02-34: value of the `sa_csrf` cookie. */
export const csrfTokenFor = (sessionId: number): string =>
  createHmac('sha256', env().JWT_ACCESS_SECRET).update(`csrf:${sessionId}`).digest('base64url');

export const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** 32 random bytes as 43 base64url characters, with an optional prefix such as `lc_`. */
export const randomToken = (prefix = ''): string => prefix + randomBytes(32).toString('base64url');

const B32_LOWER = 'abcdefghijklmnopqrstuvwxyz234567';
/** `otp_` + 24 characters [a-z2-7] (section 7.2). */
export const newChallengeId = (): string => {
  let s = 'otp_';
  const b = randomBytes(24);
  for (const x of b) s += B32_LOWER[x % 32];
  return s;
};

/** BR-02-7: six digits from crypto.randomInt, left-padded. */
export const newOtpCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

// ------------------------------------------------------------------ TOTP secret encryption (BR-02-21)
const aesKey = (): Buffer => Buffer.from(env().TOTP_ENCRYPTION_KEY, 'base64');

/** AES-256-GCM, stored as `v1:<iv>:<ciphertext>:<tag>` (base64, 12-byte IV). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', aesKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${ct.toString('base64')}:${c.getAuthTag().toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  const [v, iv, ct, tag] = stored.split(':');
  if (v !== 'v1' || !iv || !ct || !tag) throw new Error('Unsupported secret format');
  const d = createDecipheriv('aes-256-gcm', aesKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ------------------------------------------------------------------ passwords (BR-02-15, BR-02-16)
const ARGON_OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export const hashPassword = (password: string): Promise<string> =>
  argon2.hash(password.normalize('NFC'), ARGON_OPTIONS);

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password.normalize('NFC'));
  } catch {
    return false;
  }
}

export const passwordNeedsRehash = (hash: string): boolean => argon2.needsRehash(hash, ARGON_OPTIONS);

let dummyHash: Promise<string> | undefined;
/** Verified against when the account does not exist, so the response time does not tell (BR-02-16). */
export const getDummyHash = (): Promise<string> =>
  (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));

// ------------------------------------------------------------------ base32 and TOTP (RFC 4648, RFC 6238)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** BR-02-20: 20 random bytes as 32 base32 characters. */
export const newTotpSecret = (): string => base32Encode(randomBytes(20));
/** Groups of four for display: `JBSW Y3DP ...`. */
export const groupSecret = (s: string): string => s.match(/.{1,4}/g)!.join(' ');

export const TOTP_STEP_SECONDS = 30;

/** HOTP truncation with HMAC-SHA1 over an 8-byte counter, six digits. */
export function totpCode(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const off = h[h.length - 1] & 0xf;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export const totpStepAt = (ms: number): number => Math.floor(ms / 1000 / TOTP_STEP_SECONDS);

/** The step whose code equals `code` among current-1, current and current+1, or null (BR-02-20). */
export function matchTotpStep(secretBase32: string, code: string, atMs: number): number | null {
  const cur = totpStepAt(atMs);
  for (const step of [cur, cur - 1, cur + 1]) if (safeEqual(totpCode(secretBase32, step), code)) return step;
  return null;
}

// ------------------------------------------------------------------ recovery codes (BR-02-24)
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newRecoveryCode(): string {
  const pick = () => Array.from(randomBytes(4), b => CROCKFORD[b % 32]).join('');
  return `RC-${pick()}-${pick()}`;
}

/** Uppercase, remove spaces, add `RC-` and the middle hyphen when missing. */
export function normaliseRecoveryCode(input: string): string {
  let s = input.toUpperCase().replace(/\s+/g, '');
  if (!s.startsWith('RC-')) s = s.startsWith('RC') ? `RC-${s.slice(2)}` : `RC-${s}`;
  const body = s.slice(3).replace(/-/g, '');
  return body.length === 8 ? `RC-${body.slice(0, 4)}-${body.slice(4)}` : s;
}

export const RECOVERY_CODE_RE = /^RC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** 26-character ULID (Crockford base32 of a 48-bit time and 80 random bits). */
export function newUlid(atMs: number): string {
  let t = '';
  let n = BigInt(atMs);
  for (let i = 0; i < 10; i++) {
    t = CROCKFORD[Number(n % 32n)] + t;
    n /= 32n;
  }
  return t + Array.from(randomBytes(16), b => CROCKFORD[b % 32]).join('');
}
