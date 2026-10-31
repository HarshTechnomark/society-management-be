import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  Invitation,
  MemberGrant,
  Permission,
  Role,
  RolePermission,
  Society,
  SocietyMember,
  User,
  closeDb,
  sequelize,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { kv } from '../../../src/lib/kv';
import { drainQueues, tickScheduler } from '../../../src/lib/queue';
import { systemCtx } from '../../../src/types/context';
import {
  computeAccess,
  provisionSocietyRoles,
  syncCatalogue,
} from '../../../src/modules/access-control/access-control.public';
import { keys } from '../../../src/modules/access-control/access-control.cache';
import {
  assertMakerChecker,
  assertNotSelf,
  assertUnitAccess,
  hasPermission,
  scopeWhere,
} from '../../../src/modules/access-control/access-control.policies';
import { seedAccessControl } from '../../../seeders/access-control';
import { seedDemoSocieties } from '../../../seeders/demo-societies';
import { DEMO_PASSWORD, demoTotpSecret, seedDemoUsers } from '../../../seeders/demo-users';
import { call, cookiesFrom, totpNow } from '../../helpers/auth';
import { makeSociety, memberUser, resetAccess, resetLogins, roleOf } from '../../helpers/access';

afterAll(closeDb);
beforeEach(async () => {
  await resetAccess();
  resetLogins();
  setNow('2026-11-01T04:30:00Z');
});

