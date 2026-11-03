import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';

/**
 * Notification templates of module 08 (section 10) for the temporary `lib/notify.ts`; module 16 owns them later.
 * In-app delivery is not done by the stand-in, so only the e-mail text is rendered. Data never holds phone numbers or
 * file URLs; links point to the app screen.
 */
const t = (channels: NotifyChannel[], render: Template['render'], critical = false): Template => ({
  channels,
  critical,
  render,
});
const mail = (subject: string, text: string) => ({ email: { subject, text } });

registerTemplates({
  'setup.society.live': t(['EMAIL'], d =>
    mail(
      `${d.societyName} is live on SocietyApp`,
      `${d.societyName} finished setup and is now live.\nOpen the app: ${d.link}`,
    ),
  ),
  'setup.security_policy.changed': t(['EMAIL'], d =>
    mail(
      `Security settings changed for ${d.societyName}`,
      `${d.actorName} changed: ${(d.keys as string[]).join(', ')}.\nReason: ${d.reason ?? 'not given'}\nReview: ${d.link}`,
    ),
  ),
  'setup.profile.legal_changed': t(['EMAIL'], d =>
    mail(
      `Legal details of ${d.societyName} changed`,
      `${d.actorName} changed: ${(d.fields as string[]).join(', ')}.\nReason: ${d.reason ?? 'not given'}\nReview: ${d.link}`,
    ),
  ),
  // import and export results (section 10); the push and in-app channels belong to module 16
  'setup.import.validated': t(['PUSH'], d => ({
    link: String(d.link),
    ...mail(
      `Import checked for ${d.societyName}`,
      d.status === 'VALIDATED'
        ? `Your unit sheet was checked: ${d.counts.create} to add, ${d.counts.update} to update, ${d.counts.unchanged} unchanged, ${d.counts.error} with problems.\nReview: ${d.link}`
        : `Your unit sheet could not be checked (${d.failureCode}).\nReview: ${d.link}`,
    ),
  })),
  'setup.import.committed': t(['EMAIL'], d =>
    mail(
      `Import finished for ${d.societyName}`,
      `${d.written} flats were written and ${d.skipped} were skipped.\nOpen the units: ${d.link}`,
    ),
  ),
  'setup.import.failed': t(['EMAIL'], d =>
    mail(
      `Import failed for ${d.societyName}`,
      `The unit import did not finish (${d.failureCode}). Nothing was written.\nReview: ${d.link}`,
    ),
  ),
  'setup.export.ready': t([], d => ({
    link: String(d.link),
    ...mail('Units export ready', `Your units export is ready: ${d.link}`),
  })),
});
