import './helpdesk.notify.templates';
import type { Ticket } from '../../models';
import { notify } from '../../lib/notify';
import { logger } from '../../lib/logger';
import { usersWithPermission } from '../access-control/access-control.public';
import { locations, units } from '../society-setup/society-setup.public';
import { PERM, type Priority } from './helpdesk.constants';
import { helpdeskPortCalls, helpdeskPorts } from './helpdesk.ports';

/** Section 10: what may reach a notification, who is reached and how (module 16 `notify` through the `notifications` port). */

/** Keys that never go to a template: personal text, internal notes, contact details. */
export const FORBIDDEN_KEYS = [
  'description',
  'body',
  'note',
  'internalNote',
  'mobile',
  'phone',
  'email',
  'externalMobile',
  'duplicateReason',
  'csatComment',
  'resolutionNote',
  'cancelReason',
] as const;

export function cleanData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data))
    if (!(FORBIDDEN_KEYS as readonly string[]).includes(k)) out[k] = v;
  return out;
}

export const adminLink = (ticketId: number): string => `/admin/issues/${ticketId}`;
export const residentLink = (ticketId: number): string => `/resident/help/${ticketId}`;
export const staffLink = (_ticketId?: number): string => '/work/issues';

/** Short text for a comment excerpt; never longer than 140 characters. */
export const excerptOf = (s: string | null | undefined, max = 140): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export interface TicketNotifyData extends Record<string, unknown> {
  ticketId: number;
  ticketNo: string;
  title: string;
  status: string;
  priority: Priority;
  kind: string;
  locationLabel?: string;
  unitLabel?: string;
}

/** The whitelist of ticket facts a message carries (no description, no requester contact, no internal fields). */
export async function ticketData(ticket: Ticket): Promise<TicketNotifyData> {
  const out: TicketNotifyData = {
    ticketId: ticket.id,
    ticketNo: ticket.ticketNo,
    title: ticket.title,
    status: ticket.status,
    priority: ticket.priority,
    kind: ticket.kind,
  };
  if (ticket.locationNodeId) {
    const node = await locations.get(ticket.societyId, ticket.locationNodeId).catch(() => null);
    if (node) out.locationLabel = node.pathLabel;
  }
  if (ticket.unitId) {
    const u = await units.get(ticket.societyId, ticket.unitId).catch(() => null);
    if (u) out.unitLabel = u.label;
  }
  return out;
}

/** Sends one template to user ids in pages of 500; duplicates and `exclude` (the actor) are removed. Never throws. */
export async function sendTo(
  template: string,
  userIds: Iterable<number>,
  data: Record<string, unknown>,
  opts: { exclude?: Array<number | null | undefined> } = {},
): Promise<number> {
  const skip = new Set((opts.exclude ?? []).filter((x): x is number => typeof x === 'number'));
  const ids = [...new Set(userIds)].filter(id => !skip.has(id));
  if (!ids.length) return 0;
  const payload = cleanData(data);
  try {
    for (let i = 0; i < ids.length; i += 500)
      await helpdeskPorts().notifications.send(template, ids.slice(i, i + 500), payload);
  } catch (err) {
    logger.error({ err, template }, 'helpdesk notification failed');
  }
  return ids.length;
}

/** SMS to an EXTERNAL assignee (a mobile, no user): the number is not recorded in the port call log. */
export async function sendToMobile(
  template: string,
  mobile: string,
  data: Record<string, unknown>,
): Promise<void> {
  helpdeskPortCalls.push({ fn: 'notifications.sendMobile', input: { template, data: cleanData(data) } });
  await notify(template, [{ mobile }], cleanData(data), { channels: ['SMS'] });
}

/** Members holding `helpdesk.tickets.edit` (the desk). */
export const editorIds = (societyId: number): Promise<number[]> =>
  usersWithPermission(societyId, PERM.ticketsEdit);
