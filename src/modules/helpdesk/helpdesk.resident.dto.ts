import { Op } from 'sequelize';
import { Ticket, TicketAssignment, TicketCategory, TicketComment, TicketUpvote } from '../../models';
import { now } from '../../lib/clock';
import type { Ctx } from '../../types/context';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { buildings, locations, units } from '../society-setup/society-setup.public';
import { ENT, LIMITS, NON_TERMINAL, SETTING, type CommentKind, type SlaState } from './helpdesk.constants';
import { helpdeskPorts } from './helpdesk.ports';
import { residents } from '../residents/residents.public';
import { reporterLabel } from './helpdesk.rules';
import { residentTypes } from './helpdesk.resident.access';
import { factsOf, setting, societyIdOf } from './helpdesk.shared';
import { allowedActions } from './helpdesk.state';
import { slaState } from './helpdesk.sla';
import type { CallerTypes } from './helpdesk.types';

/** `ResidentTicketDto` (8.0) and the resident comment item (8.17). Residents never get requester ids, assignee ids, mobiles, escalation levels or internal entries (BR-15-49, BR-15-51). */

/** Timeline kinds a resident may see (8.17); the WHERE clause also fixes `visibility = 'PUBLIC'`. */
export const RESIDENT_KINDS: CommentKind[] = ['COMMENT', 'STATUS_CHANGE', 'ASSIGNMENT', 'MERGE', 'ESTIMATE'];

const DAY = 86_400_000;
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export interface ResidentCommentDto {
  id: number;
  kind: CommentKind;
  visibility: 'PUBLIC';
  authorRole: string;
  authorLabel: string;
  body: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  metadata: Record<string, unknown> | null;
  fileIds: number[];
  notifyAffected: boolean;
  createdAt: string;
  canDelete: false;
}

/** Lookups shared by the mappers of one response. */
export interface DtoLookups {
  showReporter: boolean;
  reopenWindowDays: number;
  maxReopens: number;
  csatOn: boolean;
  escalationOn: boolean;
  categories: Map<number, string>;
  unitLabels: Map<number, string>;
  nodeLabels: Map<number, string>;
  buildingNames: Map<number, string>;
  myUpvotes: Map<number, TicketUpvote>;
  assignedAt: Map<number, Date>;
  /** The caller's active relation to each flat (OWNER, TENANT, FAMILY...). */
  myRelations: Map<number, string>;
}

export async function loadLookups(ctx: Ctx, tickets: Ticket[]): Promise<DtoLookups> {
  const societyId = societyIdOf(ctx);
  const userId = ctx.user?.id ?? 0;
  const catIds = new Set<number>();
  const unitIds = new Set<number>();
  const nodeIds = new Set<number>();
  let needBuildings = false;
  for (const t of tickets) {
    catIds.add(t.categoryId);
    if (t.subCategoryId) catIds.add(t.subCategoryId);
    if (t.unitId) unitIds.add(t.unitId);
    if (t.reporterUnitId) unitIds.add(t.reporterUnitId);
    if (t.locationNodeId) nodeIds.add(t.locationNodeId);
    if (t.affectedBuildingId) needBuildings = true;
  }
  const [showReporter, reopenWindowDays, maxReopens, csatOn, escalationOn] = await Promise.all([
    setting<boolean>(societyId, SETTING.showReporter),
    setting<number>(societyId, SETTING.reopenWindowDays),
    setting<number>(societyId, SETTING.maxReopens),
    isFeatureOn(societyId, ENT.csat),
    isFeatureOn(societyId, ENT.escalationMatrix),
  ]);
  const cats = catIds.size
    ? await TicketCategory.findAll({
        where: { societyId, id: { [Op.in]: [...catIds] } },
        attributes: ['id', 'name'],
      })
    : [];
  const us = unitIds.size ? await units.listActive(societyId, { unitIds: [...unitIds] }) : [];
  const nodeLabels = new Map<number, string>();
  for (const id of nodeIds) {
    const n = await locations.get(societyId, id);
    if (n) nodeLabels.set(id, n.pathLabel);
  }
  const bs = needBuildings ? await buildings.list(societyId, { includeArchived: true }) : [];
  const ups = tickets.length
    ? await TicketUpvote.findAll({ where: { userId, ticketId: { [Op.in]: tickets.map(t => t.id) } } })
    : [];
  const asgIds = tickets.map(t => t.currentAssignmentId).filter((x): x is number => Boolean(x));
  const asg = asgIds.length
    ? await TicketAssignment.findAll({
        where: { societyId, id: { [Op.in]: asgIds } },
        attributes: ['id', 'ticketId', 'assignedAt'],
      })
    : [];
  const links = userId ? await residents.getActiveUnitLinks(societyId, userId) : [];
  return {
    myRelations: new Map(links.map(l => [l.unitId, String(l.relation)])),
    showReporter,
    reopenWindowDays,
    maxReopens,
    csatOn,
    escalationOn,
    categories: new Map(cats.map(c => [c.id, c.name])),
    unitLabels: new Map(us.map(u => [u.id, u.label])),
    nodeLabels,
    buildingNames: new Map(bs.map(b => [b.id, b.name])),
    myUpvotes: new Map(ups.map(u => [u.ticketId, u])),
    assignedAt: new Map(asg.map(a => [a.ticketId, a.assignedAt])),
  };
}

