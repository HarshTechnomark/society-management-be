import { Op } from 'sequelize';
import { adapters } from '../../adapters';
import { now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { enqueue } from '../../lib/queue';
import { Notification, PushSubscription, Society, User, sequelize } from '../../models';
import { systemCtx } from '../../types/context';
import { AppError } from '../../utils/errors';
import { entitlements } from '../subscriptions/subscriptions.public';
import {
  COMMUNICATION_QUEUE,
  JOBS,
  LIMIT,
  LIMITS,
  type Channel,
  type ExternalChannel,
} from './communication.constants';
import { decrypt, decryptJson } from './communication.crypto';
import { deliveryMode } from './communication.mode';
import { communicationPorts } from './communication.ports';
import { failureFallback, fallbackChannel, retryPolicy, suppressedBySociety } from './communication.route';
import { getTemplate, renderTemplate } from './communication.templates';

/**
 * 6.5 step 7 and 6.2: `deliverNotification(id)` locks one delivery row, re-checks the society, consumes the limit on the first attempt (BR-16-24), resolves the
 * provider (BR-16-28), renders, sends through the module 01 adapters (SMS, WhatsApp, e-mail) or the push port, and moves the row to SENT, back to QUEUED with the
 * next retry time (BR-16-27), or to FAILED with a fallback row. The production queue runs it as job `communication:deliver`; development and tests call it inline.
 */
export type DeliverOutcome =
  'SENT' | 'RETRY' | 'FAILED' | 'CANCELLED' | 'SKIPPED' | 'NOT_DUE' | 'NOT_FOUND' | 'NOT_PENDING';

export interface RowPayload {
  data: Record<string, unknown>;
  deepLink: string | null;
  subId?: number;
  /** Mobile or e-mail the caller supplied (also stored as `destinationEnc`). */
  channelOverride?: string;
}

/** A provider answer that must not be retried (invalid number, template rejected, push 404 / 410). */
export class PermanentSendError extends Error {
  readonly permanent = true;
}
const isPermanent = (e: unknown): boolean =>
  Boolean((e as { permanent?: boolean })?.permanent) ||
  (e instanceof AppError && e.status < 500 && e.status !== 429);

export const dedupeSafe = (s: string) => (s.length > 120 ? s.slice(0, 120) : s);

export async function enqueueDeliver(
  id: number,
  attempt: number,
  at: Date | null,
  urgent: boolean,
): Promise<void> {
  const delayMs = at ? Math.max(0, at.getTime() - now().getTime()) : 0;
  try {
    await enqueue(
      COMMUNICATION_QUEUE,
      JOBS.deliver,
      { id, attempt, priority: urgent ? 1 : 5 },
      { jobId: `ntf:${id}:${attempt}`, delayMs },
    );
  } catch (err) {
    logger.error({ err, id }, 'communication: could not enqueue deliver job');
  }
}

/** Creates the fallback row after a final failure or a refused limit; returns its id (it is delivered by the caller). */
async function makeFallback(from: Notification, channel: ExternalChannel): Promise<Notification | null> {
  try {
    return await Notification.create({
      societyId: from.societyId,
      batchId: from.batchId,
      templateKey: from.templateKey,
      locale: from.locale,
      deliveryClass: from.deliveryClass,
      channel,
      userId: from.userId,
      recipientKey: from.recipientKey,
      destinationMasked: from.destinationMasked,
      destinationEnc: from.destinationEnc,
      status: 'QUEUED',
      skipReason: null,
      dedupeKey: from.dedupeKey,
      attempts: 0,
      maxAttempts: from.maxAttempts,
      nextAttemptAt: now(),
      limitBypassed: false,
      fallbackFromId: from.id,
      dataEnc: from.dataEnc,
      sourceType: from.sourceType,
      sourceId: from.sourceId,
    } as never);
  } catch {
    return null; // a row for that channel already exists (unique key): nothing to fall back to
  }
}
async function siblingChannels(from: Notification): Promise<Set<ExternalChannel>> {
  const rows = await Notification.findAll({
    where: { batchId: from.batchId, recipientKey: from.recipientKey },
    attributes: ['channel'],
  });
  return new Set(rows.map(r => r.channel));
}

/** Delivers one row. Idempotent: a row that is not QUEUED / DEFERRED or not due is left alone (6.2). */
export async function deliverNotification(id: number): Promise<DeliverOutcome> {
  type Locked = { row: Notification; bypass: boolean } | DeliverOutcome;
  const locked: Locked = await sequelize.transaction(async t => {
    const row = await Notification.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row) return 'NOT_FOUND';
    if (row.status !== 'QUEUED' && row.status !== 'DEFERRED') return 'NOT_PENDING';
    if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now().getTime()) return 'NOT_DUE';
    let loaded;
    try {
      loaded = await getTemplate(row.templateKey, row.locale);
    } catch {
      row.status = 'CANCELLED';
      row.lastErrorCode = 'TEMPLATE_GONE';
      await row.save({ transaction: t });
      return 'CANCELLED';
    }
    if (row.societyId) {
      const s = await Society.findByPk(row.societyId, { attributes: ['id', 'status'], transaction: t });
      if (
        s &&
        suppressedBySociety(s.status, row.deliveryClass, loaded.meta.sendWhenClosed) &&
        !loaded.legacy
      ) {
        row.status = 'CANCELLED';
        row.lastErrorCode = `SOCIETY_${s.status}`;
        await row.save({ transaction: t });
        return 'CANCELLED';
      }
    }
    if (row.userId) {
      const u = await User.findByPk(row.userId, {
        attributes: ['id', 'anonymisedAt', 'status'],
        transaction: t,
      });
      if (!u || u.anonymisedAt) {
        row.status = 'CANCELLED';
        row.lastErrorCode = 'USER_GONE';
        await row.save({ transaction: t });
        return 'CANCELLED';
      }
    }
    let bypass = false;
    const limitKey = row.channel === 'SMS' ? LIMIT.sms : row.channel === 'WHATSAPP' ? LIMIT.whatsapp : null;
    if (limitKey && row.societyId && loaded.meta.countsTowardLimit && !row.limitConsumedAt) {
      try {
        await entitlements.consumeLimit(systemCtx(), limitKey, 1, {
          transaction: t,
          societyId: row.societyId,
        });
        row.limitKey = limitKey;
        row.limitConsumedAt = now();
      } catch (err) {
        if (!(err instanceof AppError) || err.status !== 402) throw err;
        if (row.deliveryClass === 'SAFETY') {
          bypass = true;
          row.limitKey = limitKey;
          row.limitBypassed = true;
        } else {
          row.status = 'SKIPPED';
          row.skipReason = 'LIMIT_REACHED';
          await row.save({ transaction: t });
          return 'SKIPPED';
        }
      }
    }
    row.status = 'SENDING';
    row.attempts += 1;
    await row.save({ transaction: t });
    return { row, bypass };
  });
  if (typeof locked === 'string') {
    if (locked === 'SKIPPED') await afterLimitSkip(id);
    return locked;
  }
  return sendAndSettle(locked.row);
}

