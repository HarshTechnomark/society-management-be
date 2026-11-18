import { HELPDESK_QUEUE } from './helpdesk.constants';
import { registerHelpdeskJobsPart4 } from './helpdesk.jobs.part4';

export { HELPDESK_QUEUE };

/**
 * Registry of the jobs of queue `helpdesk` (section 9.1). The foundation registers none: part 15.4 adds `sla-sweep`, `auto-close`, `waiting-followup`,
 * `unassigned-reminder`, `fanout`, `escalation-notify`, `daily-digest` and `seed` with ONE line each below (a `register...Jobs()` call from its own file).
 * The processors call `evaluateTicketSla` and `transitionTicket` (system actor); they never write ticket columns directly.
 */
export function registerHelpdeskJobs(): void {
  // parts add their registration here, one line each:
  registerHelpdeskJobsPart4(); // 15.4: all jobs of 9.1 and the notification templates of section 10
}
