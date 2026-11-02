import type { Transaction } from 'sequelize';
import { Queue, Worker, type Job } from 'bullmq';
import { env } from './env';
import { logger } from './logger';
import { istClock, now, nowMs } from './clock';
import { redis } from './kv';

/**
 * Job framework (module 01 section 9.1). One call shape, two drivers: BullMQ on Redis (REDIS_URL set) and an
 * in-process runner (development and tests). Processors are the same for both, so the job logic is tested.
 * Queue names are module folder names; job names are `<module>:<job>`.
 */
export type JobData = Record<string, unknown>;
export type JobProcessor = (data: JobData) => Promise<unknown>;

export type Schedule = { everyMs: number } | { hourlyAtMinute: number } | { dailyAtIst: string };

export interface EnqueueOptions {
  jobId?: string;
  delayMs?: number;
}

export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: false,
};

interface Registered {
  queue: string;
  job: string;
  processor: JobProcessor;
}
interface Repeatable {
  queue: string;
  job: string;
  schedule: Schedule;
}

const processors = new Map<string, Registered>(); // by job name
const repeatables: Repeatable[] = [];
export const queueRegistry = new Map<string, { queue: string; description: string; concurrency: number }>();

export function registerQueue(queue: string, description: string, concurrency = 5): void {
  queueRegistry.set(queue, { queue, description, concurrency });
}

export function registerProcessor(queue: string, job: string, processor: JobProcessor): void {
  processors.set(job, { queue, job, processor });
}

export function registerRepeatable(queue: string, job: string, schedule: Schedule): void {
  if (!repeatables.some(r => r.job === job)) repeatables.push({ queue, job, schedule });
}

// ---------------------------------------------------------------- memory driver
export type JobState = 'waiting' | 'active' | 'delayed' | 'failed' | 'completed';
/** What the jobs monitor (module 07 section 8.8) sees of a job, for both drivers. */
export interface JobRecord {
  id: string;
  queue: string;
  name: string;
  data: JobData;
  state: JobState;
  attemptsMade: number;
  maxAttempts: number;
  errorName: string | null;
  failedReason: string | null;
  stacktrace: string | null;
  backoff: unknown;
  createdAt: Date;
  failedAt: Date | null;
}
interface MemJob extends JobRecord {
  held: boolean;
}

let memoryBackoffMs = 2000;
const seenJobIds = new Set<string>();
const inflight = new Set<Promise<void>>();
const lastRun = new Map<string, number>();
const memJobs = new Map<string, MemJob>(); // `${queue}:${id}`; completed jobs are only counted
const completions = new Map<string, number[]>(); // queue -> completion times (ms), last 24 hours
const pausedQueues = new Set<string>();
let memSeq = 0;
const MAX_MEM_FAILED = 1000;
let timer: NodeJS.Timeout | undefined;

/** Test helper: shorten the retry delay of the in-process runner. */
export function configureMemoryQueue(opts: { backoffMs: number }): void {
  memoryBackoffMs = opts.backoffMs;
}

async function runWithRetries(
  job: string,
  data: JobData,
  onAttempt: (n: number) => void,
): Promise<{ ok: true } | { ok: false; error: Error }> {
  const reg = processors.get(job);
  if (!reg) {
    logger.warn({ job }, 'no processor registered for job');
    return { ok: true };
  }
  for (let attempt = 1; attempt <= DEFAULT_JOB_OPTIONS.attempts; attempt++) {
    onAttempt(attempt);
    try {
      await reg.processor(data);
      return { ok: true };
    } catch (err) {
      logger.warn({ err, job, attempt }, 'job failed');
      if (attempt === DEFAULT_JOB_OPTIONS.attempts)
        return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
      await new Promise(r => setTimeout(r, memoryBackoffMs * 2 ** (attempt - 1)));
    }
  }
  return { ok: true };
}

async function runMemJob(rec: MemJob): Promise<void> {
  rec.state = 'active';
  const r = await runWithRetries(rec.name, rec.data, n => {
    rec.attemptsMade = n;
  });
  const key = `${rec.queue}:${rec.id}`;
  if (r.ok) {
    memJobs.delete(key);
    const list = completions.get(rec.queue) ?? [];
    list.push(nowMs());
    completions.set(rec.queue, list.filter(t => t > nowMs() - 86_400_000).slice(-100_000));
    return;
  }
  rec.state = 'failed';
  rec.errorName = r.error.name;
  rec.failedReason = r.error.message;
  rec.stacktrace = r.error.stack ?? null;
  rec.failedAt = now();
  const failed = [...memJobs.values()].filter(j => j.queue === rec.queue && j.state === 'failed');
  if (failed.length > MAX_MEM_FAILED) memJobs.delete(`${rec.queue}:${failed[0]!.id}`);
}

