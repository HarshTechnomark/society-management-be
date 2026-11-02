import { Op } from 'sequelize';
import { Incident, PlatformTicket, ServiceProvider, Society, AuditLog } from '../../models';
import { addDays, istDate, now } from '../../lib/clock';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { auth } from '../auth/auth.public';
import { platformBilling } from '../platform-billing/platform-billing.public';
import { societyLifecycle } from '../societies/societies.public';
import { societyPorts } from '../societies/societies.ports';
import { listQueues } from './platform-ops.queues.service';
import { metricsSummary } from './platform-ops.metrics';

/** Dashboard, activity feed and health strip (module 07 section 8.2). Values that need later modules are `null`. */
const STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CLOSED'] as const;
const LIVE = ['TRIAL', 'ACTIVE', 'PAST_DUE'];
const OPEN_TICKET = ['OPEN', 'IN_PROGRESS', 'WAITING'];
const DAY = 86_400_000;

const addDaysYmd = (d: string, n: number): string =>
  new Date(new Date(`${d}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
const mondayOf = (d: string): string => addDaysYmd(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
/** Start of an IST calendar day as a UTC instant. */
const istStart = (d: string): Date => new Date(`${d}T00:00:00+05:30`);

export type Period = '7' | '30' | '90';

function buckets(period: Period, today: string): { labels: string[]; step: number; bucket: 'DAY' | 'WEEK' } {
  if (period === '7')
    return { labels: Array.from({ length: 7 }, (_, i) => addDaysYmd(today, i - 6)), step: 1, bucket: 'DAY' };
  const n = period === '30' ? 5 : 13;
  const last = mondayOf(today);
  return {
    labels: Array.from({ length: n }, (_, i) => addDaysYmd(last, (i - (n - 1)) * 7)),
    step: 7,
    bucket: 'WEEK',
  };
}

async function unitsUnderManagement(): Promise<number | null> {
  const ids = (await Society.findAll({ where: { status: { [Op.in]: LIVE } }, attributes: ['id'] })).map(
    s => s.id!,
  );
  let total = 0;
  for (const id of ids) {
    const n = await societyPorts().units.count(id);
    if (n === null) return null; // module 08 is not built yet
    total += n;
  }
  return total;
}

async function compute(period: Period) {
  const at = now();
  const days = Number(period);
  const grouped = (await Society.count({ group: ['status'] })) as unknown as {
    status: string;
    count: number;
  }[];
  const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0])) as Record<(typeof STATUSES)[number], number>;
  for (const g of grouped)
    if (g.status in byStatus) byStatus[g.status as keyof typeof byStatus] = Number(g.count);
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const since = addDays(at, -days);
  const newInPeriod = await Society.count({ where: { createdAt: { [Op.gte]: since } } });

  const summary = await platformBilling.getMrrSummary({ asOf: at, comparedTo: since });
  const netChangeBp =
    summary.previousMrrPaise === 0
      ? 0
      : Math.round((summary.netChangePaise * 10000) / summary.previousMrrPaise);

  const open = await PlatformTicket.findAll({
    where: { status: { [Op.in]: OPEN_TICKET } },
    attributes: ['assigneeUserId', 'priority', 'firstResponseBreachedAt', 'resolutionBreachedAt'],
  });
  const tickets = {
    open: open.length,
    unassigned: open.filter(t => t.assigneeUserId === null).length,
    highPriorityOpen: open.filter(t => t.priority === 'HIGH').length,
    slaBreached: open.filter(t => t.firstResponseBreachedAt || t.resolutionBreachedAt).length,
  };
  const q = await listQueues();
  const jobs = {
    waiting: q.totals.waiting,
    active: q.totals.active,
    delayed: q.totals.delayed,
    failed: q.totals.failed,
    pausedQueues: q.totals.pausedQueues,
  };
  const notOperational = (
    await ServiceProvider.findAll({
      where: { isEnabled: true, healthStatus: { [Op.in]: ['DEGRADED', 'OUTAGE'] } },
      order: [['id', 'ASC']],
    })
  ).map(p => ({ id: p.id!, displayName: p.displayName, healthStatus: p.healthStatus }));
  const openIncidents = await Incident.findAll({
    where: { status: { [Op.ne]: 'RESOLVED' } },
    attributes: ['severity'],
  });
  const incidents = {
    open: openIncidents.length,
    openSev1Sev2: openIncidents.filter(i => i.severity === 'SEV1' || i.severity === 'SEV2').length,
  };

  const today = istDate(at);
  const b = buckets(period, today);
  const signups: number[] = [];
  for (const start of b.labels) {
    const end = addDaysYmd(start, b.step);
    signups.push(
      await Society.count({ where: { createdAt: { [Op.gte]: istStart(start), [Op.lt]: istStart(end) } } }),
    );
  }
  const mrr = await platformBilling.getMrrSeries({ from: b.labels[0]!, to: today, bucket: b.bucket });
  const trialsEnding = await Society.count({
    where: { status: 'TRIAL', trialEndsAt: { [Op.gte]: at, [Op.lte]: addDays(at, 5) } },
  });
  const needs = [
    { kind: 'PAST_DUE_SOCIETIES', count: byStatus.PAST_DUE, link: '/societies?status=PAST_DUE' },
    { kind: 'FAILED_JOBS', count: jobs.failed, link: '/queues' },
    { kind: 'SLA_BREACHED_TICKETS', count: tickets.slaBreached, link: '/support?slaBreached=true' },
    { kind: 'HIGH_PRIORITY_TICKETS', count: tickets.highPriorityOpen, link: '/support?priority=HIGH' },
    { kind: 'TRIALS_ENDING', count: trialsEnding, link: '/societies?status=TRIAL' },
    { kind: 'PROVIDERS_DEGRADED', count: notOperational.length, link: '/health' },
    { kind: 'SEV_INCIDENTS_OPEN', count: incidents.openSev1Sev2, link: '/health' },
  ].filter(n => n.count > 0);

  return {
    period,
    generatedAt: at.toISOString(),
    societies: { byStatus, total, newInPeriod },
    unitsUnderManagement: await unitsUnderManagement(),
    activeUsers30d: await auth.countActiveUsersPlatform(addDays(at, -30)),
    mrr: { ...summary, netChangeBp },
    trialConversions: await societyLifecycle.trialConversionStats(since, at),
    paymentSuccessRatePct: null, // module 12 is not built yet
    tickets,
    jobs,
    providers: { notOperational },
    incidents,
    series: { labels: b.labels, signups, mrrPaise: mrr.mrrPaise },
    atRisk: await societyLifecycle.listAtRiskSocieties({ limit: 5 }),
    needsAttention: needs,
  };
}

/** `GET /platform/dashboard`: cached 60 seconds per period (`pd:<period>`). */
export async function getDashboard(period: Period) {
  const key = `pd:${period}`;
  try {
    const hit = await kv().cacheGet(key);
    if (hit) return JSON.parse(hit) as Awaited<ReturnType<typeof compute>>;
  } catch (err) {
    logger.warn({ err }, 'dashboard cache unavailable');
  }
  const data = JSON.parse(JSON.stringify(await compute(period))) as Awaited<ReturnType<typeof compute>>;
  try {
    await kv().cacheSet(key, JSON.stringify(data), 60);
  } catch (err) {
    logger.warn({ err }, 'dashboard cache unavailable');
  }
  return data;
}

// ------------------------------------------------------------------ activity feed
interface ActivityRow {
  id: number;
  action: string;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  createdAt: Date;
}
const ACTIVITY_LIKE = ['platform.society.%', 'platform.incident.%'];
const ACTIVITY_EXACT = [
  'platform_billing.invoice.paid',
  'platform.ticket.created',
  'platform.provider.status_changed',
  'platform.announcement.published',
];
export const isActivityAction = (a: string): boolean =>
  ACTIVITY_EXACT.includes(a) || a.startsWith('platform.society.') || a.startsWith('platform.incident.');

const TONE: [RegExp, 'ok' | 'info' | 'warn' | 'bad'][] = [
  [/closed|suspended|failed|outage/, 'bad'],
  [/past_due|degraded|reopened|created/, 'warn'],
  [/paid|published|resolved|converted|reactivated|activated/, 'ok'],
];

export function activityItem(r: ActivityRow) {
  const tail = r.action.split('.').pop()!.replace(/_/g, ' ');
  const label = r.entityLabel ?? `${r.entityType} ${r.entityId}`;
  const tone = TONE.find(([re]) => re.test(r.action))?.[1] ?? 'info';
  const kind = r.action.split('.')[1];
  const link =
    r.entityType === 'society'
      ? `/societies/${r.entityId}`
      : r.entityType === 'platform_ticket'
        ? `/support/${r.entityId}`
        : r.entityType === 'incident'
          ? `/health/incidents/${r.entityId}`
          : r.entityType === 'service_provider'
            ? '/health'
            : r.entityType === 'platform_notification'
              ? '/announcements'
              : '/dashboard';
  return {
    id: r.id,
    at: r.createdAt,
    tone,
    icon:
      kind === 'ticket'
        ? 'life-buoy'
        : kind === 'incident'
          ? 'alert-triangle'
          : kind === 'society'
            ? 'building'
            : 'activity',
    text: `${label}: ${tail}`,
    link,
  };
}

export async function getActivity() {
  const rows = await AuditLog.findAll({
    where: {
      [Op.or]: [
        ...ACTIVITY_LIKE.map(l => ({ action: { [Op.like]: l } })),
        { action: { [Op.in]: ACTIVITY_EXACT } },
      ],
    },
    order: [['id', 'DESC']],
    limit: 20,
  });
  return {
    items: rows.map(r =>
      activityItem({
        id: r.id!,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        entityLabel: r.entityLabel,
        createdAt: r.createdAt!,
      }),
    ),
  };
}

// ------------------------------------------------------------------ health strip
export async function getHealthSummary() {
  const m = await metricsSummary();
  const q = await listQueues();
  const providerIssues = (
    await ServiceProvider.findAll({
      where: { isEnabled: true, healthStatus: { [Op.in]: ['DEGRADED', 'OUTAGE'] } },
      order: [['id', 'ASC']],
    })
  ).map(p => ({ id: p.id!, displayName: p.displayName, healthStatus: p.healthStatus }));
  const at = now();
  const from = addDays(at, -30);
  const sev1 = await Incident.findAll({
    where: {
      severity: 'SEV1',
      startedAt: { [Op.lt]: at },
      [Op.or]: [{ resolvedAt: null }, { resolvedAt: { [Op.gt]: from } }],
    },
  });
  let minutes = 0;
  for (const i of sev1) {
    if (!i.components.includes('api')) continue;
    const start = Math.max(i.startedAt.getTime(), from.getTime());
    const end = Math.min(i.resolvedAt?.getTime() ?? at.getTime(), at.getTime());
    if (end > start) minutes += (end - start) / 60_000;
  }
  return {
    apiP95Ms: m.apiP95Ms,
    errorRatePct: m.errorRatePct,
    requestsLast15Min: m.requests,
    failedJobs: q.totals.failed,
    providerIssues,
    uptime30dPct: Math.round(100 * (1 - Math.min(minutes, 43_200) / 43_200) * 100) / 100,
    openIncidents: await Incident.count({ where: { status: { [Op.ne]: 'RESOLVED' } } }),
  };
}
