import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';

/**
 * Notification templates of module 03 (section 10) for the temporary `lib/notify.ts`; module 16 owns them later.
 * In-app and push channels are not sent by the stand-in (no recipient contact), so only SMS and email text is rendered.
 */
const t = (channels: NotifyChannel[], render: Template['render']): Template => ({
  channels,
  critical: false,
  render,
});
const mail = (subject: string, text: string) => ({ email: { subject, text } });

registerTemplates({
  'access.invitation': t(['SMS', 'EMAIL'], d => ({
    sms: `${d.inviterName} invited you to ${d.societyName} as ${d.roleName} on SocietyApp. Open ${d.link} (valid till ${d.expiresOn}).`,
    ...mail(
      `You are invited to ${d.societyName}`,
      `${d.inviterName} invited you to ${d.societyName} as ${d.roleName}.\nOpen the invitation: ${d.link}\n${
        d.setupLink ? `Set your password: ${d.setupLink}\n` : ''
      }The invitation is valid until ${d.expiresOn}.`,
    ),
  })),
  'access.platform_invitation': t(['SMS', 'EMAIL'], d => ({
    sms: `${d.inviterName} invited you to the SocietyApp platform team as ${d.roleName}. Open ${d.link} (valid till ${d.expiresOn}).`,
    ...mail(
      'You are invited to the SocietyApp platform team',
      `${d.inviterName} invited you as ${d.roleName}.\nOpen the invitation: ${d.link}\n${
        d.setupLink ? `Set your password: ${d.setupLink}\n` : ''
      }The invitation is valid until ${d.expiresOn}.`,
    ),
  })),
  'access.invitation_accepted': t(['PUSH'], () => ({})),
  'access.invitation_declined': t(['PUSH'], () => ({})),
  'access.role_changed': t(['EMAIL'], d => ({
    ...mail('Your role changed', `Your role is now ${d.roleName}. Refresh the app to see your new menus.`),
  })),
  'access.role_permissions_changed': t(['EMAIL'], d => ({
    ...mail(
      'A role was changed',
      `The permissions of the role ${d.roleName} were changed. Review them in Settings, Roles.`,
    ),
  })),
  'access.membership_suspended': t(['SMS'], d => ({
    sms: `Your access to ${d.societyName} on SocietyApp was suspended. Contact the committee.`,
  })),
  'access.membership_reactivated': t(['SMS'], d => ({
    sms: `Your access to ${d.societyName} on SocietyApp is active again.`,
  })),
  'access.membership_ended': t(['SMS', 'EMAIL'], d => ({
    sms: `Your access to ${d.societyName ?? 'the society'} on SocietyApp has ended.`,
    ...mail(
      'Your access has ended',
      `Your access to ${d.societyName ?? 'the society'} has ended. Your records stay.`,
    ),
  })),
  'access.grant_added': t(['PUSH'], () => ({})),
  'access.grant_revoked': t(['PUSH'], () => ({})),
  'access.grant_expiring': t(['PUSH'], () => ({})),
  'access.grant_expired': t(['PUSH'], () => ({})),
  'access.household_permissions_changed': t(['PUSH'], () => ({})),
});
