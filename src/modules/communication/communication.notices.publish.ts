import { appUrl } from '../auth/auth.apps';
import { Op, type Transaction } from 'sequelize';
import { Notice, NoticeReceipt, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { enqueueAfterCommit } from '../../lib/queue';
import { audit } from '../../utils/audit';
import { AppError, ForbiddenError, UnprocessableError } from '../../utils/errors';
import type { Ctx, SystemCtx } from '../../types/context';
import {
  getOpenForEntity,
  cancel as cancelApproval,
  request as requestApproval,
  resubmit as resubmitApproval,
} from '../approvals/approvals.public';
import type { ApprovalCtx, ApprovalRequestView } from '../approvals/approvals.types';
import {
  AUDIT,
  COMMUNICATION_QUEUE,
  ENT,
  ENTITY,
  ERR,
  JOBS,
  LIMITS,
  NOTIFY,
  PERM,
  SETTING,
  utilityLabel,
} from './communication.constants';
import { resolveAudience } from './communication.audience';
import { notify } from './communication.core';
import { communicationPorts } from './communication.ports';
import {
  ackDueValid,
  assertNoticeTransition,
  expiryValid,
  remindCheck,
  scheduleValid,
} from './communication.state';
import {
  actionTarget,
  assertActionsOpen,
  assertUtilityWindow,
  checkAudience,
  needFeature,
} from './communication.composer';
import { labelOf, toDetail } from './communication.notices.dto';
import {
  emitNoticeUpdated,
  findNotice,
  lockNotice,
  n,
  notFound,
  settingNum,
  societyIdOf,
  stale,
} from './communication.notices.shared';

/** State changes of a notice (8.8 to 8.14, 8.39). Every status change goes through `assertNoticeTransition` / `noticeTransition` (6.1). */
type C = Ctx | SystemCtx;
const uid = (ctx: C): number | null => ctx.user?.id ?? null;
const can = (ctx: C, key: string): boolean => Boolean(ctx.permissions?.has(key));
const forbidden = () => new ForbiddenError(ERR.permissionDenied, 'You do not have permission to do this');
/** Absolute on the resident app origin: SMS and e-mail links must open from outside the app (in-app deep links stay relative). */
const link = (id: number): string => appUrl('RESIDENT', `/notices/${id}`);

/** Locks a notice by id inside a transaction without needing a request context (approval handlers, jobs). */
async function lockById(societyId: number, id: number, t: Transaction): Promise<Notice | null> {
  return Notice.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
}

/** Chunks of at most 5,000 explicit recipients (`notify` refuses more than 10,000). */
async function notifyUsers(
  societyId: number,
  templateKey: string,
  userIds: number[],
  data: Record<string, unknown>,
  dedupeKey: string,
  extra: { channels?: never; urgent?: boolean } = {},
): Promise<void> {
  const ids = [...new Set(userIds)];
  for (let i = 0; i < ids.length; i += 5000)
    await notify(templateKey, ids.slice(i, i + 5000), data, { societyId, dedupeKey, ...extra });
}
const afterCommit = (t: Transaction, what: string, fn: () => Promise<void>): void =>
  t.afterCommit(async () => {
    try {
      await fn();
    } catch (err) {
      logger.error({ err, what }, 'communication: after-commit effect failed');
    }
  });

async function receiptUserIds(noticeId: number, where: Record<string, unknown> = {}): Promise<number[]> {
  const rows = await NoticeReceipt.findAll({
    where: { noticeId, userId: { [Op.ne]: null }, ...where },
    attributes: ['userId'],
    group: ['userId'],
  });
  return rows.map(r => n(r.userId));
}

// ------------------------------------------------------------------ pin limit (BR-16-9)
async function pinnedRows(societyId: number, t: Transaction, exceptId?: number): Promise<number[]> {
  const rows = await Notice.findAll({
    where: {
      societyId,
      isPinned: true,
      status: 'PUBLISHED',
      ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}),
    },
    attributes: ['id'],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  return rows.map(r => n(r.id));
}
const pinLimitError = (ids: number[]) =>
  new AppError(
    409,
    ERR.noticePinLimitReached,
    'The pinned notices limit is reached',
    ids.map(id => ({ field: 'pinnedNoticeIds', message: String(id) })),
  );

// ------------------------------------------------------------------ publish (8.8)
export interface PublishResult {
  notice: Awaited<ReturnType<typeof toDetail>>;
  message: string;
}

export async function publishNotice(
  ctx: Ctx,
  id: number,
  input: { version: number; scheduledAt?: Date },
): Promise<PublishResult> {
  const societyId = societyIdOf(ctx);
  if (input.scheduledAt) await needFeature(ctx, ENT.scheduling);
  const at = now();
  const { row, people } = await sequelize.transaction(async t => {
    const notice = await lockNotice(ctx, id, t, input.version);
    assertNoticeTransition(notice.status, 'submit');
    if (input.scheduledAt && !scheduleValid(input.scheduledAt, at))
      throw new UnprocessableError(
        ERR.noticeScheduleInvalid,
        'Schedule between 5 minutes and 90 days from now',
      );
    const publishAt = input.scheduledAt ?? at;
    // BR-16-1
    const text = notice.bodyText;
    if (
      notice.title.trim().length < LIMITS.titleMin ||
      text.length < LIMITS.bodyTextMin ||
      text.length > LIMITS.bodyTextMax
    )
      throw new UnprocessableError(ERR.noticeIncomplete, 'The title or body is too short to publish', [
        { field: 'title', message: 'Title 5 to 150 characters; body 10 to 20,000 characters' },
      ]);
    // BR-16-5
    if (notice.expiresAt && !expiryValid(notice.expiresAt, publishAt))
      throw new UnprocessableError(
        ERR.noticeExpiryInvalid,
        'Expiry must be 1 hour to 365 days after publish',
        [{ field: 'expiresAt', message: 'Invalid expiry' }],
      );
    if (notice.requiresAck && notice.ackDueAt && !ackDueValid(notice.ackDueAt, publishAt))
      throw new UnprocessableError(
        ERR.noticeExpiryInvalid,
        'Acknowledge-by must be after publish and within 90 days',
        [{ field: 'ackDueAt', message: 'Invalid acknowledge-by date' }],
      );
    assertUtilityWindow(notice, publishAt);
    await assertActionsOpen(societyId, notice.actions);
    // attachments (BR-16-1)
    const files = communicationPorts().files;
    for (const fileId of files.list(n(notice.id))) {
      const f = await files.describe(societyId, fileId);
      if (f?.status === 'INFECTED')
        throw new UnprocessableError(ERR.fileInfected, 'An attachment failed the virus scan');
      if (!f || f.status !== 'CLEAN')
        throw new AppError(409, ERR.noticeAttachmentsPending, 'An attachment is still being scanned');
    }
    // audience still valid, and not empty
    const aud = await checkAudience(
      ctx,
      {
        type: notice.audienceType,
        relation: notice.audienceRelation,
        ids: notice.audienceIds ?? undefined,
        roleKeys: notice.audienceRoleKeys ?? undefined,
      },
      { skipGate: true },
    );
    const resolved = await resolveAudience(societyId, {
      type: aud.type,
      relation: aud.relation,
      ids: aud.ids ?? undefined,
      roleKeys: aud.roleKeys ?? undefined,
    });
    if (!resolved.people.length)
      throw new UnprocessableError(ERR.noticeAudienceEmpty, 'This audience has nobody to send to');
    if (notice.isPinned) {
      const pinned = await pinnedRows(societyId, t);
      if (pinned.length >= (await settingNum(societyId, SETTING.maxPinnedNotices)))
        throw pinLimitError(pinned);
    }
    const from = notice.status;
    void from;
    await notice.update(
      {
        scheduledAt: input.scheduledAt ?? null,
        status: 'PENDING_APPROVAL',
        publishedBy: uid(ctx),
        version: n(notice.version) + 1,
        updatedBy: uid(ctx),
        lastDecisionReason: null,
      } as never,
      { transaction: t },
    );
    const label = await labelOf(societyId, notice);
    await audit(
      ctx,
      {
        action: AUDIT.noticeSubmitted,
        entityType: ENTITY.notice,
        entityId: n(notice.id),
        societyId,
        after: {
          scheduledAt: input.scheduledAt?.toISOString() ?? null,
          recipientEstimate: resolved.people.length,
        },
      },
      t,
    );
    const payload = {
      noticeId: n(notice.id),
      audienceLabel: label,
      scheduledAt: input.scheduledAt?.toISOString() ?? null,
      recipientEstimate: resolved.people.length,
      channels: notice.channels,
      requiresAck: Boolean(notice.requiresAck),
    };
    const open = await getOpenForEntity(societyId, 'NOTICE_PUBLISH', n(notice.id));
    const req =
      open && open.status === 'CHANGES_REQUESTED'
        ? await resubmitApproval(ctx, n(open.id), { payload }, t)
        : await requestApproval(
            ctx,
            {
              type: 'NOTICE_PUBLISH',
              entityType: 'notice',
              entityId: n(notice.id),
              title: notice.title.slice(0, 200),
              summary: `${label}, ${resolved.people.length} people`,
              payload,
            },
            t,
          );
    await Notice.update({ approvalRequestId: n(req.id) }, { where: { id: notice.id }, transaction: t });
    await notice.reload({ transaction: t }); // the handler may already have published it
    return { row: notice, people: resolved.people.length };
  });
  const message =
    row.status === 'PUBLISHED'
      ? `Published to ${people} people`
      : row.status === 'SCHEDULED'
        ? 'Scheduled'
        : 'Sent for approval';
  return { notice: await toDetail(ctx, row), message };
}

// ------------------------------------------------------------------ the approval handler side (8.39)
/** Publishes the notice now: PUBLISHED, `publishedAt`, audit, fan-out after commit. The caller holds the row lock. */
export async function doPublish(
  ctx: C,
  notice: Notice,
  t: Transaction,
  o: { by?: number | null; scheduler?: boolean } = {},
): Promise<void> {
  const societyId = n(notice.societyId);
  const to = assertNoticeTransition(notice.status, 'publish', { scheduledAt: null });
  const at = now();
  await notice.update(
    {
      status: to as never,
      publishedAt: at,
      publishedBy: notice.publishedBy ?? o.by ?? uid(ctx),
      pinnedAt: notice.isPinned ? at : null,
      version: n(notice.version) + 1,
      updatedBy: uid(ctx),
    } as never,
    { transaction: t },
  );
  await audit(
    ctx as Ctx,
    {
      action: AUDIT.noticePublished,
      entityType: ENTITY.notice,
      entityId: n(notice.id),
      societyId,
      after: { kind: notice.kind, scheduler: Boolean(o.scheduler) },
    },
    t,
  );
  enqueueAfterCommit(t, COMMUNICATION_QUEUE, JOBS.noticeFanout, { noticeId: n(notice.id), societyId });
  t.afterCommit(() => emitNoticeUpdated(societyId, n(notice.id), 'PUBLISHED'));
}

/** Module 14 `onApproved`: PENDING_APPROVAL to SCHEDULED or PUBLISHED. Idempotent. */
export async function onPublishApproved(
  ctx: ApprovalCtx,
  req: ApprovalRequestView,
  t: Transaction,
): Promise<void> {
  const societyId = req.societyId;
  const notice = await lockById(societyId, req.entityId, t);
  if (!notice || notice.status !== 'PENDING_APPROVAL') return;
  const at = now();
  const notes: string[] = [];
  let isPinned = Boolean(notice.isPinned);
  if (isPinned) {
    const pinned = await pinnedRows(societyId, t, n(notice.id));
    if (pinned.length >= (await settingNum(societyId, SETTING.maxPinnedNotices))) {
      isPinned = false;
      notes.push('Pin limit reached; published unpinned');
    }
  }
  let actions = notice.actions;
  if (actions?.length) {
    const open = [];
    for (const a of actions) {
      if ((await actionTarget(societyId, a)).open) open.push(a);
      else notes.push(`Action ${a.type} dropped: target no longer open`);
    }
    actions = open.length ? open : null;
  }
  await notice.update(
    {
      approvedBy: ctx.approval.actorUserId ?? null,
      approvedAt: at,
      approvalRequestId: req.id,
      isPinned,
      actions,
      lastDecisionReason: notes.length ? notes.join('; ').slice(0, 500) : null,
    } as never,
    { transaction: t },
  );
  const target = assertNoticeTransition(notice.status, 'publish', { scheduledAt: notice.scheduledAt, at });
  if (target === 'SCHEDULED') {
    // 6.1: the machine only knows PUBLISH_TARGET for PENDING_APPROVAL; the scheduler moves it on
    await notice.update({ status: 'SCHEDULED', version: n(notice.version) + 1 } as never, { transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.noticeScheduled,
        entityType: ENTITY.notice,
        entityId: n(notice.id),
        societyId,
        after: { scheduledAt: notice.scheduledAt?.toISOString() ?? null },
      },
      t,
    );
    return;
  }
  await doPublish(ctx, notice, t, { by: notice.publishedBy });
}

const withdrawing = new WeakSet<Transaction>();
export type ReturnCause = 'REJECTED' | 'CHANGES_REQUESTED' | 'CANCELLED' | 'EXPIRED';

/** Module 14 `onRejected`, `onChangesRequested`, `onCancelled`, `onExpired`: PENDING_APPROVAL back to DRAFT with the reason. */
export async function backToDraft(
  societyId: number,
  noticeId: number,
  cause: ReturnCause,
  reason: string | null,
  t: Transaction,
  ctx?: C,
): Promise<void> {
  const notice = await lockById(societyId, noticeId, t);
  if (!notice || notice.status !== 'PENDING_APPROVAL') return;
  assertNoticeTransition(notice.status, 'return');
  await notice.update(
    {
      status: 'DRAFT',
      scheduledAt: null,
      lastDecisionReason:
        (reason ?? (cause === 'EXPIRED' ? 'The approval request expired' : null))?.slice(0, 500) ?? null,
      version: n(notice.version) + 1,
    } as never,
    { transaction: t },
  );
  if (withdrawing.has(t)) return;
  await audit(
    (ctx ?? ({ requestId: 'approval', ip: '', userAgent: '' } as Ctx)) as Ctx,
    {
      action: AUDIT.noticeReturned,
      entityType: ENTITY.notice,
      entityId: n(notice.id),
      societyId,
      after: { cause },
      reason: reason?.slice(0, 500) ?? null,
    },
    t,
  );
}

// ------------------------------------------------------------------ withdraw, cancel schedule (8.9)
function authorOrEdit(ctx: C, notice: Notice): void {
  const isAuthor = n(notice.createdBy) === uid(ctx);
  if (!(isAuthor && can(ctx, PERM.noticesCreate)) && !can(ctx, PERM.noticesEdit)) throw forbidden();
}

export async function withdrawNotice(ctx: Ctx, id: number, input: { version: number; reason?: string }) {
  const societyId = societyIdOf(ctx);
  const row = await sequelize.transaction(async t => {
    const notice = await lockNotice(ctx, id, t, input.version);
    authorOrEdit(ctx, notice);
    assertNoticeTransition(notice.status, 'return');
    const reason = input.reason ?? 'Withdrawn by author';
    const open = await getOpenForEntity(societyId, 'NOTICE_PUBLISH', n(notice.id));
    withdrawing.add(t);
    if (open) await cancelApproval(ctx, n(open.id), reason, t);
    await notice.reload({ transaction: t });
    if (notice.status === 'PENDING_APPROVAL')
      await notice.update({ status: 'DRAFT', scheduledAt: null, version: n(notice.version) + 1 } as never, {
        transaction: t,
      });
    await notice.update({ lastDecisionReason: reason, updatedBy: uid(ctx) } as never, { transaction: t });
    await audit(
      ctx,
      { action: AUDIT.noticeWithdrawn, entityType: ENTITY.notice, entityId: n(notice.id), societyId, reason },
      t,
    );
    return notice;
  });
  return toDetail(ctx, row);
}

export async function cancelSchedule(ctx: Ctx, id: number, input: { version: number; reason?: string }) {
  const societyId = societyIdOf(ctx);
  const row = await sequelize.transaction(async t => {
    const notice = await lockNotice(ctx, id, t, input.version);
    authorOrEdit(ctx, notice);
    assertNoticeTransition(notice.status, 'cancelSchedule');
    await notice.update(
      {
        status: 'DRAFT',
        scheduledAt: null,
        lastDecisionReason: input.reason ?? null,
        version: n(notice.version) + 1,
        updatedBy: uid(ctx),
      } as never,
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.noticeScheduleCancelled,
        entityType: ENTITY.notice,
        entityId: n(notice.id),
        societyId,
        reason: input.reason ?? null,
      },
      t,
    );
    return notice;
  });
  return toDetail(ctx, row);
}

