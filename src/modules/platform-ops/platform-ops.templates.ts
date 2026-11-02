import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';

/**
 * Notification templates of module 07 section 10 (tickets) for the temporary `lib/notify.ts`; module 16 owns them later.
 * In-app and push are not delivered by the stand-in, so only the email part renders. No message body of a ticket is ever
 * put in a notification (only the subject and number).
 */
const t = (channels: NotifyChannel[], render: Template['render'], critical = false): Template => ({
  channels,
  critical,
  render,
});
const mail = (subject: string, text: string) => ({ email: { subject, text } });
const link = (d: Record<string, any>) => String(d.link ?? '');

registerTemplates({
  'platform.ticket.created_alert': t(['EMAIL'], d =>
    mail(
      `New ${d.priority} ticket ${d.ticketNo} from ${d.societyName}`,
      `${d.societyName} raised ${d.ticketNo}: ${d.subject}\nCategory ${d.category}, priority ${d.priority}.\nOpen it: ${link(d)}`,
    ),
  ),
  'platform.ticket.created_confirmation': t(['EMAIL'], d =>
    mail(
      `We received your request ${d.ticketNo}`,
      `Thank you. Your request "${d.subject}" is ${d.ticketNo}. We will reply by ${d.expectedBy}.\nFollow it here: ${link(d)}`,
    ),
  ),
  'platform.ticket.created_for_society': t(['EMAIL', 'PUSH'], d =>
    mail(
      `SocietyApp support opened ${d.ticketNo} for you`,
      `Our team opened "${d.subject}" (${d.ticketNo}) on behalf of ${d.societyName}.\nRead it here: ${link(d)}`,
    ),
  ),
  'platform.ticket.replied': t(['EMAIL', 'PUSH'], d =>
    mail(
      `New reply on ${d.ticketNo}`,
      `SocietyApp support replied to "${d.subject}" (${d.ticketNo}).\nRead it here: ${link(d)}`,
    ),
  ),
  'platform.ticket.status_changed': t(['EMAIL', 'PUSH'], d =>
    mail(
      `${d.ticketNo} is now ${String(d.status).toLowerCase().replace('_', ' ')}`,
      `"${d.subject}" (${d.ticketNo}) changed to ${d.status}.\nOpen it: ${link(d)}`,
    ),
  ),
  'platform.ticket.society_replied': t(['EMAIL'], d =>
    mail(
      `${d.societyName} replied on ${d.ticketNo}`,
      `${d.societyName} replied on "${d.subject}" (${d.ticketNo}).\nOpen it: ${link(d)}`,
    ),
  ),
  'platform.ticket.assigned': t(['EMAIL'], d =>
    mail(
      `${d.ticketNo} is assigned to you`,
      `"${d.subject}" (${d.ticketNo}) from ${d.societyName} is now yours.\nOpen it: ${link(d)}`,
    ),
  ),
  'platform.ticket.sla_warning': t(['EMAIL'], d =>
    mail(
      `SLA warning on ${d.ticketNo}`,
      `${d.ticketNo} (${d.societyName}) has used 80% of its resolution time.\nOpen it: ${link(d)}`,
    ),
  ),
  'platform.ticket.sla_breached': t(['EMAIL'], d =>
    mail(
      `SLA breached on ${d.ticketNo}`,
      `${d.ticketNo} (${d.societyName}) missed its ${d.which === 'FIRST_RESPONSE' ? 'first response' : 'resolution'} time.\nOpen it: ${link(d)}`,
    ),
  ),
});
