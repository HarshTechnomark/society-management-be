/**
 * The module 04 functions other modules may import (section 8.8, 8.9). Middleware: `middlewares/entitlement.middleware.ts`.
 */
import { Role, SocietyMember } from '../../models';
import { setAuthPorts } from '../auth/auth.ports';
import { invalidateSociety, setAccessPorts } from '../access-control/access-control.public';
import { assertCatalogue } from './subscriptions.catalogue';
import * as ent from './entitlements.service';
import * as svc from './subscriptions.service';
import { isFlagOn } from './flags.service';
import { registerSubscriptionJobs } from './subscriptions.jobs';
import { seatUsage } from './subscriptions.usage';

export const entitlements = {
  getEntitlements: ent.getEntitlements,
  isFeatureOn: ent.isFeatureOn,
  assertFeature: ent.assertFeature,
  getLimit: ent.getLimit,
  getUsage: ent.getUsage,
  consumeLimit: ent.consumeLimit,
  releaseLimit: ent.releaseLimit,
  registerUsageProvider: ent.registerUsageProvider,
  registerFeatureUsageProvider: ent.registerFeatureUsageProvider,
  invalidate: ent.invalidate,
  getFeatures: ent.getFeatures,
};
export const flags = { isFlagOn };

/** Module 05, 06, 08 and 14 entry points (section 8.9). */
export const subscriptions = {
  createTrial: svc.createTrial,
  createInitial: svc.createInitial,
  startPaid: svc.startPaid,
  extendTrial: svc.extendTrial,
  cancelForClosure: svc.cancelForClosure,
  summaryForSocieties: svc.summaryForSocieties,
  societyIdsByPlan: svc.societyIdsByPlan,
  hasPaidSubscription: svc.hasPaidSubscription,
  listDueForInvoicing: svc.listDueForInvoicing,
  getBillingSnapshot: svc.getBillingSnapshot,
  onPlatformInvoicePaid: svc.onPlatformInvoicePaid,
  setAutopay: svc.setAutopay,
  applyCancellation: svc.applyCancellation,
  onFlatCountChanged: svc.onFlatCountChanged,
  renewIfDue: svc.renewIfDue,
  seatUsage,
};
export { setSubscriptionIntegrations } from './subscriptions.integrations';
export type { SubscriptionIntegrations } from './subscriptions.integrations';

let hooked = false;
/**
 * Start-up hook (like `registerAccessControl()`): replaces the module 02 and 03 `entitlements` placeholders with the real
 * implementation, registers the seat and custom-role usage providers, the cache hook for module 03's society info, and the
 * jobs. Call from `server.ts`, `worker.ts` and the seed script, after `registerAccessControl()`.
 */
export function registerSubscriptions(): void {
  assertCatalogue();
  setAccessPorts({
    entitlements: {
      consumeLimit: async (ctx, key, n, opts) => {
        await ent.consumeLimit(ctx, key, n, opts);
      },
      releaseLimit: (ctx, key, n, opts) => ent.releaseLimit(ctx, key, n, opts),
      getLimit: (societyId, key) => ent.getUsage(societyId, key),
      planKeyFor: async societyId => (await ent.getEntitlements(societyId)).planCode ?? 'NONE',
    },
  });
  setAuthPorts({ entitlements: { getFeatures: ent.getFeatures } });
  if (!hooked) {
    hooked = true;
    ent.onEntitlementsInvalidated(invalidateSociety);
  }
  // module 03 counts (BR-04 2.5): seat-holding members, and the society's own (non-system) roles
  ent.registerUsageProvider('limit.admin_seats', societyId =>
    SocietyMember.count({
      where: { societyId, status: ['ACTIVE', 'SUSPENDED'] },
      include: [{ association: 'Role', where: { consumesSeat: true }, attributes: [], required: true }],
    }),
  );
  ent.registerUsageProvider('limit.custom_roles', societyId =>
    Role.count({ where: { societyId, isSystem: false } }),
  );
  registerSubscriptionJobs();
}
