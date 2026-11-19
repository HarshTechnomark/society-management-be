import { randomUUID, createHash } from 'node:crypto';
import { UniqueConstraintError, type Transaction } from 'sequelize';
import { now } from '../../lib/clock';
import { recordInbox } from '../../lib/inbox';
import { logger } from '../../lib/logger';
import { enqueue } from '../../lib/queue';
import { InboxItem, Notification, PushSubscription, Resident, Society, User, sequelize } from '../../models';
import { computeAccess } from '../access-control/access-control.public';
import { entitlements } from '../subscriptions/subscriptions.public';
import { settings } from '../society-setup/society-setup.public';
import {
  COMMUNICATION_QUEUE,
  ENT,
  ERR,
  JOBS,
  LANGUAGE_TO_LOCALE,
  LIMITS,
  SETTING,
  type Channel,
  type ExternalChannel,
} from './communication.constants';
import {
  decryptJson,
  encrypt,
  encryptJson,
  emailKey,
  maskEmail,
  maskMobile,
  mobileKey,
  userKey,
} from './communication.crypto';
import { deliverNotification, enqueueDeliver, type RowPayload } from './communication.deliver';
import { emitCreated, inboxScopeFor, unreadCount } from './communication.inbox';
import { deliveryMode } from './communication.mode';
import {
  effectiveWindow,
  getOrCreatePreferences,
  inQuietHours,
  isChannelOn,
  preferencesFor,
  quietEnd,
} from './communication.prefs';
import { NotifyError, validateData } from './communication.render';
import {
  isQueryRecipient,
  needsFanout,
  resolveTargets,
  validateRecipients,
  type Target,
} from './communication.recipients';
import { retryPolicy, routeChannels, suppressedBySociety, type RouteRow } from './communication.route';
import { getTemplate, renderTemplate, type LoadedTemplate } from './communication.templates';
import type { NotifyOptions, NotifyResult, Recipient } from './communication.types';

/**
 * The REAL `notify()` pipeline (6.5): template lookup, data validation, society state, channel plan, fan-out for query recipients, per page of 500 recipients
 * one transaction that resolves locale, quiet hours and channels, inserts the inbox items and delivery rows (unique keys = dedupe, BR-16-25), then after commit the
 * realtime events and the delivery (inline in development and tests, `communication:deliver` jobs in production).
 */
export { deliveryMode, setDeliveryMode } from './communication.mode';

interface SocietyInfo {
  id: number;
  status: string;
  timezone: string;
}
interface Batch {
  batchId: string;
  tpl: LoadedTemplate;
  data: Record<string, unknown>;
  opts: NotifyOptions;
  society: SocietyInfo | null;
  /** Template channels to send, IN_APP excluded. */
  channels: ExternalChannel[];
  allowedFilter: ExternalChannel[] | null;
}

const EXTERNAL: readonly ExternalChannel[] = ['PUSH', 'SMS', 'WHATSAPP', 'EMAIL'];

/** BR-16-25: the stored dedupe key includes the template key so two templates can share a caller key; hashed when it would not fit. */
export const storedDedupeKey = (templateKey: string, dedupeKey: string | undefined): string | null => {
  if (!dedupeKey) return null;
  const k = `${templateKey}|${dedupeKey}`;
  return k.length <= 120 ? k : createHash('sha256').update(k).digest('hex');
};

async function insertIgnore<T>(create: () => Promise<T>): Promise<T | null> {
  try {
    return await create();
  } catch (err) {
    if (err instanceof UniqueConstraintError) return null;
    throw err;
  }
}

function planChannels(tpl: LoadedTemplate, opts: NotifyOptions): ExternalChannel[] {
  const cls = tpl.meta.deliveryClass;
  if (cls === 'OTP') {
    const ch = (opts.channel ?? opts.channels?.[0] ?? 'SMS') as ExternalChannel;
    if (!tpl.meta.allowedChannels.includes(ch))
      throw new NotifyError(ERR.notifyChannelNotAllowed, `Channel ${ch} is not allowed for ${tpl.key}`);
    return [ch];
  }
  let requested: Channel[] = tpl.meta.defaultChannels;
  if (opts.channels) {
    if (tpl.legacy)
      requested = tpl.meta.defaultChannels.filter(c => opts.channels!.includes(c)); // stand-in meaning: restrict delivery
    else {
      const bad = opts.channels.filter(c => !tpl.meta.allowedChannels.includes(c));
      if (bad.length)
        throw new NotifyError(ERR.notifyChannelNotAllowed, `Channel ${bad[0]} is not allowed for ${tpl.key}`);
      requested = opts.channels;
    }
  }
  return EXTERNAL.filter(c => requested.includes(c));
}

