import type { RequestContext } from './context';
import type { StatePolicy } from '../modules/societies/societies.types';

declare global {
  namespace Express {
    interface Request {
      /** Per-request context. Starts with the request id; modules 02 to 04 add user, session, society and permissions. */
      ctx: RequestContext;
      /** Parsed and validated input. Controllers read only these. */
      valid: { body: any; query: any; params: any };
      /** Module 05 route policy set by `routeMeta()` (state guard allow-list, `noSupportAccess`). */
      routePolicy?: StatePolicy;
      /** Raw body of webhook requests (`/api/v1/webhooks/*`), kept for signature checks. */
      rawBody?: Buffer;
    }
  }
}
export {};
