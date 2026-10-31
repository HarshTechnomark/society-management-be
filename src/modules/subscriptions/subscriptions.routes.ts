import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { platformMiddleware, societyMiddleware } from '../../middlewares/society.middleware';
import {
  anyActiveMember,
  requirePermission as can,
  requirePlatformPermission as canPlatform,
} from '../../middlewares/permission.middleware';
import { requireFeature } from '../../middlewares/entitlement.middleware';
import { tag } from '../access-control/access-control.registry';
import { subscriptionsController as c } from './subscriptions.controller';
import { subscriptionSchemas as s } from './subscriptions.validation';
import { flagTypeOf } from './flags.service';

/**
 * Module 04 routes (section 8). Order on a route: society or platform, permission, feature, validate, step-up,
 * idempotency, controller (BR-04-28: permission before feature).
 */
const stepUp = (): RequestHandler => tag(requireRecentAuth(), { stepUp: true });
/** Step-up only for KILL_SWITCH flags (8.7.4). */
const stepUpForKillSwitch = (): RequestHandler => {
  const inner = requireRecentAuth();
  return tag(
    async (req, res, next) => {
      try {
        if ((await flagTypeOf(req.valid.params.flagId)) === 'KILL_SWITCH') return inner(req, res, next);
        next();
      } catch (err) {
        next(err);
      }
    },
    { stepUp: true },
  );
};
const society = () => societyMiddleware();
const platform = () => platformMiddleware();
const perUser = (name: string) =>
  rateLimit({ name, limit: 60, windowSeconds: 60, key: req => String(req.ctx.user?.id) });

export const subscriptionsRoutes = Router();
const r = subscriptionsRoutes;

// ---- platform: plans and versions (8.2)
r.get('/platform/plans', platform(), canPlatform('platform.plans.view'), c.listPlans);
r.get(
  '/platform/plans/:planId',
  platform(),
  canPlatform('platform.plans.view'),
  validate({ params: s.planParam }),
  c.getPlan,
);
r.patch(
  '/platform/plans/:planId',
  platform(),
  canPlatform('platform.plans.edit'),
  validate({ params: s.planParam, body: s.patchPlan }),
  c.patchPlan,
);
r.post(
  '/platform/plans/:planId/versions',
  platform(),
  canPlatform('platform.plans.create'),
  validate({ params: s.planParam, body: s.reasonOnly }),
  idempotency(),
  c.createDraft,
);
r.post(
  '/platform/plans/:planId/migrations',
  platform(),
  canPlatform('platform.plans.approve'),
  validate({ params: s.planParam, body: s.migration }),
  stepUp(),
  tag((req, res, next) => (req.valid.body.dryRun ? next() : idempotency()(req, res, next)), {
    idempotent: true,
  }),
  c.migrate,
);
r.get(
  '/platform/plan-versions/:versionId',
  platform(),
  canPlatform('platform.plans.view'),
  validate({ params: s.versionParam }),
  c.getVersion,
);
r.patch(
  '/platform/plan-versions/:versionId',
  platform(),
  canPlatform('platform.plans.edit'),
  validate({ params: s.versionParam, body: s.patchVersion }),
  c.patchVersion,
);
r.put(
  '/platform/plan-versions/:versionId/entitlements',
  platform(),
  canPlatform('platform.plans.edit'),
  validate({ params: s.versionParam, body: s.putEntitlements }),
  c.putEntitlements,
);
r.post(
  '/platform/plan-versions/:versionId/publish',
  platform(),
  canPlatform('platform.plans.edit'),
  validate({ params: s.versionParam, body: s.reasonVersion }),
  stepUp(),
  c.publish,
);
r.delete(
  '/platform/plan-versions/:versionId',
  platform(),
  canPlatform('platform.plans.edit'),
  validate({ params: s.versionParam, query: s.versionQuery }),
  c.deleteDraft,
);
r.get(
  '/platform/entitlement-catalogue',
  platform(),
  canPlatform('platform.plans.view'),
  validate({ query: s.catalogueQuery }),
  c.catalogue,
);