/** The inbox is part of every user message except OTP; a legacy caller restricting channels without IN_APP still gets the inbox item (BR-16-21). */
const wantsInApp = (tpl: LoadedTemplate): boolean => tpl.meta.deliveryClass !== 'OTP';

async function localeFor(
  b: Batch,
  userId: number | null,
  prefsLocale: string | null | undefined,
  residentLang: string | undefined,
): Promise<string> {
  if (b.opts.locale) return b.opts.locale;
  if (userId && prefsLocale) return prefsLocale;
  if (userId && residentLang) return residentLang;
  if (b.society) {
    const lang = String(await settings.get(b.society.id, SETTING.defaultLanguage as never).catch(() => 'en'));
    return LANGUAGE_TO_LOCALE[lang] ?? 'en-IN';
  }
  return 'en-IN';
}

interface PageResult {
  accepted: number;
  inbox: { userId: number; item: InboxItem }[];
  deliver: { id: number; attempt: number; at: Date | null }[];
}

async function processPage(b: Batch, targets: Target[]): Promise<PageResult> {
  const userIds = targets.filter(t => t.userId).map(t => t.userId!);
  const users = new Map(
    (userIds.length
      ? await User.findAll({
          where: { id: userIds },
          attributes: ['id', 'mobile', 'email', 'emailVerifiedAt', 'status', 'anonymisedAt'],
        })
      : []
    ).map(u => [u.id!, u]),
  );
  const prefs = await preferencesFor(userIds);
  const subs = new Map<number, number>();
  if (userIds.length && b.channels.includes('PUSH')) {
    const rows = await PushSubscription.findAll({
      where: {
        userId: userIds,
        status: 'ACTIVE',
        ...(b.opts.pushSubscriptionId ? { id: b.opts.pushSubscriptionId } : {}),
      },
      attributes: ['userId'],
    });
    for (const r of rows) subs.set(r.userId, (subs.get(r.userId) ?? 0) + 1);
  }
  const langs = new Map<number, string>();
  if (b.society && userIds.length && !b.opts.locale) {
    for (const r of await Resident.findAll({
      where: { societyId: b.society.id, userId: userIds },
      attributes: ['userId', 'preferredLanguage'],
    }))
      if (r.userId && !langs.has(r.userId)) langs.set(r.userId, r.preferredLanguage);
  }
  const waFeatureOn =
    b.tpl.meta.scope === 'SOCIETY' && b.society
      ? await entitlements.isFeatureOn(b.society.id, ENT.whatsappMessaging as never).catch(() => false)
      : true;
  const ended = new Set<number>();
  if (b.society && !b.tpl.legacy && b.tpl.meta.scope === 'SOCIETY' && !b.tpl.meta.allowEndedMembers)
    for (const t of targets) if (t.userId && (await endedCheck(b.society.id, t.userId))) ended.add(t.userId);
  const tz = b.society?.timezone ?? 'Asia/Kolkata';
  const out: PageResult = { accepted: 0, inbox: [], deliver: [] };

  await sequelize.transaction(async t => {
    for (const target of targets) {
      try {
        await planTarget(b, target, { users, prefs, subs, langs, waFeatureOn, ended, tz }, out, t);
      } catch (err) {
        if (err instanceof NotifyError) throw err;
        logger.error({ err, templateKey: b.tpl.key }, 'communication: recipient skipped after an error');
      }
    }
  });
  return out;
}

/** BR-16-26: a user whose membership of the society ENDED gets no society message (never a member, e.g. an invitee, is allowed). */
async function endedCheck(societyId: number, userId: number): Promise<boolean> {
  try {
    return (await computeAccess(societyId, userId)).status === 'ENDED';
  } catch {
    return false;
  }
}

interface Facts {
  users: Map<number, User>;
  prefs: Map<number, import('../../models').NotificationPreference>;
  subs: Map<number, number>;
  langs: Map<number, string>;
  waFeatureOn: boolean;
  ended: Set<number>;
  tz: string;
}

