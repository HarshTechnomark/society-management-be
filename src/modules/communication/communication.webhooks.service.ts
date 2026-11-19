import { Op, fn, col, where as sqlWhere } from 'sequelize';
import {
  EmergencyBroadcast,
  Notice,
  NoticeReceipt,
  Notification,
  ServiceProvider,
  User,
  sequelize,
} from '../../models';
import {
  buildProviderAdapter,
  type MessagingWebhookEvent,
  type ProviderAdapter,
} from '../../adapters/provider-adapter';
import { env } from '../../lib/env';
import { now } from '../../lib/clock';
import { enqueue } from '../../lib/queue';
import { emitToRoom } from '../../lib/realtime';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, NotFoundError } from '../../utils/errors';
import { credentialsOf } from '../platform-ops/platform-ops.providers.registry';
import { AUDIT, COMMUNICATION_QUEUE, ENTITY, ERR, JOBS, RT } from './communication.constants';
import { getOrCreatePreferences } from './communication.prefs';
import { resolveAudience } from './communication.audience';
import { SYSTEM_ACTOR, jobCtx, jobHooks } from './communication.jobs.common';
import type { NoticeAudience } from './communication.types';

/** 8.37 messaging webhooks: signature by the provider's adapter, then `communication:process-webhook` applies the events (6.2 forward-only status, STOP, button replies, bounces). */

interface Resolved {
  adapter: ProviderAdapter;
  credentials: Record<string, string> | null;
}

/** Provider of module 07 by key (`fake` always exists while PROVIDERS_MODE is fake); null when unknown. */
export async function providerByKey(providerKey: string): Promise<Resolved | null> {
  const row = await ServiceProvider.scope('withSecrets').findOne({ where: { providerKey } });
  if (row) {
    const credentials = credentialsOf(row);
    return {
      credentials,
      adapter: buildProviderAdapter({
        channel: row.channel,
        vendor: row.vendor,
        config: row.configJson,
        credentials,
      }),
    };
  }
  if (providerKey === 'fake' && env().PROVIDERS_MODE === 'fake')
    return {
      credentials: null,
      adapter: buildProviderAdapter({ channel: 'SMS', vendor: 'FAKE', config: {}, credentials: null }),
    };
  return null;
}

/** The HTTP side: verify, parse, enqueue, answer. Nothing else runs inside the request. */
export async function receiveWebhook(
  providerKey: string,
  rawBody: Buffer | undefined,
  headers: Record<string, string | undefined>,
): Promise<{ received: true; events: number }> {
  const p = await providerByKey(providerKey);
  if (!p) throw new NotFoundError(ERR.notFound, 'Unknown provider');
  if (!rawBody || !p.adapter.verifyWebhook(rawBody, headers, p.credentials)) {
    logger.warn({ providerKey }, 'messaging webhook signature invalid');
    throw new AppError(401, ERR.webhookSignatureInvalid, 'The webhook signature is not valid');
  }
  let events: MessagingWebhookEvent[];
  try {
    events = p.adapter.parseWebhook(rawBody);
  } catch {
    throw new AppError(400, ERR.validation, 'The webhook body could not be read');
  }
  if (events.length)
    await enqueue(COMMUNICATION_QUEUE, JOBS.processWebhook, {
      providerKey,
      events: events as unknown as Record<string, unknown>[],
    });
  return { received: true, events: events.length };
}

// ------------------------------------------------------------------ processing
const RANK: Record<string, number> = { SENT: 1, DELIVERED: 2, READ: 3 };
const lastEmit = new Map<number, number>();
export const resetWebhookThrottle = (): void => lastEmit.clear();

function emitNoticeThrottled(n: Notice): void {
  const t = now().getTime();
  if (t - (lastEmit.get(n.id) ?? 0) < 3000) return;
  lastEmit.set(n.id, t);
  emitToRoom(`society:${n.societyId}:admin`, RT.noticeUpdated, {
    noticeId: n.id,
    status: n.status,
    readCount: n.readCount,
    ackCount: n.ackCount,
    reachedCount: n.reachedCount,
  });
}

/** Status moves only forward: SENT -> DELIVERED -> READ, FAILED only from SENT. Returns true when the row changed. */
export async function applyStatusEvent(
  providerKey: string,
  e: Extract<MessagingWebhookEvent, { status: string }>,
): Promise<boolean> {
  const row = await Notification.findOne({ where: { providerMessageId: e.providerMessageId, providerKey } });
  if (!row) return false;
  const at = new Date(e.at);
  const when = Number.isNaN(at.getTime()) ? now() : at;
  let affected = 0;
  if (e.status === 'DELIVERED') {
    [affected] = await Notification.update(
      { status: 'DELIVERED', deliveredAt: when },
      { where: { id: row.id, status: 'SENT' } },
    );
  } else if (e.status === 'READ') {
    [affected] = await Notification.update(
      { status: 'READ', readAt: when, deliveredAt: row.deliveredAt ?? when },
      { where: { id: row.id, status: { [Op.in]: ['SENT', 'DELIVERED'] } } },
    );
  } else if (e.status === 'FAILED') {
    [affected] = await Notification.update(
      { status: 'FAILED', failedAt: when, lastErrorCode: (e.errorCode ?? 'PROVIDER_REPORTED').slice(0, 60) },
      { where: { id: row.id, status: 'SENT' } },
    );
  }
  if (!affected) return false;
  if ((RANK[e.status] ?? 0) >= RANK.DELIVERED! && row.sourceType === ENTITY.notice && row.sourceId)
    await markReached(row, when);
  return true;
}

