import { Building, Ticket, TicketAssignment, TicketCategory, User } from '../../models';
import { now } from '../../lib/clock';
import type { Ctx } from '../../types/context';
import { units, locations } from '../society-setup/society-setup.public';
import { hasPermission, members } from '../access-control/access-control.public';
import { PERM, type TicketStatus } from './helpdesk.constants';
import { helpdeskPorts } from './helpdesk.ports';
import { allowedActions } from './helpdesk.state';
import { factsOf, societyIdOf } from './helpdesk.shared';
import { slaState } from './helpdesk.sla';
import { loadEffectiveCategory } from './helpdesk.tickets.core';

/** The admin `TicketDto` (8.0) and the `TicketListItem` (8.7), with batch label lookups. */

/** `98XXXXX111`: first two and last three digits stay. */
export const maskExternalMobile = (m: string | null): string | null =>
  m ? `${m.slice(0, 2)}${'X'.repeat(Math.max(0, m.length - 5))}${m.slice(-3)}` : null;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Label lookups for a page of tickets: unit labels, location path labels, building names, names of users. */
export interface Labels {
  unit(id: number | null): string | null;
  location(id: number | null): string | null;
}

export async function loadLabels(societyId: number, rows: Ticket[]): Promise<Labels> {
  const unitIds = [...new Set(rows.map(r => r.unitId).filter((x): x is number => Boolean(x)))];
  const nodeIds = [...new Set(rows.map(r => r.locationNodeId).filter((x): x is number => Boolean(x)))];
  const unitMap = new Map<number, string>();
  if (unitIds.length) {
    for (const u of await units.listActive(societyId, { unitIds })) unitMap.set(u.id, u.label);
    for (const id of unitIds.filter(i => !unitMap.has(i))) {
      const u = await units.get(societyId, id);
      if (u) unitMap.set(id, u.label);
    }
  }
  const nodeMap = new Map<number, string>();
  await Promise.all(
    nodeIds.map(async id => {
      const n = await locations.get(societyId, id);
      if (n) nodeMap.set(id, n.pathLabel);
    }),
  );
  return {
    unit: id => (id ? (unitMap.get(id) ?? null) : null),
    location: id => (id ? (nodeMap.get(id) ?? null) : null),
  };
}

export interface TicketListItem {
  id: number;
  ticketNo: string;
  kind: string;
  title: string;
  status: TicketStatus;
  priority: string;
  categoryName: string;
  locationLabel: string | null;
  affectedUnitCount: number | null;
  upvoteCount: number;
  assigneeLabel: string | null;
  assigneeInactive: boolean;
  slaState: string;
  resolutionDueAt: string;
  createdAt: string;
  lastActivityAt: string;
}

export async function toListItems(ctx: Ctx, rows: Ticket[]): Promise<TicketListItem[]> {
  const societyId = societyIdOf(ctx);
  if (!rows.length) return [];
  const labels = await loadLabels(societyId, rows);
  const cats = new Map(
    (
      await TicketCategory.findAll({
        where: { societyId, id: [...new Set(rows.map(r => r.categoryId))] },
        attributes: ['id', 'name'],
      })
    ).map(c => [c.id, c.name]),
  );
  const asgIds = rows.map(r => r.currentAssignmentId).filter((x): x is number => Boolean(x));
  const asg = new Map(
    (asgIds.length
      ? await TicketAssignment.findAll({
          where: { id: asgIds },
          attributes: ['id', 'assigneeType', 'assigneeUserId'],
        })
      : []
    ).map(a => [a.id, a]),
  );
  const memberIds = [...asg.values()]
    .filter(a => a.assigneeType === 'MEMBER' && a.assigneeUserId)
    .map(a => a.assigneeUserId!);
  const active = new Set(
    memberIds.length
      ? (await members.listForSociety(societyId, { userIds: memberIds, statuses: ['ACTIVE'] })).map(
          m => m.userId,
        )
      : [],
  );
  const at = now();
  return rows.map(r => {
    const a = r.currentAssignmentId ? asg.get(r.currentAssignmentId) : undefined;
    return {
      id: r.id,
      ticketNo: r.ticketNo,
      kind: r.kind,
      title: r.title,
      status: r.status,
      priority: r.priority,
      categoryName: cats.get(r.categoryId) ?? '',
      locationLabel: r.kind === 'PERSONAL' ? labels.unit(r.unitId) : labels.location(r.locationNodeId),
      affectedUnitCount: r.affectedUnitCount,
      upvoteCount: r.upvoteCount,
      assigneeLabel: r.assigneeLabel,
      assigneeInactive: Boolean(
        a && a.assigneeType === 'MEMBER' && a.assigneeUserId && !active.has(a.assigneeUserId),
      ),
      slaState: slaState(r, at),
      resolutionDueAt: r.resolutionDueAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
      lastActivityAt: r.lastActivityAt.toISOString(),
    };
  });
}

