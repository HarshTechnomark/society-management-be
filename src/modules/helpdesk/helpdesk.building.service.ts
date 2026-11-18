import { Op, type Transaction } from 'sequelize';
import { Ticket, TicketCategory, TicketUpvote, User, sequelize } from '../../models';
import { AppError, NotFoundError, UnprocessableError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { assertFeature } from '../subscriptions/entitlements.service';
import { societyToday } from '../billing/billing.runs.shared';
import { locations } from '../society-setup/society-setup.public';
import {
  ENT,
  ERR,
  LIMITS,
  NON_TERMINAL,
  SETTING,
  type AffectedLevel,
  type Channel,
  type ReporterRole,
  type Urgency,
} from './helpdesk.constants';
import { findSimilarBuilding } from './helpdesk.duplicates';
import { residentTicketDtos } from './helpdesk.resident.dto';
import { residentVisibleWhere } from './helpdesk.visibility';
import { deriveAffectedLevel } from './helpdesk.rules';
import { ensureSeededOnce } from './helpdesk.seed';
import { setting, societyIdOf } from './helpdesk.shared';
import { createTicket } from './helpdesk.tickets.core';

/** Building issue reporting for the four audiences (8.10), the duplicate check (8.11), the QR prefill (8.25) and the resident daily limit (BR-15-14). */

export type Audience = 'RESIDENT' | 'GATE' | 'WORK';

const ROLE: Record<Audience, { reporterRole: ReporterRole; channel: Channel }> = {
  RESIDENT: { reporterRole: 'RESIDENT', channel: 'APP' },
  GATE: { reporterRole: 'GUARD', channel: 'GATE' },
  WORK: { reporterRole: 'STAFF', channel: 'STAFF_APP' },
};

export interface BuildingIssueBody {
  locationNodeId?: number;
  qrToken?: string;
  affectedLevel?: AffectedLevel;
  categoryId: number;
  subCategoryId?: number;
  urgency: Urgency;
  title?: string;
  description?: string;
  assetId?: number;
  duplicateReason?: string;
  fileIds?: number[];
}

/** Start of the society's local day (the society time zone is Asia/Kolkata everywhere in the code base). */
export async function localDayStart(societyId: number): Promise<Date> {
  return new Date(`${await societyToday(societyId)}T00:00:00+05:30`);
}

/** BR-15-14: a resident may create at most `helpdesk.residentDailyTicketLimit` tickets (both kinds) per society local day. */
export async function lockUserForLimit(userId: number, t: Transaction): Promise<void> {
  // serialises one user's concurrent creates so the count below sees every committed ticket (no check-then-insert race)
  await User.findByPk(userId, { attributes: ['id'], transaction: t, lock: t.LOCK.UPDATE });
}

/** Must run inside the create transaction: the user row is locked, then today's tickets are counted. */
export async function assertDailyLimit(ctx: Ctx, t: Transaction): Promise<void> {
  const societyId = societyIdOf(ctx);
  const userId = ctx.user?.id;
  if (!userId) return;
  await lockUserForLimit(userId, t);
  const limit = await setting<number>(societyId, SETTING.residentDailyLimit);
  const used = await Ticket.count({
    where: {
      societyId,
      raisedByUserId: userId,
      reporterRole: 'RESIDENT',
      createdAt: { [Op.gte]: await localDayStart(societyId) },
    },
    transaction: t,
  });
  if (used >= limit)
    throw new AppError(429, ERR.rateLimited, `You can raise at most ${limit} requests a day`, undefined, {
      'Retry-After': '3600',
    });
}

/**
 * 8.10 `buildingIssues.report(ctx, input, audience)`: resolves a QR token (Standard plan, channel QR), applies the resident daily limit and creates the
 * ticket through the core. Returns the created ticket's essentials.
 */
export async function reportBuildingIssue(ctx: Ctx, body: BuildingIssueBody, audience: Audience) {
  const societyId = societyIdOf(ctx);
  let { channel } = ROLE[audience];
  let nodeId = body.locationNodeId;
  if (body.qrToken) {
    await assertFeature(ctx, ENT.qr);
    const node = await locations.getByQrToken(societyId, body.qrToken);
    if (!node || node.status !== 'ACTIVE') throw new NotFoundError(ERR.qrNotFound, 'QR code not found');
    if (nodeId !== undefined && nodeId !== node.id)
      throw new ValidationError([{ field: 'locationNodeId', message: 'Does not match the QR code' }]);
    nodeId = node.id;
    channel = 'QR';
  }
  if (!nodeId) throw new ValidationError([{ field: 'locationNodeId', message: 'A location is required' }]);
  const created = await sequelize.transaction(async t => {
    if (audience === 'RESIDENT') await assertDailyLimit(ctx, t);
    return createTicket(
      ctx,
      {
        kind: 'BUILDING',
        categoryId: body.categoryId,
        subCategoryId: body.subCategoryId ?? null,
        locationNodeId: nodeId,
        affectedLevel: body.affectedLevel ?? null,
        title: body.title,
        description: body.description,
        urgency: body.urgency,
        channel,
        reporterRole: ROLE[audience].reporterRole,
        assetId: body.assetId ?? null,
        duplicateReason: body.duplicateReason,
        fileIds: body.fileIds,
      },
      t,
    );
  });
  return created;
}

/** Response of `POST …/building-issues` for each audience. */
export async function reportResponse(
  ctx: Ctx,
  audience: Audience,
  created: Awaited<ReturnType<typeof reportBuildingIssue>>,
) {
  const message = `Issue reported.${created.affectedUnitCount ? ` ${created.affectedUnitCount} flat${created.affectedUnitCount === 1 ? '' : 's'} will get updates.` : ''}`;
  if (audience === 'RESIDENT') {
    const row = await Ticket.findByPk(created.id);
    const [dto] = await residentTicketDtos(ctx, [row!]);
    return { data: dto!, message };
  }
  return {
    data: {
      id: created.id,
      ticketNo: created.ticketNo,
      status: created.status,
      priority: created.priority,
      affectedUnitCount: created.affectedUnitCount,
    },
    message,
  };
}

// ------------------------------------------------------------------ similar (8.11)
export interface SimilarItem {
  id: number;
  ticketNo: string;
  title: string;
  status: string;
  priority: string;
  locationLabel: string | null;
  upvoteCount: number;
  createdAt: string;
  iUpvoted: boolean;
  isRequester: boolean;
}

/** BR-15-17. Residents get the matches they could open (BR-15-50) plus the matches at the same node. */
export async function similarIssues(
  ctx: Ctx,
  audience: Audience,
  q: { locationNodeId: number; categoryId: number; q?: string },
): Promise<{ items: SimilarItem[] }> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  const node = await locations.get(societyId, q.locationNodeId);
  if (!node) throw new NotFoundError(ERR.locationNotFound, 'Location not found');
  if (node.status !== 'ACTIVE')
    throw new UnprocessableError(ERR.locationArchived, 'This location is archived');
  const cat = await TicketCategory.findOne({ where: { id: q.categoryId, societyId, parentId: null } });
  if (!cat) throw new NotFoundError(ERR.categoryNotFound, 'Category not found');
  if (cat.status !== 'ACTIVE')
    throw new UnprocessableError(ERR.categoryArchived, 'This category is archived');
  let found = await findSimilarBuilding(societyId, {
    locationNodeId: node.id,
    categoryId: cat.id,
    buildingId: node.buildingId,
    q: q.q,
  });
  if (audience === 'RESIDENT' && found.length) {
    const where = await residentVisibleWhere(ctx);
    const ok = new Set(
      (
        await Ticket.findAll({
          where: { [Op.and]: [where, { id: { [Op.in]: found.map(f => f.id) } }] },
          attributes: ['id'],
        })
      ).map(r => r.id),
    );
    found = found.filter(f => f.sameNode || ok.has(f.id));
  }
  const userId = ctx.user?.id ?? 0;
  const ids = found.map(f => f.id);
  const rows = ids.length
    ? await Ticket.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'requesterUserId'] })
    : [];
  const requester = new Map(rows.map(r => [r.id, r.requesterUserId]));
  const ups = new Set(
    ids.length
      ? (
          await TicketUpvote.findAll({
            where: { userId, ticketId: { [Op.in]: ids } },
            attributes: ['ticketId'],
          })
        ).map(u => u.ticketId)
      : [],
  );
  const labels = new Map<number, string>();
  for (const f of found)
    if (f.locationNodeId && !labels.has(f.locationNodeId)) {
      const n = await locations.get(societyId, f.locationNodeId);
      if (n) labels.set(f.locationNodeId, n.pathLabel);
    }
  return {
    items: found.map(f => ({
      id: f.id,
      ticketNo: f.ticketNo,
      title: f.title,
      status: f.status,
      priority: f.priority,
      locationLabel: f.locationNodeId ? (labels.get(f.locationNodeId) ?? null) : null,
      upvoteCount: f.upvoteCount,
      createdAt: f.createdAt.toISOString(),
      iUpvoted: ups.has(f.id),
      isRequester: requester.get(f.id) === userId,
    })),
  };
}

