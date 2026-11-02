import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Incident, ServiceProvider, closeDb, sequelize } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { listInbox } from '../../../src/lib/inbox';
import { env, parseEnv } from '../../../src/lib/env';
import { drainQueues } from '../../../src/lib/queue';
import {
  canonicalJson,
  decryptCredentials,
  encryptCredentials,
  maskCredentials,
} from '../../../src/modules/platform-ops/platform-ops.crypto';
import {
  checkAll,
  nextAutoStatus,
  runCheck,
  runProviderHealthChecks,
  runUptimeRollup,
} from '../../../src/modules/platform-ops/platform-ops.providers.health';
import {
  listEnabledProviders,
  resolveProvider,
} from '../../../src/modules/platform-ops/platform-ops.providers.registry';
import { rekeyProviders } from '../../../src/modules/platform-ops/platform-ops.providers.rekey';
import { idem, resetLogins } from '../../helpers/access';
import { platformAs } from '../../helpers/societies';
import { resetOps } from '../../helpers/platform-ops';
import { MSG91_CONFIG, MSG91_CREDS, fakeProvider } from '../../helpers/ops-providers';

afterAll(closeDb);
beforeEach(async () => {
  await resetOps();
  resetLogins();
  setNow('2026-10-30T04:00:00Z');
});

const ring2 = (): string => `1:${randomBytes(32).toString('base64')},2:${randomBytes(32).toString('base64')}`;

describe('credentials encryption (BR-07-20, T07-16)', () => {
  it('round trips; a changed ciphertext byte, a changed tag and a swapped provider key all fail', () => {
    const creds = { authKey: 'abcdefghij0123456789klmnopqr3f9a', extra: 'x' };
    const s = encryptCredentials('sms_a', creds);
    expect(decryptCredentials('sms_a', s)).toEqual(creds);
    expect(s.iv).toHaveLength(12);
    expect(s.tag).toHaveLength(16);
    expect(s.enc.toString('utf8')).not.toContain('abcdefghij');
    const flipped = Buffer.from(s.enc);
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptCredentials('sms_a', { ...s, enc: flipped })).toThrowError(/not available/);
    expect(() => decryptCredentials('sms_b', s)).toThrowError(/not available/); // AAD binds the provider key
    const tag = Buffer.from(s.tag);
    tag[0] = tag[0]! ^ 1;
    expect(() => decryptCredentials('sms_a', { ...s, tag })).toThrowError();
    expect(encryptCredentials('sms_a', creds).iv.equals(s.iv)).toBe(false); // new IV every time
  });

  it('plaintext is canonical JSON with sorted keys and at most 4096 bytes', () => {
    expect(canonicalJson({ b: '2', a: '1' })).toBe('{"a":"1","b":"2"}');
    expect(() => encryptCredentials('sms_a', { k: 'x'.repeat(5000) })).toThrowError(/Validation failed/);
  });

  it('masks a secret of 16 characters or more with its last 4, a shorter one with the dots only', () => {
    expect(maskCredentials({ authKey: 'abcdefghij0123456789klmnopqr3f9a', pin: 'short' })).toEqual({
      authKey: '••••••••3f9a',
      pin: '••••••••',
    });
  });

  it('a missing key version is CREDENTIALS_KEY_UNAVAILABLE', () => {
    const s = encryptCredentials('sms_a', { a: 'b' });
    expect(() => decryptCredentials('sms_a', { ...s, keyVersion: 99 })).toThrowError(/not available/);
  });

  it('the key ring in the environment is validated: 32 bytes each, unique versions, active version present', async () => {
    const base = { ...process.env };
    const good = ring2();
    expect(() =>
      parseEnv({ ...base, PROVIDER_CREDENTIALS_KEYS: good, PROVIDER_CREDENTIALS_ACTIVE_KEY_VERSION: '2' }),
    ).not.toThrow();
    expect(() =>
      parseEnv({ ...base, PROVIDER_CREDENTIALS_KEYS: good, PROVIDER_CREDENTIALS_ACTIVE_KEY_VERSION: '3' }),
    ).toThrowError(/ACTIVE_KEY_VERSION/);
    expect(() =>
      parseEnv({
        ...base,
        PROVIDER_CREDENTIALS_KEYS: '1:AAAA',
        PROVIDER_CREDENTIALS_ACTIVE_KEY_VERSION: '1',
      }),
    ).toThrowError(/32 bytes/);
    const k = randomBytes(32).toString('base64');
    expect(() =>
      parseEnv({
        ...base,
        PROVIDER_CREDENTIALS_KEYS: `1:${k},1:${k}`,
        PROVIDER_CREDENTIALS_ACTIVE_KEY_VERSION: '1',
      }),
    ).toThrowError(/unique/);
    expect(env().PROVIDER_CREDENTIALS_ACTIVE_KEY_VERSION).toBe(2);
  });
});

