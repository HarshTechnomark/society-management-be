import { EventEmitter } from 'node:events';
import type { Transaction } from 'sequelize';
import { kv } from '../../lib/kv';
import { AppError, ConflictError, NotFoundError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { emitAfterCommit } from './platform-ops.notify';

/** Small pieces shared by the part 2 services (providers, incidents, announcements, queues, audit). */
export const staleVersion = (what = 'record') =>
  new AppError(409, 'STALE_VERSION', `This ${what} changed since you opened it. Reload and try again.`);
export const invalidState = (m = 'This change is not allowed in the current state') =>
  new ConflictError('INVALID_STATE', m);
export const providerNotFound = () => new NotFoundError('PROVIDER_NOT_FOUND', 'Provider not found');
export const incidentNotFound = () => new NotFoundError('INCIDENT_NOT_FOUND', 'Incident not found');
export const announcementNotFound = () =>
  new NotFoundError('ANNOUNCEMENT_NOT_FOUND', 'Announcement not found');

/** Read at call time (not from the cached `env()`), so tests can switch it. */
export const inProduction = (): boolean => process.env.NODE_ENV === 'production';

/** The acting person for timeline entries and audit rows; jobs have no user. */
export const actorOf = (ctx: Ctx): { userId: number | null; name: string } => ({
  userId: ctx.user?.id ?? null,
  name: ctx.user?.name ?? 'SocietyApp',
});

export const SYSTEM_ACTOR = { userId: null, name: 'SocietyApp', role: 'system' } as const;

/** Redis pub/sub `platform-ops:providers-changed` (in process here; module 16 listens on the real channel). */
export const providerEvents = new EventEmitter();
export const STATUS_CACHE_KEY = 'status:v1';

/** Status page cache is dropped on every incident or provider status change (BR-07-35), after commit. */
export function invalidateStatusAfterCommit(t: Transaction | null): void {
  const run = () => void kv().cacheDel(STATUS_CACHE_KEY);
  if (t) t.afterCommit(run);
  else run();
}

export const OPS_ROOM = 'platform:ops';
export const emitOps = (t: Transaction | null, event: string, payload: Record<string, unknown>): void =>
  emitAfterCommit(t, [{ room: OPS_ROOM, event, payload }]);
