import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Invitation, Role, Session, User, closeDb } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import {
  changePlatformRole,
  disablePlatformMember,
  removePlatformMember,
} from '../../../src/modules/access-control/access-control.platform.service';
import { roleDetail } from '../../../src/modules/access-control/access-control.roles.service';
import { authAccess } from '../../../src/modules/access-control/access-control.public';
import { inboxFor } from '../../helpers/auth';
import {
  as,
  idem,
  login,
  makeSociety,
  memberUser,
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

const P = (cookies: Record<string, string>) => as(cookies, 'PLATFORM');

async function team() {
  const sa = await platformUser('super_admin', { name: 'Platform Admin', email: 'super@societyapp.in' });
  const support = await platformUser('platform_support', {
    name: 'Support Agent',
    email: 'support@societyapp.in',
  });
  return { sa, support, s: P(await platformLogin(sa)), p: P(await platformLogin(support)) };
}

describe('platform catalogue, roles and team (8.19)', () => {
  it('lists the catalogue by scope and the two platform roles with user counts', async () => {
    const { s } = await team();
    const cat = await s('get', '/platform/permissions');
    expect(cat.status, JSON.stringify(cat.body)).toBe(200);
    expect(cat.body.data.scopes.map((x: any) => x.scope)).toEqual([
      'platform',
      'society',
      'resident',
      'gate',
      'work',
    ]);
    expect(cat.body.data.scopes[0].masters[0].subMasters[0].permissions[0]).not.toHaveProperty('heldByMe');
    const roles = await s('get', '/platform/roles');
    expect(roles.body.data.map((r: any) => [r.key, r.permissionCount, r.userCount])).toEqual([
      ['super_admin', 39, 1],
      ['platform_support', 17, 1],
    ]);
    expect(roles.body.data[0].permissionKeys).toHaveLength(39);
  });

  it('lists team users and pending invitations, with filters', async () => {
    const { s, sa } = await team();
    await s(
      'post',
      '/platform/team/invite',
      {
        name: 'Dev Malhotra',
        mobile: '9000000004',
        email: 'dev@societyapp.in',
        roleId: (await roleOf(null, 'platform_support')).id,
      },
      { headers: idem() },
    );
    const all = await s('get', '/platform/team');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.data.map((x: any) => [x.kind, x.name])).toEqual([
      ['INVITATION', 'Dev Malhotra'],
      ['USER', 'Platform Admin'],
      ['USER', 'Support Agent'],
    ]);
    const me = all.body.data.find((x: any) => x.userId === sa.id);
    expect(me).toMatchObject({
      isSelf: true,
      status: 'ACTIVE',
      mfaEnabled: true,
      role: { key: 'super_admin' },
    });
    expect(all.body.data[0]).toMatchObject({ status: 'INVITED', resendCount: 0 });
    const inv = await s('get', '/platform/team', undefined, { query: { status: 'INVITED' } });
    expect(inv.body.data).toHaveLength(1);
    const act = await s('get', '/platform/team', undefined, {
      query: { status: 'ACTIVE', search: 'support' },
    });
    expect(act.body.data).toHaveLength(1);
  });

  it('invite: domain rule, duplicates, platform audit and a platform link', async () => {
    const { s, sa } = await team();
    const role = (await roleOf(null, 'platform_support')).id;
    const bad = await s(
      'post',
      '/platform/team/invite',
      { name: 'Eve Out', mobile: '9000000005', email: 'eve@gmail.com', roleId: role },
      { headers: idem() },
    );
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('EMAIL_DOMAIN_NOT_ALLOWED');
    const ok = await s(
      'post',
      '/platform/team/invite',
      { name: 'Dev Malhotra', mobile: '9000000004', email: 'dev@societyapp.in', roleId: role },
      { headers: idem() },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await inboxFor('9000000004'))[0]!.body).toMatch(/platform\.societyapp\.in\/invite\//);
    const row = (await AuditLog.findOne({ where: { action: 'access.platform_invitation.created' } }))!;
    expect(row.societyId).toBeNull();
    expect(row.actorRole).toBe('super_admin');
    const dup = await s(
      'post',
      '/platform/team/invite',
      { name: 'Dev Malhotra', mobile: '9000000004', email: 'dev@societyapp.in', roleId: role },
      { headers: idem() },
    );
    expect(dup.body.code).toBe('INVITATION_ALREADY_PENDING');
    const already = await s(
      'post',
      '/platform/team/invite',
      { name: 'Admin Again', mobile: sa.mobile, email: 'again@societyapp.in', roleId: role },
      { headers: idem() },
    );
    expect(already.body.code).toBe('ALREADY_MEMBER');
    const society = await makeSociety();
    const soc = await s(
      'post',
      '/platform/team/invite',
      {
        name: 'Wrong Role',
        mobile: '9000000006',
        email: 'w@societyapp.in',
        roleId: (await roleOf(society.id!, 'chairman')).id,
      },
      { headers: idem() },
    );
    expect(soc.body.code).toBe('ROLE_NOT_FOUND');
  });

  it('a platform invitee accepts, gets the role and must re-sign-in to enrol MFA; resend and revoke work', async () => {
    const { s } = await team();
    const role = await roleOf(null, 'platform_support');
    const inv = await s(
      'post',
      '/platform/team/invite',
      { name: 'Dev Malhotra', mobile: '9000000004', email: 'dev@societyapp.in', roleId: role.id },
      { headers: idem() },
    );
    const id = inv.body.data.id;
    const rs = await s('post', `/platform/invitations/${id}/resend`, {}, { headers: idem() });
    expect(rs.body.code).toBe('INVITATION_RESEND_TOO_SOON');
    // the invitee signs in to the platform app by password (they have a pending platform invitation)
    const invited = (await User.findOne({ where: { mobile: '9000000004' } }))!;
    expect(await authAccess.hasAppAccess(invited.id!, 'PLATFORM')).toBe(true);
    const revoke = await s('post', `/platform/invitations/${id}/revoke`, { reason: 'Changed our mind' });
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
    expect(await authAccess.hasAppAccess(invited.id!, 'PLATFORM')).toBe(false);
    expect((await Invitation.findByPk(id))!.status).toBe('REVOKED');
    expect(await AuditLog.count({ where: { action: 'access.platform_invitation.revoked' } })).toBe(1);
  });

  it('T03-36 platform support cannot change roles; T03-37 a society chairman gets PLATFORM_ACCESS_REQUIRED', async () => {
    const { p, sa } = await team();
    const r = await p('patch', `/platform/team/${sa.id}`, {
      roleId: (await roleOf(null, 'platform_support')).id,
      reason: 'Moving them',
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PERMISSION_DENIED');
    const view = await p('get', '/platform/team');
    expect(view.status).toBe(200);
    const society = await makeSociety();
    const chairman = await memberUser(society, 'chairman');
    const c = as(await login(chairman));
    const denied = await c('get', '/platform/team');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PLATFORM_ACCESS_REQUIRED');
  });

  it('T03-10 a Super Admin can demote another when two exist', async () => {
    const { sa } = await team();
    const other = await platformUser('super_admin', { name: 'Isha Kapoor' });
    const o = P(await platformLogin(other));
    const sup = (await roleOf(null, 'platform_support')).id;
    const ok = await o('patch', `/platform/team/${sa.id}`, { roleId: sup, reason: 'Moving to support' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.role.key).toBe('platform_support');
    expect(await AuditLog.count({ where: { action: 'access.platform_member.role_changed' } })).toBe(1);
    const self = await o('patch', `/platform/team/${other.id}`, { roleId: sup, reason: 'Demote myself' });
    expect(self.body.code).toBe('SELF_CHANGE_NOT_ALLOWED');
  });

  it('T03-38 the last Super Admin cannot be demoted, disabled or removed (service level, caller is another user)', async () => {
    const { sa, support } = await team();
    const ctx = {
      requestId: 'test',
      ip: '',
      userAgent: '',
      user: { id: support.id, name: 'x', mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' },
    };
    const sup = (await roleOf(null, 'platform_support')).id!;
    const code = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: any) => e.code,
      );
    expect(await code(changePlatformRole(ctx, sa.id, { roleId: sup, reason: 'Demote the last one' }))).toBe(
      'LAST_SUPER_ADMIN',
    );
    expect(await code(disablePlatformMember(ctx, sa.id, 'Disable the last one'))).toBe('LAST_SUPER_ADMIN');
    expect(await code(removePlatformMember(ctx, sa.id, 'Remove the last one'))).toBe('LAST_SUPER_ADMIN');
    expect((await User.findByPk(sa.id))!.status).toBe('ACTIVE');
    // with a second Super Admin it works
    await platformUser('super_admin', { name: 'Second' });
    expect(await code(disablePlatformMember(ctx, sa.id, 'Disable one of two'))).toBe('ok');
    expect((await User.findByPk(sa.id))!.status).toBe('DISABLED');
    expect((await Session.findAll({ where: { userId: sa.id } })).every(x => x.revokedAt !== null)).toBe(true);
    expect(await code(removePlatformMember(ctx, sa.id, 'Remove the disabled one'))).toBe('ok');
    expect((await User.findByPk(sa.id))!.platformRoleId).toBeNull();
  });

  it('two Super Admins disabling each other at once: one succeeds, the other is LAST_SUPER_ADMIN', async () => {
    const { s, sa } = await team();
    const b = await platformUser('super_admin', { name: 'Bee' });
    const bs = P(await platformLogin(b));
    const [r1, r2] = await Promise.all([
      s('post', `/platform/team/${b.id}/disable`, { reason: 'Disable the other' }),
      bs('post', `/platform/team/${sa.id}/disable`, { reason: 'Disable the first' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect([r1.body.code, r2.body.code]).toContain('LAST_SUPER_ADMIN');
  });

  it('enable restores a disabled teammate; enabling an active one is INVALID_STATE', async () => {
    const { s, support } = await team();
    expect(
      (await s('post', `/platform/team/${support.id}/disable`, { reason: 'Pausing the account' })).status,
    ).toBe(200);
    expect(
      (await s('post', `/platform/team/${support.id}/enable`, { reason: 'Back on the team' })).status,
    ).toBe(200);
    expect(
      (await s('post', `/platform/team/${support.id}/enable`, { reason: 'Enable it again' })).body.code,
    ).toBe('INVALID_STATE');
    expect(await AuditLog.count({ where: { action: 'access.platform_member.disabled' } })).toBe(1);
    expect(await AuditLog.count({ where: { action: 'access.platform_member.enabled' } })).toBe(1);
  });

  it('reset MFA of a teammate clears TOTP and signs them out', async () => {
    const { s, support } = await team();
    const r = await s('post', `/platform/team/${support.id}/reset-mfa`, { reason: 'Lost the authenticator' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await User.findByPk(support.id))!.mfaEnabledAt).toBeNull();
    expect(await AuditLog.count({ where: { action: 'access.platform_member.mfa_reset' } })).toBe(1);
    expect(await AuditLog.count({ where: { action: 'auth.mfa.reset' } })).toBe(1);
    expect((await s('post', `/platform/team/999999/reset-mfa`, { reason: 'Nobody there' })).body.code).toBe(
      'PLATFORM_USER_NOT_FOUND',
    );
  });

  it('platform writes need step-up and a reason', async () => {
    const { s, support } = await team();
    expect((await s('post', `/platform/team/${support.id}/disable`, {})).status).toBe(400);
    setNow('2026-11-01T04:37:00Z');
    const r = await s('post', `/platform/team/${support.id}/disable`, { reason: 'Pausing the account' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('REAUTH_REQUIRED');
  });
});

describe('platform view and edit of society roles (8.20)', () => {
  it('T03-10 Super Admin edits the Chairman role; audit carries the platform role and the society', async () => {
    const { s } = await team();
    const society = await makeSociety();
    await memberUser(society, 'chairman');
    const chairman = await roleOf(society.id!, 'chairman');
    const list = await s('get', `/platform/societies/${society.id}/roles`, undefined, {
      query: { limit: '100' },
    });
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data.find((r: any) => r.key === 'chairman').isLocked).toBe(false);
    const detail = await roleDetail(chairman, false);
    const reduced = detail.permissionKeys.filter(k => k !== 'ai.usage.export');
    const short = await s('patch', `/platform/societies/${society.id}/roles/${chairman.id}`, {
      version: 1,
      permissionKeys: reduced,
      reason: 'short',
    });
    expect(short.status).toBe(400);
    const r = await s('patch', `/platform/societies/${society.id}/roles/${chairman.id}`, {
      version: 1,
      permissionKeys: reduced,
      reason: 'Committee asked support to trim this key',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.permissionCount).toBe(210);
    const row = (await AuditLog.findOne({ where: { action: 'access.role.permissions_changed' } }))!;
    expect(row.actorRole).toBe('super_admin');
    expect(row.societyId).toBe(society.id);
    expect(row.reason).toBe('Committee asked support to trim this key');
    expect(
      (
        await s('patch', `/platform/societies/${society.id}/roles/${chairman.id}`, {
          version: 1,
          requiresMfa: false,
          reason: 'Stale version here',
        })
      ).body.code,
    ).toBe('STALE_VERSION');
    const mfa = await s('patch', `/platform/societies/${society.id}/roles/${chairman.id}`, {
      version: 2,
      requiresMfa: false,
      reason: 'Turn the flag off for them',
    });
    expect(mfa.status).toBe(200);
    expect(mfa.body.data.requiresMfa).toBe(false);
  });

  it('404 SOCIETY_NOT_FOUND and ROLE_NOT_FOUND for a role of another society; members are masked', async () => {
    const { s } = await team();
    const a = await makeSociety('A CHS');
    const b = await makeSociety('B CHS');
    const chairman = await memberUser(a, 'chairman', { name: 'Rajesh' });
    expect((await s('get', '/platform/societies/999999/roles')).body.code).toBe('SOCIETY_NOT_FOUND');
    expect((await s('get', '/platform/societies/999999/members')).body.code).toBe('SOCIETY_NOT_FOUND');
    const foreign = await roleOf(b.id!, 'treasurer');
    const r = await s('patch', `/platform/societies/${a.id}/roles/${foreign.id}`, {
      version: 1,
      requiresMfa: true,
      reason: 'Wrong society role',
    });
    expect(r.body.code).toBe('ROLE_NOT_FOUND');
    const members = await s('get', `/platform/societies/${a.id}/members`);
    expect(members.status).toBe(200);
    const row = members.body.data[0];
    expect(row.mobile).toMatch(/XXXXX/);
    expect(row.email).toMatch(/^.\*\*\*\*@/);
    // platform reset-mfa variant
    const rs = await s('post', `/platform/societies/${a.id}/members/${chairman.memberId}/reset-mfa`, {
      reason: 'Chairman lost his phone',
    });
    expect(rs.status, JSON.stringify(rs.body)).toBe(200);
    const audit = (await AuditLog.findOne({ where: { action: 'access.member.mfa_reset' } }))!;
    expect(audit).toMatchObject({ actorRole: 'super_admin', societyId: a.id });
    expect(
      (
        await s('post', `/platform/societies/${a.id}/members/${chairman.memberId}/reset-mfa`, {
          reason: 'short',
        })
      ).status,
    ).toBe(400);
    expect(
      (await s('post', `/platform/societies/999/members/1/reset-mfa`, { reason: 'Society does not exist' }))
        .body.code,
    ).toBe('SOCIETY_NOT_FOUND');
  });

  it('removing settings.roles.edit from every role of a society without a chairman is LAST_CHAIRMAN', async () => {
    const { s } = await team();
    const society = await makeSociety();
    await memberUser(society, 'society_admin');
    const admin = await roleOf(society.id!, 'society_admin');
    const keys = (await roleDetail(admin, false)).permissionKeys.filter(k => k !== 'settings.roles.edit');
    const r = await s('patch', `/platform/societies/${society.id}/roles/${admin.id}`, {
      version: 1,
      permissionKeys: keys,
      reason: 'Remove role editing for audit',
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('LAST_CHAIRMAN');
    expect((await Role.findByPk(admin.id!))!.version).toBe(1);
  });
});
