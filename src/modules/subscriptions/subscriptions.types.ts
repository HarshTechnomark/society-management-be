import type { Transaction } from 'sequelize';
import type { Ctx } from '../../types/context';
import type { FeatureKey, LimitKey, PlanCode } from './subscriptions.catalogue';

export type { FeatureKey, LimitKey, PlanCode };
export type BillingCycle = 'MONTHLY' | 'ANNUAL';
export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'CANCELLED';
export type StatusReason =
  'SIGNED_UP' | 'PAID_START' | 'CANCELLED_AT_PERIOD_END' | 'TRIAL_CANCELLED' | 'SOCIETY_CLOSED';
export type AutopayStatus = 'NONE' | 'PENDING' | 'ACTIVE' | 'CANCELLED' | 'FAILED';
export type PendingChangeType = 'DOWNGRADE' | 'VERSION_MIGRATION';
export type AddonStatus = 'PENDING_PAYMENT' | 'ACTIVE' | 'CANCEL_SCHEDULED' | 'ENDED';
export type OverrideSource = 'CONTRACT' | 'SUPPORT' | 'PREMIUM_TRIAL' | 'PROMOTION';
export type FlagType = 'GLOBAL' | 'PLAN' | 'TENANT' | 'PERCENTAGE' | 'KILL_SWITCH';

export type AddonGrant =
  | { type: 'FEATURE'; key: string }
  | { type: 'LIMIT_INCREMENT'; key: string; amount: number }
  | { type: 'FEATURE_CHOICE' };

export type EntitlementSource = 'ALWAYS_ON' | 'OVERRIDE_KEY' | 'OVERRIDE_MODULE' | 'ADDON' | 'PLAN';

export interface ResolvedFeature {
  on: boolean;
  source: EntitlementSource;
}
export interface ResolvedLimit {
  /** null is unlimited. Storage is in GB here; usage converts to bytes. */
  limit: number | null;
  planValue: number | null;
  addonIncrement: number;
  overrideApplied: boolean;
}
/** Output of the resolver for one society; JSON-safe so it can be cached (section 6.6). */
export interface ResolvedEntitlements {
  societyId: number;
  subscriptionId: number | null;
  planCode: PlanCode | null;
  planVersionId: number | null;
  status: SubscriptionStatus | null;
  billingAnchorDay: number;
  timezone: string;
  /** Current usage month start (`YYYY-MM-DD`, BR-04-20). */
  usageMonth: string;
  features: Record<string, ResolvedFeature>;
  limits: Record<string, ResolvedLimit>;
  /** Feature keys that stay readable until `readOnlyUntil` (BR-04-18). */
  readOnlyFeatures: string[];
  readOnlyUntil: string | null;
  generation: number;
  /** ISO time of the next override or add-on expiry; the cache TTL is capped by it. */
  nextExpiryAt: string | null;
}

export interface SeamCtx {
  ctx: Ctx;
  t: Transaction;
}
