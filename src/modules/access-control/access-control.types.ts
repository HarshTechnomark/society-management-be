import type { RoleScope } from '../../models/role.model';

export type Relation = 'OWNER' | 'TENANT' | 'FAMILY';
export type UnitLink = { unitId: number; relation: Relation };

/** Section 8.21 `computeAccess` result. `permissions` is empty unless `status` is ACTIVE. */
export interface AccessSnapshot {
  memberId: number | null;
  roleId: number | null;
  roleKey: string | null;
  roleScope: RoleScope | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'ENDED' | 'NONE';
  permissions: string[];
  unitLinks: UnitLink[];
  requiresMfa: boolean;
}

export interface SocietyInfo {
  id: number;
  name: string;
  status: string;
  timezone: string;
  planKey: string;
}

export type SupportGrantScope = 'READ_ONLY' | 'READ_WRITE';
export interface ActiveSupportGrant {
  id: number;
  scope: SupportGrantScope;
  endsAt: Date;
}

export const MAX_MEMBERSHIPS = 20;
export const INVITATION_DAYS = 7;
export const MAX_RESENDS = 3;
export const RESEND_MIN_GAP_SECONDS = 60;
export type LimitKey = 'limit.custom_roles' | 'limit.admin_seats';