/** `DELIVERED` of a notice delivery sets the receipt's `reachedAt` / `reachedVia` when NULL and counts it. */
async function markReached(row: Notification, at: Date): Promise<void> {
  const noticeId = row.sourceId!;
  const match: Record<string, unknown>[] = [{ recipientKey: row.recipientKey }];
  if (row.userId) match.push({ userId: row.userId });
  const [n] = await NoticeReceipt.update(
    { reachedAt: at, reachedVia: row.channel as never },
    { where: { noticeId, reachedAt: null, [Op.or]: match as never } },
  );
  if (!n) return;
  await Notice.update(
    { reachedCount: sequelize.literal(`reachedCount + ${n}`) as never },
    { where: { id: noticeId } },
  );
  const notice = await Notice.findByPk(noticeId);
  if (notice) emitNoticeThrottled(notice);
}

const usersByMobileHash = (hash: string) =>
  User.findAll({ where: sqlWhere(fn('SHA2', col('mobile'), 256), hash.toLowerCase()), attributes: ['id'] });
const usersByEmailHash = (hash: string) =>
  User.findAll({
    where: sqlWhere(fn('SHA2', fn('LOWER', col('email')), 256), hash.toLowerCase()),
    attributes: ['id'],
  });

/** STOP: every user with that mobile is opted out of WhatsApp. Idempotent (already opted-out users are untouched and not audited again). */
async function applyStop(mobileHash: string): Promise<number> {
  let changed = 0;
  for (const u of await usersByMobileHash(mobileHash)) {
    const prefs = await getOrCreatePreferences(u.id!);
    if (!prefs.whatsappOptIn && prefs.whatsappOptOutAt) continue;
    await sequelize.transaction(async t => {
      await prefs.update({ whatsappOptIn: false, whatsappOptOutAt: now() }, { transaction: t });
      await audit(
        jobCtx(0),
        {
          action: AUDIT.whatsappOptedOut,
          entityType: ENTITY.preferences,
          entityId: prefs.id!,
          actor: SYSTEM_ACTOR,
          after: { userId: u.id },
        },
        t,
      );
    });
    changed += 1;
  }
  return changed;
}

async function applyBounce(kind: 'HARD' | 'COMPLAINT', emailHash: string): Promise<number> {
  let changed = 0;
  for (const u of await usersByEmailHash(emailHash)) {
    const prefs = await getOrCreatePreferences(u.id!);
    if (prefs.emailBouncedAt) continue;
    await prefs.update({ emailBouncedAt: now() });
    changed += 1;
  }
  logger.info({ kind, changed }, 'e-mail bounce applied');
  return changed;
}

/**
 * BUTTON `EMG:<broadcastId>:SAFE|HELP`: a response (channel WHATSAPP) is recorded when exactly one audience flat of that user matches; otherwise it is logged and ignored.
 * The response itself is written by the emergency service of 16.3 (hook `recordEmergencyResponse`).
 */
async function applyButton(payload: string, mobileHash: string): Promise<boolean> {
  const m = /^EMG:(\d+):(SAFE|HELP)$/.exec(payload);
  if (!m) return false;
  const broadcast = await EmergencyBroadcast.findByPk(Number(m[1]));
  if (!broadcast || broadcast.status !== 'ACTIVE') return false;
  const audience: NoticeAudience = {
    type: broadcast.audienceType === 'BUILDINGS' ? 'BUILDINGS' : 'ALL',
    ids: broadcast.audienceBuildingIds ?? undefined,
  };
  const resolved = await resolveAudience(broadcast.societyId, audience);
  for (const u of await usersByMobileHash(mobileHash)) {
    const units = [
      ...new Set(resolved.people.filter(p => p.userId === u.id && p.unitId).map(p => p.unitId!)),
    ];
    if (units.length !== 1) {
      logger.info(
        { broadcastId: broadcast.id, flats: units.length },
        'emergency button reply ignored: no single flat',
      );
      continue;
    }
    if (!jobHooks.recordEmergencyResponse) {
      logger.warn(
        { broadcastId: broadcast.id },
        'emergency button reply ignored: no response handler registered',
      );
      return false;
    }
    await jobHooks.recordEmergencyResponse({
      societyId: broadcast.societyId,
      broadcastId: broadcast.id,
      userId: u.id!,
      unitId: units[0]!,
      status: m[2] === 'SAFE' ? 'SAFE' : 'NEED_HELP',
      channel: 'WHATSAPP',
    });
    return true;
  }
  return false;
}

/** `communication:process-webhook`. Each event is independent: one bad event never blocks the rest. */
export async function runProcessWebhook(
  data: Record<string, unknown>,
): Promise<{ applied: number; ignored: number }> {
  const providerKey = String(data.providerKey ?? '');
  const events = (Array.isArray(data.events) ? data.events : []) as MessagingWebhookEvent[];
  let applied = 0;
  let ignored = 0;
  for (const e of events) {
    try {
      let did: boolean | number;
      if ('status' in e) did = await applyStatusEvent(providerKey, e);
      else if ('inbound' in e && e.inbound === 'STOP') did = await applyStop(e.mobileHash);
      else if ('inbound' in e && e.inbound === 'BUTTON') did = await applyButton(e.payload, e.mobileHash);
      else if ('bounce' in e) did = await applyBounce(e.bounce, e.emailHash);
      else did = false;
      if (did) applied += 1;
      else ignored += 1;
    } catch (err) {
      ignored += 1;
      logger.error({ err, providerKey }, 'webhook event failed');
    }
  }
  return { applied, ignored };
}
