import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  Incident,
  PlatformNotification,
  ServiceProvider,
  Society,
  closeDb,
  sequelize,
} from '../../../src/models';
import { advance, nowMs, setNow } from '../../../src/lib/clock';
import { kv } from '../../../src/lib/kv';
import { drainQueues, tickScheduler } from '../../../src/lib/queue';
import { audit } from '../../../src/utils/audit';
import { systemCtx } from '../../../src/types/context';
import {
  bucketFor,
  metricsSummary,
  minuteKey,
  runMetricsTrim,
} from '../../../src/modules/platform-ops/platform-ops.metrics';
import {
  activityItem,
  isActivityAction,
} from '../../../src/modules/platform-ops/platform-ops.dashboard.service';
import { events } from '../../helpers/auth';
import { makeSociety } from '../../helpers/access';
import { resetLogins } from '../../helpers/access';
import { call } from '../../helpers/auth';
import { lifecycleSociety, platformAs } from '../../helpers/societies';
import { insertTicket, resetOps } from '../../helpers/platform-ops';
import { memberUser } from '../../helpers/access';
import { seedDemoAnnouncement, seedDemoIncidents, seedDemoProviders } from '../../../seeders/platform-ops';

afterAll(closeDb);
beforeEach(async () => {
  await resetOps();
  resetLogins();
  setNow('2026-10-30T04:00:00Z'); // a Friday; the Monday of this week is 2026-10-26
});

const dash = (c: any, period?: string) =>
  c('get', '/platform/dashboard', undefined, period ? { query: { period } } : {});

