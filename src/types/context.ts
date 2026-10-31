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
  /** Filled by module 05 from `session.supportGrantId`. */
  supportGrant?: { id: number; scope: 'READ_ONLY' | 'READ_WRITE'; endsAt: Date };
}

/** The part of the context services need when no request exists (jobs, scripts). */
export type Ctx = Pick<RequestContext, 'requestId' | 'ip' | 'userAgent'> &
  Partial<Pick<RequestContext, 'clientApp' | 'origin' | 'deviceId' | 'user' | 'session' | 'supportGrant'>>;

export const systemCtx = (requestId = 'job'): Ctx => ({ requestId, ip: '', userAgent: '' });