/** BR-16-24: a row over the limit is SKIPPED LIMIT_REACHED and falls back WhatsApp -> SMS -> push. */
async function afterLimitSkip(id: number): Promise<void> {
  const row = await Notification.findByPk(id);
  if (!row) return;
  const loaded = await getTemplate(row.templateKey, row.locale).catch(() => null);
  if (!loaded) return;
  const next = fallbackChannel(await siblingChannels(row), loaded.meta.allowedChannels);
  if (!next) return;
  const fb = await makeFallback(row, next);
  if (fb) await dispatchFallback(fb, loaded.meta.deliveryClass === 'SAFETY');
}

async function dispatchFallback(fb: Notification, urgent: boolean): Promise<void> {
  if (deliveryMode() === 'queue') await enqueueDeliver(fb.id, 1, null, urgent);
  else await deliverNotification(fb.id);
}

interface Contact {
  mobile: string | null;
  email: string | null;
}
async function contactOf(row: Notification): Promise<Contact> {
  if (row.destinationEnc) {
    const v = decrypt(row.destinationEnc);
    return row.channel === 'EMAIL' ? { mobile: null, email: v } : { mobile: v, email: null };
  }
  if (!row.userId) return { mobile: null, email: null };
  const u = await User.findByPk(row.userId, { attributes: ['mobile', 'email'] });
  return { mobile: u?.mobile ?? null, email: u?.email ?? null };
}