function launch(rec: MemJob, delayMs: number): void {
  const p: Promise<void> = new Promise<void>(resolve => {
    setTimeout(() => {
      if (pausedQueues.has(rec.queue)) {
        rec.state = 'waiting';
        rec.held = true; // runs when the queue is resumed
        return resolve();
      }
      rec.held = false;
      runMemJob(rec).finally(resolve);
    }, delayMs);
  }).finally(() => inflight.delete(p));
  inflight.add(p);
}

function memoryAdd(queue: string, job: string, data: JobData, opts: EnqueueOptions): void {
  if (opts.jobId) {
    if (seenJobIds.has(opts.jobId)) return;
    seenJobIds.add(opts.jobId);
  }
  memSeq += 1;
  const id = opts.jobId ?? String(memSeq);
  const rec: MemJob = {
    id,
    queue,
    name: job,
    data,
    state: opts.delayMs ? 'delayed' : 'waiting',
    attemptsMade: 0,
    maxAttempts: DEFAULT_JOB_OPTIONS.attempts,
    errorName: null,
    failedReason: null,
    stacktrace: null,
    backoff: DEFAULT_JOB_OPTIONS.backoff,
    createdAt: now(),
    failedAt: null,
    held: false,
  };
  memJobs.set(`${queue}:${id}`, rec);
  launch(rec, opts.delayMs ?? 0);
}

/** Test helper: wait until every job enqueued so far has finished (including retries). Jobs held by a paused queue do not count. */
export async function drainQueues(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}

/** Test helper. */
export function resetQueueState(): void {
  seenJobIds.clear();
  lastRun.clear();
  memJobs.clear();
  completions.clear();
  pausedQueues.clear();
}

export function isDue(s: Schedule, last: number, at: Date): boolean {
  const t = at.getTime();
  const minuteBucket = Math.floor(t / 60_000);
  if ('everyMs' in s) return t - last >= s.everyMs;
  if (Math.floor(last / 60_000) === minuteBucket) return false;
  const { hour, minute } = istClock(at);
  if ('hourlyAtMinute' in s) return minute === s.hourlyAtMinute;
  const [h, m] = s.dailyAtIst.split(':').map(Number);
  return hour === h && minute === m;
}

/** Runs the repeatable jobs that are due at `at` (in-process scheduler tick; exported for tests). */
export async function tickScheduler(at: Date = now()): Promise<string[]> {
  const fired: string[] = [];
  for (const r of repeatables) {
    const last = lastRun.get(r.job) ?? 0;
    if (isDue(r.schedule, last, at)) {
      lastRun.set(r.job, at.getTime());
      memoryAdd(r.queue, r.job, {}, {});
      fired.push(r.job);
    }
  }
  return fired;
}

// ---------------------------------------------------------------- BullMQ driver
const bullQueues = new Map<string, Queue>();
const bullWorkers: Worker[] = [];

function bullQueue(name: string): Queue {
  let q = bullQueues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redis()!, defaultJobOptions: DEFAULT_JOB_OPTIONS });
    bullQueues.set(name, q);
  }
  return q;
}

const cronFor = (s: Schedule): { every: number } | { pattern: string; tz: string } => {
  if ('everyMs' in s) return { every: s.everyMs };
  if ('hourlyAtMinute' in s) return { pattern: `${s.hourlyAtMinute} * * * *`, tz: 'Asia/Kolkata' };
  const [h, m] = s.dailyAtIst.split(':').map(Number);
  return { pattern: `${m} ${h} * * *`, tz: 'Asia/Kolkata' };
};

// ---------------------------------------------------------------- public API
export function usesRedis(): boolean {
  return Boolean(env().REDIS_URL);
}