async function planTarget(
  b: Batch,
  target: Target,
  f: Facts,
  out: PageResult,
  t: Transaction,
): Promise<void> {
  const user = target.userId ? f.users.get(target.userId) : undefined;
  if (target.userId && (!user || user.anonymisedAt)) return;
  const p = target.userId ? (f.prefs.get(target.userId) ?? null) : null;
  const cls = b.tpl.meta.deliveryClass;
  const mobile = target.mobile ?? user?.mobile ?? null;
  const email = target.email ?? user?.email ?? null;
  const emailOk =
    Boolean(email) &&
    !p?.emailBouncedAt &&
    (target.explicit || b.tpl.legacy !== null || Boolean(user?.emailVerifiedAt));
  const locale = await localeFor(
    b,
    target.userId,
    p?.locale,
    target.userId ? f.langs.get(target.userId) : undefined,
  );
  const tpl = locale === b.tpl.locale ? b.tpl : await getTemplate(b.tpl.key, locale);
  // a contact-only target keys each row by the contact of its channel, or by the one contact it has (its rows for the other channels are SKIPPED NO_CONTACT)
  const recipientKeyOf = (ch: ExternalChannel): string =>
    target.userId
      ? userKey(target.userId)
      : (ch === 'EMAIL' && email) || !mobile
        ? emailKey(email!)
        : mobileKey(mobile);
  const window = await effectiveWindow(p, b.society?.id ?? null);
  const at = now();
  const quiet = inQuietHours(window, at, f.tz);
  const dedupe = storedDedupeKey(b.tpl.key, b.opts.dedupeKey);
  const payload = encryptJson({
    data: b.data,
    deepLink: null,
    ...(b.opts.pushSubscriptionId ? { subId: b.opts.pushSubscriptionId } : {}),
  } satisfies RowPayload);
  out.accepted += 1;

  // BR-16-26: ended members are skipped without any row
  if (target.userId && f.ended.has(target.userId)) {
    for (const ch of b.channels)
      await insertRow(
        b,
        target,
        ch,
        'SKIPPED',
        'MEMBER_ENDED',
        tpl.locale,
        recipientKeyOf(ch),
        mobile,
        email,
        dedupe,
        null,
        null,
        undefined,
        t,
      );
    return;
  }

  // a legacy template renders its SMS, WhatsApp and e-mail parts only for some data (e.g. an escalation level): a part it does not render is
  // SKIPPED NO_TEMPLATE here instead of being queued, counted against the SMS limit and then FAILED at delivery
  const legacyMsg = tpl.legacy ? renderTemplate(tpl, b.data, { tz: f.tz }) : null;

  // inbox item (IN_APP is the delivery; never switched off)
  if (target.userId && wantsInApp(b.tpl) && !b.opts.skipInbox) {
    const msg = legacyMsg ?? renderTemplate(tpl, b.data, { tz: f.tz });
    const inApp = msg.inApp ?? (msg.push ? { title: msg.push.title, body: msg.push.body } : null);
    if (inApp) {
      const item = await insertIgnore(() =>
        InboxItem.create(
          {
            scope: inboxScopeFor(b.tpl.meta.scope, b.society?.id),
            societyId: inboxScopeFor(b.tpl.meta.scope, b.society?.id) === 'SOCIETY' ? b.society!.id : null,
            userId: target.userId!,
            batchId: b.batchId,
            templateKey: b.tpl.key,
            category: b.tpl.meta.category,
            deliveryClass: cls,
            tone: b.tpl.legacy?.tone ?? (cls === 'SAFETY' ? 'bad' : cls === 'SECURITY' ? 'warn' : 'info'),
            title: inApp.title.slice(0, 150),
            body: inApp.body.slice(0, 1000),
            deepLink: msg.deepLink,
            sourceType: b.opts.sourceType ?? null,
            sourceId: b.opts.sourceId ?? null,
            dedupeKey: dedupe,
            readAt: null,
          } as never,
          { transaction: t },
        ),
      );
      if (item) out.inbox.push({ userId: target.userId, item });
    }
  }

  const rows: RouteRow[] = routeChannels({
    deliveryClass: cls,
    category: b.tpl.meta.category,
    requested: b.channels,
    allowed: b.tpl.meta.allowedChannels,
    hasUser: Boolean(target.userId),
    hasMobile: Boolean(mobile),
    hasEmail: emailOk,
    pushSubscriptions: target.userId ? (f.subs.get(target.userId) ?? 0) : 0,
    prefOn: ch => isChannelOn(p?.channelMatrix, b.tpl.meta.category, ch),
    smsTemplateOk: Boolean(
      legacyMsg ? tpl.row.smsDltTemplateId && legacyMsg.sms : tpl.texts.smsBody && tpl.texts.smsDltTemplateId,
    ),
    whatsappTemplateOk: Boolean(
      legacyMsg
        ? legacyMsg.whatsapp
        : tpl.texts.whatsappTemplateName && tpl.texts.whatsappStatus === 'APPROVED',
    ),
    emailTemplateOk: legacyMsg ? Boolean(legacyMsg.email) : true,
    whatsappOptIn: Boolean(p?.whatsappOptIn),
    whatsappFeatureOn: f.waFeatureOn,
    inQuietHours: quiet,
    urgent: Boolean(b.opts.urgent),
    legacy: Boolean(b.tpl.legacy),
  });
  const created = new Map<ExternalChannel, Notification>();
  for (const r of rows) {
    const row = await insertRow(
      b,
      target,
      r.channel,
      r.status,
      r.skipReason ?? null,
      tpl.locale,
      recipientKeyOf(r.channel),
      mobile,
      email,
      dedupe,
      r.status === 'SKIPPED' ? null : payload,
      r.status === 'DEFERRED' ? quietEnd(window!, at, f.tz) : r.status === 'QUEUED' ? at : null,
      r.fallbackOf ? created.get(r.fallbackOf)?.id : undefined,
      t,
    );
    if (row) {
      created.set(r.channel, row);
      if (r.status === 'QUEUED') out.deliver.push({ id: row.id, attempt: 1, at: null });
    }
  }
}

