import type { Transaction } from 'sequelize';
import { Queue, Worker } from 'bullmq';
import { env } from './env';
import { logger } from './logger';
import { istClock, now } from './clock';
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
let memoryBackoffMs = 2000;
const seenJobIds = new Set<string>();
const inflight = new Set<Promise<void>>();
const lastRun = new Map<string, number>();
let timer: NodeJS.Timeout | undefined;

/** Test helper: shorten the retry delay of the in-process runner. */
export function configureMemoryQueue(opts: { backoffMs: number }): void {
  memoryBackoffMs = opts.backoffMs;
}

async function runWithRetries(job: string, data: JobData): Promise<void> {
  const reg = processors.get(job);
  if (!reg) {
    logger.warn({ job }, 'no processor registered for job');
    return;
  }
  for (let attempt = 1; attempt <= DEFAULT_JOB_OPTIONS.attempts; attempt++) {
    try {
      await reg.processor(data);
      return;
    } catch (err) {
      logger.warn({ err, job, attempt }, 'job failed');
      if (attempt === DEFAULT_JOB_OPTIONS.attempts) return;
      await new Promise(r => setTimeout(r, memoryBackoffMs * 2 ** (attempt - 1)));
    }
  }
}

function memoryAdd(job: string, data: JobData, opts: EnqueueOptions): void {
  if (opts.jobId) {
    if (seenJobIds.has(opts.jobId)) return;
    seenJobIds.add(opts.jobId);
  }
  const p: Promise<void> = new Promise<void>(resolve => {
    setTimeout(() => {
      runWithRetries(job, data).finally(resolve);
    }, opts.delayMs ?? 0);
  }).finally(() => inflight.delete(p));
  inflight.add(p);
}

/** Test helper: wait until every job enqueued so far has finished (including retries). */
export async function drainQueues(): Promise<void> {
  while (inflight.size) await Promise.all([...inflight]);
}

/** Test helper. */
export function resetQueueState(): void {
  seenJobIds.clear();
  lastRun.clear();
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
      memoryAdd(r.job, {}, {});
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
  memoryAdd(job, data, opts);
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
