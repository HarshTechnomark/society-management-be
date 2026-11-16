import { moneyTx } from './payments.shared';
import { Op, type Transaction } from 'sequelize';
import { Collection, CollectionRequest } from '../../models';
import { formatRupees } from '../../lib/money';
import { now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { ConflictError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { invoices } from '../billing/billing.public';
import { societyToday } from '../billing/billing.runs.shared';
import type { UnitDto } from '../society-setup/society-setup.types';
import { AUDIT, ENTITY, ERR, APPROVAL_TYPES, NOTIFY } from './payments.constants';
import { paymentsPorts } from './payments.ports';
import { collectionDetail, lockCollection } from './payments.collections.service';
import {
  billToOf,
  billToUserIds,
  emitProgress,
  invalidState,
  noAudience,
  resolveAudience,
  societyIdOf,
  staleVersion,
  touchReports,
  userIdOf,
} from './payments.collections.shared';
import { requestFundHint } from './payments.collections.hints';
import { recomputeTotals } from './payments.collections.totals';

/**
 * Collection workflow (6.4, 6.11, 8.22): submit, the module 14 approval callbacks, publish, remind, close and cancel.
 * Lock order inside a transaction: approvals request, then the collection row.
 */
export const MAX_REMINDERS = { optional: 2, mandatory: 10 } as const;
export const REMINDER_GAP_HOURS = 24;

const noticeCategory = (kind: string) => (kind === 'FESTIVAL' || kind === 'EVENT' ? 'FESTIVAL' : 'FINANCE');

// ------------------------------------------------------------------ approval type hooks (module 14)

async function describeCollection(id: number) {
  const c = await Collection.findByPk(id);
  if (!c) return [];
  return [
    { label: 'Title', value: c.title, kind: 'text' as const },
    { label: 'Kind', value: c.kind, kind: 'text' as const },
    { label: 'Target', value: formatRupees(Number(c.targetPaise)), kind: 'money' as const },
    { label: 'Due date', value: c.dueDate, kind: 'date' as const },
    { label: 'Mandatory', value: c.isMandatory ? 'Yes' : 'No', kind: 'text' as const },
  ];
}

export async function onCollectionApproved(ctx: Ctx, id: number, t: Transaction): Promise<void> {
  const societyId = societyIdOf(ctx);
  const c = await lockCollection(societyId, id, t);
  if (c.status === 'APPROVED') return;
  if (c.status !== 'PENDING_APPROVAL') throw invalidState('This collection is not waiting for approval');
  const approver = userIdOf(ctx);
  if (approver !== null && Number(c.createdBy) === approver)
    throw new ConflictError(ERR.makerChecker, 'The person who created this collection cannot approve it');
  await c.update(
    {
      status: 'APPROVED',
      approvedBy: approver,
      approvedAt: now(),
      rejectedReason: null,
      updatedBy: approver,
      version: Number(c.version) + 1,
    },
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: AUDIT.collectionApproved,
      entityType: 'collection',
      entityId: id,
      entityLabel: c.title,
      societyId,
    },
    t,
  );
  touchReports(t, societyId);
}

export async function onCollectionRejected(
  ctx: Ctx,
  id: number,
  reason: string,
  t: Transaction,
): Promise<void> {
  const societyId = societyIdOf(ctx);
  const c = await lockCollection(societyId, id, t);
  if (c.status !== 'PENDING_APPROVAL') return;
  await c.update(
    {
      status: 'REJECTED',
      rejectedReason: reason.slice(0, 500),
      updatedBy: userIdOf(ctx),
      version: Number(c.version) + 1,
    },
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: AUDIT.collectionRejected,
      entityType: 'collection',
      entityId: id,
      entityLabel: c.title,
      societyId,
      reason,
    },
    t,
  );
}

