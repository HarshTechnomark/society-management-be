import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';

/**
 * Module 04 notification templates (section 10) for the temporary `lib/notify.ts`; module 16 owns them later.
 * In-app delivery is not sent by the stand-in, so in-app-only templates render nothing.
 */
const t = (channels: NotifyChannel[], render: Template['render']): Template => ({
  channels,
  critical: false,
  render,
});
const mail = (subject: string, text: string) => ({ email: { subject, text } });

registerTemplates({
  'subscription.paid_started': t(['EMAIL'], d =>
    mail(
      'Your SocietyApp plan is active',
      `${d.societyName ?? 'Your society'} is now on the ${d.planName} plan (${d.billingCycle}).`,
    ),
  ),
  'subscription.plan_upgraded': t(['EMAIL'], d =>
    mail(
      'Plan upgraded',
      `Your society moved to the ${d.planName} plan today. New features are available now.`,
    ),
  ),
  'subscription.downgrade_scheduled': t(['EMAIL'], d =>
    mail('Plan change scheduled', `Your society will move to the ${d.planName} plan on ${d.effectiveDate}.`),
  ),
  'subscription.downgrade_applied': t(['EMAIL'], d =>
    mail(
      'Plan changed',
      `Your society is now on the ${d.planName} plan. Features of the previous plan stay readable until ${d.readOnlyUntil}.`,
    ),
  ),
  'subscription.downgrade_blocked': t(['EMAIL'], d =>
    mail(
      'Plan change postponed',
      `The move to the ${d.planName} plan was postponed: usage is above its limits (${d.conflicts}).`,
    ),
  ),
  'subscription.price_migration_notice': t(['EMAIL'], d =>
    mail('Plan price update', `Your ${d.planName} plan moves to its new version on ${d.effectiveDate}.`),
  ),
  'subscription.cycle_changed': t(['EMAIL'], d =>
    mail('Billing cycle changed', `Your subscription is now billed ${String(d.billingCycle).toLowerCase()}.`),
  ),
  'subscription.addon_purchased': t(['EMAIL'], d =>
    mail('Add-on purchased', `${d.addonName} was added to your subscription.`),
  ),
  'subscription.addon_activated': t(['PUSH'], () => ({})),
  'subscription.addon_ended': t(['PUSH'], () => ({})),
  'subscription.usage_threshold': t(['EMAIL'], d =>
    mail(
      `${d.pct} % of a plan limit used`,
      `Your society has used ${d.pct} % of ${d.limitTitle} for this period.`,
    ),
  ),
  'subscription.feature_trial_started': t(['EMAIL'], d =>
    mail('Feature trial started', `${d.featureTitle} is on for 14 days, until ${d.expiresAt}.`),
  ),
  'subscription.feature_trial_ending': t(['EMAIL'], d =>
    mail('Feature trial ends soon', `The trial of ${d.featureTitle} ends on ${d.expiresAt}.`),
  ),
  'subscription.feature_trial_ended': t(['EMAIL'], d =>
    mail('Feature trial ended', `The trial of ${d.featureTitle} has ended.`),
  ),
  'subscription.cancel_scheduled': t(['EMAIL', 'SMS'], d => ({
    sms: `SocietyApp: your subscription is set to end on ${d.periodEnd}.`,
    ...mail('Subscription cancellation scheduled', `Your SocietyApp subscription ends on ${d.periodEnd}.`),
  })),
  'subscription.cancelled': t(['EMAIL'], () =>
    mail('Subscription cancelled', 'Your SocietyApp subscription has ended. Data export stays available.'),
  ),
});
