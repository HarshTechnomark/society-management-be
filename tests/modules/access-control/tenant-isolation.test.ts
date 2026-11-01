import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MemberGrant, Permission, SocietyMember, closeDb } from '../../../src/models';
import { nowMs, setNow } from '../../../src/lib/clock';
import { setKv, type KvStore, MemoryKv } from '../../../src/lib/kv';
import { setAccessPorts } from '../../../src/modules/access-control/access-control.ports';
import { setAuthPorts } from '../../../src/modules/auth/auth.ports';
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';
import { supportPermissions } from '../../../src/modules/access-control/access-control.access';
import { listRoutes } from '../../../src/modules/access-control/access-control.registry';
import { app, call, cookiesFrom } from '../../helpers/auth';
import {
  as,
  idem,
  join,
  login,
  makeSociety,
  memberUser,
  platformLogin,
  platformUser,
  resetAccess,
  resetLogins,
  roleOf,
} from '../../helpers/access';
import { createInvitationCore } from '../../../src/modules/access-control/access-control.invitations.service';
import { sequelize } from '../../../src/models';
import { systemCtx } from '../../../src/types/context';

afterAll(closeDb);
beforeEach(async () => {
  await resetAccess();
  resetLogins();
  setKv(undefined);
  setNow('2026-11-01T04:30:00Z');
});

async function two() {
  const a = await makeSociety('Sky Heights CHS');
  const b = await makeSociety('Green Park CHS');
  const chairA = await memberUser(a, 'chairman', { name: 'Chair A' });
  await memberUser(b, 'chairman', { name: 'Chair B' });
  const fmB = await memberUser(b, 'facility_manager', { name: 'FM B' });
  const roleB = await roleOf(b.id!, 'treasurer');
  const inv = await sequelize.transaction(t =>
    createInvitationCore(
      systemCtx('t'),
      { societyId: b.id!, name: 'Pending B', mobile: '9820055577', roleKey: 'committee_member' },
      t,
    ),
  );
  const perm = (await Permission.findOne({ where: { key: 'finance.bank.import' } }))!;
  const grant = await MemberGrant.create({
    societyId: b.id!,
    memberId: fmB.memberId,
    permissionId: perm.id!,
    effect: 'ALLOW',
    source: 'ADMIN',
    status: 'ACTIVE',
    startsAt: new Date(),
    endsAt: new Date(Date.now() + 86_400_000),
    reason: 'test grant',
    grantedBy: fmB.id,
    expiryReminderSentAt: null,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    unitId: null,
    createdBy: null,
    updatedBy: null,
  } as never);
  return {
    a,
    b,
    chairA,
    c: as(await login(chairA)),
    roleB,
    memberB: fmB.memberId,
    invB: inv.invitation.id!,
    grantB: grant.id!,
  };
}