export async function onCollectionChangesRequested(ctx: Ctx, id: number, t: Transaction): Promise<void> {
  const societyId = societyIdOf(ctx);
  const c = await lockCollection(societyId, id, t);
  if (c.status !== 'PENDING_APPROVAL') return;
  await c.update(
    {
      status: 'CHANGES_REQUESTED',
      rejectedReason: 'Changes requested by the approver',
      updatedBy: userIdOf(ctx),
      version: Number(c.version) + 1,
    },
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: AUDIT.collectionChangesRequested,
      entityType: 'collection',
      entityId: id,
      entityLabel: c.title,
      societyId,
    },
    t,
  );
}

export async function onCollectionCancelled(ctx: Ctx, id: number, t: Transaction): Promise<void> {
  const societyId = societyIdOf(ctx);
  const c = await lockCollection(societyId, id, t);
  if (c.status !== 'PENDING_APPROVAL') return;
  await c.update(
    { status: 'DRAFT', updatedBy: userIdOf(ctx), version: Number(c.version) + 1 },
    { transaction: t },
  );
}

export function registerCollectionApprovalType(): void {
  paymentsPorts().approvals.registerType({
    type: APPROVAL_TYPES.collectionPublish,
    onApproved: onCollectionApproved,
    onRejected: onCollectionRejected,
    onChangesRequested: onCollectionChangesRequested,
    onCancelled: onCollectionCancelled,
    describe: describeCollection,
  });
}

// ------------------------------------------------------------------ submit

export async function submitCollection(ctx: Ctx, id: number, version: number) {
  const societyId = societyIdOf(ctx);
  const today = await societyToday(societyId);
  await moneyTx(async t => {
    const approvals = paymentsPorts().approvals;
    await approvals.lockOpenForEntity(societyId, ENTITY.collection, id, t);
    const c = await lockCollection(societyId, id, t);
    if (!['DRAFT', 'REJECTED', 'CHANGES_REQUESTED'].includes(c.status))
      throw invalidState('Only a draft, rejected or changes-requested collection can be submitted');
    if (Number(c.version) !== version) throw staleVersion();
    if (c.dueDate < today)
      throw new UnprocessableError(ERR.collectionDuePast, 'The due date is in the past', [
        { field: 'dueDate', message: 'Edit the due date first' },
      ]);
    const uid = userIdOf(ctx);
    const payload = { categoryKey: c.kind, kind: c.kind, isMandatory: Boolean(c.isMandatory) };
    const title = `${c.title} (${formatRupees(Number(c.targetPaise))})`;
    let requestId: number;
    let status: 'PENDING' | 'APPROVED';
    if (c.status === 'CHANGES_REQUESTED' && c.approvalRequestId) {
      await approvals.resubmit(
        ctx,
        Number(c.approvalRequestId),
        { title, amountPaise: Number(c.targetPaise), payload },
        t,
      );
      requestId = Number(c.approvalRequestId);
      status = 'PENDING';
    } else {
      const r = await approvals.request(
        ctx,
        {
          type: APPROVAL_TYPES.collectionPublish,
          entityType: ENTITY.collection,
          entityId: Number(c.id),
          title,
          amountPaise: Number(c.targetPaise),
          summary: `${c.kind}: ${c.title}`,
          payload,
          categoryKey: c.kind,
        } as never,
        t,
      );
      requestId = r.id;
      status = r.status;
    }
    await c.update(
      {
        status: status === 'APPROVED' ? 'APPROVED' : 'PENDING_APPROVAL',
        approvalRequestId: requestId,
        submittedAt: now(),
        rejectedReason: null,
        ...(status === 'APPROVED' ? { approvedBy: uid, approvedAt: now() } : {}),
        updatedBy: uid,
        version: Number(c.version) + 1,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.collectionSubmitted,
        entityType: 'collection',
        entityId: id,
        entityLabel: c.title,
        societyId,
        after: { approvalRequestId: requestId, status: c.status },
      },
      t,
    );
    touchReports(t, societyId);
  });
  return collectionDetail(societyId, id);
}

// ------------------------------------------------------------------ requests (publish and add units)

