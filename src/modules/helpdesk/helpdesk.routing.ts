import { QueryTypes, type Transaction } from 'sequelize';
import { Ticket, TicketAssignment, User, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, NotFoundError, UnprocessableError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { members } from '../access-control/access-control.public';
import { assertFeature, isFeatureOn } from '../subscriptions/entitlements.service';
import {
  AUDIT,
  ENT,
  ENTITY,
  ERR,
  LOAD_STATUSES,
  type AssignmentEndReason,
  type AssignmentMethod,
} from './helpdesk.constants';
import { helpdeskPorts } from './helpdesk.ports';
import { recomputeNextCheck } from './helpdesk.escalation';
import { ASSIGN_FROM, UNASSIGN_FROM } from './helpdesk.state';
import { addTimeline, emitTicketChanged, lockTicket, societyIdOf } from './helpdesk.shared';
import { calendarFor, endPause } from './helpdesk.sla';
import type { Actor, AssigneeInput, EffectiveCategory } from './helpdesk.types';

/** Assignment records, assignee eligibility (BR-15-35) and auto-assignment (BR-15-37). */

export interface ResolvedAssignee {
  assigneeType: 'MEMBER' | 'STAFF' | 'VENDOR' | 'EXTERNAL';
  assigneeUserId: number | null;
  staffId: number | null;
  vendorId: number | null;
  externalName: string | null;
  externalMobile: string | null;
  label: string;
}

/** BR-15-37, PURE: fewest current assignments, ties by the oldest latest `assignedAt` (never assigned = oldest), then the lowest user id. */
export function pickLeastLoaded(
  c: { userId: number; load: number; lastAssignedAt: Date | null }[],
): number | null {
  if (!c.length) return null;
  const sorted = [...c].sort(
    (a, b) =>
      a.load - b.load ||
      (a.lastAssignedAt?.getTime() ?? -Infinity) - (b.lastAssignedAt?.getTime() ?? -Infinity) ||
      a.userId - b.userId,
  );
  return sorted[0]!.userId;
}

const userName = async (id: number): Promise<string> =>
  (await User.findByPk(id, { attributes: ['name'] }))?.name ?? `User ${id}`;

/** BR-15-35: checks the assignee and builds the assignment fields. 404 `ASSIGNEE_NOT_FOUND`, 422 `ASSIGNEE_NOT_ELIGIBLE`, 402 for plan-gated types. */
export async function validateAssignee(ctx: Ctx, input: AssigneeInput): Promise<ResolvedAssignee> {
  const societyId = societyIdOf(ctx);
  const none = (what: string) => new NotFoundError(ERR.assigneeNotFound, `${what} not found`);
  const base = {
    assigneeUserId: null,
    staffId: null,
    vendorId: null,
    externalName: null,
    externalMobile: null,
  };
  if (input.type === 'MEMBER') {
    if (!input.userId) throw none('Member');
    const rows = await members.listForSociety(societyId, {
      userIds: [input.userId],
      statuses: ['ACTIVE', 'SUSPENDED', 'ENDED'],
    });
    if (!rows.length) throw none('Member');
    const ok = rows.find(r => r.status === 'ACTIVE' && (r.roleScope === 'society' || r.roleScope === 'work'));
    if (!ok) throw new UnprocessableError(ERR.assigneeNotEligible, 'This person cannot be assigned tickets');
    return {
      ...base,
      assigneeType: 'MEMBER',
      assigneeUserId: input.userId,
      label: await userName(input.userId),
    };
  }
  if (input.type === 'STAFF') {
    await assertFeature(ctx, ENT.staffWorkerMaster);
    const s = input.staffId
      ? await helpdeskPorts().staffDirectory.getSummary(societyId, input.staffId)
      : null;
    if (!s) throw none('Staff member');
    if (s.status !== 'ACTIVE')
      throw new UnprocessableError(ERR.assigneeNotEligible, 'This staff member is not active');
    return { ...base, assigneeType: 'STAFF', assigneeUserId: s.userId, staffId: s.id, label: s.name };
  }
  if (input.type === 'VENDOR') {
    await assertFeature(ctx, ENT.vendorDispatch);
    const v = input.vendorId ? await helpdeskPorts().vendors.getAssignable(societyId, input.vendorId) : null;
    if (!v) throw none('Vendor');
    return { ...base, assigneeType: 'VENDOR', vendorId: v.id, label: v.name };
  }
  const name = input.externalName?.trim() ?? '';
  const errors = [];
  if (name.length < 2 || name.length > 120)
    errors.push({ field: 'externalName', message: '2 to 120 characters' });
  if (!/^[6-9]\d{9}$/.test(input.externalMobile ?? ''))
    errors.push({ field: 'externalMobile', message: 'A 10-digit Indian mobile number' });
  if (errors.length) throw new ValidationError(errors);
  return {
    ...base,
    assigneeType: 'EXTERNAL',
    externalName: name,
    externalMobile: input.externalMobile!,
    label: name,
  };
}

/** Default assignee of a category (BR-15-63): same checks as BR-15-35; throws `422 DEFAULT_ASSIGNEE_INVALID` instead of the assignee codes. */
export async function validateDefaultAssignee(ctx: Ctx, input: AssigneeInput): Promise<ResolvedAssignee> {
  try {
    return await validateAssignee(ctx, input);
  } catch (e) {
    if (e instanceof AppError && e.status !== 402)
      throw new UnprocessableError(ERR.defaultAssigneeInvalid, 'The default assignee is not valid', [
        { field: 'defaultAssignee', message: e.message },
      ]);
    throw e;
  }
}

/** The current assignment row of a ticket, if any. */
export const currentAssignment = (ticketId: number, t?: Transaction) =>
  TicketAssignment.findOne({ where: { ticketId, endedAt: null }, transaction: t });

/**
 * Ends the current assignment (BR-15-36, 6.6) and clears the denormalised assignee on `ticket` (the caller saves the ticket). A VENDOR assignment's work order
 * is cancelled through module 21 except when module 21 itself ended it (`WORK_ORDER_CANCELLED`). Returns the ended row or null.
 */
export async function endCurrentAssignment(
  ctx: Ctx,
  ticket: Ticket,
  reason: AssignmentEndReason,
  t: Transaction,
): Promise<TicketAssignment | null> {
  const cur = await currentAssignment(ticket.id, t);
  if (!cur) return null;
  await cur.update(
    { endedAt: now(), endReason: reason, updatedBy: ctx.user?.id ?? null },
    { transaction: t },
  );
  if (cur.assigneeType === 'VENDOR' && cur.workOrderId && reason !== 'WORK_ORDER_CANCELLED')
    await helpdeskPorts().workOrders.cancel(ctx, cur.workOrderId, `Ticket ${ticket.ticketNo}: ${reason}`, t);
  ticket.currentAssignmentId = null;
  ticket.assigneeUserId = null;
  ticket.assigneeLabel = null;
  return cur;
}

/** Inserts the new current assignment and sets the denormalised fields on `ticket` (the caller sets the status and saves). */
export async function createAssignment(
  ctx: Ctx,
  ticket: Ticket,
  a: ResolvedAssignee,
  method: AssignmentMethod,
  opts: { note?: string | null; createWorkOrder?: boolean },
  t: Transaction,
): Promise<TicketAssignment> {
  const row = await TicketAssignment.create(
    {
      societyId: ticket.societyId,
      ticketId: ticket.id,
      assigneeType: a.assigneeType,
      assigneeUserId: a.assigneeUserId,
      staffId: a.staffId,
      vendorId: a.vendorId,
      externalName: a.externalName,
      externalMobile: a.externalMobile,
      assigneeLabel: a.label.slice(0, 150),
      method,
      assignedByUserId: ctx.user?.id ?? null,
      note: opts.note ?? null,
      assignedAt: now(),
      createdBy: ctx.user?.id ?? null,
    },
    { transaction: t },
  );
  if (a.assigneeType === 'VENDOR' && opts.createWorkOrder !== false) {
    const wo = await helpdeskPorts().workOrders.createFromTicket(
      ctx,
      {
        ticketId: ticket.id,
        vendorId: a.vendorId!,
        title: ticket.title,
        priority: ticket.priority,
        assetId: ticket.assetId,
      },
      t,
    );
    await row.update({ workOrderId: wo.workOrderId }, { transaction: t });
  }
  ticket.currentAssignmentId = row.id;
  ticket.assigneeUserId = a.assigneeUserId;
  ticket.assigneeLabel = a.label.slice(0, 150);
  return row;
}

/** Leaves WAITING_ON_RESIDENT inside an assignment change (BR-15-28, BR-15-36: a new person starts fresh). */
async function leavePause(ticket: Ticket, at: Date): Promise<void> {
  if (ticket.status !== 'WAITING_ON_RESIDENT' || !ticket.slaPausedAt) return;
  const cal = await calendarFor(ticket.societyId, ticket.slaCalendar);
  const r = await endPause({ ...ticket.get(), slaPausedAt: ticket.slaPausedAt } as never, at, cal);
  ticket.slaPausedMinutes = r.slaPausedMinutes;
  ticket.resolutionDueAt = r.resolutionDueAt;
  ticket.slaPausedAt = null;
  ticket.waitingReason = null;
  ticket.waitingReminderSentAt = null;
}

/**
 * BR-15-36 assign or reassign (admin): from OPEN, REOPENED, ASSIGNED, IN_PROGRESS or WAITING_ON_RESIDENT to ASSIGNED. Same assignee again is
 * `409 ALREADY_ASSIGNED`; the previous assignment ends REASSIGNED. Returns the saved ticket.
 */
export async function assignTicket(
  ctx: Ctx,
  ticketId: number,
  actor: Actor,
  input: AssigneeInput & { version?: number },
  t: Transaction,
): Promise<Ticket> {
  const societyId = societyIdOf(ctx);
  const ticket = await lockTicket(societyId, ticketId, t, input.version);
  if (!ASSIGN_FROM.includes(ticket.status))
    throw new AppError(409, ERR.invalidTransition, `A ${ticket.status} ticket cannot be assigned`);
  const a = await validateAssignee(ctx, input);
  const cur = await currentAssignment(ticket.id, t);
  const same =
    cur &&
    cur.assigneeType === a.assigneeType &&
    (cur.assigneeUserId ?? null) === a.assigneeUserId &&
    (cur.staffId ?? null) === a.staffId &&
    (cur.vendorId ?? null) === a.vendorId &&
    (cur.externalName ?? null) === a.externalName &&
    (cur.externalMobile ?? null) === a.externalMobile;
  if (same) throw new AppError(409, ERR.alreadyAssigned, 'The ticket is already assigned to this person');
  const at = now();
  const from = ticket.status;
  await endCurrentAssignment(ctx, ticket, 'REASSIGNED', t);
  await leavePause(ticket, at);
  const row = await createAssignment(
    ctx,
    ticket,
    a,
    'MANUAL',
    { note: input.note, createWorkOrder: input.createWorkOrder },
    t,
  );
  ticket.status = 'ASSIGNED';
  ticket.lastActivityAt = at;
  ticket.updatedBy = actor.userId;
  ticket.version += 1;
  await recomputeNextCheck(ticket, t);
  await ticket.save({ transaction: t });
  await addTimeline(
    societyId,
    ticket.id,
    actor,
    {
      kind: 'ASSIGNMENT',
      visibility: 'PUBLIC',
      body: `Assigned to ${a.label}`,
      fromStatus: from,
      toStatus: 'ASSIGNED',
      metadata: { assigneeLabel: a.label, assigneeType: a.assigneeType },
    },
    t,
  );
  await audit(
    ctx,
    {
      action: AUDIT.assigned,
      entityType: ENTITY.ticket,
      entityId: ticket.id,
      entityLabel: ticket.ticketNo,
      after: { assignee: a.label, type: a.assigneeType, assignmentId: row.id },
      societyId,
    },
    t,
  );
  emitTicketChanged(t, ticket, {
    event: 'ASSIGNED',
    fromStatus: from,
    actorUserId: actor.userId,
    data: { assignmentId: row.id, method: 'MANUAL' },
  });
  return ticket;
}

/** ASSIGNED to OPEN (assignment ends UNASSIGNED, work order cancelled). */
export async function unassignTicket(
  ctx: Ctx,
  ticketId: number,
  actor: Actor,
  input: { version?: number; note?: string },
  t: Transaction,
): Promise<Ticket> {
  const societyId = societyIdOf(ctx);
  const ticket = await lockTicket(societyId, ticketId, t, input.version);
  if (!UNASSIGN_FROM.includes(ticket.status))
    throw new AppError(409, ERR.invalidTransition, `A ${ticket.status} ticket cannot be unassigned`);
  const label = ticket.assigneeLabel;
  await endCurrentAssignment(ctx, ticket, 'UNASSIGNED', t);
  ticket.status = 'OPEN';
  ticket.lastActivityAt = now();
  ticket.updatedBy = actor.userId;
  ticket.version += 1;
  await recomputeNextCheck(ticket, t);
  await ticket.save({ transaction: t });
  await addTimeline(
    societyId,
    ticket.id,
    actor,
    {
      kind: 'ASSIGNMENT',
      body: `Unassigned${label ? ` from ${label}` : ''}`,
      fromStatus: 'ASSIGNED',
      toStatus: 'OPEN',
      metadata: { assigneeLabel: label },
    },
    t,
  );
  await audit(
    ctx,
    {
      action: AUDIT.unassigned,
      entityType: ENTITY.ticket,
      entityId: ticket.id,
      entityLabel: ticket.ticketNo,
      societyId,
    },
    t,
  );
  emitTicketChanged(t, ticket, { event: 'UNASSIGNED', fromStatus: 'ASSIGNED', actorUserId: actor.userId });
  return ticket;
}

/** Whether an assignment row is still a valid assignee (reopen, BR-15-41): MEMBER active, STAFF/VENDOR through their ports, EXTERNAL always. */
export async function assignmentStillEligible(ctx: Ctx, a: TicketAssignment): Promise<boolean> {
  try {
    await validateAssignee(ctx, {
      type: a.assigneeType,
      userId: a.assigneeUserId ?? undefined,
      staffId: a.staffId ?? undefined,
      vendorId: a.vendorId ?? undefined,
      externalName: a.externalName ?? undefined,
      externalMobile: a.externalMobile ?? undefined,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * BR-15-37 auto-assignment on create and reopen (`helpdesk.auto_assignment`) by the effective `defaultAssigneeType`. Never fails the caller: any problem
 * leaves the ticket OPEN (or REOPENED). On success sets status ASSIGNED, writes the assignment, the timeline row and the audit row; the caller saves
 * the ticket afterwards when `assigned` is true. Returns whether the ticket got an assignee.
 */
export async function autoAssign(
  ctx: Ctx,
  ticket: Ticket,
  cat: Pick<
    EffectiveCategory,
    'defaultAssigneeType' | 'defaultRoleKey' | 'defaultAssigneeUserId' | 'defaultStaffId' | 'defaultVendorId'
  >,
  method: Extract<AssignmentMethod, 'AUTO_CATEGORY' | 'REOPEN'>,
  actor: Pick<Actor, 'userId' | 'name' | 'role'>,
  t: Transaction,
): Promise<boolean> {
  try {
    const societyId = ticket.societyId;
    if (cat.defaultAssigneeType === 'NONE' || !(await isFeatureOn(societyId, ENT.autoAssignment)))
      return false;
    let resolved: ResolvedAssignee | null = null;
    if (cat.defaultAssigneeType === 'ROLE' && cat.defaultRoleKey) {
      const people = (
        await members.listForSociety(societyId, { roleKeys: [cat.defaultRoleKey], statuses: ['ACTIVE'] })
      ).filter(m => m.roleScope === 'society' || m.roleScope === 'work');
      const ids = [...new Set(people.map(p => p.userId))];
      if (!ids.length) return false;
      const loads = await sequelize.query<{ userId: number; n: number }>(
        `SELECT assigneeUserId AS userId, COUNT(*) AS n FROM tickets WHERE societyId = :societyId AND assigneeUserId IN (:ids) AND status IN (:statuses) GROUP BY assigneeUserId`,
        {
          replacements: { societyId, ids, statuses: [...LOAD_STATUSES] },
          type: QueryTypes.SELECT,
          transaction: t,
        },
      );
      const lasts = await sequelize.query<{ userId: number; at: Date }>(
        `SELECT assigneeUserId AS userId, MAX(assignedAt) AS at FROM ticket_assignments WHERE societyId = :societyId AND assigneeUserId IN (:ids) GROUP BY assigneeUserId`,
        { replacements: { societyId, ids }, type: QueryTypes.SELECT, transaction: t },
      );
      const load = new Map(loads.map(l => [Number(l.userId), Number(l.n)]));
      const last = new Map(lasts.map(l => [Number(l.userId), l.at ? new Date(l.at) : null]));
      const pick = pickLeastLoaded(
        ids.map(userId => ({
          userId,
          load: load.get(userId) ?? 0,
          lastAssignedAt: last.get(userId) ?? null,
        })),
      );
      if (pick) resolved = await validateAssignee(ctx, { type: 'MEMBER', userId: pick });
    } else if (cat.defaultAssigneeType === 'MEMBER' && cat.defaultAssigneeUserId)
      resolved = await validateAssignee(ctx, { type: 'MEMBER', userId: cat.defaultAssigneeUserId });
    else if (cat.defaultAssigneeType === 'STAFF' && cat.defaultStaffId)
      resolved = await validateAssignee(ctx, { type: 'STAFF', staffId: cat.defaultStaffId });
    else if (cat.defaultAssigneeType === 'VENDOR' && cat.defaultVendorId)
      resolved = await validateAssignee(ctx, { type: 'VENDOR', vendorId: cat.defaultVendorId });
    if (!resolved) return false;
    const from = ticket.status;
    const row = await createAssignment({ ...ctx, user: undefined } as Ctx, ticket, resolved, method, {}, t);
    ticket.status = 'ASSIGNED';
    await addTimeline(
      societyId,
      ticket.id,
      actor,
      {
        kind: 'ASSIGNMENT',
        body: `Assigned to ${resolved.label}`,
        fromStatus: from,
        toStatus: 'ASSIGNED',
        metadata: { assigneeLabel: resolved.label, assigneeType: resolved.assigneeType, method },
      },
      t,
    );
    await audit(
      ctx,
      {
        action: AUDIT.assigned,
        entityType: ENTITY.ticket,
        entityId: ticket.id,
        entityLabel: ticket.ticketNo,
        after: { assignee: resolved.label, method, assignmentId: row.id },
        societyId,
      },
      t,
    );
    return true;
  } catch (err) {
    logger.warn({ err, ticketId: ticket.id }, 'helpdesk auto-assignment skipped');
    return false;
  }
}