describe('GET /platform/dashboard (8.2, T07-53)', () => {
  it('T07-53 society counts, tickets, incidents, providers and jobs match the seeded data; netChangeBp = round(change x 10000 / previous)', async () => {
    const admin = await platformAs('super_admin');
    const trial = await lifecycleSociety('TRIAL', { name: 'Trial One' });
    await lifecycleSociety('ACTIVE', { name: 'Active One' });
    await lifecycleSociety('ACTIVE', { name: 'Active Two' });
    const pastDue = await lifecycleSociety('PAST_DUE', { name: 'Past Due One' });
    await lifecycleSociety('SUSPENDED', { name: 'Suspended One' });
    await lifecycleSociety('CLOSED', { name: 'Closed One' });
    await Society.update({ trialEndsAt: new Date('2026-11-02T00:00:00Z') }, { where: { id: trial.id! } });
    await Society.update(
      { healthScore: 90 },
      { where: { name: ['Trial One', 'Active One', 'Active Two', 'Suspended One', 'Closed One'] } },
    );
    await Society.update({ healthScore: 41, activeUsers30: 12 }, { where: { id: pastDue.id! } });
    const raiser = await memberUser(trial, 'treasurer', { name: 'Meera' });
    await insertTicket(trial, raiser, { priority: 'HIGH', status: 'OPEN' });
    await insertTicket(trial, raiser, {
      priority: 'HIGH',
      status: 'IN_PROGRESS',
      assigneeUserId: admin.user.id,
      patch: { firstResponseBreachedAt: new Date() },
    });
    await insertTicket(trial, raiser, { priority: 'LOW', status: 'WAITING' });
    await insertTicket(trial, raiser, { priority: 'HIGH', status: 'RESOLVED' });
    await ServiceProvider.create({
      ...seedProvider('sms_a', 'SMS'),
      healthStatus: 'DEGRADED',
    } as never);
    await Incident.create({ ...incident('SEV1') } as never);
    await Incident.create({ ...incident('SEV3') } as never);
    const r = await dash(admin.c);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body.data;
    expect(d.period).toBe('30');
    expect(d.generatedAt).toBe('2026-10-30T04:00:00.000Z');
    expect(d.societies).toEqual({
      byStatus: { TRIAL: 1, ACTIVE: 2, PAST_DUE: 1, SUSPENDED: 1, CLOSED: 1 },
      total: 6,
      newInPeriod: 6,
    });
    expect(d.unitsUnderManagement).toBeNull(); // module 08 is not built
    expect(d.paymentSuccessRatePct).toBeNull(); // module 12 is not built
    expect(typeof d.activeUsers30d).toBe('number');
    expect(d.mrr.netChangePaise).toBe(d.mrr.mrrPaise - d.mrr.previousMrrPaise);
    expect(d.mrr.netChangeBp).toBe(
      d.mrr.previousMrrPaise === 0 ? 0 : Math.round((d.mrr.netChangePaise * 10000) / d.mrr.previousMrrPaise),
    );
    expect(d.trialConversions).toEqual({ converted: 0, ended: 0, ratePct: null });
    expect(d.tickets).toEqual({ open: 3, unassigned: 2, highPriorityOpen: 2, slaBreached: 1 });
    expect(d.jobs).toMatchObject({ failed: 0, pausedQueues: 0 });
    expect(d.providers.notOperational).toEqual([
      expect.objectContaining({ displayName: 'sms_a name', healthStatus: 'DEGRADED' }),
    ]);
    expect(d.incidents).toEqual({ open: 2, openSev1Sev2: 1 });
    expect(d.atRisk).toEqual([
      expect.objectContaining({
        societyId: pastDue.id,
        name: 'Past Due One',
        status: 'PAST_DUE',
        healthScore: 41,
        activeUsers30d: 12,
      }),
    ]);
    expect(d.needsAttention.map((n: any) => n.kind)).toEqual([
      'PAST_DUE_SOCIETIES',
      'SLA_BREACHED_TICKETS',
      'HIGH_PRIORITY_TICKETS',
      'TRIALS_ENDING',
      'PROVIDERS_DEGRADED',
      'SEV_INCIDENTS_OPEN',
    ]);
    expect(d.needsAttention[0]).toEqual({
      kind: 'PAST_DUE_SOCIETIES',
      count: 1,
      link: '/societies?status=PAST_DUE',
    });
  });

  it('series: 7 daily buckets, 5 weekly buckets for 30 days and 13 for 90, weeks starting on Monday; signups add up', async () => {
    const admin = await platformAs('super_admin');
    await lifecycleSociety('ACTIVE', { name: 'Active One' });
    await Society.update({ createdAt: new Date('2026-10-20T10:00:00Z') }, { where: { name: 'Active One' } });
    await lifecycleSociety('ACTIVE', { name: 'Active Two' });
    const w = (await dash(admin.c, '30')).body.data.series;
    expect(w.labels).toEqual(['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    expect(w.signups).toEqual([0, 0, 0, 1, 1]);
    expect(w.mrrPaise).toHaveLength(5);
    const d7 = (await dash(admin.c, '7')).body.data.series;
    expect(d7.labels).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
    ]);
    expect(d7.signups).toEqual([0, 0, 0, 0, 0, 0, 1]);
    const q = (await dash(admin.c, '90')).body.data.series;
    expect(q.labels).toHaveLength(13);
    expect(q.labels[12]).toBe('2026-10-26');
    expect(q.labels[0]).toBe('2026-08-03');
    expect(q.signups.reduce((a: number, b: number) => a + b, 0)).toBe(2);
    expect((await dash(admin.c, '14')).status).toBe(400);
  });

  it('is cached for 60 seconds per period; Platform Support (no dashboard key) is refused', async () => {
    const admin = await platformAs('super_admin');
    const first = (await dash(admin.c)).body.data;
    await makeSociety('Added later'); // (the subscription helpers replace the key-value store, so no lifecycleSociety here)
    expect((await dash(admin.c)).body.data.societies.total).toBe(first.societies.total); // cached
    expect((await dash(admin.c, '7')).body.data.societies.total).toBe(first.societies.total + 1); // another period, another cache entry
    advance(61_000);
    expect((await dash(admin.c)).body.data.societies.total).toBe(first.societies.total + 1);
    const support = await platformAs('platform_support');
    expect((await dash(support.c)).status).toBe(200); // support holds platform.dashboard.view
  });

  it('counts failed jobs of every queue and paused queues', async () => {
    const admin = await platformAs('super_admin');
    const d = (await dash(admin.c)).body.data;
    expect(d.jobs).toEqual({ waiting: 0, active: 0, delayed: 0, failed: 0, pausedQueues: 0 });
  });
});

