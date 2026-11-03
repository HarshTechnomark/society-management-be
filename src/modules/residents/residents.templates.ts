import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';

/**
 * Notification templates of module 09 (section 10) for the temporary `lib/notify.ts`; module 16 owns them later. In-app
 * and push delivery is not done by the stand-in, so only the text that SMS or e-mail would carry is rendered. Data never
 * holds phone numbers, document links or health data. Parts 2 and 3 add their templates below the part 1 ones.
 */
const t = (channels: NotifyChannel[], render: Template['render'], critical = false): Template => ({
  channels,
  critical,
  render,
});
const mail = (subject: string, text: string) => ({ email: { subject, text } });

registerTemplates({
  'residents.welcome_kit': t(['EMAIL'], d =>
    mail(
      `Welcome to ${d.societyName}`,
      `Hello ${d.name}, you are now linked to ${d.unitLabel} in ${d.societyName}.\nOpen the app: ${d.link}`,
    ),
  ),
  'residents.document_rejected': t(['EMAIL'], d => ({
    link: String(d.link),
    ...mail(
      `A document was not accepted by ${d.societyName}`,
      `Your ${d.docType} document was not accepted.\nReason: ${d.reason}\nUpload it again: ${d.link}`,
    ),
  })),
  'residents.pet_vaccination_due': t(['EMAIL'], d =>
    mail(
      `${d.petName}'s vaccination is due`,
      `The vaccination of ${d.petName} is valid until ${d.validUntil}. Please renew it and update the pet record: ${d.link}`,
    ),
  ),
  'residents.mobile_conflict': t(['EMAIL'], d =>
    mail(
      `A resident's mobile number could not be updated in ${d.societyName}`,
      `${d.name} changed the mobile number on their login, but another resident of ${d.societyName} already uses it, so the old number was kept.\nReview: ${d.link}`,
    ),
  ),
});