export function requestAmounts(c: Collection): { amountPaise: number; minAmountPaise: number } {
  return {
    amountPaise: c.amountMode === 'VOLUNTARY' ? 0 : Number(c.amountPerUnitPaise),
    minAmountPaise: c.amountMode === 'MIN_PER_UNIT' ? Number(c.minAmountPaise) : 0,
  };
}

/**
 * Creates one request per unit (6.11 step 3) and, for a mandatory collection, the ad-hoc invoice through module 11.
 * `skipNoBillTo`: a mandatory collection cannot bill a flat nobody owns, so publishing skips those flats; adding a flat by
 * hand raises module 11's `422 NO_BILL_TO` instead.
 */
export async function createRequestsFor(
  ctx: Ctx,
  c: Collection,
  list: UnitDto[],
  today: string,
  t: Transaction,
  skipNoBillTo: boolean,
): Promise<{ created: CollectionRequest[]; skippedNoBillTo: number[] }> {
  const created: CollectionRequest[] = [];
  const skippedNoBillTo: number[] = [];
  const uid = userIdOf(ctx);
  const { amountPaise, minAmountPaise } = requestAmounts(c);
  for (let i = 0; i < list.length; i += 500) {
    for (const u of list.slice(i, i + 500)) {
      const billTo = await billToOf(u.id, today);
      if (c.isMandatory && !billTo && skipNoBillTo) {
        skippedNoBillTo.push(u.id);
        continue;
      }
      const req = await CollectionRequest.create(
        {
          societyId: Number(c.societyId),
          collectionId: Number(c.id),
          unitId: u.id,
          billToResidentId: billTo ? billTo.residentId : null,
          amountPaise,
          minAmountPaise,
          paidPaise: 0,
          status: 'OPEN',
          invoiceId: null,
          lastPaidAt: null,
          waivedReason: null,
          createdBy: uid,
          updatedBy: uid,
          version: 1,
        },
        { transaction: t },
      );
      if (c.isMandatory) {
        requestFundHint.set(Number(req.id), Number(c.fundId));
        try {
          const inv = await invoices.createAdHoc(
            ctx,
            {
              unitId: u.id,
              chargeHeadKey: 'COLLECTION',
              amountPaise,
              refType: 'collection_request',
              refId: Number(req.id),
              dueDate: c.dueDate,
            },
            t,
          );
          await req.update({ invoiceId: inv.invoiceId }, { transaction: t });
        } finally {
          requestFundHint.delete(Number(req.id));
        }
      }
      created.push(req);
    }
  }
  return { created, skippedNoBillTo };
}

// ------------------------------------------------------------------ notifications and notice (after commit)

async function notifyBillTos(
  societyId: number,
  collectionId: number,
  template: string,
  statuses: string[] | null,
  data: Record<string, unknown>,
): Promise<number> {
  const reqs = await CollectionRequest.findAll({
    where: { collectionId, ...(statuses ? { status: { [Op.in]: statuses } } : {}) },
    attributes: ['billToResidentId'],
  });
  const userIds = await billToUserIds(
    societyId,
    reqs.map(r => (r.billToResidentId ? Number(r.billToResidentId) : null)),
  );
  if (userIds.length) {
    try {
      await paymentsPorts().notifications.send(template, userIds, { societyId, collectionId, ...data });
    } catch (err) {
      logger.error({ err, template }, 'collection notification failed');
    }
  }
  return userIds.length;
}

async function postNotice(ctx: Ctx, c: Collection): Promise<void> {
  try {
    const endOfDue = new Date(`${c.dueDate}T23:59:59.999+05:30`);
    const res = await paymentsPorts().notices.createSystemNotice(ctx, {
      sourceModule: '12',
      sourceRefType: 'collection',
      sourceRefId: Number(c.id),
      title: `${c.title} contribution`,
      body: c.purpose,
      category: noticeCategory(c.kind),
      audience:
        c.audienceType === 'BUILDINGS' ? { type: 'BUILDINGS', buildingIds: c.audienceIds } : { type: 'ALL' },
      actions: [{ type: 'PAY_COLLECTION', refId: Number(c.id), label: 'Pay' }],
      expiresAt: endOfDue,
    });
    await Collection.update({ noticeId: res.noticeId }, { where: { id: c.id } });
  } catch (err) {
    logger.error({ err, collectionId: c.id }, 'collection notice failed');
  }
}

