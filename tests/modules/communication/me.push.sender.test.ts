import { createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createWebPushPort,
  encryptPayload,
  isAllowedPushEndpoint,
  pushPayloadJson,
  vapidAuthorization,
  webPushPortFromEnv,
} from '../../../src/modules/communication/communication.push.sender';

const EP = 'https://fcm.googleapis.com/fcm/send/abc';
const subKeys = {
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
};
const vapid = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const d = privateKey.export({ format: 'jwk' }).d!;
  const jwk = publicKey.export({ format: 'jwk' });
  const pub = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from(jwk.y!, 'base64url'),
  ]);
  return { publicKey: pub.toString('base64url'), privateKey: d, subject: 'mailto:ops@example.in' };
};

describe('T16-2 push sender', () => {
  it('encrypts exactly as the RFC 8291 appendix A example', () => {
    const out = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      subKeys.p256dh,
      subKeys.auth,
      {
        ephemeralPrivate: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
        salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
      },
    );
    expect(out.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('allows only the known push services (https, no credentials, no odd ports)', () => {
    for (const ok of [
      EP,
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://db5p.notify.windows.com/w/?token=x',
      'https://web.push.apple.com/Q',
      'https://api.sandbox.push.apple.com/3/device/x',
    ])
      expect(isAllowedPushEndpoint(ok), ok).toBe(true);
    for (const bad of [
      'http://fcm.googleapis.com/x',
      'https://evil.example.com/fcm.googleapis.com',
      'https://fcm.googleapis.com.evil.com/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://notify.windows.com/x',
      'https://169.254.169.254/latest',
      'not a url',
    ])
      expect(isAllowedPushEndpoint(bad), bad).toBe(false);
  });

  it('signs a VAPID token the public key verifies', () => {
    const v = vapid();
    const h = vapidAuthorization(EP, v, Date.UTC(2026, 10, 1));
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    expect(m[4]).toBe(v.publicKey);
    expect(JSON.parse(Buffer.from(m[2]!, 'base64url').toString())).toMatchObject({
      aud: 'https://fcm.googleapis.com',
      sub: 'mailto:ops@example.in',
    });
    const pub = Buffer.from(v.publicKey, 'base64url');
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    const ok = createVerify('sha256')
      .update(`${m[1]}.${m[2]}`)
      .verify({ key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3]!, 'base64url'));
    expect(ok).toBe(true);
  });

  it('keeps the payload under 3,072 bytes', () => {
    const big = pushPayloadJson({
      title: 't',
      body: 'x'.repeat(10_000),
      url: '/a',
      tag: 'k',
      requireInteraction: false,
    });
    expect(big.length).toBeLessThanOrEqual(3072);
  });

  it('send: 201 is ok; 404 and 410 are gone; other codes and network errors are plain failures; bad hosts are never called', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    let status = 201;
    const port = createWebPushPort({
      vapid: vapid(),
      fetchFn: (async (url: string, init: { headers: Record<string, string> }) => {
        calls.push({ url, headers: init.headers });
        if (status === 0) throw new Error('boom');
        return new Response(null, { status });
      }) as never,
    });
    const target = { id: 1, endpoint: EP, p256dh: subKeys.p256dh, authSecret: subKeys.auth };
    const payload = { title: 'T', body: 'B', url: '/x', tag: 'k', requireInteraction: true };
    const opts = { urgency: 'high' as const, ttlSeconds: 600 };
    expect((await port.send(target, payload, opts, 7)).ok).toBe(true);
    expect(calls[0]!.headers).toMatchObject({ TTL: '600', Urgency: 'high', 'Content-Encoding': 'aes128gcm' });
    status = 410;
    expect(await port.send(target, payload, opts, 7)).toMatchObject({ ok: false, gone: true });
    status = 404;
    expect(await port.send(target, payload, opts, 7)).toMatchObject({ ok: false, gone: true });
    status = 500;
    expect(await port.send(target, payload, opts, 7)).toMatchObject({
      ok: false,
      gone: false,
      error: 'PUSH_HTTP_500',
    });
    status = 0;
    expect(await port.send(target, payload, opts, 7)).toMatchObject({ ok: false, gone: false });
    const n = calls.length;
    expect(
      await port.send({ ...target, endpoint: 'https://evil.example.com/x' }, payload, opts, 7),
    ).toMatchObject({ ok: false, error: 'PUSH_ENDPOINT_NOT_ALLOWED' });
    expect(calls.length).toBe(n);
  });

  it('webPushPortFromEnv needs both keys', () => {
    expect(webPushPortFromEnv({} as never)).toBeNull();
    const v = vapid();
    const p = webPushPortFromEnv({
      VAPID_PUBLIC_KEY: v.publicKey,
      VAPID_PRIVATE_KEY: v.privateKey,
    } as never)!;
    expect(p.publicKey()).toBe(v.publicKey);
  });
});
