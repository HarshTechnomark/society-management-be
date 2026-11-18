import { UniqueConstraintError, type Transaction } from 'sequelize';
import { Ticket, TicketCategory, TicketComment } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { nextNumber } from '../../utils/numberSequences';
import { AppError, NotFoundError, UnprocessableError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { assertFeature, isFeatureOn } from '../subscriptions/entitlements.service';
import { invoices } from '../billing/billing.public';
import { units, locations } from '../society-setup/society-setup.public';
import { AUDIT, ENT, ENTITY, ERR, LIMITS, type TicketKind } from './helpdesk.constants';
import { findSimilarBuilding, recurringCheck, similarPersonalIds } from './helpdesk.duplicates';
import { recomputeNextCheck } from './helpdesk.escalation';
import { helpdeskPorts } from './helpdesk.ports';
import {
  assertUrgencyAllowed,
  defaultTitle,
  effectivePriority,
  mergeCategory,
  resolveAffected,
  scopeFits,
  validTitle,
  type CategoryRow,
} from './helpdesk.rules';
import { autoAssign } from './helpdesk.routing';
import { ensureSeededOnce } from './helpdesk.seed';
import { addTimeline, emitTicketChanged, societyIdOf, systemActor, userActor } from './helpdesk.shared';
import { calendarFor, slaDue, snapshotFor } from './helpdesk.sla';
import type { CreateTicketInput, CreatedTicket, EffectiveCategory } from './helpdesk.types';

const bad = (field: string, message: string) => new ValidationError([{ field, message }]);

/** BR-15-6 and BR-15-7: loads and merges the category pair. 404 `CATEGORY_NOT_FOUND`, 422 `CATEGORY_ARCHIVED`, `SUBCATEGORY_PARENT_MISMATCH`. */
export async function loadEffectiveCategory(
  societyId: number,
  categoryId: number,
  subCategoryId: number | null | undefined,
  t?: Transaction,
  opts: { allowArchived?: boolean } = {},
): Promise<EffectiveCategory> {
  const top = await TicketCategory.findOne({
    where: { id: categoryId, societyId, parentId: null },
    transaction: t,
  });
  if (!top) throw new NotFoundError(ERR.categoryNotFound, 'Category not found');
  if (top.status !== 'ACTIVE' && !opts.allowArchived)
    throw new UnprocessableError(ERR.categoryArchived, 'This category is archived');
  let sub: TicketCategory | null = null;
  if (subCategoryId) {
    sub = await TicketCategory.findOne({ where: { id: subCategoryId, societyId }, transaction: t });
    if (!sub) throw new NotFoundError(ERR.categoryNotFound, 'Sub-category not found');
    if (sub.parentId !== top.id)
      throw new UnprocessableError(
        ERR.subcategoryParentMismatch,
        'That sub-category belongs to another category',
      );
    if (sub.status !== 'ACTIVE' && !opts.allowArchived)
      throw new UnprocessableError(ERR.categoryArchived, 'This sub-category is archived');
  }
  return mergeCategory(
    top.get() as unknown as CategoryRow,
    sub ? (sub.get() as unknown as CategoryRow) : null,
  );
}

function checkText(kind: TicketKind, input: CreateTicketInput): void {
  const d = input.description ?? '';
  if (d.length > LIMITS.descMax) throw bad('description', 'At most 2000 characters');
  if (kind === 'PERSONAL' && d.trim().length < LIMITS.personalDescMin)
    throw bad('description', 'At least 10 characters');
  if (input.title !== undefined && !validTitle(input.title))
    throw bad('title', '5 to 150 characters, no control characters');
}

function checkSlot(input: CreateTicketInput, at: Date): void {
  const { preferredSlotFrom: from, preferredSlotTo: to } = input;
  if (!from && !to) return;
  if (!from || !to) throw bad('preferredSlotFrom', 'Send both ends of the slot or neither');
  const mins = (to.getTime() - from.getTime()) / 60_000;
  if (mins <= 0 || mins < 30 || mins > 720)
    throw bad('preferredSlotTo', 'The slot must be 30 minutes to 12 hours');
  if (from.getTime() < at.getTime() - 5 * 60_000)
    throw bad('preferredSlotFrom', 'The slot cannot start in the past');
  if (from.getTime() > at.getTime() + 30 * 86_400_000)
    throw bad('preferredSlotFrom', 'Within the next 30 days');
}

/**
 * BR-15-1 to BR-15-18: creates a ticket in the caller's transaction (see the README for what it leaves to the routes). A `ctx.user` is the raiser;
 * jobs and module 30 pass a context without user plus `requesterName`. Returns the created ticket's essentials.
 */
export async function createTicket(
  ctx: Ctx,
  input: CreateTicketInput,
  t: Transaction,
): Promise<CreatedTicket> {
  const societyId = societyIdOf(ctx);
  const at = now();
  await ensureSeededOnce(societyId, t);
  const kind = input.kind;
  const isResidentCaller = input.reporterRole === 'RESIDENT';

  // ---- where (BR-15-2, BR-15-3, BR-15-4, BR-15-5)
  let unitId: number | null = null;
  let locationNodeId: number | null = null;
  let affected: ReturnType<typeof resolveAffected> | null = null;
  let affectedUnitCount: number | null = null;
  let reporterUnitId: number | null = null;
  let pathLabel = '';
  if (kind === 'PERSONAL') {
    if (!input.unitId || input.locationNodeId)
      throw bad('unitId', 'A personal complaint needs a flat and no location');
    const u = await units.get(societyId, input.unitId);
    if (!u || u.status !== 'ACTIVE' || (isResidentCaller && !(ctx.unitIds ?? []).includes(input.unitId)))
      throw new NotFoundError(ERR.unitNotFound, 'Flat not found');
    unitId = u.id;
  } else {
    if (!input.locationNodeId || input.unitId)
      throw bad('locationNodeId', 'A building issue needs a location and no flat');
    const node = await locations.get(societyId, input.locationNodeId);
    if (!node) throw new NotFoundError(ERR.locationNotFound, 'Location not found');
    if (node.status !== 'ACTIVE')
      throw new UnprocessableError(ERR.locationArchived, 'This location is archived');
    locationNodeId = node.id;
    pathLabel = node.pathLabel;
    affected = resolveAffected(input.affectedLevel, node);
    const filter =
      affected.level === 'SOCIETY'
        ? {}
        : affected.level === 'BUILDING'
          ? { buildingId: affected.buildingId! }
          : { buildingId: affected.buildingId!, floor: affected.floor! };
    affectedUnitCount = (await units.listActive(societyId, filter)).length;
    if (isResidentCaller && (ctx.unitIds ?? []).length) {
      const mine = await units.listActive(societyId, { unitIds: ctx.unitIds });
      reporterUnitId = (mine.find(m => m.buildingId === node.buildingId) ?? mine[0])?.id ?? null;
    }
  }

  // ---- what (BR-15-6 to BR-15-9)
  const cat = await loadEffectiveCategory(societyId, input.categoryId, input.subCategoryId, t);
  if (!scopeFits(cat.scope, kind))
    throw new UnprocessableError(ERR.categoryScopeMismatch, 'This category is not for this kind of issue');
  assertUrgencyAllowed(kind, input.urgency, isResidentCaller);
  const { priority, source } = effectivePriority(cat.defaultPriority, input.urgency, input.priority);
  checkText(kind, input);
  const title = input.title?.trim() || defaultTitle(cat.subCategoryName ?? cat.categoryName, pathLabel);
  if (kind === 'PERSONAL' && input.title === undefined) throw bad('title', 'A title is needed');
  const fileIds = [...new Set(input.fileIds ?? [])];
  if (fileIds.length > LIMITS.maxFiles) throw bad('fileIds', 'At most 6 files');
  if (fileIds.length) await assertFeature(ctx, ENT.attachments);
  if (input.preferredSlotFrom || input.preferredSlotTo) {
    if (kind !== 'PERSONAL') throw bad('preferredSlotFrom', 'A visit slot is for personal complaints');
    await assertFeature(ctx, ENT.preferredSlot);
    checkSlot(input, at);
  }

  // ---- who (BR-15-12)
  const requesterUserId =
    input.requesterUserId !== undefined ? input.requesterUserId : (ctx.user?.id ?? null);
  const requesterName = (input.requesterName ?? ctx.user?.name ?? 'Resident').slice(0, 120);
  const raisedBy = ctx.user?.id;
  if (!raisedBy)
    throw new Error(
      'createTicket: a signed-in raiser is required (use the SYSTEM entry of module 30 through tickets.createInternal)',
    );

  // ---- duplicates (BR-15-17, BR-15-18)
  let duplicateReason: string | null = null;
  if (kind === 'BUILDING') {
    const similar = await findSimilarBuilding(
      societyId,
      { locationNodeId: locationNodeId!, categoryId: cat.categoryId, buildingId: affected!.buildingId },
      t,
    );
    if (similar.length) {
      const reason = input.duplicateReason?.trim();
      if (!reason)
        throw new AppError(
          409,
          ERR.similarIssueExists,
          'A similar issue is already reported',
          similar.map(s => ({ field: 'ticketId', message: String(s.id) })),
        );
      if (reason.length < 10 || reason.length > 300) throw bad('duplicateReason', '10 to 300 characters');
      duplicateReason = reason;
    }
  }

  // ---- disputes (BR-15-13)
  if (input.invoiceId) {
    if (kind !== 'PERSONAL' || !cat.linksInvoice)
      throw new UnprocessableError(ERR.invoiceNotDisputable, 'This invoice cannot be disputed here');
    const inv = await invoices.get(societyId, input.invoiceId);
    if (!inv) throw new NotFoundError(ERR.invoiceNotFound, 'Invoice not found');
    if (inv.unitId !== unitId || inv.status === 'CANCELLED')
      throw new UnprocessableError(ERR.invoiceNotDisputable, 'This invoice cannot be disputed here');
  }

  // ---- SLA (BR-15-23 to BR-15-26)
  const snap = await snapshotFor(societyId, cat, priority, t);
  const due = await slaDue(snap, at, 0, await calendarFor(societyId, snap.slaCalendar));

  const ticketNo = await nextNumber(societyId, 'TICKET', { transaction: t });
  let ticket: Ticket;
  try {
    ticket = await Ticket.create(
      {
        societyId,
        ticketNo,
        kind,
        unitId,
        locationNodeId,
        affectedLevel: affected?.level ?? null,
        affectedBuildingId: affected?.buildingId ?? null,
        affectedFloor: affected?.floor ?? null,
        affectedUnitCount,
        reporterUnitId,
        assetId: input.assetId ?? null,
        categoryId: cat.categoryId,
        subCategoryId: cat.subCategoryId,
        invoiceId: input.invoiceId ?? null,
        title,
        description: input.description?.trim() ?? '',
        priority,
        prioritySource: source,
        status: 'OPEN',
        createdAt: at,
        channel: input.channel,
        reporterRole: input.reporterRole,
        raisedByUserId: raisedBy,
        requesterUserId,
        requesterName,
        duplicateReason,
        ...snap,
        slaCycle: 1,
        slaStartAt: at,
        ...due,
        isChargeable: kind === 'PERSONAL' && cat.isChargeable,
        preferredSlotFrom: input.preferredSlotFrom ?? null,
        preferredSlotTo: input.preferredSlotTo ?? null,
        lastActivityAt: at,
        createdBy: raisedBy,
        updatedBy: raisedBy,
      },
      { transaction: t },
    );
  } catch (e) {
    if (e instanceof UniqueConstraintError && input.invoiceId)
      throw new AppError(409, ERR.invoiceDisputeOpen, 'There is already an open dispute for this invoice');
    throw e;
  }
  if (input.invoiceId) await invoices.setDisputed(ctx, input.invoiceId, true, t);
  if (fileIds.length) await helpdeskPorts().files.link(ctx, fileIds, 'ticket', ticket.id, t);

  const actor = userActor(
    ctx,
    new Set(['REQUESTER']),
    isResidentCaller
      ? 'RESIDENT'
      : input.reporterRole === 'GUARD'
        ? 'GUARD'
        : input.reporterRole === 'STAFF'
          ? 'STAFF'
          : 'ADMIN',
  );
  await addTimeline(
    societyId,
    ticket.id,
    actor,
    { kind: 'STATUS_CHANGE', fromStatus: null, toStatus: 'OPEN', body: 'Ticket raised' },
    t,
  );
  if (duplicateReason)
    await TicketComment.create(
      {
        societyId,
        ticketId: ticket.id,
        kind: 'SYSTEM',
        visibility: 'INTERNAL',
        authorUserId: raisedBy,
        authorRole: 'SYSTEM',
        authorName: 'System',
        body: `Reported although similar issues exist: ${duplicateReason}`,
        createdBy: raisedBy,
      },
      { transaction: t },
    );

  // ---- recurring (BR-15-16), auto-assignment (BR-15-37)
  if (await isFeatureOn(societyId, ENT.recurring))
    ticket.isRecurring = await recurringCheck(
      societyId,
      {
        kind,
        locationNodeId,
        unitId,
        categoryId: cat.categoryId,
        assetId: ticket.assetId,
        ticketId: ticket.id,
      },
      t,
    );
  const assigned = await autoAssign(ctx, ticket, cat, 'AUTO_CATEGORY', systemActor(ctx), t);
  await recomputeNextCheck(ticket, t);
  await ticket.save({ transaction: t });

  const similarOpenTicketIds =
    kind === 'PERSONAL' && (await isFeatureOn(societyId, ENT.duplicateDetection))
      ? await similarPersonalIds(societyId, unitId!, cat.categoryId, ticket.id, t)
      : [];
  await audit(
    ctx,
    {
      action: AUDIT.ticketCreated,
      entityType: ENTITY.ticket,
      entityId: ticket.id,
      entityLabel: ticketNo,
      // BR-15 section 13: a personal complaint's text never goes into the audit log, only its length
      after: {
        kind,
        priority,
        category: cat.categoryName,
        channel: input.channel,
        ...(kind === 'PERSONAL'
          ? { descriptionLength: ticket.description.length }
          : { description: ticket.description }),
      },
      societyId,
    },
    t,
  );
  emitTicketChanged(t, ticket, {
    event: 'CREATED',
    actorUserId: raisedBy,
    data: { safety: kind === 'BUILDING' && priority === 'P1' && cat.isSafety, assigned },
  });
  t.afterCommit(() => helpdeskPorts().reportsCache.touch(societyId, 'helpdesk'));
  return {
    id: ticket.id,
    ticketNo,
    status: ticket.status,
    priority,
    affectedUnitCount,
    assigned,
    similarOpenTicketIds,
    isRecurring: ticket.isRecurring,
  };
}
