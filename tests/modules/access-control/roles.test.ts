import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Role, RolePermission, closeDb } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import {
  as,
  fakeEntitlements,
  idem,
  join,
  login,
  makeSociety,
  memberUser,
  resetAccess,
  resetLogins,
  roleOf,
} from '../../helpers/access';
import { makeUser } from '../../helpers/auth';

afterAll(closeDb);
beforeEach(async () => {
  await resetAccess();
  resetLogins();
  setNow('2026-11-01T04:30:00Z');
});

async function world() {
  const society = await makeSociety();
  const chairman = await memberUser(society, 'chairman');
  const admin = await memberUser(society, 'society_admin');
  return { society, chairman, admin, c: as(await login(chairman)), a: as(await login(admin)) };
}

describe('roles list and catalogue (8.1, 8.2)', () => {
  it('lists the 15 default roles with counts and locks the Chairman for society users', async () => {
    const { c } = await world();
    const r = await c('get', '/roles', undefined, { query: { limit: '100' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toHaveLength(15);
    expect(r.body.pagination.total).toBe(15);
    const chairman = r.body.data.find((x: any) => x.key === 'chairman');
    expect(chairman).toMatchObject({ isSystem: true, isLocked: true, memberCount: 1, permissionCount: 211 });
    expect(r.body.data.find((x: any) => x.key === 'treasurer').isLocked).toBe(false);
    const detail = await c('get', `/roles/${chairman.id}`);
    expect(detail.body.data.permissionKeys).toHaveLength(211);
    expect(detail.body.data.basedOnRoleId).toBeNull();
  });

  it('filters by type and scope and searches by name', async () => {
    const { c } = await world();
    const gate = await c('get', '/roles', undefined, { query: { scope: 'gate' } });
    expect(gate.body.data.map((x: any) => x.key)).toEqual(['guard']);
    const custom = await c('get', '/roles', undefined, { query: { type: 'custom' } });
    expect(custom.body.data).toHaveLength(0);
    const s = await c('get', '/roles', undefined, { query: { search: 'treas' } });
    expect(s.body.data.map((x: any) => x.key)).toEqual(['treasurer']);
  });

  it('returns the catalogue tree with heldByMe', async () => {
    const { a } = await world();
    const r = await a('get', '/permissions');
    expect(r.status).toBe(200);
    expect(r.body.data.scope).toBe('society');
    const fin = r.body.data.masters.find((m: any) => m.master === 'finance');
    const expenses = fin.subMasters.find((s: any) => s.subMaster === 'expenses');
    expect(expenses.label).toBe('Expenses and cash book');
    const view = expenses.permissions.find((p: any) => p.key === 'finance.expenses.view');
    const approve = expenses.permissions.find((p: any) => p.key === 'finance.expenses.approve');
    expect(view).toMatchObject({ heldByMe: true, isPrivileged: false, action: 'view' });
    expect(approve).toMatchObject({ heldByMe: false, isPrivileged: true });
  });
});

describe('create role (8.3)', () => {
  it('T03-06 creates a custom role with held keys, key slug, audit row', async () => {
    const { c, society } = await world();
    const keys = ['amenities.amenities.view', 'amenities.amenities.edit', 'communication.notices.create'];
    const r = await c(
      'post',
      '/roles',
      { name: 'Clubhouse manager', scope: 'society', permissionKeys: keys },
      { headers: idem() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      key: 'custom_clubhouse_manager',
      isSystem: false,
      scope: 'society',
      permissionCount: 3,
      version: 1,
      requiresMfa: false,
    });
    expect(r.body.data.permissionKeys).toEqual([...keys].sort());
    const role = (await Role.findByPk(r.body.data.id))!;
    expect(role.consumesSeat).toBe(true);
    expect(
      await AuditLog.count({
        where: { action: 'access.role.created', entityId: String(role.id), societyId: society.id! },
      }),
    ).toBe(1);
  });

  it('clones a role (key suffix on clash) and keeps committee clones off the seat count', async () => {
    const { c } = await world();
    const member = await roleOf(
      (await Role.findOne({ where: { key: 'chairman' } }))!.societyId,
      'committee_member',
    );
    const accountant = await roleOf(member.societyId, 'accountant');
    const one = await c(
      'post',
      '/roles',
      { name: 'Club-house', scope: 'society', basedOnRoleId: member.id },
      { headers: idem() },
    );
    const two = await c(
      'post',
      '/roles',
      { name: 'Club house', scope: 'society', basedOnRoleId: accountant.id },
      { headers: idem() },
    );
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect(two.status, JSON.stringify(two.body)).toBe(201);
    expect(one.body.data.basedOnRoleId).toBe(member.id);
    expect(two.body.data.key).toBe('custom_club_house_2');
    expect((await Role.findByPk(one.body.data.id))!.consumesSeat).toBe(false); // T03-56
    expect((await Role.findByPk(two.body.data.id))!.consumesSeat).toBe(true);
  });

  it('T03-07 Society Admin cannot include finance.bank.approve; nothing is saved', async () => {
    const { a } = await world();
    const before = await Role.count();
    const r = await a(
      'post',
      '/roles',
      {
        name: 'Money mover',
        scope: 'society',
        permissionKeys: ['finance.bank.approve', 'finance.bank.view'],
      },
      { headers: idem() },
    );
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('CANNOT_GRANT_UNHELD_PERMISSION');
    expect(r.body.errors.map((e: any) => e.message)).toContain('finance.bank.approve');
    expect(await Role.count()).toBe(before);
  });

  it('forces MFA when a privileged key is included and rejects bad input', async () => {
    const { c } = await world();
    const r = await c(
      'post',
      '/roles',
      { name: 'Biller', scope: 'society', permissionKeys: ['finance.billing.create'], requiresMfa: false },
      { headers: idem() },
    );
    expect(r.body.data.requiresMfa).toBe(true);
    const dup = await c(
      'post',
      '/roles',
      { name: 'BILLER', scope: 'society', permissionKeys: ['dashboard.today.view'] },
      { headers: idem() },
    );
    expect(dup.body.code).toBe('ROLE_NAME_TAKEN');
    const unknown = await c(
      'post',
      '/roles',
      { name: 'Odd one', scope: 'society', permissionKeys: ['nope.nope.view'] },
      { headers: idem() },
    );
    expect(unknown.body.code).toBe('UNKNOWN_PERMISSION');
    const mismatch = await c(
      'post',
      '/roles',
      { name: 'Odd two', scope: 'society', permissionKeys: ['gate.visitors.view'] },
      { headers: idem() },
    );
    expect(mismatch.body.code).toBe('PERMISSION_SCOPE_MISMATCH');
    const resident = await c(
      'post',
      '/roles',
      { name: 'Odd three', scope: 'resident', permissionKeys: ['resident.home.view'] },
      { headers: idem() },
    );
    expect(resident.status).toBe(422);
    expect(resident.body.code).toBe('ROLE_SCOPE_NOT_ALLOWED');
    const none = await c('post', '/roles', { name: 'Odd four', scope: 'society' }, { headers: idem() });
    expect(none.status).toBe(400);
    const gate = await c(
      'post',
      '/roles',
      { name: 'Gate helper', scope: 'gate', permissionKeys: ['gate.visitors.view'] },
      { headers: idem() },
    );
    expect(gate.status, JSON.stringify(gate.body)).toBe(201);
    expect((await Role.findByPk(gate.body.data.id))!.consumesSeat).toBe(false);
  });

  it('T03-08 the custom role limit gives 402, Starter (0) fails at once, delete releases', async () => {
    const { c } = await world();
    fakeEntitlements({ 'limit.custom_roles': 2 });
    const mk = (n: string) =>
      c(
        'post',
        '/roles',
        { name: n, scope: 'society', permissionKeys: ['dashboard.today.view'] },
        { headers: idem() },
      );
    expect((await mk('Role one')).status).toBe(201);
    const second = await mk('Role two');
    expect(second.status).toBe(201);
    const third = await mk('Role three');
    expect(third.status).toBe(402);
    expect(third.body.code).toBe('USAGE_LIMIT_EXCEEDED');
    const del = await c('delete', `/roles/${second.body.data.id}`, {
      version: 1,
      reason: 'Not needed any more',
    });
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    expect((await mk('Role three')).status).toBe(201);
    fakeEntitlements({ 'limit.custom_roles': 0 });
    expect((await mk('Role four')).status).toBe(402);
  });

  it('T03-21-style validation lists every bad field', async () => {
    const { c } = await world();
    const r = await c(
      'post',
      '/roles',
      { name: 'x', scope: 'society', permissionKeys: [], surprise: 1 },
      { headers: idem() },
    );
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION_FAILED');
    expect(r.body.errors.map((e: any) => e.field).sort()).toEqual(['name', 'permissionKeys', 'surprise']);
  });

  it('needs an Idempotency-Key and replays a repeat (T03-27 style)', async () => {
    const { c } = await world();
    const body = { name: 'Replay role', scope: 'society', permissionKeys: ['dashboard.today.view'] };
    const missing = await c('post', '/roles', body);
    expect(missing.status).toBe(400);
    const h = idem();
    const first = await c('post', '/roles', body, { headers: h });
    const again = await c('post', '/roles', body, { headers: h });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await Role.count({ where: { name: 'Replay role' } })).toBe(1);
    const reused = await c('post', '/roles', { ...body, name: 'Other role' }, { headers: h });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('edit, reset, delete (8.4 to 8.6)', () => {
  async function custom(
    c: ReturnType<typeof as>,
    keys = ['dashboard.today.view', 'communication.notices.view'],
  ) {
    const r = await c(
      'post',
      '/roles',
      { name: 'Notice reader', scope: 'society', permissionKeys: keys },
      { headers: idem() },
    );
    return r.body.data;
  }

  it('edits name, description and keys, bumps the version, audits before and after', async () => {
    const { c, society } = await world();
    const role = await custom(c);
    const r = await c('patch', `/roles/${role.id}`, {
      version: 1,
      name: 'Notice writer',
      description: 'Writes notices',
      permissionKeys: ['dashboard.today.view', 'communication.notices.view', 'communication.notices.create'],
      reason: 'Allow writing notices',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      name: 'Notice writer',
      version: 2,
      permissionCount: 3,
      key: 'custom_notice_reader',
    });
    const rows = await AuditLog.findAll({
      where: { entityType: 'role', entityId: String(role.id) },
      order: [['id', 'ASC']],
    });
    const changed = rows.find(x => x.action === 'access.role.permissions_changed')!;
    expect((changed.before as any).permissionKeys).toEqual([
      'communication.notices.view',
      'dashboard.today.view',
    ]);
    expect((changed.after as any).permissionKeys).toHaveLength(3);
    expect(changed.reason).toBe('Allow writing notices');
    expect(changed.societyId).toBe(society.id);
    expect(rows.some(x => x.action === 'access.role.updated')).toBe(true);
    expect(await RolePermission.count({ where: { roleId: role.id } })).toBe(3);
  });

  it('T03-13 an old version is STALE_VERSION; a reason is needed for key changes', async () => {
    const { c } = await world();
    const role = await custom(c);
    await c('patch', `/roles/${role.id}`, { version: 1, description: 'one' });
    const stale = await c('patch', `/roles/${role.id}`, { version: 1, description: 'two' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    const noReason = await c('patch', `/roles/${role.id}`, {
      version: 2,
      permissionKeys: ['dashboard.today.view'],
    });
    expect(noReason.status).toBe(400);
    const nothing = await c('patch', `/roles/${role.id}`, { version: 2 });
    expect(nothing.status).toBe(400);
  });

  it('requires step-up (REAUTH_REQUIRED after 5 minutes)', async () => {
    const { c } = await world();
    const role = await custom(c);
    setNow('2026-11-01T04:40:00Z');
    const r = await c('patch', `/roles/${role.id}`, { version: 1, description: 'late' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('REAUTH_REQUIRED');
  });

  it('T03-09 society users cannot edit, reset or delete the Chairman role', async () => {
    const { c, society } = await world();
    const chairman = await roleOf(society.id!, 'chairman');
    const p = await c('patch', `/roles/${chairman.id}`, { version: 1, description: 'x' });
    expect(p.status).toBe(403);
    expect(p.body.code).toBe('CHAIRMAN_ROLE_LOCKED');
    expect(
      (await c('post', `/roles/${chairman.id}/reset`, { version: 1, reason: 'Resetting it' })).body.code,
    ).toBe('CHAIRMAN_ROLE_LOCKED');
    expect(
      (await c('delete', `/roles/${chairman.id}`, { version: 1, reason: 'Deleting it' })).body.code,
    ).toBe('CHAIRMAN_ROLE_LOCKED');
  });

  it('T03-11 renaming or deleting a system role is SYSTEM_ROLE_IMMUTABLE; the description may change', async () => {
    const { c, society } = await world();
    const t = await roleOf(society.id!, 'treasurer');
    const rename = await c('patch', `/roles/${t.id}`, { version: 1, name: 'Money person' });
    expect(rename.status).toBe(422);
    expect(rename.body.code).toBe('SYSTEM_ROLE_IMMUTABLE');
    const del = await c('delete', `/roles/${t.id}`, { version: 1, reason: 'Remove treasurer' });
    expect(del.body.code).toBe('SYSTEM_ROLE_IMMUTABLE');
    const desc = await c('patch', `/roles/${t.id}`, { version: 1, description: 'Keeps the money safe' });
    expect(desc.status).toBe(200);
    const mfa = await c('patch', `/roles/${t.id}`, { version: 2, requiresMfa: false, reason: 'Turn it off' });
    expect(mfa.status).toBe(422);
    expect(mfa.body.code).toBe('MFA_FLAG_LOCKED');
  });

  it('no-escalation applies when adding keys to a role; removing unheld keys is allowed', async () => {
    const { c, a, society } = await world();
    const fm = await roleOf(society.id!, 'facility_manager');
    const add = await a('patch', `/roles/${fm.id}`, {
      version: 1,
      permissionKeys: ['dashboard.today.view', 'finance.bank.approve'],
      reason: 'Add bank approval',
    });
    expect(add.status).toBe(403);
    expect(add.body.code).toBe('CANNOT_GRANT_UNHELD_PERMISSION');
    const ok = await c('patch', `/roles/${fm.id}`, {
      version: 1,
      permissionKeys: ['dashboard.today.view', 'finance.bank.view'],
      reason: 'Fewer keys',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // society admin removes keys it does not hold: allowed
    const removeUnheld = await a('patch', `/roles/${fm.id}`, {
      version: 2,
      permissionKeys: ['dashboard.today.view'],
      reason: 'Trim back',
    });
    expect(removeUnheld.status, JSON.stringify(removeUnheld.body)).toBe(200);
  });

  it('T03-53 a custom role with a privileged key cannot turn MFA off', async () => {
    const { c } = await world();
    const r = await c(
      'post',
      '/roles',
      { name: 'Expense clerk', scope: 'society', permissionKeys: ['finance.expenses.create'] },
      { headers: idem() },
    );
    const p = await c('patch', `/roles/${r.body.data.id}`, {
      version: 1,
      requiresMfa: false,
      reason: 'Switch it off',
    });
    expect(p.status).toBe(422);
    expect(p.body.code).toBe('MFA_FLAG_LOCKED');
  });

  it('reset restores the matrix defaults and refuses custom roles', async () => {
    const { c, society } = await world();
    const sec = await roleOf(society.id!, 'secretary');
    await c('patch', `/roles/${sec.id}`, {
      version: 1,
      permissionKeys: ['dashboard.today.view'],
      reason: 'Trim it down',
    });
    const reset = await c('post', `/roles/${sec.id}/reset`, { version: 2, reason: 'Back to normal' });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(reset.body.data.permissionCount).toBeGreaterThan(100);
    expect(reset.body.data.version).toBe(3);
    expect(await AuditLog.count({ where: { action: 'access.role.reset' } })).toBe(1);
    const cr = (await custom(c)) as any;
    const bad = await c('post', `/roles/${cr.id}/reset`, { version: 1, reason: 'Try to reset it' });
    expect(bad.body.code).toBe('SYSTEM_ROLE_IMMUTABLE');
  });

  it('T03-12 deleting a role in use gives ROLE_IN_USE with counts; unused delete renames key and name', async () => {
    const { c, society } = await world();
    const r = await custom(c);
    const user = await makeUser({ name: 'Holder' });
    // move a member onto the custom role directly
    const m = await join(society, user, 'committee_member');
    await m.update({ roleId: r.id });
    const inUse = await c('delete', `/roles/${r.id}`, { version: 1, reason: 'Clean up roles' });
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe('ROLE_IN_USE');
    expect(inUse.body.errors).toEqual([
      { field: 'memberCount', message: '1' },
      { field: 'pendingInvitationCount', message: '0' },
    ]);
    await m.update({ roleId: (await roleOf(society.id!, 'committee_member')).id! });
    const ok = await c('delete', `/roles/${r.id}`, { version: 1, reason: 'Clean up roles' });
    expect(ok.status).toBe(204);
    const row = (await Role.findByPk(r.id, { paranoid: false }))!;
    expect(row.key).toBe(`custom_notice_reader__del_${r.id}`);
    expect(row.name).toBe(`Notice reader (deleted ${r.id})`);
    expect(row.deletedAt).not.toBeNull();
    // the name can be used again
    const again = await custom(c);
    expect(again.key).toBe('custom_notice_reader');
    expect((await c('get', `/roles/${r.id}`)).body.code).toBe('ROLE_NOT_FOUND');
  });
});
