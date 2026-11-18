import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';
import { NOTIFY } from './helpdesk.constants';

/**
 * Section 10 templates for the temporary `lib/notify.ts` (module 16 owns them later). The stand-in only delivers SMS and e-mail, so the text of the
 * in-app and push messages is rendered into `sms` (shown by the dev inbox only for templates that list the SMS channel). Data never holds the
 * description of a personal complaint, internal notes, mobiles or e-mail addresses: `helpdesk.notify.ts` whitelists what reaches a template.
 */
const t = (channels: NotifyChannel[], render: Template['render'], critical = false): Template => ({
  channels,
  critical,
  render,
});
const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
const where = (d: Record<string, unknown>): string => {
  const w = str(d.locationLabel) || str(d.unitLabel);
  return w ? ` (${w})` : '';
};
const PRIORITY_NAME: Record<string, string> = { P1: 'Emergency', P2: 'Urgent', P3: 'Normal', P4: 'Low' };
const prio = (v: unknown): string => PRIORITY_NAME[str(v)] ?? str(v);
const ref = (d: Record<string, unknown>): string => `${str(d.ticketNo)} ${str(d.title)}`.trim();
const msg = (d: Record<string, unknown>, text: string, subject?: string) => ({
  sms: text,
  link: str(d.link),
  ...(subject ? { email: { subject, text: `${text}\n${str(d.link)}`.trim() } } : {}),
});

registerTemplates({
  [NOTIFY.created]: t(['PUSH'], d =>
    msg(d, `New ${prio(d.priority)} request ${ref(d)}${where(d)} was raised.`),
  ),
  [NOTIFY.assigned]: t(['PUSH', 'WHATSAPP', 'SMS'], d =>
    msg(d, `You have been assigned ${ref(d)}${where(d)}. Priority: ${prio(d.priority)}.`),
  ),
  [NOTIFY.assignedResident]: t(['PUSH'], d =>
    msg(d, `${ref(d)} has been assigned to ${str(d.assigneeLabel) || 'a team member'}.`),
  ),
  [NOTIFY.statusChanged]: t(['PUSH'], d =>
    msg(d, `${ref(d)} is now ${str(d.statusLabel) || str(d.status)}.`),
  ),
  [NOTIFY.waiting]: t(['PUSH', 'WHATSAPP'], d =>
    msg(d, `${ref(d)} needs your reply${d.question ? `: ${str(d.question)}` : '.'}`),
  ),
  [NOTIFY.waitingReminder]: t(['PUSH'], d => msg(d, `Reminder: ${ref(d)} is still waiting for your reply.`)),
  [NOTIFY.resolved]: t(['PUSH', 'WHATSAPP'], d =>
    msg(d, `${ref(d)} was resolved. Please confirm and rate the work.`),
  ),
  [NOTIFY.closed]: t([], d => msg(d, `${ref(d)} was closed.`)),
  [NOTIFY.reopened]: t(['PUSH'], d => msg(d, `${ref(d)} was reopened.`)),
  [NOTIFY.cancelled]: t(['PUSH'], d => msg(d, `${ref(d)} was cancelled.`)),
  [NOTIFY.merged]: t(['PUSH'], d =>
    msg(d, `${ref(d)} was merged into ${str(d.mergedIntoTicketNo) || 'another request'}.`),
  ),
  [NOTIFY.comment]: t(['PUSH'], d =>
    msg(
      d,
      d.internal
        ? `New internal note on ${ref(d)}.`
        : `New update on ${ref(d)}${d.excerpt ? `: ${str(d.excerpt)}` : ''}`,
    ),
  ),
  [NOTIFY.estimateSent]: t(['PUSH', 'WHATSAPP'], d =>
    msg(d, `An estimate of Rs ${str(d.estimateRupees)} was sent for ${ref(d)}. Please approve or reject it.`),
  ),
  [NOTIFY.estimateDecided]: t(['PUSH'], d =>
    msg(d, `The estimate for ${ref(d)} was ${str(d.decision) || 'decided'}.`),
  ),
  // level 1: in-app and push; level 2 adds e-mail; level 3 adds e-mail and SMS (the stand-in sends what the rendered message carries)
  [NOTIFY.slaEscalated]: t(['PUSH', 'EMAIL', 'SMS'], d => {
    const level = Number(d.level) || 1;
    const text = `Level ${level} escalation: ${ref(d)}${where(d)} breached its service level (${str(d.ruleName)}).`;
    return {
      link: str(d.link),
      ...(level >= 3 ? { sms: text } : {}),
      ...(level >= 2
        ? {
            email: {
              subject: `Escalation level ${level}: ${str(d.ticketNo)}`,
              text: `${text}\n${str(d.link)}`,
            },
          }
        : {}),
    };
  }),
  [NOTIFY.escalationRequested]: t(['PUSH', 'EMAIL'], d =>
    msg(d, `A resident asked to escalate ${ref(d)}${where(d)}.`, `Escalation requested: ${str(d.ticketNo)}`),
  ),
  [NOTIFY.lowCsat]: t(['PUSH'], d => msg(d, `${ref(d)} received a low rating (${str(d.score)} of 5).`)),
  [NOTIFY.recurring]: t(['EMAIL'], d =>
    msg(d, `${ref(d)}${where(d)} looks like a recurring issue.`, `Recurring issue: ${str(d.ticketNo)}`),
  ),
  [NOTIFY.unassignedReminder]: t(['PUSH'], d =>
    msg(d, `${ref(d)}${where(d)} has had no assignee for ${str(d.minutes)} minutes.`),
  ),
  [NOTIFY.dailyDigest]: t(['EMAIL'], d =>
    msg(
      d,
      `Helpdesk digest for ${str(d.date)}: ${str(d.open)} open, ${str(d.breached)} breached, ${str(d.unassigned)} unassigned, ${str(d.p1)} urgent.${
        Array.isArray(d.p1List) && d.p1List.length ? `\nUrgent: ${(d.p1List as string[]).join('; ')}` : ''
      }`,
      `Helpdesk digest ${str(d.date)}`,
    ),
  ),
  [NOTIFY.buildingRaised]: t(['PUSH', 'WHATSAPP'], d =>
    msg(d, `Issue reported${where(d)}: ${str(d.title)}. We will keep you updated.`),
  ),
  [NOTIFY.buildingUpdate]: t(['PUSH'], d => msg(d, `Update on ${str(d.title)}${where(d)}: ${str(d.update)}`)),
  [NOTIFY.urgentGate]: t(['PUSH'], d => msg(d, `Urgent safety issue${where(d)}: ${str(d.title)}.`)),
});
