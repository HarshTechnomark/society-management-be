import { kv } from '../../lib/kv';

/**
 * 8.2 count cache: `appr:count:<societyId>:<userId>:<epoch>` for 60 seconds; `appr:epoch:<societyId>` is bumped after every
 * commit that changes a request of the society (`emitChanged` calls `bumpEpoch`). Memory or Redis through `lib/kv`.
 */
export const COUNT_TTL_SECONDS = 60;
export const epochKey = (societyId: number): string => `appr:epoch:${societyId}`;
export const countKey = (societyId: number, userId: number, epoch: number): string =>
  `appr:count:${societyId}:${userId}:${epoch}`;

export const readEpoch = (societyId: number): Promise<number> => kv().counterGet(epochKey(societyId));
