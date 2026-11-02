import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, PlatformSetting, closeDb } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { listInbox } from '../../../src/lib/inbox';
import {
  drainQueues,
  enqueue,
  queueInspector,
  queueRegistry,
  registerProcessor,
  registerQueue,
} from '../../../src/lib/queue';
import { runFailedJobsAlert } from '../../../src/modules/platform-ops/platform-ops.jobs';
import {
  clearSettingsCache,
  seedPlatformSettings,
} from '../../../src/modules/platform-ops/platform-ops.settings.service';
import { events } from '../../helpers/auth';
import { resetLogins } from '../../helpers/access';
import { platformAs } from '../../helpers/societies';
import { resetOps } from '../../helpers/platform-ops';

afterAll(closeDb);

const Q = 'ops-test';
const behaviour = { fail: true };
function fail(name: string, message = 'Temporary glitch'): never {
  throw Object.assign(new Error(message), { name });
}
registerQueue(Q, 'Queue used by the module 07 tests', 3);
registerProcessor(Q, 'ops-test:transient', async () => {
  if (behaviour.fail) fail('Error');
});
registerProcessor(Q, 'ops-test:permanent', async () => {
  if (behaviour.fail) fail('ValidationError', 'Statement is not valid');
});
registerProcessor(Q, 'ops-test:ok', async () => undefined);

beforeEach(async () => {
  await resetOps();
  resetLogins();
  setNow('2026-10-30T04:00:00Z');
  behaviour.fail = true;
  await queueInspector().resume(Q);
});

async function failedJobs(permanent: number, transient: number) {
  for (let i = 0; i < permanent; i++) await enqueue(Q, 'ops-test:permanent', { societyId: 7, n: i });
  for (let i = 0; i < transient; i++) await enqueue(Q, 'ops-test:transient', { societyId: 8, n: i });
  await drainQueues();
}
const failed = async () => (await queueInspector().list(Q, 'failed', 0, 100)).items;