const lateNow = (t: Ticket, at: Date): boolean =>
  t.responseBreached ||
  t.resolutionBreached ||
  at > t.resolutionDueAt ||
  (!t.firstResponseAt && at > t.responseDueAt);

/** True only when an estimate waits and the caller is an owner or tenant of the flat (what `ESTIMATE_APPROVER_NOT_ALLOWED` enforces). */
export function canDecideEstimate(t: Ticket, k: DtoLookups): boolean {
  if (t.kind !== 'PERSONAL' || t.status !== 'WAITING_ON_RESIDENT' || t.chargeStatus !== 'ESTIMATE_SENT')
    return false;
  const rel = t.unitId ? k.myRelations.get(t.unitId) : undefined;
  return rel === 'OWNER' || rel === 'TENANT';
}

/**
 * The actions a resident may take now (names: CONFIRM, REOPEN, CANCEL, RATE, ESCALATE, COMMENT). Combines the transition table (6.2) with the window,
 * limit and eligibility guards so the app shows only buttons that can work.
 */
export function residentActions(t: Ticket, types: CallerTypes, k: DtoLookups, at = now()): string[] {
  const out: string[] = [];
  const base = allowedActions(factsOf(t), types);
  if (base.includes('CLOSE')) out.push('CONFIRM');
  const inWindow =
    Boolean(t.resolvedAt) && at.getTime() <= t.resolvedAt!.getTime() + k.reopenWindowDays * DAY;
  if (base.includes('REOPEN') && inWindow && t.reopenCount < k.maxReopens) out.push('REOPEN');
  if (base.includes('CANCEL') && !(t.kind === 'BUILDING' && t.upvoteCount > 0)) out.push('CANCEL');
  const settled = t.status === 'RESOLVED' || t.status === 'CLOSED';
  const requester = types.has('REQUESTER');
  const rated = requester ? t.csatScore !== null : (k.myUpvotes.get(t.id)?.csatScore ?? null) !== null;
  if (
    k.csatOn &&
    settled &&
    inWindow &&
    !rated &&
    (requester || (t.kind === 'BUILDING' && types.has('UPVOTER')))
  )
    out.push('RATE');
  const eligible = types.has('REQUESTER') || types.has('UNIT_RESIDENT') || types.has('UPVOTER');
  if (
    k.escalationOn &&
    eligible &&
    (NON_TERMINAL as readonly string[]).includes(t.status) &&
    lateNow(t, at) &&
    !(
      t.lastResidentEscalationAt &&
      at.getTime() - t.lastResidentEscalationAt.getTime() < LIMITS.residentEscalationGapHours * 3_600_000
    )
  )
    out.push('ESCALATE');
  if (
    eligible &&
    t.status !== 'CLOSED' &&
    t.status !== 'CANCELLED' &&
    !(t.kind === 'PERSONAL' && !requester && !types.has('UNIT_RESIDENT'))
  )
    out.push('COMMENT');
  return out;
}