/** Enqueue a job. Payloads contain ids only (never personal data) plus an optional requestId. */
export async function enqueue(
  queue: string,
  job: string,
  data: JobData,
  opts: EnqueueOptions = {},
): Promise<void> {
  if (usesRedis()) {
    await bullQueue(queue).add(job, data, { jobId: opts.jobId, delay: opts.delayMs });
    return;
  }
  memoryAdd(queue, job, data, opts);
}

/** Enqueue after the transaction commits (BR-01-15); nothing is enqueued if it rolls back. */
export function enqueueAfterCommit(
  tx: Transaction,
  queue: string,
  job: string,
  data: JobData,
  opts: EnqueueOptions = {},
): void {
  tx.afterCommit(async () => {
    try {
      await enqueue(queue, job, data, opts);
    } catch (err) {
      logger.error({ err, job }, 'failed to enqueue job');
    }
  });
}

/**
 * Starts workers and repeatable jobs: BullMQ workers on Redis, or the in-process scheduler without Redis.
 * Called by `worker.ts`, and by `server.ts` when Redis is not configured.
 */
export async function startWorkers(): Promise<void> {
  if (usesRedis()) {
    const byQueue = new Map<string, Registered[]>();
    for (const p of processors.values()) byQueue.set(p.queue, [...(byQueue.get(p.queue) ?? []), p]);
    for (const [queue, regs] of byQueue) {
      bullWorkers.push(
        new Worker(
          queue,
          async job => {
            const reg = regs.find(r => r.job === job.name);
            if (!reg) throw new Error(`No processor for ${job.name}`);
            return reg.processor(job.data as JobData);
          },
          {
            connection: redis()!,
            concurrency: queueRegistry.get(queue)?.concurrency ?? 5,
            metrics: { maxDataPoints: 60 * 24 },
          },
        ),
      );
    }
    for (const r of repeatables)
      await bullQueue(r.queue).upsertJobScheduler(r.job, cronFor(r.schedule), { name: r.job, data: {} });
    return;
  }
  if (timer) return;
  timer = setInterval(() => void tickScheduler(), 20_000);
  timer.unref();
}

export async function stopWorkers(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  await Promise.all(bullWorkers.splice(0).map(w => w.close()));
  await Promise.all([...bullQueues.values()].map(q => q.close()));
  bullQueues.clear();
}

// ---------------------------------------------------------------- inspection (module 07 jobs and queues monitor)
export interface QueueSnapshot {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed24h: number;
  isPaused: boolean;
  throughputPerMin: number;
  oldestWaitingAgeSec: number;
}

export interface QueueInspector {
  snapshot(queue: string): Promise<QueueSnapshot>;
  list(
    queue: string,
    state: Exclude<JobState, 'completed'>,
    offset: number,
    limit: number,
  ): Promise<{ items: JobRecord[]; total: number }>;
  get(queue: string, jobId: string): Promise<JobRecord | null>;
  /** Moves a failed job back to waiting. */
  retry(queue: string, jobId: string): Promise<void>;
  remove(queue: string, jobId: string): Promise<void>;
  pause(queue: string): Promise<void>;
  resume(queue: string): Promise<void>;
}

/** `<Name>:` of the first stack line (BullMQ keeps only the stack text). */
export const errorNameOf = (stack: string | null | undefined): string | null => {
  const m = /^\s*([A-Za-z_$][\w$]*)(?::|\s*$)/.exec((stack ?? '').split('\n')[0] ?? '');
  return m ? m[1]! : null;
};

