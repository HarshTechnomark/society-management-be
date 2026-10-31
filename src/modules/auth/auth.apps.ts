import { env } from '../../lib/env';
import { AppError } from '../../utils/errors';
import type { ClientApp } from './auth.types';
import { APP_RULES } from './auth.types';

const PREFIX_TO_APP: Record<string, ClientApp> = {
  platform: 'PLATFORM',
  admin: 'ADMIN',
  my: 'RESIDENT',
  gate: 'GATE',
  work: 'WORK',
};

/** Origin (scheme and host, no path) to app, from APP_ORIGINS by the first host label (BR-02-43). */
export function appForOrigin(origin: string | undefined): ClientApp | undefined {
  if (!origin) return undefined;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return undefined;
  }
  if (!env().appOrigins.includes(o.origin)) return undefined;
  return PREFIX_TO_APP[o.hostname.split('.')[0]];
}

export const originOf = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

export const appHost = (app: ClientApp): string => {
  const o = env().appOrigins.find(x => appForOrigin(x) === app);
  return o ? new URL(o).host : 'societyapp.in';
};

/** Absolute URL on the host of an app, for links in emails. */
export const appUrl = (app: ClientApp, path: string): string => {
  const o = env().appOrigins.find(x => appForOrigin(x) === app);
  return `${o ?? 'https://societyapp.in'}${path}`;
};

export const requireApp = (app: ClientApp | undefined): ClientApp => {
  if (!app) throw new AppError(403, 'CSRF_FAILED', 'Request origin is not allowed');
  return app;
};

export function assertMethod(app: ClientApp, method: 'otp' | 'password' | 'passkey'): void {
  if (!APP_RULES[app][method])
    throw new AppError(400, 'LOGIN_METHOD_NOT_ALLOWED', 'This sign-in method is not available here');
}