async function insertRow(
  b: Batch,
  target: Target,
  channel: ExternalChannel,
  status: 'QUEUED' | 'DEFERRED' | 'SKIPPED',
  skipReason: string | null,
  locale: string,
  recipientKey: string,
  mobile: string | null,
  email: string | null,
  dedupe: string | null,
  dataEnc: Buffer | null,
  nextAttemptAt: Date | null,
  fallbackFromId: number | undefined,
  t: Transaction,
): Promise<Notification | null> {
  const dest = channel === 'EMAIL' ? email : channel === 'PUSH' ? null : mobile;
  return insertIgnore(() =>
    Notification.create(
      {
        societyId: b.society?.id ?? null,
        batchId: b.batchId,
        templateKey: b.tpl.key,
        locale,
        deliveryClass: b.tpl.meta.deliveryClass,
        channel,
        userId: target.userId,
        recipientKey,
        destinationMasked: dest ? (channel === 'EMAIL' ? maskEmail(dest) : maskMobile(dest)) : null,
        // contacts of people without a user, or given by the caller, are kept encrypted until the row is final (BR-16-31)
        destinationEnc: dest && (target.explicit || !target.userId) ? encrypt(dest) : null,
        status,
        skipReason,
        dedupeKey: dedupe,
        attempts: 0,
        maxAttempts: retryPolicy(b.tpl.meta.deliveryClass).maxAttempts,
        nextAttemptAt,
        fallbackFromId: fallbackFromId ?? null,
        dataEnc,
        sourceType: b.opts.sourceType ?? null,
        sourceId: b.opts.sourceId ?? null,
      } as never,
      { transaction: t },
    ),
  );
}

async function finishPage(b: Batch, page: PageResult): Promise<void> {
  const unread = new Map<number, number>();
  for (const { userId, item } of page.inbox) {
    if (!unread.has(userId))
      unread.set(userId, await unreadCount(userId, b.society ? { societyId: b.society.id } : {}));
    emitCreated(userId, item, unread.get(userId)!);
    // the dev inbox (`GET /api/v1/dev/inbox`) shows the in-app message too: the fake adapters show SMS, WhatsApp, e-mail and push
    await recordInbox({
      channel: 'IN_APP',
      to: `user:${userId}`,
      subject: item.title,
      body: item.body,
      link: item.deepLink,
      templateKey: item.templateKey,
    });
  }
  const urgent = b.tpl.meta.deliveryClass === 'SAFETY' || b.tpl.meta.deliveryClass === 'OTP';
  for (const d of page.deliver) {
    if (deliveryMode() === 'queue') await enqueueDeliver(d.id, d.attempt, d.at, urgent);
    else
      try {
        await deliverNotification(d.id);
      } catch (err) {
        logger.error({ err, id: d.id }, 'communication: inline delivery failed');
      }
  }
}

async function runBatch(b: Batch, recipients: Recipient[]): Promise<number> {
  const targets = await resolveTargets(recipients, b.society?.id ?? b.opts.societyId, b.society?.timezone);
  let accepted = 0;
  for (let i = 0; i < targets.length; i += LIMITS.fanoutPage) {
    const page = await processPage(b, targets.slice(i, i + LIMITS.fanoutPage));
    accepted += page.accepted;
    await finishPage(b, page);
  }
  return accepted;
}

