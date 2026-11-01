import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, noContent, ok, okList } from '../../utils/response';
import * as plans from './subscriptions.plans.service';
import * as society from './subscriptions.society.service';
import * as subs from './subscriptions.service';
import * as flags from './flags.service';
import { usageView } from './subscriptions.usage';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const sid = (req: Request) => req.ctx.society!.id;
const v = (req: Request) => req.valid;

export const subscriptionsController = {
  // ---- plans and versions (8.2)
  listPlans: h(async (_req, res) => ok(res, await plans.listPlans())),
  getPlan: h(async (req, res) => ok(res, await plans.getPlan(v(req).params.planId))),
  patchPlan: h(async (req, res) =>
    ok(res, await plans.patchPlan(req.ctx, v(req).params.planId, v(req).body), 'Plan saved'),
  ),
  getVersion: h(async (req, res) => ok(res, await plans.getVersion(v(req).params.versionId))),
  createDraft: h(async (req, res) =>
    created(
      res,
      await plans.createDraft(req.ctx, v(req).params.planId, v(req).body),
      'Draft version created',
    ),
  ),
  patchVersion: h(async (req, res) =>
    ok(res, await plans.patchVersion(req.ctx, v(req).params.versionId, v(req).body), 'Draft saved'),
  ),
  putEntitlements: h(async (req, res) =>
    ok(res, await plans.putEntitlements(req.ctx, v(req).params.versionId, v(req).body), 'Entitlements saved'),
  ),
  publish: h(async (req, res) =>
    ok(res, await plans.publishVersion(req.ctx, v(req).params.versionId, v(req).body), 'Version published'),
  ),
  deleteDraft: h(async (req, res) => {
    await plans.deleteDraft(req.ctx, v(req).params.versionId, v(req).query.version);
    noContent(res);
  }),
  migrate: h(async (req, res) => {
    const r = await plans.migratePlan(req.ctx, v(req).params.planId, v(req).body);
    ok(res, r, v(req).body.dryRun ? 'Migration preview' : 'Migration scheduled');
  }),
  catalogue: h(async (req, res) => ok(res, plans.catalogue(v(req).query))),

  // ---- add-ons (8.3)
  listAddons: h(async (_req, res) => ok(res, await plans.listAddons())),
  createAddon: h(async (req, res) =>
    created(res, await plans.createAddon(req.ctx, v(req).body), 'Add-on created'),
  ),
  patchAddon: h(async (req, res) =>
    ok(res, await plans.patchAddon(req.ctx, v(req).params.addonId, v(req).body), 'Add-on saved'),
  ),

  // ---- platform subscriptions and overrides (8.4)
  listSubscriptions: h(async (req, res) => {
    const r = await society.listSubscriptions(v(req).query);
    okList(res, r.data, r.pagination);
  }),
  getSubscription: h(async (req, res) =>
    ok(res, await society.subscriptionDetail(v(req).params.subscriptionId)),
  ),
  platformChangePlan: h(async (req, res) => {
    const id = v(req).params.subscriptionId;
    const s = await subs.getSubscriptionById(id);
    const r = await subs.changePlan(req.ctx, s.societyId, v(req).body, 'PLATFORM', id);
    ok(res, r, r.effect === 'IMMEDIATE' ? 'Plan changed' : 'Plan change scheduled');
  }),
  patchSubscription: h(async (req, res) =>
    ok(
      res,
      await society.patchSubscription(req.ctx, v(req).params.subscriptionId, v(req).body),
      'Subscription saved',
    ),
  ),
  listOverrides: h(async (req, res) =>
    ok(res, await society.listOverrides(v(req).params.subscriptionId, v(req).query.includeHistory)),
  ),
  createOverride: h(async (req, res) =>
    created(
      res,
      await society.createOverride(req.ctx, v(req).params.subscriptionId, v(req).body),
      'Override added',
    ),
  ),
  revokeOverride: h(async (req, res) =>
    ok(
      res,
      await society.revokeOverride(
        req.ctx,
        v(req).params.subscriptionId,
        v(req).params.overrideId,
        v(req).body,
      ),
      'Override revoked',
    ),
  ),

  // ---- society reads (8.5)
  summary: h(async (req, res) => ok(res, await subs.getSummary(sid(req)))),
  entitlements: h(async (req, res) => {
    res.setHeader('Cache-Control', 'private, max-age=60');
    ok(res, await society.entitlementsView(req.ctx));
  }),
  usage: h(async (req, res) => ok(res, await usageView(sid(req)))),
  plansForSociety: h(async (req, res) =>
    ok(res, await society.plansForSociety(sid(req), v(req).query.billingCycle)),
  ),
  quote: h(async (req, res) => ok(res, await society.quote(sid(req), v(req).query))),
  downgradePreview: h(async (req, res) =>
    ok(res, await society.downgradePreview(sid(req), v(req).query.planCode)),
  ),

  // ---- society writes (8.6)
  activate: h(async (req, res) => ok(res, await society.activate(req.ctx, v(req).body), 'Paid plan started')),
  changePlan: h(async (req, res) => {
    const r = await subs.changePlan(req.ctx, sid(req), v(req).body, 'SOCIETY');
    ok(res, r, r.effect === 'IMMEDIATE' ? 'Plan upgraded' : 'Plan change scheduled');
  }),
  billingCycle: h(async (req, res) =>
    ok(res, await subs.scheduleCycle(req.ctx, sid(req), v(req).body), 'Billing cycle change scheduled'),
  ),
  cancelPendingChange: h(async (req, res) => {
    await subs.cancelPendingChange(req.ctx, sid(req), v(req).query);
    noContent(res);
  }),
  addonStore: h(async (req, res) => ok(res, await society.addonStore(sid(req)))),
  buyAddon: h(async (req, res) =>
    created(res, await society.buyAddon(req.ctx, v(req).body), 'Add-on purchased'),
  ),
  cancelAddon: h(async (req, res) =>
    ok(
      res,
      await society.cancelAddon(req.ctx, v(req).params.subscriptionAddonId, v(req).query.version),
      'Add-on ends at the end of the period',
    ),
  ),
  resumeAddon: h(async (req, res) =>
    ok(
      res,
      await society.resumeAddon(req.ctx, v(req).params.subscriptionAddonId, v(req).body.version),
      'Add-on resumed',
    ),
  ),
  featureTrial: h(async (req, res) =>
    created(res, await society.startFeatureTrial(req.ctx, v(req).body.featureKey), 'Feature trial started'),
  ),
  cancel: h(async (req, res) =>
    ok(
      res,
      await subs.requestCancellation(req.ctx, sid(req), v(req).body),
      'Cancellation sent for approval',
      202,
    ),
  ),
  withdrawCancel: h(async (req, res) =>
    ok(res, await subs.withdrawCancellation(req.ctx, sid(req), v(req).body), 'Cancellation withdrawn'),
  ),

  // ---- feature flags (8.7)
  listFlags: h(async (req, res) => {
    const r = await flags.listFlags(v(req).query);
    res.status(200).json({
      success: true,
      data: r.data,
      message: 'OK',
      pagination: r.pagination,
      typeCounts: r.typeCounts,
    });
  }),
  getFlag: h(async (req, res) => ok(res, await flags.getFlag(v(req).params.flagId))),
  createFlag: h(async (req, res) =>
    created(res, await flags.createFlag(req.ctx, v(req).body), 'Flag created'),
  ),
  patchFlag: h(async (req, res) =>
    ok(res, await flags.updateFlag(req.ctx, v(req).params.flagId, v(req).body), 'Flag saved'),
  ),
  toggleFlag: h(async (req, res) =>
    ok(res, await flags.toggleFlag(req.ctx, v(req).params.flagId, v(req).body), 'Flag switched'),
  ),
  archiveFlag: h(async (req, res) => {
    await flags.archiveFlag(req.ctx, v(req).params.flagId, {
      reason: v(req).body.reason,
      version: v(req).query.version,
    });
    noContent(res);
  }),
  evaluateFlag: h(async (req, res) =>
    ok(res, await flags.evaluateFlag(v(req).params.flagId, v(req).query.societyId)),
  ),
  addFlagOverride: h(async (req, res) => {
    const r = await flags.upsertFlagOverride(req.ctx, v(req).params.flagId, v(req).body);
    if (r.created) created(res, r.override, 'Override added');
    else ok(res, r.override, 'Override replaced');
  }),
  removeFlagOverride: h(async (req, res) => {
    await flags.removeFlagOverride(
      req.ctx,
      v(req).params.flagId,
      v(req).params.overrideId,
      v(req).body.reason,
    );
    noContent(res);
  }),
};
