import { env } from '../../lib/env';
import { usesRedis } from '../../lib/queue';

/**
 * How delivery rows are sent: `inline` (development and tests: right after the rows are written, so the dev inbox fills at once) or `queue`
 * (production and any Redis setup: one `communication:deliver` job per row). Tests switch with `setDeliveryMode`.
 */
export type DeliveryMode = 'inline' | 'queue';
let forced: DeliveryMode | null = null;
export const setDeliveryMode = (m: DeliveryMode | null): void => {
  forced = m;
};
export const deliveryMode = (): DeliveryMode =>
  forced ?? (env().NODE_ENV === 'production' || usesRedis() ? 'queue' : 'inline');
