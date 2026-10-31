import type { RequestContext } from './context';

declare global {
  namespace Express {
    interface Request {
      /** Per-request context. Starts with the request id; modules 02 to 04 add user, session, society and permissions. */
      ctx: RequestContext;
      /** Parsed and validated input. Controllers read only these. */
      valid: { body: any; query: any; params: any };
    }
  }
}
export {};