async function sendOne(
  row: Notification,
): Promise<{ providerKey: string | null; providerMessageId: string | null }> {
  const payload = decryptJson<RowPayload>(
    row.dataEnc ??
      (() => {
        throw new PermanentSendError('DATA_MISSING');
      })(),
  );
  const loaded = await getTemplate(row.templateKey, row.locale);
  const tz = row.societyId
    ? (await Society.findByPk(row.societyId, { attributes: ['timezone'] }))?.timezone
    : undefined;
  const msg = renderTemplate(loaded, payload.data, { tz });
  const provider = await communicationPorts().providers.resolve(row.channel as Channel);
  if (!provider) throw new PermanentSendError('NO_PROVIDER');
  const a = adapters();
  const c = await contactOf(row);
  switch (row.channel) {
    case 'SMS': {
      if (!c.mobile || !msg.sms) throw new PermanentSendError('NO_CONTACT');
      const r = await a.sms.send(c.mobile, row.templateKey, msg.sms);
      return { providerKey: provider.providerKey, providerMessageId: r.providerId };
    }
    case 'WHATSAPP': {
      if (!c.mobile || !msg.whatsapp) throw new PermanentSendError('NO_CONTACT');
      const r = await a.whatsapp.sendTemplate(
        c.mobile,
        loaded.legacy ? row.templateKey : msg.whatsapp.name,
        row.locale,
        msg.whatsapp.params,
        msg.whatsapp.buttonSuffix ? [{ url: msg.whatsapp.buttonSuffix }] : undefined,
      );
      return { providerKey: provider.providerKey, providerMessageId: r.providerId };
    }
    case 'EMAIL': {
      if (!c.email || !msg.email) throw new PermanentSendError('NO_CONTACT');
      const r = await a.email.send(c.email, msg.email.subject, msg.email.html, msg.email.text);
      return { providerKey: provider.providerKey, providerMessageId: r.providerId };
    }
    case 'PUSH': {
      if (!row.userId || !msg.push) throw new PermanentSendError('NO_CONTACT');
      const subs = await PushSubscription.findAll({
        where: { userId: row.userId, status: 'ACTIVE', ...(payload.subId ? { id: payload.subId } : {}) },
      });
      if (!subs.length) throw new PermanentSendError('NO_SUBSCRIPTION');
      const safety = row.deliveryClass === 'SAFETY';
      let ok: string | null = null;
      let lastErr = 'PUSH_FAILED';
      for (const s of subs) {
        const res = await communicationPorts().push.send(
          { id: s.id, endpoint: s.endpoint, p256dh: s.p256dh, authSecret: decrypt(s.authSecretEnc) },
          {
            title: msg.push.title,
            body: msg.push.body,
            url: msg.deepLink,
            tag: row.templateKey,
            requireInteraction: safety,
          },
          { urgency: safety ? 'high' : 'normal', ttlSeconds: safety ? 600 : 86_400 },
          row.userId,
        );
        if (res.ok) {
          ok = res.providerMessageId;
          s.consecutiveFailures = 0;
          s.lastSuccessAt = now();
          await s.save();
        } else {
          lastErr = res.error;
          s.consecutiveFailures += 1;
          s.lastFailureAt = now();
          if (res.gone) {
            s.status = 'REVOKED';
            s.revokedReason = 'GONE';
            s.revokedAt = now();
          } else if (s.consecutiveFailures >= LIMITS.pushFailuresRevoke) {
            s.status = 'REVOKED';
            s.revokedReason = 'FAILURES';
            s.revokedAt = now();
          }
          await s.save();
        }
      }
      if (!ok) throw new Error(lastErr);
      return { providerKey: provider.providerKey, providerMessageId: ok };
    }
  }
}

