import type { Request, RequestHandler } from 'express';
import { AppError, PaymentRequiredError } from '../utils/errors';
import { tag } from '../modules/access-control/access-control.registry';
import {
  FEATURE_BY_KEY,
  LIMIT_BY_KEY,
  type FeatureKey,
  type LimitKey,
} from '../modules/subscriptions/subscriptions.catalogue';
import {
  counterLimit,
  featureAllowed,
  featureNotInPlan,
  getEntitlements,
  periodKeyFor,
  usedOf,
  type FeatureMode,
} from '../modules/subscriptions/entitlements.service';
import type { ResolvedEntitlements } from '../modules/subscriptions/subscriptions.types';

/**
 * Module 04 plan checks (section 8.8). Place after `societyMiddleware` and `requirePermission` (BR-04-28): a feature
 * check never runs before the permission check. Unknown keys fail at start-up (the route file does not load).
 */
const perRequest = new WeakMap<Request, ResolvedEntitlements>();

async function entitlementsFor(req: Request): Promise<ResolvedEntitlements> {
  const societyId = req.ctx.society?.id;
  if (!societyId) throw new AppError(403, 'SOCIETY_NOT_SELECTED', 'Select a society first');
  let ent = perRequest.get(req);
  if (!ent) {
    ent = await getEntitlements(societyId);
    perRequest.set(req, ent);
  }
  return ent;
}

/** `402 FEATURE_NOT_IN_PLAN` unless the feature is on (or, with `mode: 'read'`, in the 90-day read grace, BR-04-18). */
export function requireFeature(key: FeatureKey, opts: { mode?: FeatureMode } = {}): RequestHandler {
  if (!FEATURE_BY_KEY.has(key)) throw new Error(`requireFeature: unknown entitlement key ${key}`);
  const mode = opts.mode ?? 'write';
  return tag(
    async (req, _res, next) => {
      try {
        const ent = await entitlementsFor(req);
        if (featureAllowed(ent, key, mode)) return next();
        next(await featureNotInPlan(ent, key));
      } catch (err) {
        next(err);
      }
    },
    { features: [key] },
  );
}

/** Early `402 USAGE_LIMIT_EXCEEDED` before a costly request; not authoritative (the service still calls `consumeLimit`). */
export function requireLimitHeadroom(key: LimitKey, n: number | ((req: Request) => number)): RequestHandler {
  const def = LIMIT_BY_KEY.get(key);
  if (!def) throw new Error(`requireLimitHeadroom: unknown limit key ${key}`);
  return async (req, _res, next) => {
    try {
      const ent = await entitlementsFor(req);
      const want = typeof n === 'function' ? n(req) : n;
      const limit = counterLimit(key, ent.limits[key]?.limit ?? 0);
      if (limit === null) return next();
      const ceiling = def.enforcement === 'SOFT' && limit > 0 ? limit * 2 : limit;
      const used = await usedOf(ent.societyId, key, periodKeyFor(ent, key));
      if (used + want <= ceiling) return next();
      next(
        new PaymentRequiredError('USAGE_LIMIT_EXCEEDED', `Plan limit reached (${def.title}).`, [
          { field: 'limitKey', message: key, limit, used, requested: want },
        ]),
      );
    } catch (err) {
      next(err);
    }
  };
}
