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

/**
 * The single sign-in address: an app origin whose first host label is not a role label ("app.societyapp.in", "localhost").
 * Everyone signs in there and the app is chosen after sign-in from what the person may open (see `auth.signin.ts`).
 */
export function isUnifiedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (!env().appOrigins.includes(o.origin)) return false;
  return !Object.prototype.hasOwnProperty.call(PREFIX_TO_APP, o.hostname.split('.')[0]!);
}

/** The first configured single sign-in address, if any. */
const unifiedOrigin = (): string | undefined => env().appOrigins.find(x => isUnifiedOrigin(x));

/** Host of an app (or of the single sign-in address when no app is known yet), for the text of messages. */
export const appHost = (app?: ClientApp): string => {
  const o = (app ? env().appOrigins.find(x => appForOrigin(x) === app) : undefined) ?? unifiedOrigin();
  return o ? new URL(o).host : 'societyapp.in';
};

/** Absolute URL for links in emails: the app's own host when one is configured, else the single sign-in address. */
export const appUrl = (app: ClientApp | undefined, path: string): string => {
  const o = (app ? env().appOrigins.find(x => appForOrigin(x) === app) : undefined) ?? unifiedOrigin();
  return `${o ?? 'https://societyapp.in'}${path}`;
};

export const requireApp = (app: ClientApp | undefined): ClientApp => {
  if (!app) throw new AppError(403, 'CSRF_FAILED', 'Request origin is not allowed');
  return app;
};

/**
 * For sign-in steps that run before a session exists: the app of a per-role host, or `undefined` on the single sign-in address
 * (the app is chosen later). Any other origin is refused.
 */
export const requireAppOrUnified = (ctx: {
  clientApp?: ClientApp;
  unified?: boolean;
}): ClientApp | undefined => {
  if (ctx.clientApp) return ctx.clientApp;
  if (ctx.unified) return undefined;
  throw new AppError(403, 'CSRF_FAILED', 'Request origin is not allowed');
};

/** `app` is `undefined` on the single sign-in address, where the rule is applied per app after the first factor. */
export function assertMethod(app: ClientApp | undefined, method: 'otp' | 'password' | 'passkey'): void {
  if (app && !APP_RULES[app][method])
    throw new AppError(400, 'LOGIN_METHOD_NOT_ALLOWED', 'This sign-in method is not available here');
}