// ------------------------------------------------------------------ recall (8.10)
async function recallTx(
  ctx: C,
  notice: Notice,
  t: Transaction,
  reason: string,
  notifyRecall: boolean,
): Promise<void> {
  const societyId = n(notice.societyId);
  assertNoticeTransition(notice.status, 'recall');
  const at = now();
  await notice.update(
    {
      status: 'RECALLED',
      isPinned: false,
      pinnedAt: null,
      recalledAt: at,
      recalledBy: uid(ctx),
      recallReason: reason,
      version: n(notice.version) + 1,
      updatedBy: uid(ctx),
    } as never,
    { transaction: t },
  );
  await audit(
    ctx as Ctx,
    {
      action: AUDIT.noticeRecalled,
      entityType: ENTITY.notice,
      entityId: n(notice.id),
      societyId,
      reason,
      after: { notifyRecall },
    },
    t,
  );
  t.afterCommit(() => emitNoticeUpdated(societyId, n(notice.id), 'RECALLED'));
  if (notifyRecall)
    afterCommit(t, 'notice-recall', async () => {
      await notifyUsers(
        societyId,
        NOTIFY.noticeRecalled,
        await receiptUserIds(n(notice.id)),
        { noticeId: n(notice.id), title: notice.title },
        `notice-recall:${n(notice.id)}`,
      );
    });
}