/** The full admin `TicketDto`. Mobiles are masked unless the caller holds `residents.contacts.view`; actions are empty without `helpdesk.tickets.edit`. */
export async function toTicketDto(ctx: Ctx, t: Ticket): Promise<Record<string, unknown>> {
  const societyId = societyIdOf(ctx);
  const labels = await loadLabels(societyId, [t]);
  const [cat, sub, asg, building, requesterOk] = await Promise.all([
    TicketCategory.findByPk(t.categoryId, { attributes: ['id', 'name'] }),
    t.subCategoryId ? TicketCategory.findByPk(t.subCategoryId, { attributes: ['id', 'name'] }) : null,
    t.currentAssignmentId ? TicketAssignment.findByPk(t.currentAssignmentId) : null,
    t.affectedBuildingId ? Building.findByPk(t.affectedBuildingId, { attributes: ['id', 'name'] }) : null,
    t.requesterUserId ? User.findByPk(t.requesterUserId, { attributes: ['id', 'name'] }) : null,
  ]);
  const reveal = hasPermission(ctx, PERM.contactsView);
  const effective = await loadEffectiveCategory(societyId, t.categoryId, t.subCategoryId, undefined, {
    allowArchived: true,
  }).catch(() => null);
  const at = now();
  const charged = t.isChargeable || t.chargeStatus !== 'NONE';
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
    category: cat ? { id: cat.id, name: cat.name } : null,
    subCategory: sub ? { id: sub.id, name: sub.name } : null,
    unit: t.unitId ? { id: t.unitId, label: labels.unit(t.unitId) } : null,
    location: t.locationNodeId
      ? { id: t.locationNodeId, pathLabel: labels.location(t.locationNodeId) }
      : null,
    affectedLevel: t.affectedLevel,
    affectedBuilding: building ? { id: building.id, name: building.name } : null,
    affectedFloor: t.affectedFloor,
    affectedUnitCount: t.affectedUnitCount,
    channel: t.channel,
    reporterRole: t.reporterRole,
    requester: { userId: t.requesterUserId, name: requesterOk?.name ?? t.requesterName },
    assignment: asg
      ? {
          id: asg.id,
          assigneeType: asg.assigneeType,
          assigneeLabel: asg.assigneeLabel,
          externalMobile: reveal ? asg.externalMobile : maskExternalMobile(asg.externalMobile),
          workOrderId: asg.workOrderId,
          assignedAt: asg.assignedAt.toISOString(),
        }
      : null,
    sla: {
      policyId: t.slaPolicyId,
      calendar: t.slaCalendar,
      cycle: t.slaCycle,
      responseDueAt: iso(t.responseDueAt),
      resolutionDueAt: iso(t.resolutionDueAt),
      firstResponseAt: iso(t.firstResponseAt),
      pausedMinutes: t.slaPausedMinutes,
      responseBreached: t.responseBreached,
      resolutionBreached: t.resolutionBreached,
      escalationLevel: t.escalationLevel,
      slaState: slaState(t, at),
    },
    upvoteCount: t.upvoteCount,
    isRecurring: t.isRecurring,
    mergedIntoTicketId: t.mergedIntoTicketId,
    reopenCount: t.reopenCount,
    isChargeable: t.isChargeable,
    requiresAfterPhoto: Boolean(effective?.requiresAfterPhoto),
    charge: charged
      ? {
          status: t.chargeStatus,
          estimatePaise: Number(t.chargeEstimatePaise),
          estimateNote: t.chargeEstimateNote,
          finalPaise: Number(t.chargeFinalPaise),
          invoiceId: t.chargeInvoiceId,
          decidedAt: iso(t.chargeDecidedAt),
        }
      : null,
    invoiceId: t.invoiceId,
    preferredSlot:
      t.preferredSlotFrom && t.preferredSlotTo
        ? { from: t.preferredSlotFrom.toISOString(), to: t.preferredSlotTo.toISOString() }
        : null,
    csat: {
      score: t.csatScore,
      avg: t.csatAvgTenths === null ? null : t.csatAvgTenths / 10,
      count: t.csatCount,
    },
    resolutionNote: t.resolutionNote,
    cancelReason: t.cancelReason,
    fileIds: helpdeskPorts().files.list('ticket', t.id),
    resolvedAt: iso(t.resolvedAt),
    closedAt: iso(t.closedAt),
    cancelledAt: iso(t.cancelledAt),
    lastActivityAt: t.lastActivityAt.toISOString(),
    allowedActions: hasPermission(ctx, PERM.ticketsEdit)
      ? allowedActions(factsOf(t), new Set(['ADMIN']))
      : [],
    version: t.version,
    createdAt: t.createdAt.toISOString(),
  };
}
