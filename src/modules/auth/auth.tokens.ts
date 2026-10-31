import type { CookieOptions, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../../lib/env';
import { nowMs } from '../../lib/clock';
import { csrfTokenFor } from './auth.crypto';
import { ACCESS_TTL_SECONDS, DEVICE_COOKIE_MAX_AGE, type ClientApp } from './auth.types';

export interface AccessClaims {
  sub: string;
  sid: string;
  app: ClientApp;
  typ: 'access';
  iat: number;
  exp: number;
}

/** BR-02-31: HS256, 900 seconds, no roles or permissions in the token. */
export function signAccessToken(userId: number, sessionId: number, app: ClientApp): string {
  const iat = Math.floor(nowMs() / 1000);
  const claims: AccessClaims = {
    sub: String(userId),
    sid: String(sessionId),
    app,
    typ: 'access',
    iat,
    exp: iat + ACCESS_TTL_SECONDS,
  };
  return jwt.sign(claims, env().JWT_ACCESS_SECRET, { algorithm: 'HS256' });
}

/** Returns the claims, or null for any invalid, expired or wrong-shape token (BR-02-31). */
export function verifyAccessToken(
  token: string,
  expectedApp: ClientApp | undefined,
  opts: { ignoreExpiration?: boolean } = {},
): AccessClaims | null {
  try {
    const c = jwt.verify(token, env().JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      clockTimestamp: Math.floor(nowMs() / 1000),
      ignoreExpiration: opts.ignoreExpiration ?? false,
    }) as Partial<AccessClaims>;
    if (c.typ !== 'access' || !c.sub || !c.sid || !c.app) return null;
    if (expectedApp !== undefined && c.app !== expectedApp) return null;
    if (!/^\d+$/.test(c.sub) || !/^\d+$/.test(c.sid)) return null;
    return c as AccessClaims;
  } catch {
    return null;
  }
}

export const COOKIES = {
  access: 'sa_access',
  refresh: 'sa_refresh',
  csrf: 'sa_csrf',
  device: 'sa_device',
} as const;

const base = (): CookieOptions => ({ secure: env().COOKIE_SECURE, path: '/' });

export interface SessionCookies {
  accessToken: string;
  refreshToken: string;
  sessionId: number;
  absoluteExpiresAt: Date;
  /** Set when the browser has no `sa_device` cookie yet. */
  newDeviceId?: string;
}

/** BR-02-34. No `Domain` attribute, so every host keeps its own session. */
export function setSessionCookies(res: Pick<Response, 'cookie'>, c: SessionCookies): void {
  const maxAgeMs = Math.max(0, c.absoluteExpiresAt.getTime() - nowMs());
  res.cookie(COOKIES.access, c.accessToken, {
    ...base(),
    httpOnly: true,
    sameSite: 'lax',
    maxAge: ACCESS_TTL_SECONDS * 1000,
  });
  res.cookie(COOKIES.refresh, c.refreshToken, {
    ...base(),
    httpOnly: true,
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: maxAgeMs,
  });
  res.cookie(COOKIES.csrf, csrfTokenFor(c.sessionId), {
    ...base(),
    httpOnly: false,
    sameSite: 'strict',
    maxAge: maxAgeMs,
  });
  if (c.newDeviceId)
    res.cookie(COOKIES.device, c.newDeviceId, {
      ...base(),
      httpOnly: true,
      sameSite: 'lax',
      maxAge: DEVICE_COOKIE_MAX_AGE * 1000,
    });
}

/** Logout clears the four cookies except `sa_device`. */
export function clearSessionCookies(res: Pick<Response, 'clearCookie'>): void {
  res.clearCookie(COOKIES.access, { ...base(), httpOnly: true, sameSite: 'lax' });
  res.clearCookie(COOKIES.refresh, { ...base(), httpOnly: true, sameSite: 'strict', path: '/api/v1/auth' });
  res.clearCookie(COOKIES.csrf, { ...base(), sameSite: 'strict' });
}

/** "Chrome on Android" style label from a user agent (section 7.3 `deviceLabel`). */
export function deviceLabelFor(ua: string): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iOS/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? 'Unknown device';
}
