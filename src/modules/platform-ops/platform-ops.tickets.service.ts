import { Op, literal, type WhereOptions } from 'sequelize';
import { PlatformTicket, PlatformTicketMessage, Society, User, sequelize } from '../../models';
import type { TicketCategory, TicketPriority, TicketStatus } from '../../models/platform-ticket.model';
import { now } from '../../lib/clock';
import { AppError, UnprocessableError, ValidationError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { getPlatformSetting } from './platform-ops.settings.service';
import { dueTimes, reprioritise } from './platform-ops.sla';
import { AUDIT, parseTicketNo, ticketNo } from './platform-ops.types';
import {
  OPEN_STATUSES,
  applyTransition,
  auditTicket,
  emitTicketChanged,
  hasPublicPlatformReply,
  invalidState,
  isEligibleAssignee,
  lockTicket,
  notifyStatusChanged,
  platformLink,
  staleVersion,
  societyName,
  ticketClosed,
  ticketNotFound,
  writeMessage,
} from './platform-ops.tickets.core';
import { likeEscape, messageViews, platformTicketView, ticketContext } from './platform-ops.tickets.view';
import { emitAfterCommit, notifyAfterCommit, raiserRecipients, supportTeam } from './platform-ops.notify';
import { activeMemberRole } from './platform-ops.tickets.core';

/** Platform side of support tickets (module 07 section 8.3, rules BR-07-1 to BR-07-19). */
const IST = '+05:30';
const SORT_COLUMNS = {
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  resolutionDueAt: 'resolutionDueAt',
  lastMessageAt: 'lastMessageAt',
} as const;

export interface PlatformTicketQuery {
  status?: TicketStatus[];
  priority?: TicketPriority[];
  category?: TicketCategory;
  societyId?: number;
  assignee?: string;
  slaBreached?: boolean;
  q?: string;
  createdFrom?: string;
  createdTo?: string;
  sortBy: keyof typeof SORT_COLUMNS | 'priority';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

async function whereFor(ctx: Ctx, q: PlatformTicketQuery, withStatus: boolean): Promise<WhereOptions> {
  const and: WhereOptions[] = [];
  if (withStatus && q.status) and.push({ status: { [Op.in]: q.status } });
  if (q.priority) and.push({ priority: { [Op.in]: q.priority } });
  if (q.category) and.push({ category: q.category });
  if (q.societyId) and.push({ societyId: q.societyId });
  if (q.assignee === 'me') and.push({ assigneeUserId: ctx.user?.id ?? 0 });
  else if (q.assignee === 'none') and.push({ assigneeUserId: null });
  else if (q.assignee) and.push({ assigneeUserId: Number(q.assignee) });
  if (q.slaBreached)
    and.push({
      status: { [Op.notIn]: ['RESOLVED', 'CLOSED'] },
      [Op.or]: [{ firstResponseBreachedAt: { [Op.ne]: null } }, { resolutionBreachedAt: { [Op.ne]: null } }],
    });
  if (q.createdFrom) and.push({ createdAt: { [Op.gte]: new Date(`${q.createdFrom}T00:00:00${IST}`) } });
  if (q.createdTo)
    and.push({
      createdAt: { [Op.lt]: new Date(new Date(`${q.createdTo}T00:00:00${IST}`).getTime() + 86_400_000) },
    });
  if (q.q) {
    const no = parseTicketNo(q.q);
    if (no !== null) and.push({ id: no });
    else {
      const like = `%${likeEscape(q.q)}%`;
      const socs = await Society.findAll({
        where: { name: { [Op.like]: `${likeEscape(q.q)}%` } },
        attributes: ['id'],
        limit: 200,
      });
      and.push({
        [Op.or]: [{ subject: { [Op.like]: like } }, { societyId: { [Op.in]: socs.map(s => s.id!) } }],
      });
    }
  }
  return and.length ? { [Op.and]: and } : {};
}

export async function listTickets(ctx: Ctx, q: PlatformTicketQuery) {
  const where = await whereFor(ctx, q, true);
  const dir = q.sortOrder.toUpperCase();
  const order: any[] =
    q.sortBy === 'priority'
      ? [
          [literal("FIELD(priority,'LOW','MEDIUM','HIGH')"), dir],
          ['id', 'DESC'],
        ]
      : [
          [SORT_COLUMNS[q.sortBy], dir],
          ['id', 'DESC'],
        ];
  const { rows, count } = await PlatformTicket.findAndCountAll({
    where,
    order,
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const c = await ticketContext(rows);
  const counted = (await PlatformTicket.findAll({
    where: await whereFor(ctx, q, false),
    attributes: ['status', [sequelize.fn('COUNT', sequelize.col('id')), 'n']],
    group: ['status'],
    raw: true,
  })) as unknown as { status: string; n: number }[];
  const counts: Record<string, number> = {
    ALL: 0,
    OPEN: 0,
    IN_PROGRESS: 0,
    WAITING: 0,
    RESOLVED: 0,
    CLOSED: 0,
  };
  for (const r of counted) {
    counts[r.status] = Number(r.n);
    counts.ALL += Number(r.n);
  }
  return {
    data: { items: rows.map(t => platformTicketView(t, c)), counts },
    pagination: pageMeta(q.page, q.limit, count),
  };
}

async function fullView(id: number) {
  const t = await PlatformTicket.findByPk(id);
  if (!t) throw ticketNotFound();
  const msgs = await PlatformTicketMessage.findAll({ where: { ticketId: id }, order: [['id', 'ASC']] });
  return platformTicketView(t, await ticketContext([t]), await messageViews(msgs, { society: false }));
}

export const getTicket = (_ctx: Ctx, id: number) => fullView(id);

/** BR-07-3: the open ticket limit of a society, under the society row lock. */
export async function assertOpenLimit(societyId: number, t: import('sequelize').Transaction) {
  const limit = await getPlatformSetting('support.maxOpenTicketsPerSociety');
  const open = await PlatformTicket.count({
    where: { societyId, status: { [Op.in]: OPEN_STATUSES } },
    transaction: t,
  });
  if (open >= limit)
    throw new UnprocessableError(
      'TOO_MANY_OPEN_TICKETS',
      `This society already has ${limit} open tickets. Resolve some before raising more.`,
    );
}

export interface CreatePlatformTicketInput {
  societyId: number;
  raisedByUserId: number;
  subject: string;
  category: TicketCategory;
  priority?: TicketPriority;
  body: string;
  fileIds?: number[];
}

/** `POST /platform/tickets`: raised on behalf of a society (BR-07-19). Counts as the first response. */
export async function createTicket(ctx: Ctx, input: CreatePlatformTicketInput) {
  const society = await Society.findByPk(input.societyId);
  if (!society) throw new AppError(404, 'SOCIETY_NOT_FOUND', 'Society not found');
  if (society.status === 'CLOSED') throw new UnprocessableError('SOCIETY_CLOSED', 'This society is closed');
  if (!(await activeMemberRole(input.societyId, input.raisedByUserId)))
    throw new UnprocessableError('RAISER_NOT_MEMBER', 'The person must be an active member of this society');
  const sla = await getPlatformSetting('support.slaHours');
  const priority = input.priority ?? 'MEDIUM';
  const at = now();
  const actor = ctx.user!;
  const id = await sequelize.transaction(async t => {
    await Society.findByPk(input.societyId, { transaction: t, lock: t.LOCK.UPDATE });
    await assertOpenLimit(input.societyId, t);
    const tk = await PlatformTicket.create(
      {
        societyId: input.societyId,
        raisedByUserId: input.raisedByUserId,
        source: 'PLATFORM',
        subject: input.subject,
        category: input.category,
        priority,
        status: 'IN_PROGRESS',
        assigneeUserId: actor.id,
        ...dueTimes(at, priority, sla),
        firstRespondedAt: at,
        firstResponseBreachedAt: null,
        resolutionWarnedAt: null,
        resolutionBreachedAt: null,
        waitingSince: null,
        pausedMinutes: 0,
        resolvedAt: null,
        closedAt: null,
        closedReason: null,
        reopenCount: 0,
        lastMessageAt: at,
        lastSocietyMessageAt: null,
        lastPlatformMessageAt: at,
        messageCount: 1,
        satisfactionRating: null,
        satisfactionComment: null,
        ratedAt: null,
        version: 1,
        createdBy: actor.id,
        updatedBy: actor.id,
        createdAt: at,
        updatedAt: at,
      },
      { transaction: t },
    );
    await writeMessage(
      ctx,
      {
        ticket: tk,
        authorSide: 'PLATFORM',
        authorUserId: actor.id,
        authorName: actor.name ?? 'SocietyApp Support',
        body: input.body,
        fileIds: input.fileIds,
      },
      t,
    );
    await auditTicket(
      ctx,
      tk,
      AUDIT.ticketCreated,
      { after: { subject: tk.subject, category: tk.category, priority, source: 'PLATFORM' } },
      t,
    );
    notifyAfterCommit(
      t,
      'platform.ticket.created_for_society',
      () => raiserRecipients(tk.societyId, tk.raisedByUserId),
      {
        ticketNo: ticketNo(tk.id!),
        subject: tk.subject,
        societyName: society.name,
        link: `/settings/support/${tk.id}`,
      },
    );
    emitAfterCommit(t, [
      {
        room: 'platform:support',
        event: 'platform.ticket.created',
        payload: { ticketId: tk.id!, societyId: tk.societyId },
      },
      {
        userId: tk.raisedByUserId,
        event: 'support.ticket.updated',
        payload: { ticketId: tk.id!, status: tk.status },
      },
    ]);
    return tk.id!;
  });
  return fullView(id);
}

export interface PatchTicketInput {
  version: number;
  status?: 'IN_PROGRESS' | 'WAITING' | 'RESOLVED' | 'CLOSED';
  closeReason?: string;
  priority?: TicketPriority;
  category?: TicketCategory;
  assigneeUserId?: number | null;
}

const ALLOWED: Record<string, TicketStatus[]> = {
  OPEN: ['IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['WAITING', 'RESOLVED', 'CLOSED'],
  WAITING: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
};

/** `PATCH /platform/tickets/:id`: status (table 6.1), priority (BR-07-7), category, assignee (BR-07-16). */
export async function updateTicket(ctx: Ctx, id: number, input: PatchTicketInput) {
  const sla = await getPlatformSetting('support.slaHours');
  const actor = ctx.user!;
  const by = { side: 'PLATFORM' as const, userId: actor.id, name: actor.name ?? 'SocietyApp Support' };
  const result = await sequelize.transaction(async t => {
    const tk = await lockTicket(id, t);
    if (tk.status === 'CLOSED') throw ticketClosed();
    if (tk.version !== input.version) throw staleVersion();

    const statusChange = input.status !== undefined && input.status !== tk.status;
    const priorityChange = input.priority !== undefined && input.priority !== tk.priority;
    const categoryChange = input.category !== undefined && input.category !== tk.category;
    const assigneeChange = input.assigneeUserId !== undefined && input.assigneeUserId !== tk.assigneeUserId;
    if (!statusChange && !priorityChange && !categoryChange && !assigneeChange)
      throw new ValidationError([{ field: 'body', message: 'No changes' }]);

    if (statusChange) {
      if (!ALLOWED[tk.status]!.includes(input.status!)) throw invalidState();
      if (
        (input.status === 'WAITING' || input.status === 'RESOLVED') &&
        !(await hasPublicPlatformReply(id, t))
      )
        throw new UnprocessableError(
          'PUBLIC_REPLY_REQUIRED',
          'Send a public reply to the society before moving the ticket to this status',
        );
      if (input.status === 'CLOSED' && tk.status !== 'RESOLVED' && !input.closeReason)
        throw new ValidationError([
          { field: 'closeReason', message: 'A reason is required to close this ticket' },
        ]);
    }
    if (assigneeChange && input.assigneeUserId !== null && !(await isEligibleAssignee(input.assigneeUserId!)))
      throw new UnprocessableError(
        'ASSIGNEE_NOT_ELIGIBLE',
        'The assignee must be an active support team member',
      );

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const patch: Record<string, unknown> = {};
    const from = tk.status;
    if (statusChange) {
      before.status = tk.status;
      after.status = input.status;
      Object.assign(
        patch,
        await applyTransition(
          ctx,
          tk,
          { to: input.status!, by, body: input.closeReason, closedReason: 'CLOSED_BY_PLATFORM' },
          t,
          sla,
        ),
      );
    }
    if (priorityChange) {
      before.priority = tk.priority;
      after.priority = input.priority;
      const snap = {
        createdAt: tk.createdAt!,
        pausedMinutes: (patch.pausedMinutes as number | undefined) ?? tk.pausedMinutes,
        firstRespondedAt: tk.firstRespondedAt,
        firstResponseDueAt: tk.firstResponseDueAt,
        firstResponseBreachedAt: tk.firstResponseBreachedAt,
        resolutionWarnedAt: (patch.resolutionWarnedAt as Date | null | undefined) ?? tk.resolutionWarnedAt,
        resolutionBreachedAt:
          (patch.resolutionBreachedAt as Date | null | undefined) ?? tk.resolutionBreachedAt,
        resolutionDueAt: tk.resolutionDueAt,
      };
      const r = reprioritise(snap, input.priority!, sla, now());
      Object.assign(patch, r, { priority: input.priority });
      // an unfinished pause is added later, when the ticket leaves WAITING (BR-07-6)
      await writeMessage(
        ctx,
        {
          ticket: tk,
          authorSide: 'PLATFORM',
          authorUserId: actor.id,
          authorName: by.name,
          kind: 'PRIORITY_CHANGE',
          visibility: 'INTERNAL',
          body: `Priority changed from ${tk.priority} to ${input.priority}`,
          meta: { from: tk.priority, to: input.priority },
        },
        t,
      );
    }
    if (categoryChange) {
      before.category = tk.category;
      after.category = input.category;
      patch.category = input.category;
    }
    let newAssignee: User | null = null;
    if (assigneeChange) {
      before.assigneeUserId = tk.assigneeUserId;
      after.assigneeUserId = input.assigneeUserId;
      patch.assigneeUserId = input.assigneeUserId;
      if (input.assigneeUserId !== null)
        newAssignee = await User.findByPk(input.assigneeUserId!, { attributes: ['id', 'name'] });
      await writeMessage(
        ctx,
        {
          ticket: tk,
          authorSide: 'PLATFORM',
          authorUserId: actor.id,
          authorName: by.name,
          kind: 'ASSIGNMENT',
          visibility: 'INTERNAL',
          body: newAssignee ? `Assigned to ${newAssignee.name ?? 'a team member'}` : 'Unassigned',
          meta: { from: tk.assigneeUserId, to: input.assigneeUserId },
        },
        t,
      );
    }
    await tk.update({ ...patch, version: tk.version + 1, updatedBy: actor.id }, { transaction: t });
    await auditTicket(ctx, tk, AUDIT.ticketUpdated, { before, after, reason: input.closeReason ?? null }, t);

    const name = await societyName(tk.societyId);
    if (statusChange && from !== tk.status) notifyStatusChanged(t, tk, `/settings/support/${tk.id}`);
    if (assigneeChange && newAssignee && newAssignee.id !== actor.id)
      notifyAfterCommit(t, 'platform.ticket.assigned', [newAssignee.id!], {
        ticketNo: ticketNo(tk.id!),
        subject: tk.subject,
        societyName: name,
        link: platformLink(tk.id!),
      });
    emitTicketChanged(t, tk, { statusChanged: statusChange });
    return tk.id!;
  });
  return fullView(result);
}

export interface ReplyInput {
  body: string;
  visibility?: 'PUBLIC' | 'INTERNAL';
  fileIds?: number[];
}

/** `POST /platform/tickets/:id/messages`: public reply or internal note (BR-07-5, 10, 14). */
export async function addPlatformMessage(ctx: Ctx, id: number, input: ReplyInput) {
  const visibility = input.visibility ?? 'PUBLIC';
  const actor = ctx.user!;
  const name = actor.name ?? 'SocietyApp Support';
  const out = await sequelize.transaction(async t => {
    const tk = await lockTicket(id, t);
    if (tk.status === 'CLOSED') throw ticketClosed();
    const at = now();
    const message = await writeMessage(
      ctx,
      {
        ticket: tk,
        authorSide: 'PLATFORM',
        authorUserId: actor.id,
        authorName: name,
        visibility,
        body: input.body,
        fileIds: input.fileIds,
      },
      t,
    );
    const patch: Record<string, unknown> = {
      messageCount: tk.messageCount + 1,
      lastMessageAt: at,
      version: tk.version + 1,
      updatedBy: actor.id,
    };
    const prevStatus = tk.status;
    if (visibility === 'PUBLIC') {
      patch.lastPlatformMessageAt = at;
      if (!tk.firstRespondedAt) patch.firstRespondedAt = at;
      if (tk.status === 'OPEN') {
        Object.assign(
          patch,
          await applyTransition(
            ctx,
            tk,
            { to: 'IN_PROGRESS', by: { side: 'PLATFORM', userId: actor.id, name } },
            t,
          ),
        );
      }
      if (!tk.assigneeUserId) {
        patch.assigneeUserId = actor.id;
        await writeMessage(
          ctx,
          {
            ticket: tk,
            authorSide: 'PLATFORM',
            authorUserId: actor.id,
            authorName: name,
            kind: 'ASSIGNMENT',
            visibility: 'INTERNAL',
            body: `Assigned to ${name}`,
            meta: { from: null, to: actor.id },
          },
          t,
        );
      }
    }
    await tk.update(patch, { transaction: t });
    await auditTicket(
      ctx,
      tk,
      AUDIT.ticketMessageAdded,
      { after: { messageId: message.id, visibility }, internal: visibility === 'INTERNAL' },
      t,
    );
    if (visibility === 'PUBLIC') {
      const sName = await societyName(tk.societyId);
      notifyAfterCommit(
        t,
        'platform.ticket.replied',
        () => raiserRecipients(tk.societyId, tk.raisedByUserId),
        {
          ticketNo: ticketNo(tk.id!),
          subject: tk.subject,
          societyName: sName,
          link: `/settings/support/${tk.id}`,
        },
      );
      emitTicketChanged(t, tk, { statusChanged: prevStatus !== tk.status, society: true });
    } else emitTicketChanged(t, tk, { statusChanged: false });
    return { message, ticketId: tk.id! };
  });
  const tk = (await PlatformTicket.findByPk(out.ticketId))!;
  const c = await ticketContext([tk]);
  const [mv] = await messageViews([out.message], { society: false });
  return {
    message: mv!,
    ticket: {
      id: tk.id!,
      status: tk.status,
      version: tk.version,
      assignee: tk.assigneeUserId
        ? { id: tk.assigneeUserId, name: c.users.get(tk.assigneeUserId) ?? 'User' }
        : null,
    },
  };
}

/** Used by tests and the dashboard: assignee-aware recipient fallback (edge case "assignee is disabled"). */
export async function assigneeOrSupport(tk: PlatformTicket): Promise<number[]> {
  if (tk.assigneeUserId) {
    const u = await User.findByPk(tk.assigneeUserId, { attributes: ['id', 'status'] });
    if (u?.status === 'ACTIVE') return [tk.assigneeUserId];
  }
  return supportTeam();
}