describe('activity feed and health summary (8.2)', () => {
  it('lists the latest 20 allowlisted audit rows as items with tone, icon, text and link', async () => {
    const admin = await platformAs('super_admin');
    const society = await lifecycleSociety('ACTIVE', { name: 'Krishna Kunj' });
    await sequelize.query('DELETE FROM audit_logs');
    const mk = (action: string, entityType: string, entityId: string, entityLabel: string) =>
      AuditLog.create({
        societyId: null,
        actorUserId: 1,
        actorName: 'A',
        actorRole: 'super_admin',
        supportGrantId: null,
        action,
        entityType,
        entityId,
        entityLabel,
        before: null,
        after: null,
        reason: null,
        ip: null,
        userAgent: null,
        requestId: null,
      } as never);
    await mk('platform.society.suspended', 'society', String(society.id), 'Krishna Kunj');
    await mk('finance.invoice.created', 'invoice', '1', 'Invoice 1'); // not on the allowlist
    await mk('platform.ticket.created', 'platform_ticket', '9', 'TKT-000009');
    await mk('platform_billing.invoice.paid', 'platform_invoice', '3', 'INV-000003');
    await mk('platform.incident.resolved', 'incident', '4', 'INC-000004');
    for (let i = 0; i < 25; i++)
      await mk('platform.announcement.published', 'platform_notification', String(i), `Notice ${i}`);
    const r = await admin.c('get', '/platform/dashboard/activity');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.items).toHaveLength(20);
    expect(r.body.data.items[0]).toMatchObject({ tone: 'ok', icon: 'activity', link: '/announcements' });
    await sequelize.query('DELETE FROM audit_logs');
    await mk('platform.society.suspended', 'society', String(society.id), 'Krishna Kunj');
    await mk('finance.invoice.created', 'invoice', '1', 'Invoice 1');
    await mk('platform.ticket.created', 'platform_ticket', '9', 'TKT-000009');
    const small = (await admin.c('get', '/platform/dashboard/activity')).body.data.items;
    expect(small.map((i: any) => i.link)).toEqual(['/support/9', `/societies/${society.id}`]);
    expect(small[1]).toMatchObject({ tone: 'bad', icon: 'building', text: 'Krishna Kunj: suspended' });
    expect(isActivityAction('platform.provider.status_changed')).toBe(true);
    expect(isActivityAction('platform.setting.updated')).toBe(false);
    expect(
      activityItem({
        id: 1,
        action: 'platform_billing.invoice.paid',
        entityType: 'platform_invoice',
        entityId: '3',
        entityLabel: null,
        createdAt: new Date(),
      }).tone,
    ).toBe('ok');
  });

  it('a committed audit row on the allowlist is pushed live on platform:ops as platform.activity', async () => {
    await platformAs('super_admin');
    events.length = 0;
    await sequelize.transaction(async t => {
      await audit(
        systemCtx('x'),
        {
          action: 'platform.incident.created',
          entityType: 'incident',
          entityId: 12,
          entityLabel: 'Delivery delays',
        },
        t,
      );
      expect(events.filter(e => e.event === 'platform.activity')).toHaveLength(0); // not before the commit
    });
    const e = events.filter(x => x.room === 'platform:ops' && x.event === 'platform.activity');
    expect(e).toHaveLength(1);
    expect(e[0]!.payload).toMatchObject({
      tone: 'warn',
      icon: 'alert-triangle',
      link: '/health/incidents/12',
      text: 'Delivery delays: created',
    });
    events.length = 0;
    await audit(systemCtx('x'), { action: 'finance.invoice.created', entityType: 'invoice', entityId: 1 });
    expect(events.filter(x => x.event === 'platform.activity')).toHaveLength(0);
  });

  it('health summary: p95 from the latency buckets, 5xx rate, requests, failed jobs, provider issues, uptime and open incidents', async () => {
    const admin = await platformAs('super_admin');
    await new Promise(r => setTimeout(r, 40)); // let the sign-in requests finish counting
    await kv().cacheDelPrefix('m:');
    const key = minuteKey(nowMs());
    await kv().hashIncr(key, 't', 100, 7200);
    await kv().hashIncr(key, 'e', 5, 7200);
    await kv().hashIncr(key, bucketFor(40), 90, 7200);
    await kv().hashIncr(key, bucketFor(900), 10, 7200);
    await ServiceProvider.create({
      ...seedProvider('wa_a', 'WHATSAPP'),
      healthStatus: 'OUTAGE',
    } as never);
    await Incident.create({
      ...incident('SEV1'),
      components: ['api'],
      startedAt: new Date(nowMs() - 432 * 60_000),
      status: 'RESOLVED',
      resolvedAt: new Date(nowMs()),
    } as never);
    const r = await admin.c('get', '/platform/health/summary');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      apiP95Ms: 1000,
      errorRatePct: 5,
      requestsLast15Min: 100,
      failedJobs: 0,
      providerIssues: [expect.objectContaining({ healthStatus: 'OUTAGE' })],
      uptime30dPct: 99,
      openIncidents: 0,
    });
    await kv().cacheDelPrefix('m:');
    const empty = (await admin.c('get', '/platform/health/summary')).body.data;
    expect(empty).toMatchObject({ apiP95Ms: 0, errorRatePct: 0, requestsLast15Min: 0 });
  });
});