export async function recallNotice(
  ctx: Ctx,
  id: number,
  input: { version: number; reason: string; notifyRecall: boolean },
) {
  const row = await sequelize.transaction(async t => {
    const notice = await lockNotice(ctx, id, t, input.version);
    await recallTx(ctx, notice, t, input.reason, input.notifyRecall);
    return notice;
  });
  return toDetail(ctx, row);
}

/** 8.38 `notices.recallBySource`: recalls the published system notice of a source record; a no-op when there is none or it is not PUBLISHED. */
export async function recallBySource(
  ctx: C,
  sourceRefType: string,
  sourceRefId: number,
  reason: string,
): Promise<void> {
  const societyId = societyIdOf(ctx);
  await sequelize.transaction(async t => {
    const row = await Notice.findOne({
      where: { societyId, sourceRefType, sourceRefId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!row || row.status !== 'PUBLISHED') return;
    await recallTx(ctx, row, t, reason.slice(0, LIMITS.recallReasonMax), true);
  });
}

// ------------------------------------------------------------------ pin, unpin, archive (8.11)
export async function pinNotice(ctx: Ctx, id: number, version: number) {
  const societyId = societyIdOf(ctx);
  const row = await sequelize.transaction(async t => {
    const notice = await lockNotice(ctx, id, t, version);
    if (notice.status !== 'PUBLISHED')
      throw new AppError(409, ERR.invalidState, 'Only a published notice can be pinned');
    if (notice.isPinned) return notice;
    const pinned = await pinnedRows(societyId, t);
    if (pinned.length >= (await settingNum(societyId, SETTING.maxPinnedNotices))) throw pinLimitError(pinned);
    await notice.update(
      { isPinned: true, pinnedAt: now(), version: n(notice.version) + 1, updatedBy: uid(ctx) } as never,
      { transaction: t },
    );
    await audit(
      ctx,
      { action: AUDIT.noticePinned, entityType: ENTITY.notice, entityId: n(notice.id), societyId },
      t,
    );
    t.afterCommit(() => emitNoticeUpdated(societyId, n(notice.id), notice.status));
    return notice;
  });
  return toDetail(ctx, row);
}

export async function unpinNotice(ctx: Ctx, id: number, version: number) {
  const societyId = societyIdOf(ctx);
  const row = await sequelize.transaction(async t => {
    const notice = await lockNotice(ctx, id, t, version);
    if (!notice.isPinned) return notice;
    await notice.update(
      { isPinned: false, pinnedAt: null, version: n(notice.version) + 1, updatedBy: uid(ctx) } as never,
      { transaction: t },
    );
    await audit(
      ctx,
      { action: AUDIT.noticeUnpinned, entityType: ENTITY.notice, entityId: n(notice.id), societyId },
      t,
    );
    return notice;
  });
  return toDetail(ctx, row);
}

export async function archiveNotice(ctx: Ctx, id: number, version: number) {
  const societyId = societyIdOf(ctx);
  const row = await sequelize.transaction(async t => {
    const notice = await lockNotice(ctx, id, t, version);
    const from = notice.status;
    assertNoticeTransition(from, 'archive');
    await notice.update(
      {
        status: 'ARCHIVED',
        isPinned: false,
        pinnedAt: null,
        archivedAt: now(),
        version: n(notice.version) + 1,
        updatedBy: uid(ctx),
      } as never,
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.noticeArchived,
        entityType: ENTITY.notice,
        entityId: n(notice.id),
        societyId,
        before: { status: from },
      },
      t,
    );
    return notice;
  });
  return toDetail(ctx, row);
}

// ------------------------------------------------------------------ remind (8.13), mark restored (8.14)
export async function remindNotice(ctx: Ctx, id: number, version: number): Promise<{ queuedFor: number }> {
  const societyId = societyIdOf(ctx);
  const at = now();
  return sequelize.transaction(async t => {
    const notice = await lockNotice(ctx, id, t, version);
    if (notice.status !== 'PUBLISHED' || !notice.requiresAck)
      throw new AppError(
        409,
        ERR.invalidState,
        'Only a published notice that needs acknowledgement can be reminded',
      );
    const max = await settingNum(societyId, SETTING.ackMaxReminders);
    const refused = remindCheck(notice, max, at);
    if (refused === ERR.noticeRemindTooSoon)
      throw new UnprocessableError(ERR.noticeRemindTooSoon, 'A reminder was sent less than 6 hours ago');
    if (refused)
      throw new UnprocessableError(
        ERR.noticeRemindLimit,
        'The reminder limit is reached or the due date has passed',
      );
    const reminderNo = n(notice.remindersSent) + 1;
    const queuedFor = await NoticeReceipt.count({
      where: { noticeId: n(notice.id), userId: { [Op.ne]: null }, acknowledgedAt: null },
    });
    await notice.update(
      {
        remindersSent: reminderNo,
        lastRemindedAt: at,
        version: n(notice.version) + 1,
        updatedBy: uid(ctx),
      } as never,
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.noticeReminded,
        entityType: ENTITY.notice,
        entityId: n(notice.id),
        societyId,
        after: { reminderNo, queuedFor },
      },
      t,
    );
    enqueueAfterCommit(t, COMMUNICATION_QUEUE, JOBS.ackRemindNotice, {
      noticeId: n(notice.id),
      societyId,
      reminderNo,
    });
    return { queuedFor };
  });
}

