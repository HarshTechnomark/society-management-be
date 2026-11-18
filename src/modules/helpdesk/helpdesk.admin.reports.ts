import { Op, type WhereOptions } from 'sequelize';
import { Ticket } from '../../models';
import { units } from '../society-setup/society-setup.public';
import { NON_TERMINAL, type TicketKind } from './helpdesk.constants';
import { loadLabels } from './helpdesk.admin.dto';
import { assigneeProductivity, monthly, recurring, summary } from './helpdesk.admin.stats';
import { slaState } from './helpdesk.sla';
import { now } from '../../lib/clock';

/** 8.31 readers for modules 24, 25 and 30. The open counts stay in `helpdesk.public.ts` (foundation). */

export interface ResidentTicketListItem {
  id: number;
  ticketNo: string;
  kind: TicketKind;
  title: string;
  status: string;
  priority: string;
  locationLabel: string | null;
  affectedUnitCount: number | null;
  upvoteCount: number;
  slaState: string;
  resolutionDueAt: string;
  createdAt: string;
  lastActivityAt: string;
}

/** Open building issues that affect any of the units (SOCIETY level; BUILDING level of the unit's building; FLOOR level of its floor). Module 25 home. */
async function openBuildingIssuesForUnits(
  societyId: number,
  unitIds: number[],
): Promise<ResidentTicketListItem[]> {
  if (!unitIds.length) return [];
  const mine = await units.listActive(societyId, { unitIds });
  const or: WhereOptions[] = [{ affectedLevel: 'SOCIETY' }];
  const buildings = [...new Set(mine.map(u => u.buildingId))];
  if (buildings.length) or.push({ affectedLevel: 'BUILDING', affectedBuildingId: { [Op.in]: buildings } });
  for (const u of mine)
    or.push({ affectedLevel: 'FLOOR', affectedBuildingId: u.buildingId, affectedFloor: u.floor });
  const rows = await Ticket.findAll({
    where: { societyId, kind: 'BUILDING', status: { [Op.in]: [...NON_TERMINAL] }, [Op.or]: or },
    order: [
      ['priority', 'ASC'],
      ['createdAt', 'DESC'],
    ],
    limit: 50,
  });
  const labels = await loadLabels(societyId, rows);
  return rows.map(r => ({
    id: r.id,
    ticketNo: r.ticketNo,
    kind: r.kind,
    title: r.title,
    status: r.status,
    priority: r.priority,
    locationLabel: labels.location(r.locationNodeId),
    affectedUnitCount: r.affectedUnitCount,
    upvoteCount: r.upvoteCount,
    slaState: slaState(r, now()),
    resolutionDueAt: r.resolutionDueAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    lastActivityAt: r.lastActivityAt.toISOString(),
  }));
}

export const reportFunctions = {
  summary,
  monthly,
  recurring,
  assigneeProductivity,
  openBuildingIssuesForUnits,
};
