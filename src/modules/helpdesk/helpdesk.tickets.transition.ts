import { UniqueConstraintError, type Transaction } from 'sequelize';
import { Ticket } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { invoices } from '../billing/billing.public';
import { societyToday } from '../billing/billing.runs.shared';
import {
  AUDIT,
  ENT,
  ENTITY,
  ERR,
  SETTING,
  WAITING_REASONS,
  type TicketStatus,
  type TransitionAction,
} from './helpdesk.constants';
import { recomputeNextCheck, settleBreach } from './helpdesk.escalation';
import { helpdeskPorts } from './helpdesk.ports';
import { assertTransition } from './helpdesk.state';
import {
  assignmentStillEligible,
  autoAssign,
  currentAssignment,
  endCurrentAssignment,
} from './helpdesk.routing';
import {
  addTimeline,
  emitTicketChanged,
  factsOf,
  lockTicket,
  setting,
  societyIdOf,
  systemActor,
} from './helpdesk.shared';
import { calendarFor, endPause, snapshotFor, slaDue } from './helpdesk.sla';
import { loadEffectiveCategory } from './helpdesk.tickets.core';
import type { Actor, TransitionInput } from './helpdesk.types';

const bad = (field: string, message: string) => new ValidationError([{ field, message }]);
const needText = (v: string | undefined, field: string, min: number, max: number): string => {
  const s = (v ?? '').trim();
  if (s.length < min || s.length > max) throw bad(field, `${min} to ${max} characters`);
  return s;
};

export interface TransitionOptions {
  /** Merge (15.2): the duplicate is cancelled with this primary; the assignment ends MERGED. */
  mergedIntoTicketId?: number;
  mergedIntoTicketNo?: string;
}

const AUDIT_FOR: Record<TransitionAction, string> = {
  START: AUDIT.statusChanged,
  WAIT_ON_RESIDENT: AUDIT.statusChanged,
  RESUME: AUDIT.statusChanged,
  RESOLVE: AUDIT.resolved,
  CLOSE: AUDIT.closed,
  REOPEN: AUDIT.reopened,
  CANCEL: AUDIT.cancelled,
};

/** BR-15-28: leave the pause (calendar minutes added, due time recomputed). */
async function leavePause(ticket: Ticket, at: Date): Promise<void> {
  if (!ticket.slaPausedAt) return;
  const cal = await calendarFor(ticket.societyId, ticket.slaCalendar);
  const r = await endPause(
    {
      slaCalendar: ticket.slaCalendar,
      resolutionMinutes: ticket.resolutionMinutes,
      slaStartAt: ticket.slaStartAt,
      slaPausedAt: ticket.slaPausedAt,
      slaPausedMinutes: ticket.slaPausedMinutes,
    },
    at,
    cal,
  );
  ticket.slaPausedMinutes = r.slaPausedMinutes;
  ticket.resolutionDueAt = r.resolutionDueAt;
  ticket.slaPausedAt = null;
  ticket.waitingReason = null;
  ticket.waitingReminderSentAt = null;
}

/** BR-15-27: set once per SLA cycle at the first START, WAIT_ON_RESIDENT, RESOLVE or public staff comment. */
export function markFirstResponse(ticket: Ticket, at: Date): void {
  if (!ticket.firstResponseAt) {
    ticket.firstResponseAt = at;
    if (at > ticket.responseDueAt) ticket.responseBreached = true;
  }
}

/**
 * BR-15-29: priority or category changed. Re-snapshots the policy numbers for the (possibly new) category and priority and recomputes both due times from
 * the unchanged `slaStartAt` and the minutes already paused. Breach flags stay set; fired escalations are not repeated (they are keyed by rule and cycle).
 * Does not save; the caller does.
 */
export async function recomputeSla(ticket: Ticket, t: Transaction): Promise<void> {
  const cat = await loadEffectiveCategory(ticket.societyId, ticket.categoryId, ticket.subCategoryId, t, {
    allowArchived: true,
  });
  const snap = await snapshotFor(ticket.societyId, cat, ticket.priority, t);
  Object.assign(ticket, snap);
  const due = await slaDue(
    snap,
    ticket.slaStartAt,
    ticket.slaPausedMinutes,
    await calendarFor(ticket.societyId, snap.slaCalendar),
  );
  ticket.responseDueAt = due.responseDueAt;
  ticket.resolutionDueAt = due.resolutionDueAt;
  await recomputeNextCheck(ticket, t);
}

