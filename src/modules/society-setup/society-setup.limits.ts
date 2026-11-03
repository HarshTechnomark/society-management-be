import type { Transaction } from 'sequelize';
import type { Ctx } from '../../types/context';
import { entitlements, subscriptions } from '../subscriptions/subscriptions.public';
import { FLATS_LIMIT } from './society-setup.types';
import { COUNTABLE_UNIT_TYPES, type UnitType } from '../../models/unit.model';

/** BR-08-20: countable units are ACTIVE FLAT, SHOP and OFFICE units; PARKING_ONLY never counts. */
export const isCountable = (t: UnitType | string): boolean =>
  (COUNTABLE_UNIT_TYPES as readonly string[]).includes(t);

/**
 * Moves the `limit.flats` counter by `delta` inside the caller's transaction and, once, tells module 04 that the flat
 * count changed. `consumeLimit` throws `402 USAGE_LIMIT_EXCEEDED` when the plan is full.
 */
export async function adjustFlats(ctx: Ctx, societyId: number, delta: number, t: Transaction): Promise<void> {
  if (delta > 0) await entitlements.consumeLimit(ctx, FLATS_LIMIT, delta, { transaction: t, societyId });
  else if (delta < 0)
    await entitlements.releaseLimit(ctx, FLATS_LIMIT, -delta, { transaction: t, societyId });
  if (delta !== 0) await subscriptions.onFlatCountChanged(ctx, societyId, t);
}