// ---- platform: add-ons (8.3)
r.get('/platform/addons', platform(), canPlatform('platform.plans.view'), c.listAddons);
r.post(
  '/platform/addons',
  platform(),
  canPlatform('platform.plans.create'),
  validate({ body: s.createAddon }),
  idempotency(),
  c.createAddon,
);
r.patch(
  '/platform/addons/:addonId',
  platform(),
  canPlatform('platform.plans.edit'),
  validate({ params: s.addonParam, body: s.patchAddon }),
  c.patchAddon,
);

// ---- platform: subscriptions and overrides (8.4)
r.get(
  '/platform/subscriptions',
  platform(),
  canPlatform('platform.societies.view'),
  validate({ query: s.listSubscriptions }),
  c.listSubscriptions,
);
r.get(
  '/platform/subscriptions/:subscriptionId',
  platform(),
  canPlatform('platform.societies.view'),
  validate({ params: s.subscriptionParam }),
  c.getSubscription,
);
r.post(
  '/platform/subscriptions/:subscriptionId/change-plan',
  platform(),
  canPlatform('platform.societies.edit'),
  validate({ params: s.subscriptionParam, body: s.platformChangePlan }),
  stepUp(),
  idempotency(),
  c.platformChangePlan,
);
r.patch(
  '/platform/subscriptions/:subscriptionId',
  platform(),
  canPlatform('platform.societies.edit'),
  validate({ params: s.subscriptionParam, body: s.patchSubscription }),
  stepUp(),
  c.patchSubscription,
);
r.get(
  '/platform/subscriptions/:subscriptionId/overrides',
  platform(),
  canPlatform('platform.societies.view'),
  validate({ params: s.subscriptionParam, query: s.overridesQuery }),
  c.listOverrides,
);
r.post(
  '/platform/subscriptions/:subscriptionId/overrides',
  platform(),
  canPlatform('platform.societies.edit'),
  validate({ params: s.subscriptionParam, body: s.createOverride }),
  stepUp(),
  idempotency(),
  c.createOverride,
);
r.post(
  '/platform/subscriptions/:subscriptionId/overrides/:overrideId/revoke',
  platform(),
  canPlatform('platform.societies.edit'),
  validate({ params: s.overrideParams, body: s.reasonVersion }),
  c.revokeOverride,
);

// ---- platform: feature flags (8.7)
r.get(
  '/platform/feature-flags',
  platform(),
  canPlatform('platform.feature_flags.view'),
  validate({ query: s.listFlags }),
  c.listFlags,
);
r.get(
  '/platform/feature-flags/:flagId',
  platform(),
  canPlatform('platform.feature_flags.view'),
  validate({ params: s.flagParam }),
  c.getFlag,
);
r.post(
  '/platform/feature-flags',
  platform(),
  canPlatform('platform.feature_flags.create'),
  validate({ body: s.createFlag }),
  idempotency(),
  c.createFlag,
);
r.patch(
  '/platform/feature-flags/:flagId',
  platform(),
  canPlatform('platform.feature_flags.edit'),
  validate({ params: s.flagParam, body: s.patchFlag }),
  c.patchFlag,
);
r.post(
  '/platform/feature-flags/:flagId/toggle',
  platform(),
  canPlatform('platform.feature_flags.edit'),
  validate({ params: s.flagParam, body: s.toggleFlag }),
  stepUpForKillSwitch(),
  c.toggleFlag,
);
r.delete(
  '/platform/feature-flags/:flagId',
  platform(),
  canPlatform('platform.feature_flags.edit'),
  validate({ params: s.flagParam, query: s.versionQuery, body: s.reasonOnly }),
  c.archiveFlag,
);
r.get(
  '/platform/feature-flags/:flagId/evaluate',
  platform(),
  canPlatform('platform.feature_flags.view'),
  validate({ params: s.flagParam, query: s.evaluateQuery }),
  c.evaluateFlag,
);
r.post(
  '/platform/feature-flags/:flagId/overrides',
  platform(),
  canPlatform('platform.feature_flags.edit'),
  validate({ params: s.flagParam, body: s.flagOverride }),
  c.addFlagOverride,
);
r.delete(
  '/platform/feature-flags/:flagId/overrides/:overrideId',
  platform(),
  canPlatform('platform.feature_flags.edit'),
  validate({ params: s.flagOverrideParams, body: s.reasonOnly }),
  c.removeFlagOverride,
);

