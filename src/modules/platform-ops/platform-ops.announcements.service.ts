import { Op, type Transaction, type WhereOptions } from 'sequelize';
import { Plan, PlatformNotification, Society, sequelize } from '../../models';
import type { Incident } from '../../models/incident.model';
import { addDays, addMinutes, now } from '../../lib/clock';
import { env } from '../../lib/env';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { enqueueAfterCommit } from '../../lib/queue';
import { notify } from '../../lib/notify';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import {
  AppError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
  type FieldError,
} from '../../utils/errors';
import { systemCtx, type Ctx } from '../../types/context';
import { AUDIT, ENTITY, JOBS, PLATFORM_OPS_QUEUE } from './platform-ops.types';
import {
  DEFAULT_INCIDENT_ROLES,
  audienceSocietyIds,
  countAudience,
  matchesAudience,
  recipientRows,
  type Audience,
} from './platform-ops.announcements.audience';
import { announcementNotFound, invalidState, staleVersion } from './platform-ops.shared';
import { emitAfterCommit } from './platform-ops.notify';

/**
 * Announcements (module 07 sections 6.3, 6.7, 8.7). Banner audience is matched live at read time; the fan-out snapshot
 * is taken at publish. Dismissals live in the key-value store set `pn:dismissed:<id>` (BR-07 7.6).
 */
export interface AnnouncementInput extends Audience {
  title: string;
  body: string;
  kind: PlatformNotification['kind'];
  severity: PlatformNotification['severity'];
  channels: string[];
  publishAt: Date | null;
  expiresAt: Date;
  isDismissible: boolean;
  ctaLabel: string | null;
  ctaUrl: string | null;
}

const DAY = 86_400_000;
const dismissedKey = (id: number) => `pn:dismissed:${id}`;
const sentKey = (id: number) => `pn:sent:${id}`;
const FAN_BATCH = 500;

