import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { env } from '../../lib/env';
import { AppError } from '../../utils/errors';

/**
 * Bank account number protection (BR-13-35). AES-256-GCM: the stored value is `iv (12) + tag (16) + ciphertext`, the AAD binds it to
 * the society (a value copied into another society's row fails authentication). The uniqueness hash is HMAC-SHA-256 of
 * `ifsc + number` under the same key. Key: env `BANK_ACCOUNT_ENCRYPTION_KEY` (base64, 32 bytes, required in production). In
 * development and tests, when it is unset, a fixed built-in key is used so no `.env` file has to change; never rely on it in production.
 */
const DEV_KEY = createHash('sha256').update('societyapp-dev-bank-account-key').digest();

function key(): Buffer {
  const raw = env().BANK_ACCOUNT_ENCRYPTION_KEY;
  if (raw) return Buffer.from(raw, 'base64');
  if (env().NODE_ENV === 'production')
    throw new AppError(500, 'BANK_KEY_UNAVAILABLE', 'The bank account encryption key is not available');
  return DEV_KEY;
}

const aad = (societyId: number) => Buffer.from(`bank_accounts|${societyId}`, 'utf8');

export function encryptAccountNumber(societyId: number, accountNumber: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(aad(societyId));
  const enc = Buffer.concat([c.update(accountNumber, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

export function decryptAccountNumber(societyId: number, blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAAD(aad(societyId));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
}

export const accountNumberHash = (ifsc: string, accountNumber: string): string =>
  createHmac('sha256', key()).update(`${ifsc}${accountNumber}`).digest('hex');

export const last4 = (accountNumber: string): string => accountNumber.slice(-4);
export const maskNumber = (l4: string): string => `XXXXXX${l4}`;