const memoryInspector: QueueInspector = {
  async snapshot(queue) {
    const jobs = [...memJobs.values()].filter(j => j.queue === queue);
    const count = (s: JobState) => jobs.filter(j => j.state === s).length;
    const t = nowMs();
    const done = (completions.get(queue) ?? []).filter(x => x > t - 86_400_000);
    const minute = Math.floor(t / 60_000) - 1;
    const waiting = jobs.filter(j => j.state === 'waiting');
    const oldest = waiting.length ? Math.min(...waiting.map(j => j.createdAt.getTime())) : null;
    return {
      waiting: count('waiting'),
      active: count('active'),
      delayed: count('delayed'),
      failed: count('failed'),
      completed24h: done.length,
      isPaused: pausedQueues.has(queue),
      throughputPerMin: pausedQueues.has(queue)
        ? 0
        : done.filter(x => Math.floor(x / 60_000) === minute).length,
      oldestWaitingAgeSec: oldest === null ? 0 : Math.max(0, Math.floor((t - oldest) / 1000)),
    };
  },
  async list(queue, state, offset, limit) {
    const all = [...memJobs.values()]
      .filter(j => j.queue === queue && j.state === state)
      .sort((a, b) => (b.failedAt ?? b.createdAt).getTime() - (a.failedAt ?? a.createdAt).getTime());
    return { items: all.slice(offset, offset + limit).map(j => ({ ...j })), total: all.length };
  },
  async get(queue, jobId) {
    const rec = memJobs.get(`${queue}:${jobId}`);
    return rec ? { ...rec } : null;
  },
  async retry(queue, jobId) {
    const rec = memJobs.get(`${queue}:${jobId}`);
    if (!rec || rec.state !== 'failed') return;
    Object.assign(rec, {
      state: 'waiting',
      attemptsMade: 0,
      errorName: null,
      failedReason: null,
      stacktrace: null,
      failedAt: null,
    });
    launch(rec, 0);
  },
  async remove(queue, jobId) {
    memJobs.delete(`${queue}:${jobId}`);
  },
  async pause(queue) {
    pausedQueues.add(queue);
  },
  async resume(queue) {
    pausedQueues.delete(queue);
    for (const rec of memJobs.values()) if (rec.queue === queue && rec.held) launch(rec, 0);
  },
};

const bullRecord = (queue: string, job: Job, state: JobState): JobRecord => {
  const stack = job.stacktrace?.length ? job.stacktrace.join('\n') : null;
  return {
    id: String(job.id),
    queue,
    name: job.name,
    data: (job.data ?? {}) as JobData,
    state,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts?.attempts ?? DEFAULT_JOB_OPTIONS.attempts,
    errorName: errorNameOf(stack) ?? (job.failedReason ? 'Error' : null),
    failedReason: job.failedReason ?? null,
    stacktrace: stack,
    backoff: job.opts?.backoff ?? DEFAULT_JOB_OPTIONS.backoff,
    createdAt: new Date(job.timestamp),
    failedAt: state === 'failed' && job.finishedOn ? new Date(job.finishedOn) : null,
  };
};

/** BullMQ implementation (written for production; not run against a real Redis in this build). */
const bullInspector: QueueInspector = {
  async snapshot(queue) {
    const q = bullQueue(queue);
    const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
    let completed24h = 0;
    let throughputPerMin = 0;
    try {
      const m = await q.getMetrics('completed', 0, 24 * 60 - 1);
      completed24h = m.data.reduce((a, b) => a + b, 0);
      throughputPerMin = m.data[1] ?? 0; // data[0] is the minute in progress
    } catch (err) {
      logger.warn({ err, queue }, 'queue metrics unavailable');
    }
    const isPaused = await q.isPaused();
    const oldest = await q.getJobs(['waiting'], 0, 0, true);
    return {
      waiting: c.waiting ?? 0,
      active: c.active ?? 0,
      delayed: c.delayed ?? 0,
      failed: c.failed ?? 0,
      completed24h,
      isPaused,
      throughputPerMin: isPaused ? 0 : throughputPerMin,
      oldestWaitingAgeSec: oldest[0] ? Math.max(0, Math.floor((nowMs() - oldest[0].timestamp) / 1000)) : 0,
    };
  },
  async list(queue, state, offset, limit) {
    const q = bullQueue(queue);
    const total = (await q.getJobCounts(state))[state] ?? 0;
    const jobs = await q.getJobs([state], offset, offset + limit - 1, false);
    return { items: jobs.filter(Boolean).map(j => bullRecord(queue, j, state)), total };
  },
  async get(queue, jobId) {
    const job = await bullQueue(queue).getJob(jobId);
    if (!job) return null;
    return bullRecord(queue, job, (await job.getState()) as JobState);
  },
  async retry(queue, jobId) {
    const job = await bullQueue(queue).getJob(jobId);
    if (job) await job.retry('failed');
  },
  async remove(queue, jobId) {
    const job = await bullQueue(queue).getJob(jobId);
    if (job) await job.remove();
  },
  async pause(queue) {
    await bullQueue(queue).pause();
  },
  async resume(queue) {
    await bullQueue(queue).resume();
  },
};

/** The inspector of the active driver (BullMQ with `REDIS_URL`, the in-process runner without). */
export const queueInspector = (): QueueInspector => (usesRedis() ? bullInspector : memoryInspector);