export function announcementView(a: PlatformNotification) {
  return {
    id: a.id!,
    title: a.title,
    body: a.body,
    kind: a.kind,
    severity: a.severity,
    audienceType: a.audienceType,
    audiencePlanKeys: a.audiencePlanKeys,
    audienceSocietyStatuses: a.audienceSocietyStatuses,
    audienceSocietyIds: a.audienceSocietyIds,
    audienceRoleKeys: a.audienceRoleKeys,
    channels: a.channels,
    status: a.status,
    publishAt: a.publishAt,
    expiresAt: a.expiresAt,
    publishedAt: a.publishedAt,
    cancelledAt: a.cancelledAt,
    cancelReason: a.cancelReason,
    isDismissible: a.isDismissible,
    ctaLabel: a.ctaLabel,
    ctaUrl: a.ctaUrl,
    incidentId: a.incidentId,
    recipientCount: a.recipientCount,
    fanoutCompletedAt: a.fanoutCompletedAt,
    version: a.version,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

// ------------------------------------------------------------------ validation (BR-07-37, BR-07-39)
const appHosts = (): Set<string> => {
  const hosts = new Set(env().appOrigins.map(o => new URL(o).host));
  hosts.add(new URL(env().STATUS_PAGE_ORIGIN ?? 'https://status.societyapp.in').host);
  return hosts;
};

function checkCta(url: string | null): void {
  if (!url) return;
  let u: URL | undefined;
  try {
    u = new URL(url);
  } catch {
    u = undefined;
  }
  if (!u || u.protocol !== 'https:' || !appHosts().has(u.host))
    throw new AppError(
      400,
      'CTA_URL_NOT_ALLOWED',
      'The link must be https and point to a SocietyApp address',
      [{ field: 'ctaUrl', message: 'Not an allowed address' }],
    );
}

/** Dates against now (create, edit and publish share the ranges; `publishWindow` turns them into 422 at publish). */
function checkDates(i: Pick<AnnouncementInput, 'publishAt' | 'expiresAt'>): void {
  const at = now();
  const errors: FieldError[] = [];
  if (i.publishAt) {
    if (i.publishAt < addMinutes(at, 1))
      errors.push({ field: 'publishAt', message: 'Must be at least 1 minute in the future' });
    else if (i.publishAt > addDays(at, 60))
      errors.push({ field: 'publishAt', message: 'Must be within 60 days' });
  }
  const start = i.publishAt ?? at;
  if (i.expiresAt <= start) errors.push({ field: 'expiresAt', message: 'Must be after the publish time' });
  else if (i.expiresAt.getTime() - start.getTime() > 90 * DAY)
    errors.push({ field: 'expiresAt', message: 'Must be within 90 days of the publish time' });
  if (errors.length) throw new ValidationError(errors);
}

async function checkReferences(i: AnnouncementInput): Promise<void> {
  if (
    i.channels.includes('WHATSAPP') &&
    !(i.severity === 'CRITICAL' || ['MAINTENANCE', 'INCIDENT'].includes(i.kind))
  )
    throw new UnprocessableError(
      'WHATSAPP_NOT_ALLOWED',
      'WhatsApp is only for critical, maintenance and incident announcements',
    );
  if (i.audienceType === 'PLANS') {
    const codes = (await Plan.findAll({ attributes: ['code'] })).map(p => p.code as string);
    const unknown = (i.audiencePlanKeys ?? []).filter(k => !codes.includes(k.toUpperCase()));
    if (unknown.length)
      throw new UnprocessableError(
        'UNKNOWN_PLAN_KEY',
        'A plan in the audience does not exist',
        unknown.map(k => ({ field: 'audiencePlanKeys', message: `Unknown plan ${k}` })),
      );
  }
  if (i.audienceType === 'SOCIETIES') {
    const ids = i.audienceSocietyIds ?? [];
    const found = new Set(
      (await Society.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id'] })).map(s => s.id!),
    );
    const missing = ids.filter(x => !found.has(x));
    if (missing.length) throw new NotFoundError('SOCIETY_NOT_FOUND', `Society ${missing[0]} does not exist`);
  }
}

/** Order of checks: link (400), channel and references (422, 404), then dates (400). */
export async function validateAnnouncement(i: AnnouncementInput): Promise<void> {
  checkCta(i.ctaUrl);
  await checkReferences(i);
  checkDates(i);
}

// ------------------------------------------------------------------ create, edit, preview
const dismissibleFor = (severity: string, want: boolean) => (severity === 'CRITICAL' ? false : want);

export interface CreateOptions {
  publish: boolean;
  t?: Transaction;
  incident?: Incident;
  /** Incident-generated banners go live even if no member matches (nobody to e-mail, but the banner is live). */
  skipAudienceCheck?: boolean;
}

/** Section 8.13 `createAnnouncement`: same validation as `POST /platform/announcements`, optionally published at once. */
export async function createAnnouncement(
  ctx: Ctx,
  input: AnnouncementInput,
  opts: CreateOptions,
): Promise<{ id: number }> {
  await validateAnnouncement(input);
  const run = async (t: Transaction) => {
    const row = await PlatformNotification.create(
      {
        ...input,
        audiencePlanKeys: input.audiencePlanKeys?.map(k => k.toUpperCase()) ?? null,
        isDismissible: dismissibleFor(input.severity, input.isDismissible),
        status: 'DRAFT',
        incidentId: opts.incident?.id ?? null,
        publishedAt: null,
        cancelledAt: null,
        cancelReason: null,
        recipientCount: null,
        fanoutCompletedAt: null,
        version: 1,
        createdBy: ctx.user?.id ?? null,
        updatedBy: null,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.announcementCreated,
        entityType: ENTITY.announcement,
        entityId: row.id!,
        entityLabel: row.title,
        after: { title: row.title, kind: row.kind, severity: row.severity, audienceType: row.audienceType },
      },
      t,
    );
    if (opts.publish) await publishRow(ctx, row, t, { skipAudienceCheck: opts.skipAudienceCheck });
    return row.id!;
  };
  const id = opts.t ? await run(opts.t) : await sequelize.transaction(run);
  return { id };
}

export async function listAnnouncements(q: {
  status?: string[];
  kind?: string;
  severity?: string;
  sortBy: 'createdAt' | 'publishAt';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}) {
  const where: Record<string, unknown> = {};
  if (q.status) where.status = { [Op.in]: q.status };
  if (q.kind) where.kind = q.kind;
  if (q.severity) where.severity = q.severity;
  const { rows, count } = await PlatformNotification.findAndCountAll({
    where: where as WhereOptions,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: rows.map(announcementView), pagination: pageMeta(q.page, q.limit, count) };
}

export async function getAnnouncement(id: number) {
  const a = await PlatformNotification.findByPk(id);
  if (!a) throw announcementNotFound();
  return announcementView(a);
}

export async function createDraft(ctx: Ctx, input: AnnouncementInput) {
  const { id } = await createAnnouncement(ctx, input, { publish: false });
  return getAnnouncement(id);
}

export async function previewAudience(a: Audience) {
  await checkReferences({ ...a, channels: [] } as unknown as AnnouncementInput);
  const c = await countAudience(a);
  return { societies: c.societies, recipients: c.recipients };
}

async function lockAnnouncement(id: number, t: Transaction): Promise<PlatformNotification> {
  const a = await PlatformNotification.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!a) throw announcementNotFound();
  return a;
}

export async function updateAnnouncement(
  ctx: Ctx,
  id: number,
  patch: Partial<AnnouncementInput> & { version: number },
) {
  const { version, ...fields } = patch;
  await sequelize.transaction(async t => {
    const a = await lockAnnouncement(id, t);
    if (a.version !== version) throw staleVersion('announcement');
    if (a.status !== 'DRAFT' && a.status !== 'SCHEDULED')
      throw invalidState('Only drafts and scheduled announcements can be edited');
    const merged: AnnouncementInput = {
      title: a.title,
      body: a.body,
      kind: a.kind,
      severity: a.severity,
      audienceType: a.audienceType,
      audiencePlanKeys: a.audiencePlanKeys,
      audienceSocietyStatuses: a.audienceSocietyStatuses,
      audienceSocietyIds: a.audienceSocietyIds,
      audienceRoleKeys: a.audienceRoleKeys,
      channels: a.channels,
      publishAt: a.publishAt,
      expiresAt: a.expiresAt,
      isDismissible: a.isDismissible,
      ctaLabel: a.ctaLabel,
      ctaUrl: a.ctaUrl,
      ...fields,
    };
    if (fields.audienceType) {
      // a new audience type replaces the lists of the old one
      merged.audiencePlanKeys = fields.audiencePlanKeys ?? null;
      merged.audienceSocietyStatuses = fields.audienceSocietyStatuses ?? null;
      merged.audienceSocietyIds = fields.audienceSocietyIds ?? null;
    }
    if (a.status === 'SCHEDULED' && !('publishAt' in fields) && merged.publishAt && merged.publishAt < now())
      merged.publishAt = null; // an unchanged past time is checked at publish, not here
    await validateAnnouncement(merged);
    const before = announcementView(a);
    await a.update(
      {
        ...merged,
        audiencePlanKeys: merged.audiencePlanKeys?.map(k => k.toUpperCase()) ?? null,
        isDismissible: dismissibleFor(merged.severity, merged.isDismissible),
        publishAt: a.status === 'SCHEDULED' && !('publishAt' in fields) ? a.publishAt : merged.publishAt,
        version: a.version + 1,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.announcementUpdated,
        entityType: ENTITY.announcement,
        entityId: a.id!,
        entityLabel: a.title,
        before: { title: before.title, expiresAt: before.expiresAt, status: before.status },
        after: { title: a.title, expiresAt: a.expiresAt, status: a.status, changed: Object.keys(fields) },
      },
      t,
    );
  });
  return getAnnouncement(id);
}

// ------------------------------------------------------------------ publish, cancel, delete
interface PublishOptions {
  skipAudienceCheck?: boolean;
  /** Scheduler publish: the stored `publishAt` is already due. */
  due?: boolean;
  actorCtx?: Ctx;
}

const publishWindowInvalid = () =>
  new UnprocessableError(
    'PUBLISH_WINDOW_INVALID',
    'The publish time or the expiry has already passed. Edit the dates and try again.',
  );

/** DRAFT to PUBLISHED or SCHEDULED inside the caller's transaction (table 6.3). */
async function publishRow(
  ctx: Ctx,
  a: PlatformNotification,
  t: Transaction,
  o: PublishOptions = {},
): Promise<void> {
  const at = now();
  if (a.expiresAt <= at) throw publishWindowInvalid();
  if (a.publishAt && a.publishAt < addMinutes(at, -1)) throw publishWindowInvalid();
  const c = await countAudience(a);
  if (c.recipients === 0 && !o.skipAudienceCheck)
    throw new UnprocessableError('AUDIENCE_EMPTY', 'No one matches this audience and these roles');
  const scheduled = a.publishAt !== null && a.publishAt > addMinutes(at, 1);
  await a.update(
    {
      status: scheduled ? 'SCHEDULED' : 'PUBLISHED',
      publishedAt: scheduled ? null : at,
      version: a.version + 1,
      updatedBy: ctx.user?.id ?? null,
    },
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: scheduled ? AUDIT.announcementScheduled : AUDIT.announcementPublished,
      entityType: ENTITY.announcement,
      entityId: a.id!,
      entityLabel: a.title,
      after: { status: a.status, recipients: c.recipients, societies: c.societies },
    },
    t,
  );
  if (!scheduled) afterPublish(t, a.id!, c.societyIds);
}

function afterPublish(t: Transaction, id: number, societyIds: number[]): void {
  enqueueAfterCommit(t, PLATFORM_OPS_QUEUE, JOBS.announcementFanout, { notificationId: id });
  emitAfterCommit(
    t,
    societyIds.map(s => ({
      room: `society:${s}:admin`,
      event: 'platform.announcement.published',
      payload: { id },
    })),
  );
}

export async function publishAnnouncement(ctx: Ctx, id: number, input: { version: number }) {
  await sequelize.transaction(async t => {
    const a = await lockAnnouncement(id, t);
    if (a.version !== input.version) throw staleVersion('announcement');
    if (a.status !== 'DRAFT') throw invalidState('Only a draft can be published');
    await publishRow(ctx, a, t);
  });
  return getAnnouncement(id);
}

export async function cancelAnnouncement(ctx: Ctx, id: number, input: { version: number; reason: string }) {
  await sequelize.transaction(async t => {
    const a = await lockAnnouncement(id, t);
    if (a.version !== input.version) throw staleVersion('announcement');
    if (a.status !== 'SCHEDULED' && a.status !== 'PUBLISHED')
      throw invalidState('Only scheduled or published announcements can be cancelled');
    const from = a.status;
    await a.update(
      {
        status: 'CANCELLED',
        cancelledAt: now(),
        cancelReason: input.reason,
        version: a.version + 1,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.announcementCancelled,
        entityType: ENTITY.announcement,
        entityId: a.id!,
        entityLabel: a.title,
        before: { status: from },
        after: { status: 'CANCELLED' },
        reason: input.reason,
      },
      t,
    );
  });
  return getAnnouncement(id);
}

export async function deleteAnnouncement(ctx: Ctx, id: number, input: { version: number }): Promise<void> {
  await sequelize.transaction(async t => {
    const a = await lockAnnouncement(id, t);
    if (a.version !== input.version) throw staleVersion('announcement');
    if (a.status !== 'DRAFT') throw invalidState('Only a draft can be deleted');
    await a.update({ updatedBy: ctx.user?.id ?? null }, { transaction: t });
    await a.destroy({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.announcementDeleted,
        entityType: ENTITY.announcement,
        entityId: a.id!,
        entityLabel: a.title,
        before: { status: 'DRAFT' },
      },
      t,
    );
  });
}

/** BR-07-36: the linked banner of a resolved incident expires at once. */
export async function expireIncidentAnnouncements(ctx: Ctx, incidentId: number, t: Transaction) {
  const rows = await PlatformNotification.findAll({
    where: { incidentId, status: { [Op.in]: ['PUBLISHED', 'SCHEDULED'] } },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  for (const a of rows) {
    await a.update({ status: 'EXPIRED', version: a.version + 1 }, { transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.announcementExpired,
        entityType: ENTITY.announcement,
        entityId: a.id!,
        entityLabel: a.title,
        before: { status: 'PUBLISHED' },
        after: { status: 'EXPIRED' },
        reason: 'Incident resolved',
      },
      t,
    );
  }
  return rows.length;
}

/** The linked banner a SEV1 or SEV2 public incident raises (BR-07-36). */
export async function createIncidentAnnouncement(ctx: Ctx, incident: Incident, t: Transaction, body: string) {
  const sev1 = incident.severity === 'SEV1';
  return createAnnouncement(
    ctx,
    {
      title: incident.title.slice(0, 120).padEnd(5, '.'),
      body: body.slice(0, 2000).padEnd(10, '.'),
      kind: 'INCIDENT',
      severity: sev1 ? 'CRITICAL' : 'WARNING',
      audienceType: 'ALL',
      audiencePlanKeys: null,
      audienceSocietyStatuses: null,
      audienceSocietyIds: null,
      audienceRoleKeys: DEFAULT_INCIDENT_ROLES,
      channels: [],
      publishAt: null,
      expiresAt: addDays(incident.startedAt, 7),
      isDismissible: !sev1,
      ctaLabel: null,
      ctaUrl: null,
    },
    { publish: true, t, incident, skipAudienceCheck: true },
  );
}

// ------------------------------------------------------------------ jobs (6.3, 6.7)
export interface SchedulerResult {
  published: number;
  cancelled: number;
  expired: number;
}

/** `platform-ops:announcement-scheduler` (every minute): due SCHEDULED rows go live; expired PUBLISHED rows expire. */
export async function runAnnouncementScheduler(): Promise<SchedulerResult> {
  const r: SchedulerResult = { published: 0, cancelled: 0, expired: 0 };
  const sys = systemCtx('job');
  const at = now();
  const due = await PlatformNotification.findAll({
    where: { status: 'SCHEDULED', publishAt: { [Op.lte]: at } },
    attributes: ['id'],
    order: [['id', 'ASC']],
    limit: 200,
  });
  for (const d of due)
    await sequelize.transaction(async t => {
      const a = await lockAnnouncement(d.id!, t);
      if (a.status !== 'SCHEDULED') return; // conditional on status: another worker was first
      const c = await countAudience(a);
      if (a.expiresAt <= at) {
        await a.update({ status: 'EXPIRED', version: a.version + 1 }, { transaction: t });
        await audit(
          sys,
          {
            action: AUDIT.announcementExpired,
            entityType: ENTITY.announcement,
            entityId: a.id!,
            entityLabel: a.title,
          },
          t,
        );
        r.expired += 1;
      } else if (c.recipients === 0) {
        await a.update(
          {
            status: 'CANCELLED',
            cancelledAt: at,
            cancelReason: 'Audience empty at publish time',
            version: a.version + 1,
          },
          { transaction: t },
        );
        await audit(
          sys,
          {
            action: AUDIT.announcementCancelled,
            entityType: ENTITY.announcement,
            entityId: a.id!,
            entityLabel: a.title,
            before: { status: 'SCHEDULED' },
            after: { status: 'CANCELLED' },
            reason: 'Audience empty at publish time',
          },
          t,
        );
        r.cancelled += 1;
      } else {
        await a.update({ status: 'PUBLISHED', publishedAt: at, version: a.version + 1 }, { transaction: t });
        await audit(
          sys,
          {
            action: AUDIT.announcementPublished,
            entityType: ENTITY.announcement,
            entityId: a.id!,
            entityLabel: a.title,
            after: { status: 'PUBLISHED', recipients: c.recipients, societies: c.societies },
          },
          t,
        );
        afterPublish(t, a.id!, c.societyIds);
        r.published += 1;
      }
    });
  const old = await PlatformNotification.findAll({
    where: { status: 'PUBLISHED', expiresAt: { [Op.lte]: at } },
    attributes: ['id'],
    order: [['id', 'ASC']],
    limit: 200,
  });
  for (const o of old)
    await sequelize.transaction(async t => {
      const a = await lockAnnouncement(o.id!, t);
      if (a.status !== 'PUBLISHED' || a.expiresAt > at) return;
      await a.update({ status: 'EXPIRED', version: a.version + 1 }, { transaction: t });
      await audit(
        sys,
        {
          action: AUDIT.announcementExpired,
          entityType: ENTITY.announcement,
          entityId: a.id!,
          entityLabel: a.title,
          before: { status: 'PUBLISHED' },
          after: { status: 'EXPIRED' },
        },
        t,
      );
      r.expired += 1;
    });
  return r;
}

/**
 * `platform-ops:announcement-fanout` (6.7): pages through the recipients 500 at a time, checks the status before each batch
 * (a resolved incident or a cancel stops it) and sends once per user (`pn:sent:<id>` replaces module 16's `dedupeKey`).
 * `fanoutCompletedAt` makes a second run do nothing.
 */
export async function runAnnouncementFanout(notificationId: number): Promise<{ recipients: number } | null> {
  let a = await PlatformNotification.findByPk(notificationId);
  if (!a || a.fanoutCompletedAt || a.status !== 'PUBLISHED') return null;
  const societyIds = await audienceSocietyIds(a);
  const emailOn = a.channels.includes('EMAIL');
  const seen = new Set<number>();
  let after: { societyId: number; memberId: number } | null = null;
  const ttl = Math.max(86_400, Math.ceil((a.expiresAt.getTime() - now().getTime()) / 1000) + 7 * 86_400);
  for (;;) {
    a = (await PlatformNotification.findByPk(notificationId))!;
    if (!a || a.status !== 'PUBLISHED') return null; // stopped: cancelled or expired
    const page = await recipientRows(societyIds, a.audienceRoleKeys, after, FAN_BATCH);
    const fresh: number[] = [];
    for (const row of page) {
      if (seen.has(row.userId)) continue;
      seen.add(row.userId);
      if (!(await kv().setHas(sentKey(notificationId), String(row.userId)))) fresh.push(row.userId);
    }
    if (fresh.length && emailOn)
      await notify(
        'platform.announcement',
        fresh.map(userId => ({ userId })),
        {
          notificationId,
          title: a.title,
          body: a.body,
          ctaLabel: a.ctaLabel,
          ctaUrl: a.ctaUrl,
        },
        { channels: ['EMAIL'] },
      );
    for (const u of fresh) await kv().setAdd(sentKey(notificationId), String(u), ttl);
    if (page.length < FAN_BATCH) break;
    const last = page[page.length - 1]!;
    after = { societyId: last.societyId, memberId: last.memberId };
  }
  const [claimed] = await PlatformNotification.update(
    { recipientCount: seen.size, fanoutCompletedAt: now() },
    { where: { id: notificationId, fanoutCompletedAt: null, status: 'PUBLISHED' } },
  );
  if (claimed === 0) logger.info({ notificationId }, 'announcement fan-out finished elsewhere');
  return { recipients: seen.size };
}

// ------------------------------------------------------------------ society side (8.7)
const bannerView = (a: PlatformNotification) => ({
  id: a.id!,
  title: a.title,
  body: a.body,
  kind: a.kind,
  severity: a.severity,
  isDismissible: a.isDismissible,
  ctaLabel: a.ctaLabel,
  ctaUrl: a.ctaUrl,
  publishedAt: a.publishedAt,
  expiresAt: a.expiresAt,
});

async function visibleFor(ctx: Ctx): Promise<PlatformNotification[]> {
  const society = ctx.society!;
  const rows = await PlatformNotification.findAll({
    where: { status: 'PUBLISHED', expiresAt: { [Op.gt]: now() } },
    order: [['publishedAt', 'DESC']],
  });
  return rows.filter(
    a =>
      matchesAudience(a, society) && (!ctx.membership || a.audienceRoleKeys.includes(ctx.membership.roleKey)),
  );
}

/** `GET /platform-announcements`: CRITICAL first, then newest, at most 5, minus the ones this user dismissed. */
export async function bannersForMe(ctx: Ctx) {
  const visible = await visibleFor(ctx);
  const out: PlatformNotification[] = [];
  for (const a of visible) {
    let dismissed = false;
    try {
      dismissed = await kv().setHas(dismissedKey(a.id!), String(ctx.user!.id));
    } catch (err) {
      logger.warn({ err }, 'dismissal store unavailable');
    }
    if (!dismissed) out.push(a);
  }
  out.sort(
    (x, y) =>
      Number(y.severity === 'CRITICAL') - Number(x.severity === 'CRITICAL') ||
      (y.publishedAt?.getTime() ?? 0) - (x.publishedAt?.getTime() ?? 0),
  );
  return { items: out.slice(0, 5).map(bannerView) };
}

export async function dismissBanner(ctx: Ctx, id: number): Promise<void> {
  const a = (await visibleFor(ctx)).find(x => x.id === id);
  if (!a) throw announcementNotFound();
  if (!a.isDismissible) throw new UnprocessableError('NOT_DISMISSIBLE', 'This notice cannot be dismissed');
  const ttl = Math.ceil((a.expiresAt.getTime() - now().getTime()) / 1000) + 7 * 86_400;
  await kv().setAdd(dismissedKey(id), String(ctx.user!.id), Math.max(ttl, 60));
}
