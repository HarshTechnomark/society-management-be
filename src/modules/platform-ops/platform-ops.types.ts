/** Shared constants of module 07 (Platform Operations). Audit actions follow section 9.2, error codes section 12. */
export const PLATFORM_OPS_QUEUE = 'platform-ops';

export const JOBS = {
  ticketSlaScan: 'platform-ops:ticket-sla-scan',
  ticketHousekeeping: 'platform-ops:ticket-housekeeping',
} as const;

export const AUDIT = {
  ticketCreated: 'platform.ticket.created',
  ticketUpdated: 'platform.ticket.updated',
  ticketClosed: 'platform.ticket.closed',
  ticketReopened: 'platform.ticket.reopened',
  ticketRated: 'platform.ticket.rated',
  ticketAutoResolved: 'platform.ticket.auto_resolved',
  ticketAutoClosed: 'platform.ticket.auto_closed',
  ticketMessageAdded: 'platform.ticket.message_added',
  settingUpdated: 'platform.setting.updated',
  organizationCreated: 'platform.organization.created',
  organizationUpdated: 'platform.organization.updated',
  organizationStatusChanged: 'platform.organization.status_changed',
} as const;

export const ENTITY = {
  ticket: 'platform_ticket',
  setting: 'platform_setting',
  organization: 'organization',
} as const;

/** `TKT-` + id zero-padded to 6 digits (BR-07-2). */
export const ticketNo = (id: number): string => `TKT-${String(id).padStart(6, '0')}`;
export const parseTicketNo = (q: string): number | null => {
  const m = /^TKT-(\d{1,6})$/i.exec(q.trim());
  return m ? Number(m[1]) : null;
};
