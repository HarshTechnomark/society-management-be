import { Op, type Transaction } from 'sequelize';
import { PlatformTicket, PlatformTicketMessage, Role, Society, SocietyMember, User } from '../../models';
import type {
  TicketAuthorSide,
  TicketMessageKind,
  TicketVisibility,
} from '../../models/platform-ticket-message.model';
import type { TicketClosedReason, TicketStatus } from '../../models/platform-ticket.model';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, NotFoundError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { getPlatformRoleKeys } from '../access-control/access-control.access';
import { opsPorts } from './platform-ops.ports';
import { ENTITY } from './platform-ops.types';
import { restartResolution, settleWaiting, type SlaHours } from './platform-ops.sla';
import { emitAfterCommit, notifyAfterCommit, raiserRecipients } from './platform-ops.notify';

/** Pieces shared by the platform and society ticket services and by the jobs (BR-07-6, 9, 10, 13, 14). */
export const ticketNotFound = () => new NotFoundError('TICKET_NOT_FOUND', 'Ticket not found');
export const ticketClosed = () =>
  new ConflictError('TICKET_CLOSED', 'This ticket is closed. Raise a new one.');
export const invalidState = (m = 'This change is not allowed in the current state') =>
  new ConflictError('INVALID_STATE', m);
export const staleVersion = () =>
  new AppError(409, 'STALE_VERSION', 'The ticket changed since you opened it. Reload and try again.');

export const OPEN_STATUSES: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING'];

