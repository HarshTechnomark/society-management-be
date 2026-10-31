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
  const here: AccessTag[] = [...inherited];
  for (const layer of stack) {
    if (layer.route) {
      const route = layer.route;
      const tags = [...here, ...route.stack.map((l: any) => tagOf(l.handle)).filter(Boolean)] as AccessTag[];
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
        });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, prefix + mountPrefix(layer), here, out);
    } else {
      const t = tagOf(layer.handle);
      if (t) here.push(t);
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
