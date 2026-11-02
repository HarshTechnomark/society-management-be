import { sequelize } from '../../models';
import { queueInspector, queueRegistry, type JobRecord } from '../../lib/queue';
import { redact } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import { ConflictError, NotFoundError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { AUDIT, ENTITY } from './platform-ops.types';
import { emitOps } from './platform-ops.shared';

/** Jobs and queues monitor (module 07 section 8.8, BR-07-40 to BR-07-42). Works with BullMQ and the in-process runner. */
const PERMANENT_ERRORS = new Set([
  'SignatureMismatch',
  'AmountMismatchError',
  'StatementParseError',
  'UnrecoverableError',
  'ValidationError',
]);
const WINDOW = 1000; // failed jobs read per queue for filtering and merging

export const queueNotFound = () => new NotFoundError('QUEUE_NOT_FOUND', 'Queue not found');
export const jobNotFound = () => new NotFoundError('JOB_NOT_FOUND', 'Job not found');
const registered = (name: string) => {
  const q = queueRegistry.get(name);
  if (!q) throw queueNotFound();
  return q;
};

/** BR-07-41: permanent when the error name is on the list or the job failed before using all its attempts. */
export const isPermanent = (j: JobRecord): boolean =>
  (j.errorName !== null && PERMANENT_ERRORS.has(j.errorName)) ||
  (j.state === 'failed' && j.attemptsMade < j.maxAttempts);

const societyOf = (j: JobRecord): number | null => {
  const v = (j.data as { societyId?: unknown }).societyId;
  return typeof v === 'number' ? v : null;
};

export const jobSummary = (j: JobRecord) => ({
  queue: j.queue,
  jobId: j.id,
  name: j.name,
  societyId: societyOf(j),
  attemptsMade: j.attemptsMade,
  maxAttempts: j.maxAttempts,
  errorName: j.errorName,
  failedReason: j.failedReason ? j.failedReason.slice(0, 500) : null,
  isPermanent: j.state === 'failed' ? isPermanent(j) : false,
  failedAt: j.failedAt,
  createdAt: j.createdAt,
});

async function queueObject(name: string) {
  const q = registered(name);
  const s = await queueInspector().snapshot(name);
  return {
    name,
    description: q.description,
    concurrency: q.concurrency,
    isPaused: s.isPaused,
    counts: {
      waiting: s.waiting,
      active: s.active,
      delayed: s.delayed,
      failed: s.failed,
      completed24h: s.completed24h,
    },
    throughputPerMin: s.throughputPerMin,
    oldestWaitingAgeSec: s.oldestWaitingAgeSec,
  };
}

export async function listQueues() {
  const items = await Promise.all([...queueRegistry.keys()].sort().map(queueObject));
  const sum = (f: (i: (typeof items)[number]) => number) => items.reduce((a, i) => a + f(i), 0);
  return {
    items,
    totals: {
      waiting: sum(i => i.counts.waiting),
      active: sum(i => i.counts.active),
      delayed: sum(i => i.counts.delayed),
      failed: sum(i => i.counts.failed),
      throughputPerMin: sum(i => i.throughputPerMin),
      pausedQueues: items.filter(i => i.isPaused).length,
    },
  };
}

interface JobFilter {
  jobName?: string;
  societyId?: number;
  page: number;
  limit: number;
}

function paginate(all: JobRecord[], f: JobFilter) {
  const filtered = all.filter(
    j => (!f.jobName || j.name === f.jobName) && (!f.societyId || societyOf(j) === f.societyId),
  );
  const items = filtered.slice((f.page - 1) * f.limit, f.page * f.limit).map(jobSummary);
  return { data: items, pagination: pageMeta(f.page, f.limit, filtered.length) };
}

export async function listJobs(
  name: string,
  f: JobFilter & { state: 'failed' | 'delayed' | 'waiting' | 'active' },
) {
  registered(name);
  const { items } = await queueInspector().list(name, f.state, 0, WINDOW);
  return paginate(items, f);
}

export async function listFailedJobs(f: JobFilter & { queue?: string }) {
  const names = f.queue ? [registered(f.queue).queue] : [...queueRegistry.keys()];
  const all: JobRecord[] = [];
  for (const n of names) all.push(...(await queueInspector().list(n, 'failed', 0, WINDOW)).items);
  all.sort((a, b) => (b.failedAt?.getTime() ?? 0) - (a.failedAt?.getTime() ?? 0));
  return paginate(all, f);
}

async function findJob(queue: string, jobId: string): Promise<JobRecord> {
  registered(queue);
  const j = await queueInspector().get(queue, jobId);
  if (!j) throw jobNotFound();
  return j;
}

export async function getJob(queue: string, jobId: string) {
  const j = await findJob(queue, jobId);
  return {
    ...jobSummary(j),
    state: j.state,
    data: redact(j.data),
    stacktrace: j.stacktrace ? j.stacktrace.slice(0, 2000) : null,
    opts: { attempts: j.maxAttempts, backoff: j.backoff },
  };
}

const notFailed = () => new ConflictError('JOB_NOT_FAILED', 'Only a failed job can be retried or discarded');

export async function retryJob(ctx: Ctx, queue: string, jobId: string) {
  const j = await findJob(queue, jobId);
  if (j.state !== 'failed') throw notFailed();
  const permanent = isPermanent(j);
  await sequelize.transaction(async t => {
    await audit(
      ctx,
      {
        action: AUDIT.jobRetried,
        entityType: ENTITY.job,
        entityId: `${queue}:${jobId}`,
        before: { attemptsMade: j.attemptsMade, failedReason: j.failedReason?.slice(0, 300) ?? null },
      },
      t,
    );
    await queueInspector().retry(queue, jobId);
  });
  return {
    jobId,
    state: 'waiting' as const,
    warning: permanent ? 'PERMANENT_ERROR_LIKELY_TO_FAIL' : null,
  };
}

export async function discardJob(ctx: Ctx, queue: string, jobId: string, reason: string): Promise<void> {
  const j = await findJob(queue, jobId);
  if (j.state !== 'failed') throw notFailed();
  await sequelize.transaction(async t => {
    await audit(
      ctx,
      {
        action: AUDIT.jobDiscarded,
        entityType: ENTITY.job,
        entityId: `${queue}:${jobId}`,
        before: { name: j.name, failedReason: j.failedReason?.slice(0, 300) ?? null, data: redact(j.data) },
        reason,
      },
      t,
    );
    await queueInspector().remove(queue, jobId);
  });
}

async function setPaused(ctx: Ctx, name: string, paused: boolean, reason: string) {
  registered(name);
  const now = (await queueInspector().snapshot(name)).isPaused;
  if (paused && now) throw new ConflictError('QUEUE_ALREADY_PAUSED', 'This queue is already paused');
  if (!paused && !now) throw new ConflictError('QUEUE_NOT_PAUSED', 'This queue is not paused');
  await sequelize.transaction(async t => {
    await audit(
      ctx,
      {
        action: paused ? AUDIT.queuePaused : AUDIT.queueResumed,
        entityType: ENTITY.queue,
        entityId: name,
        before: { isPaused: now },
        after: { isPaused: paused },
        reason,
      },
      t,
    );
    if (paused) await queueInspector().pause(name);
    else await queueInspector().resume(name);
    emitOps(t, 'platform.queue.changed', { queue: name, isPaused: paused });
  });
  return queueObject(name);
}
export const pauseQueue = (ctx: Ctx, name: string, reason: string) => setPaused(ctx, name, true, reason);
export const resumeQueue = (ctx: Ctx, name: string, reason: string) => setPaused(ctx, name, false, reason);

/** `POST /queues/retry-failed`: at most `max` (500) failed jobs examined; permanent ones are skipped unless asked for. */
export async function bulkRetry(
  ctx: Ctx,
  input: { queue?: string; includePermanent?: boolean; max?: number },
) {
  const names = input.queue ? [registered(input.queue).queue] : [...queueRegistry.keys()].sort();
  const max = Math.min(500, input.max ?? 500);
  const r = { examined: 0, retried: 0, skippedPermanent: 0 };
  const todo: JobRecord[] = [];
  for (const n of names) {
    if (r.examined >= max) break;
    const { items } = await queueInspector().list(n, 'failed', 0, max - r.examined);
    for (const j of items) {
      r.examined += 1;
      if (isPermanent(j) && !input.includePermanent) r.skippedPermanent += 1;
      else todo.push(j);
    }
  }
  await sequelize.transaction(async t => {
    await audit(
      ctx,
      {
        action: AUDIT.queueBulkRetried,
        entityType: ENTITY.queue,
        entityId: input.queue ?? 'all',
        after: { examined: r.examined, retried: todo.length, skippedPermanent: r.skippedPermanent },
      },
      t,
    );
    for (const j of todo) await queueInspector().retry(j.queue, j.id);
  });
  r.retried = todo.length;
  return r;
}

/** Sum of failed jobs over all registered queues (dashboard and failed-jobs alert). */
export async function totalFailed(): Promise<number> {
  let n = 0;
  for (const q of queueRegistry.keys()) n += (await queueInspector().snapshot(q)).failed;
  return n;
}