describe('request metrics (9.4)', () => {
  it('counts requests and 5xx per minute, skips the health and status routes, and the trim job drops hashes older than 2 hours', async () => {
    const admin = await platformAs('super_admin');
    await kv().cacheDelPrefix('m:');
    const settle = () => new Promise(r => setTimeout(r, 30));
    await call('get', '/health', undefined, { csrf: false });
    await call('get', '/public/status', undefined, { csrf: false });
    await settle();
    expect((await metricsSummary()).requests).toBe(0);
    await admin.c('get', '/platform/dashboard/activity');
    await admin.c('get', '/platform/nonexistent-route');
    await settle();
    const m = await metricsSummary();
    expect(m.requests).toBe(2);
    expect(m.errors).toBe(0);
    expect(m.apiP95Ms).toBeGreaterThan(0);
    expect(bucketFor(50)).toBe('l50');
    expect(bucketFor(51)).toBe('l100');
    expect(bucketFor(5000)).toBe('l5000');
    expect(bucketFor(5001)).toBe('linf');
    expect(minuteKey(Date.UTC(2026, 9, 30, 4, 7, 55))).toBe('m:202610300407');
    await kv().hashIncr(minuteKey(nowMs() - 3 * 3_600_000), 't', 1, 7200);
    expect(await runMetricsTrim()).toBe(1);
    expect((await kv().hashKeys('m:')).every(k => k >= minuteKey(nowMs() - 7200 * 1000))).toBe(true);
  });
});