describe('provider routes (8.5)', () => {
  it('T07-17 creates with credentials: response has only masked values, the row holds ciphertext, the audit row has no secret', async () => {
    const admin = await platformAs('super_admin');
    const r = await admin.c(
      'post',
      '/platform/providers',
      {
        providerKey: 'sms_msg91_primary',
        channel: 'SMS',
        vendor: 'MSG91',
        displayName: 'SMS gateway (DLT)',
        description: 'OTP and alerts',
        priority: 1,
        config: MSG91_CONFIG,
        credentials: MSG91_CREDS,
      },
      { headers: idem() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      providerKey: 'sms_msg91_primary',
      isEnabled: false,
      credentialsMasked: { authKey: '••••••••3f9a' },
      credentialsSource: 'DATABASE',
      health: { status: 'UNKNOWN', mode: 'AUTOMATIC' },
      version: 1,
    });
    expect(JSON.stringify(r.body)).not.toContain('abcdefghij');
    const get = await admin.c('get', `/platform/providers/${r.body.data.id}`);
    expect(JSON.stringify(get.body)).not.toContain('abcdefghij');
    expect(JSON.stringify(get.body)).not.toContain('credentialsEnc');
    const row = (await ServiceProvider.scope('withSecrets').findByPk(r.body.data.id))!;
    expect(row.credentialsEnc).not.toBeNull();
    expect(row.credentialsKeyVersion).toBe(2);
    expect(row.credentialsEnc!.toString('latin1')).not.toContain('abcdefghij');
    const audits = await AuditLog.findAll({ where: { entityType: 'service_provider' } });
    expect(audits.map(a => a.action)).toEqual(['platform.provider.created']);
    expect(JSON.stringify(audits)).not.toContain('abcdefghij');
    expect(JSON.stringify(audits)).not.toContain('3f9a');
    // replace the credentials: new masked view, audit says only that credentials changed
    const put = await admin.c('put', `/platform/providers/${row.id}/credentials`, {
      version: 1,
      credentials: { authKey: 'ZZZZZZZZZZ0123456789ZZZZZZZZ77aa' },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data.credentialsMasked).toEqual({ authKey: '••••••••77aa' });
    expect(put.body.data.version).toBe(2);
    const a2 = await AuditLog.findOne({ where: { action: 'platform.provider.credentials_updated' } });
    expect(a2!.after).toEqual({ updated: ['credentials'], keyVersion: 2 });
    expect(JSON.stringify(a2)).not.toContain('ZZZZZZZZZZ');
  });

  it('T07-18 a credentials object with an extra field is CREDENTIALS_SCHEMA_INVALID and lists field names only', async () => {
    const admin = await platformAs('super_admin');
    const secret = 'abcdefghij0123456789klmnopqrSECRET';
    const r = await admin.c(
      'post',
      '/platform/providers',
      {
        providerKey: 'sms_a',
        channel: 'SMS',
        vendor: 'MSG91',
        displayName: 'SMS A',
        priority: 1,
        config: MSG91_CONFIG,
        credentials: { authKey: secret, password: 'hunter2hunter2' },
      },
      { headers: idem() },
    );
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('CREDENTIALS_SCHEMA_INVALID');
    expect(r.body.errors.map((e: any) => e.field)).toEqual(['password']);
    expect(JSON.stringify(r.body)).not.toContain('hunter2');
    expect(JSON.stringify(r.body)).not.toContain('SECRET');
    const missing = await admin.c(
      'post',
      '/platform/providers',
      {
        providerKey: 'sms_a',
        channel: 'SMS',
        vendor: 'MSG91',
        displayName: 'SMS A',
        priority: 1,
        config: MSG91_CONFIG,
      },
      { headers: idem() },
    );
    expect(missing.body.code).toBe('CREDENTIALS_SCHEMA_INVALID');
    const badConfig = await admin.c(
      'post',
      '/platform/providers',
      {
        providerKey: 'sms_a',
        channel: 'SMS',
        vendor: 'MSG91',
        displayName: 'SMS A',
        priority: 1,
        config: { senderId: 'x' },
        credentials: MSG91_CREDS,
      },
      { headers: idem() },
    );
    expect(badConfig.body.code).toBe('CONFIG_SCHEMA_INVALID');
    const wrongVendor = await admin.c(
      'post',
      '/platform/providers',
      {
        providerKey: 'sms_a',
        channel: 'EMAIL',
        vendor: 'MSG91',
        displayName: 'SMS A',
        priority: 1,
        config: {},
      },
      { headers: idem() },
    );
    expect(wrongVendor.body.code).toBe('VENDOR_NOT_ALLOWED_FOR_CHANNEL');
    expect(await ServiceProvider.count()).toBe(0);
  });

  it('a vendor on the environment refuses credentials; a Razorpay key id must match the mode', async () => {
    const admin = await platformAs('super_admin');
    const fake = await admin.c(
      'post',
      '/platform/providers',
      {
        providerKey: 'sms_f',
        channel: 'SMS',
        vendor: 'FAKE',
        displayName: 'SMS fake',
        priority: 1,
        config: { failMode: 'none' },
        credentials: { a: 'b' },
      },
      { headers: idem() },
    );
    expect(fake.status).toBe(422);
    expect(fake.body.code).toBe('CREDENTIALS_NOT_APPLICABLE');
    const rz = (keyId: string) =>
      admin.c(
        'post',
        '/platform/providers',
        {
          providerKey: 'pg_rz',
          channel: 'PAYMENT_GATEWAY',
          vendor: 'RAZORPAY',
          displayName: 'Razorpay',
          priority: 1,
          config: { mode: 'live' },
          credentials: { keyId, keySecret: 'k'.repeat(24), webhookSecret: 'w'.repeat(20) },
        },
        { headers: idem() },
      );
    expect((await rz('rzp_test_AbCdEfGhIjKlMn')).body.code).toBe('CREDENTIALS_SCHEMA_INVALID');
    expect((await rz('rzp_live_AbCdEfGhIjKlMn')).status).toBe(201);
    const p = (await ServiceProvider.findOne({ where: { providerKey: 'pg_rz' } }))!;
    const put = await admin.c('put', `/platform/providers/${p.id}/credentials`, {
      version: 1,
      credentials: {},
    });
    expect(put.body.code).toBe('CREDENTIALS_SCHEMA_INVALID');
    const f = await fakeProvider(admin.c, { key: 'sms_f2', channel: 'SMS', enable: false });
    const noApply = await admin.c('put', `/platform/providers/${f.id}/credentials`, {
      version: 1,
      credentials: { a: 'b' },
    });
    expect(noApply.status).toBe(422);
    expect(noApply.body.code).toBe('CREDENTIALS_NOT_APPLICABLE');
  });

  it('T07-19 enabling a provider without credentials is PROVIDER_CREDENTIALS_MISSING; with credentials it works', async () => {
    const admin = await platformAs('super_admin');
    // a database-sourced row without credentials (inserted directly: the API always requires them)
    const p = await ServiceProvider.create({
      providerKey: 'sms_nocreds',
      channel: 'SMS',
      vendor: 'MSG91',
      displayName: 'No creds',
      description: null,
      isEnabled: false,
      priority: 3,
      credentialsSource: 'DATABASE',
      configJson: MSG91_CONFIG,
      credentialsEnc: null,
      credentialsIv: null,
      credentialsTag: null,
      credentialsKeyVersion: null,
      credentialsMasked: null,
      credentialsUpdatedAt: null,
      credentialsUpdatedBy: null,
      healthStatus: 'UNKNOWN',
      statusMode: 'AUTOMATIC',
      statusReason: null,
      statusChangedAt: null,
      consecutiveFailures: 0,
      degradedLatencyMs: 3000,
      lastCheckAt: null,
      lastCheckOk: null,
      lastCheckLatencyMs: null,
      lastCheckError: null,
      uptime30dPct: null,
      lastTestAt: null,
      lastTestOk: null,
      lastTestBy: null,
      version: 1,
      createdBy: null,
      updatedBy: null,
    });
    const r = await admin.c('patch', `/platform/providers/${p.id}`, { version: 1, isEnabled: true });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PROVIDER_CREDENTIALS_MISSING');
    const put = await admin.c('put', `/platform/providers/${p.id}/credentials`, {
      version: 1,
      credentials: MSG91_CREDS,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const again = await admin.c('patch', `/platform/providers/${p.id}`, { version: 2, isEnabled: true });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.isEnabled).toBe(true);
    const test = await admin.c('post', `/platform/providers/${p.id}/test-send`, { to: '9820011111' });
    expect(test.body.data.ok).toBe(false); // the real vendor adapter is module 16's; the error is returned, never thrown
    expect(test.body.data.error).toMatch(/not built/);
  });

  it('T07-20 a FAKE provider cannot be created or enabled when NODE_ENV is production', async () => {
    const admin = await platformAs('super_admin');
    const f = await fakeProvider(admin.c, { key: 'sms_f', enable: false });
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const create = await admin.c(
        'post',
        '/platform/providers',
        {
          providerKey: 'sms_f2',
          channel: 'SMS',
          vendor: 'FAKE',
          displayName: 'SMS fake 2',
          priority: 2,
          config: { failMode: 'none' },
        },
        { headers: idem() },
      );
      expect(create.status).toBe(422);
      expect(create.body.code).toBe('FAKE_PROVIDER_IN_PRODUCTION');
      const enable = await admin.c('patch', `/platform/providers/${f.id}`, { version: 1, isEnabled: true });
      expect(enable.body.code).toBe('FAKE_PROVIDER_IN_PRODUCTION');
    } finally {
      process.env.NODE_ENV = before;
    }
  });

  it('T07-21 PUT credentials without recent authentication is REAUTH_REQUIRED (also create, edit, delete)', async () => {
    const admin = await platformAs('super_admin');
    const f = await fakeProvider(admin.c, { key: 'sms_f', enable: false });
    setNow('2026-10-30T04:06:00Z');
    for (const [m, path, body] of [
      ['put', `/platform/providers/${f.id}/credentials`, { version: 1, credentials: {} }],
      ['patch', `/platform/providers/${f.id}`, { version: 1, displayName: 'Renamed' }],
      ['delete', `/platform/providers/${f.id}`, { version: 1, reason: 'Not needed any more' }],
      [
        'post',
        '/platform/providers',
        {
          providerKey: 'sms_z',
          channel: 'SMS',
          vendor: 'FAKE',
          displayName: 'Zed',
          priority: 2,
          config: { failMode: 'none' },
        },
      ],
    ] as const) {
      const r = await admin.c(m, path, body, { headers: idem() });
      expect(r.status, `${m} ${path}`).toBe(401);
      expect(r.body.code).toBe('REAUTH_REQUIRED');
    }
  });

  it('T07-22 Platform Support cannot create, edit, change credentials, delete, override status, send a test or read settings it lacks', async () => {
    const admin = await platformAs('super_admin');
    const f = await fakeProvider(admin.c, { key: 'sms_f', enable: false });
    const agent = await platformAs('platform_support');
    for (const [m, path, body] of [
      ['patch', `/platform/providers/${f.id}`, { version: 1, displayName: 'Renamed' }],
      ['put', `/platform/providers/${f.id}/credentials`, { version: 1, credentials: {} }],
      ['delete', `/platform/providers/${f.id}`, { version: 1, reason: 'Not needed any more' }],
      [
        'post',
        '/platform/providers',
        {
          providerKey: 'sms_z',
          channel: 'SMS',
          vendor: 'FAKE',
          displayName: 'Zed',
          priority: 2,
          config: { failMode: 'none' },
        },
      ],
      ['post', '/platform/queues/retry-failed', {}],
      ['patch', '/platform/settings', { changes: [{ key: 'support.autoCloseDays', value: 5, version: 1 }] }],
    ] as const) {
      const r = await agent.c(m, path, body, { headers: idem() });
      expect(r.status, `${m} ${path}`).toBe(403);
      expect(r.body.code).toBe('PERMISSION_DENIED');
    }
    expect((await agent.c('get', '/platform/providers')).status).toBe(200); // health view is allowed
  });

  it('key and priority rules: PROVIDER_KEY_TAKEN (also after delete), PROVIDER_PRIORITY_TAKEN, STALE_VERSION', async () => {
    const admin = await platformAs('super_admin');
    const a = await fakeProvider(admin.c, { key: 'sms_a', priority: 1, enable: false });
    const dupKey = await admin.c(
      'post',
      '/platform/providers',
      {
        providerKey: 'sms_a',
        channel: 'EMAIL',
        vendor: 'FAKE',
        displayName: 'Other',
        priority: 1,
        config: { failMode: 'none' },
      },
      { headers: idem() },
    );
    expect(dupKey.body.code).toBe('PROVIDER_KEY_TAKEN');
    const dupPriority = await admin.c(
      'post',
      '/platform/providers',
      {
        providerKey: 'sms_b',
        channel: 'SMS',
        vendor: 'FAKE',
        displayName: 'Other',
        priority: 1,
        config: { failMode: 'none' },
      },
      { headers: idem() },
    );
    expect(dupPriority.status).toBe(409);
    expect(dupPriority.body.code).toBe('PROVIDER_PRIORITY_TAKEN');
    const b = await fakeProvider(admin.c, { key: 'sms_b', priority: 2, enable: false });
    const move = await admin.c('patch', `/platform/providers/${b.id}`, { version: 1, priority: 1 });
    expect(move.body.code).toBe('PROVIDER_PRIORITY_TAKEN');
    const stale = await admin.c('patch', `/platform/providers/${a.id}`, { version: 7, displayName: 'Nope' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    const del = await admin.c('delete', `/platform/providers/${a.id}`, {
      version: 1,
      reason: 'Replaced by another',
    });
    expect(del.status).toBe(204);
    const reuse = await admin.c(
      'post',
      '/platform/providers',
      {
        providerKey: 'sms_a',
        channel: 'SMS',
        vendor: 'FAKE',
        displayName: 'Again',
        priority: 1,
        config: { failMode: 'none' },
      },
      { headers: idem() },
    );
    expect(reuse.body.code).toBe('PROVIDER_KEY_TAKEN'); // never reused, even after delete
    const freed = await fakeProvider(admin.c, { key: 'sms_c', priority: 1, enable: false }); // the priority is free again
    expect(freed.priority).toBe(1);
  });

  it('delete: only a disabled provider (PROVIDER_IN_USE); the row is soft deleted, credentials wiped, priority NULL', async () => {
    const admin = await platformAs('super_admin');
    const f = await fakeProvider(admin.c, { key: 'sms_a', priority: 1 });
    const busy = await admin.c('delete', `/platform/providers/${f.id}`, {
      version: f.version,
      reason: 'Not needed any more',
    });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('PROVIDER_IN_USE');
    const create = await admin.c(
      'post',
      '/platform/providers',
      {
        providerKey: 'sms_msg',
        channel: 'SMS',
        vendor: 'MSG91',
        displayName: 'MSG91',
        priority: 2,
        config: MSG91_CONFIG,
        credentials: MSG91_CREDS,
      },
      { headers: idem() },
    );
    const id = create.body.data.id;
    const del = await admin.c('delete', `/platform/providers/${id}`, {
      version: 1,
      reason: 'Contract ended',
    });
    expect(del.status).toBe(204);
    const row = (await ServiceProvider.scope('withSecrets').findByPk(id, { paranoid: false }))!;
    expect(row.deletedAt).not.toBeNull();
    expect(row.priority).toBeNull();
    expect(row.credentialsEnc).toBeNull();
    expect(row.credentialsMasked).toBeNull();
    expect((await admin.c('get', `/platform/providers/${id}`)).body.code).toBe('PROVIDER_NOT_FOUND');
    const a = await AuditLog.findOne({ where: { action: 'platform.provider.deleted' } });
    expect(a!.reason).toBe('Contract ended');
  });

  it('T07-25 in production the last enabled SMS, EMAIL or PAYMENT_GATEWAY provider cannot be disabled', async () => {
    const admin = await platformAs('super_admin');
    const sms = await fakeProvider(admin.c, { key: 'sms_a', channel: 'SMS', priority: 1 });
    const push = await fakeProvider(admin.c, { key: 'push_a', channel: 'PUSH', priority: 1 });
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const r = await admin.c('patch', `/platform/providers/${sms.id}`, {
        version: sms.version,
        isEnabled: false,
      });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('LAST_ENABLED_PROVIDER');
      const ok = await admin.c('patch', `/platform/providers/${push.id}`, {
        version: push.version,
        isEnabled: false,
      });
      expect(ok.status).toBe(200); // PUSH is not guarded
    } finally {
      process.env.NODE_ENV = before;
    }
    const second = await fakeProvider(admin.c, { key: 'sms_b', channel: 'SMS', priority: 2 });
    const fine = await admin.c('patch', `/platform/providers/${sms.id}`, {
      version: sms.version,
      isEnabled: false,
    });
    expect(fine.status).toBe(200);
    expect(second.isEnabled).toBe(true);
  });

  it('T07-26 test send to a fake SMS provider: ok, recipient masked in the audit row, the 11th in an hour is 429', async () => {
    const admin = await platformAs('super_admin');
    const f = await fakeProvider(admin.c, { key: 'sms_a' });
    const r = await admin.c('post', `/platform/providers/${f.id}/test-send`, { to: '9820011111' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ ok: true, error: null });
    expect(r.body.data.providerMessageId).toMatch(/^fake_/);
    const inbox = await listInbox();
    expect(inbox.find(m => m.to === '9820011111')!.body).toMatch(
      /^SocietyApp test message \d{6}\. No action needed\.$/,
    );
    const a = await AuditLog.findOne({ where: { action: 'platform.provider.test_sent' } });
    expect(a!.after).toEqual({ to: '98XXXXX111', ok: true });
    const row = (await ServiceProvider.findByPk(f.id!))!;
    expect(row.lastTestOk).toBe(true);
    expect(row.lastTestBy).toBe(admin.user.id);
    for (let i = 0; i < 9; i++)
      expect(
        (await admin.c('post', `/platform/providers/${f.id}/test-send`, { to: '9820011111' })).status,
      ).toBe(200);
    const eleventh = await admin.c('post', `/platform/providers/${f.id}/test-send`, { to: '9820011111' });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.code).toBe('RATE_LIMITED');
  });

  it('test send validation: recipient required for SMS, forbidden for a gateway; a failing vendor is a 200 with ok false', async () => {
    const admin = await platformAs('super_admin');
    const f = await fakeProvider(admin.c, { key: 'sms_a', failMode: 'error' });
    const noTo = await admin.c('post', `/platform/providers/${f.id}/test-send`, {});
    expect(noTo.status).toBe(422);
    expect(noTo.body.code).toBe('TEST_RECIPIENT_REQUIRED');
    const bad = await admin.c('post', `/platform/providers/${f.id}/test-send`, { to: '12345' });
    expect(bad.status).toBe(400);
    const fail = await admin.c('post', `/platform/providers/${f.id}/test-send`, { to: '9820011111' });
    expect(fail.status).toBe(200);
    expect(fail.body.data).toMatchObject({ ok: false, providerMessageId: null });
    expect((await ServiceProvider.findByPk(f.id!))!.lastTestOk).toBe(false);
    const pg = await fakeProvider(admin.c, { key: 'pg_a', channel: 'PAYMENT_GATEWAY' });
    expect(
      (await admin.c('post', `/platform/providers/${pg.id}/test-send`, { to: '9820011111' })).status,
    ).toBe(400);
    const conn = await admin.c('post', `/platform/providers/${pg.id}/test-send`, {});
    expect(conn.body.data).toMatchObject({ ok: true, providerMessageId: null });
    const push = await fakeProvider(admin.c, { key: 'push_a', channel: 'PUSH' });
    const p = await admin.c('post', `/platform/providers/${push.id}/test-send`, {
      pushSubscriptionOfMe: true,
    });
    expect(p.body.code).toBe('TEST_RECIPIENT_REQUIRED');
  });

  it('list filters and the provider object', async () => {
    const admin = await platformAs('super_admin');
    await fakeProvider(admin.c, { key: 'sms_a', channel: 'SMS', priority: 1 });
    await fakeProvider(admin.c, { key: 'email_a', channel: 'EMAIL', priority: 1, enable: false });
    const all = await admin.c('get', '/platform/providers');
    expect(all.body.data.items.map((p: any) => p.providerKey)).toEqual(['email_a', 'sms_a']);
    const enabled = await admin.c('get', '/platform/providers', undefined, { query: { isEnabled: 'true' } });
    expect(enabled.body.data.items.map((p: any) => p.providerKey)).toEqual(['sms_a']);
    const sms = await admin.c('get', '/platform/providers', undefined, {
      query: { channel: 'SMS', healthStatus: 'UNKNOWN' },
    });
    expect(sms.body.data.items).toHaveLength(1);
    expect(Object.keys(sms.body.data.items[0]).sort()).toEqual(
      [
        'id',
        'providerKey',
        'channel',
        'vendor',
        'displayName',
        'description',
        'isEnabled',
        'priority',
        'credentialsSource',
        'config',
        'credentialsMasked',
        'credentialsUpdatedAt',
        'health',
        'lastTest',
        'openIncidentId',
        'version',
        'updatedAt',
      ].sort(),
    );
    expect((await admin.c('get', '/platform/providers/999999')).body.code).toBe('PROVIDER_NOT_FOUND');
  });
});

describe('health checks (BR-07-26, BR-07-27, T07-23)', () => {
  it('maps failures to a status: 1 and 2 keep it, 3 degrade, 10 are an outage, a success resets', () => {
    expect(nextAutoStatus('OPERATIONAL', false, 1)).toBe('OPERATIONAL');
    expect(nextAutoStatus('UNKNOWN', false, 2)).toBe('UNKNOWN');
    expect(nextAutoStatus('OPERATIONAL', false, 3)).toBe('DEGRADED');
    expect(nextAutoStatus('DEGRADED', false, 9)).toBe('DEGRADED');
    expect(nextAutoStatus('DEGRADED', false, 10)).toBe('OUTAGE');
    expect(nextAutoStatus('OUTAGE', true, 0)).toBe('OPERATIONAL');
  });

  it('T07-23 three failures: DEGRADED and a private SEV3 incident; ten: OUTAGE and SEV2; success: OPERATIONAL and MONITORING', async () => {
    const admin = await platformAs('super_admin');
    const f = await fakeProvider(admin.c, { key: 'sms_a', failMode: 'error' });
    await runCheck(f.id!);
    await runCheck(f.id!);
    let p = (await ServiceProvider.findByPk(f.id!))!;
    expect(p).toMatchObject({ healthStatus: 'UNKNOWN', consecutiveFailures: 2, lastCheckOk: false });
    expect(await Incident.count()).toBe(0); // no flapping
    await runCheck(f.id!);
    p = (await ServiceProvider.findByPk(f.id!))!;
    expect(p).toMatchObject({ healthStatus: 'DEGRADED', consecutiveFailures: 3 });
    let inc = (await Incident.findOne())!;
    expect(inc).toMatchObject({
      severity: 'SEV3',
      status: 'INVESTIGATING',
      source: 'PROVIDER_AUTO',
      isPublic: false,
      serviceProviderId: f.id,
      components: ['notifications_sms'],
    });
    for (let i = 0; i < 7; i++) await runCheck(f.id!);
    p = (await ServiceProvider.findByPk(f.id!))!;
    expect(p).toMatchObject({ healthStatus: 'OUTAGE', consecutiveFailures: 10 });
    inc = (await Incident.findByPk(inc.id!))!;
    expect(inc.severity).toBe('SEV2'); // raised, not duplicated
    expect(await Incident.count()).toBe(1);
    // the vendor recovers
    await admin.c('patch', `/platform/providers/${f.id}`, {
      version: p.version,
      config: { failMode: 'none' },
    });
    const r = await runCheck(f.id!);
    expect(r).toMatchObject({ ok: true, healthStatus: 'OPERATIONAL' });
    p = (await ServiceProvider.findByPk(f.id!))!;
    expect(p).toMatchObject({ healthStatus: 'OPERATIONAL', consecutiveFailures: 0, statusReason: null });
    inc = (await Incident.findByPk(inc.id!))!;
    expect(inc.status).toBe('MONITORING');
    expect(inc.monitoringAt).not.toBeNull();
    expect(inc.updates.at(-1)).toMatchObject({
      message: 'Provider checks are passing again',
      byName: 'SocietyApp',
    });
    expect(inc.resolvedAt).toBeNull(); // a person resolves it
    const statuses = (
      await AuditLog.findAll({
        where: { action: 'platform.provider.status_changed' },
        order: [['id', 'ASC']],
      })
    ).map(a => (a.after as any).status);
    expect(statuses).toEqual(['DEGRADED', 'OUTAGE', 'OPERATIONAL']);
  });

  it('a slow response counts as a failed check; MANUAL mode stores results but keeps the status', async () => {
    const admin = await platformAs('super_admin');
    const slow = await fakeProvider(admin.c, { key: 'sms_slow', failMode: 'slow' });
    const r = await runCheck(slow.id!);
    expect(r).toMatchObject({ ok: false, latencyMs: 5000 });
    expect(r!.error).toMatch(/Slow response/);
    const f = await fakeProvider(admin.c, { key: 'sms_m', priority: 2, failMode: 'error' });
    const set = await admin.c('post', `/platform/providers/${f.id}/status`, {
      version: f.version,
      mode: 'MANUAL',
      status: 'OPERATIONAL',
      reason: 'We know about it',
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    for (let i = 0; i < 4; i++) await runCheck(f.id!);
    const p = (await ServiceProvider.findByPk(f.id!))!;
    expect(p).toMatchObject({
      healthStatus: 'OPERATIONAL',
      statusMode: 'MANUAL',
      consecutiveFailures: 4,
      lastCheckOk: false,
    });
    expect(await Incident.count({ where: { serviceProviderId: f.id! } })).toBe(0);
  });

  it('the job runs enabled providers once per tick (conditional on lastCheckAt); check routes return results; disabled ones are skipped', async () => {
    const admin = await platformAs('super_admin');
    const a = await fakeProvider(admin.c, { key: 'sms_a', priority: 1 });
    await fakeProvider(admin.c, { key: 'sms_off', priority: 2, enable: false });
    expect(await runProviderHealthChecks()).toBe(1);
    const first = (await ServiceProvider.findByPk(a.id!))!.lastCheckAt!;
    expect(first.toISOString()).toBe('2026-10-30T04:00:00.000Z');
    // the same tick on a second worker: lastCheckAt is not before the job start any more
    expect(await runCheck(a.id!, { startedAt: new Date('2026-10-30T04:00:00Z') })).toBeNull();
    setNow('2026-10-30T04:02:00Z');
    expect(await runProviderHealthChecks()).toBe(1);
    const all = await checkAll();
    expect(all.results).toHaveLength(1);
    const one = await admin.c('post', `/platform/providers/${a.id}/check`);
    expect(one.status).toBe(200);
    expect(one.body.data.results[0]).toMatchObject({
      providerId: a.id,
      ok: true,
      healthStatus: 'OPERATIONAL',
    });
    expect((await admin.c('post', '/platform/providers/check-all')).body.data.results).toHaveLength(1);
    expect((await admin.c('post', '/platform/providers/999999/check')).body.code).toBe('PROVIDER_NOT_FOUND');
    await runUptimeRollup();
    expect(Number((await ServiceProvider.findByPk(a.id!))!.uptime30dPct)).toBe(100);
  });

  it('uptime roll-up counts ok and failed checks of the last 30 days', async () => {
    const admin = await platformAs('super_admin');
    const f = await fakeProvider(admin.c, { key: 'sms_a', failMode: 'error' });
    await runCheck(f.id!);
    const cur = (await ServiceProvider.findByPk(f.id!))!;
    expect(
      (
        await admin.c('patch', `/platform/providers/${f.id}`, {
          version: cur.version,
          config: { failMode: 'none' },
        })
      ).status,
    ).toBe(200);
    await runCheck(f.id!);
    await runCheck(f.id!);
    await runCheck(f.id!);
    await runUptimeRollup();
    expect(Number((await ServiceProvider.findByPk(f.id!))!.uptime30dPct)).toBe(75);
  });

  it('new credentials reset the failure count and queue an immediate check', async () => {
    const admin = await platformAs('super_admin');
    const c = await admin.c(
      'post',
      '/platform/providers',
      {
        providerKey: 'sms_msg',
        channel: 'SMS',
        vendor: 'MSG91',
        displayName: 'MSG91',
        priority: 1,
        config: MSG91_CONFIG,
        credentials: MSG91_CREDS,
      },
      { headers: idem() },
    );
    await ServiceProvider.update({ consecutiveFailures: 5 }, { where: { id: c.body.data.id } });
    const put = await admin.c('put', `/platform/providers/${c.body.data.id}/credentials`, {
      version: 1,
      credentials: { authKey: 'N'.repeat(24) },
    });
    expect(put.status).toBe(200);
    await drainQueues();
    const p = (await ServiceProvider.findByPk(c.body.data.id))!;
    expect(p.lastCheckAt).not.toBeNull(); // the queued check ran (the real vendor adapter answers "not built")
    expect(p.consecutiveFailures).toBe(1);
    expect(p.lastCheckError).toMatch(/not built/);
  });
});

describe('resolveProvider (BR-07-25, section 8.13)', () => {
  it('picks the enabled provider with the lowest priority that is not in OUTAGE', async () => {
    const admin = await platformAs('super_admin');
    const a = await fakeProvider(admin.c, { key: 'sms_a', priority: 1 });
    const b = await fakeProvider(admin.c, { key: 'sms_b', priority: 2 });
    await fakeProvider(admin.c, { key: 'sms_c', priority: 3, enable: false });
    expect((await resolveProvider('SMS', 'real')).providerKey).toBe('sms_a');
    await ServiceProvider.update({ healthStatus: 'DEGRADED' }, { where: { id: a.id! } });
    expect((await resolveProvider('SMS', 'real')).providerKey).toBe('sms_a'); // DEGRADED still serves
    await ServiceProvider.update({ healthStatus: 'OUTAGE' }, { where: { id: a.id! } });
    expect((await resolveProvider('SMS', 'real')).providerKey).toBe('sms_b');
    expect((await listEnabledProviders('SMS', 'real')).map(p => p.providerKey)).toEqual(['sms_b', 'sms_a']);
    await ServiceProvider.update({ healthStatus: 'OUTAGE' }, { where: { id: b.id! } });
    const all = await resolveProvider('SMS', 'real');
    expect(all.providerKey).toBe('sms_a'); // all in OUTAGE: the primary anyway
    expect(all.source).toBe('FAKE');
  });

  it('no enabled provider falls back to the environment adapter; fake mode always answers the fake; credentials are decrypted', async () => {
    const admin = await platformAs('super_admin');
    expect(await resolveProvider('EMAIL', 'real')).toMatchObject({ providerId: null, source: 'ENV' });
    const c = await admin.c(
      'post',
      '/platform/providers',
      {
        providerKey: 'sms_msg',
        channel: 'SMS',
        vendor: 'MSG91',
        displayName: 'MSG91',
        priority: 1,
        config: MSG91_CONFIG,
        credentials: MSG91_CREDS,
      },
      { headers: idem() },
    );
    await admin.c('patch', `/platform/providers/${c.body.data.id}`, { version: 1, isEnabled: true });
    const r = await resolveProvider('SMS', 'real');
    expect(r).toMatchObject({
      vendor: 'MSG91',
      source: 'DATABASE',
      credentials: MSG91_CREDS,
      config: MSG91_CONFIG,
    });
    expect((await resolveProvider('SMS', 'fake')).source).toBe('FAKE');
    expect((await resolveProvider('SMS')).source).toBe('FAKE'); // the test environment runs PROVIDERS_MODE=fake
  });
});

describe('providers:rekey (section 9.1)', () => {
  it('re-encrypts rows on an old key version with the active one and reports 0 left', async () => {
    const admin = await platformAs('super_admin');
    const c = await admin.c(
      'post',
      '/platform/providers',
      {
        providerKey: 'sms_msg',
        channel: 'SMS',
        vendor: 'MSG91',
        displayName: 'MSG91',
        priority: 1,
        config: MSG91_CONFIG,
        credentials: MSG91_CREDS,
      },
      { headers: idem() },
    );
    const id = c.body.data.id;
    // move the row to key version 1 by re-encrypting under it, as if it were written before the rotation
    const old = encryptCredentials('sms_msg', MSG91_CREDS, 1);
    await sequelize.query(
      'UPDATE service_providers SET credentialsEnc = :e, credentialsIv = :i, credentialsTag = :t, credentialsKeyVersion = 1 WHERE id = :id',
      {
        replacements: { e: old.enc, i: old.iv, t: old.tag, id },
      },
    );
    expect((await ServiceProvider.scope('withSecrets').findByPk(id))!.credentialsKeyVersion).toBe(1);
    const r = await rekeyProviders();
    expect(r).toEqual({ rekeyed: 1, remainingOnOldVersions: 0 });
    const row = (await ServiceProvider.scope('withSecrets').findByPk(id))!;
    expect(row.credentialsKeyVersion).toBe(2);
    expect(
      decryptCredentials('sms_msg', {
        enc: row.credentialsEnc!,
        iv: row.credentialsIv!,
        tag: row.credentialsTag!,
        keyVersion: 2,
      }),
    ).toEqual(MSG91_CREDS);
    const a = await AuditLog.findOne({ where: { action: 'platform.provider.credentials_rekeyed' } });
    expect(a!.after).toEqual({ fromKeyVersion: 1, toKeyVersion: 2 });
    expect(await rekeyProviders()).toEqual({ rekeyed: 0, remainingOnOldVersions: 0 });
  });
});
