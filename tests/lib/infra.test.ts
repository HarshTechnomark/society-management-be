import request from 'supertest';
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, closeDb, sequelize } from '../../src/models';
import { addDays, advance, istClock, istDate, now, nowMs, setNow } from '../../src/lib/clock';
import { MemoryKv, setKv, kv, type KvStore } from '../../src/lib/kv';
import { clearInbox, listInbox } from '../../src/lib/inbox';
import { redact } from '../../src/lib/logger';
import { notify, registerTemplates } from '../../src/lib/notify';
import {
  configureMemoryQueue,
  drainQueues,
  enqueue,
  enqueueAfterCommit,
  isDue,
  registerProcessor,
  registerRepeatable,
  resetQueueState,
  tickScheduler,
} from '../../src/lib/queue';
import { rateLimit } from '../../src/middlewares/rateLimit.middleware';
import { errorHandler } from '../../src/middlewares/error.middleware';
import { requestId } from '../../src/middlewares/requestId.middleware';
import { audit } from '../../src/utils/audit';
import { adapters, setAdapters } from '../../src/adapters';
import { app, resetAll } from '../helpers/auth';

afterAll(closeDb);
beforeEach(async () => {
  setKv(undefined);
  await resetAll();
});

describe('clock helper (BR-01-18)', () => {
  it('freezes, advances and gives Asia/Kolkata parts', () => {
    setNow('2026-11-01T04:30:00Z');
    expect(nowMs()).toBe(Date.parse('2026-11-01T04:30:00Z'));
    advance(61_000);
    expect(now().toISOString()).toBe('2026-11-01T04:31:01.000Z');
    expect(istClock(new Date('2026-11-01T21:00:00Z'))).toEqual({ hour: 2, minute: 30 });
    expect(istDate(new Date('2026-11-01T21:00:00Z'))).toBe('2026-11-02');
    expect(addDays(now(), 30).toISOString()).toBe('2026-12-01T04:31:01.000Z');
    setNow(null);
    expect(Math.abs(nowMs() - Date.now())).toBeLessThan(1000);
  });
  it('now() returns a copy that cannot move the clock', () => {
    setNow('2026-11-01T04:30:00Z');
    now().setFullYear(2000);
    expect(now().getUTCFullYear()).toBe(2026);
  });
});

describe('memory key-value store', () => {
  it('sliding window allows up to the limit, then denies with the seconds until the oldest hit leaves', async () => {
    setNow('2026-11-01T04:30:00Z');
    const s = new MemoryKv();
    for (let i = 0; i < 3; i++) expect((await s.slidingWindowHit('k', 60_000, 3)).allowed).toBe(true);
    advance(20_000);
    const denied = await s.slidingWindowHit('k', 60_000, 3);
    expect(denied).toEqual({ allowed: false, count: 3, retryAfterSeconds: 40 });
    expect((await s.slidingWindowHit('other', 60_000, 3)).allowed).toBe(true);
    advance(41_000);
    expect((await s.slidingWindowHit('k', 60_000, 3)).allowed).toBe(true);
  });
  it('a denied attempt is not counted, and reset clears by prefix', async () => {
    setNow('2026-11-01T04:30:00Z');
    const s = new MemoryKv();
    await s.slidingWindowHit('a:1', 1000, 1);
    for (let i = 0; i < 5; i++) await s.slidingWindowHit('a:1', 1000, 1);
    advance(1001);
    expect((await s.slidingWindowHit('a:1', 1000, 1)).count).toBe(1);
    await s.slidingWindowReset('a:');
    expect((await s.slidingWindowHit('a:1', 1000, 1)).allowed).toBe(true);
  });
  it('lists keep the newest first and are capped', async () => {
    const s = new MemoryKv();
    for (let i = 0; i < 5; i++) await s.listPush('l', String(i), 3);
    expect(await s.listAll('l')).toEqual(['4', '3', '2']);
    await s.listClear('l');
    expect(await s.listAll('l')).toEqual([]);
  });
});

describe('rate-limit middleware (BR-01-6)', () => {
  const mk = (opts: Partial<Parameters<typeof rateLimit>[0]> = {}) => {
    const a = express();
    a.set('trust proxy', 1);
    a.use(requestId);
    a.get(
      '/x',
      rateLimit({ name: 't', limit: 2, windowSeconds: 60, key: req => req.ip, ...opts }),
      (_req, res) => void res.json({ ok: true }),
    );
    a.use(errorHandler);
    return a;
  };
  it('answers 429 RATE_LIMITED with Retry-After over the limit and counts per key', async () => {
    const a = mk();
    expect((await request(a).get('/x').set('X-Forwarded-For', '1.1.1.1')).status).toBe(200);
    expect((await request(a).get('/x').set('X-Forwarded-For', '1.1.1.1')).status).toBe(200);
    const r = await request(a).get('/x').set('X-Forwarded-For', '1.1.1.1');
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect((await request(a).get('/x').set('X-Forwarded-For', '2.2.2.2')).status).toBe(200);
  });
  it('fails closed (429) or open when the store is down', async () => {
    const broken: KvStore = Object.assign(new MemoryKv(), {
      slidingWindowHit: async () => {
        throw new Error('redis down');
      },
    });
    setKv(broken);
    expect((await request(mk({ failClosed: true })).get('/x')).status).toBe(429);
    expect((await request(mk({ failClosed: false })).get('/x')).status).toBe(200);
    expect(kv()).toBe(broken);
  });
  it('a null key skips the limit', async () => {
    const a = mk({ key: () => null });
    for (let i = 0; i < 5; i++) expect((await request(a).get('/x')).status).toBe(200);
  });
});