describe('jobs of section 9.1 and seeds (7.8)', () => {
  it('registers the repeatable jobs: health check every 2 minutes, scheduler every minute, archive 02:30 IST, uptime 00:10 IST, trim hourly', async () => {
    const fired = async (iso: string) => {
      const f = await tickScheduler(new Date(iso));
      await drainQueues();
      return f;
    };
    const first = await fired('2026-10-29T21:00:00Z'); // 02:30 IST
    expect(first).toEqual(
      expect.arrayContaining([
        'platform-ops:provider-health-check',
        'platform-ops:announcement-scheduler',
        'platform-ops:failed-jobs-alert',
        'platform-ops:audit-archive',
        'platform-ops:ticket-sla-scan',
      ]),
    );
    expect(first).not.toContain('platform-ops:provider-uptime-rollup');
    expect(await fired('2026-10-29T18:40:00Z')).toContain('platform-ops:provider-uptime-rollup'); // 00:10 IST
    expect(await fired('2026-10-29T21:45:00Z')).toContain('platform-ops:metrics-trim'); // :15 past the hour in IST
    const minute = await fired('2026-10-29T21:46:00Z'); // a minute later only the every-minute job of this module is due
    expect(minute).toContain('platform-ops:announcement-scheduler');
    expect(minute.filter(j => j.startsWith('platform-ops:'))).toEqual([
      'platform-ops:announcement-scheduler',
    ]);
  });

  it('seeds the non-production providers, the two demo incidents and the announcement, idempotently', async () => {
    const p = await seedDemoProviders();
    expect(p.created).toEqual([
      'sms_fake',
      'whatsapp_fake',
      'email_fake',
      'push_fake',
      'pg_fake',
      'storage_s3',
      'ivr_fake',
    ]);
    expect((await seedDemoProviders()).created).toEqual([]);
    const rows = await ServiceProvider.findAll({ order: [['id', 'ASC']] });
    expect(rows.map(r => r.displayName)).toEqual([
      'SMS gateway (DLT)',
      'WhatsApp Business API',
      'Email (SES)',
      'Push notifications',
      'Payment gateway',
      'Object storage (S3)',
      'IVR and call bridge',
    ]);
    expect(rows.every(r => r.isEnabled && r.priority === 1)).toBe(true);
    expect(rows.find(r => r.providerKey === 'storage_s3')).toMatchObject({
      vendor: 'S3_COMPATIBLE',
      credentialsSource: 'ENV',
    });
    const i = await seedDemoIncidents();
    expect(i.created).toEqual([
      'Delivery delays of about 4 minutes',
      'Webhook retries elevated for 12 minutes',
    ]);
    expect((await seedDemoIncidents()).created).toEqual([]);
    const inc = await Incident.findAll({ order: [['id', 'ASC']] });
    expect(inc[0]).toMatchObject({ severity: 'SEV3', status: 'MONITORING', serviceProviderId: rows[1]!.id });
    expect(inc[1]).toMatchObject({
      severity: 'SEV3',
      status: 'RESOLVED',
      serviceProviderId: rows[4]!.id,
      durationMinutes: 12,
    });
    expect((await seedDemoAnnouncement()).created).toBe(true);
    expect((await seedDemoAnnouncement()).created).toBe(false);
    expect(await PlatformNotification.findOne()).toMatchObject({
      title: 'New billing run wizard is live',
      kind: 'RELEASE_NOTE',
      severity: 'INFO',
      audienceType: 'ALL',
      status: 'PUBLISHED',
    });
    // the demo data shows on the public status page: WhatsApp is degraded by the open incident
    const s = await call('get', '/public/status', undefined, { csrf: false });
    expect(s.body.data.components.find((c: any) => c.key === 'notifications_whatsapp').status).toBe(
      'DEGRADED',
    );
    expect(s.body.data.recentIncidents).toHaveLength(1);
  });
});

// ---- fixtures
function seedProvider(key: string, channel: string) {
  return {
    providerKey: key,
    channel,
    vendor: 'FAKE',
    displayName: `${key} name`,
    description: null,
    isEnabled: true,
    priority: 1,
    credentialsSource: 'ENV',
    configJson: { failMode: 'none' },
    healthStatus: 'UNKNOWN',
    statusMode: 'AUTOMATIC',
    consecutiveFailures: 0,
    degradedLatencyMs: 3000,
    version: 1,
  };
}
const incident = (severity: string) => ({
  title: `Incident ${severity}`,
  severity,
  status: 'INVESTIGATING',
  components: ['notifications_sms'],
  serviceProviderId: null,
  source: 'MANUAL',
  isPublic: true,
  updates: [],
  startedAt: new Date(nowMs() - 3_600_000),
  version: 1,
});
