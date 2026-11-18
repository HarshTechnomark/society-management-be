import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { env } from '../../lib/env';

/**
 * AES-256-GCM of `dataEnc`, `destinationEnc` and `authSecretEnc` (BR-16-31, `NOTIFY_DATA_KEY`) and the HMAC of anonymous survey respondents
 * (BR-16-48, `SURVEY_ANON_KEY`). Development and tests fall back to fixed built-in keys when the variables are unset (like module 13);
 * production requires them.
 */
const DEV_DATA_KEY = createHash('sha256').update('societyapp-notify-data-dev-key').digest();
const DEV_ANON_KEY = createHash('sha256').update('societyapp-survey-anon-dev-key').digest();

function key(name: 'NOTIFY_DATA_KEY' | 'SURVEY_ANON_KEY'): Buffer {
  const raw = process.env[name];
  if (raw) {
    const k = Buffer.from(raw, 'base64');
    if (k.length !== 32) throw new Error(`${name} must be 32 bytes in base64`);
    return k;
  }
  if (env().NODE_ENV === 'production') throw new Error(`${name} is required in production`);
  return name === 'NOTIFY_DATA_KEY' ? DEV_DATA_KEY : DEV_ANON_KEY;
}

/** `iv(12) | tag(16) | ciphertext`. */
export function encrypt(plain: string | Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key('NOTIFY_DATA_KEY'), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
export function decrypt(blob: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', key('NOTIFY_DATA_KEY'), blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
}
export const encryptJson = (v: unknown): Buffer => encrypt(JSON.stringify(v));
export const decryptJson = <T>(blob: Buffer): T => JSON.parse(decrypt(blob)) as T;

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
/** `m:<sha256(mobile) first 32 hex>` (7.4 `recipientKey`). */
export const mobileKey = (mobile: string): string => `m:${sha256Hex(mobile).slice(0, 32)}`;
export const emailKey = (email: string): string => `e:${sha256Hex(email.toLowerCase()).slice(0, 32)}`;
export const userKey = (userId: number): string => `u:${userId}`;

/** `98XXXXX111` (10-digit mobile) and `r****@mail.in` (7.4 `destinationMasked`). */
export function maskMobile(m: string): string {
  const d = m.replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `${d.slice(0, 2)}XXXXX${d.slice(-3)}` : 'XXXXXXXXXX';
}
export function maskEmail(e: string): string {
  const [local = '', domain = ''] = e.split('@');
  return `${local.slice(0, 1)}****@${domain}`;
}

/** BR-16-48: `respondentKey` = HMAC-SHA256(`SURVEY_ANON_KEY`, `surveyId:PERSON:userId` or `surveyId:FLAT:unitId`); named surveys use plain sha256 of the same input. */
export function respondentKey(
  surveyId: number,
  scope: 'PERSON' | 'FLAT',
  id: number,
  anonymous: boolean,
): string {
  const input = `${surveyId}:${scope}:${id}`;
  return anonymous
    ? createHmac('sha256', key('SURVEY_ANON_KEY')).update(input).digest('hex')
    : sha256Hex(input);
}
