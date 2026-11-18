import { Op, literal, type Order, type Transaction, type WhereOptions } from 'sequelize';
import { Notice, PushSubscription, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import { ForbiddenError, ValidationError, AppError } from '../../utils/errors';
import type { Ctx, SystemCtx } from '../../types/context';
import { units } from '../society-setup/society-setup.public';
import { getOpenForEntity, cancel as cancelApproval } from '../approvals/approvals.public';
import { AUDIT, ENT, ENTITY, ERR, LIMITS, PERM, type NoticeExtraChannel } from './communication.constants';
import { resolveAudience } from './communication.audience';
import { communicationPorts } from './communication.ports';
import { assertNoticeTransition, noticeEditMode, expiryValid } from './communication.state';
import type { NoticeActionInput, NoticeAudience } from './communication.types';
import {
  actionTarget,
  assertUtilityFeature,
  checkActionsShape,
  checkAudience,
  checkChannels,
  linkFiles,
  needFeature,
} from './communication.composer';
import { htmlToText, sanitizeHtml } from './communication.notices.sanitize';
import { toDetail, toListItems } from './communication.notices.dto';
import {
  emitNoticeUpdated,
  findNotice,
  istDayEnd,
  istDayStart,
  lockNotice,
  n,
  societyIdOf,
  societyLocale,
} from './communication.notices.shared';

/** Notice CRUD (8.1 to 8.7, 8.12, 8.4). Publishing and the state changes are in `communication.notices.publish.ts`. */
type C = Ctx | SystemCtx;
const uid = (ctx: C): number | null => ctx.user?.id ?? null;
const can = (ctx: C, key: string): boolean => Boolean(ctx.permissions?.has(key));
const forbidden = () => new ForbiddenError(ERR.permissionDenied, 'You do not have permission to do this');

export interface CreateInput {
  kind?: 'STANDARD' | 'UTILITY_SHUTDOWN';
  title: string;
  body?: string;
  category?: string;
  priority?: string;
  locale?: string;
  audience?: NoticeAudience;
  channels?: NoticeExtraChannel[];
  actions?: NoticeActionInput[];
  requiresAck?: boolean;
  ackDueAt?: Date | null;
  isPinned?: boolean;
  expiresAt?: Date | null;
  utilityType?: string;
  outageStartsAt?: Date;
  outageEndsAt?: Date;
  fileIds?: number[];
}

/** Sanitises a body and derives `bodyText` (BR-16-2). */
export const prepareBody = (raw: string | undefined): { body: string; bodyText: string } => {
  const body = sanitizeHtml(raw ?? '');
  return { body, bodyText: htmlToText(body) };
};

// ------------------------------------------------------------------ create (8.2)
export async function createNoticeTx(
  ctx: C,
  input: CreateInput,
  t: Transaction,
  extra: { duplicatedFrom?: number; skipGates?: boolean } = {},
): Promise<Notice> {
  const societyId = societyIdOf(ctx);
  const kind = input.kind ?? 'STANDARD';
  if (kind === 'UTILITY_SHUTDOWN' && !extra.skipGates) await assertUtilityFeature(ctx);
  const audience = await checkAudience(ctx, input.audience ?? { type: 'ALL', relation: 'ANY' }, {
    skipGate: extra.skipGates,
  });
  const channels = extra.skipGates
    ? [...new Set(input.channels ?? [])]
    : await checkChannels(ctx, input.channels ?? []);
  const actions = extra.skipGates ? (input.actions ?? []) : await checkActionsShape(ctx, input.actions ?? []);
  const { body, bodyText } = prepareBody(input.body);
  if (input.ackDueAt && !input.requiresAck)
    throw new ValidationError([{ field: 'ackDueAt', message: 'ackDueAt needs requiresAck' }]);
  const row = await Notice.create(
    {
      societyId,
      kind,
      category: (input.category as never) ?? 'GENERAL',
      priority: (input.priority as never) ?? 'NORMAL',
      title: input.title.trim(),
      body,
      bodyText,
      locale: input.locale ?? (await societyLocale(societyId)),
      status: 'DRAFT',
      audienceType: audience.type,
      audienceRelation: audience.relation,
      audienceIds: audience.ids,
      audienceRoleKeys: audience.roleKeys,
      channels,
      actions: actions.length ? actions : null,
      requiresAck: Boolean(input.requiresAck),
      ackDueAt: input.requiresAck ? (input.ackDueAt ?? null) : null,
      isPinned: Boolean(input.isPinned),
      pinnedAt: null,
      scheduledAt: null,
      expiresAt: input.expiresAt ?? null,
      utilityType: kind === 'UTILITY_SHUTDOWN' ? ((input.utilityType as never) ?? null) : null,
      outageStartsAt: kind === 'UTILITY_SHUTDOWN' ? (input.outageStartsAt ?? null) : null,
      outageEndsAt: kind === 'UTILITY_SHUTDOWN' ? (input.outageEndsAt ?? null) : null,
      createdBy: uid(ctx),
      updatedBy: uid(ctx),
    } as never,
    { transaction: t },
  );
  const fileIds = input.fileIds ?? [];
  if (fileIds.length) {
    await linkFiles(ctx, n(row.id), fileIds, t);
    await row.update({ attachmentCount: fileIds.length }, { transaction: t });
  }
  await audit(
    ctx as Ctx,
    {
      action: AUDIT.noticeCreated,
      entityType: ENTITY.notice,
      entityId: n(row.id),
      societyId,
      after: {
        kind,
        category: row.category,
        audienceType: row.audienceType,
        titleLength: row.title.length,
        bodyLength: bodyText.length,
        fileCount: fileIds.length,
        ...(extra.duplicatedFrom ? { duplicatedFrom: extra.duplicatedFrom } : {}),
      },
    },
    t,
  );
  return row;
}

export async function createNotice(ctx: Ctx, input: CreateInput) {
  const row = await sequelize.transaction(t => createNoticeTx(ctx, input, t));
  return toDetail(ctx, row);
}

// ------------------------------------------------------------------ read (8.5)
export async function getNotice(ctx: Ctx, id: number) {
  return toDetail(ctx, await findNotice(ctx, id));
}

// ------------------------------------------------------------------ list (8.1)
export interface ListQuery {
  status?: string;
  category?: string;
  kind?: string;
  pinned?: boolean;
  q?: string;
  createdBy?: number;
  from?: string;
  to?: string;
  sortBy: 'publishedAt' | 'createdAt' | 'title' | 'readPct' | 'ackPct';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, c => `\\${c}`);

export async function listNotices(ctx: Ctx, q: ListQuery) {
  const societyId = societyIdOf(ctx);
  const and: WhereOptions[] = [{ societyId }];
  if (q.status === 'ACTIVE')
    and.push({ status: { [Op.in]: ['PUBLISHED', 'SCHEDULED', 'PENDING_APPROVAL'] } });
  else if (q.status) and.push({ status: q.status });
  if (q.category) and.push({ category: q.category });
  if (q.kind) and.push({ kind: q.kind });
  if (q.pinned !== undefined) and.push({ isPinned: q.pinned });
  if (q.createdBy) and.push({ createdBy: q.createdBy });
  if (q.from) and.push({ publishedAt: { [Op.gte]: istDayStart(q.from) } });
  if (q.to) and.push({ publishedAt: { [Op.lt]: istDayEnd(q.to) } });
  if (q.q) {
    const like = `%${likeEscape(q.q)}%`;
    and.push(
      literal(
        `(MATCH(title, bodyText) AGAINST (${sequelize.escape(q.q)} IN NATURAL LANGUAGE MODE) OR title LIKE ${sequelize.escape(like)} OR bodyText LIKE ${sequelize.escape(like)})`,
      ) as never,
    );
  }
  const dir = q.sortOrder.toUpperCase();
  const primary =
    q.sortBy === 'readPct'
      ? literal('(readCount / NULLIF(recipientCount, 0))')
      : q.sortBy === 'ackPct'
        ? literal('(ackCount / NULLIF(recipientCount, 0))')
        : q.sortBy === 'publishedAt'
          ? literal('COALESCE(publishedAt, scheduledAt, createdAt)')
          : q.sortBy;
  const order: Order = [
    [primary as never, dir],
    ['id', dir],
  ];
  const { rows, count } = await Notice.findAndCountAll({
    where: { [Op.and]: and },
    order,
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { items: await toListItems(ctx, rows), pagination: pageMeta(q.page, q.limit, count) };
}

// ------------------------------------------------------------------ edit (8.6)
const POST_PUBLISH_FIELDS = new Set(['version', 'title', 'body', 'expiresAt', 'fileIds', 'editNote']);

export async function updateNotice(
  ctx: Ctx,
  id: number,
  body: Record<string, unknown> & { version: number },
) {
  const societyId = societyIdOf(ctx);
  const result = await sequelize.transaction(async t => {
    const row = await lockNotice(ctx, id, t, body.version);
    const mode = noticeEditMode(row.status);
    if (mode === 'NONE')
      throw new AppError(
        409,
        ERR.invalidState,
        `A ${row.status.toLowerCase().replace('_', ' ')} notice cannot be edited`,
      );
    const isAuthor = n(row.createdBy) === uid(ctx);
    if (mode === 'FULL') {
      if (!(isAuthor && can(ctx, PERM.noticesCreate)) && !can(ctx, PERM.noticesEdit)) throw forbidden();
    } else {
      if (!can(ctx, PERM.noticesEdit)) throw forbidden();
      await needFeature(ctx, ENT.revisionsAndRecall);
      const extraKeys = Object.keys(body).filter(k => !POST_PUBLISH_FIELDS.has(k));
      if (extraKeys.length)
        throw new ValidationError(
          extraKeys.map(field => ({ field, message: 'Cannot change after publish' })),
        );
      if (!body.editNote)
        throw new ValidationError([{ field: 'editNote', message: 'An edit note is required' }]);
    }
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    const patch: Record<string, unknown> = {};
    const changed: string[] = [];
    const set = (k: string, v: unknown) => {
      patch[k] = v;
      changed.push(k);
    };
    if (has('title')) set('title', String(body.title).trim());
    if (has('body')) {
      const p = prepareBody(body.body as string);
      set('body', p.body);
      patch.bodyText = p.bodyText;
    }
    if (mode === 'TYPO' && (patch.title !== undefined || patch.bodyText !== undefined)) {
      const title = (patch.title as string | undefined) ?? row.title;
      const text = (patch.bodyText as string | undefined) ?? row.bodyText;
      if (
        title.length < LIMITS.titleMin ||
        text.length < LIMITS.bodyTextMin ||
        text.length > LIMITS.bodyTextMax
      )
        throw new AppError(422, ERR.noticeIncomplete, 'The title or body is too short to publish');
    }
    if (has('expiresAt')) {
      const e = body.expiresAt as Date | null;
      if (mode === 'TYPO' && e) {
        const at = now();
        if (!row.publishedAt || e.getTime() <= at.getTime() || !expiryValid(e, row.publishedAt))
          throw new AppError(
            422,
            ERR.noticeExpiryInvalid,
            'The expiry must be 1 hour to 365 days after publish and in the future',
          );
      }
      set('expiresAt', e);
    }
    if (mode === 'FULL') {
      if (has('category')) set('category', body.category);
      if (has('priority')) set('priority', body.priority);
      if (has('locale')) set('locale', body.locale);
      if (has('audience') && body.audience) {
        const a = await checkAudience(ctx, body.audience as NoticeAudience);
        set('audienceType', a.type);
        patch.audienceRelation = a.relation;
        patch.audienceIds = a.ids;
        patch.audienceRoleKeys = a.roleKeys;
        changed.push('audience');
      }
      if (has('channels')) set('channels', await checkChannels(ctx, body.channels as NoticeExtraChannel[]));
      if (has('actions')) {
        const a = await checkActionsShape(ctx, body.actions as NoticeActionInput[]);
        set('actions', a.length ? a : null);
      }
      const requiresAck = has('requiresAck') ? Boolean(body.requiresAck) : Boolean(row.requiresAck);
      if (has('requiresAck')) set('requiresAck', requiresAck);
      if (has('ackDueAt')) {
        if (body.ackDueAt && !requiresAck)
          throw new ValidationError([{ field: 'ackDueAt', message: 'ackDueAt needs requiresAck' }]);
        set('ackDueAt', body.ackDueAt);
      } else if (!requiresAck && row.ackDueAt) set('ackDueAt', null);
      if (has('isPinned')) set('isPinned', Boolean(body.isPinned));
      const utilityKeys = ['utilityType', 'outageStartsAt', 'outageEndsAt'].filter(has);
      if (utilityKeys.length) {
        if (row.kind !== 'UTILITY_SHUTDOWN')
          throw new ValidationError(
            utilityKeys.map(field => ({ field, message: 'Only for utility notices' })),
          );
        for (const k of utilityKeys) set(k, body[k]);
      }
    }
    if (has('fileIds')) {
      const next = body.fileIds as number[];
      const cur = communicationPorts().files.list(n(row.id));
      const removed = cur.filter(f => !next.includes(f));
      const added = next.filter(f => !cur.includes(f));
      if (removed.length) await communicationPorts().files.unlink(ctx, removed, n(row.id), t);
      await linkFiles(ctx, n(row.id), added, t);
      set('attachmentCount', next.length);
      changed[changed.length - 1] = 'fileIds';
    }
    const published = mode === 'TYPO';
    await row.update(
      {
        ...patch,
        ...(published ? { revisionNo: n(row.revisionNo) + 1, lastEditNote: String(body.editNote) } : {}),
        updatedBy: uid(ctx),
        version: n(row.version) + 1,
      } as never,
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.noticeUpdated,
        entityType: ENTITY.notice,
        entityId: n(row.id),
        societyId,
        after: {
          changed: [...new Set(changed)],
          ...(patch.title !== undefined ? { titleLength: String(patch.title).length } : {}),
          ...(patch.bodyText !== undefined ? { bodyLength: String(patch.bodyText).length } : {}),
        },
        reason: published ? String(body.editNote) : null,
      },
      t,
    );
    if (published) t.afterCommit(() => emitNoticeUpdated(societyId, n(row.id), row.status));
    return row;
  });
  return toDetail(ctx, result);
}

// ------------------------------------------------------------------ delete (8.7)
export async function deleteNotice(ctx: Ctx, id: number, version: number): Promise<void> {
  const societyId = societyIdOf(ctx);
  await sequelize.transaction(async t => {
    const row = await lockNotice(ctx, id, t, version);
    const isAuthor = n(row.createdBy) === uid(ctx);
    if (!(isAuthor && can(ctx, PERM.noticesCreate)) && !can(ctx, PERM.noticesDelete)) throw forbidden();
    assertNoticeTransition(row.status, 'delete');
    const open = await getOpenForEntity(societyId, 'NOTICE_PUBLISH', n(row.id));
    if (open) await cancelApproval(ctx, n(open.id), 'Notice deleted', t);
    const files = communicationPorts().files.list(n(row.id));
    if (files.length) await communicationPorts().files.unlink(ctx, files, n(row.id), t);
    await audit(
      ctx,
      {
        action: AUDIT.noticeDeleted,
        entityType: ENTITY.notice,
        entityId: n(row.id),
        societyId,
        before: { status: row.status, titleLength: row.title.length },
      },
      t,
    );
    await row.update({ updatedBy: uid(ctx) } as never, { transaction: t });
    await row.destroy({ transaction: t });
  });
}

// ------------------------------------------------------------------ duplicate (8.12)
export async function duplicateNotice(ctx: Ctx, id: number) {
  const societyId = societyIdOf(ctx);
  const row = await sequelize.transaction(async t => {
    const src = await findNotice(ctx, id, t);
    const open: NoticeActionInput[] = [];
    for (const a of src.actions ?? []) if ((await actionTarget(societyId, a)).open) open.push(a);
    const utility = src.kind === 'UTILITY_SHUTDOWN';
    return createNoticeTx(
      ctx,
      {
        kind: utility ? 'UTILITY_SHUTDOWN' : 'STANDARD',
        title: `Copy of ${src.title}`.slice(0, LIMITS.titleMax),
        body: src.body,
        category: src.category,
        priority: src.priority,
        locale: src.locale,
        audience: {
          type: src.audienceType,
          relation: src.audienceRelation,
          ids: src.audienceIds ?? undefined,
          roleKeys: src.audienceRoleKeys ?? undefined,
        },
        channels: src.channels,
        actions: open,
        requiresAck: Boolean(src.requiresAck),
        utilityType: src.utilityType ?? undefined,
        outageStartsAt: src.outageStartsAt ?? undefined,
        outageEndsAt: src.outageEndsAt ?? undefined,
      },
      t,
      { duplicatedFrom: n(src.id), skipGates: true },
    );
  });
  return toDetail(ctx, row);
}

// ------------------------------------------------------------------ audience preview (8.4)
export async function audiencePreview(ctx: Ctx, a: NoticeAudience) {
  const societyId = societyIdOf(ctx);
  const norm = await checkAudience(ctx, a);
  const resolved = await resolveAudience(societyId, {
    type: norm.type,
    relation: norm.relation,
    ids: norm.ids ?? undefined,
    roleKeys: norm.roleKeys ?? undefined,
  });
  const withLogin = resolved.people.filter(p => p.userId).length;
  const withPush = resolved.userIds.length
    ? (
        await PushSubscription.findAll({
          where: { userId: { [Op.in]: resolved.userIds }, status: 'ACTIVE' },
          attributes: ['userId'],
          group: ['userId'],
        })
      ).length
    : 0;
  const sampleIds = resolved.unitIds;
  const sample = sampleIds.length
    ? (await units.listActive(societyId, { unitIds: sampleIds }))
        .slice(0, 20)
        .map(u => ({ unitId: u.id, unitLabel: u.label }))
    : [];
  return {
    units: resolved.unitIds.length,
    people: resolved.people.length,
    withLogin,
    withoutLogin: resolved.people.length - withLogin,
    withPush,
    sample,
  };
}
