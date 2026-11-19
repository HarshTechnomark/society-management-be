import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
} from 'node:crypto';
import { LIMITS } from './communication.constants';
import type { PushPayload, PushPort, PushResult, PushTarget } from './communication.ports';

/**
 * The real Web Push sender (BR-16-30, BR-16-36): RFC 8291 `aes128gcm` payload encryption and RFC 8292 VAPID, with `node:crypto` only. It answers
 * `{ ok: false, gone: true }` for 404 and 410 so the deliver step revokes the subscription at once. Endpoints outside the push-service allow-list are
 * never called (`PUSH_ENDPOINT_NOT_ALLOWED`; an SSRF guard as much as a validation).
 */
const b64u = (b: Buffer): string => b.toString('base64url');
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url');

/** 8.24: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`, `web.push.apple.com`, `*.push.apple.com`. */
const EXACT_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);
const SUFFIX_HOSTS = ['.notify.windows.com', '.push.apple.com'];
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const h = u.hostname.toLowerCase();
  return EXACT_HOSTS.has(h) || SUFFIX_HOSTS.some(s => h.endsWith(s) && h.length > s.length);
}

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, len: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, len));

export interface EncryptOptions {
  /** Tests only: a fixed ephemeral private key (32 bytes) and salt (16 bytes), as in RFC 8291 appendix A. */
  ephemeralPrivate?: Buffer;
  salt?: Buffer;
}
/** RFC 8291: the single-record `aes128gcm` body for a subscription's `p256dh` and `auth`. */
export function encryptPayload(
  plaintext: Buffer,
  p256dh: string,
  auth: string,
  o: EncryptOptions = {},
): Buffer {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const ecdh = createECDH('prime256v1');
  if (o.ephemeralPrivate) ecdh.setPrivateKey(o.ephemeralPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = o.salt ?? randomBytes(16);
  const prk = hkdf(
    authSecret,
    shared,
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]),
    32,
  );
  const cek = hkdf(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export interface VapidKeys {
  publicKey: string; // base64url, 65 bytes
  privateKey: string; // base64url, 32 bytes
  subject: string; // mailto: or https:
}
/** RFC 8292 `Authorization` header value for an endpoint. */
export function vapidAuthorization(endpoint: string, v: VapidKeys, nowMs: number): string {
  const pub = unb64u(v.publicKey);
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: v.privateKey,
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
    format: 'jwk',
  });
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(nowMs / 1000) + 12 * 3600,
        sub: v.subject,
      }),
    ),
  );
  const sig = cryptoSign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${v.publicKey}`;
}

export function pushPayloadJson(p: PushPayload): Buffer {
  const make = (body: string) =>
    Buffer.from(
      JSON.stringify({
        title: p.title,
        body,
        url: p.url,
        tag: p.tag,
        requireInteraction: p.requireInteraction,
      }),
    );
  let body = p.body;
  let out = make(body);
  while (out.length > LIMITS.pushPayloadMax && body.length > 0) {
    body = body.slice(0, Math.max(0, body.length - 100));
    out = make(body);
  }
  return out;
}

export interface SenderOptions {
  vapid: VapidKeys;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}
/** The `communicationPorts().push` implementation. */
export function createWebPushPort(o: SenderOptions): PushPort {
  const doFetch = o.fetchFn ?? fetch;
  return {
    publicKey: () => o.vapid.publicKey,
    async send(target: PushTarget, payload, opts): Promise<PushResult> {
      if (!isAllowedPushEndpoint(target.endpoint))
        return { ok: false, gone: false, error: 'PUSH_ENDPOINT_NOT_ALLOWED' };
      try {
        const body = encryptPayload(pushPayloadJson(payload), target.p256dh, target.authSecret);
        const res = await doFetch(target.endpoint, {
          method: 'POST',
          headers: {
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: String(opts.ttlSeconds),
            Urgency: opts.urgency,
            Authorization: vapidAuthorization(target.endpoint, o.vapid, Date.now()),
          },
          body: new Uint8Array(body),
          redirect: 'error',
          signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
        });
        if (res.status === 201 || res.status === 200 || res.status === 202)
          return {
            ok: true,
            providerMessageId: res.headers.get('location') ?? `push-${target.id}-${Date.now()}`,
          };
        if (res.status === 404 || res.status === 410)
          return { ok: false, gone: true, error: `PUSH_${res.status}` };
        return { ok: false, gone: false, error: `PUSH_HTTP_${res.status}` };
      } catch (err) {
        return {
          ok: false,
          gone: false,
          error: err instanceof Error ? err.name.slice(0, 40) : 'PUSH_FAILED',
        };
      }
    },
  };
}

/** The sender configured from `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`, or null when they are unset. */
export function webPushPortFromEnv(env: NodeJS.ProcessEnv = process.env): PushPort | null {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = env;
  if (!publicKey || !privateKey) return null;
  return createWebPushPort({
    vapid: { publicKey, privateKey, subject: env.VAPID_SUBJECT ?? 'mailto:support@societyapp.in' },
  });
}
