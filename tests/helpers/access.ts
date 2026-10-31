import { randomUUID } from 'node:crypto';
import { Role, Society, SocietyMember, User, sequelize } from '../../src/models';
import { now } from '../../src/lib/clock';
import { joinMember } from '../../src/modules/access-control/access-control.members.service';
import {
  provisionSocietyRoles,
  registerAccessControl,
  syncCatalogue,
} from '../../src/modules/access-control/access-control.public';
import { setAccessPorts, usageLimitExceeded } from '../../src/modules/access-control/access-control.ports';
import { systemCtx } from '../../src/types/context';
import { call, fullSignIn, makeUser, resetAll, type CallOpts, type Cookies, type TestUser } from './auth';

/** Fresh database state plus the permission catalogue, platform roles and the real `authAccess` port. */
export async function resetAccess(): Promise<void> {
  await resetAll();
  registerAccessControl();
  await syncCatalogue();
}

let slugCounter = 0;
export async function makeSociety(
  name = 'Sky Heights CHS',
  o: { status?: 'TRIAL' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED' | 'PAST_DUE' } = {},
): Promise<Society> {
  slugCounter += 1;
  const s = await Society.create({
    slug: `soc-${slugCounter}-${Date.now() % 100000}`,
    name,
    city: 'Pune',
    state: 'Maharashtra',
    pincode: '411045',
    addressLine1: 'Baner Road',
    status: o.status ?? 'ACTIVE',
  } as never);
  await sequelize.transaction(tx => provisionSocietyRoles(s.id!, tx));
  return s;
}

export async function roleOf(societyId: number | null, key: string): Promise<Role> {
  const r = await Role.findOne({ where: { societyId, key } });
  if (!r) throw new Error(`no role ${key}`);
  return r;
}

export async function join(
  society: Society,
  user: { id: number },
  roleKey: string,
  label: string | null = null,
): Promise<SocietyMember> {
  return sequelize.transaction(async tx => {
    const role = await roleOf(society.id!, roleKey);
    return (
      await joinMember(
        systemCtx('test'),
        { societyId: society.id!, userId: user.id, role, locationLabel: label },
        tx,
      )
    ).member;
  });
}

/** A user who is an ACTIVE member with the role. `mfa` follows the role by default so sign-in works. */
export async function memberUser(
  society: Society,
  roleKey: string,
  o: { name?: string; mfa?: boolean; mobile?: string } = {},
): Promise<TestUser & { memberId: number }> {
  const mfaRoles = ['chairman', 'secretary', 'treasurer', 'society_admin', 'accountant'];
  const u = await makeUser({
    name: o.name ?? roleKey,
    mfa: o.mfa ?? mfaRoles.includes(roleKey),
    mobile: o.mobile,
  });
  const m = await join(society, u, roleKey);
  return { ...u, memberId: m.id! };
}

const cache = new Map<string, Cookies>();
export const resetLogins = (): void => cache.clear();

/** Signs in once per user and app per test (a TOTP step cannot be used twice). Picks the society when asked. */
export async function login(
  u: TestUser,
  o: { app?: 'ADMIN' | 'PLATFORM' | 'RESIDENT' | 'GATE' | 'WORK'; societyId?: number } = {},
): Promise<Cookies> {
  const app = o.app ?? 'ADMIN';
  const key = `${u.id}:${app}:${o.societyId ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const cookies = await fullSignIn(u, app);
  if (o.societyId) {
    const r = await call('post', '/auth/switch-society', { societyId: o.societyId }, { app, cookies });
    if (r.status !== 200) throw new Error(`switch failed ${JSON.stringify(r.body)}`);
  }
  cache.set(key, cookies);
  return cookies;
}

export const idem = (): Record<string, string> => ({ 'Idempotency-Key': randomUUID() });

type M = 'get' | 'post' | 'patch' | 'delete';
/** Authenticated call with the cookies of a signed-in user. */
export const as =
  (cookies: Cookies, app: CallOpts['app'] = 'ADMIN') =>
  (method: M, path: string, body?: unknown, o: CallOpts = {}) =>
    call(method, path, body, { app, cookies, ...o });

export async function userByMobile(mobile: string): Promise<User> {
  return (await User.findOne({ where: { mobile } }))!;
}

export const fakeEntitlements = (limits: { 'limit.custom_roles'?: number; 'limit.admin_seats'?: number }) => {
  const used: Record<string, number> = { 'limit.custom_roles': 0, 'limit.admin_seats': 0 };
  setAccessPorts({
    entitlements: {
      consumeLimit: async (_c, key, n) => {
        const lim = limits[key];
        if (lim !== undefined && used[key]! + n > lim) {
          throw usageLimitExceeded(key);
        }
        used[key]! += n;
      },
      releaseLimit: async (_c, key, n) => {
        used[key]! -= n;
      },
      getLimit: async (_s, key) => ({ limit: limits[key] ?? null, used: used[key]! }),
    },
  });
  return used;
};

export { now };
