import { Op } from 'sequelize';
import { Incident, ServiceProvider, sequelize } from '../../models';
import type { ProviderHealth } from '../../models/service-provider.model';
import { addDays, istDate, now } from '../../lib/clock';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { buildProviderAdapter } from '../../adapters/provider-adapter';
import { audit } from '../../utils/audit';
import { systemCtx } from '../../types/context';
import { AUDIT, COMPONENT_FOR_CHANNEL, ENTITY } from './platform-ops.types';
import { credentialsOf } from './platform-ops.providers.registry';
import { scrub, withTimeout } from './platform-ops.providers.service';
import { emitOps, invalidateStatusAfterCommit, providerNotFound } from './platform-ops.shared';
import {
  autoIncidentRecovered,
  openProviderIncident,
  raiseAutoIncident,
} from './platform-ops.incidents.service';
import { notifyAfterCommit, platformUsersWith } from './platform-ops.notify';
import { getPlatformSetting } from './platform-ops.settings.service';

/** Provider health checks (module 07 section 6.4, BR-07-26, BR-07-27) and the 30 day uptime roll-up. */
export interface CheckResult {
  providerId: number;
  ok: boolean;
  latencyMs: number;
  error: string | null;
  healthStatus: ProviderHealth;
}

const CHECK_TIMEOUT_MS = 10_000;
const dayKey = (providerId: number, d: string) => `ph:${providerId}:${d.replaceAll('-', '')}`;

/** BR-07-26 in AUTOMATIC mode: no failures is OPERATIONAL, 3 to 9 DEGRADED, 10 or more OUTAGE, 1 and 2 keep the status. */
export function nextAutoStatus(current: ProviderHealth, ok: boolean, failures: number): ProviderHealth {
  if (ok) return 'OPERATIONAL';
  if (failures >= 10) return 'OUTAGE';
  if (failures >= 3) return 'DEGRADED';
  return current;
}

async function probe(p: ServiceProvider): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
  let creds: Record<string, string> | null = null;
  try {
    creds = credentialsOf(p);
    const adapter = buildProviderAdapter({
      channel: p.channel,
      vendor: p.vendor,
      config: p.configJson,
      credentials: creds,
    });
    const started = Date.now();
    const r = await withTimeout(adapter.healthCheck(), CHECK_TIMEOUT_MS);
    const latencyMs = r.latencyMs ?? Date.now() - started;
    if (!r.ok) return { ok: false, latencyMs, error: scrub(r.error ?? 'Health check failed', creds) };
    if (latencyMs > p.degradedLatencyMs)
      return {
        ok: false,
        latencyMs,
        error: `Slow response: ${latencyMs} ms (limit ${p.degradedLatencyMs} ms)`,
      };
    return { ok: true, latencyMs, error: null };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return {
      ok: false,
      latencyMs: 0,
      error: scrub(code ?? (err instanceof Error ? err.message : String(err)), creds),
    };
  }
}

/**
 * Runs one check and applies it (BR-07-26) under the row lock. With `startedAt` (the job) the update is conditional on
 * `lastCheckAt < startedAt`, so a second worker's run of the same tick changes nothing. Returns `null` when skipped.
 */
