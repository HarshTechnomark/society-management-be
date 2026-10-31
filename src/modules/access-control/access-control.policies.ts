import { AppError, ForbiddenError, NotFoundError } from '../../utils/errors';
import type { Ctx } from '../../types/context';

/** Policy helpers every module uses in its services (section 8.21, BR-03-22). */

/** BR-03-22: the approver is never the maker. */
export function assertMakerChecker(ctx: Ctx, makerUserId: number): void {
  if (ctx.user?.id === makerUserId)
    throw new AppError(409, 'MAKER_CHECKER_VIOLATION', 'The person who created this cannot approve it');
}

/** 404 with the caller's own code for a unit outside the caller's units (BR-03-23). */
export function assertUnitAccess(ctx: Ctx, unitId: number, notFoundCode: string): void {
  if (!(ctx.unitIds ?? []).includes(unitId)) throw new NotFoundError(notFoundCode, 'Not found');
}

/** BR-03-9: nobody changes their own role, status or grants. */
export function assertNotSelf(ctx: Ctx, targetUserId: number): void {
  if (ctx.user?.id === targetUserId)
    throw new ForbiddenError('SELF_CHANGE_NOT_ALLOWED', 'You cannot change yourself');
}

/** Spread into every `where` on a society table. The society id comes from the session only (BR-03-17). */
export function scopeWhere(ctx: Ctx): { societyId: number } {
  const id = ctx.society?.id;
  if (!id) throw new ForbiddenError('SOCIETY_NOT_SELECTED', 'Select a society first');
  return { societyId: id };
}

export function hasPermission(ctx: Ctx, key: string): boolean {
  return ctx.permissions?.has(key) ?? false;
}

/** BR-03-5: every key of the resulting set must be held by the caller. System callers (no user) are not limited. */
export function assertCanGrant(ctx: Ctx, keys: string[]): void {
  if (!ctx.user) return;
  const missing = keys.filter(k => !ctx.permissions?.has(k));
  if (missing.length)
    throw new AppError(
      403,
      'CANNOT_GRANT_UNHELD_PERMISSION',
      'You cannot give more access than you have',
      missing.map(k => ({ field: 'permissionKey', message: k })),
    );
}
