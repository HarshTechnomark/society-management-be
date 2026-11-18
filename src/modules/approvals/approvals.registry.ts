import { logger } from '../../lib/logger';
import { AppError } from '../../utils/errors';
import { APPROVAL_TYPES, isApprovalType } from './approvals.catalogue';
import { ERR } from './approvals.constants';
import type { TypeHandlers } from './approvals.types';

/**
 * BR-14-2 type registry. `registerType` of an unknown type, a second registration, or missing `onApproved`, `onRejected` or
 * `describe` throws at boot. `replace: true` is for the compatibility port (modules register again on every `registerX()` call in
 * tests) and for hot re-registration; production boot never passes it.
 */
const handlers = new Map<string, TypeHandlers>();

export function registerType(type: string, h: TypeHandlers, opts: { replace?: boolean } = {}): void {
  if (!isApprovalType(type)) throw new Error(`approvals.registerType: unknown type ${type}`);
  if (handlers.has(type) && !opts.replace)
    throw new Error(`approvals.registerType: ${type} is already registered`);
  for (const fn of ['onApproved', 'onRejected', 'describe'] as const)
    if (typeof h[fn] !== 'function') throw new Error(`approvals.registerType: ${type} needs ${fn}`);
  handlers.set(type, h);
}

export const getHandlers = (type: string): TypeHandlers | undefined => handlers.get(type);
export const isRegistered = (type: string): boolean => handlers.has(type);

/** `request()` for a catalogued type without handlers is a developer error (BR-14-2). */
export function requireHandlers(type: string): TypeHandlers {
  const h = handlers.get(type);
  if (!h) {
    logger.error({ type }, 'approvals: no handlers registered for type');
    throw new AppError(500, ERR.internal, 'Something went wrong');
  }
  return h;
}

/** Boot check: logs (does not fail) the catalogued types nobody registered yet. */
export function unregisteredTypes(): string[] {
  return APPROVAL_TYPES.filter(t => !handlers.has(t));
}
export function logUnregisteredTypes(): void {
  const missing = unregisteredTypes();
  if (missing.length)
    logger.info({ missing }, 'approvals: types without handlers (owner module not deployed)');
}

/** Test helper. */
export function resetRegistry(): void {
  handlers.clear();
}
