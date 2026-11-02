import type { RequestHandler } from 'express';
import { nowMs } from '../../lib/clock';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';

/**
 * Request metrics (module 07 section 9.4): on `res.finish` one count per minute, one 5xx count and one latency bucket in a
 * key-value hash `m:<yyyyMMddHHmm>` (fields `t`, `e`, `l<bucket>`), expiring after 7200 seconds. Errors are swallowed.
 */
export const LATENCY_BUCKETS = [50, 100, 200, 300, 400, 600, 800, 1000, 1500, 2000, 3000, 5000] as const;
const TTL_SECONDS = 7200;
const EXCLUDED = ['/api/v1/health', '/api/v1/public/status'];

export const minuteKey = (ms: number): string =>
  `m:${new Date(ms).toISOString().slice(0, 16).replace(/[-T:]/g, '')}`;

export const bucketFor = (ms: number): string => {
  const b = LATENCY_BUCKETS.find(x => ms <= x);
  return b === undefined ? 'linf' : `l${b}`;
};

export const requestMetrics = (): RequestHandler => (req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const path = req.originalUrl.split('?')[0]!;
    if (EXCLUDED.some(p => path === p || path.startsWith(`${p}/`))) return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const key = minuteKey(nowMs());
    const writes = [
      kv().hashIncr(key, 't', 1, TTL_SECONDS),
      kv().hashIncr(key, bucketFor(ms), 1, TTL_SECONDS),
    ];
    if (res.statusCode >= 500) writes.push(kv().hashIncr(key, 'e', 1, TTL_SECONDS));
    Promise.all(writes).catch(err => logger.warn({ err }, 'request metrics write failed'));
  });
  next();
};

export interface MetricsSummary {
  requests: number;
  errors: number;
  apiP95Ms: number;
  errorRatePct: number;
}

/** p95 is the upper bound of the first bucket where the cumulative count over the last 15 minutes reaches 95%. */
export async function metricsSummary(minutes = 15): Promise<MetricsSummary> {
  const t = nowMs();
  const totals: Record<string, number> = {};
  for (let i = 0; i < minutes; i++) {
    const h = await kv().hashGetAll(minuteKey(t - i * 60_000));
    for (const [k, v] of Object.entries(h)) totals[k] = (totals[k] ?? 0) + v;
  }
  const requests = totals.t ?? 0;
  const errors = totals.e ?? 0;
  const counted = [...LATENCY_BUCKETS.map(b => totals[`l${b}`] ?? 0), totals.linf ?? 0];
  const all = counted.reduce((a, b) => a + b, 0);
  let apiP95Ms = 0;
  if (all > 0) {
    const need = Math.ceil(all * 0.95);
    let cum = 0;
    for (let i = 0; i < counted.length; i++) {
      cum += counted[i]!;
      if (cum >= need) {
        apiP95Ms = LATENCY_BUCKETS[Math.min(i, LATENCY_BUCKETS.length - 1)]!;
        break;
      }
    }
  }
  return {
    requests,
    errors,
    apiP95Ms,
    errorRatePct: requests ? Math.round((errors * 10000) / requests) / 100 : 0,
  };
}

/** `platform-ops:metrics-trim` (hourly): drops metric hashes older than 2 hours (safety net for the TTL). */
export async function runMetricsTrim(): Promise<number> {
  const limit = minuteKey(nowMs() - TTL_SECONDS * 1000);
  const old = (await kv().hashKeys('m:')).filter(k => k < limit);
  if (old.length) await kv().hashDel(...old);
  return old.length;
}
