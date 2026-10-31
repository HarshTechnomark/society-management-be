/**
 * The only access-control functions other modules may import (section 8.21).
 * Policies and middlewares live in `access-control.policies.ts` and `src/middlewares/`.
 */
import { setAuthPorts } from '../auth/auth.ports';
import { authAccess } from './access-control.auth-port';
import { registerAccessControlJobs } from './access-control.jobs';
import { computeAccess } from './access-control.access';
import { del, keys } from './access-control.cache';
import {
  endAllMembersForSociety,
  endMember,
  endResidentMember,
  ensureResidentMember,
  changeRole,
  createInitialMember,
  listForSociety,
  roleKeysOf,
  setResidentRole,
  usersWithPermission,
} from './access-control.members.service';
import { cancelAllPendingInvitations, createInvitation } from './access-control.invitations.service';
import { invalidateMember, revokeHouseholdGrants } from './access-control.household.service';
import { provisionSocietyRoles, syncCatalogue } from './access-control.provision';

export { authAccess, computeAccess, provisionSocietyRoles, syncCatalogue, usersWithPermission };
export { createInitialMember, createInvitation, cancelAllPendingInvitations, endAllMembersForSociety };
export { ensureResidentMember, setResidentRole, endResidentMember, endMember, changeRole };
export { invalidateMember, revokeHouseholdGrants };
export {
  assertMakerChecker,
  assertUnitAccess,
  assertNotSelf,
  scopeWhere,
  hasPermission,
} from './access-control.policies';
export { setAccessPorts } from './access-control.ports';
export type { AccessPorts } from './access-control.ports';
export type { AccessSnapshot } from './access-control.types';

export const members = { listForSociety };
export const roles = { getPermissionKeys: roleKeysOf };

/** Module 05 calls this after a society status change (BR-03-20). */
export async function invalidateSociety(societyId: number): Promise<void> {
  await del(keys.society(societyId));
}

/** Start-up hook of module 03: gives module 02 the real `authAccess` port and registers the jobs. Call from `server.ts`, `worker.ts` and the seed script. */
export function registerAccessControl(): void {
  setAuthPorts({ authAccess });
  registerAccessControlJobs();
}
