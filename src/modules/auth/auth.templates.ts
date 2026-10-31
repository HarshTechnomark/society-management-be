import { registerTemplates, setContactResolver, type NotifyChannel, type Template } from '../../lib/notify';
import { User } from '../../models';

/** Notification templates of module 02 (section 10) for the temporary `lib/notify.ts`; module 16 owns them later. */
const t = (channels: NotifyChannel[], critical: boolean, render: Template['render']): Template => ({
  channels,
  critical,
  render,
});

const mail = (subject: string, text: string) => ({ email: { subject, text } });

registerTemplates({
  'auth.otp': t(['SMS'], true, d => ({
    sms: `${d.code} is your SocietyApp login code. It expires in ${d.minutes ?? 5} minutes. Do not share it.\n@${d.host} #${d.code}`,
    whatsappParams: [String(d.code)],
  })),
  'auth.password_reset': t(['EMAIL'], true, d => ({
    ...mail(
      'Reset your SocietyApp password',
      `Use this link within 15 minutes to choose a new password:\n${d.link}`,
    ),
  })),
  'auth.password_changed': t(['EMAIL'], true, () => ({
    ...mail(
      'Your SocietyApp password was changed',
      'Your password was changed. If this was not you, reset it now.',
    ),
  })),
  'auth.email_verify': t(['EMAIL'], true, d => ({
    ...mail(
      'Confirm your new email address',
      `Confirm your new SocietyApp email within 24 hours:\n${d.link}`,
    ),
  })),
  'auth.email_changed': t(['EMAIL'], true, d => ({
    ...mail('Your SocietyApp email was changed', `Your sign-in email was changed to ${d.newEmail}.`),
  })),
  'auth.mobile_changed': t(['SMS'], true, () => ({
    sms: 'Your SocietyApp mobile number was changed. If this was not you, contact support.',
  })),
  'auth.new_device_login': t(['SMS', 'EMAIL'], true, d => ({
    sms: `New SocietyApp sign-in on ${d.deviceLabel}. If this was not you, secure your account.`,
    ...mail(
      'New sign-in to SocietyApp',
      `New sign-in on ${d.deviceLabel}. If this was not you, secure your account.`,
    ),
  })),
  'auth.refresh_reuse_detected': t(['SMS', 'EMAIL'], true, () => ({
    sms: 'Someone may have copied your SocietyApp sign-in. We signed that session out.',
    ...mail(
      'Someone may have copied your sign-in',
      'We signed that session out. Sign in again and review your devices.',
    ),
  })),
  'auth.account_locked': t(['SMS', 'EMAIL'], true, d => ({
    sms: `Your SocietyApp account was locked for ${d.minutes} minutes after too many wrong attempts.`,
    ...mail(
      'Your account was locked',
      `Your account was locked for ${d.minutes} minutes after too many wrong attempts.`,
    ),
  })),
  'auth.mfa_enabled': t(['EMAIL'], false, () => ({
    ...mail('Two-step sign-in is on', 'Your authenticator app is now required when you sign in.'),
  })),
  'auth.mfa_disabled': t(['SMS', 'EMAIL'], true, () => ({
    sms: 'Two-step sign-in was turned off on your SocietyApp account.',
    ...mail('Two-step sign-in is off', 'Two-step sign-in was turned off on your account.'),
  })),
  'auth.mfa_reset': t(['SMS', 'EMAIL'], true, () => ({
    sms: 'Your SocietyApp two-step sign-in was reset by an administrator. Set it up again at your next sign-in.',
    ...mail(
      'Two-step sign-in was reset',
      'An administrator reset your two-step sign-in. Set it up again at your next sign-in.',
    ),
  })),
  'auth.recovery_code_used': t(['EMAIL'], true, () => ({
    ...mail(
      'A recovery code was used',
      'A recovery code was used to sign in. Generate new codes in Settings > Security.',
    ),
  })),
  'auth.recovery_codes_regenerated': t(['EMAIL'], false, () => ({
    ...mail('New recovery codes generated', 'Your old recovery codes no longer work.'),
  })),
  'auth.passkey_added': t(['EMAIL'], true, d => ({
    ...mail('A passkey was added', `A passkey named "${d.name}" was added to your account.`),
  })),
  'auth.passkey_removed': t(['EMAIL'], false, d => ({
    ...mail('A passkey was removed', `The passkey "${d.name}" was removed from your account.`),
  })),
  'auth.account_deletion_requested': t(['SMS', 'EMAIL'], true, d => ({
    sms: `Your SocietyApp account will be deleted on ${d.date}. Sign in to cancel.`,
    ...mail('Account deletion requested', `Your account will be deleted on ${d.date}. Sign in to cancel.`),
  })),
  'auth.account_deletion_reminder': t(['SMS', 'EMAIL'], true, d => ({
    sms: `Your SocietyApp account will be deleted in ${d.days} day(s). Sign in to cancel.`,
    ...mail(
      'Your account will be deleted soon',
      `Your account will be deleted in ${d.days} day(s). Sign in to cancel.`,
    ),
  })),
  'auth.account_deletion_cancelled': t(['EMAIL'], false, () => ({
    ...mail('Account deletion cancelled', 'Your account will not be deleted.'),
  })),
  'auth.account_deleted': t(['SMS', 'EMAIL'], true, () => ({
    sms: 'Your SocietyApp account was deleted.',
    ...mail('Your account was deleted', 'Your SocietyApp account and personal data were deleted.'),
  })),
  'auth.account_deletion_blocked': t(['EMAIL'], true, d => ({
    ...mail(
      'Account deletion paused',
      `We could not delete your account yet: ${d.reasons}. Resolve this and request again.`,
    ),
  })),
  'auth.signup_existing_account': t(['SMS'], true, () => ({
    sms: 'You already have a SocietyApp account. Sign in instead.',
  })),
});

setContactResolver(async userId => {
  const u = await User.findByPk(userId, { attributes: ['mobile', 'email', 'emailVerifiedAt'] });
  return u ? { mobile: u.mobile, email: u.email } : null;
});
