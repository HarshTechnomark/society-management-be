import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Role, closeDb, sequelize } from '../../../src/models';
import {
  listRoutes,
  routeProblems,
  type RouteMeta,
} from '../../../src/modules/access-control/access-control.registry';
import { isPublicRoute } from '../../../src/modules/auth/public.routes';
import { replaceRoleKeys } from '../../../src/modules/access-control/access-control.util';
import { authArea, publicRoute, requirePermission } from '../../../src/middlewares/permission.middleware';
import { societyMiddleware } from '../../../src/middlewares/society.middleware';
import { setNow } from '../../../src/lib/clock';
import { app, makeUser } from '../../helpers/auth';
import {
  as,
  join,
  login,
  makeSociety,
  platformLogin,
  platformUser,
  resetAccess,
  resetLogins,
  roleOf,
} from '../../helpers/access';

afterAll(closeDb);
beforeEach(async () => {
  await resetAccess();
  resetLogins();
  setNow('2026-11-01T04:30:00Z');
});

const routes = listRoutes(app);
const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, '1');

describe('route registry (T03-43, section 13)', () => {
  it('every registered route has a marker, or is a listed public route', () => {
    expect(routes.length).toBeGreaterThan(80);
    expect(routeProblems(routes, isPublicRoute)).toEqual([]);
    expect(routes.filter(r => r.kind === 'society').length).toBeGreaterThan(20);
    // module 03's own platform routes; module 04 adds plans, add-ons, subscriptions and flags; module 05 societies and support access
    const m04 =
      /^\/platform\/(plans|plan-versions|entitlement-catalogue|addons|subscriptions|feature-flags|support-access|societies(\/export|\/slug-availability|\/:id(\/(lifecycle-events|extend-trial|convert|suspend|reactivate|close|reopen|purge-hold|nudge|notes(\/:noteId)?|data-exports))?)?$)/;
    // module 06 adds invoices (with remind, extend-grace and write-off), payments, credits, refunds and the billing reports under /platform
    const m06 =
      /^\/platform\/(invoices(\/export|\/:id(\/(pdf-url|credit-notes|approve|reject|tds-claims|remind|extend-grace|write-off(\/approve|\/reject)?))?)?|billing\/(approvals|dunning|revenue|gst-summary|tds-receivable)|payments(\/:id\/(approve|reject|tds-decision|complete-refund))?|credits\/:id\/(approve|reject)|societies\/:societyId\/(credits|refunds))$/;
    // module 07 (part 1) adds platform support tickets, settings and organizations
    const m07 = /^\/platform\/(tickets(\/:id(\/messages)?)?|settings|organizations(\/:id(\/status)?)?)$/;
    expect(
      routes.filter(r => r.kind === 'platform' && !m04.test(r.path) && !m06.test(r.path) && !m07.test(r.path))
        .length,
    ).toBe(15);
    expect(routes.filter(r => r.kind === 'platform' && m07.test(r.path)).length).toBe(12);
    expect(routes.filter(r => r.kind === 'platform' && m06.test(r.path)).length).toBe(30);
  });

  it('detects an unmarked route and a society route without a permission', () => {
    const probe = express();
    const router = express.Router();
    router.get('/oops', (_q, r) => void r.end());
    router.get('/needs-key', societyMiddleware(), (_q, r) => void r.end());
    router.get(
      '/fine',
      societyMiddleware(),
      requirePermission('settings.roles.view'),
      (_q, r) => void r.end(),
    );
    router.get('/open', publicRoute(), (_q, r) => void r.end());
    const inner = express.Router();
    inner.get('/x', (_q, r) => void r.end());
    router.use('/area', authArea(), inner);
    const api = express.Router();
    api.use(router);
    probe.use('/api/v1', api);
    const found = listRoutes(probe);
    expect(found.map(r => `${r.method} ${r.path} ${r.kind}`).sort()).toEqual([
      'GET /area/x auth',
      'GET /fine society',
      'GET /needs-key society',
      'GET /oops unmarked',
      'GET /open public',
    ]);
    expect(routeProblems(found, () => false).sort()).toEqual([
      'GET /needs-key: society route without a permission',
      'GET /oops: no marker',
    ]);
  });

  it('reads step-up, idempotency and permission metadata', () => {
    const find = (m: string, p: string): RouteMeta => routes.find(r => r.method === m && r.path === p)!;
    expect(find('PATCH', '/roles/:id')).toMatchObject({
      kind: 'society',
      permissions: ['settings.roles.edit'],
      stepUp: true,
    });
    expect(find('POST', '/roles')).toMatchObject({ idempotent: true, stepUp: false });
    expect(find('GET', '/roles').permissions).toEqual(['settings.roles.view', 'settings.members.view']);
    expect(find('POST', '/invitations/:token/accept')).toMatchObject({ kind: 'auth', idempotent: true });
    expect(find('GET', '/public/invitations/:token').kind).toBe('public');
    expect(find('DELETE', '/platform/team/:userId')).toMatchObject({
      kind: 'platform',
      permissions: ['platform.team.delete'],
      stepUp: true,
    });
  });
});

