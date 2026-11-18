import { Op, type Transaction } from 'sequelize';
import {
  AuditLog,
  Ticket,
  TicketAssignment,
  TicketCategory,
  TicketComment,
  User,
  sequelize,
} from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, ValidationError } from '../../utils/errors';
import { pageMeta, type PageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import {
  AUDIT,
  ENTITY,
  ERR,
  type Priority,
  type SlaState,
  type TicketKind,
  type TicketStatus,
  type WaitingReason,
} from './helpdesk.constants';
import { loadLabels } from './helpdesk.admin.dto';
import { reportBuildingIssue, ticketFileUrl } from './helpdesk.admin.service';
import { adminSchemas } from './helpdesk.admin.validation';
import { helpdeskPorts } from './helpdesk.ports';
import { allowedActions } from './helpdesk.state';
import { factsOf, notFound, societyIdOf, userActor } from './helpdesk.shared';
import { slaState } from './helpdesk.sla';
import { addComment } from './helpdesk.tickets.comment';
import { loadEffectiveCategory } from './helpdesk.tickets.core';
import { transitionTicket } from './helpdesk.tickets.transition';
import type { Actor } from './helpdesk.types';
import { commentWhere, workVisibleWhere, type CommentAudience } from './helpdesk.visibility';

/** 8.30 service functions for the staff app (module 28). Each runs in its own transaction; visibility is BR-15-53 (404 TICKET_NOT_FOUND otherwise). */

export interface WorkTicketDto {
  id: number;
  ticketNo: string;
  kind: TicketKind;
  title: string;
  description: string;
  status: TicketStatus;
  priority: Priority;
  categoryName: string;
  locationLabel: string;
  unitLabel: string | null;
  preferredSlot: { from: string; to: string } | null;
  requesterName: string;
  requesterMobile: string | null;
  resolutionDueAt: string;
  slaState: SlaState;
  requiresAfterPhoto: boolean;
  isChargeable: boolean;
  chargeStatus: string;
  fileIds: number[];
  allowedActions: ('START' | 'WAIT_ON_RESIDENT' | 'RESUME' | 'RESOLVE')[];
  version: number;
}
export interface WorkCommentDto {
  id: number;
  kind: string;
  visibility: string;
  authorRole: string;
  authorName: string;
  body: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  fileIds: number[];
  createdAt: string;
}

const ACTIVE = ['ASSIGNED', 'IN_PROGRESS', 'WAITING_ON_RESIDENT', 'REOPENED'];
const WORK_ACTIONS = ['START', 'WAIT_ON_RESIDENT', 'RESUME', 'RESOLVE'] as const;
const DAY = 86_400_000;

const visible = async (ctx: Ctx, extra: object = {}) => ({
  [Op.and]: [await workVisibleWhere(ctx), extra],
});

async function visibleTicket(ctx: Ctx, id: number, t?: Transaction): Promise<Ticket> {
  const row = await Ticket.findOne({ where: await visible(ctx, { id }), transaction: t });
  if (!row) throw notFound();
  return row;
}

/** Vendors see public entries only; staff (member or staff assignees) see internal notes too. */
async function audienceOf(ticket: Ticket): Promise<CommentAudience> {
  const a = ticket.currentAssignmentId ? await TicketAssignment.findByPk(ticket.currentAssignmentId) : null;
  return a?.assigneeType === 'VENDOR' ? 'VENDOR' : 'STAFF';
}

async function toWorkDtos(ctx: Ctx, rows: Ticket[], withMobile = false): Promise<WorkTicketDto[]> {
  const societyId = societyIdOf(ctx);
  const labels = await loadLabels(societyId, rows);
  const names = new Map(
    (
      await TicketCategory.findAll({
        where: { societyId, id: [...new Set(rows.map(r => r.categoryId))] },
        attributes: ['id', 'name'],
        paranoid: false,
      })
    ).map(c => [c.id, c.name]),
  );
  const out: WorkTicketDto[] = [];
  for (const r of rows) {
    const eff = await loadEffectiveCategory(societyId, r.categoryId, r.subCategoryId, undefined, {
      allowArchived: true,
    }).catch(() => null);
    const personal = r.kind === 'PERSONAL';
    let mobile: string | null = null;
    if (
      withMobile &&
      personal &&
      r.requesterUserId &&
      ['ASSIGNED', 'IN_PROGRESS', 'WAITING_ON_RESIDENT', 'REOPENED'].includes(r.status)
    )
      mobile = (await User.findByPk(r.requesterUserId, { attributes: ['mobile'] }))?.mobile ?? null;
    // staff cannot resolve an approved chargeable ticket: the office enters the final charge (8.30)
    const actions = allowedActions(factsOf(r), new Set(['ASSIGNEE'])).filter(
      (a): a is (typeof WORK_ACTIONS)[number] =>
        (WORK_ACTIONS as readonly string[]).includes(a) &&
        !(a === 'RESOLVE' && r.chargeStatus === 'APPROVED'),
    );
    out.push({
      id: r.id,
      ticketNo: r.ticketNo,
      kind: r.kind,
      title: r.title,
      description: r.description,
      status: r.status,
      priority: r.priority,
      categoryName: names.get(r.categoryId) ?? '',
      locationLabel: (personal ? labels.unit(r.unitId) : labels.location(r.locationNodeId)) ?? '',
      unitLabel: labels.unit(r.unitId),
      preferredSlot:
        r.preferredSlotFrom && r.preferredSlotTo
          ? { from: r.preferredSlotFrom.toISOString(), to: r.preferredSlotTo.toISOString() }
          : null,
      requesterName: r.requesterName,
      requesterMobile: mobile,
      resolutionDueAt: r.resolutionDueAt.toISOString(),
      slaState: slaState(r, now()),
      requiresAfterPhoto: Boolean(eff?.requiresAfterPhoto),
      isChargeable: r.isChargeable,
      chargeStatus: r.chargeStatus,
      fileIds: helpdeskPorts().files.list('ticket', r.id),
      allowedActions: actions,
      version: r.version,
    });
  }
  return out;
}

const toWorkComment = (c: TicketComment): WorkCommentDto => ({
  id: c.id,
  kind: c.kind,
  visibility: c.visibility,
  authorRole: c.authorRole,
  authorName: c.authorName,
  body: c.body,
  fromStatus: c.fromStatus,
  toStatus: c.toStatus,
  fileIds: helpdeskPorts().files.list('ticket_comment', c.id),
  createdAt: c.createdAt.toISOString(),
});

async function workActor(ctx: Ctx, ticket: Ticket): Promise<Actor> {
  const vendor = (await audienceOf(ticket)) === 'VENDOR';
  return userActor(ctx, new Set(['ASSIGNEE']), vendor ? 'VENDOR' : 'STAFF');
}

export const workFunctions = {
  async listAssigned(
    ctx: Ctx,
    q: { status?: 'ACTIVE' | 'DONE'; page?: number; limit?: number } = {},
  ): Promise<{ items: WorkTicketDto[]; pagination: PageMeta }> {
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.min(100, Math.max(1, q.limit ?? 20));
    const since = new Date(now().getTime() - 7 * DAY);
    const extra =
      q.status === 'DONE'
        ? { status: { [Op.in]: ['RESOLVED', 'CLOSED'] }, resolvedAt: { [Op.gte]: since } }
        : { status: { [Op.in]: ACTIVE } };
    const { rows, count } = await Ticket.findAndCountAll({
      where: await visible(ctx, extra),
      order: [
        ['priority', 'ASC'],
        ['resolutionDueAt', 'ASC'],
        ['id', 'ASC'],
      ],
      limit,
      offset: (page - 1) * limit,
    });
    return { items: await toWorkDtos(ctx, rows), pagination: pageMeta(page, limit, count) };
  },

  countActive: async (ctx: Ctx): Promise<number> =>
    Ticket.count({ where: await visible(ctx, { status: { [Op.in]: ACTIVE } }) }),

  async get(ctx: Ctx, ticketId: number): Promise<WorkTicketDto & { comments: WorkCommentDto[] }> {
    const t = await visibleTicket(ctx, ticketId);
    const [dto] = await toWorkDtos(ctx, [t], true);
    if (dto!.requesterMobile) await recordContactView(ctx, t);
    const audience = await audienceOf(t);
    const comments = await TicketComment.findAll({
      where: { ticketId: t.id, kind: { [Op.ne]: 'ESCALATION' }, ...commentWhere(audience) },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    return { ...dto!, comments: comments.map(toWorkComment) };
  },

  async transition(
    ctx: Ctx,
    ticketId: number,
    input: {
      action: 'START' | 'WAIT_ON_RESIDENT' | 'RESUME' | 'RESOLVE';
      note?: string;
      waitingReason?: WaitingReason;
      fileIds?: number[];
      version: number;
    },
  ): Promise<WorkTicketDto> {
    if (!(WORK_ACTIONS as readonly string[]).includes(input.action))
      throw new ValidationError([{ field: 'action', message: 'START, WAIT_ON_RESIDENT, RESUME or RESOLVE' }]);
    await sequelize.transaction(async t => {
      const row = await visibleTicket(ctx, ticketId, t);
      if (input.action === 'RESOLVE' && row.chargeStatus === 'APPROVED')
        throw new AppError(409, ERR.invalidTransition, 'Ask the office to enter the final charge');
      await transitionTicket(ctx, ticketId, await workActor(ctx, row), { ...input }, t);
    });
    const [dto] = await toWorkDtos(ctx, [await visibleTicket(ctx, ticketId)]);
    return dto!;
  },

  async addComment(
    ctx: Ctx,
    ticketId: number,
    input: { body: string; visibility: 'PUBLIC' | 'INTERNAL'; fileIds?: number[] },
  ): Promise<WorkCommentDto> {
    const row = await sequelize.transaction(async t => {
      const tk = await visibleTicket(ctx, ticketId, t);
      return addComment(ctx, ticketId, await workActor(ctx, tk), input, t);
    });
    return toWorkComment(row);
  },

  async getFileUrl(ctx: Ctx, ticketId: number, fileId: number, disposition: 'inline' | 'attachment') {
    const t = await visibleTicket(ctx, ticketId);
    return ticketFileUrl(ctx, t, fileId, await audienceOf(t), disposition);
  },

  async reportBuildingIssue(ctx: Ctx, input: Record<string, unknown>) {
    const parsed = adminSchemas.workBuildingIssue.safeParse(input);
    if (!parsed.success)
      throw new ValidationError(
        parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
      );
    const t = await reportBuildingIssue(ctx, parsed.data, 'WORK');
    return {
      id: t.id,
      ticketNo: t.ticketNo,
      status: t.status,
      priority: t.priority,
      affectedUnitCount: t.affectedUnitCount ?? 0,
    };
  },
};

/** `helpdesk.ticket.contact_viewed`, once per assignment (the entity label carries the assignment id). */
async function recordContactView(ctx: Ctx, t: Ticket): Promise<void> {
  const label = `assignment:${t.currentAssignmentId}`;
  const seen = await AuditLog.count({
    where: {
      societyId: t.societyId,
      action: AUDIT.contactViewed,
      entityType: ENTITY.ticket,
      entityId: String(t.id),
      entityLabel: label,
    },
  });
  if (!seen)
    await audit(ctx, {
      action: AUDIT.contactViewed,
      entityType: ENTITY.ticket,
      entityId: t.id,
      entityLabel: label,
      societyId: t.societyId,
    });
}
