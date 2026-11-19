import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import { Notice, NoticeReceipt, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { enqueueAfterCommit } from '../../lib/queue';
import { audit } from '../../utils/audit';
import type { Ctx, SystemCtx } from '../../types/context';
import { AUDIT, COMMUNICATION_QUEUE, ENTITY, JOBS, type NoticeCategory } from './communication.constants';
import { checkAudience } from './communication.composer';
import type { SystemNoticeInput } from './communication.types';
import { prepareBody, createNoticeTx } from './communication.notices.service';
import { n, societyIdOf } from './communication.notices.shared';

/** 8.38 `notices.*` readers and writers for other modules (BR-16-17). */
type C = Ctx | SystemCtx;

/** BR-16-17: a system notice starts PUBLISHED, skips `NOTICE_PUBLISH`, and is unique per source record (a second call returns the first). */
export async function createSystemNotice(
  ctx: C,
  input: SystemNoticeInput,
): Promise<{ noticeId: number; created: boolean }> {
  const societyId = societyIdOf(ctx);
  const find = () =>
    Notice.findOne({
      where: { societyId, sourceRefType: input.sourceRefType, sourceRefId: input.sourceRefId },
      paranoid: false,
    });
  const existing = await find();
  if (existing) return { noticeId: n(existing.id), created: false };
  try {
    return await sequelize.transaction(async t => {
      const aud = await checkAudience(ctx, input.audience, { skipGate: true });
      const { body, bodyText } = prepareBody(input.body);
      const at = now();
      const row = await Notice.create(
        {
          societyId,
          kind: 'SYSTEM',
          category: input.category,
          priority: 'NORMAL',
          title: input.title.trim().slice(0, 150),
          body,
          bodyText,
          locale: 'en-IN',
          status: 'PUBLISHED',
          audienceType: aud.type,
          audienceRelation: aud.relation,
          audienceIds: aud.ids,
          audienceRoleKeys: aud.roleKeys,
          channels: [...new Set(input.channels ?? [])],
          actions: input.actions?.length ? input.actions : null,
          requiresAck: Boolean(input.requiresAck),
          expiresAt: input.expiresAt ?? null,
          sourceModule: input.sourceModule.slice(0, 2),
          sourceRefType: input.sourceRefType,
          sourceRefId: input.sourceRefId,
          publishedAt: at,
          publishedBy: ctx.user?.id ?? null,
          createdBy: ctx.user?.id ?? null,
          updatedBy: ctx.user?.id ?? null,
        } as never,
        { transaction: t },
      );
      await audit(
        ctx as Ctx,
        {
          action: AUDIT.noticePublished,
          entityType: ENTITY.notice,
          entityId: n(row.id),
          societyId,
          after: { kind: 'SYSTEM', sourceModule: input.sourceModule, sourceRefType: input.sourceRefType },
        },
        t,
      );
      enqueueAfterCommit(t, COMMUNICATION_QUEUE, JOBS.noticeFanout, { noticeId: n(row.id), societyId });
      return { noticeId: n(row.id), created: true };
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const again = await find();
      if (again) return { noticeId: n(again.id), created: false };
    }
    throw err;
  }
}

/** 8.38 `notices.createDraft`: a DRAFT for ALL residents in the caller's transaction (module 30 automation); a person edits and publishes it. */
export async function createDraft(
  ctx: C,
  input: { title: string; body: string; category: NoticeCategory },
  t: Transaction,
): Promise<{ noticeId: number }> {
  const row = await createNoticeTx(
    ctx,
    {
      title: input.title,
      body: input.body,
      category: input.category,
      audience: { type: 'ALL', relation: 'ANY' },
    },
    t,
    { skipGates: true },
  );
  return { noticeId: n(row.id) };
}

/** 8.38 `notices.ackSummary` (module 23): counts of the snapshot. */
export async function ackSummary(
  societyId: number,
  noticeId: number,
): Promise<{ audience: number; acknowledged: number }> {
  const row = await Notice.findOne({ where: { id: noticeId, societyId } });
  if (!row) return { audience: 0, acknowledged: 0 };
  return { audience: n(row.recipientCount), acknowledged: n(row.ackCount) };
}

/** 8.38 `notices.hasUserAcknowledged` (module 23 resident rule book). */
export async function hasUserAcknowledged(
  societyId: number,
  noticeId: number,
  userId: number,
): Promise<{ acknowledged: boolean; at: string | null }> {
  const r = await NoticeReceipt.findOne({
    where: { societyId, noticeId, userId, acknowledgedAt: { [Op.ne]: null } },
    order: [['acknowledgedAt', 'ASC']],
  });
  return r ? { acknowledged: true, at: r.acknowledgedAt!.toISOString() } : { acknowledged: false, at: null };
}