// ------------------------------------------------------------------ QR prefill (8.25)
const AREA_CATEGORY: Record<string, string> = {
  LIFT: 'Lift',
  PUMP_ROOM: 'Water supply',
  WATER_TANK: 'Water supply',
  GYM: 'Gym equipment',
  GARDEN: 'Garden',
  GATE: 'Security',
  SECURITY_CABIN: 'Security',
  GARBAGE_AREA: 'Housekeeping',
};

export async function qrPrefill(ctx: Ctx, qrToken: string) {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  const node = await locations.getByQrToken(societyId, qrToken);
  if (!node || node.status !== 'ACTIVE') throw new NotFoundError(ERR.qrNotFound, 'QR code not found');
  const wanted =
    (node.nodeType === 'AREA' && node.areaType ? AREA_CATEGORY[node.areaType] : undefined) ?? 'Other';
  const cats = await TicketCategory.findAll({
    where: {
      societyId,
      parentId: null,
      status: 'ACTIVE',
      name: wanted,
      scope: { [Op.in]: ['BUILDING', 'BOTH'] },
    },
    attributes: ['id'],
    order: [['id', 'ASC']],
  });
  const open = await Ticket.findAll({
    where: { societyId, kind: 'BUILDING', locationNodeId: node.id, status: { [Op.in]: [...NON_TERMINAL] } },
    order: [
      ['upvoteCount', 'DESC'],
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: LIMITS.similarMax,
  });
  const userId = ctx.user?.id ?? 0;
  const ups = new Set(
    open.length
      ? (
          await TicketUpvote.findAll({
            where: { userId, ticketId: { [Op.in]: open.map(o => o.id) } },
            attributes: ['ticketId'],
          })
        ).map(u => u.ticketId)
      : [],
  );
  return {
    location: { id: node.id, pathLabel: node.pathLabel, nodeType: node.nodeType, areaType: node.areaType },
    suggestedAffectedLevel: deriveAffectedLevel(node),
    suggestedCategoryIds: cats.map(c => c.id),
    openIssuesHere: open.map(o => ({
      id: o.id,
      ticketNo: o.ticketNo,
      title: o.title,
      status: o.status,
      priority: o.priority,
      locationLabel: node.pathLabel,
      upvoteCount: o.upvoteCount,
      createdAt: o.createdAt.toISOString(),
      iUpvoted: ups.has(o.id),
      isRequester: o.requesterUserId === userId,
    })),
  };
}
