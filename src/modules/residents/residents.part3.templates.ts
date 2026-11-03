import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';

/**
 * Notification templates of module 09 part 3 (section 10: renovation permits and ownership transfers), for the temporary
 * `lib/notify.ts`; module 16 owns them later. Data never holds phone numbers, document links or health data.
 */
const t = (channels: NotifyChannel[], render: Template['render'], critical = false): Template => ({
  channels,
  critical,
  render,
});
const mail = (subject: string, text: string) => ({ email: { subject, text } });
const sms = (text: string) => ({ sms: text });

registerTemplates({
  'residents.renovation_approved': t(['EMAIL', 'WHATSAPP'], d =>
    mail(
      `Renovation permit approved for ${d.unitLabel}`,
      `The renovation permit for ${d.unitLabel} in ${d.societyName} is approved. Work may start on ${d.startDate} between ${d.dailyStartTime} and ${d.dailyEndTime}.\nOpen: ${d.link}`,
    ),
  ),
  'residents.renovation_rejected': t(['EMAIL'], d =>
    mail(
      `Renovation permit not approved for ${d.unitLabel}`,
      `The renovation permit for ${d.unitLabel} in ${d.societyName} was not approved.${d.reason ? `\nReason: ${d.reason}` : ''}\nOpen: ${d.link}`,
    ),
  ),
  'residents.renovation_violation': t(['SMS', 'EMAIL'], d => ({
    ...sms(
      `${d.societyName}: a rule violation (${d.category}) was recorded for the renovation in ${d.unitLabel}.`,
    ),
    ...mail(
      `Renovation violation recorded for ${d.unitLabel}`,
      `A violation (${d.category}) was recorded for the renovation in ${d.unitLabel}: ${d.note}${d.stopWork ? '\nWork has been stopped until the society resumes it.' : ''}\nOpen: ${d.link}`,
    ),
  })),
  'residents.renovation_inspection_due': t(['EMAIL'], d =>
    mail(
      `Renovation inspection due for ${d.unitLabel}`,
      `The renovation in ${d.unitLabel} is ready for inspection in ${d.societyName}.\nOpen: ${d.link}`,
    ),
  ),
  'residents.renovation_completed': t(['EMAIL'], d =>
    mail(
      `Renovation completed for ${d.unitLabel}`,
      `The inspection of the renovation in ${d.unitLabel} passed.${d.deductionPaise > 0 ? ' A deduction was made from the deposit for damage.' : ''}\nOpen: ${d.link}`,
    ),
  ),
  'residents.transfer_submitted': t(['EMAIL'], d =>
    mail(
      `Ownership transfer submitted for ${d.unitLabel}`,
      `An ownership transfer (${d.transferType}) of ${d.unitLabel} in ${d.societyName} is waiting for approval.\nOpen: ${d.link}`,
    ),
  ),
  'residents.transfer_approved': t(['PUSH', 'EMAIL'], d =>
    mail(
      `Ownership transfer approved for ${d.unitLabel}`,
      `The ownership transfer of ${d.unitLabel} in ${d.societyName} is approved. The transfer fees are raised and must be paid before the society completes the transfer on or after ${d.effectiveDate}.\nOpen: ${d.link}`,
    ),
  ),
  'residents.transfer_completed': t(['EMAIL', 'PUSH'], d =>
    mail(
      `Ownership transfer completed for ${d.unitLabel}`,
      `The ownership transfer of ${d.unitLabel} in ${d.societyName} is completed with effect from ${d.effectiveDate}.\nOpen: ${d.link}`,
    ),
  ),
  'residents.request_changes_requested': t(['EMAIL'], d =>
    mail(
      `Changes requested on your request in ${d.societyName}`,
      `The approver asked for changes on your ${d.kind} request for ${d.unitLabel}.${d.reason ? `\nNote: ${d.reason}` : ''}\nEdit and resubmit: ${d.link}`,
    ),
  ),
});