async function sendAndSettle(row: Notification): Promise<DeliverOutcome> {
  try {
    const r = await sendOne(row);
    await Notification.update(
      {
        status: 'SENT',
        sentAt: now(),
        providerKey: r.providerKey,
        providerMessageId: r.providerMessageId,
        lastErrorCode: null,
        lastErrorMessage: null,
        nextAttemptAt: null,
      },
      { where: { id: row.id } },
    );
    return 'SENT';
  } catch (err) {
    const permanent = isPermanent(err);
    const policy = retryPolicy(row.deliveryClass);
    const code = String((err as { code?: unknown })?.code ?? (err as Error)?.message ?? 'SEND_FAILED').slice(
      0,
      60,
    );
    // never log rendered text (BR-16-31): only ids and the error code
    logger.warn(
      { id: row.id, channel: row.channel, code, permanent },
      'communication: delivery attempt failed',
    );
    if (!permanent && row.attempts < Math.min(row.maxAttempts, policy.maxAttempts)) {
      const delay = policy.delaysSec[Math.min(row.attempts - 1, policy.delaysSec.length - 1)]! * 1000;
      const next = new Date(now().getTime() + delay);
      await Notification.update(
        { status: 'QUEUED', nextAttemptAt: next, lastErrorCode: code, lastErrorMessage: 'temporary error' },
        { where: { id: row.id } },
      );
      if (deliveryMode() === 'queue')
        await enqueueDeliver(row.id, row.attempts + 1, next, row.deliveryClass === 'SAFETY');
      return 'RETRY';
    }
    await Notification.update(
      {
        status: 'FAILED',
        failedAt: now(),
        lastErrorCode: code,
        lastErrorMessage: permanent ? 'permanent error' : 'out of attempts',
        nextAttemptAt: null,
      },
      { where: { id: row.id } },
    );
    const loaded = await getTemplate(row.templateKey, row.locale).catch(() => null);
    if (loaded) {
      const next = failureFallback(
        row.deliveryClass,
        row.channel,
        await siblingChannels(row),
        loaded.meta.allowedChannels,
      );
      if (next) {
        const fb = await makeFallback(row, next);
        if (fb) await dispatchFallback(fb, row.deliveryClass === 'SAFETY');
      }
    }
    return 'FAILED';
  }
}

/** Job `communication:deliver` (and the inline path): payload `{ id, attempt }`. */
export const runDeliverJob = async (data: { id?: unknown }): Promise<DeliverOutcome> =>
  deliverNotification(Number(data.id));

/**
 * Job `communication:repair-stuck` (every 5 minutes) and the inline retry path: QUEUED / DEFERRED rows that are due (more than 2 minutes late in queue
 * mode, immediately in inline mode) are delivered again; SENDING rows older than 10 minutes go back to QUEUED without counting the attempt.
 */
export async function repairStuck(
  opts: { lateMs?: number } = {},
): Promise<{ redelivered: number; reset: number }> {
  const at = now();
  const [reset] = await Notification.update(
    { status: 'QUEUED', nextAttemptAt: at },
    { where: { status: 'SENDING', updatedAt: { [Op.lt]: new Date(at.getTime() - 10 * 60_000) } } },
  );
  const due = await Notification.findAll({
    where: {
      status: { [Op.in]: ['QUEUED', 'DEFERRED'] },
      nextAttemptAt: { [Op.lte]: new Date(at.getTime() - (opts.lateMs ?? 0)) },
    },
    attributes: ['id', 'attempts', 'deliveryClass'],
    order: [['id', 'ASC']],
    limit: 500,
  });
  for (const r of due) {
    if (deliveryMode() === 'queue')
      await enqueueDeliver(r.id, r.attempts + 1, null, r.deliveryClass === 'SAFETY');
    else await deliverNotification(r.id);
  }
  return { redelivered: due.length, reset };
}