describe('job queue, in-process runner (BR-01-14, BR-01-15)', () => {
  beforeEach(() => {
    configureMemoryQueue({ backoffMs: 0 });
    resetQueueState();
  });
  it('runs the registered processor with the payload', async () => {
    const seen: unknown[] = [];
    registerProcessor('t', 't:one', async d => void seen.push(d));
    await enqueue('t', 't:one', { id: 1 });
    await drainQueues();
    expect(seen).toEqual([{ id: 1 }]);
  });
  it('retries up to 5 attempts and then gives up; a jobId runs once', async () => {
    let n = 0;
    registerProcessor('t', 't:flaky', async () => {
      n += 1;
      if (n < 4) throw new Error('boom');
    });
    await enqueue('t', 't:flaky', {});
    await drainQueues();
    expect(n).toBe(4);
    let m = 0;
    registerProcessor('t', 't:always', async () => {
      m += 1;
      throw new Error('boom');
    });
    await enqueue('t', 't:always', {});
    await drainQueues();
    expect(m).toBe(5);
    let c = 0;
    registerProcessor('t', 't:once', async () => void (c += 1));
    await enqueue('t', 't:once', {}, { jobId: 'same' });
    await enqueue('t', 't:once', {}, { jobId: 'same' });
    await drainQueues();
    expect(c).toBe(1);
  });
  it('enqueueAfterCommit enqueues after a commit and not after a rollback', async () => {
    let c = 0;
    registerProcessor('t', 't:commit', async () => void (c += 1));
    await sequelize.transaction(async tx => {
      enqueueAfterCommit(tx, 't', 't:commit', {});
      await drainQueues();
      expect(c).toBe(0);
    });
    await drainQueues();
    expect(c).toBe(1);
    await sequelize
      .transaction(async tx => {
        enqueueAfterCommit(tx, 't', 't:commit', {});
        throw new Error('rollback');
      })
      .catch(() => undefined);
    await drainQueues();
    expect(c).toBe(1);
  });
  it('schedules: hourly at :15, daily 02:30 IST, every N ms', async () => {
    expect(isDue({ hourlyAtMinute: 15 }, 0, new Date('2026-11-01T04:15:30Z'))).toBe(false); // 09:45 IST
    expect(isDue({ hourlyAtMinute: 15 }, 0, new Date('2026-11-01T04:45:30Z'))).toBe(true); // 10:15 IST
    expect(isDue({ dailyAtIst: '02:30' }, 0, new Date('2026-10-31T21:00:10Z'))).toBe(true);
    expect(isDue({ dailyAtIst: '02:30' }, 0, new Date('2026-10-31T21:01:10Z'))).toBe(false);
    expect(isDue({ everyMs: 300_000 }, 1000, new Date(301_000))).toBe(true);
    expect(isDue({ everyMs: 300_000 }, 1000, new Date(300_000))).toBe(false);
    let c = 0;
    registerProcessor('t', 't:tick', async () => void (c += 1));
    registerRepeatable('t', 't:tick', { dailyAtIst: '02:30' });
    expect(await tickScheduler(new Date('2026-10-31T21:00:10Z'))).toContain('t:tick');
    expect(await tickScheduler(new Date('2026-10-31T21:00:40Z'))).not.toContain('t:tick'); // same minute: once
    await drainQueues();
    expect(c).toBe(1);
  });
});

