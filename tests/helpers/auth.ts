import request from 'supertest';
import { createApp } from '../../src/app';
import { sequelize, User, UserRecoveryCode } from '../../src/models';
import { setNow } from '../../src/lib/clock';
import { clearInbox, listInbox, type InboxMessage } from '../../src/lib/inbox';
import { configureMemoryQueue, resetQueueState } from '../../src/lib/queue';
import { setRealtimeSink, type RealtimeEvent } from '../../src/lib/realtime';
import { resetRateLimits } from '../../src/middlewares/rateLimit.middleware';
import { setAuthPorts } from '../../src/modules/auth/auth.ports';
import { setAccessPorts } from '../../src/modules/access-control/access-control.ports';
import { flushAcl } from '../../src/modules/access-control/access-control.cache';
import { setMinResponseMs } from '../../src/modules/auth/auth.util';
import {
  encryptSecret,
  hashPassword,
  newTotpSecret,
  totpCode,
  totpStepAt,
  newRecoveryCode,
  hashRecoveryCode,
  newUlid,
} from '../../src/modules/auth/auth.crypto';
import { resetSystemUserCache } from '../../src/modules/auth/auth.users';
import { now } from '../../src/lib/clock';
import '../../src/modules/auth/auth.templates';

export const app = createApp();

export const ORIGINS = {
  PLATFORM: 'https://platform.societyapp.in',
  ADMIN: 'https://admin.societyapp.in',
  RESIDENT: 'https://my.societyapp.in',
  GATE: 'https://gate.societyapp.in',
  WORK: 'https://work.societyapp.in',
} as const;
export type App = keyof typeof ORIGINS;

export const PASSWORD = 'Demo@Society2026';
export const events: RealtimeEvent[] = [];
export const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36';

/** Resets every piece of state a test can touch. Call from `beforeEach`. */
export async function resetAll(): Promise<void> {
  setNow(null);
  setMinResponseMs(0);
  configureMemoryQueue({ backoffMs: 0 });
  resetQueueState();
  setAuthPorts();
  setAccessPorts();
  events.length = 0;
  setRealtimeSink({
    emit: e => events.push(e),
    disconnectSession: sessionId =>
      events.push({ room: 'socket', event: 'disconnect', payload: { sessionId } }),
  });
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of [
    'usage_counters',
    'feature_flag_overrides',
    'entitlement_overrides',
    'subscription_addons',
    'subscriptions',
    'idempotency_keys',
    'member_grants',
    'society_members',
    'invitations',
    'role_permissions',
    'roles',
    'societies',
    'organizations',
    'auth_lockouts',
    'user_recovery_codes',
    'user_passkeys',
    'auth_tokens',
    'auth_otps',
    'sessions',
    'users',
    'audit_logs',
  ])
    await sequelize.query(`DELETE FROM ${t}`);
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  resetSystemUserCache();
  await resetRateLimits();
  await flushAcl();
  await clearInbox();
}

export interface TestUser {
  id: number;
  mobile: string;
  email: string | null;
  totpSecret: string | null;
  recoveryCodes: string[];
}

/** Module 03 added the foreign key users.platformRoleId -> roles.id: older tests need real platform role rows for the ids they use. */
export async function ensurePlatformRoles(ids: number[]): Promise<void> {
  for (const id of ids)
    await sequelize.query(
      `INSERT IGNORE INTO roles (id, societyId, scope, \`key\`, name, isSystem, requiresMfa, consumesSeat, version, createdAt, updatedAt)
       VALUES (:id, NULL, 'platform', :key, :name, 1, 1, 0, 1, NOW(3), NOW(3))`,
      { replacements: { id, key: `test_platform_${id}`, name: `Test platform ${id}` } },
    );
}

let counter = 0;
export async function makeUser(
  o: {
    mobile?: string;
    email?: string | null;
    name?: string | null;
    status?: string;
    password?: string | null;
    mfa?: boolean;
    platformRoleId?: number | null;
    emailVerified?: boolean;
  } = {},
): Promise<TestUser> {
  counter += 1;
  const mobile = o.mobile ?? `98${String(10000000 + counter).padStart(8, '0')}`;
  const email = o.email === undefined ? `user${counter}@example.in` : o.email;
  const secret = o.mfa ? newTotpSecret() : null;
  const t = now();
  if (o.platformRoleId) await ensurePlatformRoles([o.platformRoleId]);
  const u = await User.create({
    mobile,
    email,
    emailVerifiedAt: email && o.emailVerified !== false ? t : null,
    mobileVerifiedAt: t,
    name: o.name === undefined ? 'Test User' : o.name,
    status: (o.status ?? 'ACTIVE') as never,
    passwordHash: o.password === null ? null : await hashPassword(o.password ?? PASSWORD),
    passwordChangedAt: t,
    totpSecretEnc: secret ? encryptSecret(secret) : null,
    mfaEnabledAt: secret ? t : null,
    platformRoleId: o.platformRoleId ?? null,
    deletionScheduledFor: o.status === 'PENDING_DELETION' ? new Date(t.getTime() + 30 * 86_400_000) : null,
  } as never);
  const recoveryCodes: string[] = [];
  if (secret) {
    const batch = newUlid(t.getTime());
    for (let i = 0; i < 3; i++) {
      const c = newRecoveryCode();
      recoveryCodes.push(c);
      await UserRecoveryCode.create({
        userId: u.id!,
        batchId: batch,
        codeHash: hashRecoveryCode(u.id!, c),
        usedAt: null,
        usedSessionId: null,
      });
    }
  }
  return { id: u.id!, mobile, email, totpSecret: secret, recoveryCodes };
}

