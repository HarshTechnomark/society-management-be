import { Op, type Transaction, type WhereOptions } from 'sequelize';
import { PlatformTicket, PlatformTicketMessage, Role, Society, sequelize } from '../../models';
import type { TicketCategory, TicketPriority, TicketStatus } from '../../models/platform-ticket.model';
import { addDays, now, nowMs } from '../../lib/clock';
import { ConflictError, RateLimitedError, UnprocessableError, ValidationError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { getPlatformSetting } from './platform-ops.settings.service';
import { dueTimes } from './platform-ops.sla';
import { AUDIT, parseTicketNo, ticketNo } from './platform-ops.types';
import {
  applyTransition,
  auditTicket,
  emitTicketChanged,
  invalidState,
  lockTicket,
  societyLink,
  platformLink,
  ticketClosed,
  ticketNotFound,
  writeMessage,
} from './platform-ops.tickets.core';
import { likeEscape, messageViews, societyTicketView, ticketContext } from './platform-ops.tickets.view';
import { assertOpenLimit, assigneeOrSupport } from './platform-ops.tickets.service';
import { emitAfterCommit, notifyAfterCommit, supportTeam } from './platform-ops.notify';

/** Society side of support tickets (module 07 section 8.4). Every query adds `societyId` from the request context. */
const DAY_MS = 86_400_000;
const CREATE_LIMIT_PER_DAY = 20;

const societyOf = (ctx: Ctx): number => ctx.society!.id;

/** "Name, Role label, Society" (section 8.4); a platform user under a support grant is named as such. */
async function authorName(ctx: Ctx): Promise<string> {
  const user = ctx.user?.name ?? 'Member';
  if (ctx.membership) {
    const role = await Role.findByPk(ctx.membership.roleId, { attributes: ['name'] });
    return `${user}, ${role?.name ?? ctx.membership.roleKey}, ${ctx.society!.name}`;
  }
  return `${user}, SocietyApp Support, ${ctx.society!.name}`;
}

export interface SocietyTicketQuery {
  status?: TicketStatus[];
  q?: string;
  sortBy: 'createdAt' | 'lastMessageAt';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

export async function listTickets(ctx: Ctx, q: SocietyTicketQuery) {
  const and: WhereOptions[] = [{ societyId: societyOf(ctx) }];
  if (q.status) and.push({ status: { [Op.in]: q.status } });
  if (q.q) {
    const no = parseTicketNo(q.q);
    and.push(no !== null ? { id: no } : { subject: { [Op.like]: `%${likeEscape(q.q)}%` } });
  }
  const { rows, count } = await PlatformTicket.findAndCountAll({
    where: { [Op.and]: and },
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const c = await ticketContext(rows);
  const days = await getPlatformSetting('support.autoCloseDays');
  return { data: rows.map(t => societyTicketView(t, c, days)), pagination: pageMeta(q.page, q.limit, count) };
}

async function fullView(ctx: Ctx, id: number) {
  const t = await PlatformTicket.findOne({ where: { id, societyId: societyOf(ctx) } });
  if (!t) throw ticketNotFound();
  const msgs = await PlatformTicketMessage.findAll({
    where: { ticketId: id, societyId: societyOf(ctx), visibility: 'PUBLIC' },
    order: [['id', 'ASC']],
  });
  const days = await getPlatformSetting('support.autoCloseDays');
  return societyTicketView(t, await ticketContext([t]), days, await messageViews(msgs, { society: true }));
}

export const getTicket = (ctx: Ctx, id: number) => fullView(ctx, id);

export interface CreateInput {
  subject: string;
  category: TicketCategory;
  priority?: TicketPriority;
  body: string;
  fileIds?: number[];
}

/** `POST /support-tickets` (BR-07-1, 3, 4). Exempt from the suspended-society block (BR-07-18). */
export async function createTicket(ctx: Ctx, input: CreateInput) {
  const societyId = societyOf(ctx);
  const sla = await getPlatformSetting('support.slaHours');
  const priority = input.priority ?? 'MEDIUM';
  const at = now();
  const name = await authorName(ctx);
  const id = await sequelize.transaction(async t => {
    await Society.findByPk(societyId, { transaction: t, lock: t.LOCK.UPDATE });
    const recent = await PlatformTicket.findAll({
      where: { societyId, source: 'ADMIN_APP', createdAt: { [Op.gt]: new Date(nowMs() - DAY_MS) } },
      attributes: ['createdAt'],
      order: [['createdAt', 'ASC']],
      transaction: t,
    });
    if (recent.length >= CREATE_LIMIT_PER_DAY)
      throw new RateLimitedError((recent[0]!.createdAt!.getTime() + DAY_MS - nowMs()) / 1000);
    await assertOpenLimit(societyId, t);
    const tk = await PlatformTicket.create(
      {
        societyId,
        raisedByUserId: ctx.user!.id,
        source: 'ADMIN_APP',
        subject: input.subject,
        category: input.category,
        priority,
        status: 'OPEN',
        assigneeUserId: null,
        ...dueTimes(at, priority, sla),
        firstRespondedAt: null,
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
        lastSocietyMessageAt: at,
        lastPlatformMessageAt: null,
        messageCount: 1,
        satisfactionRating: null,
        satisfactionComment: null,
        ratedAt: null,
        version: 1,
        createdBy: ctx.user!.id,
        updatedBy: ctx.user!.id,
        createdAt: at,
        updatedAt: at,
      },
      { transaction: t },
    );
    await writeMessage(
      ctx,
      {
        ticket: tk,
        authorSide: 'SOCIETY',
        authorUserId: ctx.user!.id,
        authorName: name,
        body: input.body,
        fileIds: input.fileIds,
      },
      t,
    );
    await auditTicket(
      ctx,
      tk,
      AUDIT.ticketCreated,
      { after: { subject: tk.subject, category: tk.category, priority, source: 'ADMIN_APP' } },
      t,
    );
    const data = {
      ticketNo: ticketNo(tk.id!),
      subject: tk.subject,
      societyName: ctx.society!.name,
      priority,
      category: tk.category,
    };
    notifyAfterCommit(t, 'platform.ticket.created_alert', supportTeam, {
      ...data,
      link: platformLink(tk.id!),
    });
    notifyAfterCommit(t, 'platform.ticket.created_confirmation', [ctx.user!.id], {
      ...data,
      expectedBy: tk.firstResponseDueAt.toISOString(),
      link: societyLink(tk.id!),
    });
    emitAfterCommit(t, [
      {
        room: 'platform:support',
        event: 'platform.ticket.created',
        payload: { ticketId: tk.id!, societyId },
      },
    ]);
    return tk.id!;
  });
  return fullView(ctx, id);
}

/** BR-07-11: reopen only inside the window and at most five times. */
async function assertReopenable(tk: PlatformTicket): Promise<void> {
  const days = await getPlatformSetting('support.autoCloseDays');
  if (tk.resolvedAt && now() > addDays(tk.resolvedAt, days))
    throw new UnprocessableError(
      'REOPEN_WINDOW_EXPIRED',
      `A resolved ticket can only be reopened within ${days} days`,
    );
  if (tk.reopenCount >= 5)
    throw new UnprocessableError(
      'REOPEN_LIMIT_REACHED',
      'This ticket has been reopened the maximum number of times',
    );
}

/** Moves a RESOLVED ticket to IN_PROGRESS as a reopen (BR-07-11). Returns the column patch. */
async function reopenPatch(ctx: Ctx, tk: PlatformTicket, name: string, t: Transaction) {
  const sla = await getPlatformSetting('support.slaHours');
  const patch = await applyTransition(
    ctx,
    tk,
    {
      to: 'IN_PROGRESS',
      by: { side: 'SOCIETY', userId: ctx.user!.id, name },
      body: 'Reopened by the society',
    },
    t,
    sla,
  );
  return { ...patch, reopenCount: tk.reopenCount + 1 };
}

async function notifyReply(t: Transaction, tk: PlatformTicket, ctx: Ctx) {
  notifyAfterCommit(t, 'platform.ticket.society_replied', () => assigneeOrSupport(tk), {
    ticketNo: ticketNo(tk.id!),
    subject: tk.subject,
    societyName: ctx.society!.name,
    link: platformLink(tk.id!),
  });
}

export interface ReplyInput {
  body: string;
  fileIds?: number[];
}

/** `POST /support-tickets/:id/messages`: reply; WAITING and RESOLVED tickets go back to IN_PROGRESS (BR-07-10). */
export async function addMessage(ctx: Ctx, id: number, input: ReplyInput) {
  const name = await authorName(ctx);
  const out = await sequelize.transaction(async t => {
    const tk = await lockTicket(id, t, societyOf(ctx));
    if (tk.status === 'CLOSED') throw ticketClosed();
    const reopening = tk.status === 'RESOLVED';
    if (reopening) {
      if (input.body.length < 10)
        throw new ValidationError([{ field: 'body', message: 'Tell us why in at least 10 characters' }]);
      await assertReopenable(tk);
    }
    const at = now();
    const message = await writeMessage(
      ctx,
      {
        ticket: tk,
        authorSide: 'SOCIETY',
        authorUserId: ctx.user!.id,
        authorName: name,
        body: input.body,
        fileIds: input.fileIds,
      },
      t,
    );
    const patch: Record<string, unknown> = {
      messageCount: tk.messageCount + 1,
      lastMessageAt: at,
      lastSocietyMessageAt: at,
      version: tk.version + 1,
      updatedBy: ctx.user!.id,
    };
    const prev = tk.status;
    if (reopening) Object.assign(patch, await reopenPatch(ctx, tk, name, t));
    else if (tk.status === 'WAITING')
      Object.assign(
        patch,
        await applyTransition(
          ctx,
          tk,
          { to: 'IN_PROGRESS', by: { side: 'SOCIETY', userId: ctx.user!.id, name } },
          t,
        ),
      );
    await tk.update(patch, { transaction: t });
    await auditTicket(
      ctx,
      tk,
      AUDIT.ticketMessageAdded,
      { after: { messageId: message.id, visibility: 'PUBLIC' } },
      t,
    );
    if (reopening)
      await auditTicket(
        ctx,
        tk,
        AUDIT.ticketReopened,
        { before: { status: prev }, after: { status: tk.status } },
        t,
      );
    await notifyReply(t, tk, ctx);
    emitTicketChanged(t, tk, { statusChanged: prev !== tk.status, society: true });
    return { messageId: message.id!, ticketId: tk.id! };
  });
  const msg = (await PlatformTicketMessage.findByPk(out.messageId))!;
  const [mv] = await messageViews([msg], { society: true });
  return { message: mv!, ticket: await fullView(ctx, out.ticketId) };
}

/** `POST /support-tickets/:id/reopen` (BR-07-11). */
export async function reopenTicket(ctx: Ctx, id: number, input: { body: string }) {
  const name = await authorName(ctx);
  await sequelize.transaction(async t => {
    const tk = await lockTicket(id, t, societyOf(ctx));
    if (tk.status === 'CLOSED') throw ticketClosed();
    if (tk.status !== 'RESOLVED') throw invalidState('Only a resolved ticket can be reopened');
    await assertReopenable(tk);
    const at = now();
    await writeMessage(
      ctx,
      { ticket: tk, authorSide: 'SOCIETY', authorUserId: ctx.user!.id, authorName: name, body: input.body },
      t,
    );
    const patch = await reopenPatch(ctx, tk, name, t);
    await tk.update(
      {
        ...patch,
        messageCount: tk.messageCount + 1,
        lastMessageAt: at,
        lastSocietyMessageAt: at,
        version: tk.version + 1,
        updatedBy: ctx.user!.id,
      },
      { transaction: t },
    );
    await auditTicket(
      ctx,
      tk,
      AUDIT.ticketReopened,
      { before: { status: 'RESOLVED' }, after: { status: 'IN_PROGRESS' } },
      t,
    );
    await notifyReply(t, tk, ctx);
    emitTicketChanged(t, tk, { statusChanged: true, society: true });
  });
  return fullView(ctx, id);
}

/** `POST /support-tickets/:id/close`: a WAITING period is settled first (BR-07-6). */
export async function closeTicket(ctx: Ctx, id: number, input: { reason?: string }) {
  const name = await authorName(ctx);
  await sequelize.transaction(async t => {
    const tk = await lockTicket(id, t, societyOf(ctx));
    if (tk.status === 'CLOSED') throw ticketClosed();
    const prev = tk.status;
    const patch = await applyTransition(
      ctx,
      tk,
      {
        to: 'CLOSED',
        by: { side: 'SOCIETY', userId: ctx.user!.id, name },
        body: input.reason || 'Closed by the society',
        closedReason: 'CLOSED_BY_SOCIETY',
      },
      t,
    );
    await tk.update({ ...patch, version: tk.version + 1, updatedBy: ctx.user!.id }, { transaction: t });
    await auditTicket(
      ctx,
      tk,
      AUDIT.ticketClosed,
      { before: { status: prev }, after: { status: 'CLOSED' }, reason: input.reason ?? null },
      t,
    );
    emitTicketChanged(t, tk, { statusChanged: true, society: true });
  });
  return fullView(ctx, id);
}

/** `POST /support-tickets/:id/rating` (BR-07-17): once per ticket, in RESOLVED or CLOSED. */
export async function rateTicket(ctx: Ctx, id: number, input: { rating: number; comment?: string }) {
  await sequelize.transaction(async t => {
    const tk = await lockTicket(id, t, societyOf(ctx));
    if (tk.status !== 'RESOLVED' && tk.status !== 'CLOSED')
      throw invalidState('Only a resolved or closed ticket can be rated');
    if (tk.satisfactionRating !== null)
      throw new ConflictError('RATING_ALREADY_GIVEN', 'This ticket is already rated');
    await tk.update(
      {
        satisfactionRating: input.rating,
        satisfactionComment: input.comment || null,
        ratedAt: now(),
        version: tk.version + 1,
        updatedBy: ctx.user!.id,
      },
      { transaction: t },
    );
    await auditTicket(ctx, tk, AUDIT.ticketRated, { after: { rating: input.rating } }, t);
  });
  return fullView(ctx, id);
}
