import { Op } from 'sequelize';
import { Incident, ServiceProvider } from '../../models';
import type { Incident as IncidentRow } from '../../models/incident.model';
import { addDays, now } from '../../lib/clock';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { STATUS_COMPONENTS, incidentNo } from './platform-ops.types';
import { STATUS_CACHE_KEY } from './platform-ops.shared';
import { getPlatformSetting } from './platform-ops.settings.service';

/** Public status page data (module 07 section 8.6, BR-07-34, BR-07-35). Only public, non-personal data; cached 30 seconds. */
export type ComponentStatus = 'OPERATIONAL' | 'DEGRADED' | 'PARTIAL_OUTAGE' | 'MAJOR_OUTAGE';
const ORDER: ComponentStatus[] = ['OPERATIONAL', 'DEGRADED', 'PARTIAL_OUTAGE', 'MAJOR_OUTAGE'];
const worst = (a: ComponentStatus, b: ComponentStatus): ComponentStatus =>
  ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;

const bySeverity = (s: string): ComponentStatus =>
  s === 'SEV1' ? 'MAJOR_OUTAGE' : s === 'SEV2' ? 'PARTIAL_OUTAGE' : 'DEGRADED';

/** BR-07-34 (b): health of the enabled providers of one channel, in priority order. */
export function providerComponentStatus(health: string[]): ComponentStatus {
  if (!health.length) return 'OPERATIONAL';
  if (health.every(h => h === 'OUTAGE')) return 'PARTIAL_OUTAGE';
  const primary = health[0]!;
  if (primary === 'OUTAGE' || primary === 'DEGRADED') return 'DEGRADED';
  return 'OPERATIONAL';
}

export interface StatusPage {
  overall: ComponentStatus;
  updatedAt?: string;
  components: { key: string; name: string; status: ComponentStatus }[];
  activeIncidents?: unknown[];
  recentIncidents?: unknown[];
  message?: string;
}

const publicIncident = (i: IncidentRow) => ({
  incidentNo: incidentNo(i.id!),
  title: i.title,
  severity: i.severity,
  status: i.status,
  startedAt: i.startedAt,
  components: i.components,
  updates: i.updates.filter(u => u.isPublic).map(u => ({ at: u.at, status: u.status, message: u.message })),
});

async function compute(): Promise<StatusPage> {
  const at = now();
  const open = await Incident.findAll({
    where: { isPublic: true, status: { [Op.ne]: 'RESOLVED' } },
    order: [['startedAt', 'DESC']],
  });
  const providers = await ServiceProvider.findAll({
    where: { isEnabled: true },
    order: [
      ['channel', 'ASC'],
      ['priority', 'ASC'],
    ],
  });
  const components = STATUS_COMPONENTS.map(c => {
    let status: ComponentStatus = 'OPERATIONAL';
    for (const i of open) if (i.components.includes(c.key)) status = worst(status, bySeverity(i.severity));
    if (c.channel)
      status = worst(
        status,
        providerComponentStatus(providers.filter(p => p.channel === c.channel).map(p => p.healthStatus)),
      );
    return { key: c.key, name: c.name, status };
  });
  const recent = await Incident.findAll({
    where: { isPublic: true, status: 'RESOLVED', resolvedAt: { [Op.gte]: addDays(at, -14) } },
    order: [['resolvedAt', 'DESC']],
    limit: 20,
  });
  return {
    overall: components.reduce<ComponentStatus>((a, c) => worst(a, c.status), 'OPERATIONAL'),
    updatedAt: at.toISOString(),
    components,
    activeIncidents: open.map(publicIncident),
    recentIncidents: recent.map(i => ({
      incidentNo: incidentNo(i.id!),
      title: i.title,
      severity: i.severity,
      startedAt: i.startedAt,
      resolvedAt: i.resolvedAt,
      durationMinutes: i.durationMinutes,
    })),
  };
}

/** The status page, from the cache when it is under 30 seconds old. */
export async function getStatusPage(): Promise<StatusPage> {
  if (!(await getPlatformSetting('status.publicEnabled')))
    return { overall: 'OPERATIONAL', components: [], message: 'Status page disabled' };
  try {
    const hit = await kv().cacheGet(STATUS_CACHE_KEY);
    if (hit) return JSON.parse(hit) as StatusPage;
  } catch (err) {
    logger.warn({ err }, 'status cache unavailable');
  }
  const page = await compute();
  try {
    await kv().cacheSet(STATUS_CACHE_KEY, JSON.stringify(page), 30);
  } catch (err) {
    logger.warn({ err }, 'status cache unavailable');
  }
  return page;
}
