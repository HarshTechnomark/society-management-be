import type { RequestHandler } from 'express';
import { AppError, ForbiddenError } from '../../utils/errors';
import { tag } from '../access-control/access-control.registry';
import { keysOfScope } from '../access-control/access-control.permissions';
import type { JobTag, SocietyStatus, StatePolicy, SupportScope } from './societies.types';

/**
 * Pure policy functions of module 05 used by the request pipeline (module 03 `societyMiddleware`) and by jobs.
 * No database access here, so the middleware can import this file without pulling in the module.
 */

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const isWrite = (method: string): boolean => !READS.has(method.toUpperCase());

/**
 * `routeMeta({ suspended: 'allow', closed: 'allow', noSupportAccess: true })` (6.2.1, 6.4). Put it **before**
 * `societyMiddleware()` on the route; it records the policy on `req.routePolicy` and tags the route for the registry.
 * Without it a society route has the default policy `{ suspended: 'block-writes', closed: 'block' }`.
 */
export const routeMeta = (policy: StatePolicy): RequestHandler =>
  tag(
    (req, _res, next) => {
      req.routePolicy = { ...(req.routePolicy ?? {}), ...policy };
      next();
    },
    {
      allowWhenSuspended: policy.suspended === 'allow' || undefined,
      allowWhenClosed: policy.closed === 'allow' || undefined,
      noSupportAccess: policy.noSupportAccess || undefined,
    },
  );

export const lockedSuspended = () =>
  new AppError(423, 'SOCIETY_SUSPENDED', 'This society is suspended. You can only view it.');
export const lockedClosed = () => new AppError(423, 'SOCIETY_CLOSED', 'This society is closed');

/**
 * BR-05-11: `423 SOCIETY_CLOSED` for every society-context call while CLOSED and `423 SOCIETY_SUSPENDED` for writes
 * while SUSPENDED, unless the route policy allows it. Returns the error (or null) instead of throwing so the middleware
 * can pass it on.
 */
export function societyStateGuard(input: {
  status: SocietyStatus | string;
  method: string;
  policy?: StatePolicy;
}): AppError | null {
  const p = input.policy ?? {};
  if (input.status === 'CLOSED' && p.closed !== 'allow') return lockedClosed();
  if (input.status === 'SUSPENDED' && isWrite(input.method) && p.suspended !== 'allow')
    return lockedSuspended();
  return null;
}

/** BR-05-14: which tagged society jobs run in each status. */
export function isJobAllowed(status: SocietyStatus | string, jobTag: JobTag): boolean {
  if (status === 'SUSPENDED')
    return ['safety', 'payments', 'export', 'support', 'lifecycle', 'health'].includes(jobTag);
  if (status === 'CLOSED') return ['export', 'lifecycle', 'payments'].includes(jobTag);
  return true;
}

/** 6.4 checks for a request made under a support grant (BR-05-30). */
export function supportRequestGuard(input: {
  scope: SupportScope;
  method: string;
  policy?: StatePolicy;
}): AppError | null {
  if (input.policy?.noSupportAccess)
    return new ForbiddenError('SUPPORT_ROUTE_FORBIDDEN', 'This page is not available during support access');
  if (input.scope === 'READ_ONLY' && isWrite(input.method))
    return new ForbiddenError(
      'SUPPORT_SCOPE_READ_ONLY',
      'This support access is read only. Writes are blocked.',
    );
  return null;
}

/** 6.4 deny list (prefix `*` matches every action). */
export const SUPPORT_DENY = [
  'residents.contacts.view',
  'settings.roles.*',
  'settings.members.*',
  'settings.support_access.*',
  'settings.data_export.*',
  'settings.subscription.edit',
  'settings.integrations.edit',
  'communication.emergency.create',
] as const;

const denied = (key: string): boolean =>
  SUPPORT_DENY.some(d => (d.endsWith('.*') ? key.startsWith(d.slice(0, -1)) : key === d));

/**
 * 6.4 derived permissions: READ_ONLY = every society-scope `view` key, READ_WRITE adds `create` and `edit`; never
 * `approve`, `delete`, `import`, `export` and never resident, gate or work scopes; minus `SUPPORT_DENY`. Computed from
 * the catalogue on each call and never stored.
 */
export function derivedSupportPermissions(scope: SupportScope): string[] {
  const actions = scope === 'READ_ONLY' ? ['view'] : ['view', 'create', 'edit'];
  return keysOfScope('society')
    .filter(k => actions.includes(k.slice(k.lastIndexOf('.') + 1)) && !denied(k))
    .sort();
}
