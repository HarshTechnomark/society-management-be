import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, MemberGrant, SocietyMember, closeDb } from '../../../src/models';
import { advance, setNow } from '../../../src/lib/clock';
import {
  authAccess,
  computeAccess,
  invalidateMember,
} from '../../../src/modules/access-control/access-control.public';
import { setAccessPorts } from '../../../src/modules/access-control/access-control.ports';
import { expireGrants, grantExpiryReminders } from '../../../src/modules/access-control/access-control.jobs';
import { events } from '../../helpers/auth';
import {
  as,
  idem,
  login,
  makeSociety,
  memberUser,
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

async function world() {
  const society = await makeSociety();
  const chairman = await memberUser(society, 'chairman');
  const fm = await memberUser(society, 'facility_manager');
  return { society, chairman, fm, c: as(await login(chairman)) };
}
const addGrant = (c: ReturnType<typeof as>, memberId: number, o: Record<string, unknown> = {}) =>
  c(
    'post',
    `/members/${memberId}/grants`,
    {
      permissionKey: 'finance.bank.import',
      endsAt: '2026-11-01T04:40:00.000Z',
      reason: 'Statutory audit FY 2025-26',
      ...o,
    },
    { headers: idem() },
  );

describe('admin grants (8.15)', () => {
  it('T03-28 a grant works until endsAt and not one second after; the job marks it EXPIRED', async () => {
    const { c, fm, society } = await world();
    const f = as(await login(fm));
    // facility manager lacks settings.members.export; grant it as the probe permission
    expect((await f('get', '/members/export')).status).toBe(403);
    const r = await addGrant(c, fm.memberId, {
      permissionKey: 'settings.members.export',
      endsAt: '2026-11-01T04:40:00.000Z',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      permissionKey: 'settings.members.export',
      effect: 'ALLOW',
      source: 'ADMIN',
      status: 'ACTIVE',
      isInEffect: true,
      reason: 'Statutory audit FY 2025-26',
    });
    expect((await f('get', '/members/export')).status).toBe(200);
    setNow('2026-11-01T04:39:59.999Z');
    expect((await f('get', '/members/export')).status).toBe(200);
    setNow('2026-11-01T04:40:00.000Z');
    const after = await f('get', '/members/export');
    expect(after.status).toBe(403);
    expect(after.body.code).toBe('PERMISSION_DENIED');
    // the job is late, but the window was enforced; now it marks EXPIRED and notifies
    expect((await MemberGrant.findOne({ where: { memberId: fm.memberId } }))!.status).toBe('ACTIVE');
    expect(await expireGrants()).toBe(1);
    expect(await expireGrants()).toBe(0);
    expect((await MemberGrant.findOne({ where: { memberId: fm.memberId } }))!.status).toBe('EXPIRED');
    expect(await AuditLog.count({ where: { action: 'access.grant.expired', societyId: society.id! } })).toBe(
      1,
    );
    expect(
      events.some(e => e.room === `user:${fm.id}` && (e.payload as any).reason === 'GRANT_CHANGED'),
    ).toBe(true);
  });

  it('T03-03 computeAccess: role, ALLOW grant, expired and future grants', async () => {
    const { c, fm, society } = await world();
    const base = await computeAccess(society.id!, fm.id);
    expect(base.status).toBe('ACTIVE');
    expect(base.permissions).not.toContain('finance.bank.import');
    await addGrant(c, fm.memberId);
    await addGrant(c, fm.memberId, {
      permissionKey: 'finance.bank.edit',
      startsAt: '2026-11-02T04:30:00.000Z',
      endsAt: '2026-11-05T00:00:00.000Z',
    });
    const now = await computeAccess(society.id!, fm.id);
    expect(now.permissions).toContain('finance.bank.import');
    expect(now.permissions).not.toContain('finance.bank.edit'); // future
    setNow('2026-11-01T05:00:00Z');
    expect((await computeAccess(society.id!, fm.id)).permissions).not.toContain('finance.bank.import'); // expired
    setNow('2026-11-03T00:00:00Z');
    expect((await computeAccess(society.id!, fm.id)).permissions).toContain('finance.bank.edit');
    expect(await authAccess.getPermissions(fm.id, society.id!)).toContain('finance.bank.edit');
  });

  it('T03-29 a window over 90 days, past start, far start or end before start is GRANT_WINDOW_INVALID', async () => {
    const { c, fm } = await world();
    const bad = async (o: Record<string, unknown>) => {
      const r = await addGrant(c, fm.memberId, o);
      expect(r.status, JSON.stringify(o)).toBe(422);
      expect(r.body.code).toBe('GRANT_WINDOW_INVALID');
    };
    await bad({ endsAt: '2027-02-01T04:30:01.000Z' }); // 91 days after the default start
    await bad({ startsAt: '2026-10-31T00:00:00.000Z', endsAt: '2026-11-05T00:00:00.000Z' });
    await bad({ startsAt: '2026-12-15T00:00:00.000Z', endsAt: '2026-12-20T00:00:00.000Z' });
    await bad({ endsAt: '2026-11-01T04:30:00.000Z' });
    const ok = await addGrant(c, fm.memberId, { endsAt: '2027-01-30T04:30:00.000Z' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201); // exactly 90 days
  });

  it('T03-30 a second ACTIVE grant for the same key is GRANT_ALREADY_EXISTS; revoke frees the slot', async () => {
    const { c, fm } = await world();
    const first = await addGrant(c, fm.memberId);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const dup = await addGrant(c, fm.memberId);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('GRANT_ALREADY_EXISTS');
    const rev = await c('delete', `/members/${fm.memberId}/grants/${first.body.data.id}`, {
      reason: 'Audit finished early',
    });
    expect(rev.status, JSON.stringify(rev.body)).toBe(204);
    expect((await addGrant(c, fm.memberId)).status).toBe(201);
    const again = await c('delete', `/members/${fm.memberId}/grants/${first.body.data.id}`, {
      reason: 'Revoke it twice',
    });
    expect(again.body.code).toBe('INVALID_STATE');
    expect(
      (await c('delete', `/members/${fm.memberId}/grants/999999`, { reason: 'Does not exist' })).body.code,
    ).toBe('GRANT_NOT_FOUND');
    expect(await AuditLog.count({ where: { action: 'access.grant.revoked' } })).toBe(1);
  });

  it('rules: not self, key in role, wrong scope, unknown key, no escalation, step-up', async () => {
    const { c, fm, chairman, society } = await world();
    const cm = (await SocietyMember.findOne({ where: { userId: chairman.id } }))!;
    expect((await addGrant(c, cm.id!)).body.code).toBe('SELF_CHANGE_NOT_ALLOWED');
    expect((await addGrant(c, fm.memberId, { permissionKey: 'helpdesk.tickets.view' })).body.code).toBe(
      'GRANT_NOT_ALLOWED',
    );
    expect((await addGrant(c, fm.memberId, { permissionKey: 'gate.visitors.view' })).body.code).toBe(
      'GRANT_NOT_ALLOWED',
    );
    expect((await addGrant(c, fm.memberId, { permissionKey: 'nope.nope.view' })).body.code).toBe(
      'UNKNOWN_PERMISSION',
    );
    const admin = await memberUser(society, 'society_admin');
    const a = as(await login(admin));
    const esc = await addGrant(a, fm.memberId, { permissionKey: 'finance.bank.approve' });
    expect(esc.status).toBe(403);
    expect(esc.body.code).toBe('CANNOT_GRANT_UNHELD_PERMISSION');
    setNow('2026-11-01T04:37:00Z');
    const late = await addGrant(c, fm.memberId);
    expect(late.status).toBe(401);
    expect(late.body.code).toBe('REAUTH_REQUIRED');
    expect((await addGrant(c, fm.memberId, { endsAt: 'tomorrow' })).status).toBe(400);
  });

  it('lists grants by status with the granter name, and the detail carries them', async () => {
    const { c, fm } = await world();
    const g = await addGrant(c, fm.memberId);
    const list = await c('get', `/members/${fm.memberId}/grants`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      id: g.body.data.id,
      grantedByName: 'chairman',
      label: 'Import bank and reconciliation',
    });
    expect(
      (await c('get', `/members/${fm.memberId}/grants`, undefined, { query: { status: 'REVOKED' } })).body
        .data,
    ).toHaveLength(0);
    const d = await c('get', `/members/${fm.memberId}`);
    expect(d.body.data.grants).toHaveLength(1);
    expect(d.body.data.activeGrantCount).toBe(1);
  });

  it('a role change drops admin grants of another scope; the reminder job runs once', async () => {
    const { c, fm } = await world();
    await addGrant(c, fm.memberId, { endsAt: '2026-11-01T20:00:00.000Z' });
    expect(await grantExpiryReminders()).toBe(1);
    expect(await grantExpiryReminders()).toBe(0);
    const g = (await MemberGrant.findOne({ where: { memberId: fm.memberId } }))!;
    expect(g.expiryReminderSentAt).not.toBeNull();
    const guard = (await roleOf(g.societyId, 'guard')).id;
    const r = await c('patch', `/members/${fm.memberId}`, {
      version: 1,
      roleId: guard,
      reason: 'Moved to the gate',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await g.reload()).status).toBe('REVOKED');
    advance(1);
  });
});

describe('household grants (8.18, BR-03-16, T03-31, T03-32)', () => {
  async function house() {
    const society = await makeSociety();
    const owner = await memberUser(society, 'owner', { name: 'Owner One', mfa: false });
    const son = await memberUser(society, 'family_member', { name: 'Kabir', mfa: false });
    const other = await memberUser(society, 'owner', { name: 'Other Owner', mfa: false });
    const links: Record<number, { unitId: number; relation: 'OWNER' | 'TENANT' | 'FAMILY' }[]> = {
      [owner.id]: [{ unitId: 101, relation: 'OWNER' }],
      [son.id]: [{ unitId: 101, relation: 'FAMILY' }],
      [other.id]: [{ unitId: 102, relation: 'OWNER' }],
    };
    setAccessPorts({ residents: { getActiveUnitLinks: async (_s, u) => links[u] ?? [] } });
    const o = as(await login(owner, { app: 'RESIDENT' }), 'RESIDENT');
    return { society, owner, son, other, links, o };
  }

  it('shows the options and applies ALLOW and DENY grants to the family member', async () => {
    const { o, son, society } = await house();
    const get = await o('get', `/me/household/${son.memberId}/grants`);
    expect(get.status, JSON.stringify(get.body)).toBe(200);
    expect(get.body.data).toMatchObject({ memberId: son.memberId, name: 'Kabir', unitIds: [101] });
    const opt = (k: string, body = get.body) => body.data.options.find((x: any) => x.permissionKey === k);
    expect(opt('resident.payments.create')).toMatchObject({
      kind: 'ALLOW',
      enabled: false,
      label: 'Pay dues',
    });
    expect(opt('resident.amenities.create')).toMatchObject({ kind: 'DENY', enabled: true });
    expect(get.body.data.options).toHaveLength(10);
    const save = await o('patch', `/me/household/${son.memberId}/grants`, {
      unitId: 101,
      allow: ['resident.payments.create', 'resident.dues.view'],
      deny: ['resident.amenities.create'],
    });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect(opt('resident.payments.create', save.body).enabled).toBe(true);
    expect(opt('resident.amenities.create', save.body).enabled).toBe(false);
    const perms = await authAccess.getPermissions(son.id, society.id!);
    expect(perms).toContain('resident.payments.create');
    expect(perms).not.toContain('resident.amenities.create');
    expect(perms).toContain('resident.visitors.approve');
    const audit = (await AuditLog.findOne({ where: { action: 'access.grant.household_updated' } }))!;
    expect((audit.after as any).allow).toEqual(['resident.dues.view', 'resident.payments.create']);
    // full replacement: dropping a key revokes it with HOUSEHOLD_UPDATED
    const again = await o('patch', `/me/household/${son.memberId}/grants`, {
      unitId: 101,
      allow: ['resident.dues.view'],
      deny: [],
    });
    expect(again.status).toBe(200);
    const revoked = await MemberGrant.findAll({ where: { memberId: son.memberId, status: 'REVOKED' } });
    expect(revoked.map(g => g.revokeReason)).toEqual(['HOUSEHOLD_UPDATED', 'HOUSEHOLD_UPDATED']);
    expect(await authAccess.getPermissions(son.id, society.id!)).toContain('resident.amenities.create');
  });

  it('T03-32 an owner of unit 101 cannot see or change a family member of unit 102 (404), nor themselves (403)', async () => {
    const { o, owner, society, links } = await house();
    const kid = await memberUser(society, 'family_member', { name: 'Neighbour kid', mfa: false });
    links[kid.id] = [{ unitId: 102, relation: 'FAMILY' }];
    const r = await o('patch', `/me/household/${kid.memberId}/grants`, { unitId: 102, allow: [], deny: [] });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('MEMBER_NOT_FOUND');
    expect((await o('get', `/me/household/${kid.memberId}/grants`)).body.code).toBe('MEMBER_NOT_FOUND');
    const mine = (await SocietyMember.findOne({ where: { userId: owner.id } }))!;
    expect((await o('get', `/me/household/${mine.id}/grants`)).body.code).toBe('SELF_CHANGE_NOT_ALLOWED');
    expect((await o('get', '/me/household/999999/grants')).body.code).toBe('MEMBER_NOT_FOUND');
  });

  it('GRANT_NOT_ALLOWED for keys outside the lists; a unit the member is not linked to is 404', async () => {
    const { o, son } = await house();
    const a = await o('patch', `/me/household/${son.memberId}/grants`, {
      unitId: 101,
      allow: ['finance.bank.import'],
      deny: [],
    });
    expect(a.status).toBe(422);
    expect(a.body.code).toBe('GRANT_NOT_ALLOWED');
    const swapped = await o('patch', `/me/household/${son.memberId}/grants`, {
      unitId: 101,
      allow: [],
      deny: ['resident.payments.create'],
    });
    expect(swapped.body.code).toBe('GRANT_NOT_ALLOWED');
    const unit = await o('patch', `/me/household/${son.memberId}/grants`, {
      unitId: 555,
      allow: [],
      deny: [],
    });
    expect(unit.body.code).toBe('MEMBER_NOT_FOUND');
    expect(
      (await o('patch', `/me/household/${son.memberId}/grants`, { unitId: 101, allow: [], deny: [], x: 1 }))
        .status,
    ).toBe(400);
  });

  it('revokeHouseholdGrants and invalidateMember revoke grants when the FAMILY link ends (UNIT_LINK_ENDED)', async () => {
    const { o, son, links, society } = await house();
    await o('patch', `/me/household/${son.memberId}/grants`, {
      unitId: 101,
      allow: ['resident.payments.create'],
      deny: [],
    });
    links[son.id] = []; // module 09 ended the link
    await invalidateMember(society.id!, son.id);
    const g = (await MemberGrant.findOne({ where: { memberId: son.memberId } }))!;
    expect(g).toMatchObject({ status: 'REVOKED', revokeReason: 'UNIT_LINK_ENDED' });
  });

  it('a treasurer who also owns a flat gets resident permissions from the OWNER link (BR-03-4)', async () => {
    const society = await makeSociety();
    const tr = await memberUser(society, 'treasurer');
    setAccessPorts({ residents: { getActiveUnitLinks: async () => [{ unitId: 7, relation: 'OWNER' }] } });
    const snap = await computeAccess(society.id!, tr.id);
    expect(snap.roleKey).toBe('treasurer');
    expect(snap.permissions).toEqual(
      expect.arrayContaining(['finance.payments.approve', 'resident.payments.create']),
    );
    expect(snap.unitLinks).toEqual([{ unitId: 7, relation: 'OWNER' }]);
  });
});