describe('permission matrix (T03-35)', () => {
  it('a member whose role lacks the permission gets 403 PERMISSION_DENIED on every society route, before validation', async () => {
    const society = await makeSociety();
    const user = await makeUser({ name: 'Minimal' });
    await sequelize.transaction(async tx => {
      const role = await Role.create(
        {
          societyId: society.id!,
          scope: 'society',
          key: 'custom_minimal',
          name: 'Minimal',
          description: null,
          isSystem: false,
          requiresMfa: false,
          consumesSeat: false,
          basedOnRoleId: null,
          version: 1,
          createdBy: null,
          updatedBy: null,
        },
        { transaction: tx },
      );
      await replaceRoleKeys(role, ['dashboard.today.view'], null, tx);
    });
    const member = await join(society, user, 'committee_member');
    await member.update({ roleId: (await Role.findOne({ where: { key: 'custom_minimal' } }))!.id! });
    const call = as(await login(user));
    const society_routes = routes.filter(r => r.kind === 'society' && !r.memberOnly);
    const failures: string[] = [];
    for (const r of society_routes) {
      const res = await call(
        r.method.toLowerCase() as 'get',
        concrete(r.path),
        r.method === 'GET' ? undefined : {},
        {
          headers: { 'Idempotency-Key': '00000000-0000-4000-8000-000000000000' },
        },
      );
      if (res.status !== 403 || res.body.code !== 'PERMISSION_DENIED')
        failures.push(`${r.method} ${r.path} -> ${res.status} ${res.body.code}`);
    }
    expect(failures).toEqual([]);
    expect(society_routes.length).toBeGreaterThan(20);
    // routes open to every active member (module 04 `GET /subscription/entitlements`) answer this member
    for (const r of routes.filter(x => x.kind === 'society' && x.memberOnly))
      expect((await call(r.method.toLowerCase() as 'get', concrete(r.path))).status, r.path).toBe(200);
  });

  it('a platform user whose role lacks the permission gets 403 on every platform route; a society user gets PLATFORM_ACCESS_REQUIRED', async () => {
    const role = await Role.create({
      societyId: null,
      scope: 'platform',
      key: 'custom_dash',
      name: 'Dash only',
      description: null,
      isSystem: false,
      requiresMfa: true,
      consumesSeat: false,
      basedOnRoleId: null,
      version: 1,
      createdBy: null,
      updatedBy: null,
    });
    await sequelize.transaction(tx => replaceRoleKeys(role, ['platform.dashboard.view'], null, tx));
    const u = await makeUser({ email: 'dash@societyapp.in', mfa: true, platformRoleId: role.id! });
    const call = as(await platformLogin({ ...u, email: 'dash@societyapp.in' }), 'PLATFORM');
    const failures: string[] = [];
    const platform = routes.filter(r => r.kind === 'platform');
    for (const r of platform) {
      const res = await call(
        r.method.toLowerCase() as 'get',
        concrete(r.path),
        r.method === 'GET' ? undefined : {},
        {
          headers: { 'Idempotency-Key': '00000000-0000-4000-8000-000000000000' },
        },
      );
      if (res.status !== 403 || res.body.code !== 'PERMISSION_DENIED')
        failures.push(`${r.method} ${r.path} -> ${res.status} ${res.body.code}`);
    }
    expect(failures).toEqual([]);

    const society = await makeSociety();
    const member = await makeUser({ name: 'Chair' });
    await join(society, member, 'committee_member');
    const sc = as(await login(member));
    for (const r of platform) {
      const res = await sc(
        r.method.toLowerCase() as 'get',
        concrete(r.path),
        r.method === 'GET' ? undefined : {},
      );
      expect(res.body.code, `${r.method} ${r.path}`).toBe('PLATFORM_ACCESS_REQUIRED');
    }
    void platformUser;
    void roleOf;
  });
});
