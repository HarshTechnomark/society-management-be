import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';

/**
 * Notification templates of module 10 (section 10) for the temporary `lib/notify.ts`; module 16 owns them later. Sub-module
 * 10.1 sends `committee.draft_from_election`; 10.2 and 10.3 add the others below it. Data never holds phone numbers.
 */
const t = (channels: NotifyChannel[], render: Template['render'], critical = false): Template => ({
  channels,
  critical,
  render,
});

registerTemplates({
  'committee.draft_from_election': t(['EMAIL'], d => ({
    link: String(d.link),
    email: {
      subject: `Election results are in for ${d.societyName}`,
      text: `A draft committee "${d.termName}" was created from the election results.\nSet the designations and review it: ${d.link}`,
    },
  })),

  'committee.term_activated': t(['EMAIL', 'PUSH'], d => ({
    link: String(d.link),
    email: {
      subject: `${d.termName} has taken charge at ${d.societyName}`,
      text: `The committee "${d.termName}" has taken charge. Its term ends on ${d.endDate}.\nSee the committee: ${d.link}`,
    },
  })),
  'committee.new_committee_announced': t(['PUSH'], d => ({
    link: String(d.link),
    sms: `${d.termName} is now the managing committee of ${d.societyName}.`,
  })),
  'committee.seat_assigned': t(['PUSH'], d => ({
    link: String(d.link),
    sms: `You are now ${d.designationLabel} of the committee at ${d.societyName}.`,
  })),
});