async function resolveCharge(
  ctx: Ctx,
  ticket: Ticket,
  input: TransitionInput,
  t: Transaction,
): Promise<'invoiced' | 'waived' | null> {
  if (ticket.chargeStatus !== 'APPROVED') return null;
  const societyId = ticket.societyId;
  if (input.waiveReason !== undefined) {
    ticket.chargeWaiveReason = needText(input.waiveReason, 'waiveReason', 5, 300);
    ticket.chargeStatus = 'WAIVED';
    ticket.chargeFinalPaise = 0;
    return 'waived';
  }
  const final = input.chargeFinalPaise;
  if (final === undefined)
    throw new UnprocessableError(ERR.chargeFinalRequired, 'Enter the final charge or waive it');
  const tolerance = await setting<number>(societyId, SETTING.chargeTolerancePct);
  const max = Math.floor((Number(ticket.chargeEstimatePaise) * (100 + tolerance)) / 100);
  if (!Number.isInteger(final) || final < 1 || final > max)
    throw new UnprocessableError(ERR.chargeExceedsEstimate, `The final charge can be at most ${max} paise`, [
      { field: 'chargeFinalPaise', message: `At most ${max} paise` },
    ]);
  const dueDays = await setting<number>(societyId, SETTING.chargeDueDays);
  const today = await societyToday(societyId);
  const due = new Date(Date.parse(`${today}T00:00:00Z`) + dueDays * 86_400_000).toISOString().slice(0, 10);
  const inv = await invoices.createAdHoc(
    ctx,
    {
      unitId: ticket.unitId!,
      chargeHeadKey: 'CHARGEABLE_WORK',
      amountPaise: final,
      refType: 'ticket',
      refId: ticket.id,
      dueDate: due,
    },
    t,
  );
  ticket.chargeFinalPaise = final;
  ticket.chargeInvoiceId = inv.invoiceId;
  ticket.chargeStatus = 'INVOICED';
  return 'invoiced';
}

/**
 * Every transition of 6.2 that is not an assignment: START, WAIT_ON_RESIDENT, RESUME, RESOLVE, CLOSE, REOPEN, CANCEL. Takes the row lock, checks the
 * table for this actor (`409 TICKET_INVALID_TRANSITION` with the allowed actions), applies the BR-15 rules of the action, moves the SLA clock, writes the
 * STATUS_CHANGE timeline row and the audit row, and queues the realtime events. Returns the saved ticket.
 */