describe('GET /platform/queues and the job lists (8.8)', () => {
  it('lists the registered queues with counts and totals; the queue module itself is there', async () => {
    const admin = await platformAs('super_admin');
    await failedJobs(1, 2);
    const r = await admin.c('get', '/platform/queues');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const q = r.body.data.items.find((i: any) => i.name === Q);
    expect(q).toMatchObject({
      description: 'Queue used by the module 07 tests',
      concurrency: 3,
      isPaused: false,
      counts: { waiting: 0, active: 0, delayed: 0, failed: 3, completed24h: 0 },
      throughputPerMin: 0,
      oldestWaitingAgeSec: 0,
    });
    expect(r.body.data.items.some((i: any) => i.name === 'platform-ops')).toBe(true);
    expect(r.body.data.totals.failed).toBeGreaterThanOrEqual(3);
    expect(r.body.data.items.map((i: any) => i.name)).toEqual([...queueRegistry.keys()].sort());
    await enqueue(Q, 'ops-test:ok', {});
    await drainQueues();
    expect(
      (await admin.c('get', '/platform/queues')).body.data.items.find((i: any) => i.name === Q).counts
        .completed24h,
    ).toBe(1);
  });

  it('failed jobs of a queue and across queues, with the summary fields, filters and pagination', async () => {
    const admin = await platformAs('super_admin');
    await failedJobs(2, 3);
    const list = await admin.c('get', `/platform/queues/${Q}/jobs`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.pagination).toMatchObject({ page: 1, limit: 20, total: 5 });
    const permanent = list.body.data.find((j: any) => j.name === 'ops-test:permanent');
    expect(permanent).toMatchObject({
      queue: Q,
      societyId: 7,
      attemptsMade: 5,
      maxAttempts: 5,
      errorName: 'ValidationError',
      failedReason: 'Statement is not valid',
      isPermanent: true,
    });
    expect(list.body.data.find((j: any) => j.name === 'ops-test:transient')).toMatchObject({
      isPermanent: false,
      errorName: 'Error',
    });
    const bySociety = await admin.c('get', '/platform/jobs/failed', undefined, { query: { societyId: '8' } });
    expect(bySociety.body.data).toHaveLength(3);
    const byName = await admin.c('get', '/platform/jobs/failed', undefined, {
      query: { queue: Q, jobName: 'ops-test:permanent', limit: '1', page: '2' },
    });
    expect(byName.body.data).toHaveLength(1);
    expect(byName.body.pagination.total).toBe(2);
    expect(
      (await admin.c('get', '/platform/jobs/failed', undefined, { query: { queue: 'nope' } })).body.code,
    ).toBe('QUEUE_NOT_FOUND');
    expect((await admin.c('get', `/platform/queues/nope/jobs`)).body.code).toBe('QUEUE_NOT_FOUND');
    expect(
      (await admin.c('get', `/platform/queues/${Q}/jobs`, undefined, { query: { state: 'completed' } }))
        .status,
    ).toBe(400);
  });

  it('job detail: redacted payload, stack cut to 2000 characters, attempt options; unknown job is 404 JOB_NOT_FOUND', async () => {
    const admin = await platformAs('super_admin');
    await enqueue(Q, 'ops-test:transient', {
      societyId: 3,
      token: 'super-secret-token',
      mobile: '9820011111',
    });
    await drainQueues();
    const [job] = await failed();
    const r = await admin.c('get', `/platform/queues/${Q}/jobs/${job!.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.data).toEqual({ societyId: 3, token: '[REDACTED]', mobile: '98XXXXX111' });
    expect(r.body.data.opts).toMatchObject({ attempts: 5, backoff: { type: 'exponential', delay: 2000 } });
    expect(r.body.data.stacktrace.length).toBeLessThanOrEqual(2000);
    expect(r.body.data.state).toBe('failed');
    expect(JSON.stringify(r.body)).not.toContain('super-secret-token');
    expect((await admin.c('get', `/platform/queues/${Q}/jobs/99999`)).body.code).toBe('JOB_NOT_FOUND');
  });
});

describe('retry, discard, pause and resume (8.8, BR-07-41, BR-07-42)', () => {
  it('retry moves a failed job back to waiting and runs it; a permanent error gets a warning', async () => {
    const admin = await platformAs('super_admin');
    await failedJobs(1, 1);
    const jobs = await failed();
    const perm = jobs.find(j => j.name === 'ops-test:permanent')!;
    const trans = jobs.find(j => j.name === 'ops-test:transient')!;
    behaviour.fail = false;
    const a = await admin.c('post', `/platform/queues/${Q}/jobs/${trans.id}/retry`);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.data).toEqual({ jobId: trans.id, state: 'waiting', warning: null });
    const b = await admin.c('post', `/platform/queues/${Q}/jobs/${perm.id}/retry`);
    expect(b.body.data.warning).toBe('PERMANENT_ERROR_LIKELY_TO_FAIL');
    await drainQueues();
    expect(await failed()).toHaveLength(0);
    const audits = await AuditLog.findAll({
      where: { action: 'platform.job.retried' },
      order: [['id', 'ASC']],
    });
    expect(audits.map(x => x.entityId)).toEqual([`${Q}:${trans.id}`, `${Q}:${perm.id}`]);
    expect(audits[0]!.entityType).toBe('job');
    expect(audits[0]!.before).toEqual({ attemptsMade: 5, failedReason: 'Temporary glitch' });
    expect(audits[0]!.societyId).toBeNull();
  });

  it('T07-37 retrying or discarding a job that is not failed is 409 JOB_NOT_FAILED; unknown queue and job are 404', async () => {
    const admin = await platformAs('super_admin');
    await queueInspector().pause(Q);
    await enqueue(Q, 'ops-test:ok', {});
    await drainQueues();
    const waiting = (await queueInspector().list(Q, 'waiting', 0, 10)).items[0]!;
    const r = await admin.c('post', `/platform/queues/${Q}/jobs/${waiting.id}/retry`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('JOB_NOT_FAILED');
    const d = await admin.c('post', `/platform/queues/${Q}/jobs/${waiting.id}/discard`, {
      reason: 'Not needed any more',
    });
    expect(d.body.code).toBe('JOB_NOT_FAILED');
    expect((await admin.c('post', `/platform/queues/nope/jobs/1/retry`)).body.code).toBe('QUEUE_NOT_FOUND');
    expect((await admin.c('post', `/platform/queues/${Q}/jobs/424242/retry`)).body.code).toBe(
      'JOB_NOT_FOUND',
    );
  });

  it('T07-38 discard with a reason after step-up: 204, the job is gone, the audit row has the redacted payload', async () => {
    const admin = await platformAs('super_admin');
    await enqueue(Q, 'ops-test:transient', { societyId: 4, token: 'secret-value-123' });
    await drainQueues();
    const [job] = await failed();
    expect((await admin.c('post', `/platform/queues/${Q}/jobs/${job!.id}/discard`, {})).status).toBe(400); // reason is required
    expect(
      (await admin.c('post', `/platform/queues/${Q}/jobs/${job!.id}/discard`, { reason: 'abc' })).status,
    ).toBe(400);
    const r = await admin.c('post', `/platform/queues/${Q}/jobs/${job!.id}/discard`, {
      reason: 'Payload is obsolete',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    expect(await failed()).toHaveLength(0);
    expect((await admin.c('get', `/platform/queues/${Q}/jobs/${job!.id}`)).body.code).toBe('JOB_NOT_FOUND');
    const a = (await AuditLog.findOne({ where: { action: 'platform.job.discarded' } }))!;
    expect(a.reason).toBe('Payload is obsolete');
    expect(a.before).toMatchObject({
      name: 'ops-test:transient',
      failedReason: 'Temporary glitch',
      data: { societyId: 4, token: '[REDACTED]' },
    });
    expect(JSON.stringify(a)).not.toContain('secret-value-123');
  });

  it('discard, pause and resume need a recent sign-in; Platform Support cannot retry or discard', async () => {
    const admin = await platformAs('super_admin');
    const agent = await platformAs('platform_support');
    await failedJobs(0, 1);
    const [job] = await failed();
    expect((await agent.c('post', `/platform/queues/${Q}/jobs/${job!.id}/retry`)).status).toBe(403);
    expect(
      (await agent.c('post', `/platform/queues/${Q}/pause`, { reason: 'Maintenance window' })).status,
    ).toBe(403);
    expect((await agent.c('post', '/platform/queues/retry-failed', {})).status).toBe(403);
    setNow('2026-10-30T04:06:00Z');
    for (const [path, body] of [
      [`/platform/queues/${Q}/jobs/${job!.id}/discard`, { reason: 'Payload is obsolete' }],
      [`/platform/queues/${Q}/pause`, { reason: 'Maintenance window' }],
      [`/platform/queues/${Q}/resume`, { reason: 'Maintenance is over' }],
    ] as const) {
      const r = await admin.c('post', path, body);
      expect(r.status, path).toBe(401);
      expect(r.body.code).toBe('REAUTH_REQUIRED');
    }
    expect(await failed()).toHaveLength(1);
  });

  it('T07-40 pause and resume: audit, realtime event, and the 409 codes; unknown queue is 404', async () => {
    const admin = await platformAs('super_admin');
    const p = await admin.c('post', `/platform/queues/${Q}/pause`, { reason: 'Maintenance window' });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data).toMatchObject({ name: Q, isPaused: true });
    expect(
      events.some(
        e =>
          e.room === 'platform:ops' &&
          e.event === 'platform.queue.changed' &&
          (e.payload as any).isPaused === true,
      ),
    ).toBe(true);
    const again = await admin.c('post', `/platform/queues/${Q}/pause`, { reason: 'Maintenance window' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('QUEUE_ALREADY_PAUSED');
    // a paused queue holds new jobs as waiting and runs them on resume
    await enqueue(Q, 'ops-test:ok', {});
    await drainQueues();
    expect(
      (await admin.c('get', '/platform/queues')).body.data.items.find((i: any) => i.name === Q),
    ).toMatchObject({ isPaused: true, counts: { waiting: 1 }, throughputPerMin: 0 });
    expect(
      (await admin.c('get', `/platform/queues/${Q}/jobs`, undefined, { query: { state: 'waiting' } })).body
        .data,
    ).toHaveLength(1);
    const res = await admin.c('post', `/platform/queues/${Q}/resume`, { reason: 'Maintenance is over' });
    expect(res.body.data.isPaused).toBe(false);
    await drainQueues();
    expect((await queueInspector().snapshot(Q)).waiting).toBe(0);
    const notPaused = await admin.c('post', `/platform/queues/${Q}/resume`, {
      reason: 'Maintenance is over',
    });
    expect(notPaused.status).toBe(409);
    expect(notPaused.body.code).toBe('QUEUE_NOT_PAUSED');
    expect(
      (await admin.c('post', '/platform/queues/nope/pause', { reason: 'Maintenance window' })).body.code,
    ).toBe('QUEUE_NOT_FOUND');
    expect(
      (
        await AuditLog.findAll({
          where: { action: ['platform.queue.paused', 'platform.queue.resumed'] },
          order: [['id', 'ASC']],
        })
      ).map(a => a.action),
    ).toEqual(['platform.queue.paused', 'platform.queue.resumed']);
  });

  it('T07-39 bulk retry with 3 permanent and 4 transient failures: retried 4, skippedPermanent 3; includePermanent retries all', async () => {
    const admin = await platformAs('super_admin');
    await failedJobs(3, 4);
    behaviour.fail = false;
    const r = await admin.c('post', '/platform/queues/retry-failed', { queue: Q });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual({ examined: 7, retried: 4, skippedPermanent: 3 });
    await drainQueues();
    const left = await failed();
    expect(left).toHaveLength(3);
    expect(left.every(j => j.name === 'ops-test:permanent')).toBe(true);
    const all = await admin.c('post', '/platform/queues/retry-failed', { queue: Q, includePermanent: true });
    expect(all.body.data).toEqual({ examined: 3, retried: 3, skippedPermanent: 0 });
    await drainQueues();
    expect(await failed()).toHaveLength(0);
    const a = await AuditLog.findAll({
      where: { action: 'platform.queue.bulk_retried' },
      order: [['id', 'ASC']],
    });
    expect(a[0]!.after).toEqual({ examined: 7, retried: 4, skippedPermanent: 3 });
    expect(a[0]!.entityId).toBe(Q);
  });

  it('bulk retry examines at most `max` jobs and every queue when none is named; unknown queue is 404', async () => {
    const admin = await platformAs('super_admin');
    await failedJobs(0, 5);
    behaviour.fail = false;
    const r = await admin.c('post', '/platform/queues/retry-failed', { max: 2 });
    expect(r.body.data.examined).toBe(2);
    expect(r.body.data.retried).toBe(2);
    expect((await admin.c('post', '/platform/queues/retry-failed', { max: 501 })).status).toBe(400);
    expect((await admin.c('post', '/platform/queues/retry-failed', { queue: 'nope' })).body.code).toBe(
      'QUEUE_NOT_FOUND',
    );
    await drainQueues();
    expect((await admin.c('post', '/platform/queues/retry-failed', {})).body.data).toMatchObject({
      examined: 3,
      retried: 3,
    });
  });
});

describe('failed-jobs alert (9.1, 6.5)', () => {
  it('notifies the users holding platform.jobs.edit when the failed count rose, once per rise; off when alerts.jobFailed is false', async () => {
    const admin = await platformAs('super_admin', 'Asha Admin');
    const agent = await platformAs('platform_support');
    void agent;
    await failedJobs(0, 2);
    const r = await runFailedJobsAlert();
    expect(r).toMatchObject({ alerted: true });
    expect(r.failed).toBeGreaterThanOrEqual(2);
    const mail = (await listInbox()).filter(m => m.subject?.endsWith('failed background jobs'));
    expect(mail.length).toBeGreaterThan(0);
    const count = mail.length;
    expect((await runFailedJobsAlert()).alerted).toBe(false); // no new failures since the last run
    expect((await listInbox()).filter(m => m.subject?.endsWith('failed background jobs'))).toHaveLength(
      count,
    );
    await failedJobs(0, 1);
    expect((await runFailedJobsAlert()).alerted).toBe(true);
    await seedPlatformSettings();
    await PlatformSetting.update({ valueJson: false }, { where: { settingKey: 'alerts.jobFailed' } });
    await clearSettingsCache();
    await failedJobs(0, 1);
    expect((await runFailedJobsAlert()).alerted).toBe(false);
    void admin;
  });
});
