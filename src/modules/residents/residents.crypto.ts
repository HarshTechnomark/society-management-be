import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../../lib/env';

/**
 * AES-256-GCM of the emergency-profile medical notes (section 7.10, 13). Format `iv(12) ‖ tag(16) ‖ ciphertext`, key
 * `RESIDENT_DATA_KEY`. The plaintext never reaches the database, a log line or an audit row.
 */
const key = (): Buffer => Buffer.from(env().RESIDENT_DATA_KEY, 'base64');

export function encryptNotes(plain: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function decryptNotes(blob: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
}