export async function transitionTicket(
  ctx: Ctx,
  ticketId: number,
  actor: Actor,
  input: TransitionInput,
  t: Transaction,
  opts: TransitionOptions = {},
): Promise<Ticket> {
  const societyId = societyIdOf(ctx);
  const ticket = await lockTicket(societyId, ticketId, t, input.version);
  const from: TicketStatus = ticket.status;
  const action = input.action;
  const to = assertTransition(factsOf(ticket), action, actor.types);
  const at = now();
  const isSystem = actor.types.has('SYSTEM') && !actor.userId;
  let note: string | null = input.note?.trim() || null;
  const fileIds: number[] = [...new Set(input.fileIds ?? [])];
  let extraAudit: string | null = null;
  const reopenAssigneeKept: { kept: boolean } = { kept: false };

  switch (action) {
    case 'START':
      markFirstResponse(ticket, at);
      break;
    case 'WAIT_ON_RESIDENT': {
      note = needText(input.note, 'note', 5, 1000);
      const reason = input.waitingReason;
      if (
        !reason ||
        !(WAITING_REASONS as readonly string[]).includes(reason) ||
        (reason === 'ESTIMATE_APPROVAL' && !isSystem)
      )
        throw bad('waitingReason', 'INFORMATION, ACCESS_TO_FLAT, CONFIRMATION or OTHER');
      markFirstResponse(ticket, at);
      ticket.slaPausedAt = at;
      ticket.waitingReason = reason;
      ticket.waitingReminderSentAt = null;
      break;
    }
    case 'RESUME':
      await leavePause(ticket, at);
      break;
    case 'RESOLVE': {
      note = needText(input.note, 'note', 10, 2000);
      const cat = await loadEffectiveCategory(societyId, ticket.categoryId, ticket.subCategoryId, t, {
        allowArchived: true,
      });
      if (
        cat.requiresAfterPhoto &&
        !isSystem &&
        fileIds.length === 0 &&
        (await isFeatureOn(societyId, ENT.beforeAfterPhotos))
      )
        throw new UnprocessableError(ERR.afterPhotoRequired, 'Add an after photo to resolve this ticket', [
          { field: 'fileIds', message: 'At least one photo is required' },
        ]);
      await leavePause(ticket, at);
      extraAudit =
        (await resolveCharge(ctx, ticket, input, t)) === 'invoiced'
          ? AUDIT.chargeInvoiced
          : ticket.chargeStatus === 'WAIVED'
            ? AUDIT.chargeWaived
            : null;
      markFirstResponse(ticket, at);
      ticket.resolvedAt = at;
      ticket.resolvedByUserId = actor.userId;
      ticket.resolutionNote = note;
      settleBreach(ticket, at, true);
      if (ticket.invoiceId && ticket.kind === 'PERSONAL')
        await invoices.setDisputed(ctx, ticket.invoiceId, false, t);
      break;
    }
    case 'CLOSE':
      ticket.closedAt = at;
      ticket.closeSource = actor.types.has('ADMIN') ? 'ADMIN' : isSystem ? 'AUTO' : 'RESIDENT';
      break;
    case 'REOPEN': {
      note = needText(input.reason, 'reason', 5, 500);
      const [days, max] = await Promise.all([
        setting<number>(societyId, SETTING.reopenWindowDays),
        setting<number>(societyId, SETTING.maxReopens),
      ]);
      if (!ticket.resolvedAt || at.getTime() > ticket.resolvedAt.getTime() + days * 86_400_000)
        throw new UnprocessableError(
          ERR.reopenWindowExpired,
          `A ticket can be reopened for ${days} days after it is resolved`,
        );
      if (ticket.reopenCount >= max)
        throw new UnprocessableError(ERR.reopenLimitReached, 'This ticket was reopened too many times');
      const cat = await loadEffectiveCategory(societyId, ticket.categoryId, ticket.subCategoryId, t, {
        allowArchived: true,
      });
      // BR-15-31: a new SLA cycle
      ticket.slaCycle += 1;
      ticket.slaStartAt = at;
      ticket.slaPausedMinutes = 0;
      ticket.slaPausedAt = null;
      ticket.firstResponseAt = null;
      ticket.responseBreached = false;
      ticket.resolutionBreached = false;
      ticket.escalationLevel = 0;
      ticket.reopenCount += 1;
      ticket.closedAt = null;
      ticket.closeSource = null;
      const snap = await snapshotFor(societyId, cat, ticket.priority, t);
      Object.assign(ticket, snap);
      const due = await slaDue(snap, at, 0, await calendarFor(societyId, snap.slaCalendar));
      ticket.responseDueAt = due.responseDueAt;
      ticket.resolutionDueAt = due.resolutionDueAt;
      if (ticket.invoiceId && ticket.kind === 'PERSONAL') {
        ticket.status = 'REOPENED';
        try {
          await ticket.save({ transaction: t });
        } catch (e) {
          if (e instanceof UniqueConstraintError)
            throw new AppError(
              409,
              ERR.invoiceDisputeOpen,
              'There is already an open dispute for this invoice',
            );
          throw e;
        }
        await invoices.setDisputed(ctx, ticket.invoiceId, true, t);
      }
      break;
    }
    case 'CANCEL': {
      note = needText(input.reason, 'reason', 5, 500);
      const byResidentOnly = !actor.types.has('ADMIN') && !isSystem;
      if (byResidentOnly && ticket.kind === 'BUILDING' && ticket.upvoteCount > 0)
        throw new UnprocessableError(
          ERR.ticketHasUpvotes,
          'Other residents agreed with this issue, so it cannot be cancelled',
        );
      if (!byResidentOnly && ticket.chargeStatus === 'INVOICED' && !opts.mergedIntoTicketId)
        throw new UnprocessableError(ERR.chargeInvoiced, 'The charge was already invoiced');
      await leavePause(ticket, at);
      await endCurrentAssignment(ctx, ticket, opts.mergedIntoTicketId ? 'MERGED' : 'CANCELLED', t);
      ticket.cancelledAt = at;
      ticket.cancelReason = opts.mergedIntoTicketId ? `Merged into ${opts.mergedIntoTicketNo}` : note;
      ticket.mergedIntoTicketId = opts.mergedIntoTicketId ?? null;
      if (ticket.invoiceId && ticket.kind === 'PERSONAL')
        await invoices.setDisputed(ctx, ticket.invoiceId, false, t);
      break;
    }
  }

  ticket.status = to;
  ticket.lastActivityAt = at;
  ticket.updatedBy = actor.userId;
  ticket.version += 1;

  if (action === 'REOPEN') {
    // BR-15-41: keep the assignee when still eligible, else end the assignment and auto-assign (BR-15-37)
    const cur = await currentAssignment(ticket.id, t);
    if (cur && (await assignmentStillEligible(ctx, cur))) {
      if (cur.assigneeType === 'VENDOR') {
        const wo = await helpdeskPorts().workOrders.createFromTicket(
          ctx,
          {
            ticketId: ticket.id,
            vendorId: cur.vendorId!,
            title: ticket.title,
            priority: ticket.priority,
            assetId: ticket.assetId,
          },
          t,
        );
        await cur.update({ workOrderId: wo.workOrderId }, { transaction: t });
      }
      ticket.status = 'ASSIGNED';
      reopenAssigneeKept.kept = true;
    } else {
      if (cur) await endCurrentAssignment(ctx, ticket, 'ASSIGNEE_INACTIVE', t);
      const cat = await loadEffectiveCategory(societyId, ticket.categoryId, ticket.subCategoryId, t, {
        allowArchived: true,
      });
      await autoAssign(ctx, ticket, cat, 'REOPEN', systemActor(ctx), t);
    }
  }
  await recomputeNextCheck(ticket, t);
  await ticket.save({ transaction: t });

  const comment = await addTimeline(
    societyId,
    ticket.id,
    actor,
    {
      kind: 'STATUS_CHANGE',
      fromStatus: from,
      toStatus: to,
      body: note,
      metadata:
        action === 'RESOLVE' && ticket.chargeStatus === 'INVOICED'
          ? { chargeFinalPaise: Number(ticket.chargeFinalPaise) }
          : null,
    },
    t,
  );
  if (fileIds.length) await helpdeskPorts().files.link(ctx, fileIds, 'ticket_comment', comment.id, t);
  await audit(
    ctx,
    {
      action: AUDIT_FOR[action],
      entityType: ENTITY.ticket,
      entityId: ticket.id,
      entityLabel: ticket.ticketNo,
      before: { status: from },
      after: { status: ticket.status },
      reason: action === 'CANCEL' || action === 'REOPEN' ? note : null,
      societyId,
    },
    t,
  );
  if (extraAudit)
    await audit(
      ctx,
      {
        action: extraAudit,
        entityType: ENTITY.ticket,
        entityId: ticket.id,
        entityLabel: ticket.ticketNo,
        after: { chargeFinalPaise: Number(ticket.chargeFinalPaise), invoiceId: ticket.chargeInvoiceId },
        societyId,
      },
      t,
    );
  emitTicketChanged(t, ticket, {
    event: 'STATUS_CHANGED',
    fromStatus: from,
    actorUserId: actor.userId,
    data: { action, assigneeKept: reopenAssigneeKept.kept, merged: Boolean(opts.mergedIntoTicketId) },
  });
  t.afterCommit(() => helpdeskPorts().reportsCache.touch(societyId, 'helpdesk'));
  return ticket;
}