export function reporterLabelFor(ctx: Ctx, t: Ticket, k: DtoLookups): string {
  if (ctx.user && t.requesterUserId === ctx.user.id) return 'You';
  if (t.kind === 'PERSONAL') return t.requesterName;
  return reporterLabel(
    t.reporterRole,
    k.showReporter,
    t.reporterUnitId ? (k.unitLabels.get(t.reporterUnitId) ?? null) : null,
  );
}

export function myRelationOf(ctx: Ctx, t: Ticket, types: CallerTypes): string {
  if (types.has('REQUESTER')) return 'REQUESTER';
  if (types.has('UNIT_RESIDENT')) return 'UNIT_RESIDENT';
  if (types.has('UPVOTER')) return 'UPVOTER';
  return 'AFFECTED';
}

export function residentTicketDto(ctx: Ctx, t: Ticket, k: DtoLookups, at = now()): Record<string, unknown> {
  const up = k.myUpvotes.get(t.id);
  const types = residentTypes(ctx, t, Boolean(up));
  const own = types.has('REQUESTER');
  const myRating = own ? t.csatScore : (up?.csatScore ?? null);
  const charge =
    t.kind === 'PERSONAL' && t.chargeStatus !== 'NONE'
      ? {
          status: t.chargeStatus,
          estimatePaise: Number(t.chargeEstimatePaise),
          estimateNote: t.chargeEstimateNote,
          finalPaise: Number(t.chargeFinalPaise),
          decidedAt: iso(t.chargeDecidedAt),
        }
      : null;
  const state: SlaState = slaState(t, at);
  return {
    id: t.id,
    ticketNo: t.ticketNo,
    kind: t.kind,
    title: t.title,
    description: t.description,
    status: t.status,
    waitingReason: t.waitingReason,
    priority: t.priority,
    prioritySource: t.prioritySource,
    category: { id: t.categoryId, name: k.categories.get(t.categoryId) ?? '' },
    subCategory: t.subCategoryId
      ? { id: t.subCategoryId, name: k.categories.get(t.subCategoryId) ?? '' }
      : null,
    unit: t.unitId ? { id: t.unitId, label: k.unitLabels.get(t.unitId) ?? '' } : null,
    location: t.locationNodeId
      ? { id: t.locationNodeId, pathLabel: k.nodeLabels.get(t.locationNodeId) ?? '' }
      : null,
    affectedLevel: t.affectedLevel,
    affectedBuilding: t.affectedBuildingId
      ? { id: t.affectedBuildingId, name: k.buildingNames.get(t.affectedBuildingId) ?? '' }
      : null,
    affectedFloor: t.affectedFloor,
    affectedUnitCount: t.affectedUnitCount,
    channel: t.channel,
    reporterLabel: reporterLabelFor(ctx, t, k),
    assignment: t.assigneeLabel
      ? { assigneeLabel: t.assigneeLabel, assignedAt: iso(k.assignedAt.get(t.id) ?? null) }
      : null,
    sla: { resolutionDueAt: iso(t.resolutionDueAt), slaState: state, pausedMinutes: t.slaPausedMinutes },
    upvoteCount: t.upvoteCount,
    isRecurring: t.isRecurring,
    mergedIntoTicketId: t.mergedIntoTicketId,
    reopenCount: t.reopenCount,
    charge,
    preferredSlot: t.preferredSlotFrom
      ? { from: iso(t.preferredSlotFrom), to: iso(t.preferredSlotTo) }
      : null,
    csat: {
      score: myRating,
      avg: t.csatAvgTenths === null ? null : t.csatAvgTenths / 10,
      count: t.csatCount,
    },
    fileIds: helpdeskPorts().files.list('ticket', t.id),
    resolvedAt: iso(t.resolvedAt),
    closedAt: iso(t.closedAt),
    cancelledAt: iso(t.cancelledAt),
    lastActivityAt: iso(t.lastActivityAt),
    escalationRequestedAt: iso(t.lastResidentEscalationAt),
    allowedActions: residentActions(t, types, k, at),
    canDecideEstimate: canDecideEstimate(t, k),
    canRate: residentActions(t, types, k, at).includes('RATE'),
    version: t.version,
    createdAt: iso(t.createdAt),
    myRelation: myRelationOf(ctx, t, types),
    iUpvoted: Boolean(up),
    myRating,
  };
}

