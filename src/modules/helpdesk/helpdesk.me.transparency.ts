import { Op } from 'sequelize';
import { Ticket } from '../../models';
import { now } from '../../lib/clock';
import type { Ctx } from '../../types/context';
import { societyIdOf } from './helpdesk.shared';

/** 8.28: monthly building-issue figures for residents (building issues only, no names, no personal complaints). Months are society local (Asia/Kolkata). */

const IST_MS = 330 * 60_000;
const monthKey = (d: Date): string => new Date(d.getTime() + IST_MS).toISOString().slice(0, 7);

/** Start (UTC instant) of the society-local month that is `back` months before the month of `at`. */
function monthStart(at: Date, back: number): Date {
  const local = new Date(at.getTime() + IST_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - back, 1) - IST_MS);
}

export async function transparency(ctx: Ctx, months: number) {
  const societyId = societyIdOf(ctx);
  const at = now();
  const from = monthStart(at, months - 1);
  const rows = await Ticket.findAll({
    where: {
      societyId,
      kind: 'BUILDING',
      [Op.or]: [{ createdAt: { [Op.gte]: from } }, { resolvedAt: { [Op.gte]: from } }],
    },
    attributes: ['createdAt', 'resolvedAt', 'resolutionBreached', 'status'],
  });
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const key = monthKey(monthStart(at, i));
    const raised = rows.filter(r => monthKey(r.createdAt) === key).length;
    const done = rows.filter(r => r.resolvedAt && monthKey(r.resolvedAt) === key && r.status !== 'CANCELLED');
    const hours = done
      .map(r => (r.resolvedAt!.getTime() - r.createdAt.getTime()) / 3_600_000)
      .sort((a, b) => a - b);
    const mid = Math.floor(hours.length / 2);
    const median = hours.length
      ? Math.round((hours.length % 2 ? hours[mid]! : (hours[mid - 1]! + hours[mid]!) / 2) * 10) / 10
      : null;
    const met = done.filter(r => !r.resolutionBreached).length;
    out.push({
      month: key,
      buildingIssuesRaised: raised,
      resolved: done.length,
      medianResolutionHours: median,
      resolutionMetPct: done.length ? Math.round((met / done.length) * 100) : null,
    });
  }
  return { months: out };
}