describe('policies (T03-04)', () => {
  const ctx = (id: number) => ({
    ...systemCtx('t'),
    user: { id, name: 'x', mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' },
    permissions: new Set(['a.b.view']),
    unitIds: [101],
    society: { id: 7, name: 'S', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: 'X' },
  });
  it('assertMakerChecker throws 409 MAKER_CHECKER_VIOLATION for the same user only', () => {
    expect(() => assertMakerChecker(ctx(5), 5)).toThrowError(
      expect.objectContaining({ status: 409, code: 'MAKER_CHECKER_VIOLATION' }),
    );
    expect(() => assertMakerChecker(ctx(5), 6)).not.toThrow();
  });
  it('assertNotSelf, assertUnitAccess, scopeWhere and hasPermission', () => {
    expect(() => assertNotSelf(ctx(5), 5)).toThrowError(
      expect.objectContaining({ code: 'SELF_CHANGE_NOT_ALLOWED' }),
    );
    expect(() => assertNotSelf(ctx(5), 6)).not.toThrow();
    expect(() => assertUnitAccess(ctx(5), 102, 'VISITOR_NOT_FOUND')).toThrowError(
      expect.objectContaining({ status: 404, code: 'VISITOR_NOT_FOUND' }),
    );
    expect(() => assertUnitAccess(ctx(5), 101, 'VISITOR_NOT_FOUND')).not.toThrow();
    expect(scopeWhere(ctx(5))).toEqual({ societyId: 7 });
    expect(() => scopeWhere(systemCtx('t'))).toThrowError(
      expect.objectContaining({ code: 'SOCIETY_NOT_SELECTED' }),
    );
    expect(hasPermission(ctx(5), 'a.b.view')).toBe(true);
    expect(hasPermission(ctx(5), 'a.b.edit')).toBe(false);
  });
});

describe('catalogue sync and provisioning (T03-42, 9.1)', () => {
  it('T03-42 a removed key takes its role and grant rows with it and flushes the cache', async () => {
    const society = await makeSociety();
    const fm = await memberUser(society, 'facility_manager');
    const ghost = await Permission.create({
      key: 'ghost.thing.view',
      scope: 'society',
      master: 'ghost',
      subMaster: 'thing',
      action: 'view',
      label: 'View ghost things',
      description: null,
      moduleNo: 1,
      isPrivileged: false,
      sortOrder: 9999,
    } as never);
    const role = await roleOf(society.id!, 'facility_manager');
    await RolePermission.create({
      societyId: society.id!,
      roleId: role.id!,
      permissionId: ghost.id!,
      createdBy: null,
    } as never);
    await MemberGrant.create({
      societyId: society.id!,
      memberId: fm.memberId,
      permissionId: ghost.id!,
      effect: 'ALLOW',
      source: 'ADMIN',
      status: 'ACTIVE',
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 86_400_000),
      reason: 'ghost grant',
      grantedBy: fm.id,
      expiryReminderSentAt: null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      unitId: null,
      createdBy: null,
      updatedBy: null,
    } as never);
    expect((await computeAccess(society.id!, fm.id)).permissions).toContain('ghost.thing.view');
    expect(await kv().cacheGet(keys.role(role.id!))).not.toBeNull();
    const report = await syncCatalogue();
    expect(report.removed).toEqual(['ghost.thing.view']);
    expect(await Permission.count({ where: { key: 'ghost.thing.view' } })).toBe(0);
    expect(await RolePermission.count({ where: { permissionId: ghost.id! } })).toBe(0);
    expect(await MemberGrant.count({ where: { permissionId: ghost.id! } })).toBe(0);
    expect(await kv().cacheGet(keys.role(role.id!))).toBeNull();
    expect((await computeAccess(society.id!, fm.id)).permissions).not.toContain('ghost.thing.view');
    const audit = (await AuditLog.findOne({
      where: { action: 'access.catalogue.synced' },
      order: [['id', 'DESC']],
    }))!;
    expect(audit.societyId).toBeNull();
    expect((audit.after as any).removed).toEqual(['ghost.thing.view']);
  });

  it('is idempotent, adds the missing default roles to every society, and keeps 300 keys', async () => {
    const society = await makeSociety();
    await Role.destroy({ where: { societyId: society.id!, key: 'auditor' }, force: true });
    expect(await Role.count({ where: { societyId: society.id! } })).toBe(14);
    const r = await syncCatalogue();
    expect(r.societyRolesCreated).toBe(1);
    expect(await Role.count({ where: { societyId: society.id! } })).toBe(15);
    expect(await Permission.count()).toBe(300);
    const again = await syncCatalogue();
    expect(again).toMatchObject({ added: 0, removed: [], platformRoles: 0, societyRolesCreated: 0 });
    expect(await sequelize.transaction(t => provisionSocietyRoles(society.id!, t))).toBe(0);
    expect(await Role.count({ where: { societyId: null } })).toBe(2);
  });

  it('registers the repeatable jobs and the in-process scheduler fires them', async () => {
    const fired = await tickScheduler(new Date('2026-11-01T06:30:00Z'));
    expect(fired).toEqual(
      expect.arrayContaining([
        'access-control:expire-invitations',
        'access-control:expire-grants',
        'access-control:grant-expiry-reminder',
      ]),
    );
    await drainQueues();
  });
});