async function buildBatch(
  batchId: string,
  templateKey: string,
  data: Record<string, unknown>,
  opts: NotifyOptions,
  strict: boolean,
): Promise<{ batch: Batch; suppressed: boolean }> {
  const tpl = await getTemplate(templateKey, opts.locale);
  if (strict && !tpl.legacy) validateData(tpl.variables, data);
  if (tpl.meta.scope === 'SOCIETY' && !opts.societyId && !tpl.legacy)
    throw new NotifyError(ERR.notifySocietyRequired, `Template ${templateKey} needs opts.societyId`);
  const society = opts.societyId
    ? ((await Society.findByPk(opts.societyId, {
        attributes: ['id', 'status', 'timezone'],
      })) as SocietyInfo | null)
    : null;
  const channels = planChannels(tpl, opts);
  const batch: Batch = { batchId, tpl, data, opts, society, channels, allowedFilter: null };
  const suppressed = Boolean(
    society &&
    tpl.meta.scope === 'SOCIETY' &&
    !tpl.legacy &&
    suppressedBySociety(society.status, tpl.meta.deliveryClass, tpl.meta.sendWhenClosed),
  );
  return { batch, suppressed };
}

/** 8.38 `notify()`: see the file header. Programmer errors throw; delivery problems never do. */
export async function notify(
  templateKey: string,
  recipients: Recipient[],
  data: Record<string, unknown> = {},
  opts: NotifyOptions = {},
): Promise<NotifyResult> {
  const batchId = randomUUID();
  const tpl = await getTemplate(templateKey, opts.locale); // TEMPLATE_NOT_FOUND first (6.5 step 1)
  const strict = !tpl.legacy;
  validateRecipients(recipients, strict);
  const { batch, suppressed } = await buildBatch(batchId, templateKey, data, opts, strict);
  if (suppressed) return { batchId, accepted: 0, queued: false, suppressed: true };
  if (needsFanout(recipients)) {
    if (deliveryMode() === 'queue') {
      await enqueue(COMMUNICATION_QUEUE, JOBS.notifyFanout, {
        batchId,
        templateKey,
        societyId: opts.societyId ?? null,
        recipients: recipients as unknown as Record<string, unknown>[],
        dataEnc: encryptJson(data).toString('base64'),
        opts: opts as unknown as Record<string, unknown>,
      });
    } else await runBatch(batch, recipients);
    return { batchId, accepted: null, queued: true, suppressed: false };
  }
  const accepted = await runBatch(batch, recipients);
  return { batchId, accepted, queued: false, suppressed: false };
}

export async function notifyMany(
  items: { templateKey: string; recipients: Recipient[]; data: object; opts?: NotifyOptions }[],
): Promise<NotifyResult[]> {
  const out: NotifyResult[] = [];
  for (const i of items)
    out.push(await notify(i.templateKey, i.recipients, i.data as Record<string, unknown>, i.opts));
  return out;
}

/** Job `communication:notify-fanout` (6.5 step 4): resolves the recipients of a queued batch. A restart re-runs pages safely (unique keys). */
export async function runNotifyFanout(payload: Record<string, unknown>): Promise<number> {
  const opts = (payload.opts ?? {}) as NotifyOptions;
  const data = decryptJson<Record<string, unknown>>(Buffer.from(String(payload.dataEnc), 'base64'));
  const { batch, suppressed } = await buildBatch(
    String(payload.batchId),
    String(payload.templateKey),
    data,
    opts,
    false,
  );
  if (suppressed) return 0;
  return runBatch(batch, payload.recipients as Recipient[]);
}

/** The engine installed into `lib/notify` (legacy `Recipient`s are `{ userId?, mobile?, email? }`; both shapes pass the same pipeline). */
export async function legacyEngine(
  templateKey: string,
  recipients: { userId?: number; mobile?: string | null; email?: string | null }[],
  data: Record<string, unknown>,
  options: { channel?: 'SMS' | 'WHATSAPP'; locale?: string; channels?: string[] },
): Promise<void> {
  const list: Recipient[] = [];
  for (const r of recipients) {
    if (r.userId !== undefined)
      list.push({ userId: r.userId, mobile: r.mobile ?? null, email: r.email ?? null });
    else if (r.mobile) list.push(r.email ? { mobile: r.mobile, email: r.email } : { mobile: r.mobile });
    else if (r.email) list.push({ email: r.email });
  }
  await notify(templateKey, list, data, {
    channel: options.channel,
    locale: options.locale,
    channels: options.channels as Channel[] | undefined,
  });
}

export { getOrCreatePreferences, isQueryRecipient };