export type Cookies = Record<string, string>;

export function cookiesFrom(res: request.Response, into: Cookies = {}): Cookies {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  for (const line of raw ?? []) {
    const [pair, ...attrs] = line.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const cleared = attrs.some(a => /max-age=0/i.test(a)) || value === '';
    if (cleared) delete into[name];
    else into[name] = value;
  }
  return into;
}

export const cookieHeader = (c: Cookies): string =>
  Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
export interface CallOpts {
  app?: App;
  cookies?: Cookies;
  csrf?: boolean | string;
  origin?: string | null;
  headers?: Record<string, string>;
  ip?: string;
  query?: Record<string, string>;
}

export function call(method: Method, path: string, body?: unknown, o: CallOpts = {}): request.Test {
  const appName = o.app ?? 'ADMIN';
  let r = request(app)[method](`/api/v1${path}`).set('User-Agent', UA);
  const origin = o.origin === undefined ? ORIGINS[appName] : o.origin;
  if (origin) r = r.set('Origin', origin);
  if (o.cookies && Object.keys(o.cookies).length) r = r.set('Cookie', cookieHeader(o.cookies));
  const csrf = o.csrf === undefined ? true : o.csrf;
  if (csrf && o.cookies?.sa_csrf)
    r = r.set('X-CSRF-Token', typeof csrf === 'string' ? csrf : o.cookies.sa_csrf);
  if (o.ip) r = r.set('X-Forwarded-For', o.ip);
  for (const [k, v] of Object.entries(o.headers ?? {})) r = r.set(k, v);
  if (o.query) r = r.query(o.query);
  if (body !== undefined && method !== 'get') r = r.send(body as object);
  return r;
}
export const post = (path: string, body: unknown, o?: CallOpts) => call('post', path, body, o);
export const get = (path: string, o?: CallOpts) => call('get', path, undefined, o);

/** Latest SMS code sent to a mobile, read from the dev inbox. */
export async function lastOtp(mobile: string): Promise<string> {
  const m = (await listInbox()).find(x => x.channel === 'SMS' && x.to === mobile);
  const code = m?.body.match(/^(\d{6}) is your/)?.[1];
  if (!code) throw new Error(`no OTP for ${mobile}`);
  return code;
}
export const inboxFor = async (to: string): Promise<InboxMessage[]> =>
  (await listInbox()).filter(m => m.to === to);

export async function sendOtp(mobile: string, o: CallOpts = {}) {
  return post('/auth/otp/send', { mobile }, o);
}

/** OTP send and verify; returns the verify response and the cookies it set. */
export async function otpSignIn(
  mobile: string,
  o: CallOpts = {},
): Promise<{ res: request.Response; cookies: Cookies }> {
  const s = await sendOtp(mobile, o);
  if (s.status !== 202) throw new Error(`send failed ${s.status} ${JSON.stringify(s.body)}`);
  const code = await lastOtp(mobile);
  const res = await post('/auth/otp/verify', { challengeId: s.body.data.challengeId, code }, o);
  return { res, cookies: cookiesFrom(res, { ...(o.cookies ?? {}) }) };
}

export const totpNow = (secret: string, stepOffset = 0): string =>
  totpCode(secret, totpStepAt(now().getTime()) + stepOffset);

/** Full sign-in for a user who may have MFA on: OTP, then TOTP when asked. */
export async function fullSignIn(u: TestUser, appName: App = 'ADMIN'): Promise<Cookies> {
  const o = { app: appName };
  const { res, cookies } = await otpSignIn(u.mobile, o);
  if (res.body.data?.status === 'SIGNED_IN') return cookies;
  if (res.body.data?.status !== 'MFA_REQUIRED') throw new Error(`unexpected ${JSON.stringify(res.body)}`);
  const v = await post(
    '/auth/mfa/verify',
    { challengeToken: res.body.data.challengeToken, method: 'TOTP', code: totpNow(u.totpSecret!) },
    { ...o, cookies },
  );
  if (v.status !== 200) throw new Error(`mfa failed ${JSON.stringify(v.body)}`);
  return cookiesFrom(v, cookies);
}

export const noMembershipsFor = () => undefined;
