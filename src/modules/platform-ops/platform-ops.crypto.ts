import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env, parseKeyRing } from '../../lib/env';
import { logger } from '../../lib/logger';
import { AppError, ValidationError } from '../../utils/errors';

/**
 * Provider credential encryption (BR-07-20). AES-256-GCM, 12 random IV bytes per encryption, 16 byte tag, AAD
 * `service_providers|<providerKey>|<keyVersion>` (a ciphertext moved to another row fails authentication). Plaintext is the
 * canonical JSON (sorted keys) of the credentials object, at most 4096 bytes. Key ring: env `PROVIDER_CREDENTIALS_KEYS`.
 */
export interface SealedCredentials {
  enc: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

export const keyUnavailable = () =>
  new AppError(500, 'CREDENTIALS_KEY_UNAVAILABLE', 'The credentials encryption key is not available');

let ringCache: { raw: string; ring: Map<number, Buffer> } | undefined;
function keyRing(): Map<number, Buffer> {
  const raw = env().PROVIDER_CREDENTIALS_KEYS;
  if (!raw) {
    logger.fatal('PROVIDER_CREDENTIALS_KEYS is not set');
    throw keyUnavailable();
  }
  if (ringCache?.raw !== raw) ringCache = { raw, ring: parseKeyRing(raw) };
  return ringCache.ring;
}

export function activeKeyVersion(): number {
  const v = env().PROVIDER_CREDENTIALS_ACTIVE_KEY_VERSION;
  if (v === undefined || !keyRing().has(v)) {
    logger.fatal('The active provider credentials key version is missing from the key ring');
    throw keyUnavailable();
  }
  return v;
}

const aad = (providerKey: string, version: number) =>
  Buffer.from(`service_providers|${providerKey}|${version}`, 'utf8');

/** Sorted-key JSON so the same credentials always produce the same plaintext. */
export const canonicalJson = (o: Record<string, string>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.keys(o)
        .sort()
        .map(k => [k, o[k]]),
    ),
  );

export function encryptCredentials(
  providerKey: string,
  creds: Record<string, string>,
  version = activeKeyVersion(),
): SealedCredentials {
  const key = keyRing().get(version);
  if (!key) throw keyUnavailable();
  const plain = Buffer.from(canonicalJson(creds), 'utf8');
  if (plain.length > 4096)
    throw new ValidationError([{ field: 'credentials', message: 'Credentials are too large' }]);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad(providerKey, version));
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return { enc, iv, tag: c.getAuthTag(), keyVersion: version };
}

/** Throws `CREDENTIALS_KEY_UNAVAILABLE` for a missing key version and for any failed authentication (never logs values). */
export function decryptCredentials(providerKey: string, s: SealedCredentials): Record<string, string> {
  const key = keyRing().get(s.keyVersion);
  if (!key) {
    logger.fatal({ providerKey, keyVersion: s.keyVersion }, 'provider credentials key version missing');
    throw keyUnavailable();
  }
  try {
    const d = createDecipheriv('aes-256-gcm', key, s.iv);
    d.setAAD(aad(providerKey, s.keyVersion));
    d.setAuthTag(s.tag);
    return JSON.parse(Buffer.concat([d.update(s.enc), d.final()]).toString('utf8')) as Record<string, string>;
  } catch {
    logger.fatal({ providerKey, keyVersion: s.keyVersion }, 'provider credentials failed to decrypt');
    throw keyUnavailable();
  }
}

const DOTS = '••••••••';
/** BR-07-21: each secret as eight dots plus its last 4 characters when it has at least 16, else the dots only. */
export function maskCredentials(creds: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(creds)
      .sort()
      .map(k => [k, creds[k]!.length >= 16 ? `${DOTS}${creds[k]!.slice(-4)}` : DOTS]),
  );
}