export async function markRestored(ctx: Ctx, id: number, input: { version: number; message?: string }) {
  const societyId = societyIdOf(ctx);
  const row = await sequelize.transaction(async t => {
    const notice = await lockNotice(ctx, id, t, input.version);
    if (notice.kind !== 'UTILITY_SHUTDOWN' || notice.status !== 'PUBLISHED' || notice.restoredAt)
      throw new AppError(409, ERR.invalidState, 'This notice cannot be marked restored');
    await notice.update({ restoredAt: now(), version: n(notice.version) + 1, updatedBy: uid(ctx) } as never, {
      transaction: t,
    });
    await audit(
      ctx,
      {
        action: AUDIT.noticeRestored,
        entityType: ENTITY.notice,
        entityId: n(notice.id),
        societyId,
        reason: input.message ?? 'Supply is restored.',
      },
      t,
    );
    afterCommit(t, 'utility-restored', async () => {
      await notifyUsers(
        societyId,
        NOTIFY.utilityRestored,
        await receiptUserIds(n(notice.id)),
        { noticeId: n(notice.id), title: notice.title, utilityType: utilityLabel(notice.utilityType) },
        `util-restored:${n(notice.id)}`,
      );
    });
    t.afterCommit(() => emitNoticeUpdated(societyId, n(notice.id), notice.status));
    return notice;
  });
  return toDetail(ctx, row);
}

export { link as noticeLink, notFound, stale, findNotice, receiptUserIds, notifyUsers };
