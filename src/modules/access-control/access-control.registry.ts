import type { Express, RequestHandler } from 'express';

/**
 * Route metadata (section 8.21). Markers (`societyMiddleware`, `platformMiddleware`, `requirePermission`,
 * `requirePlatformPermission`, `publicRoute`, `authenticatedOnly`, `idempotency`, `stepUp`) tag the handler they return.
 * `listRoutes(app)` walks the Express stack and returns one entry per registered route with the tags of the handlers on it
 * (and of the middleware mounted above it). The permission matrix, tenant isolation and route-registry tests read it.
 */
export interface AccessTag {
  kind?: 'society' | 'platform' | 'public' | 'auth';
  permissions?: string[];
  stepUp?: boolean;
  idempotent?: boolean;
  allowWhenClosed?: boolean;
  allowWhenSuspended?: boolean;
  /** Society route open to any active member (no permission key), e.g. `GET /subscription/entitlements`. */
  memberOnly?: boolean;
  /** Module 04 `requireFeature` keys on the route. */
  features?: string[];
}

const TAG = Symbol.for('societyapp.access');

export function tag<T extends RequestHandler>(handler: T, t: AccessTag): T {
  (handler as any)[TAG] = t;
  return handler;
}
export const tagOf = (h: unknown): AccessTag | undefined => (h as any)?.[TAG];

export interface RouteMeta {
  method: string;
  /** Path relative to `/api/v1`, with `:param` placeholders. */
  path: string;
  kind: 'society' | 'platform' | 'public' | 'auth' | 'unmarked';
  permissions: string[];
  stepUp: boolean;
  idempotent: boolean;
  allowWhenClosed: boolean;
  allowWhenSuspended: boolean;
  memberOnly: boolean;
  features: string[];
}

function mountPrefix(layer: any): string {
  if (layer.regexp?.fast_slash) return '';
  const m = layer.regexp
    ?.toString()
    .replace('\\/?', '')
    .replace('(?=\\/|$)', '$')
    .match(/^\/\^((?:\\[.*+?^${}()|[\]\\/]|[^.*+?^${}()|[\]\\/])*)\$\//);
  if (!m) return '<complex>';
  return m[1]!.replace(/\\(.)/g, '$1');
}

function walk(stack: any[], prefix: string, inherited: AccessTag[], out: RouteMeta[]): void {
  // tags of middleware mounted for the whole stack (`router.use(mw)`), and of middleware mounted on one path
  const global: AccessTag[] = [...inherited];
  const scoped: { mount: string; tag: AccessTag }[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const route = layer.route;
      const tags = [
        ...global,
        ...route.stack.map((l: any) => tagOf(l.handle)).filter(Boolean),
      ] as AccessTag[];
      for (const method of Object.keys(route.methods)) {
        if (method === '_all') continue;
        const kinds = tags.map(t => t.kind).filter((k): k is NonNullable<AccessTag['kind']> => Boolean(k));
        const kind = kinds.includes('public')
          ? 'public'
          : kinds.includes('platform')
            ? 'platform'
            : kinds.includes('society')
              ? 'society'
              : kinds.includes('auth')
                ? 'auth'
                : 'unmarked';
        out.push({
          method: method.toUpperCase(),
          path: prefix + (route.path === '/' ? '' : String(route.path)) || '/',
          kind,
          permissions: [...new Set(tags.flatMap(t => t.permissions ?? []))],
          stepUp: tags.some(t => t.stepUp),
          idempotent: tags.some(t => t.idempotent),
          allowWhenClosed: tags.some(t => t.allowWhenClosed),
          allowWhenSuspended: tags.some(t => t.allowWhenSuspended),
          memberOnly: tags.some(t => t.memberOnly),
          features: [...new Set(tags.flatMap(t => t.features ?? []))],
        });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const mount = mountPrefix(layer);
      walk(
        layer.handle.stack,
        prefix + mount,
        [...global, ...scoped.filter(x => x.mount === mount).map(x => x.tag)],
        out,
      );
    } else {
      const t = tagOf(layer.handle);
      if (!t) continue;
      const mount = mountPrefix(layer);
      if (mount === '') global.push(t);
      else scoped.push({ mount, tag: t });
    }
  }
}

/** Every route of the app under `/api/v1`, relative to it. */
export function listRoutes(app: Express): RouteMeta[] {
  const out: RouteMeta[] = [];
  const root: any[] = (app as any)._router.stack;
  for (const layer of root) {
    if (layer.name === 'router' && layer.handle?.stack && mountPrefix(layer) === '/api/v1')
      walk(layer.handle.stack, '', [], out);
  }
  return out;
}

/**
 * Routes that break the deny-by-default rule (section 13): no marker, a society route without a permission, or a platform
 * route without a platform permission. Routes listed as public (`public.routes.ts`) need no marker.
 */
export function routeProblems(
  routes: RouteMeta[],
  isPublic: (method: string, path: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const r of routes) {
    const id = `${r.method} ${r.path}`;
    if (r.kind === 'unmarked' && !isPublic(r.method, r.path)) out.push(`${id}: no marker`);
    if ((r.kind === 'society' || r.kind === 'platform') && r.permissions.length === 0 && !r.memberOnly)
      out.push(`${id}: ${r.kind} route without a permission`);
  }
  return out;
}
