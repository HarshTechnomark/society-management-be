import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';

/**
 * Notification templates of module 09 part 2 (section 10): join requests, tenancies and moves, for the temporary
 * `lib/notify.ts`. In-app, push and WhatsApp delivery belong to module 16; the stand-in sends the SMS and e-mail text.
 * Data never holds phone numbers or document links.
 */
const t = (channels: NotifyChannel[], render: Template['render'], critical = false): Template => ({
  channels,
  critical,
  render,
});
const both = (subject: string, text: string) => ({ sms: text.split('\n')[0]!, email: { subject, text } });

registerTemplates({
  'residents.join_request_received': t(['PUSH'], d =>
    both(
      `Join request for ${d.unitLabel}`,
      `${d.name} asked to join ${d.societyName} as ${d.relation} of ${d.unitLabel}.\nReview: ${d.link}`,
    ),
  ),
  'residents.join_request_confirm': t(['PUSH', 'WHATSAPP'], d =>
    both(
      `Please confirm a join request for ${d.unitLabel}`,
      `${d.name} says they are your ${d.relationLabel} at ${d.unitLabel}. Please confirm or decline.\nOpen: ${d.link}`,
    ),
  ),
  'residents.join_request_approved': t(['SMS', 'PUSH'], d =>
    both(
      `Welcome to ${d.societyName}`,
      `Your request to join ${d.societyName} (${d.unitLabel}) was approved.\nOpen the app: ${d.link}`,
    ),
  ),
  'residents.join_request_rejected': t(['SMS', 'PUSH'], d =>
    both(
      `Your join request for ${d.societyName}`,
      `Your request to join ${d.societyName} (${d.unitLabel}) was not accepted.${d.reason ? `\nReason: ${d.reason}` : ''}`,
    ),
  ),
  'residents.tenancy_submitted': t(['PUSH'], d =>
    both(
      `Tenancy for ${d.unitLabel} needs approval`,
      `A tenancy for ${d.unitLabel} (${d.tenantName}, ${d.agreementStart} to ${d.agreementEnd}) was submitted.\nReview: ${d.link}`,
    ),
  ),
  'residents.tenancy_approved': t(['PUSH', 'WHATSAPP'], d =>
    both(
      `Tenancy approved for ${d.unitLabel}`,
      `The tenancy of ${d.tenantName} at ${d.unitLabel} was approved.\nOpen: ${d.link}`,
    ),
  ),
  'residents.tenancy_rejected': t(['PUSH'], d =>
    both(
      `Tenancy for ${d.unitLabel} was rejected`,
      `The tenancy of ${d.tenantName} at ${d.unitLabel} was rejected.\nReason: ${d.reason}`,
    ),
  ),
  'residents.tenancy_expiring': t(['PUSH', 'WHATSAPP', 'EMAIL'], d =>
    both(
      `Agreement for ${d.unitLabel} ends in ${d.days} days`,
      `The rent agreement of ${d.unitLabel} ends on ${d.agreementEnd}. Renew it in time.\nOpen: ${d.link}`,
    ),
  ),
  'residents.tenancy_overstay': t(['PUSH', 'EMAIL'], d =>
    both(
      `Agreement for ${d.unitLabel} has ended`,
      `The rent agreement of ${d.unitLabel} ended on ${d.agreementEnd} and the tenant is still recorded as living there.\nOpen: ${d.link}`,
    ),
  ),
  'residents.tenancy_ended': t(['PUSH'], d =>
    both(
      `Tenancy ended for ${d.unitLabel}`,
      `The tenancy of ${d.tenantName} at ${d.unitLabel} ended on ${d.endedOn}.`,
    ),
  ),
  'residents.police_verification_pending': t(['PUSH', 'WHATSAPP'], d =>
    both(
      `Police verification pending for ${d.unitLabel}`,
      `The police verification of the tenant at ${d.unitLabel} is still pending. Please submit it.\nOpen: ${d.link}`,
    ),
  ),
  'residents.move_owner_confirm': t(['PUSH', 'WHATSAPP'], d =>
    both(
      `Please confirm a move at ${d.unitLabel}`,
      `${d.requesterName} asked for a ${d.typeLabel} on ${d.moveDate} at ${d.unitLabel}. Please confirm or decline.\nOpen: ${d.link}`,
    ),
  ),
  'residents.move_blocked_dues': t(['PUSH', 'WHATSAPP'], d =>
    both(
      `Dues block the move at ${d.unitLabel}`,
      `The ${d.typeLabel} at ${d.unitLabel} waits for dues of Rs ${d.duesRupees}. Pay them and check again.\nOpen: ${d.link}`,
    ),
  ),
  'residents.move_deposit_due': t(['PUSH'], d =>
    both(
      `Moving deposit due for ${d.unitLabel}`,
      `Pay the moving deposit of Rs ${d.depositRupees} to continue your ${d.typeLabel} at ${d.unitLabel}.\nOpen: ${d.link}`,
    ),
  ),
  'residents.move_approved': t(['PUSH', 'SMS'], d =>
    both(
      `${d.typeLabel} approved for ${d.unitLabel}`,
      `Your ${d.typeLabel} at ${d.unitLabel} on ${d.moveDate} (${d.slotStart} to ${d.slotEnd}) is approved. Gate pass: ${d.gatePass}`,
    ),
  ),
  'residents.move_rejected': t(['PUSH'], d =>
    both(
      `${d.typeLabel} not approved for ${d.unitLabel}`,
      `Your ${d.typeLabel} at ${d.unitLabel} was not approved.${d.reason ? `\nReason: ${d.reason}` : ''}`,
    ),
  ),
  'residents.move_completed': t(['PUSH'], d =>
    both(
      `${d.typeLabel} completed at ${d.unitLabel}`,
      `The ${d.typeLabel} at ${d.unitLabel} was completed on ${d.completedOn}.`,
    ),
  ),
  'residents.request_changes_requested': t(['PUSH'], d =>
    both(
      `Changes requested for your request`,
      `The committee asked for changes to your request for ${d.unitLabel}.\nOpen: ${d.link}`,
    ),
  ),
});
