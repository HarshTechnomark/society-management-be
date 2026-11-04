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

  'committee.term_expiring': t(['EMAIL', 'PUSH'], d => ({
    link: String(d.link),
    email: {
      subject: `The committee term of ${d.societyName} ends in ${d.daysLeft} days`,
      text: `"${d.termName}" ends on ${d.endDate} (${d.daysLeft} days left).\nPlan the election in time: ${d.link}`,
    },
    sms: `The committee term of ${d.societyName} ends on ${d.endDate}.`,
  })),
  'committee.term_expired': t(['EMAIL'], d => ({
    link: String(d.link),
    email: {
      subject: `The committee term of ${d.societyName} has ended`,
      text: `"${d.termName}" ended on ${d.endDate}. The committee continues as caretaker until the new committee takes charge.\nSee the committee: ${d.link}`,
    },
  })),
  'committee.handover_pending': t(['PUSH'], d => ({
    link: String(d.link),
    sms: `The hand-over checklist of ${d.termName} at ${d.societyName} still has pending items.`,
  })),
  // in-app only (module 16); the stand-in renders the link and sends nothing
  'committee.seat_needs_attention': t(['PUSH'], d => ({
    link: String(d.link),
    sms: `A committee seat at ${d.societyName} needs attention: ${d.detail}`,
  })),
});