export async function runCheck(
  providerId: number,
  opts: { startedAt?: Date } = {},
): Promise<CheckResult | null> {
  const p0 = await ServiceProvider.scope('withSecrets').findByPk(providerId);
  if (!p0) return null;
  const result = await probe(p0);
  const alerts = await getPlatformSetting('alerts.providerDown');
  const sys = systemCtx('job');
  let out: CheckResult | null = null;
  await sequelize.transaction(async t => {
    const p = await ServiceProvider.findByPk(providerId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!p) return;
    if (opts.startedAt && p.lastCheckAt && p.lastCheckAt >= opts.startedAt) return;
    const at = now();
    const failures = result.ok ? 0 : p.consecutiveFailures + 1;
    const from = p.healthStatus;
    const to = p.statusMode === 'AUTOMATIC' ? nextAutoStatus(from, result.ok, failures) : from;
    const patch: Record<string, unknown> = {
      consecutiveFailures: failures,
      lastCheckAt: at,
      lastCheckOk: result.ok,
      lastCheckLatencyMs: result.latencyMs,
      lastCheckError: result.error,
    };
    if (to !== from) {
      patch.healthStatus = to;
      patch.statusChangedAt = at;
      patch.statusReason = result.ok ? null : result.error;
      patch.version = p.version + 1;
    }
    await p.update(patch, { transaction: t, silent: false });
    out = {
      providerId,
      ok: result.ok,
      latencyMs: result.latencyMs,
      error: result.error,
      healthStatus: p.healthStatus,
    };
    if (to === from) return;

    const component = COMPONENT_FOR_CHANNEL[p.channel]!;
    const hasOpen = await Incident.count({
      where: { serviceProviderId: p.id!, status: { [Op.ne]: 'RESOLVED' } },
      transaction: t,
    });
    if (to === 'OPERATIONAL') await autoIncidentRecovered(t, p.id!);
    else if (from === 'DEGRADED' && to === 'OUTAGE') {
      const raised = await raiseAutoIncident(t, p.id!, result.error ?? 'checks failing');
      if (!raised && !hasOpen)
        await openProviderIncident(sys, t, p, {
          severity: 'SEV2',
          title: `${p.displayName} is down`,
          message: `Automatic checks are failing: ${result.error ?? 'no response'}`,
          source: 'PROVIDER_AUTO',
          isPublic: false,
          components: [component],
        });
    } else if (
      (from === 'OPERATIONAL' || from === 'UNKNOWN') &&
      (to === 'DEGRADED' || to === 'OUTAGE') &&
      !hasOpen
    )
      await openProviderIncident(sys, t, p, {
        severity: to === 'OUTAGE' ? 'SEV2' : 'SEV3',
        title: `${p.displayName} is ${to === 'OUTAGE' ? 'down' : 'degraded'}`,
        message: `Automatic checks are failing: ${result.error ?? 'no response'}`,
        source: 'PROVIDER_AUTO',
        isPublic: false,
        components: [component],
      });
    await audit(
      sys,
      {
        action: AUDIT.providerStatusChanged,
        entityType: ENTITY.provider,
        entityId: p.id!,
        entityLabel: p.displayName,
        before: { status: from },
        after: { status: to, consecutiveFailures: failures },
        reason: result.error,
      },
      t,
    );
    if (alerts)
      notifyAfterCommit(
        t,
        'platform.provider.status_changed',
        () => platformUsersWith('platform.dashboard.view'),
        {
          provider: p.displayName,
          from,
          to,
          manual: false,
          reason: result.error,
          link: '/health',
        },
      );
    emitOps(t, 'platform.provider.status_changed', { providerId: p.id!, healthStatus: to });
    invalidateStatusAfterCommit(t);
  });
  if (out) {
    try {
      await kv().hashIncr(dayKey(providerId, istDate(now())), result.ok ? 'ok' : 'fail', 1, 35 * 86_400);
    } catch (err) {
      logger.warn({ err }, 'provider day counter unavailable');
    }
  }
  return out;
}

export async function checkOne(id: number): Promise<CheckResult> {
  const p = await ServiceProvider.findByPk(id, { attributes: ['id'] });
  if (!p) throw providerNotFound();
  return (await runCheck(id))!;
}

/** `POST /providers/check-all`: every enabled provider (at most 10), in parallel. */
export async function checkAll(): Promise<{ results: CheckResult[] }> {
  const rows = await ServiceProvider.findAll({
    where: { isEnabled: true },
    attributes: ['id'],
    order: [['id', 'ASC']],
    limit: 10,
  });
  const results = await Promise.all(rows.map(r => runCheck(r.id!)));
  return { results: results.filter((r): r is CheckResult => r !== null) };
}

/** `platform-ops:provider-health-check`: every enabled provider, five at a time (or one provider after new credentials). */
export async function runProviderHealthChecks(data: { providerId?: number } = {}): Promise<number> {
  const startedAt = now();
  const rows = data.providerId
    ? await ServiceProvider.findAll({ where: { id: data.providerId }, attributes: ['id'] })
    : await ServiceProvider.findAll({
        where: { isEnabled: true },
        attributes: ['id'],
        order: [['id', 'ASC']],
      });
  let done = 0;
  for (let i = 0; i < rows.length; i += 5) {
    const results = await Promise.all(rows.slice(i, i + 5).map(r => runCheck(r.id!, { startedAt })));
    done += results.filter(Boolean).length;
  }
  return done;
}

/** `platform-ops:provider-uptime-rollup`: ok / (ok + fail) over the day counters of the last 30 days; a pure overwrite. */
export async function runUptimeRollup(): Promise<number> {
  const rows = await ServiceProvider.findAll({ attributes: ['id'] });
  const today = now();
  let n = 0;
  for (const r of rows) {
    let ok = 0;
    let fail = 0;
    for (let d = 0; d < 30; d++) {
      const h = await kv().hashGetAll(dayKey(r.id!, istDate(addDays(today, -d))));
      ok += h.ok ?? 0;
      fail += h.fail ?? 0;
    }
    if (ok + fail === 0) continue;
    await ServiceProvider.update(
      { uptime30dPct: ((ok * 100) / (ok + fail)).toFixed(3) as unknown as string },
      { where: { id: r.id! }, silent: true },
    );
    n += 1;
  }
  return n;
}
