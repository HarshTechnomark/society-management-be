import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';

/**
 * Notification templates of module 05 (section 10) for the temporary `lib/notify.ts`; module 16 owns them later.
 * In-app and push are not delivered by the stand-in, so templates whose only channels are in-app or push render nothing.
 */
const t = (channels: NotifyChannel[], render: Template['render'], critical = false): Template => ({
  channels,
  critical,
  render,
});
const mail = (subject: string, text: string) => ({ email: { subject, text } });
const day = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Kolkata',
      })
    : '';

registerTemplates({
  'societies.welcome': t(['SMS', 'EMAIL', 'WHATSAPP'], d => ({
    sms: `Welcome to SocietyApp! ${d.societyName} is on a free trial until ${day(d.trialEndsAt)}. Continue setup: ${d.link}`,
    ...mail(
      `Welcome to SocietyApp, ${d.societyName}`,
      `Your society is on a free trial until ${day(d.trialEndsAt)}.\nContinue the setup: ${d.link}`,
    ),
  })),
  'societies.new_signup': t(['PUSH'], () => ({})),
  'societies.trial_ending': t(['EMAIL', 'WHATSAPP'], d => ({
    ...mail(
      `Your SocietyApp trial ends in ${d.daysLeft} day(s)`,
      `The free trial of ${d.societyName} ends on ${day(d.trialEndsAt)}. Choose a plan in Settings, Subscription to keep going.`,
    ),
  })),
  'societies.trial_expired': t(['SMS', 'EMAIL'], d => ({
    sms: `The SocietyApp trial of ${d.societyName} has ended. You can still view and export data. Choose a plan to continue.`,
    ...mail(
      'Your SocietyApp trial has ended',
      `The free trial of ${d.societyName} has ended. You can view and export your data. Choose a plan to continue.`,
    ),
  })),
  'societies.trial_extended': t(['EMAIL'], d => ({
    ...mail(
      'Your SocietyApp trial was extended',
      `The trial of ${d.societyName} now ends on ${day(d.trialEndsAt)}.`,
    ),
  })),
  'societies.converted': t(['EMAIL'], d => ({
    ...mail(
      'Welcome to your SocietyApp plan',
      `${d.societyName} is now on a paid SocietyApp plan. Thank you.`,
    ),
  })),
  'societies.past_due': t(['PUSH'], () => ({})),
  'societies.suspended': t(
    ['SMS', 'EMAIL'],
    d => ({
      sms: `The SocietyApp account of ${d.societyName} is suspended. You can view and export data. Contact SocietyApp support.`,
      ...mail(
        'Your SocietyApp account is suspended',
        `The SocietyApp account of ${d.societyName} is suspended. You can view and export data. Pay the platform invoice or contact support to restore access.`,
      ),
    }),
    true,
  ),
  'societies.reactivated': t(['EMAIL'], d => ({
    ...mail('Your SocietyApp account is active again', `${d.societyName} can use SocietyApp normally again.`),
  })),
  'societies.auto_close_warning': t(['SMS', 'EMAIL', 'WHATSAPP'], d => ({
    sms: `The SocietyApp account of ${d.societyName} will be closed in ${d.daysLeft} day(s). Pay or contact support to keep it.`,
    ...mail(
      `Your SocietyApp account closes in ${d.daysLeft} day(s)`,
      `The suspended account of ${d.societyName} will be closed in ${d.daysLeft} day(s). Download your data or contact support.`,
    ),
  })),
  'societies.closed': t(['SMS', 'EMAIL'], d => ({
    sms: `The SocietyApp account of ${d.societyName} is closed. A full data export is being prepared for you.`,
    ...mail(
      'Your SocietyApp account is closed',
      `The SocietyApp account of ${d.societyName} is closed. A full data export is being prepared; you can download it for 30 days from Settings, Data export.`,
    ),
  })),
  'societies.closed_resident': t(['EMAIL'], d => ({
    ...mail(
      `${d.societyName} has left SocietyApp`,
      `${d.societyName} no longer uses SocietyApp. In an emergency call 112. Contact your committee for society matters.`,
    ),
  })),
  'societies.purge_warning': t(['SMS', 'EMAIL'], d => ({
    sms: `SocietyApp will delete the personal data of ${d.societyName} on ${day(d.purgeAfter)}. Download your export before then.`,
    ...mail(
      'Your society data will be deleted in 7 days',
      `The personal data of ${d.societyName} will be deleted on ${day(d.purgeAfter)}. Financial records are kept as the law requires. Download the closure export before then.`,
    ),
  })),
  'societies.reopened': t(['EMAIL'], d => ({
    ...mail('Your SocietyApp account is open again', `${d.societyName} is active on SocietyApp again.`),
  })),
  'societies.success_nudge': t(['EMAIL', 'WHATSAPP'], d => ({
    ...mail(
      'Need help with SocietyApp?',
      `Hello from the SocietyApp team. We would like to help ${d.societyName} get the most out of SocietyApp.${
        d.note ? `\n${d.note}` : ''
      }\nReply to this email or call us any time.`,
    ),
  })),
  'support_access.consent_requested': t(['SMS', 'EMAIL', 'WHATSAPP'], d => ({
    sms: `SocietyApp support (${d.staffName}) asks for ${d.scope === 'READ_ONLY' ? 'read-only' : 'read and write'} access to ${d.societyName} for ${d.durationMinutes} minutes. Review: ${d.link}`,
    ...mail(
      'SocietyApp support asks for access to your society',
      `${d.staffName} from SocietyApp support asks for ${d.scope === 'READ_ONLY' ? 'read-only' : 'read and write'} access to ${d.societyName} for ${d.durationMinutes} minutes (${d.grantCode}).\nApprove or deny: ${d.link}`,
    ),
  })),
  'support_access.started': t(['PUSH'], () => ({})),
  'support_access.emergency_started': t(
    ['SMS', 'EMAIL'],
    d => ({
      sms: `SocietyApp support opened emergency read-only access to ${d.societyName} for ${d.durationMinutes} minutes (${d.grantCode}). You can revoke it in Settings.`,
      ...mail(
        'Emergency support access to your society',
        `SocietyApp support opened emergency read-only access to ${d.societyName} for ${d.durationMinutes} minutes (${d.grantCode}). You can revoke it in Settings, Support access.`,
      ),
    }),
    true,
  ),
  'support_access.approved': t(['EMAIL'], d => ({
    ...mail(`Support access ${d.grantCode} approved`, `Your access is active until ${day(d.endsAt)}.`),
  })),
  'support_access.denied': t(['EMAIL'], d => ({
    ...mail(`Support access ${d.grantCode} denied`, `The society denied your request: ${d.reason}`),
  })),
  'support_access.revoked': t(['EMAIL'], d => ({
    ...mail(`Support access ${d.grantCode} revoked`, `The society revoked your access: ${d.reason}`),
  })),
  'support_access.consent_expired': t(['PUSH'], () => ({})),
  'support_access.ended_summary': t(['EMAIL'], d => ({
    ...mail(
      `Support access ${d.grantCode} has ended`,
      `Support access ${d.grantCode} ended (${d.status}). Requests made: ${d.requestCount}. Changes made: ${d.writeCount}. The read log is in Settings, Support access.`,
    ),
  })),
  'support_access.setting_changed': t(['EMAIL'], d => ({
    ...mail(
      'Support access setting changed',
      `SocietyApp support access to ${d.societyName} now ${
        d.requiresSupportConsent ? 'needs your approval each time' : 'starts without approval'
      }.`,
    ),
  })),
  'data_export.ready': t(['EMAIL'], d => ({
    ...mail(
      'Your SocietyApp data export is ready',
      `The data export of ${d.societyName} is ready. Download it from Settings, Data export before ${day(d.expiresAt)}.`,
    ),
  })),
  'data_export.failed': t(['EMAIL'], d => ({
    ...mail(
      'Your SocietyApp data export failed',
      `The data export of ${d.societyName} could not be prepared. Try again or contact support.`,
    ),
  })),
  'data_export.expiring': t(['SMS', 'EMAIL'], d => ({
    sms: `The closure data export of ${d.societyName} can be downloaded until ${day(d.expiresAt)}.`,
    ...mail(
      'Download your closure export',
      `The closure data export of ${d.societyName} can be downloaded until ${day(d.expiresAt)}. After that it is deleted.`,
    ),
  })),
});