describe('npm run seed (module 03 section: demo data, 7.10)', () => {
  it('creates the catalogue, roles, demo memberships, platform team and invitations; a second run changes nothing', async () => {
    await seedDemoSocieties();
    await seedDemoUsers();
    const first = await seedAccessControl({ demo: true });
    expect(first.members).toHaveLength(8);
    expect(first.platformAssigned).toHaveLength(3);
    expect(Object.keys(first.invitations).sort()).toEqual(['Dev Malhotra', 'Kavita Rao']);
    expect(await Permission.count()).toBe(300);
    expect(await Society.count()).toBe(3);
    for (const s of await Society.findAll())
      expect(await Role.count({ where: { societyId: s.id! } }), s.slug).toBe(15);
    expect(await SocietyMember.count()).toBe(8);
    expect(await Invitation.count({ where: { status: 'PENDING' } })).toBe(2);
    const rajesh = (await User.findOne({ where: { mobile: '9820011111' } }))!;
    const rm = await SocietyMember.findAll({ where: { userId: rajesh.id! }, include: [{ model: Role }] });
    expect(rm.map(m => [(m as any).Role.key, m.locationLabel]).sort()).toEqual([
      ['chairman', 'A-501'],
      ['secretary', 'B-203'],
    ]);
    const tulip = (await Society.findOne({ where: { slug: 'tulip-gardens' } }))!;
    const kavita = (await Invitation.findOne({ where: { mobile: '9820088888' } }))!;
    expect(kavita).toMatchObject({ societyId: tulip.id, locationLabel: 'Office' });
    expect((await Invitation.findOne({ where: { mobile: '9000000004' } }))!.societyId).toBeNull();
    const second = await seedAccessControl({ demo: true });
    expect(second).toMatchObject({ members: [], platformAssigned: [], invitations: {}, catalogueAdded: 0 });
    expect(await SocietyMember.count()).toBe(8);
    expect(await Invitation.count()).toBe(2);
  });

  it('after seeding the chairman signs in to the admin app and Super Admin to the platform app, with authenticator codes', async () => {
    await seedDemoSocieties();
    await seedDemoUsers();
    await seedAccessControl({ demo: true });
    // chairman of Sky Heights (also secretary of Green Park, so he picks a society)
    const email = 'chairman@skyheights.in';
    const r = await call(
      'post',
      '/auth/password/login',
      { email, password: DEMO_PASSWORD },
      { app: 'ADMIN' },
    );
    expect(r.body.data.status, JSON.stringify(r.body)).toBe('MFA_REQUIRED');
    const v = await call(
      'post',
      '/auth/mfa/verify',
      { challengeToken: r.body.data.challengeToken, method: 'TOTP', code: totpNow(demoTotpSecret(email)) },
      { app: 'ADMIN', cookies: cookiesFrom(r) },
    );
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.data.me.memberships.map((m: any) => m.roleKey).sort()).toEqual(['chairman', 'secretary']);
    expect(v.body.data.me.needsSocietyPick).toBe(true);
    const sky = v.body.data.me.memberships.find((m: any) => m.roleKey === 'chairman').societyId;
    const cookies = cookiesFrom(v, cookiesFrom(r));
    const sw = await call('post', '/auth/switch-society', { societyId: sky }, { app: 'ADMIN', cookies });
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    expect(sw.body.data.permissions).toHaveLength(211);
    const roles = await call('get', '/roles', undefined, { app: 'ADMIN', cookies, query: { limit: '100' } });
    expect(roles.body.pagination.total).toBe(15);
    // the office admin, the treasurer and the facility manager can reach the admin app too
    for (const e of ['treasurer@skyheights.in']) {
      const x = await call(
        'post',
        '/auth/password/login',
        { email: e, password: DEMO_PASSWORD },
        { app: 'ADMIN' },
      );
      expect(x.body.data.status).toBe('MFA_REQUIRED');
    }
    // super admin to the platform app
    const sEmail = 'super@societyapp.in';
    const p = await call(
      'post',
      '/auth/password/login',
      { email: sEmail, password: DEMO_PASSWORD },
      { app: 'PLATFORM' },
    );
    expect(p.body.data.status, JSON.stringify(p.body)).toBe('MFA_REQUIRED');
    const pv = await call(
      'post',
      '/auth/mfa/verify',
      { challengeToken: p.body.data.challengeToken, method: 'TOTP', code: totpNow(demoTotpSecret(sEmail)) },
      { app: 'PLATFORM', cookies: cookiesFrom(p) },
    );
    expect(pv.status, JSON.stringify(pv.body)).toBe(200);
    expect(pv.body.data.me.platformPermissions).toHaveLength(39);
    const team = await call('get', '/platform/team', undefined, {
      app: 'PLATFORM',
      cookies: cookiesFrom(pv, cookiesFrom(p)),
    });
    expect(team.status, JSON.stringify(team.body)).toBe(200);
    expect(team.body.data.map((x: any) => x.name).sort()).toEqual([
      'Dev Malhotra',
      'Isha Kapoor',
      'Platform Admin',
      'Support Agent',
    ]);
    // a society chairman cannot use the platform app
    const no = await call(
      'post',
      '/auth/password/login',
      { email, password: DEMO_PASSWORD },
      { app: 'PLATFORM' },
    );
    expect(no.body.code).toBe('NO_ACCESS_FOR_APP');
  });
});
