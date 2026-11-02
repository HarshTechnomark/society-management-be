import { Op } from 'sequelize';
import { PlatformTicket, PlatformTicketMessage, Role, Society, SocietyMember, User } from '../../models';
import { addDays } from '../../lib/clock';
import { opsPorts } from './platform-ops.ports';
import { ticketNo } from './platform-ops.types';

/** Serializers for tickets (module 07 sections 8.3 and 8.4). The society serializer is an allowlist of fields (BR-07-14). */
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export interface TicketContext {
  societies: Map<number, { id: number; name: string; status: string }>;
  users: Map<number, string>;
  roleKeys: Map<string, string | null>; // `${societyId}:${userId}`
}

/** Loads the society, user names and raiser roles for a set of tickets in four queries. */
export async function ticketContext(tickets: PlatformTicket[]): Promise<TicketContext> {
  const societyIds = [...new Set(tickets.map(t => t.societyId))];
  const userIds = [
    ...new Set(
      tickets.flatMap(t => [t.raisedByUserId, t.assigneeUserId].filter((x): x is number => x != null)),
    ),
  ];
  const societies = societyIds.length
    ? await Society.findAll({ where: { id: { [Op.in]: societyIds } }, attributes: ['id', 'name', 'status'] })
    : [];
  const users = userIds.length
    ? await User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ['id', 'name'] })
    : [];
  const members = tickets.length
    ? await SocietyMember.findAll({
        where: {
          societyId: { [Op.in]: societyIds },
          userId: { [Op.in]: [...new Set(tickets.map(t => t.raisedByUserId))] },
        },
        attributes: ['societyId', 'userId', 'status'],
        include: [{ model: Role, attributes: ['key'] }],
        order: [['id', 'ASC']],
      })
    : [];
  const roleKeys = new Map<string, string | null>();
  for (const m of members) roleKeys.set(`${m.societyId}:${m.userId}`, (m as any).Role?.key ?? null);
  return {
    societies: new Map(societies.map(s => [s.id!, { id: s.id!, name: s.name, status: s.status }])),
    users: new Map(users.map(u => [u.id!, u.name ?? 'User'])),
    roleKeys,
  };
}

export interface MessageView {
  id: number;
  authorSide: string;
  authorName: string;
  kind: string;
  visibility?: string;
  body: string;
  meta?: unknown;
  attachments: unknown[];
  createdAt: string;
}

export async function messageViews(
  messages: PlatformTicketMessage[],
  opts: { society: boolean },
): Promise<MessageView[]> {
  const att = await opsPorts().files.attachmentsFor(messages.map(m => m.id!));
  return messages.map(m => ({
    id: m.id!,
    authorSide: m.authorSide,
    authorName: m.authorName,
    kind: m.kind,
    ...(opts.society ? {} : { visibility: m.visibility }),
    body: m.body,
    ...(m.meta ? { meta: m.meta } : {}),
    attachments: att.get(m.id!) ?? [],
    createdAt: m.createdAt!.toISOString(),
  }));
}

/** Platform view (8.3). */
export function platformTicketView(t: PlatformTicket, c: TicketContext, messages?: MessageView[]) {
  const s = c.societies.get(t.societyId);
  return {
    id: t.id!,
    ticketNo: ticketNo(t.id!),
    society: s ?? { id: t.societyId, name: 'Unknown', status: 'UNKNOWN' },
    raisedBy: {
      id: t.raisedByUserId,
      name: c.users.get(t.raisedByUserId) ?? 'User',
      roleKey: c.roleKeys.get(`${t.societyId}:${t.raisedByUserId}`) ?? null,
    },
    source: t.source,
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: t.status,
    assignee: t.assigneeUserId
      ? { id: t.assigneeUserId, name: c.users.get(t.assigneeUserId) ?? 'User' }
      : null,
    sla: {
      firstResponseDueAt: t.firstResponseDueAt.toISOString(),
      resolutionDueAt: t.resolutionDueAt.toISOString(),
      firstRespondedAt: iso(t.firstRespondedAt),
      firstResponseBreachedAt: iso(t.firstResponseBreachedAt),
      resolutionWarnedAt: iso(t.resolutionWarnedAt),
      resolutionBreachedAt: iso(t.resolutionBreachedAt),
      pausedMinutes: t.pausedMinutes,
    },
    reopenCount: t.reopenCount,
    messageCount: t.messageCount,
    lastMessageAt: t.lastMessageAt.toISOString(),
    satisfactionRating: t.satisfactionRating,
    satisfactionComment: t.satisfactionComment,
    resolvedAt: iso(t.resolvedAt),
    closedAt: iso(t.closedAt),
    closedReason: t.closedReason,
    version: t.version,
    createdAt: t.createdAt!.toISOString(),
    updatedAt: t.updatedAt!.toISOString(),
    ...(messages ? { messages } : {}),
  };
}

/** Society view (8.4): no breach fields, no version, assignee reduced to a name, plus the two derived dates. */
export function societyTicketView(
  t: PlatformTicket,
  c: TicketContext,
  autoCloseDays: number,
  messages?: MessageView[],
) {
  return {
    id: t.id!,
    ticketNo: ticketNo(t.id!),
    raisedBy: { id: t.raisedByUserId, name: c.users.get(t.raisedByUserId) ?? 'User' },
    source: t.source,
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: t.status,
    assignee: t.assigneeUserId ? { name: c.users.get(t.assigneeUserId) ?? 'SocietyApp Support' } : null,
    sla: {
      firstResponseDueAt: t.firstResponseDueAt.toISOString(),
      resolutionDueAt: t.resolutionDueAt.toISOString(),
      firstRespondedAt: iso(t.firstRespondedAt),
    },
    expectedFirstResponseBy: t.firstRespondedAt ? null : t.firstResponseDueAt.toISOString(),
    reopenAllowedUntil:
      t.status === 'RESOLVED' && t.resolvedAt ? addDays(t.resolvedAt, autoCloseDays).toISOString() : null,
    reopenCount: t.reopenCount,
    messageCount: t.messageCount,
    lastMessageAt: t.lastMessageAt.toISOString(),
    satisfactionRating: t.satisfactionRating,
    satisfactionComment: t.satisfactionComment,
    resolvedAt: iso(t.resolvedAt),
    closedAt: iso(t.closedAt),
    closedReason: t.closedReason,
    createdAt: t.createdAt!.toISOString(),
    updatedAt: t.updatedAt!.toISOString(),
    ...(messages ? { messages } : {}),
  };
}

export const likeEscape = (s: string): string => s.replace(/[\\%_]/g, c => `\\${c}`);
