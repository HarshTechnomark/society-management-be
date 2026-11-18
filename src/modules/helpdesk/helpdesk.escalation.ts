import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import { EscalationRule, Ticket, TicketComment, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { members, usersWithPermission } from '../access-control/access-control.public';
import { committee } from '../committee/committee.public';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import {
  AUDIT,
  ENT,
  ENTITY,
  ERR,
  LIMITS,
  NON_TERMINAL,
  PERM,
  SETTING,
  type TriggerType,
} from './helpdesk.constants';
import { addTimeline, emitTicketChanged, setting, societyIdOf, systemActor } from './helpdesk.shared';
import { calendarFor, escalationFireTime, nextSlaCheck } from './helpdesk.sla';

/** 6.4, BR-15-30, BR-15-58 to BR-15-61: breach flags, escalation firing and the sweep cursor. */

export interface FiredRule {
  ruleId: number;
  ruleName: string;
  level: number;
  trigger: TriggerType;
  commentId: number;
  recipients: number[];
  notifyAssignee: boolean;
  fallback: boolean;
}

export const ruleMatches = (
  r: { categoryId: number | null; priority: string | null },
  t: { categoryId: number; priority: string },
): boolean =>
  (r.categoryId === null || r.categoryId === t.categoryId) &&
  (r.priority === null || r.priority === t.priority);

/** BR-15-61: the people a rule notifies; an empty set falls back to the holders of `helpdesk.settings.edit`. */
export async function resolveTargets(
  societyId: number,
  rule: Pick<EscalationRule, 'targetType' | 'targetRoleKey' | 'targetDesignation' | 'targetUserId'>,
): Promise<{ userIds: number[]; fallback: boolean }> {
  let ids: number[] = [];
  if (rule.targetType === 'ROLE' && rule.targetRoleKey)
    ids = (
      await members.listForSociety(societyId, { roleKeys: [rule.targetRoleKey], statuses: ['ACTIVE'] })
    ).map(m => m.userId);
  else if (rule.targetType === 'DESIGNATION' && rule.targetDesignation)
    ids = await committee.listSeatedUserIds(societyId, [rule.targetDesignation]);
  else if (rule.targetType === 'MEMBER' && rule.targetUserId)
    ids = (
      await members.listForSociety(societyId, { userIds: [rule.targetUserId], statuses: ['ACTIVE'] })
    ).map(m => m.userId);
  ids = [...new Set(ids)];
  if (ids.length) return { userIds: ids, fallback: false };
  return { userIds: await usersWithPermission(societyId, PERM.settingsEdit), fallback: true };
}

async function activeRules(
  societyId: number,
  triggers: TriggerType[],
  t: Transaction,
): Promise<EscalationRule[]> {
  return EscalationRule.findAll({
    where: { societyId, status: 'ACTIVE', triggerType: { [Op.in]: triggers } },
    order: [
      ['level', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction: t,
  });
}

async function firedRuleIds(ticketId: number, cycle: number, t: Transaction): Promise<Set<number>> {
  const rows = await TicketComment.findAll({
    where: { ticketId, kind: 'ESCALATION', slaCycle: cycle },
    attributes: ['escalationRuleId'],
    paranoid: false,
    transaction: t,
  });
  return new Set(rows.map(r => Number(r.escalationRuleId)));
}

/** Fire time of an SLA rule for a ticket, or null for non-SLA triggers. */
async function fireAt(ticket: Ticket, rule: EscalationRule): Promise<Date | null> {
  if (rule.triggerType !== 'RESPONSE_SLA' && rule.triggerType !== 'RESOLUTION_SLA') return null;
  const cal = await calendarFor(ticket.societyId, ticket.slaCalendar);
  const minutes = rule.triggerType === 'RESPONSE_SLA' ? ticket.responseMinutes : ticket.resolutionMinutes;
  return escalationFireTime(ticket, minutes, rule.thresholdPercent ?? 100, rule.triggerType, cal);
}

/** Recomputes `nextSlaCheckAt` (6.4): called by the service whenever status, priority, pause or cycle changes. Does not save. */
export async function recomputeNextCheck(ticket: Ticket, t: Transaction): Promise<void> {
  if (['RESOLVED', 'CLOSED', 'CANCELLED', 'WAITING_ON_RESIDENT'].includes(ticket.status)) {
    ticket.nextSlaCheckAt = null;
    return;
  }
  const times: Date[] = [];
  if (await isFeatureOn(ticket.societyId, ENT.escalationMatrix)) {
    const fired = await firedRuleIds(ticket.id, ticket.slaCycle, t);
    for (const r of await activeRules(ticket.societyId, ['RESPONSE_SLA', 'RESOLUTION_SLA'], t)) {
      if (fired.has(r.id) || !ruleMatches(r, ticket)) continue;
      if (r.triggerType === 'RESPONSE_SLA' && ticket.firstResponseAt) continue;
      const at = await fireAt(ticket, r);
      if (at) times.push(at);
    }
  }
  ticket.nextSlaCheckAt = nextSlaCheck(ticket, times);
}

/**
 * BR-15-30 at a settling transition: response breached when the first response is missing past due or came later; resolution breached when the
 * ticket is settled later than its due time. Set-only.
 */
export function settleBreach(ticket: Ticket, at: Date, resolved: boolean): void {
  if (ticket.firstResponseAt ? ticket.firstResponseAt > ticket.responseDueAt : at > ticket.responseDueAt)
    ticket.responseBreached = true;
  if (resolved && at > ticket.resolutionDueAt) ticket.resolutionBreached = true;
}

async function fire(
  ctx: Ctx,
  ticket: Ticket,
  rule: EscalationRule,
  slaCycle: number | null,
  t: Transaction,
  note?: string,
): Promise<FiredRule | null> {
  const targets = await resolveTargets(ticket.societyId, rule);
  try {
    const row = await addTimeline(
      ticket.societyId,
      ticket.id,
      systemActor(ctx),
      {
        kind: 'ESCALATION',
        body: `Escalated to level ${rule.level}: ${rule.name}${targets.fallback ? `. No recipient for rule ${rule.name}` : ''}${note ? `. ${note}` : ''}`,
        escalationRuleId: rule.id,
        slaCycle,
        metadata: { level: rule.level, trigger: rule.triggerType, recipients: targets.userIds },
      },
      t,
    );
    ticket.escalationLevel = Math.max(ticket.escalationLevel, rule.level);
    await audit(
      ctx,
      {
        action: AUDIT.escalated,
        entityType: ENTITY.ticket,
        entityId: ticket.id,
        entityLabel: ticket.ticketNo,
        after: { level: rule.level, rule: rule.name, trigger: rule.triggerType },
        societyId: ticket.societyId,
      },
      t,
    );
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      level: rule.level,
      trigger: rule.triggerType,
      commentId: row.id,
      recipients: targets.userIds,
      notifyAssignee: rule.notifyAssignee,
      fallback: targets.fallback,
    };
  } catch (e) {
    if (e instanceof UniqueConstraintError) return null; // fired by a concurrent sweep (BR-15-60)
    throw e;
  }
}

/**
 * The sweep step of one ticket (6.4), in its own transaction when none is given: row lock, breach flags (BR-15-30), every matching SLA rule whose
 * fire time has passed and that did not fire in this cycle (BR-15-59, BR-15-60), `escalationLevel = max`, new `nextSlaCheckAt`. Returns what fired so the job
 * notifies after commit. Safe to run twice at the same instant (the second run fires nothing).
 */
export async function evaluateTicketSla(
  ticketId: number,
  at: Date = now(),
  tx?: Transaction,
  ctxIn?: Ctx,
): Promise<FiredRule[]> {
  const run = async (t: Transaction): Promise<FiredRule[]> => {
    const ticket = await Ticket.findOne({ where: { id: ticketId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!ticket) return [];
    const ctx: Ctx = ctxIn ?? {
      requestId: 'sla-sweep',
      ip: '',
      userAgent: '',
      society: { id: ticket.societyId, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
    };
    const out: FiredRule[] = [];
    const live = (NON_TERMINAL as readonly string[]).includes(ticket.status);
    if (!live || ticket.status === 'WAITING_ON_RESIDENT') {
      if (ticket.nextSlaCheckAt) {
        ticket.nextSlaCheckAt = null;
        await ticket.save({ transaction: t });
      }
      return out;
    }
    let changed = false;
    if (!ticket.firstResponseAt && !ticket.responseBreached && at >= ticket.responseDueAt) {
      ticket.responseBreached = true;
      changed = true;
    }
    if (!ticket.resolutionBreached && at >= ticket.resolutionDueAt) {
      ticket.resolutionBreached = true;
      changed = true;
    }
    if (await isFeatureOn(ticket.societyId, ENT.escalationMatrix)) {
      const fired = await firedRuleIds(ticket.id, ticket.slaCycle, t);
      for (const r of await activeRules(ticket.societyId, ['RESPONSE_SLA', 'RESOLUTION_SLA'], t)) {
        if (fired.has(r.id) || !ruleMatches(r, ticket)) continue;
        if (r.triggerType === 'RESPONSE_SLA' && ticket.firstResponseAt) continue;
        const when = await fireAt(ticket, r);
        if (!when || when > at) continue;
        const f = await fire(ctx, ticket, r, ticket.slaCycle, t);
        if (f) {
          out.push(f);
          changed = true;
        }
      }
    }
    const before = ticket.nextSlaCheckAt?.getTime() ?? null;
    await recomputeNextCheck(ticket, t);
    if (changed || before !== (ticket.nextSlaCheckAt?.getTime() ?? null)) {
      ticket.version += 1;
      await ticket.save({ transaction: t });
      if (changed) emitTicketChanged(t, ticket, { event: 'ESCALATED', actorUserId: null });
    }
    return out;
  };
  return tx ? run(tx) : sequelize.transaction(run);
}

/**
 * BR-15-58 resident escalation request: allowed when a due time has passed or a breach flag is set, status non-terminal and not RESOLVED, once per 24 hours.
 * Fires the RESIDENT_REQUEST rules at the lowest level above `escalationLevel` (the highest level when none is above).
 */
export async function fireResidentRequest(ctx: Ctx, ticketId: number, t: Transaction): Promise<FiredRule[]> {
  const societyId = societyIdOf(ctx);
  const ticket = await Ticket.findOne({
    where: { id: ticketId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!ticket) throw new AppError(404, ERR.ticketNotFound, 'Ticket not found');
  const at = now();
  const late =
    ticket.responseBreached ||
    ticket.resolutionBreached ||
    at > ticket.resolutionDueAt ||
    (!ticket.firstResponseAt && at > ticket.responseDueAt);
  if (!(NON_TERMINAL as readonly string[]).includes(ticket.status) || !late)
    throw new UnprocessableError(ERR.escalationNotAllowed, 'This request cannot be escalated yet');
  if (
    ticket.lastResidentEscalationAt &&
    at.getTime() - ticket.lastResidentEscalationAt.getTime() < LIMITS.residentEscalationGapHours * 3_600_000
  )
    throw new UnprocessableError(ERR.escalationTooSoon, 'You can escalate once in 24 hours');
  const rules = (await activeRules(societyId, ['RESIDENT_REQUEST'], t)).filter(r => ruleMatches(r, ticket));
  const above = rules.filter(r => r.level > ticket.escalationLevel);
  const level = above.length ? Math.min(...above.map(r => r.level)) : Math.max(0, ...rules.map(r => r.level));
  const out: FiredRule[] = [];
  for (const r of rules.filter(x => x.level === level)) {
    const f = await fire(ctx, ticket, r, null, t, 'Requested by the resident');
    if (f) out.push(f);
  }
  ticket.lastResidentEscalationAt = at;
  ticket.lastActivityAt = at;
  ticket.version += 1;
  await ticket.save({ transaction: t });
  emitTicketChanged(t, ticket, { event: 'ESCALATED', actorUserId: ctx.user?.id ?? null });
  return out;
}

/** BR-15-56: a rating at or below `helpdesk.lowCsatThreshold` fires the LOW_CSAT rules (call it from the rating code of 15.3 inside its transaction). */
export async function fireLowCsat(
  ctx: Ctx,
  ticketId: number,
  score: number,
  t: Transaction,
): Promise<FiredRule[]> {
  const societyId = societyIdOf(ctx);
  if (!(await isFeatureOn(societyId, ENT.csat)) || !(await isFeatureOn(societyId, ENT.escalationMatrix)))
    return [];
  if (score > (await setting<number>(societyId, SETTING.lowCsatThreshold))) return [];
  const ticket = await Ticket.findOne({
    where: { id: ticketId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!ticket) throw new AppError(404, ERR.ticketNotFound, 'Ticket not found');
  const out: FiredRule[] = [];
  for (const r of (await activeRules(societyId, ['LOW_CSAT'], t)).filter(x => ruleMatches(x, ticket))) {
    const f = await fire(ctx, ticket, r, null, t, `Rating ${score}`);
    if (f) out.push(f);
  }
  if (out.length) {
    ticket.version += 1;
    await ticket.save({ transaction: t });
  }
  return out;
}