async function recallNotice(ctx: Ctx, id: number, reason: string): Promise<void> {
  try {
    await paymentsPorts().notices.recallBySource(ctx, 'collection', id, reason);
  } catch (err) {
    logger.error({ err, collectionId: id }, 'collection notice recall failed');
  }
}

// ------------------------------------------------------------------ publish (6.11)

export async function publishCollection(ctx: Ctx, id: number, version: number) {
  const societyId = societyIdOf(ctx);
  const today = await societyToday(societyId);
  const out = await moneyTx(async t => {
    await paymentsPorts().approvals.lockOpenForEntity(societyId, ENTITY.collection, id, t);
    const c = await lockCollection(societyId, id, t);
    if (c.status !== 'APPROVED') throw invalidState('Only an approved collection can be published');
    if (Number(c.version) !== version) throw staleVersion();
    if (c.dueDate < today)
      throw new UnprocessableError(ERR.collectionDuePast, 'The due date is in the past', [
        { field: 'dueDate', message: 'Edit the due date and submit again' },
      ]);
    const audience = await resolveAudience(societyId, c, today);
    if (audience.length === 0) throw noAudience();
    const { created, skippedNoBillTo } = await createRequestsFor(ctx, c, audience, today, t, true);
    if (created.length === 0) throw noAudience();
    const uid = userIdOf(ctx);
    await c.update(
      {
        status: 'PUBLISHED',
        publishedAt: now(),
        publishedBy: uid,
        requestCount: created.length,
        updatedBy: uid,
        version: Number(c.version) + 1,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.collectionPublished,
        entityType: 'collection',
        entityId: id,
        entityLabel: c.title,
        societyId,
        after: { requestCount: created.length, skippedNoBillTo },
      },
      t,
    );
    touchReports(t, societyId);
    return c;
  });
  await notifyBillTos(societyId, id, NOTIFY.collectionPublished, null, {
    title: out.title,
    dueDate: out.dueDate,
    isMandatory: Boolean(out.isMandatory),
  });
  if (out.sendNotice) await postNotice(ctx, out);
  emitProgress(out);
  return collectionDetail(societyId, id);
}

// ------------------------------------------------------------------ remind (BR-12-43)

export async function remindCollection(ctx: Ctx, id: number, version: number | null) {
  const societyId = societyIdOf(ctx);
  const c = await moneyTx(async t => {
    const c = await lockCollection(societyId, id, t);
    if (c.status !== 'PUBLISHED') throw invalidState('Only a published collection can be reminded');
    if (version !== null && Number(c.version) !== version) throw staleVersion();
    const max = c.isMandatory ? MAX_REMINDERS.mandatory : MAX_REMINDERS.optional;
    if (Number(c.reminderCount) >= max)
      throw new UnprocessableError(ERR.reminderLimitReached, `At most ${max} reminders for this collection`);
    if (c.lastReminderAt && now().getTime() - c.lastReminderAt.getTime() < REMINDER_GAP_HOURS * 3_600_000)
      throw new UnprocessableError(ERR.reminderTooSoon, 'Wait 24 hours between reminders');
    await c.update(
      { reminderCount: Number(c.reminderCount) + 1, lastReminderAt: now(), version: Number(c.version) + 1 },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.collectionReminderSent,
        entityType: 'collection',
        entityId: id,
        entityLabel: c.title,
        societyId,
        after: { reminderCount: c.reminderCount },
      },
      t,
    );
    return c;
  });
  const sentTo = await notifyBillTos(societyId, id, NOTIFY.collectionReminder, ['OPEN', 'PART_PAID'], {
    title: c.title,
    dueDate: c.dueDate,
  });
  return { sentTo, reminderCount: Number(c.reminderCount) };
}