export async function lockTicket(id: number, t: Transaction, societyId?: number): Promise<PlatformTicket> {
  const tk = await PlatformTicket.findOne({
    where: { id, ...(societyId ? { societyId } : {}) },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!tk) throw ticketNotFound();
  return tk;
}

export interface NewMessage {
  ticket: PlatformTicket;
  authorSide: TicketAuthorSide;
  authorUserId: number | null;
  authorName: string;
  kind?: TicketMessageKind;
  visibility?: TicketVisibility;
  body: string;
  meta?: Record<string, unknown> | null;
  fileIds?: number[];
}

/** Writes one message row (and links attachments). Counters on the ticket are the caller's business. */
export async function writeMessage(ctx: Ctx, m: NewMessage, t: Transaction): Promise<PlatformTicketMessage> {
  const fileIds = m.fileIds ?? [];
  const row = await PlatformTicketMessage.create(
    {
      ticketId: m.ticket.id!,
      societyId: m.ticket.societyId,
      authorUserId: m.authorUserId,
      authorSide: m.authorSide,
      authorName: m.authorName.slice(0, 120),
      kind: m.kind ?? 'MESSAGE',
      visibility: m.visibility ?? 'PUBLIC',
      body: m.body,
      meta: m.meta ?? null,
      attachmentCount: fileIds.length,
    },
    { transaction: t },
  );
  if (fileIds.length)
    await opsPorts().files.linkMessageFiles(
      ctx,
      { fileIds, societyId: m.ticket.societyId, messageId: row.id! },
      t,
    );
  return row;
}

/** BR-07-9: the society must have been told something before WAITING or RESOLVED. */
export async function hasPublicPlatformReply(ticketId: number, t: Transaction): Promise<boolean> {
  return (
    (await PlatformTicketMessage.count({
      where: { ticketId, authorSide: 'PLATFORM', kind: 'MESSAGE', visibility: 'PUBLIC' },
      transaction: t,
    })) > 0
  );
}

/** BR-07-16: an ACTIVE platform user holding `platform.tickets.edit`. */
export async function isEligibleAssignee(userId: number): Promise<boolean> {
  const u = await User.findByPk(userId, { attributes: ['id', 'status', 'platformRoleId'] });
  if (!u || u.status !== 'ACTIVE' || !u.platformRoleId) return false;
  return (await getPlatformRoleKeys(u.platformRoleId)).includes('platform.tickets.edit');
}

export const STATUS_TEXT: Record<string, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  WAITING: 'Waiting on you',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

export interface Transition {
  to: TicketStatus;
  by: { side: TicketAuthorSide; userId: number | null; name: string };
  body?: string;
  closedReason?: TicketClosedReason;
}

/**
 * Applies a status change to a locked ticket (6.1): pause accounting (BR-07-6), timestamps, and the PUBLIC
 * `STATUS_CHANGE` line. Returns the column patch (the caller adds counters and saves).
 */
export async function applyTransition(
  ctx: Ctx,
  tk: PlatformTicket,
  tr: Transition,
  t: Transaction,
  sla?: SlaHours,
): Promise<Partial<PlatformTicket>> {
  const at = now();
  const from = tk.status;
  const patch: Record<string, unknown> = { status: tr.to };
  if (from === 'WAITING') Object.assign(patch, settleWaiting(tk, at));
  if (tr.to === 'WAITING') patch.waitingSince = at;
  if (tr.to === 'RESOLVED') patch.resolvedAt = at;
  if (from === 'RESOLVED' && tr.to === 'IN_PROGRESS') {
    patch.resolvedAt = null;
    if (sla) Object.assign(patch, restartResolution(at, tk.priority, sla));
  }
  if (tr.to === 'CLOSED') {
    patch.closedAt = at;
    patch.closedReason = tr.closedReason ?? 'CLOSED_BY_PLATFORM';
  }
  await writeMessage(
    ctx,
    {
      ticket: tk,
      authorSide: tr.by.side,
      authorUserId: tr.by.userId,
      authorName: tr.by.name,
      kind: 'STATUS_CHANGE',
      visibility: 'PUBLIC',
      body: tr.body ?? `Status changed from ${STATUS_TEXT[from]} to ${STATUS_TEXT[tr.to]}`,
      meta: { from, to: tr.to },
    },
    t,
  );
  return patch as Partial<PlatformTicket>;
}

/** After-commit realtime for a ticket change (9.3): platform room, society admin room and the raiser. */
export function emitTicketChanged(
  t: Transaction,
  tk: PlatformTicket,
  o: { statusChanged: boolean; society?: boolean },
): void {
  emitAfterCommit(t, [
    {
      room: 'platform:support',
      event: 'platform.ticket.updated',
      payload: {
        ticketId: tk.id!,
        status: tk.status,
        priority: tk.priority,
        assigneeUserId: tk.assigneeUserId,
        lastMessageAt: tk.lastMessageAt.toISOString(),
      },
    },
    ...(o.statusChanged || o.society
      ? [
          {
            room: `society:${tk.societyId}:admin`,
            event: 'support.ticket.updated',
            payload: { ticketId: tk.id!, status: tk.status },
          },
          {
            userId: tk.raisedByUserId,
            event: 'support.ticket.updated',
            payload: { ticketId: tk.id!, status: tk.status },
          },
        ]
      : []),
  ]);
}

export interface NotifyBase {
  ticketNo: string;
  subject: string;
  societyName: string;
}

export async function societyName(id: number): Promise<string> {
  return (await Society.findByPk(id, { attributes: ['name'] }))?.name ?? 'Society';
}

/** `status_changed` to the raiser for WAITING, RESOLVED and CLOSED (section 10). */
export function notifyStatusChanged(t: Transaction | null, tk: PlatformTicket, link: string): void {
  if (!['WAITING', 'RESOLVED', 'CLOSED'].includes(tk.status)) return;
  notifyAfterCommit(
    t,
    'platform.ticket.status_changed',
    () => raiserRecipients(tk.societyId, tk.raisedByUserId),
    {
      ticketNo: `TKT-${String(tk.id).padStart(6, '0')}`,
      subject: tk.subject,
      status: tk.status,
      link,
    },
  );
}

/** Counts of open tickets of a society (module 05 society detail, Support tab; BR-07-3). */
export async function countOpenTicketsBySociety(societyId: number, t?: Transaction): Promise<number> {
  return PlatformTicket.count({ where: { societyId, status: { [Op.in]: OPEN_STATUSES } }, transaction: t });
}

export const platformLink = (id: number) => `/support/${id}`;
export const societyLink = (id: number) => `/settings/support/${id}`;

export async function activeMemberRole(societyId: number, userId: number) {
  return SocietyMember.findOne({
    where: { societyId, userId, status: 'ACTIVE' },
    include: [{ model: Role, attributes: ['id', 'key', 'name'], required: true }],
  });
}

export async function auditTicket(
  ctx: Ctx,
  tk: PlatformTicket,
  action: string,
  extra: { before?: unknown; after?: unknown; reason?: string | null; internal?: boolean },
  t: Transaction,
): Promise<void> {
  await audit(
    ctx,
    {
      action,
      entityType: ENTITY.ticket,
      entityId: tk.id!,
      entityLabel: `TKT-${String(tk.id).padStart(6, '0')}`,
      societyId: extra.internal ? null : tk.societyId,
      before: extra.before,
      after: extra.after,
      reason: extra.reason ?? null,
    },
    t,
  );
}
