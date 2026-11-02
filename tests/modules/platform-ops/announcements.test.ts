import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, PlatformNotification, User, closeDb, sequelize } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { kv } from '../../../src/lib/kv';
import { listInbox } from '../../../src/lib/inbox';
import { events } from '../../helpers/auth';
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';
import { PLATFORM_OPS_QUEUE } from '../../../src/modules/platform-ops/platform-ops.types';
import { queueInspector } from '../../../src/lib/queue';
import { as, idem, login, memberUser, resetLogins } from '../../helpers/access';
import { lifecycleSociety, platformAs } from '../../helpers/societies';
import { resetOps } from '../../helpers/platform-ops';
import {
  createAnnouncement,
  runAnnouncementFanout,
  runAnnouncementScheduler,
} from '../../../src/modules/platform-ops/platform-ops.announcements.service';
import { systemCtx } from '../../../src/types/context';

afterAll(closeDb);
beforeEach(async () => {
  await resetOps();
  resetLogins();
  setNow('2026-10-30T04:00:00Z');
});

const ROLES = ['chairman', 'secretary'];
const body = (o: Record<string, unknown> = {}) => ({
  title: 'Scheduled maintenance on Sunday',
  body: 'The app will be unavailable from 01:00 to 02:00 IST on Sunday for a database upgrade.',
  kind: 'MAINTENANCE',
  severity: 'WARNING',
  audienceType: 'ALL',
  audienceRoleKeys: ROLES,
  expiresAt: '2026-11-02T00:30:00.000Z',
  ...o,
});
const create = (c: any, o: Record<string, unknown> = {}) =>
  c('post', '/platform/announcements', body(o), { headers: idem() });

async function world() {
  const premium = await lifecycleSociety('ACTIVE', { name: 'Sky Heights CHS', plan: 'PREMIUM' });
  const standard = await lifecycleSociety('ACTIVE', { name: 'Green Park CHS', plan: 'STANDARD' });
  const pChair = await memberUser(premium, 'chairman', { name: 'Rajesh' });
  const sChair = await memberUser(standard, 'chairman', { name: 'Meena' });
  await User.update({ email: 'rajesh@skyheights.in' }, { where: { id: pChair.id } });
  await User.update({ email: 'meena@greenpark.in' }, { where: { id: sChair.id } });
  const admin = await platformAs('super_admin');
  return { premium, standard, pChair, sChair, admin };
}
const banners = async (u: any, societyId: number) =>
  (await as(await login(u, { societyId }))('get', '/platform-announcements')).body.data.items as any[];

