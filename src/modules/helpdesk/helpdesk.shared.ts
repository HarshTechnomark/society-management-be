import type { Transaction } from 'sequelize';
import { Ticket, TicketComment } from '../../models';
import { now } from '../../lib/clock';
import { emitToRoom, emitToUser } from '../../lib/realtime';
import { AppError, NotFoundError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { settings } from '../society-setup/society-setup.public';
import {
  ERR,
  RT,
  roomAdmin,
  roomUnit,
  type CommentKind,
  type TicketStatus,
  type Visibility,
} from './helpdesk.constants';
import type { Actor, CallerTypes, TicketFacts } from './helpdesk.types';
import { slaState } from './helpdesk.sla';

export function societyIdOf(ctx: Ctx): number {
  const id = ctx.society?.id;
  if (!id) throw new Error('helpdesk: the context carries no society');
  return id;
}

export const notFound = (): AppError => new NotFoundError(ERR.ticketNotFound, 'Ticket not found');
export const notImplemented = (what: string): AppError =>
  new AppError(501, ERR.notImplemented, `${what}: not implemented in foundation (filled by its part)`);

/** Reads a `helpdesk.*` setting of module 08 as a number or boolean. */
export const setting = async <T extends number | boolean>(societyId: number, key: string): Promise<T> =>
  (await settings.get(societyId, key as never)) as unknown as T;

export const factsOf = (t: Ticket): TicketFacts => ({
  status: t.status,
  kind: t.kind,
  requesterUserId: t.requesterUserId,
  waitingReason: t.waitingReason,
  chargeStatus: t.chargeStatus,
  resolvedAt: t.resolvedAt,
  reopenCount: t.reopenCount,
});

/** An actor for jobs, hooks and automatic effects. */
export const systemActor = (ctx: Ctx): Actor => ({
  ctx,
  types: new Set(['SYSTEM']) as CallerTypes,
  name: 'System',
  role: 'SYSTEM',
  userId: null,
});

/** An actor for a signed-in user holding the given caller types for this ticket (routes decide the types). */
export function userActor(ctx: Ctx, types: CallerTypes, role: Actor['role'] = 'ADMIN'): Actor {
  if (!ctx.user) return { ...systemActor(ctx), types };
  return { ctx, types, name: ctx.user.name ?? 'User', role, userId: ctx.user.id };
}

/** BR-15-34: row lock plus the optional version check. */
export async function lockTicket(
  societyId: number,
  ticketId: number,
  t: Transaction,
  version?: number,
): Promise<Ticket> {
  const row = await Ticket.findOne({
    where: { id: ticketId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!row) throw notFound();
  if (version !== undefined && row.version !== version)
    throw new AppError(
      409,
      ERR.staleVersion,
      'The ticket was changed by someone else. Reload and try again.',
    );
  return row;
}

/** One timeline row (`ticket_comments`): STATUS_CHANGE, ASSIGNMENT, PRIORITY_CHANGE, ESCALATION, MERGE, ESTIMATE, RATING, SYSTEM. */
export async function addTimeline(
  societyId: number,
  ticketId: number,
  actor: Pick<Actor, 'userId' | 'name' | 'role'>,
  entry: {
    kind: Exclude<CommentKind, 'COMMENT'>;
    visibility?: Visibility;
    body?: string | null;
    fromStatus?: TicketStatus | null;
    toStatus?: TicketStatus | null;
    escalationRuleId?: number | null;
    slaCycle?: number | null;
    metadata?: Record<string, unknown> | null;
  },
  t: Transaction,
): Promise<TicketComment> {
  return TicketComment.create(
    {
      societyId,
      ticketId,
      kind: entry.kind,
      visibility: entry.kind === 'ESCALATION' ? 'INTERNAL' : (entry.visibility ?? 'PUBLIC'),
      authorUserId: actor.userId,
      authorRole: actor.userId ? actor.role : 'SYSTEM',
      authorName: actor.userId ? actor.name : 'System',
      body: entry.body ?? null,
      fromStatus: entry.fromStatus ?? null,
      toStatus: entry.toStatus ?? null,
      escalationRuleId: entry.escalationRuleId ?? null,
      slaCycle: entry.slaCycle ?? null,
      metadata: entry.metadata ?? null,
      createdBy: actor.userId,
    },
    { transaction: t },
  );
}

// ------------------------------------------------------------------ events after commit
export interface TicketEvent {
  societyId: number;
  ticketId: number;
  /** What happened: CREATED, STATUS_CHANGED, ASSIGNED, UNASSIGNED, MERGED, PRIORITY_CHANGED, COMMENT, UPVOTE, ESCALATED, ESTIMATE, RATED. */
  event: string;
  status: TicketStatus;
  fromStatus?: TicketStatus | null;
  actorUserId: number | null;
  data?: Record<string, unknown>;
}
type Listener = (e: TicketEvent) => void | Promise<void>;
const listeners: Listener[] = [];
/** Part 15.4 registers its notification and fan-out listener here. Called after commit; a throwing listener never fails the write. */
export const onTicketEvent = (fn: Listener): void => {
  if (!listeners.includes(fn)) listeners.push(fn);
};
export const clearTicketListeners = (): void => void (listeners.length = 0);

/**
 * 9.4: the realtime events of a ticket change, sent from `afterCommit` (ids and states only), then the listeners of part 15.4.
 * Callers pass the ticket as stored after the change.
 */
export function emitTicketChanged(
  t: Transaction,
  ticket: Ticket,
  ev: Omit<TicketEvent, 'societyId' | 'ticketId' | 'status'>,
): void {
  const snapshot = {
    societyId: ticket.societyId,
    ticketId: ticket.id,
    ticketNo: ticket.ticketNo,
    kind: ticket.kind,
    status: ticket.status,
    priority: ticket.priority,
    slaState: slaState(ticket, now()),
    assigneeLabel: ticket.assigneeLabel,
    upvoteCount: ticket.upvoteCount,
    version: ticket.version,
  };
  const assigneeUserId = ticket.assigneeUserId;
  const requesterUserId = ticket.requesterUserId;
  const unitId = ticket.unitId;
  const kind = ticket.kind;
  t.afterCommit(async () => {
    const { societyId, ticketId, ticketNo, status, priority, upvoteCount, version, ...rest } = snapshot;
    emitToRoom(roomAdmin(societyId), RT.ticketChanged, {
      ticketId,
      ticketNo,
      status,
      priority,
      upvoteCount,
      version,
      kind,
      slaState: rest.slaState,
      assigneeLabel: rest.assigneeLabel,
    });
    if (kind === 'PERSONAL' && unitId)
      emitToRoom(roomUnit(unitId), RT.ticketChanged, { ticketId, status, version });
    if (assigneeUserId)
      emitToUser(assigneeUserId, RT.assignmentChanged, { ticketId, status, assigned: true });
    if (kind === 'BUILDING' && requesterUserId)
      emitToUser(requesterUserId, RT.ticketChanged, { ticketId, status, version });
    for (const l of listeners) {
      try {
        await l({ ...ev, societyId, ticketId, status: ticket.status });
      } catch {
        /* a listener never fails the write */
      }
    }
  });
}