// ---- society: reads (8.5)
r.get('/subscription', society(), can('settings.subscription.view'), c.summary);
r.get('/subscription/entitlements', society(), anyActiveMember(), c.entitlements);
r.get('/subscription/usage', society(), can('settings.subscription.view'), c.usage);
r.get(
  '/subscription/plans',
  society(),
  can('settings.subscription.view'),
  validate({ query: s.plansQuery }),
  c.plansForSociety,
);
r.get(
  '/subscription/quote',
  society(),
  can('settings.subscription.view'),
  validate({ query: s.quoteQuery }),
  perUser('subscription-quote'),
  c.quote,
);
r.get(
  '/subscription/downgrade-preview',
  society(),
  can('settings.subscription.view'),
  requireFeature('platform.downgrade_impact_preview', { mode: 'read' }),
  validate({ query: s.previewQuery }),
  perUser('subscription-downgrade-preview'),
  c.downgradePreview,
);

// ---- society: writes (8.6)
r.post(
  '/subscription/activate',
  societyMiddleware({ allowWhenSuspended: true }),
  can('settings.subscription.edit'),
  validate({ body: s.activate }),
  stepUp(),
  idempotency(),
  c.activate,
);
r.post(
  '/subscription/change-plan',
  society(),
  can('settings.subscription.edit'),
  validate({ body: s.changePlan }),
  stepUp(),
  idempotency(),
  c.changePlan,
);
r.post(
  '/subscription/billing-cycle',
  society(),
  can('settings.subscription.edit'),
  validate({ body: s.billingCycle }),
  c.billingCycle,
);
r.delete(
  '/subscription/pending-change',
  society(),
  can('settings.subscription.edit'),
  validate({ query: s.pendingChangeQuery }),
  c.cancelPendingChange,
);
r.get(
  '/subscription/addons',
  society(),
  can('settings.subscription.view'),
  requireFeature('platform.add_on_store', { mode: 'read' }),
  c.addonStore,
);
r.post(
  '/subscription/addons',
  society(),
  can('settings.subscription.edit'),
  requireFeature('platform.add_on_store'),
  validate({ body: s.buyAddon }),
  idempotency(),
  c.buyAddon,
);
r.delete(
  '/subscription/addons/:subscriptionAddonId',
  society(),
  can('settings.subscription.edit'),
  requireFeature('platform.add_on_store'),
  validate({ params: s.ownedAddonParam, query: s.versionQuery }),
  c.cancelAddon,
);
r.post(
  '/subscription/addons/:subscriptionAddonId/resume',
  society(),
  can('settings.subscription.edit'),
  requireFeature('platform.add_on_store'),
  validate({ params: s.ownedAddonParam, body: s.versionOnly }),
  c.resumeAddon,
);
r.post(
  '/subscription/feature-trials',
  society(),
  can('settings.subscription.edit'),
  requireFeature('platform.premium_feature_trial'),
  validate({ body: s.featureTrial }),
  idempotency(),
  c.featureTrial,
);
r.post(
  '/subscription/cancel',
  society(),
  can('settings.subscription.edit'),
  validate({ body: s.cancel }),
  stepUp(),
  idempotency(),
  c.cancel,
);
r.post(
  '/subscription/cancel/withdraw',
  society(),
  can('settings.subscription.edit'),
  validate({ body: s.versionOnly }),
  c.withdrawCancel,
);