describe('announcement routes (8.7)', () => {
  it('creates a DRAFT with the announcement object and an audit row; CRITICAL is never dismissible', async () => {
    const { admin } = await world();
    const r = await create(admin.c.bind(null) as any);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'DRAFT',
      kind: 'MAINTENANCE',
      severity: 'WARNING',
      audienceType: 'ALL',
      audienceRoleKeys: ROLES,
      channels: [],
      isDismissible: true,
      publishAt: null,
      expiresAt: '2026-11-02T00:30:00.000Z',
      ctaLabel: null,
      incidentId: null,
      recipientCount: null,
      version: 1,
    });
    expect((await AuditLog.findOne({ where: { action: 'platform.announcement.created' } }))!.entityId).toBe(
      String(r.body.data.id),
    );
    const crit = await create(admin.c, { severity: 'CRITICAL', isDismissible: true });
    expect(crit.body.data.isDismissible).toBe(false);
  });

  it('T07-34 the WhatsApp channel needs CRITICAL severity or kind MAINTENANCE or INCIDENT', async () => {
    const { admin } = await world();
    const info = await create(admin.c, { kind: 'ANNOUNCEMENT', severity: 'INFO', channels: ['WHATSAPP'] });
    expect(info.status).toBe(422);
    expect(info.body.code).toBe('WHATSAPP_NOT_ALLOWED');
    expect(
      (await create(admin.c, { kind: 'MAINTENANCE', severity: 'INFO', channels: ['WHATSAPP', 'EMAIL'] }))
        .status,
    ).toBe(201);
    expect(
      (await create(admin.c, { kind: 'BILLING', severity: 'CRITICAL', channels: ['WHATSAPP'] })).status,
    ).toBe(201);
  });

  it('validates the link, the audience, the plan keys, the societies and the dates', async () => {
    const { admin, premium } = await world();
    const cta = (url: string) => create(admin.c, { ctaLabel: 'View status', ctaUrl: url });
    expect((await cta('http://status.societyapp.in')).body.code).toBe('CTA_URL_NOT_ALLOWED');
    expect((await cta('https://evil.example.com/x')).body.code).toBe('CTA_URL_NOT_ALLOWED');
    expect((await cta('https://status.societyapp.in')).status).toBe(201);
    expect((await cta('https://admin.societyapp.in/billing')).status).toBe(201);
    expect((await create(admin.c, { ctaLabel: 'View status' })).status).toBe(400); // label without link
    expect((await create(admin.c, { audienceType: 'PLANS' })).status).toBe(400); // list missing
    expect((await create(admin.c, { audienceType: 'ALL', audiencePlanKeys: ['PREMIUM'] })).status).toBe(400); // list not allowed
    expect((await create(admin.c, { audienceType: 'PLANS', audiencePlanKeys: ['GOLD'] })).body.code).toBe(
      'UNKNOWN_PLAN_KEY',
    );
    expect((await create(admin.c, { audienceType: 'PLANS', audiencePlanKeys: ['premium'] })).status).toBe(
      201,
    ); // keys are case-insensitive
    expect(
      (await create(admin.c, { audienceType: 'SOCIETIES', audienceSocietyIds: [premium.id, 999999] })).body
        .code,
    ).toBe('SOCIETY_NOT_FOUND');
    expect(
      (await create(admin.c, { audienceType: 'SOCIETY_STATUSES', audienceSocietyStatuses: ['CLOSED'] }))
        .status,
    ).toBe(400);
    expect((await create(admin.c, { audienceRoleKeys: ['janitor'] })).status).toBe(400);
    expect((await create(admin.c, { expiresAt: '2026-10-30T03:00:00.000Z' })).status).toBe(400); // already past
    expect((await create(admin.c, { expiresAt: '2027-03-01T00:00:00.000Z' })).status).toBe(400); // over 90 days
    expect((await create(admin.c, { publishAt: '2026-10-30T04:00:30.000Z' })).status).toBe(400); // under a minute ahead
    expect(
      (
        await create(admin.c, {
          publishAt: '2027-01-30T04:00:00.000Z',
          expiresAt: '2027-02-01T00:00:00.000Z',
        })
      ).status,
    ).toBe(400); // over 60 days ahead
    expect(
      (
        await create(admin.c, {
          publishAt: '2026-11-01T04:30:00.000Z',
          expiresAt: '2026-11-01T04:00:00.000Z',
        })
      ).status,
    ).toBe(400); // expiry before publish
    expect((await create(admin.c, { extra: 1 })).status).toBe(400); // strict body
  });

  it('T07-33 publishing an audience that matches no members is AUDIENCE_EMPTY', async () => {
    const { admin } = await world();
    const d = (await create(admin.c, { audienceRoleKeys: ['auditor'] })).body.data;
    const r = await admin.c('post', `/platform/announcements/${d.id}/publish`, { version: 1 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('AUDIENCE_EMPTY');
    expect((await PlatformNotification.findByPk(d.id))!.status).toBe('DRAFT');
    const pre = await admin.c('post', '/platform/announcements/audience-preview', {
      audienceType: 'ALL',
      audienceRoleKeys: ['auditor'],
    });
    expect(pre.body.data).toEqual({ societies: 0, recipients: 0 });
  });

  it('audience preview counts societies and distinct recipients', async () => {
    const { admin, premium } = await world();
    await memberUser(premium, 'secretary', { name: 'Sunita' });
    const all = await admin.c('post', '/platform/announcements/audience-preview', {
      audienceType: 'ALL',
      audienceRoleKeys: ['chairman', 'secretary'],
    });
    expect(all.body.data).toEqual({ societies: 2, recipients: 3 });
    const plan = await admin.c('post', '/platform/announcements/audience-preview', {
      audienceType: 'PLANS',
      audiencePlanKeys: ['PREMIUM'],
      audienceRoleKeys: ['chairman', 'secretary'],
    });
    expect(plan.body.data).toEqual({ societies: 1, recipients: 2 });
    const one = await admin.c('post', '/platform/announcements/audience-preview', {
      audienceType: 'SOCIETIES',
      audienceSocietyIds: [premium.id],
      audienceRoleKeys: ['secretary'],
    });
    expect(one.body.data).toEqual({ societies: 1, recipients: 1 });
    const st = await admin.c('post', '/platform/announcements/audience-preview', {
      audienceType: 'SOCIETY_STATUSES',
      audienceSocietyStatuses: ['PAST_DUE'],
      audienceRoleKeys: ['chairman'],
    });
    expect(st.body.data).toEqual({ societies: 0, recipients: 0 });
  });

  it('T07-32 an announcement for plan premium and role chairman reaches the Premium chairman, not the Standard one', async () => {
    const { admin, premium, standard, pChair, sChair } = await world();
    const secretary = await memberUser(premium, 'secretary', { name: 'Sunita' });
    const d = (
      await create(admin.c, {
        audienceType: 'PLANS',
        audiencePlanKeys: ['premium'],
        audienceRoleKeys: ['chairman'],
      })
    ).body.data;
    expect((await banners(pChair, premium.id!)).length).toBe(0); // a draft shows nowhere
    const pub = await admin.c('post', `/platform/announcements/${d.id}/publish`, { version: 1 });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(pub.body.data).toMatchObject({ status: 'PUBLISHED', version: 2 });
    expect(pub.body.data.publishedAt).toBe('2026-10-30T04:00:00.000Z');
    const mine = await banners(pChair, premium.id!);
    expect(mine).toHaveLength(1);
    expect(Object.keys(mine[0]).sort()).toEqual([
      'body',
      'ctaLabel',
      'ctaUrl',
      'expiresAt',
      'id',
      'isDismissible',
      'kind',
      'publishedAt',
      'severity',
      'title',
    ]);
    expect(await banners(sChair, standard.id!)).toEqual([]); // wrong plan
    expect(await banners(secretary, premium.id!)).toEqual([]); // right plan, wrong role
    expect(
      events.some(
        e =>
          e.room === `society:${premium.id}:admin` &&
          e.event === 'platform.announcement.published' &&
          (e.payload as any).id === d.id,
      ),
    ).toBe(true);
    expect(
      events.some(
        e => e.room === `society:${standard.id}:admin` && e.event === 'platform.announcement.published',
      ),
    ).toBe(false);
    expect(
      (await AuditLog.findOne({ where: { action: 'platform.announcement.published' } }))!.societyId,
    ).toBeNull();
  });

  it('the banner audience is live: a society that joins the audience later sees it; expiry and cancel remove it at once', async () => {
    const { admin, premium, standard, sChair } = await world();
    const d = (await create(admin.c, { audienceType: 'SOCIETIES', audienceSocietyIds: [premium.id] })).body
      .data;
    await admin.c('post', `/platform/announcements/${d.id}/publish`, { version: 1 });
    expect(await banners(sChair, standard.id!)).toEqual([]);
    await PlatformNotification.update(
      { audienceType: 'ALL', audienceSocietyIds: null },
      { where: { id: d.id } },
    );
    expect(await banners(sChair, standard.id!)).toHaveLength(1);
    const cancel = await admin.c('post', `/platform/announcements/${d.id}/cancel`, {
      version: 2,
      reason: 'Sent to the wrong audience',
    });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    expect(cancel.body.data).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Sent to the wrong audience',
    });
    expect(await banners(sChair, standard.id!)).toEqual([]);
    expect(
      (
        await admin.c('post', `/platform/announcements/${d.id}/cancel`, {
          version: 3,
          reason: 'Cancel it again',
        })
      ).body.code,
    ).toBe('INVALID_STATE');
  });

  it('banners: CRITICAL first, then newest, at most 5; a suspended society still reads them', async () => {
    const { admin, premium, pChair } = await world();
    for (let i = 0; i < 6; i++) {
      setNow(`2026-10-30T04:0${i}:00Z`);
      const d = (
        await create(admin.c, {
          title: `Notice number ${i}`,
          severity: i === 2 ? 'CRITICAL' : 'INFO',
          kind: 'ANNOUNCEMENT',
          expiresAt: '2026-11-20T00:00:00.000Z',
        })
      ).body.data;
      expect((await admin.c('post', `/platform/announcements/${d.id}/publish`, { version: 1 })).status).toBe(
        200,
      );
    }
    const items = await banners(pChair, premium.id!);
    expect(items).toHaveLength(5);
    expect(items.map(i => i.title)).toEqual([
      'Notice number 2',
      'Notice number 5',
      'Notice number 4',
      'Notice number 3',
      'Notice number 1',
    ]);
    await sequelize.query(
      'UPDATE societies SET status = "SUSPENDED", suspensionCause = "MANUAL" WHERE id = :id',
      { replacements: { id: premium.id } },
    );
    await flushAcl();
    const sus = as(await login(pChair, { societyId: premium.id! })); // the signed-in session of this test
    const r = await sus('get', '/platform-announcements');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('T07-36 a CRITICAL announcement cannot be dismissed; a normal one can, only for the user who dismissed it', async () => {
    const { admin, premium, pChair } = await world();
    const sec = await memberUser(premium, 'chairman', { name: 'Second Chair' });
    const crit = (await create(admin.c, { severity: 'CRITICAL', title: 'Critical notice here' })).body.data;
    const info = (
      await create(admin.c, { severity: 'INFO', kind: 'ANNOUNCEMENT', title: 'Plain notice here' })
    ).body.data;
    await admin.c('post', `/platform/announcements/${crit.id}/publish`, { version: 1 });
    await admin.c('post', `/platform/announcements/${info.id}/publish`, { version: 1 });
    const c = as(await login(pChair, { societyId: premium.id! }));
    const no = await c('post', `/platform-announcements/${crit.id}/dismiss`, {});
    expect(no.status).toBe(422);
    expect(no.body.code).toBe('NOT_DISMISSIBLE');
    const yes = await c('post', `/platform-announcements/${info.id}/dismiss`, {});
    expect(yes.status).toBe(204);
    expect((await c('get', '/platform-announcements')).body.data.items.map((i: any) => i.title)).toEqual([
      'Critical notice here',
    ]);
    const other = as(await login(sec, { societyId: premium.id! }));
    expect((await other('get', '/platform-announcements')).body.data.items).toHaveLength(2); // dismissal is per user
    expect((await c('post', '/platform-announcements/999999/dismiss', {})).body.code).toBe(
      'ANNOUNCEMENT_NOT_FOUND',
    );
    // Redis loses the keys: the banner comes back once
    await kv().cacheDelPrefix('pn:dismissed:');
    expect((await c('get', '/platform-announcements')).body.data.items).toHaveLength(2);
  });

  it('a banner another audience cannot see is 404 on dismiss (isolation)', async () => {
    const { admin, premium, standard, sChair } = await world();
    const d = (
      await create(admin.c, {
        audienceType: 'SOCIETIES',
        audienceSocietyIds: [premium.id],
        severity: 'INFO',
        kind: 'ANNOUNCEMENT',
      })
    ).body.data;
    await admin.c('post', `/platform/announcements/${d.id}/publish`, { version: 1 });
    const c = as(await login(sChair, { societyId: standard.id! }));
    const r = await c('post', `/platform-announcements/${d.id}/dismiss`, {});
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('ANNOUNCEMENT_NOT_FOUND');
  });

  it('lifecycle guards: PATCH only DRAFT and SCHEDULED, DELETE only DRAFT, stale versions, a published one cannot be edited', async () => {
    const { admin } = await world();
    const d = (await create(admin.c)).body.data;
    const p = await admin.c('patch', `/platform/announcements/${d.id}`, {
      version: 1,
      title: 'New title for it',
      audienceType: 'ALL',
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data).toMatchObject({ title: 'New title for it', version: 2 });
    expect(
      (await admin.c('patch', `/platform/announcements/${d.id}`, { version: 1, title: 'Stale title here' }))
        .body.code,
    ).toBe('STALE_VERSION');
    expect(
      (await admin.c('patch', `/platform/announcements/${d.id}`, { version: 2, ctaLabel: 'Open' })).status,
    ).toBe(400);
    expect(
      (
        await admin.c('patch', `/platform/announcements/${d.id}`, {
          version: 2,
          severity: 'INFO',
          kind: 'ANNOUNCEMENT',
          channels: ['WHATSAPP'],
        })
      ).body.code,
    ).toBe('WHATSAPP_NOT_ALLOWED');
    await admin.c('post', `/platform/announcements/${d.id}/publish`, { version: 2 });
    expect(
      (await admin.c('patch', `/platform/announcements/${d.id}`, { version: 3, title: 'Edit after publish' }))
        .body.code,
    ).toBe('INVALID_STATE');
    expect((await admin.c('delete', `/platform/announcements/${d.id}`, { version: 3 })).body.code).toBe(
      'INVALID_STATE',
    );
    expect((await admin.c('post', `/platform/announcements/${d.id}/publish`, { version: 3 })).body.code).toBe(
      'INVALID_STATE',
    );
    const draft = (await create(admin.c, { title: 'To be deleted soon' })).body.data;
    expect((await admin.c('delete', `/platform/announcements/${draft.id}`, { version: 9 })).body.code).toBe(
      'STALE_VERSION',
    );
    expect((await admin.c('delete', `/platform/announcements/${draft.id}`, { version: 1 })).status).toBe(204);
    expect((await admin.c('get', `/platform/announcements/${draft.id}`)).body.code).toBe(
      'ANNOUNCEMENT_NOT_FOUND',
    );
    expect(await PlatformNotification.count({ where: { id: draft.id }, paranoid: false })).toBe(1); // soft delete
    expect(
      (await admin.c('get', '/platform/announcements', undefined, { query: { status: 'PUBLISHED' } })).body
        .data,
    ).toHaveLength(1);
    expect(
      (await admin.c('get', '/platform/announcements', undefined, { query: { kind: 'BILLING' } })).body.data,
    ).toHaveLength(0);
    const support = await platformAs('platform_support');
    expect((await support.c('get', '/platform/announcements')).status).toBe(200);
    expect((await create(support.c)).status).toBe(403);
    expect(
      (
        await support.c('post', `/platform/announcements/${d.id}/cancel`, {
          version: 3,
          reason: 'Not allowed to',
        })
      ).status,
    ).toBe(403);
  });

  it('PUBLISH_WINDOW_INVALID when the publish time or the expiry has passed since the draft was saved', async () => {
    const { admin } = await world();
    const d = (await create(admin.c, { publishAt: '2026-10-30T05:00:00.000Z' })).body.data;
    setNow('2026-10-30T05:02:00Z');
    const r = await admin.c('post', `/platform/announcements/${d.id}/publish`, { version: 1 });
    expect(r.status).toBe(401); // the session aged; sign in again at the new time
    resetLogins();
    const fresh = await platformAs('super_admin', 'Asha Two');
    const r2 = await fresh.c('post', `/platform/announcements/${d.id}/publish`, { version: 1 });
    expect(r2.status).toBe(422);
    expect(r2.body.code).toBe('PUBLISH_WINDOW_INVALID');
    const e = await PlatformNotification.create({
      ...((await PlatformNotification.findByPk(d.id))!.toJSON() as object),
      id: undefined,
      publishAt: null,
      expiresAt: new Date('2026-10-30T05:01:00Z'),
    } as never);
    expect((await fresh.c('post', `/platform/announcements/${e.id}/publish`, { version: 1 })).body.code).toBe(
      'PUBLISH_WINDOW_INVALID',
    );
  });
});

describe('scheduler and fan-out (6.3, 6.7, T07-35)', () => {
  it('a future publishAt becomes SCHEDULED; the scheduler publishes it when due and the fan-out runs', async () => {
    const { admin, premium, pChair } = await world();
    const d = (await create(admin.c, { publishAt: '2026-10-30T04:30:00.000Z', channels: ['EMAIL'] })).body
      .data;
    const pub = await admin.c('post', `/platform/announcements/${d.id}/publish`, { version: 1 });
    expect(pub.body.data).toMatchObject({ status: 'SCHEDULED', publishedAt: null });
    expect(await AuditLog.findOne({ where: { action: 'platform.announcement.scheduled' } })).not.toBeNull();
    expect(await runAnnouncementScheduler()).toEqual({ published: 0, cancelled: 0, expired: 0 });
    setNow('2026-10-30T04:30:05Z');
    expect(await runAnnouncementScheduler()).toEqual({ published: 1, cancelled: 0, expired: 0 });
    await drainQueues();
    const row = (await PlatformNotification.findByPk(d.id))!;
    expect(row.status).toBe('PUBLISHED');
    expect(row.publishedAt!.toISOString()).toBe('2026-10-30T04:30:05.000Z');
    expect(row.recipientCount).toBe(2);
    expect(row.fanoutCompletedAt).not.toBeNull();
    expect(await runAnnouncementScheduler()).toEqual({ published: 0, cancelled: 0, expired: 0 }); // idempotent
    resetLogins();
    expect((await banners(pChair, premium.id!)).length).toBe(1);
    const mails = (await listInbox()).filter(m => m.subject === 'Scheduled maintenance on Sunday');
    expect(mails.map(m => m.to).sort()).toEqual(['meena@greenpark.in', 'rajesh@skyheights.in']);
    expect(
      (await AuditLog.findOne({ where: { action: 'platform.announcement.published' } }))!.actorRole,
    ).toBe('system');
  });

  it('a scheduled announcement whose audience became empty is CANCELLED by the scheduler with a reason and an audit row', async () => {
    const { admin, pChair, sChair } = await world();
    const d = (await create(admin.c, { publishAt: '2026-10-30T04:30:00.000Z' })).body.data;
    await admin.c('post', `/platform/announcements/${d.id}/publish`, { version: 1 });
    await sequelize.query(
      'UPDATE society_members SET status = "ENDED", endedAt = NOW(3) WHERE userId IN (:ids)',
      {
        replacements: { ids: [pChair.id, sChair.id] },
      },
    );
    setNow('2026-10-30T04:31:00Z');
    expect(await runAnnouncementScheduler()).toEqual({ published: 0, cancelled: 1, expired: 0 });
    const row = (await PlatformNotification.findByPk(d.id))!;
    expect(row).toMatchObject({ status: 'CANCELLED', cancelReason: 'Audience empty at publish time' });
    expect((await AuditLog.findOne({ where: { action: 'platform.announcement.cancelled' } }))!.reason).toBe(
      'Audience empty at publish time',
    );
  });

  it('the scheduler expires PUBLISHED announcements whose expiry has passed (audited as system)', async () => {
    const { admin } = await world();
    const d = (await create(admin.c, { expiresAt: '2026-10-30T06:00:00.000Z' })).body.data;
    await admin.c('post', `/platform/announcements/${d.id}/publish`, { version: 1 });
    setNow('2026-10-30T06:00:01Z');
    expect((await runAnnouncementScheduler()).expired).toBe(1);
    expect((await PlatformNotification.findByPk(d.id))!.status).toBe('EXPIRED');
    const a = await AuditLog.findOne({ where: { action: 'platform.announcement.expired' } });
    expect(a!.actorRole).toBe('system');
  });

  it('T07-35 the fan-out job runs twice: every recipient is notified once and recipientCount is set once', async () => {
    const { admin, premium } = await world();
    await memberUser(premium, 'secretary', { name: 'Sunita' });
    const d = (await create(admin.c, { channels: ['EMAIL'] })).body.data;
    await admin.c('post', `/platform/announcements/${d.id}/publish`, { version: 1 });
    await drainQueues(); // the job queued by the publish
    const first = (await PlatformNotification.findByPk(d.id))!;
    expect(first.recipientCount).toBe(3);
    const stamp = first.fanoutCompletedAt!;
    const before = (await listInbox()).length;
    expect(await runAnnouncementFanout(d.id)).toBeNull(); // fanoutCompletedAt is set: nothing to do
    expect((await listInbox()).length).toBe(before);
    // a restart midway: the marker is gone but the per-recipient marks are not, so nobody is notified twice
    await PlatformNotification.update(
      { fanoutCompletedAt: null, recipientCount: null },
      { where: { id: d.id } },
    );
    expect(await runAnnouncementFanout(d.id)).toEqual({ recipients: 3 });
    expect((await listInbox()).length).toBe(before);
    const again = (await PlatformNotification.findByPk(d.id))!;
    expect(again.recipientCount).toBe(3);
    expect(again.fanoutCompletedAt!.getTime()).toBeGreaterThanOrEqual(stamp.getTime());
    const titles = (await listInbox()).filter(m => m.subject === 'Scheduled maintenance on Sunday');
    expect(titles).toHaveLength(3); // each of the three recipients once
  });

  it('a cancelled or resolved announcement stops the fan-out; without the EMAIL channel nobody is mailed but the count is set', async () => {
    const { admin } = await world();
    const d = (await create(admin.c, { channels: ['EMAIL'] })).body.data;
    await queueInspector().pause(PLATFORM_OPS_QUEUE); // the fan-out job waits while the incident resolves the banner
    await admin.c('post', `/platform/announcements/${d.id}/publish`, { version: 1 });
    await PlatformNotification.update({ status: 'EXPIRED' }, { where: { id: d.id } });
    await queueInspector().resume(PLATFORM_OPS_QUEUE);
    await drainQueues();
    expect((await PlatformNotification.findByPk(d.id))!.fanoutCompletedAt).toBeNull();
    expect((await listInbox()).filter(m => m.subject === 'Scheduled maintenance on Sunday')).toHaveLength(0);
    const e = (await create(admin.c, { title: 'Banner only notice' })).body.data;
    await admin.c('post', `/platform/announcements/${e.id}/publish`, { version: 1 });
    await drainQueues();
    expect((await PlatformNotification.findByPk(e.id))!.recipientCount).toBe(2);
    expect((await listInbox()).filter(m => m.subject === 'Banner only notice')).toHaveLength(0);
  });

  it('createAnnouncement (section 8.13) validates like the route and can publish at once', async () => {
    await world();
    const input = {
      title: 'Plan change notice',
      body: 'The Standard plan price changes next month.',
      kind: 'BILLING' as const,
      severity: 'INFO' as const,
      audienceType: 'ALL' as const,
      audiencePlanKeys: null,
      audienceSocietyStatuses: null,
      audienceSocietyIds: null,
      audienceRoleKeys: ['chairman'],
      channels: [],
      publishAt: null,
      expiresAt: new Date('2026-11-20T00:00:00Z'),
      isDismissible: true,
      ctaLabel: null,
      ctaUrl: null,
    };
    const r = await createAnnouncement(systemCtx('kill-switch'), input, { publish: true });
    expect((await PlatformNotification.findByPk(r.id))!).toMatchObject({
      status: 'PUBLISHED',
      createdBy: null,
    });
    await expect(
      createAnnouncement(
        systemCtx('x'),
        { ...input, ctaLabel: 'Open', ctaUrl: 'http://x.example.com' },
        { publish: false },
      ),
    ).rejects.toMatchObject({ code: 'CTA_URL_NOT_ALLOWED' });
    await expect(
      createAnnouncement(systemCtx('x'), { ...input, audienceRoleKeys: ['auditor'] }, { publish: true }),
    ).rejects.toMatchObject({ code: 'AUDIENCE_EMPTY' });
  });
});
