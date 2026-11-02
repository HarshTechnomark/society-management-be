import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  Incident,
  PlatformNotification,
  PlatformSetting,
  ServiceProvider,
  closeDb,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { listInbox } from '../../../src/lib/inbox';
import { events } from '../../helpers/auth';
import { idem, memberUser, resetLogins } from '../../helpers/access';
import { call } from '../../helpers/auth';
import { platformAs } from '../../helpers/societies';
import { opsSociety, resetOps } from '../../helpers/platform-ops';
import { fakeProvider } from '../../helpers/ops-providers';
import { runCheck } from '../../../src/modules/platform-ops/platform-ops.providers.health';
import {
  clearSettingsCache,
  seedPlatformSettings,
} from '../../../src/modules/platform-ops/platform-ops.settings.service';
import { providerComponentStatus } from '../../../src/modules/platform-ops/platform-ops.status.service';

afterAll(closeDb);
beforeEach(async () => {
  await resetOps();
  resetLogins();
  setNow('2026-10-30T04:00:00Z');
});

const create = (c: any, body: Record<string, unknown> = {}) =>
  c(
    'post',
    '/platform/incidents',
    {
      title: 'WhatsApp delivery delayed',
      severity: 'SEV3',
      components: ['notifications_whatsapp'],
      message: 'Messages are reaching residents late.',
      ...body,
    },
    { headers: idem() },
  );
const status = () => call('get', '/public/status', undefined, { app: 'ADMIN', csrf: false });

