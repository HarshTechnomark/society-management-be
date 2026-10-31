import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  Invitation,
  MemberGrant,
  Role,
  Session,
  SocietyMember,
  closeDb,
  sequelize,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { setRealtimeSink } from '../../../src/lib/realtime';
import { systemCtx } from '../../../src/types/context';
import {
  changeRole,
  cancelAllPendingInvitations,
  createInitialMember,
  endAllMembersForSociety,
  endMember,
  authAccess,
} from '../../../src/modules/access-control/access-control.public';
import { placeholderExports } from '../../../src/modules/access-control/access-control.ports';
import { createInvitationCore } from '../../../src/modules/access-control/access-control.invitations.service';
import { events, makeUser } from '../../helpers/auth';
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

afterAll(closeDb);
beforeEach(async () => {
  await resetAccess();
  resetLogins();
  setNow('2026-11-01T04:30:00Z');
});

const tx = <T>(fn: (t: import('sequelize').Transaction) => Promise<T>) => sequelize.transaction(fn);

async function world() {
  const society = await makeSociety();
  const chairman = await memberUser(society, 'chairman', { name: 'Rajesh Kulkarni' });
  const admin = await memberUser(society, 'society_admin', { name: 'Neha Joshi' });
  const treasurer = await memberUser(society, 'treasurer', { name: 'Meera Iyer' });
  const fm = await memberUser(society, 'facility_manager', { name: 'Sunil Patil' });
  return {
    society,
    chairman,
    admin,
    treasurer,
    fm,
    c: as(await login(chairman)),
    a: as(await login(admin)),
  };
}
const detail = (c: ReturnType<typeof as>, id: number) => c('get', `/members/${id}`);

describe('member list and detail (8.7, 8.9)', () => {
  it('lists active members, masks mobiles without residents.contacts.view, flags self', async () => {
    const { society, chairman, c } = await world();
    const custom = await c(
      'post',
      '/roles',
      {
        name: 'Team viewer',
        scope: 'society',
        permissionKeys: ['settings.members.view', 'dashboard.today.view'],
      },
      { headers: idem() },
    );
    const viewer = await memberUser(society, 'committee_member', { name: 'Viewer' });
    await SocietyMember.update({ roleId: custom.body.data.id }, { where: { id: viewer.memberId } });
    const v = as(await login(viewer));
    const r = await v('get', '/members');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.pagination.total).toBe(5);
    const row = r.body.data.find((x: any) => x.userId === chairman.id);
    expect(row.mobile).toMatch(/^\d\dXXXXX\d{3}$/);
    expect(row.role).toMatchObject({ key: 'chairman', scope: 'society' });
    expect(row).toMatchObject({
      status: 'ACTIVE',
      mfaEnabled: true,
      requiresMfa: true,
      isSelf: false,
      activeGrantCount: 0,
    });
    expect(r.body.data.find((x: any) => x.userId === viewer.id).isSelf).toBe(true);
    expect(r.body.data.find((x: any) => x.userId === viewer.id).mobile).toBe(viewer.mobile);
    const full = await c('get', '/members');
    expect(full.body.data.find((x: any) => x.userId === chairman.id).mobile).toBe(chairman.mobile);
  });

  it('filters by status, role and search, sorts and paginates', async () => {
    const { treasurer, c, society } = await world();
    const role = await roleOf(society.id!, 'treasurer');
    const byRole = await c('get', '/members', undefined, { query: { roleId: String(role.id) } });
    expect(byRole.body.data.map((x: any) => x.userId)).toEqual([treasurer.id]);
    const bySearch = await c('get', '/members', undefined, { query: { search: 'Meera' } });
    expect(bySearch.body.data).toHaveLength(1);
    const byLast4 = await c('get', '/members', undefined, { query: { search: treasurer.mobile.slice(-4) } });
    expect(byLast4.body.data.map((x: any) => x.userId)).toContain(treasurer.id);
    const sorted = await c('get', '/members', undefined, {
      query: { sortBy: 'name', sortOrder: 'desc', limit: '2' },
    });
    expect(sorted.body.data.map((x: any) => x.name)).toEqual(['Sunil Patil', 'Rajesh Kulkarni']);
    expect(sorted.body.pagination).toEqual({ page: 1, limit: 2, total: 4, totalPages: 2 });
    const none = await c('get', '/members', undefined, { query: { status: 'ENDED' } });
    expect(none.body.data).toHaveLength(0);
    const foreign = await c('get', '/members', undefined, { query: { roleId: '999999' } });
    expect(foreign.body.data).toHaveLength(0);
  });

  it('returns detail with effective permission count, grants and invitation', async () => {
    const { treasurer, c } = await world();
    const m = (await SocietyMember.findOne({ where: { userId: treasurer.id } }))!;
    const r = await detail(c, m.id!);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      id: m.id,
      unitLinks: [],
      grants: [],
      invitation: null,
      suspendReason: null,
    });
    expect(r.body.data.effectivePermissionCount).toBeGreaterThan(50);
  });
});