describe('tenant isolation (T03-33, section 13)', () => {
  it("society A's chairman gets 404 with the entity code for every id of society B", async () => {
    const { c, roleB, memberB, invB, grantB } = await two();
    const cases: [string, string, unknown, string][] = [
      ['get', `/roles/${roleB.id}`, undefined, 'ROLE_NOT_FOUND'],
      ['patch', `/roles/${roleB.id}`, { version: 1, description: 'x' }, 'ROLE_NOT_FOUND'],
      ['post', `/roles/${roleB.id}/reset`, { version: 1, reason: 'Resetting it' }, 'ROLE_NOT_FOUND'],
      ['delete', `/roles/${roleB.id}`, { version: 1, reason: 'Deleting it' }, 'ROLE_NOT_FOUND'],
      ['get', `/members/${memberB}`, undefined, 'MEMBER_NOT_FOUND'],
      ['patch', `/members/${memberB}`, { version: 1, locationLabel: 'X' }, 'MEMBER_NOT_FOUND'],
      ['post', `/members/${memberB}/suspend`, { version: 1, reason: 'Suspending it' }, 'MEMBER_NOT_FOUND'],
      ['post', `/members/${memberB}/reactivate`, { version: 1, reason: 'Reactivate it' }, 'MEMBER_NOT_FOUND'],
      ['delete', `/members/${memberB}`, { version: 1, reason: 'Ending it' }, 'MEMBER_NOT_FOUND'],
      ['post', `/members/${memberB}/reset-mfa`, { reason: 'Resetting it' }, 'MEMBER_NOT_FOUND'],
      ['post', `/members/${memberB}/revoke-sessions`, { reason: 'Revoking it' }, 'MEMBER_NOT_FOUND'],
      ['get', `/members/${memberB}/grants`, undefined, 'MEMBER_NOT_FOUND'],
      [
        'post',
        `/members/${memberB}/grants`,
        { permissionKey: 'finance.bank.edit', endsAt: '2026-11-03T00:00:00.000Z', reason: 'Granting it' },
        'MEMBER_NOT_FOUND',
      ],
      ['delete', `/members/${memberB}/grants/${grantB}`, { reason: 'Revoking it' }, 'MEMBER_NOT_FOUND'],
      ['post', `/invitations/${invB}/resend`, {}, 'INVITATION_NOT_FOUND'],
      ['post', `/invitations/${invB}/revoke`, { reason: 'Revoking it' }, 'INVITATION_NOT_FOUND'],
    ];
    for (const [m, path, body, code] of cases) {
      const r = await c(m as 'get', path, body, { headers: idem() });
      expect(r.status, `${m} ${path}`).toBe(404);
      expect(r.body.code, `${m} ${path}`).toBe(code);
    }
    // filters never leak another society's rows
    expect(
      (await c('get', '/members', undefined, { query: { roleId: String(roleB.id) } })).body.data,
    ).toEqual([]);
    expect((await c('get', '/invitations')).body.data).toEqual([]);
    expect(await SocietyMember.count({ where: { id: memberB, status: 'ACTIVE' } })).toBe(1);
    expect((await MemberGrant.findByPk(grantB))!.status).toBe('ACTIVE');
  });

  it('the generator covers every society and platform route that takes an id', () => {
    const covered = new Set([
      'GET /roles/:id',
      'PATCH /roles/:id',
      'POST /roles/:id/reset',
      'DELETE /roles/:id',
      'GET /members/:id',
      'PATCH /members/:id',
      'POST /members/:id/suspend',
      'POST /members/:id/reactivate',
      'DELETE /members/:id',
      'POST /members/:id/reset-mfa',
      'POST /members/:id/revoke-sessions',
      'GET /members/:id/grants',
      'POST /members/:id/grants',
      'DELETE /members/:id/grants/:grantId',
      'POST /invitations/:id/resend',
      'POST /invitations/:id/revoke',
      // household, token routes and platform routes are tested in grants.test.ts, invitations.test.ts and platform.test.ts
      'GET /me/household/:memberId/grants',
      'PATCH /me/household/:memberId/grants',
      'POST /invitations/:token/accept',
      'GET /public/invitations/:token',
      'POST /public/invitations/:token/decline',
      // module 04: another society's add-on purchase id is 404 (tests/modules/subscriptions/society-routes.test.ts, T04-30)
      'DELETE /subscription/addons/:subscriptionAddonId',
      'POST /subscription/addons/:subscriptionAddonId/resume',
    ]);
    const missing = listRoutes(app)
      .filter(r => (r.kind === 'society' || r.kind === 'platform') && /:[A-Za-z]+/.test(r.path))
      .filter(r => !r.path.startsWith('/platform/') && !covered.has(`${r.method} ${r.path}`))
      .map(r => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it('T03-34 one login, many societies: the active society decides the roles and the permissions', async () => {
    const sky = await makeSociety('Sky Heights CHS');
    const green = await makeSociety('Green Park CHS');
    const rajesh = await memberUser(sky, 'chairman', { name: 'Rajesh' });
    await join(green, rajesh, 'secretary');
    const skyRole = await roleOf(sky.id!, 'treasurer');
    const g = as(await login(rajesh, { societyId: green.id! }));
    const list = await g('get', '/roles', undefined, { query: { limit: '100' } });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data.every((r: any) => r.id !== skyRole.id)).toBe(true);
    expect(list.body.pagination.total).toBe(15);
    expect((await g('get', `/roles/${skyRole.id}`)).body.code).toBe('ROLE_NOT_FOUND');
    const me = await g('get', '/auth/me');
    expect(me.body.data.activeSocietyId).toBe(green.id);
    expect(me.body.data.permissions).toContain('finance.billing.approve');
    expect(me.body.data.permissions).not.toContain('finance.billing.create'); // the Secretary has V A only
    expect(me.body.data.memberships.map((m: any) => m.roleKey).sort()).toEqual(['chairman', 'secretary']);
  });

  it('no society selected is SOCIETY_NOT_SELECTED; a header cannot choose the society', async () => {
    const sky = await makeSociety('Sky Heights CHS');
    const green = await makeSociety('Green Park CHS');
    const rajesh = await memberUser(sky, 'chairman');
    await join(green, rajesh, 'secretary');
    const c = as(await login(rajesh));
    const r = await c('get', '/roles');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SOCIETY_NOT_SELECTED');
    const sneaky = await c('get', '/roles', undefined, {
      headers: { 'X-Society-Id': String(green.id) },
      query: { societyId: String(green.id) },
    });
    expect(sneaky.body.code).toBe('SOCIETY_NOT_SELECTED');
  });
});

describe('society status and support access (BR-03-17, BR-03-19)', () => {
  it('T03-40 a suspended society allows reads and blocks writes; a closed society blocks everything', async () => {
    const society = await makeSociety();
    const chair = await memberUser(society, 'chairman');
    const c = as(await login(chair));
    await sequelize.query('UPDATE societies SET status = "SUSPENDED" WHERE id = :id', {
      replacements: { id: society.id },
    });
    await flushAcl();
    expect((await c('get', '/roles')).status).toBe(200);
    const w = await c(
      'post',
      '/roles',
      { name: 'Blocked role', scope: 'society', permissionKeys: ['dashboard.today.view'] },
      { headers: idem() },
    );
    expect(w.status).toBe(423);
    expect(w.body.code).toBe('SOCIETY_SUSPENDED');
    await sequelize.query('UPDATE societies SET status = "CLOSED" WHERE id = :id', {
      replacements: { id: society.id },
    });
    await flushAcl();
    const closed = await c('get', '/roles');
    expect(closed.status).toBe(423);
    expect(closed.body.code).toBe('SOCIETY_CLOSED');
  });

  /** A real support hand-off: the platform user issues a token and redeems it on the admin host. */
  async function supportSession(
    grantScope: 'READ_ONLY' | 'READ_WRITE',
    grantSociety: number,
    activeSociety: number,
  ) {
    const sa = await platformUser('platform_support');
    const platformCookies = await platformLogin(sa);
    const endsAt = new Date(nowMs() + 3_600_000);
    setAuthPorts({
      supportAccess: {
        validateForHandoff: async (_u, grantId) => ({
          grantId,
          societyId: activeSociety,
          scope: grantScope,
          endsAt,
        }),
        markEntered: async () => undefined,
        isGrantActive: async () => true,
        getGrantSummary: async () => ({ id: 1, scope: grantScope, endsAt }),
      },
    });
    setAccessPorts({
      support: {
        getActiveGrant: async (_u, s) => (s === grantSociety ? { id: 1, scope: grantScope, endsAt } : null),
      },
    });
    const h = await as(platformCookies, 'PLATFORM')('post', '/auth/support-handoff', { grantId: 1 });
    expect(h.status, JSON.stringify(h.body)).toBe(201);
    const r = await call(
      'post',
      '/auth/support-handoff/redeem',
      { handoffToken: h.body.data.handoffToken },
      { app: 'ADMIN' },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return as(cookiesFrom(r), 'ADMIN');
  }

  it('T03-39 READ_ONLY support: members are readable and masked, writes are SUPPORT_GRANT_READ_ONLY', async () => {
    const society = await makeSociety();
    const chair = await memberUser(society, 'chairman');
    const s = await supportSession('READ_ONLY', society.id!, society.id!);
    const r = await s('get', '/members');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data[0].mobile).toMatch(/XXXXX/);
    expect(r.body.data[0].mobile).not.toBe(chair.mobile);
    const w = await s(
      'post',
      '/members/invite',
      { name: 'Some One', mobile: '9820011100', roleId: 1 },
      { headers: idem() },
    );
    expect(w.status).toBe(403);
    expect(w.body.code).toBe('SUPPORT_GRANT_READ_ONLY');
  });

  it('a support grant for society B gives nothing in society C; READ_WRITE has no approve, import, export or role edit', async () => {
    const b = await makeSociety('B CHS');
    const c = await makeSociety('C CHS');
    const s = await supportSession('READ_WRITE', b.id!, c.id!);
    const r = await s('get', '/members');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('NOT_A_MEMBER');
    const rw = await supportPermissions(b.id!, 'READ_WRITE');
    expect(rw).toContain('helpdesk.tickets.edit');
    for (const k of rw) expect(k, k).not.toMatch(/\.(approve|import|export)$/);
    expect(rw).toContain('settings.roles.view');
    expect(rw).not.toContain('settings.roles.edit');
    expect(rw).not.toContain('settings.members.create');
    expect(rw).not.toContain('settings.subscription.edit');
    const ro = await supportPermissions(b.id!, 'READ_ONLY');
    expect(ro.every(k => k.endsWith('.view'))).toBe(true);
    expect(ro).not.toContain('residents.contacts.view');
  });
});

describe('cache fail-safe (T03-41)', () => {
  it('answers from MySQL when the cache store is down', async () => {
    const society = await makeSociety();
    const chair = await memberUser(society, 'chairman');
    const c = as(await login(chair));
    const down: KvStore = new Proxy(new MemoryKv(), {
      get: (target, prop) =>
        typeof (target as any)[prop] === 'function' && String(prop).startsWith('cache')
          ? () => Promise.reject(new Error('redis down'))
          : (target as any)[prop].bind(target),
    });
    setKv(down);
    const r = await c('get', '/roles');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.pagination.total).toBe(15);
    const m = await c('get', '/members');
    expect(m.status).toBe(200);
    // a denial is still a denial
    const fm = await memberUser(society, 'facility_manager');
    setKv(undefined);
    const f = as(await login(fm));
    setKv(down);
    expect((await f('get', '/members/export')).status).toBe(403);
    // writes still invalidate without failing the request
    const write = await c(
      'post',
      '/roles',
      { name: 'Written while down', scope: 'society', permissionKeys: ['dashboard.today.view'] },
      { headers: idem() },
    );
    expect(write.status).toBe(201);
  });

  it('a change is visible on the very next request even though the member access is cached', async () => {
    const society = await makeSociety();
    const chair = await memberUser(society, 'chairman');
    const fm = await memberUser(society, 'facility_manager');
    const c = as(await login(chair));
    const f = as(await login(fm));
    expect((await f('get', '/roles')).status).toBe(200); // cached now
    const role = await roleOf(society.id!, 'facility_manager');
    const r = await c('patch', `/roles/${role.id}`, {
      version: 1,
      permissionKeys: ['dashboard.today.view'],
      reason: 'Remove the access',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await f('get', '/roles')).status).toBe(403);
  });
});
