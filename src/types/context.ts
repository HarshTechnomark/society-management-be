import type { Amr, ClientApp } from '../models/session.model';

/** Per-request context (module 01 section 6.2, extended by module 02). Services receive this, never `req` or `res`. */
export interface RequestContext {
  requestId: string;
  ip: string;
  userAgent: string;
  /** App resolved from the Origin header (BR-02-43); undefined when the Origin is missing or unknown. */
  clientApp?: ClientApp;
  /** Origin header value (scheme and host) when it is an allowed app origin. */
  origin?: string;
  /** Raw `sa_device` cookie value when the browser sent one. */
  deviceId?: string;
  user?: {
    id: number;
    name: string | null;
    mobile: string | null;
    email: string | null;
    platformRoleId: number | null;
    status: string;
  };
  session?: {
    id: number;
    authTime: Date;
    clientApp: ClientApp;
    activeSocietyId: number | null;
    mfaVerified: boolean;
    amr: Amr[];
    supportGrantId: number | null;
    idleTimeoutMinutes: number;
    absoluteExpiresAt: Date;
  };
  /** Module 03: the active society (from `session.activeSocietyId`), set by `societyMiddleware`. */
  society?: { id: number; name: string; status: string; timezone: string; planKey: string };
  /** Module 03: the caller's ACTIVE membership in the active society (absent under a support grant). */
  membership?: {
    id: number;
    roleId: number;
    roleKey: string;
    roleScope: 'platform' | 'society' | 'resident' | 'gate' | 'work';
    status: 'ACTIVE';
    requiresMfa: boolean;
  };
  /** Module 03: effective society permissions (BR-03-4, or BR-03-19 under a support grant). Empty until `societyMiddleware`. */
  permissions: Set<string>;
  /** Module 03: permissions of the caller's platform role, set by `platformMiddleware`. */
  platformPermissions: Set<string>;
  /** Module 03: active unit links of the caller (module 09). */
  unitIds: number[];
  unitLinks: { unitId: number; relation: 'OWNER' | 'TENANT' | 'FAMILY' }[];
  /** Filled by module 03 from `session.supportGrantId` and module 05. */
  supportGrant?: { id: number; scope: 'READ_ONLY' | 'READ_WRITE'; endsAt: Date };
  /** Module 03: role key used as `actorRole` in audit rows: society role key, platform role key, or `system`. */
  actorRoleKey?: string;
}

/** The part of the context services need when no request exists (jobs, scripts). */
export type Ctx = Pick<RequestContext, 'requestId' | 'ip' | 'userAgent'> &
  Partial<
    Pick<
      RequestContext,
      | 'clientApp'
      | 'origin'
      | 'deviceId'
      | 'user'
      | 'session'
      | 'supportGrant'
      | 'society'
      | 'membership'
      | 'permissions'
      | 'platformPermissions'
      | 'unitIds'
      | 'unitLinks'
      | 'actorRoleKey'
    >
  >;

/** A context with no signed-in user: seeders, jobs and other modules acting for the platform (module 03 section 8.21). */
export type SystemCtx = Ctx;

export const systemCtx = (requestId = 'job'): Ctx => ({ requestId, ip: '', userAgent: '' });