describe('role change, suspend, end (8.11, 8.12)', () => {
  it('T03-14 the only chairman cannot be demoted, suspended or ended; a second chairman allows it', async () => {
    const { society, chairman, a, c } = await world();
    const m = (await SocietyMember.findOne({ where: { userId: chairman.id } }))!;
    const cm = (await roleOf(society.id!, 'committee_member')).id;
    const change = await a('patch', `/members/${m.id}`, {
      version: m.version,
      roleId: cm,
      reason: 'Stepping down',
    });
    expect(change.status, JSON.stringify(change.body)).toBe(409);
    expect(change.body.code).toBe('LAST_CHAIRMAN');
    const sus = await a('post', `/members/${m.id}/suspend`, { version: 1, reason: 'Pausing access' });
    expect(sus.body.code).toBe('LAST_CHAIRMAN');
    const end = await a('delete', `/members/${m.id}`, { version: 1, reason: 'Resigned' });
    expect(end.body.code).toBe('LAST_CHAIRMAN');
    expect((await SocietyMember.findByPk(m.id))!.status).toBe('ACTIVE');
    const second = await memberUser(society, 'chairman', { name: 'Second Chair' });
    expect(second.memberId).toBeGreaterThan(0);
    const ok = await a('patch', `/members/${m.id}`, { version: 1, roleId: cm, reason: 'Stepping down' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    void c;
  });

  it('T03-15 two parallel demotions of two chairmen: one 200 and one LAST_CHAIRMAN', async () => {
    const { society, admin, chairman } = await world();
    const other = await memberUser(society, 'chairman', { name: 'Second Chair' });
    const second = await memberUser(society, 'society_admin', { name: 'Second Admin' });
    const a1 = as(await login(admin));
    const a2 = as(await login(second));
    const cm = (await roleOf(society.id!, 'committee_member')).id;
    const m1 = (await SocietyMember.findOne({ where: { userId: chairman.id } }))!;
    const m2 = (await SocietyMember.findOne({ where: { userId: other.id } }))!;
    const [r1, r2] = await Promise.all([
      a1('patch', `/members/${m1.id}`, { version: 1, roleId: cm, reason: 'Parallel one' }),
      a2('patch', `/members/${m2.id}`, { version: 1, roleId: cm, reason: 'Parallel two' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect([r1.body.code, r2.body.code]).toContain('LAST_CHAIRMAN');
    expect(
      await SocietyMember.count({
        where: {
          societyId: society.id!,
          status: 'ACTIVE',
          roleId: (await roleOf(society.id!, 'chairman')).id!,
        },
      }),
    ).toBe(1);
  });

  it('T03-16 nobody changes their own role, status or membership', async () => {
    const { admin, a, society } = await world();
    const m = (await SocietyMember.findOne({ where: { userId: admin.id } }))!;
    const cm = (await roleOf(society.id!, 'committee_member')).id;
    for (const [method, path, body] of [
      ['patch', `/members/${m.id}`, { version: 1, roleId: cm, reason: 'Change myself' }],
      ['post', `/members/${m.id}/suspend`, { version: 1, reason: 'Suspend myself' }],
      ['delete', `/members/${m.id}`, { version: 1, reason: 'Remove myself' }],
      ['post', `/members/${m.id}/reset-mfa`, { reason: 'Reset my own' }],
    ] as const) {
      const r = await a(method, path, body);
      expect(r.status, path).toBe(403);
      expect(r.body.code).toBe('SELF_CHANGE_NOT_ALLOWED');
    }
  });

  it('T03-17 suspend takes effect on the very next request and the sockets leave the society rooms', async () => {
    const { fm, c, society } = await world();
    const left: [number, number][] = [];
    setRealtimeSink({
      emit: e => events.push(e),
      disconnectSession: () => undefined,
      leaveSocietyRooms: (u, s) => left.push([u, s]),
    });
    const f = as(await login(fm));
    expect((await f('get', '/roles')).status).toBe(200);
    const m = (await SocietyMember.findOne({ where: { userId: fm.id } }))!;
    const sus = await c('post', `/members/${m.id}/suspend`, { version: 1, reason: 'Pausing the access' });
    expect(sus.status, JSON.stringify(sus.body)).toBe(200);
    const next = await f('get', '/roles');
    expect(next.status).toBe(403);
    expect(next.body.code).toBe('MEMBERSHIP_INACTIVE');
    expect(left).toEqual([[fm.id, society.id!]]);
    expect(
      events.some(
        e =>
          e.room === `user:${fm.id}` &&
          e.event === 'access.changed' &&
          (e.payload as any).reason === 'SUSPENDED',
      ),
    ).toBe(true);
    expect(events.some(e => e.room === `society:${society.id}:admin` && e.event === 'members.changed')).toBe(
      true,
    );
    const row = (await SocietyMember.findByPk(m.id))!;
    expect(row).toMatchObject({ status: 'SUSPENDED', suspendReason: 'Pausing the access' });
    expect(await AuditLog.count({ where: { action: 'access.member.suspended' } })).toBe(1);
    // reactivate brings access back
    const re = await c('post', `/members/${m.id}/reactivate`, { version: 2, reason: 'Back again' });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect((await f('get', '/roles')).status).toBe(200);
    expect((await SocietyMember.findByPk(m.id))!.suspendedAt).toBeNull();
  });

  it('T03-18 invalid transitions are INVALID_STATE; stale version is STALE_VERSION', async () => {
    const { fm, c } = await world();
    const m = (await SocietyMember.findOne({ where: { userId: fm.id } }))!;
    const re = await c('post', `/members/${m.id}/reactivate`, { version: 1, reason: 'Already active' });
    expect(re.status).toBe(409);
    expect(re.body.code).toBe('INVALID_STATE');
    const stale = await c('post', `/members/${m.id}/suspend`, { version: 9, reason: 'Wrong version' });
    expect(stale.body.code).toBe('STALE_VERSION');
    expect((await c('delete', `/members/${m.id}`, { version: 1, reason: 'Ending the access' })).status).toBe(
      204,
    );
    const again = await c('delete', `/members/${m.id}`, { version: 2, reason: 'Ending it twice' });
    expect(again.body.code).toBe('INVALID_STATE');
    const sus = await c('post', `/members/${m.id}/suspend`, { version: 2, reason: 'Suspend an ended one' });
    expect(sus.body.code).toBe('INVALID_STATE');
    expect((await c('patch', `/members/${m.id}`, { version: 2, locationLabel: 'X' })).body.code).toBe(
      'INVALID_STATE',
    );
  });

  it('ending revokes grants, audits and returns 204; step-up is required', async () => {
    const { fm, c, society, chairman } = await world();
    const m = (await SocietyMember.findOne({ where: { userId: fm.id } }))!;
    const g = await c(
      'post',
      `/members/${m.id}/grants`,
      {
        permissionKey: 'finance.bank.import',
        endsAt: '2026-11-10T00:00:00.000Z',
        reason: 'Statutory audit work',
      },
      { headers: idem() },
    );
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    setNow('2026-11-01T04:37:00Z');
    const late = await c('delete', `/members/${m.id}`, { version: 1, reason: 'Ending the access' });
    expect(late.body.code).toBe('REAUTH_REQUIRED');
    setNow('2026-11-01T04:31:00Z');
    expect((await c('delete', `/members/${m.id}`, { version: 1, reason: 'Ending the access' })).status).toBe(
      204,
    );
    const grant = (await MemberGrant.findOne({ where: { memberId: m.id } }))!;
    expect(grant).toMatchObject({ status: 'REVOKED', revokeReason: 'MEMBERSHIP_ENDED' });
    const row = (await SocietyMember.findByPk(m.id))!;
    expect(row).toMatchObject({ status: 'ENDED', endedBy: chairman.id, endReason: 'Ending the access' });
    expect(await AuditLog.count({ where: { action: 'access.member.ended', societyId: society.id! } })).toBe(
      1,
    );
  });

  it('T03-50 moving a facility manager without MFA to treasurer revokes sessions (MFA_POLICY_CHANGED)', async () => {
    const { fm, c, society } = await world();
    await login(fm);
    const m = (await SocietyMember.findOne({ where: { userId: fm.id } }))!;
    const t = (await roleOf(society.id!, 'treasurer')).id;
    const r = await c('patch', `/members/${m.id}`, { version: 1, roleId: t, reason: 'Elected treasurer' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = (await Session.findOne({ where: { userId: fm.id } }))!;
    expect(s.revokeReason).toBe('MFA_POLICY_CHANGED');
    expect(await authAccess.userRequiresMfa(fm.id)).toBe(true);
    expect((await AuditLog.findOne({ where: { action: 'access.member.role_changed' } }))!.after).toEqual({
      roleKey: 'treasurer',
    });
  });

  it('role change rules: scope, escalation, same role, location label', async () => {
    const { society, admin, a, c, fm } = await world();
    const m = (await SocietyMember.findOne({ where: { userId: fm.id } }))!;
    const owner = (await roleOf(society.id!, 'owner')).id;
    const r1 = await c('patch', `/members/${m.id}`, { version: 1, roleId: owner, reason: 'Make them owner' });
    expect(r1.status).toBe(422);
    expect(r1.body.code).toBe('ROLE_SCOPE_NOT_ALLOWED');
    const treasurer = (await roleOf(society.id!, 'treasurer')).id;
    const r2 = await a('patch', `/members/${m.id}`, {
      version: 1,
      roleId: treasurer,
      reason: 'Elected treasurer',
    });
    expect(r2.status).toBe(403);
    expect(r2.body.code).toBe('CANNOT_GRANT_UNHELD_PERMISSION');
    const same = await c('patch', `/members/${m.id}`, {
      version: 1,
      roleId: (await roleOf(society.id!, 'facility_manager')).id,
      reason: 'Same role again',
    });
    expect(same.status).toBe(400);
    const label = await c('patch', `/members/${m.id}`, { version: 1, locationLabel: 'Office 2' });
    expect(label.status, JSON.stringify(label.body)).toBe(200);
    expect(label.body.data.locationLabel).toBe('Office 2');
    expect(label.body.data.version).toBe(2);
    const noReason = await c('patch', `/members/${m.id}`, { version: 2, roleId: treasurer });
    expect(noReason.status).toBe(400);
    void admin;
  });

  it('T03-51 an admin cannot reset the chairman MFA; the chairman can reset the admin MFA with step-up', async () => {
    const { chairman, admin, a, c } = await world();
    const cm = (await SocietyMember.findOne({ where: { userId: chairman.id } }))!;
    const am = (await SocietyMember.findOne({ where: { userId: admin.id } }))!;
    const denied = await a('post', `/members/${cm.id}/reset-mfa`, { reason: 'Locked out' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('CANNOT_GRANT_UNHELD_PERMISSION');
    const ok = await c('post', `/members/${am.id}/reset-mfa`, { reason: 'Lost the phone' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await AuditLog.count({ where: { action: 'auth.mfa.reset' } })).toBe(1);
    expect(await AuditLog.count({ where: { action: 'access.member.mfa_reset' } })).toBe(1);
    const again = await c('post', `/members/${am.id}/reset-mfa`, { reason: 'Reset it twice' });
    expect(again.body.code).toBe('INVALID_STATE');
  });

  it('revoke-sessions signs the member out everywhere and reports the count', async () => {
    const { fm, c } = await world();
    const f = as(await login(fm));
    expect((await f('get', '/roles')).status).toBe(200);
    const m = (await SocietyMember.findOne({ where: { userId: fm.id } }))!;
    const r = await c('post', `/members/${m.id}/revoke-sessions`, { reason: 'Lost device' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.revokedCount).toBe(1);
    expect((await Session.findOne({ where: { userId: fm.id } }))!.revokeReason).toBe('ADMIN_REVOKED');
    expect(await AuditLog.count({ where: { action: 'access.member.sessions_revoked' } })).toBe(1);
  });
});

describe('seats (BR-03-33, T03-54, T03-56)', () => {
  it('staff roles consume admin seats, committee roles do not; ending releases', async () => {
    const society = await makeSociety();
    const used = fakeEntitlements({ 'limit.admin_seats': 3 });
    const chairman = await memberUser(society, 'chairman');
    await memberUser(society, 'treasurer');
    await memberUser(society, 'secretary');
    expect(used['limit.admin_seats']).toBe(0);
    const a1 = await memberUser(society, 'society_admin');
    const acc = await memberUser(society, 'accountant');
    expect(used['limit.admin_seats']).toBe(2);
    const c = as(await login(chairman));
    // invite pre-check: a third staff invitation fits (3 seats), then fill the last seat
    const inv = await c(
      'post',
      '/members/invite',
      { name: 'Anil Auditor', mobile: '9820099999', roleId: (await roleOf(society.id!, 'auditor')).id },
      { headers: idem() },
    );
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const fm = await memberUser(society, 'facility_manager');
    expect(used['limit.admin_seats']).toBe(3);
    const full = await c(
      'post',
      '/members/invite',
      { name: 'Zed Auditor', mobile: '9820099998', roleId: (await roleOf(society.id!, 'auditor')).id },
      { headers: idem() },
    );
    expect(full.status).toBe(402);
    expect(full.body.code).toBe('USAGE_LIMIT_EXCEEDED');
    // committee roles are not limited
    const cm = await c(
      'post',
      '/members/invite',
      {
        name: 'Cora Committee',
        mobile: '9820099997',
        roleId: (await roleOf(society.id!, 'committee_member')).id,
      },
      { headers: idem() },
    );
    expect(cm.status, JSON.stringify(cm.body)).toBe(201);
    // role change accountant -> treasurer releases a seat; treasurer -> accountant takes one
    const m = (await SocietyMember.findOne({ where: { userId: acc.id } }))!;
    const t = (await roleOf(society.id!, 'treasurer')).id;
    const r = await c('patch', `/members/${m.id}`, { version: 1, roleId: t, reason: 'Elected treasurer' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(used['limit.admin_seats']).toBe(2);
    const m2 = (await SocietyMember.findOne({ where: { userId: a1.id } }))!;
    const accountantRole = (await roleOf(society.id!, 'accountant')).id;
    expect(
      (
        await c('patch', `/members/${m2.id}`, {
          version: 1,
          roleId: accountantRole,
          reason: 'Switch seat to seat',
        })
      ).status,
    ).toBe(200);
    expect(used['limit.admin_seats']).toBe(2); // seat to seat
    expect(
      (await c('post', `/members/${m2.id}/suspend`, { version: 2, reason: 'Suspending them' })).status,
    ).toBe(200);
    expect(used['limit.admin_seats']).toBe(2); // suspended still holds a seat
    expect((await c('delete', `/members/${m2.id}`, { version: 3, reason: 'Ending the access' })).status).toBe(
      204,
    );
    expect(used['limit.admin_seats']).toBe(1);
    void fm;
  });

  it('T03-56 a clone of committee_member holds no seat, a clone of accountant holds one', async () => {
    const society = await makeSociety();
    const chairman = await memberUser(society, 'chairman');
    const c = as(await login(chairman));
    const a = await c(
      'post',
      '/roles',
      {
        name: 'Clone one',
        scope: 'society',
        basedOnRoleId: (await roleOf(society.id!, 'committee_member')).id,
      },
      { headers: idem() },
    );
    const b = await c(
      'post',
      '/roles',
      { name: 'Clone two', scope: 'society', basedOnRoleId: (await roleOf(society.id!, 'accountant')).id },
      { headers: idem() },
    );
    expect(a.status).toBe(201);
    expect((await Role.findByPk(a.body.data.id))!.consumesSeat).toBe(false);
    expect((await Role.findByPk(b.body.data.id))!.consumesSeat).toBe(true);
  });
});

describe('service API for other modules', () => {
  it('T03-55 endAllMembersForSociety skips the chairman guard, releases seats; cancelAllPendingInvitations revokes', async () => {
    const society = await makeSociety();
    const used = fakeEntitlements({ 'limit.admin_seats': 5 });
    const ch = await memberUser(society, 'chairman');
    await memberUser(society, 'society_admin');
    await memberUser(society, 'owner', { mfa: false });
    expect(used['limit.admin_seats']).toBe(1);
    const ctx = systemCtx('close');
    await tx(async t => {
      await createInvitationCore(
        ctx,
        { societyId: society.id!, name: 'Pending One', mobile: '9820077701', roleKey: 'committee_member' },
        t,
      );
    });
    const n = await tx(t => cancelAllPendingInvitations(ctx, society.id!, 'Society closing', t));
    expect(n).toBe(1);
    const ended = await tx(t => endAllMembersForSociety(ctx, society.id!, 'Society closing', t));
    expect(ended).toBe(3);
    expect(await SocietyMember.count({ where: { societyId: society.id!, status: 'ENDED' } })).toBe(3);
    expect(used['limit.admin_seats']).toBe(0);
    expect((await SocietyMember.findOne({ where: { userId: ch.id } }))!.endedBy).toBeNull();
    expect((await Invitation.findOne({ where: { mobile: '9820077701' } }))!.status).toBe('REVOKED');
  });

  it('T03-57 changeRole via committee: resident <-> society roles, chairman hand-over order', async () => {
    const society = await makeSociety();
    const owner = await memberUser(society, 'owner', { mfa: false, name: 'Owner One' });
    const actor = await makeUser({ name: 'Committee actor' });
    const ctx = {
      ...systemCtx('committee'),
      user: {
        id: actor.id,
        name: 'Committee actor',
        mobile: null,
        email: null,
        platformRoleId: null,
        status: 'ACTIVE',
      },
    };
    await tx(t => changeRole(ctx, owner.memberId, 'treasurer', 'Elected treasurer', t, { via: 'committee' }));
    expect((await SocietyMember.findByPk(owner.memberId))!.roleId).toBe(
      (await roleOf(society.id!, 'treasurer')).id,
    );
    await tx(t => changeRole(ctx, owner.memberId, 'owner', 'Term ended', t, { via: 'committee' }));
    expect((await SocietyMember.findByPk(owner.memberId))!.roleId).toBe(
      (await roleOf(society.id!, 'owner')).id,
    );
    // hand-over: new chairman first, then the old one
    const oldChair = await memberUser(society, 'chairman', { name: 'Old chair' });
    const incoming = await memberUser(society, 'owner', { mfa: false, name: 'Incoming' });
    await tx(async t => {
      await changeRole(ctx, incoming.memberId, 'chairman', 'Elected chairman', t, { via: 'committee' });
      await changeRole(ctx, oldChair.memberId, 'owner', 'Term ended', t, { via: 'committee' });
    });
    expect((await SocietyMember.findByPk(oldChair.memberId))!.roleId).toBe(
      (await roleOf(society.id!, 'owner')).id,
    );
    // the wrong order: old chairman first is LAST_CHAIRMAN
    await tx(async t => {
      await changeRole(ctx, oldChair.memberId, 'chairman', 'Back again', t, { via: 'committee' });
    });
    await tx(t => changeRole(ctx, incoming.memberId, 'owner', 'Step down', t, { via: 'committee' }));
    const err = await tx(t =>
      changeRole(ctx, oldChair.memberId, 'owner', 'Step down too', t, { via: 'committee' }),
    ).catch(e => e);
    expect(err.code).toBe('LAST_CHAIRMAN');
  });

  it('endMember via committee skips not-self but keeps the chairman guard', async () => {
    const society = await makeSociety();
    const ch = await memberUser(society, 'chairman');
    const staff = await memberUser(society, 'accountant');
    const ctx = {
      ...systemCtx('committee'),
      user: { id: ch.id, name: 'x', mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' },
    };
    const err = await tx(t => endMember(ctx, ch.memberId, 'Term ended', t, { via: 'committee' })).catch(
      e => e,
    );
    expect(err.code).toBe('LAST_CHAIRMAN');
    await tx(t => endMember(ctx, staff.memberId, 'Left', t));
    expect((await SocietyMember.findByPk(staff.memberId))!.status).toBe('ENDED');
  });

  it('createInitialMember: chairman and society admin, ALREADY_MEMBER, ENDED row reused', async () => {
    const society = await makeSociety();
    const u = await makeUser();
    const m = await tx(t =>
      createInitialMember(
        systemCtx('prov'),
        { societyId: society.id!, userId: u.id, roleKey: 'chairman' },
        t,
      ),
    );
    expect(m.status).toBe('ACTIVE');
    const err = await tx(t =>
      createInitialMember(
        systemCtx('prov'),
        { societyId: society.id!, userId: u.id, roleKey: 'society_admin' },
        t,
      ),
    ).catch(e => e);
    expect(err.code).toBe('ALREADY_MEMBER');
    expect(await AuditLog.count({ where: { action: 'access.member.joined' } })).toBe(1);
    void join;
  });
});

describe('members export (8.8, T03-44)', () => {
  it('masks mobiles without residents.contacts.view and audits the export', async () => {
    const { c, society, chairman } = await world();
    const role = await c(
      'post',
      '/roles',
      {
        name: 'Roster only',
        scope: 'society',
        permissionKeys: ['settings.members.view', 'settings.members.export', 'dashboard.today.view'],
      },
      { headers: idem() },
    );
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const roster = await memberUser(society, 'committee_member', { name: 'Roster Clerk', mfa: true });
    await SocietyMember.update({ roleId: role.body.data.id }, { where: { id: roster.memberId } });
    const r = await as(await login(roster))('get', '/members/export');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.rowCount).toBe(5);
    const csv = placeholderExports.get(r.body.data.fileId)!.content;
    expect(csv.split('\r\n')[0]).toBe('Name,Mobile,Email,Role,Status,Flat or office,MFA,Joined,Last sign in');
    expect(csv).not.toContain(chairman.mobile);
    expect(csv).toMatch(/\d\dXXXXX\d{3}/);
    expect(await AuditLog.count({ where: { action: 'access.member.exported' } })).toBe(1);
    const full = await c('get', '/members/export');
    expect(placeholderExports.get(full.body.data.fileId)!.content).toContain(chairman.mobile);
  });
});