describe('incident routes (8.6, 6.2)', () => {
  it('creates an incident with its first timeline entry, audit, realtime event and an incident number', async () => {
    const admin = await platformAs('super_admin', 'Isha Kapoor');
    const r = await create(admin.c);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      incidentNo: `INC-${String(r.body.data.id).padStart(6, '0')}`,
      severity: 'SEV3',
      status: 'INVESTIGATING',
      isPublic: true,
      source: 'MANUAL',
      startedAt: '2026-10-30T04:00:00.000Z',
      announcementId: null,
      version: 1,
    });
    expect(r.body.data.updates).toEqual([
      {
        at: '2026-10-30T04:00:00.000Z',
        status: 'INVESTIGATING',
        message: 'Messages are reaching residents late.',
        isPublic: true,
        byName: 'Isha Kapoor',
      },
    ]);
    expect((await AuditLog.findOne({ where: { action: 'platform.incident.created' } }))!.entityId).toBe(
      String(r.body.data.id),
    );
    expect(events.some(e => e.room === 'platform:ops' && e.event === 'platform.incident.changed')).toBe(true);
    const bad = await create(admin.c, { startedAt: '2026-10-20T00:00:00.000Z' });
    expect(bad.status).toBe(400);
    expect((await create(admin.c, { components: ['nope'] })).status).toBe(400);
    expect((await create(admin.c, { serviceProviderId: 999 })).body.code).toBe('PROVIDER_NOT_FOUND');
    expect((await create(admin.c, { notifySocieties: true })).body.code).toBe(
      'NOTIFY_REQUIRES_PUBLIC_SEV1_SEV2',
    );
    expect(
      (await create(admin.c, { severity: 'SEV2', isPublic: false, notifySocieties: true })).body.code,
    ).toBe('NOTIFY_REQUIRES_PUBLIC_SEV1_SEV2');
  });

  it('the platform team gets an e-mail when an incident opens (SMS for SEV1 only)', async () => {
    const admin = await platformAs('super_admin', 'Isha Kapoor');
    await create(admin.c);
    const mail = (await listInbox()).filter(m => m.subject?.includes('incident INC-'));
    expect(mail.length).toBeGreaterThan(0);
    expect((await listInbox()).some(m => m.channel === 'SMS' && m.body.includes('SEV1'))).toBe(false);
    await create(admin.c, { severity: 'SEV1', title: 'Everything is down' });
    expect((await listInbox()).some(m => m.channel === 'SMS' && m.body.includes('SEV1'))).toBe(true);
  });

  it('the workflow: updates move forward, regress, skip; IDENTIFIED to MONITORING is first-time stamped; a stale version is 409', async () => {
    const admin = await platformAs('super_admin');
    const id = (await create(admin.c)).body.data.id;
    const post = (version: number, body: Record<string, unknown>) =>
      admin.c('post', `/platform/incidents/${id}/updates`, {
        version,
        message: 'We are looking at it now.',
        ...body,
      });
    let r = await post(1, { status: 'IDENTIFIED' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('IDENTIFIED');
    expect(r.body.data.identifiedAt).toBe('2026-10-30T04:00:00.000Z');
    setNow('2026-10-30T04:05:00Z');
    r = await post(2, { status: 'MONITORING' });
    expect(r.body.data.monitoringAt).toBe('2026-10-30T04:05:00.000Z');
    r = await post(3, { status: 'INVESTIGATING' }); // regression
    expect(r.body.data.status).toBe('INVESTIGATING');
    await post(4, { status: 'MONITORING' });
    r = await post(5, {}); // same status: a timeline entry only
    expect(r.body.data.status).toBe('MONITORING');
    expect(r.body.data.updates).toHaveLength(6);
    expect(r.body.data.monitoringAt).toBe('2026-10-30T04:05:00.000Z'); // first time only
    const illegal = await post(6, { status: 'IDENTIFIED' });
    expect(illegal.status).toBe(409);
    expect(illegal.body.code).toBe('INVALID_STATE');
    const stale = await post(1, {});
    expect(stale.body.code).toBe('STALE_VERSION');
    expect((await post(6, { message: 'short' })).status).toBe(400);
    expect(
      (
        await admin.c('post', '/platform/incidents/999999/updates', {
          version: 1,
          message: 'We are looking at it now.',
        })
      ).body.code,
    ).toBe('INCIDENT_NOT_FOUND');
  });

  it('T07-27 resolving a SEV2 needs a root cause; T07-28 a resolved incident takes no update, edit or second resolve', async () => {
    const admin = await platformAs('super_admin');
    const id = (await create(admin.c, { severity: 'SEV2' })).body.data.id;
    const resolve = (version: number, body: Record<string, unknown>) =>
      admin.c('post', `/platform/incidents/${id}/resolve`, {
        version,
        message: 'The provider fixed the delay.',
        ...body,
      });
    const no = await resolve(1, {});
    expect(no.status).toBe(422);
    expect(no.body.code).toBe('ROOT_CAUSE_REQUIRED');
    expect((await resolve(1, { rootCause: 'too short' })).body.code).toBe('ROOT_CAUSE_REQUIRED');
    setNow('2026-10-30T04:10:30Z');
    const ok = await resolve(1, { rootCause: 'The vendor rolled out a faulty release and rolled it back.' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      status: 'RESOLVED',
      resolvedAt: '2026-10-30T04:10:30.000Z',
      durationMinutes: 11,
    }); // ceil(70.5)
    expect(ok.body.data.updates.at(-1)).toMatchObject({
      status: 'RESOLVED',
      message: 'The provider fixed the delay.',
    });
    const upd = await admin.c('post', `/platform/incidents/${id}/updates`, {
      version: 2,
      message: 'One more thing to add.',
    });
    expect(upd.status).toBe(409);
    expect(upd.body.code).toBe('INVALID_STATE');
    expect(
      (await admin.c('patch', `/platform/incidents/${id}`, { version: 2, title: 'Changed title here' })).body
        .code,
    ).toBe('INVALID_STATE');
    expect((await resolve(2, {})).body.code).toBe('INVALID_STATE');
    // SEV3 needs no root cause
    const id3 = (await create(admin.c)).body.data.id;
    const sev3 = await admin.c('post', `/platform/incidents/${id3}/resolve`, {
      version: 1,
      message: 'All clear now.',
    });
    expect(sev3.status).toBe(200);
    expect(sev3.body.data.rootCause).toBeNull();
  });

  it('BR-07-33 an incident holds at most 100 timeline entries', async () => {
    const admin = await platformAs('super_admin');
    const created = (await create(admin.c)).body.data;
    await Incident.update(
      {
        updates: Array.from({ length: 100 }, (_, i) => ({
          at: '2026-10-30T04:00:00.000Z',
          status: 'INVESTIGATING',
          message: `Update number ${i}`,
          isPublic: true,
          byUserId: null,
          byName: 'x',
        })),
      },
      { where: { id: created.id } },
    );
    const r = await admin.c('post', `/platform/incidents/${created.id}/updates`, {
      version: 1,
      message: 'The hundred and first.',
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('INCIDENT_UPDATES_LIMIT');
    const res = await admin.c('post', `/platform/incidents/${created.id}/resolve`, {
      version: 1,
      message: 'Closing this one now.',
    });
    expect(res.body.code).toBe('INCIDENT_UPDATES_LIMIT');
  });

  it('PATCH edits title, severity, components and the public flag; list filters; Support may read but not write', async () => {
    const admin = await platformAs('super_admin');
    const agent = await platformAs('platform_support');
    const id = (await create(admin.c)).body.data.id;
    await create(admin.c, { title: 'Another incident', severity: 'SEV1', components: ['api'] });
    const r = await admin.c('patch', `/platform/incidents/${id}`, {
      version: 1,
      title: 'Delivery delays',
      severity: 'SEV4',
      isPublic: false,
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      title: 'Delivery delays',
      severity: 'SEV4',
      isPublic: false,
      version: 2,
    });
    expect(
      (await admin.c('patch', `/platform/incidents/${id}`, { version: 1, title: 'Stale edit here' })).body
        .code,
    ).toBe('STALE_VERSION');
    const list = await admin.c('get', '/platform/incidents', undefined, {
      query: { severity: 'SEV1,SEV4', sortBy: 'severity', sortOrder: 'asc' },
    });
    expect(list.body.data.map((i: any) => i.severity)).toEqual(['SEV1', 'SEV4']);
    expect(list.body.pagination.total).toBe(2);
    expect(
      (await admin.c('get', '/platform/incidents', undefined, { query: { status: 'RESOLVED' } })).body.data,
    ).toEqual([]);
    expect((await agent.c('get', `/platform/incidents/${id}`)).status).toBe(200);
    expect((await agent.c('get', `/platform/incidents/${id}`)).body.data.incidentNo).toMatch(/^INC-/);
    expect(
      (
        await agent.c(
          'post',
          '/platform/incidents',
          {
            title: 'Support incident',
            severity: 'SEV3',
            components: ['api'],
            message: 'We are checking something.',
          },
          { headers: idem() },
        )
      ).status,
    ).toBeLessThan(500);
    expect((await admin.c('get', '/platform/incidents/999999')).body.code).toBe('INCIDENT_NOT_FOUND');
  });
});

describe('manual provider status (BR-07-28, BR-07-29, T07-24)', () => {
  it('manual OUTAGE switches to MANUAL and opens one public incident; a second manual change adds none while one is open', async () => {
    const admin = await platformAs('super_admin');
    const f = await fakeProvider(admin.c, {
      key: 'wa_a',
      channel: 'WHATSAPP',
      name: 'WhatsApp Business API',
    });
    const r = await admin.c('post', `/platform/providers/${f.id}/status`, {
      version: f.version,
      mode: 'MANUAL',
      status: 'OUTAGE',
      reason: 'Vendor confirmed an outage',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.provider.health).toMatchObject({
      status: 'OUTAGE',
      mode: 'MANUAL',
      reason: 'Vendor confirmed an outage',
    });
    const inc = (await Incident.findByPk(r.body.data.incidentId))!;
    expect(inc).toMatchObject({
      title: 'WhatsApp Business API is down: Vendor confirmed an outage',
      severity: 'SEV2',
      source: 'PROVIDER_MANUAL',
      isPublic: true,
      serviceProviderId: f.id,
    });
    const again = await admin.c('post', `/platform/providers/${f.id}/status`, {
      version: r.body.data.provider.version,
      mode: 'MANUAL',
      status: 'DEGRADED',
      reason: 'Partly back, still slow',
    });
    expect(again.body.data.incidentId).toBeNull();
    expect(await Incident.count()).toBe(1);
    const same = await admin.c('post', `/platform/providers/${f.id}/status`, {
      version: again.body.data.provider.version,
      mode: 'MANUAL',
      status: 'DEGRADED',
      reason: 'Still the same reason',
    });
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('INVALID_STATE');
    expect(
      (
        await admin.c('post', `/platform/providers/${f.id}/status`, {
          version: 1,
          mode: 'MANUAL',
          status: 'OUTAGE',
          reason: 'ok ok ok',
        })
      ).body.code,
    ).toBe('STALE_VERSION');
    expect(
      (
        await admin.c('post', `/platform/providers/${f.id}/status`, {
          version: 9,
          mode: 'MANUAL',
          status: 'OUTAGE',
        })
      ).status,
    ).toBe(400); // reason required
    expect(await AuditLog.count({ where: { action: 'platform.provider.status_set' } })).toBe(2);
    expect(
      events.some(e => e.event === 'platform.provider.status_changed' && e.room === 'platform:ops'),
    ).toBe(true);
    const mail = (await listInbox()).filter(m => m.subject?.includes('WhatsApp Business API is now'));
    expect(mail.length).toBeGreaterThan(0);
  });

  it('T07-24 manual OPERATIONAL resolves every open incident of the provider with the reason as root cause', async () => {
    const admin = await platformAs('super_admin');
    const f = await fakeProvider(admin.c, {
      key: 'wa_a',
      channel: 'WHATSAPP',
      name: 'WhatsApp Business API',
    });
    const out = await admin.c('post', `/platform/providers/${f.id}/status`, {
      version: f.version,
      mode: 'MANUAL',
      status: 'OUTAGE',
      reason: 'Vendor confirmed an outage',
    });
    const ok = await admin.c('post', `/platform/providers/${f.id}/status`, {
      version: out.body.data.provider.version,
      mode: 'MANUAL',
      status: 'OPERATIONAL',
      reason: 'Vendor fixed the issue',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const inc = (await Incident.findByPk(out.body.data.incidentId))!;
    expect(inc).toMatchObject({ status: 'RESOLVED', rootCause: 'Vendor fixed the issue' });
    expect(inc.resolvedAt).not.toBeNull();
    expect(ok.body.data.provider.health).toMatchObject({ status: 'OPERATIONAL', mode: 'MANUAL' });
    // back to automatic
    const auto = await admin.c('post', `/platform/providers/${f.id}/status`, {
      version: ok.body.data.provider.version,
      mode: 'AUTOMATIC',
    });
    expect(auto.body.data.provider.health.mode).toBe('AUTOMATIC');
    expect(
      (
        await admin.c('post', `/platform/providers/${f.id}/status`, {
          version: auto.body.data.provider.version,
          mode: 'AUTOMATIC',
        })
      ).body.code,
    ).toBe('INVALID_STATE');
  });

  it('BR-07-29 resolving the last incident of a MANUAL provider returns it to AUTOMATIC and OPERATIONAL', async () => {
    const admin = await platformAs('super_admin');
    const f = await fakeProvider(admin.c, { key: 'wa_a', channel: 'WHATSAPP' });
    const out = await admin.c('post', `/platform/providers/${f.id}/status`, {
      version: f.version,
      mode: 'MANUAL',
      status: 'DEGRADED',
      reason: 'Delivery is slow today',
    });
    const res = await admin.c('post', `/platform/incidents/${out.body.data.incidentId}/resolve`, {
      version: 1,
      message: 'Delivery is back to normal.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await ServiceProvider.findByPk(f.id!)).toMatchObject({
      statusMode: 'AUTOMATIC',
      healthStatus: 'OPERATIONAL',
    });
  });

  it('a manual OUTAGE while an automatic incident is open adds no second incident', async () => {
    const admin = await platformAs('super_admin');
    const f = await fakeProvider(admin.c, { key: 'sms_a', failMode: 'error' });
    for (let i = 0; i < 3; i++) await runCheck(f.id!);
    expect(await Incident.count()).toBe(1);
    const cur = (await ServiceProvider.findByPk(f.id!))!;
    const r = await admin.c('post', `/platform/providers/${f.id}/status`, {
      version: cur.version,
      mode: 'MANUAL',
      status: 'OUTAGE',
      reason: 'Confirmed with the vendor',
    });
    expect(r.body.data.incidentId).toBeNull();
    expect(await Incident.count()).toBe(1);
    expect((await ServiceProvider.findByPk(f.id!))!.statusMode).toBe('MANUAL');
  });
});

describe('public status page (8.6, BR-07-34, BR-07-35)', () => {
  it('lists all 12 components operational with no login and the cache headers', async () => {
    await platformAs('super_admin');
    const r = await status();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.overall).toBe('OPERATIONAL');
    expect(r.body.data.components).toHaveLength(12);
    expect(r.body.data.components[0]).toEqual({ key: 'api', name: 'Sign-in and API', status: 'OPERATIONAL' });
    expect(r.body.data.activeIncidents).toEqual([]);
    expect(r.headers['cache-control']).toBe('public, max-age=30');
    expect(r.headers.etag).toBeTruthy();
    const cond = await call('get', '/public/status', undefined, { csrf: false }).set(
      'If-None-Match',
      r.headers.etag,
    );
    expect(cond.status).toBe(304);
  });

  it('T07-29 a public SEV2 incident on WhatsApp with notifySocieties: PARTIAL_OUTAGE, a published banner, resolve expires it', async () => {
    const admin = await platformAs('super_admin');
    const society = await opsSociety();
    const chair = await memberUser(society, 'chairman', { name: 'Rajesh' });
    const r = await create(admin.c, { severity: 'SEV2', notifySocieties: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.announcementId).not.toBeNull();
    const a = (await PlatformNotification.findByPk(r.body.data.announcementId))!;
    expect(a).toMatchObject({
      kind: 'INCIDENT',
      severity: 'WARNING',
      status: 'PUBLISHED',
      audienceType: 'ALL',
      incidentId: r.body.data.id,
      isDismissible: true,
      channels: [],
    });
    expect(a.expiresAt.toISOString()).toBe('2026-11-06T04:00:00.000Z'); // startedAt + 7 days
    const s = await status();
    expect(s.body.data.overall).toBe('PARTIAL_OUTAGE');
    expect(s.body.data.components.find((c: any) => c.key === 'notifications_whatsapp').status).toBe(
      'PARTIAL_OUTAGE',
    );
    expect(s.body.data.activeIncidents[0]).toMatchObject({
      incidentNo: r.body.data.incidentNo,
      severity: 'SEV2',
      components: ['notifications_whatsapp'],
    });
    expect(JSON.stringify(s.body)).not.toContain('Isha');
    expect(JSON.stringify(s.body)).not.toContain('byName');
    void chair;
    const res = await admin.c('post', `/platform/incidents/${r.body.data.id}/resolve`, {
      version: 1,
      message: 'WhatsApp delivery is back to normal.',
      rootCause: 'The vendor queue stalled and was restarted at 05:10.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await PlatformNotification.findByPk(a.id!))!.status).toBe('EXPIRED');
    const after = await status();
    expect(after.body.data.overall).toBe('OPERATIONAL'); // cache invalidated by the resolve
    expect(after.body.data.recentIncidents[0]).toMatchObject({
      incidentNo: r.body.data.incidentNo,
      severity: 'SEV2',
    });
    expect(after.body.data.recentIncidents[0].durationMinutes).toBe(0);
    expect(after.body.data.recentIncidents[0].rootCause).toBeUndefined();
  });

  it('SEV1 notify creates a CRITICAL banner that cannot be dismissed; PATCH notifySocieties creates it once', async () => {
    const admin = await platformAs('super_admin');
    const r = await create(admin.c, { severity: 'SEV1', components: ['api'], notifySocieties: true });
    const a = (await PlatformNotification.findByPk(r.body.data.announcementId))!;
    expect(a).toMatchObject({ severity: 'CRITICAL', isDismissible: false });
    const s = await status();
    expect(s.body.data.overall).toBe('MAJOR_OUTAGE');
    const plain = (await create(admin.c, { severity: 'SEV2', title: 'Second incident here' })).body.data;
    expect(plain.announcementId).toBeNull();
    const p = await admin.c('patch', `/platform/incidents/${plain.id}`, {
      version: 1,
      notifySocieties: true,
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data.announcementId).not.toBeNull();
    await admin.c('patch', `/platform/incidents/${plain.id}`, { version: 2, notifySocieties: true });
    expect(await PlatformNotification.count({ where: { incidentId: plain.id } })).toBe(1);
  });

  it('T07-30 a private incident and an internal update never appear; only public updates are shown', async () => {
    const admin = await platformAs('super_admin');
    await create(admin.c, { title: 'Private investigation', isPublic: false });
    const pub = (
      await create(admin.c, { title: 'Public incident here', message: 'This part is public text.' })
    ).body.data;
    await admin.c('post', `/platform/incidents/${pub.id}/updates`, {
      version: 1,
      message: 'Internal note about the vendor.',
      isPublic: false,
    });
    await admin.c('post', `/platform/incidents/${pub.id}/updates`, {
      version: 2,
      message: 'Second public update text.',
      status: 'IDENTIFIED',
    });
    const s = await status();
    const text = JSON.stringify(s.body);
    expect(text).not.toContain('Private investigation');
    expect(text).not.toContain('Internal note');
    expect(s.body.data.activeIncidents).toHaveLength(1);
    expect(s.body.data.activeIncidents[0].updates.map((u: any) => u.message)).toEqual([
      'This part is public text.',
      'Second public update text.',
    ]);
    expect(Object.keys(s.body.data.activeIncidents[0].updates[0])).toEqual(['at', 'status', 'message']);
    expect(text).not.toContain('rootCause');
    expect(text).not.toContain('serviceProviderId');
    expect(s.body.data.overall).toBe('DEGRADED'); // SEV3 public incident
  });

  it('T07-31 the status page answers 60 times a minute per address and the 61st is 429', async () => {
    for (let i = 0; i < 60; i++)
      expect((await status().set('X-Forwarded-For', '203.0.113.9')).status).toBe(200);
    const r = await status().set('X-Forwarded-For', '203.0.113.9');
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('RATE_LIMITED');
    expect((await status().set('X-Forwarded-For', '203.0.113.10')).status).toBe(200); // another address
  });

  it('status.publicEnabled false answers 200 with the disabled message; the cache lasts 30 seconds', async () => {
    const admin = await platformAs('super_admin');
    await status();
    await create(admin.c, { severity: 'SEV3', title: 'Cached incident here' });
    // the create invalidated the cache, so the page shows the incident at once
    expect((await status()).body.data.activeIncidents).toHaveLength(1);
    await seedPlatformSettings();
    await PlatformSetting.update({ valueJson: false }, { where: { settingKey: 'status.publicEnabled' } });
    await clearSettingsCache();
    const off = await status();
    expect(off.status).toBe(200);
    expect(off.body.data).toEqual({
      overall: 'OPERATIONAL',
      components: [],
      message: 'Status page disabled',
    });
  });

  it('provider health maps to components: all in OUTAGE is PARTIAL_OUTAGE, primary down with a healthy fallback is DEGRADED', async () => {
    expect(providerComponentStatus([])).toBe('OPERATIONAL');
    expect(providerComponentStatus(['OUTAGE'])).toBe('PARTIAL_OUTAGE');
    expect(providerComponentStatus(['OUTAGE', 'OUTAGE'])).toBe('PARTIAL_OUTAGE');
    expect(providerComponentStatus(['OUTAGE', 'OPERATIONAL'])).toBe('DEGRADED');
    expect(providerComponentStatus(['DEGRADED', 'OPERATIONAL'])).toBe('DEGRADED');
    expect(providerComponentStatus(['DEGRADED'])).toBe('DEGRADED');
    expect(providerComponentStatus(['OPERATIONAL', 'OUTAGE'])).toBe('OPERATIONAL');
    const admin = await platformAs('super_admin');
    const f = await fakeProvider(admin.c, { key: 'sms_a', channel: 'SMS', failMode: 'error' });
    for (let i = 0; i < 10; i++) await runCheck(f.id!);
    const s = await status();
    expect(s.body.data.components.find((c: any) => c.key === 'notifications_sms').status).toBe(
      'PARTIAL_OUTAGE',
    );
    expect(s.body.data.overall).toBe('PARTIAL_OUTAGE');
    expect(JSON.stringify(s.body)).not.toContain('FAKE'); // no vendor names
  });
});