// ------------------------------------------------------------------ close (BR-12-44)

export async function closeCollection(ctx: Ctx, id: number, version: number | null, reason: string) {
  const societyId = societyIdOf(ctx);
  const c = await moneyTx(async t => {
    const c = await lockCollection(societyId, id, t);
    if (c.status !== 'PUBLISHED') throw invalidState('Only a published collection can be closed');
    if (version !== null && Number(c.version) !== version) throw staleVersion();
    const uid = userIdOf(ctx);
    if (!c.isMandatory)
      await CollectionRequest.update(
        { status: 'CANCELLED', updatedBy: uid },
        { where: { collectionId: id, status: { [Op.in]: ['OPEN', 'PART_PAID'] } }, transaction: t },
      );
    await c.update(
      {
        status: 'CLOSED',
        closedAt: now(),
        closedBy: uid,
        closeReason: reason,
        updatedBy: uid,
        version: Number(c.version) + 1,
      },
      { transaction: t },
    );
    await recomputeTotals(c, t);
    await audit(
      ctx,
      {
        action: AUDIT.collectionClosed,
        entityType: 'collection',
        entityId: id,
        entityLabel: c.title,
        societyId,
        reason,
      },
      t,
    );
    touchReports(t, societyId);
    return c;
  });
  await notifyBillTos(societyId, id, NOTIFY.collectionClosed, null, { title: c.title });
  if (c.sendNotice) await recallNotice(ctx, id, 'Collection closed');
  emitProgress(c);
  return collectionDetail(societyId, id);
}

// ------------------------------------------------------------------ cancel (BR-12-44)

export async function cancelCollection(ctx: Ctx, id: number, version: number, reason: string) {
  const societyId = societyIdOf(ctx);
  const { c, wasPublished } = await moneyTx(async t => {
    await paymentsPorts().approvals.lockOpenForEntity(societyId, ENTITY.collection, id, t);
    const c = await lockCollection(societyId, id, t);
    if (!['DRAFT', 'REJECTED', 'APPROVED', 'PUBLISHED'].includes(c.status))
      throw invalidState('This collection cannot be cancelled in its current state');
    if (Number(c.version) !== version) throw staleVersion();
    const wasPublished = c.status === 'PUBLISHED';
    if (wasPublished && (c.isMandatory || Number(c.collectedPaise) > 0))
      throw new ConflictError(
        ERR.collectionHasPayments,
        c.isMandatory
          ? 'A published mandatory collection cannot be cancelled'
          : 'Money was already collected',
      );
    const uid = userIdOf(ctx);
    if (wasPublished)
      await CollectionRequest.update(
        { status: 'CANCELLED', updatedBy: uid },
        { where: { collectionId: id, status: { [Op.in]: ['OPEN', 'PART_PAID'] } }, transaction: t },
      );
    await c.update(
      {
        status: 'CANCELLED',
        closedAt: now(),
        closedBy: uid,
        closeReason: reason,
        updatedBy: uid,
        version: Number(c.version) + 1,
      },
      { transaction: t },
    );
    if (wasPublished) await recomputeTotals(c, t);
    await audit(
      ctx,
      {
        action: AUDIT.collectionCancelled,
        entityType: 'collection',
        entityId: id,
        entityLabel: c.title,
        societyId,
        reason,
      },
      t,
    );
    touchReports(t, societyId);
    return { c, wasPublished };
  });
  if (wasPublished) {
    await notifyBillTos(societyId, id, NOTIFY.collectionCancelled, null, { title: c.title, reason });
    await recallNotice(ctx, id, 'Collection cancelled');
    emitProgress(c);
  }
  return collectionDetail(societyId, id);
}