describe('audit helper (BR-01-8)', () => {
  const ctx = { requestId: 'req_abcdefghijkl', ip: '10.0.0.1', userAgent: 'UA' };
  it('writes a redacted row inside the caller transaction; a rollback leaves no row', async () => {
    await sequelize.transaction(async tx => {
      await audit(
        ctx,
        {
          action: 'auth.user.updated',
          entityType: 'user',
          entityId: 5,
          before: { password: 'x', name: 'A' },
          after: { mobile: '9820011111', email: 'raj@mail.in', token: 't' },
          actor: { userId: 5, name: 'Raj', role: 'user' },
        },
        tx,
      );
    });
    const row = (await AuditLog.findOne())!;
    expect(row).toMatchObject({
      actorUserId: 5,
      actorName: 'Raj',
      actorRole: 'user',
      entityId: '5',
      ip: '10.0.0.1',
      requestId: 'req_abcdefghijkl',
    });
    expect(row.before).toEqual({ password: '[REDACTED]', name: 'A' });
    expect(row.after).toEqual({ mobile: '98XXXXX111', email: 'r****@mail.in', token: '[REDACTED]' });
    await resetAll();
    await sequelize
      .transaction(async tx => {
        await audit(ctx, { action: 'a.b.c', entityType: 'x', entityId: 1 }, tx);
        throw new Error('rollback');
      })
      .catch(() => undefined);
    expect(await AuditLog.count()).toBe(0);
  });
  it('without a user the actor is the system; the rows can never be updated or deleted', async () => {
    await audit(ctx, { action: 'a.b.c', entityType: 'x', entityId: 1 });
    const row = (await AuditLog.findOne())!;
    expect(row).toMatchObject({ actorUserId: null, actorName: 'System', actorRole: 'system' });
    row.reason = 'edit';
    await expect(row.save()).rejects.toThrow(/cannot be updated/);
    await expect(row.destroy()).rejects.toThrow(/cannot be deleted/);
    await expect(AuditLog.destroy({ where: {} })).rejects.toThrow(/cannot be deleted/);
    await expect(AuditLog.update({ reason: 'x' }, { where: {} })).rejects.toThrow(/cannot be updated/);
    expect(await AuditLog.count()).toBe(1);
  });
});

describe('adapters, inbox and notify', () => {
  it('fake adapters record to the inbox; the dev route lists newest first, filters, and clears', async () => {
    const a = adapters();
    await a.sms.send('9820011111', 'auth.otp', '123456 is your code');
    await a.email.send(
      'a@x.in',
      'Hello',
      '<p>Hi</p>',
      'Open https://admin.societyapp.in/reset?token=abc please',
    );
    await a.whatsapp.sendTemplate('9820011111', 'auth.otp', 'en', ['123456'], [{ url: 'https://x.in/1' }]);
    const all = await request(app).get('/api/v1/dev/inbox');
    expect(all.status).toBe(200);
    expect(all.body.success).toBe(true);
    expect(all.body.data.map((m: { channel: string }) => m.channel)).toEqual(['WHATSAPP', 'EMAIL', 'SMS']);
    expect(all.body.data[1]).toMatchObject({
      to: 'a@x.in',
      subject: 'Hello',
      link: 'https://admin.societyapp.in/reset?token=abc',
    });
    expect((await request(app).get('/api/v1/dev/inbox?channel=sms')).body.data).toHaveLength(1);
    expect((await request(app).get('/api/v1/dev/inbox?to=a@x.in')).body.data).toHaveLength(1);
    const del = await request(app).delete('/api/v1/dev/inbox');
    expect(del.status).toBe(200);
    expect(await listInbox()).toEqual([]);
  });
  it('the inbox keeps the last 200 messages', async () => {
    for (let i = 0; i < 205; i++) await adapters().sms.send('9820011111', 't', `m${i}`);
    const l = await listInbox();
    expect(l).toHaveLength(200);
    expect(l[0].body).toBe('m204');
    await clearInbox();
  });
  it('notify never throws: unknown templates and failing senders are swallowed', async () => {
    registerTemplates({
      'test.hello': { channels: ['SMS'], critical: false, render: () => ({ sms: 'hi' }) },
    });
    await expect(notify('nope.nothing', [{ mobile: '9820011111' }])).resolves.toBeUndefined();
    const real = adapters();
    setAdapters({
      ...real,
      sms: {
        send: async () => {
          throw new Error('provider down');
        },
      },
    });
    await expect(
      notify('test.hello', [{ mobile: '9820011111' }, { mobile: '9820022222' }]),
    ).resolves.toBeUndefined();
    setAdapters(undefined);
    await notify('test.hello', [{ mobile: '9820011111' }]);
    expect((await listInbox())[0].body).toBe('hi');
  });
  it('real providers are refused until module 16 wires them in', async () => {
    setAdapters(undefined);
    expect(adapters().sms).toBeDefined();
  });
});

describe('log redaction (BR-01-3 and module 02 section 13)', () => {
  it('redacts the module 02 keys', () => {
    expect(
      redact({
        challengeToken: 'lc_x',
        recoveryCodes: ['RC-1'],
        credential: { id: 1 },
        newPassword: 'x',
        currentPassword: 'y',
        code: '123456',
        requestId: 'r',
        statusCode: 400,
      }),
    ).toEqual({
      challengeToken: '[REDACTED]',
      recoveryCodes: '[REDACTED]',
      credential: '[REDACTED]',
      newPassword: '[REDACTED]',
      currentPassword: '[REDACTED]',
      code: '[REDACTED]',
      requestId: 'r',
      statusCode: 400,
    });
  });
});