export async function residentTicketDtos(ctx: Ctx, tickets: Ticket[]): Promise<Record<string, unknown>[]> {
  const k = await loadLookups(ctx, tickets);
  return tickets.map(t => residentTicketDto(ctx, t, k));
}

// ------------------------------------------------------------------ comments (8.17)
const roleLabel: Record<string, string> = {
  ADMIN: 'Society office',
  STAFF: 'Maintenance staff',
  VENDOR: 'Vendor',
  GUARD: 'Security',
  SYSTEM: 'System',
};

export function residentCommentDto(
  ctx: Ctx,
  c: TicketComment,
  t: Ticket,
  k: DtoLookups,
  fileIds: number[],
): ResidentCommentDto {
  let authorLabel = roleLabel[c.authorRole] ?? 'System';
  if (c.authorRole === 'RESIDENT') {
    if (ctx.user && c.authorUserId === ctx.user.id) authorLabel = 'You';
    else if (t.kind === 'PERSONAL') authorLabel = c.authorName;
    else {
      const label = c.authorUnitId ? k.unitLabels.get(c.authorUnitId) : undefined;
      authorLabel = k.showReporter && label ? `Resident, ${label}` : 'Resident';
    }
  }
  return {
    id: c.id,
    kind: c.kind,
    visibility: 'PUBLIC',
    authorRole: c.authorRole,
    authorLabel,
    body: c.body,
    fromStatus: c.fromStatus,
    toStatus: c.toStatus,
    // only the estimate entry carries metadata residents may see (no priority or escalation figures)
    metadata: c.kind === 'ESTIMATE' ? c.metadata : null,
    fileIds,
    notifyAffected: c.notifyAffected,
    createdAt: c.createdAt.toISOString(),
    canDelete: false,
  };
}

/** Public timeline rows of a ticket, newest first (`visibility = 'PUBLIC'` is in the WHERE clause, BR-15-51). Removed comments are excluded. */
export async function publicTimeline(
  ctx: Ctx,
  t: Ticket,
  opts: { before?: number; limit: number },
): Promise<ResidentCommentDto[]> {
  const rows = await TicketComment.findAll({
    where: {
      ticketId: t.id,
      societyId: t.societyId,
      visibility: 'PUBLIC',
      kind: { [Op.in]: RESIDENT_KINDS },
      ...(opts.before ? { id: { [Op.lt]: opts.before } } : {}),
    },
    order: [['id', 'DESC']],
    limit: opts.limit,
  });
  const k = await loadLookups(ctx, [t]);
  const unitIds = [...new Set(rows.map(r => r.authorUnitId).filter((x): x is number => Boolean(x)))];
  if (unitIds.length) {
    for (const u of await units.listActive(t.societyId, { unitIds })) k.unitLabels.set(u.id, u.label);
  }
  return rows.map(r => residentCommentDto(ctx, r, t, k, helpdeskPorts().files.list('ticket_comment', r.id)));
}
