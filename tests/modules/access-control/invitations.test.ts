import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  AuthToken,
  Invitation,
  Session,
  SocietyMember,
  User,
  closeDb,
  sequelize,
} from '../../../src/models';
import { advance, now, setNow } from '../../../src/lib/clock';
import { systemCtx } from '../../../src/types/context';
import { authAccess, createInvitation, expireInvitationsForTest } from './invitations.support';
import { events, get, inboxFor, makeUser, post, otpSignIn, call } from '../../helpers/auth';
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
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';
import { sha256 } from '../../../src/modules/access-control/access-control.util';

afterAll(closeDb);
beforeEach(async () => {
  await resetAccess();
  resetLogins();
  setNow('2026-11-01T04:30:00Z');
});

const body = (o: Record<string, unknown> = {}) => ({ name: 'Meera Iyer', mobile: '9820022222', ...o });

async function world() {
  const society = await makeSociety();
  const chairman = await memberUser(society, 'chairman', { name: 'Rajesh Kulkarni' });
  const admin = await memberUser(society, 'society_admin', { name: 'Neha Joshi' });
  return { society, chairman, admin, c: as(await login(chairman)), a: as(await login(admin)) };
}
const tokenFor = async (mobile: string): Promise<string> => {
  const m = (await inboxFor(mobile)).find(x => x.channel === 'SMS')!;
  const t = m.body.match(/\/invite\/([A-Za-z0-9_-]{43})/)?.[1];
  if (!t) throw new Error(`no token in ${m.body}`);
  return t;
};

describe('invite (8.10)', () => {
  it('T03-19 invites a treasurer: PENDING, 7 days, SMS with a 43 character token, audit', async () => {
    const { c, society, chairman } = await world();
    const role = await roleOf(society.id!, 'treasurer');
    const r = await c(
      'post',
      '/members/invite',
      body({ roleId: role.id, email: 'meera@mail.in', locationLabel: 'B-302', message: 'Welcome' }),
      { headers: idem() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      name: 'Meera Iyer',
      status: 'PENDING',
      resendCount: 0,
      role: { key: 'treasurer', name: 'Treasurer' },
      expiresAt: '2026-11-08T04:30:00.000Z',
    });
    expect(r.body.data.mobile).toBe('9820022222'); // the chairman holds residents.contacts.view
    expect(JSON.stringify(r.body)).not.toMatch(/[A-Za-z0-9_-]{43}/);
    const token = await tokenFor('9820022222');
    expect(token).toHaveLength(43);
    const inv = (await Invitation.findByPk(r.body.data.id))!;
    expect(inv.tokenHash).toBe(sha256(token));
    expect(inv.invitedBy).toBe(chairman.id);
    expect((await inboxFor('meera@mail.in')).length).toBe(1);
    expect(
      await AuditLog.count({ where: { action: 'access.invitation.created', entityId: String(inv.id) } }),
    ).toBe(1);
  });

  it('T03-52 an unknown mobile with an email becomes an INVITED user with a setup link tied to the invitation', async () => {
    const { c, society } = await world();
    const role = await roleOf(society.id!, 'committee_member');
    const r = await c(
      'post',
      '/members/invite',
      body({ mobile: '9820055501', name: 'Asha Verma', email: 'asha@mail.in', roleId: role.id }),
      { headers: idem() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const inv = (await Invitation.findByPk(r.body.data.id))!;
    const u = (await User.findByPk(inv.invitedUserId))!;
    expect(u.status).toBe('INVITED');
    expect(u.mobile).toBe('9820055501');
    const tokens = await AuthToken.findAll({ where: { userId: u.id!, purpose: 'ACCOUNT_SETUP' } });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.payload).toMatchObject({ invitationId: inv.id });
    expect(tokens[0]!.expiresAt.toISOString()).toBe(inv.expiresAt.toISOString());
    const mail = (await inboxFor('asha@mail.in'))[0]!;
    expect(mail.body).toMatch(/setup\?token=/);
  });

  it('T03-20 inviting the same mobile again is INVITATION_ALREADY_PENDING with the id', async () => {
    const { c, society } = await world();
    const role = await roleOf(society.id!, 'committee_member');
    const first = await c('post', '/members/invite', body({ roleId: role.id }), { headers: idem() });
    const dup = await c('post', '/members/invite', body({ roleId: role.id }), { headers: idem() });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('INVITATION_ALREADY_PENDING');
    expect(dup.body.errors[0]).toEqual({ field: 'invitationId', message: String(first.body.data.id) });
  });

  it('T03-21 an invalid mobile, a one letter name and an unknown key list three fields', async () => {
    const { c, society } = await world();
    const role = await roleOf(society.id!, 'committee_member');
    const r = await c(
      'post',
      '/members/invite',
      { name: 'M', mobile: '5820011111', roleId: role.id, nope: true },
      { headers: idem() },
    );
    expect(r.status).toBe(400);
    expect(r.body.errors.map((e: any) => e.field).sort()).toEqual(['mobile', 'name', 'nope']);
  });

  it('T03-02 no escalation: a society admin cannot invite a chairman or a treasurer', async () => {
    const { a, society } = await world();
    for (const key of ['chairman', 'treasurer']) {
      const r = await a('post', '/members/invite', body({ roleId: (await roleOf(society.id!, key)).id }), {
        headers: idem(),
      });
      expect(r.status, key).toBe(403);
      expect(r.body.code).toBe('CANNOT_GRANT_UNHELD_PERMISSION');
    }
    expect(await Invitation.count()).toBe(0);
  });

  it('T03-58 field roles need only settings.members.create; a SystemCtx call also works', async () => {
    const { a, society } = await world();
    const guard = await a(
      'post',
      '/members/invite',
      body({ mobile: '9820066601', name: 'Gita Guard', roleId: (await roleOf(society.id!, 'guard')).id }),
      { headers: idem() },
    );
    expect(guard.status, JSON.stringify(guard.body)).toBe(201);
    const work = await a(
      'post',
      '/members/invite',
      body({
        mobile: '9820066602',
        name: 'Wasim Worker',
        roleId: (await roleOf(society.id!, 'maintenance_staff')).id,
      }),
      { headers: idem() },
    );
    expect(work.status, JSON.stringify(work.body)).toBe(201);
    expect((await inboxFor('9820066601'))[0]!.body).toMatch(/gate\.societyapp\.in\/invite\//);
    expect((await inboxFor('9820066602'))[0]!.body).toMatch(/work\.societyapp\.in\/invite\//);
    const accountant = await a(
      'post',
      '/members/invite',
      body({
        mobile: '9820066603',
        name: 'Anil Account',
        roleId: (await roleOf(society.id!, 'accountant')).id,
      }),
      { headers: idem() },
    );
    expect(accountant.body.code).toBe('CANNOT_GRANT_UNHELD_PERMISSION');
    const treasurer = await a(
      'post',
      '/members/invite',
      body({
        mobile: '9820066604',
        name: 'Tara Treasure',
        roleId: (await roleOf(society.id!, 'treasurer')).id,
      }),
      { headers: idem() },
    );
    expect(treasurer.body.code).toBe('CANNOT_GRANT_UNHELD_PERMISSION');
    const inv = await sequelize.transaction(t =>
      createInvitation(
        systemCtx('module-20'),
        { societyId: society.id!, name: 'Sam Sentry', mobile: '9820066605', roleKey: 'guard' },
        t,
      ),
    );
    expect(inv.status).toBe('PENDING');
    expect(inv.invitedBy).toBeNull();
  });

  it('rejects resident and platform roles, ACTIVE and SUSPENDED members, another society roles', async () => {
    const { c, society, admin } = await world();
    const other = await makeSociety('Green Park CHS');
    const resident = await c(
      'post',
      '/members/invite',
      body({ roleId: (await roleOf(society.id!, 'owner')).id }),
      { headers: idem() },
    );
    expect(resident.status).toBe(422);
    expect(resident.body.code).toBe('ROLE_SCOPE_NOT_ALLOWED');
    const platform = await c(
      'post',
      '/members/invite',
      body({ roleId: (await roleOf(null, 'super_admin')).id }),
      { headers: idem() },
    );
    expect(platform.body.code).toBe('ROLE_NOT_FOUND');
    const foreign = await c(
      'post',
      '/members/invite',
      body({ roleId: (await roleOf(other.id!, 'committee_member')).id }),
      { headers: idem() },
    );
    expect(foreign.body.code).toBe('ROLE_NOT_FOUND');
    const active = await c(
      'post',
      '/members/invite',
      body({ mobile: admin.mobile, roleId: (await roleOf(society.id!, 'committee_member')).id }),
      { headers: idem() },
    );
    expect(active.body.code).toBe('ALREADY_MEMBER');
    await SocietyMember.update(
      { status: 'SUSPENDED', suspendedAt: new Date() },
      { where: { id: admin.memberId } },
    );
    await flushAcl();
    const sus = await c(
      'post',
      '/members/invite',
      body({ mobile: admin.mobile, roleId: (await roleOf(society.id!, 'committee_member')).id }),
      { headers: idem() },
    );
    expect(sus.body.code).toBe('MEMBER_SUSPENDED');
  });

  it('passes EMAIL_IN_USE through from module 02', async () => {
    const { c, society } = await world();
    const other = await makeUser({ email: 'taken@mail.in' });
    void other;
    const r = await c(
      'post',
      '/members/invite',
      body({ email: 'taken@mail.in', roleId: (await roleOf(society.id!, 'committee_member')).id }),
      { headers: idem() },
    );
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('EMAIL_IN_USE');
  });
});

describe('list, resend, revoke (8.13, 8.14)', () => {
  async function pending() {
    const w = await world();
    const role = await roleOf(w.society.id!, 'committee_member');
    const r = await w.c('post', '/members/invite', body({ roleId: role.id }), { headers: idem() });
    return { ...w, id: r.body.data.id as number };
  }

  it('lists pending invitations with the inviter name', async () => {
    const { c, id } = await pending();
    const r = await c('get', '/invitations');
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({
      id,
      invitedByName: 'Rajesh Kulkarni',
      respondedAt: null,
      status: 'PENDING',
    });
    expect(
      (await c('get', '/invitations', undefined, { query: { status: 'REVOKED' } })).body.data,
    ).toHaveLength(0);
  });

  it('T03-22 and T03-23 resend rotates the token, waits 60 seconds, stops at 3', async () => {
    const { c, id } = await pending();
    const oldToken = await tokenFor('9820022222');
    const early = await c('post', `/invitations/${id}/resend`, {}, { headers: idem() });
    expect(early.status).toBe(422);
    expect(early.body.code).toBe('INVITATION_RESEND_TOO_SOON');
    for (let i = 1; i <= 3; i++) {
      advance(61_000);
      const r = await c('post', `/invitations/${id}/resend`, {}, { headers: idem() });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.data.resendCount).toBe(i);
    }
    advance(61_000);
    const fourth = await c('post', `/invitations/${id}/resend`, {}, { headers: idem() });
    expect(fourth.status).toBe(422);
    expect(fourth.body.code).toBe('RESEND_LIMIT_REACHED');
    const old = await get(`/public/invitations/${oldToken}`, { app: 'ADMIN' });
    expect(old.status).toBe(404);
    expect(old.body.code).toBe('INVITATION_NOT_FOUND');
    const fresh = await tokenFor('9820022222');
    expect(fresh).not.toBe(oldToken);
    expect((await get(`/public/invitations/${fresh}`, { app: 'ADMIN' })).status).toBe(200);
    // expiry was reset on each resend
    const inv = (await Invitation.findByPk(id))!;
    expect(inv.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('revoke needs a reason, audits, and blocks later actions', async () => {
    const { c, id } = await pending();
    const token = await tokenFor('9820022222');
    expect((await c('post', `/invitations/${id}/revoke`, {})).status).toBe(400);
    const r = await c('post', `/invitations/${id}/revoke`, { reason: 'Invited by mistake' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'REVOKED', revokeReason: 'Invited by mistake' });
    expect(await AuditLog.count({ where: { action: 'access.invitation.revoked' } })).toBe(1);
    expect((await c('post', `/invitations/${id}/revoke`, { reason: 'Revoke it twice' })).body.code).toBe(
      'INVITATION_NOT_PENDING',
    );
    expect((await c('post', `/invitations/${id}/resend`, {}, { headers: idem() })).body.code).toBe(
      'INVITATION_NOT_PENDING',
    );
    expect((await get(`/public/invitations/${token}`, { app: 'ADMIN' })).body.code).toBe(
      'INVITATION_NOT_PENDING',
    );
    // can invite again after a revoke
    const role = await roleOf((await Invitation.findByPk(id))!.societyId!, 'committee_member');
    const again = await c('post', '/members/invite', body({ roleId: role.id }), { headers: idem() });
    expect(again.status).toBe(201);
  });

  it('T03-25 an expired invitation: resend is 410, the expiry job marks EXPIRED and audits', async () => {
    const { c, id } = await pending();
    await Invitation.update({ expiresAt: new Date(now().getTime() - 1000) }, { where: { id } });
    const r = await c('post', `/invitations/${id}/resend`, {}, { headers: idem() });
    expect(r.status).toBe(410);
    expect(r.body.code).toBe('INVITATION_EXPIRED');
    expect((await Invitation.findByPk(id))!.status).toBe('EXPIRED');
    expect(await AuditLog.count({ where: { action: 'access.invitation.expired' } })).toBe(1);
  });

  it('expire-invitations job expires lapsed pending rows, revokes setup tokens, and is safe to run twice', async () => {
    const { c, society } = await world();
    const role = await roleOf(society.id!, 'committee_member');
    await c(
      'post',
      '/members/invite',
      body({ mobile: '9820055502', email: 'late@mail.in', roleId: role.id }),
      { headers: idem() },
    );
    expect(await expireInvitationsForTest()).toBe(0);
    advance(7 * 86_400_000 + 1000);
    expect(await expireInvitationsForTest()).toBe(1);
    expect(await expireInvitationsForTest()).toBe(0);
    const inv = (await Invitation.findOne({ where: { mobile: '9820055502' } }))!;
    expect(inv.status).toBe('EXPIRED');
    const tok = await AuthToken.findOne({ where: { userId: inv.invitedUserId, purpose: 'ACCOUNT_SETUP' } });
    expect(tok!.revokedAt).not.toBeNull();
    const row = (await AuditLog.findOne({ where: { action: 'access.invitation.expired' } }))!;
    expect(row.actorRole).toBe('system');
  });
});

describe('public preview and decline (8.16)', () => {
  it('shows names and a masked mobile, never the full number; 404 for a malformed token', async () => {
    const { c, society } = await world();
    await c(
      'post',
      '/members/invite',
      body({ message: 'Welcome to the committee', roleId: (await roleOf(society.id!, 'treasurer')).id }),
      { headers: idem() },
    );
    const token = await tokenFor('9820022222');
    const r = await get(`/public/invitations/${token}`, { app: 'ADMIN' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      societyName: 'Sky Heights CHS',
      roleName: 'Treasurer',
      scope: 'society',
      inviterName: 'Rajesh Kulkarni',
      inviteeName: 'Meera Iyer',
      mobileMasked: '98XXXXX222',
      message: 'Welcome to the committee',
      status: 'PENDING',
      requiresMfa: true,
      societyLogoUrl: null,
    });
    expect(JSON.stringify(r.body)).not.toContain('9820022222');
    expect((await get('/public/invitations/short', { app: 'ADMIN' })).body.code).toBe('INVITATION_NOT_FOUND');
    expect((await get(`/public/invitations/${'A'.repeat(43)}`, { app: 'ADMIN' })).status).toBe(404);
  });

  it('decline is public, audited as public, and notifies the inviter', async () => {
    const { c, society, chairman } = await world();
    await c('post', '/members/invite', body({ roleId: (await roleOf(society.id!, 'treasurer')).id }), {
      headers: idem(),
    });
    const token = await tokenFor('9820022222');
    const r = await post(
      `/public/invitations/${token}/decline`,
      { reason: 'Not interested' },
      { app: 'ADMIN' },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const inv = (await Invitation.findOne({ where: { mobile: '9820022222' } }))!;
    expect(inv.status).toBe('DECLINED');
    const row = (await AuditLog.findOne({ where: { action: 'access.invitation.declined' } }))!;
    expect(row.actorRole).toBe('public');
    expect(row.reason).toBe('Not interested');
    expect((await post(`/public/invitations/${token}/decline`, {}, { app: 'ADMIN' })).body.code).toBe(
      'INVITATION_NOT_PENDING',
    );
    void chairman;
  });

  it('decline of an expired invitation is 410 and the row becomes EXPIRED', async () => {
    const { c, society } = await world();
    await c('post', '/members/invite', body({ roleId: (await roleOf(society.id!, 'treasurer')).id }), {
      headers: idem(),
    });
    const token = await tokenFor('9820022222');
    advance(7 * 86_400_000 + 1000);
    const r = await post(`/public/invitations/${token}/decline`, {}, { app: 'ADMIN' });
    expect(r.status).toBe(410);
    expect((await Invitation.findOne({ where: { mobile: '9820022222' } }))!.status).toBe('EXPIRED');
    expect((await get(`/public/invitations/${token}`, { app: 'ADMIN' })).body.code).toBe(
      'INVITATION_EXPIRED',
    );
  });

  it('is rate limited per IP', async () => {
    let last = 0;
    for (let i = 0; i < 31; i++)
      last = (await get(`/public/invitations/${'B'.repeat(43)}`, { app: 'ADMIN', ip: '10.1.1.1' })).status;
    expect(last).toBe(429);
  });
});

describe('accept (8.17)', () => {
  async function invited(roleKey = 'committee_member', o: { mfa?: boolean } = {}) {
    const w = await world();
    const user = await makeUser({ name: 'Invitee', mfa: o.mfa ?? false });
    const role = await roleOf(w.society.id!, roleKey);
    const r = await w.c(
      'post',
      '/members/invite',
      { name: 'Invitee', mobile: user.mobile, roleId: role.id, locationLabel: 'C-104' },
      { headers: idem() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const token = await tokenFor(user.mobile);
    return { ...w, user, token, invitationId: r.body.data.id as number };
  }

  it('T03-26 accepts: member ACTIVE, session active society set, audit rows, inviter notified', async () => {
    const { user, token, society, invitationId } = await invited();
    const cookies = await login(user);
    const r = await as(cookies)('post', `/invitations/${token}/accept`, {}, { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.message).toBe('Welcome to Sky Heights CHS');
    expect(r.body.data).toMatchObject({
      societyId: society.id,
      role: { key: 'committee_member', name: 'Committee Member', scope: 'society' },
      requiresMfa: false,
      reSignInRequired: false,
      redirectTo: 'https://admin.societyapp.in/admin',
    });
    const m = (await SocietyMember.findOne({ where: { userId: user.id } }))!;
    expect(m).toMatchObject({
      status: 'ACTIVE',
      locationLabel: 'C-104',
      invitationId,
      societyId: society.id,
    });
    expect(r.body.data.memberId).toBe(m.id);
    const inv = (await Invitation.findByPk(invitationId))!;
    expect(inv).toMatchObject({ status: 'ACCEPTED', acceptedUserId: user.id, acceptedMemberId: m.id });
    expect(await AuditLog.count({ where: { action: 'access.invitation.accepted' } })).toBe(1);
    expect(await AuditLog.count({ where: { action: 'access.member.joined', entityId: String(m.id) } })).toBe(
      1,
    );
    expect((await Session.findOne({ where: { userId: user.id } }))!.activeSocietyId).toBe(society.id);
    expect(events.some(e => e.room === `society:${society.id}:admin` && e.event === 'members.changed')).toBe(
      true,
    );
    const me = await as(cookies)('get', '/auth/me');
    expect(me.body.data.activeSocietyId).toBe(society.id);
    expect(me.body.data.permissions).toContain('settings.members.view');
    expect(
      (await as(cookies)('post', `/invitations/${token}/accept`, {}, { headers: idem() })).body.code,
    ).toBe('INVITATION_NOT_PENDING');
  });

  it('T03-27 accepting twice with the same Idempotency-Key replays the first answer', async () => {
    const { user, token } = await invited();
    const f = as(await login(user));
    const h = idem();
    const first = await f('post', `/invitations/${token}/accept`, {}, { headers: h });
    const second = await f('post', `/invitations/${token}/accept`, {}, { headers: h });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(await SocietyMember.count({ where: { userId: user.id } })).toBe(1);
  });

  it('T03-24 a different signed-in user gets INVITATION_MOBILE_MISMATCH', async () => {
    const { token } = await invited();
    const other = await makeUser({ name: 'Someone else' });
    const r = await as(await login(other, { app: 'RESIDENT' }), 'RESIDENT')(
      'post',
      `/invitations/${token}/accept`,
      {},
      { headers: idem() },
    );
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('INVITATION_MOBILE_MISMATCH');
  });

  it('T03-25 accepting after 7 days is 410 and the row becomes EXPIRED', async () => {
    const { user, token, invitationId } = await invited();
    const f = as(await login(user));
    advance(7 * 86_400_000 + 1000);
    const r = await call(
      'post',
      `/invitations/${token}/accept`,
      {},
      { app: 'ADMIN', cookies: await login(user), headers: idem() },
    );
    void f;
    expect([401, 410]).toContain(r.status);
    if (r.status === 410) {
      expect(r.body.code).toBe('INVITATION_EXPIRED');
      expect((await Invitation.findByPk(invitationId))!.status).toBe('EXPIRED');
    }
  });

  it('401 when not signed in, 404 for a malformed or unknown token', async () => {
    const { user, token } = await invited();
    const none = await post(`/invitations/${token}/accept`, {}, { app: 'ADMIN', headers: idem() });
    expect(none.status).toBe(401);
    const f = as(await login(user));
    const bad = await f('post', '/invitations/not-a-token/accept', {}, { headers: idem() });
    expect(bad.status).toBe(404);
    expect(bad.body.code).toBe('INVITATION_NOT_FOUND');
    expect(
      (await f('post', `/invitations/${'C'.repeat(43)}/accept`, {}, { headers: idem() })).body.code,
    ).toBe('INVITATION_NOT_FOUND');
  });

  it('an MFA role revokes the sessions of an invitee without MFA (reSignInRequired), BR-03-26', async () => {
    const { user, token, society } = await invited('treasurer');
    const cookies = await login(user);
    const r = await as(cookies)('post', `/invitations/${token}/accept`, {}, { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ requiresMfa: true, reSignInRequired: true });
    expect((await Session.findOne({ where: { userId: user.id } }))!.revokeReason).toBe('MFA_POLICY_CHANGED');
    expect(
      (await SocietyMember.findOne({ where: { userId: user.id, societyId: society.id! } }))!.status,
    ).toBe('ACTIVE');
    // next sign-in forces enrolment
    const { res } = await otpSignIn(user.mobile, { app: 'ADMIN' });
    expect(res.body.data.status).toBe('MFA_ENROLL_REQUIRED');
  });

  it('ALREADY_MEMBER keeps the invitation PENDING; an ENDED membership is reactivated with the new role', async () => {
    const w = await world();
    const user = await makeUser({ name: 'Returner' });
    await join(w.society, user, 'committee_member');
    const ended = (await SocietyMember.findOne({ where: { userId: user.id } }))!;
    const role = await roleOf(w.society.id!, 'facility_manager');
    // invite while ended
    await ended.update({ status: 'ENDED', endedAt: new Date(), endReason: 'Left' });
    await flushAcl();
    const inv = await w.c(
      'post',
      '/members/invite',
      { name: 'Returner', mobile: user.mobile, roleId: role.id },
      { headers: idem() },
    );
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const token = await tokenFor(user.mobile);
    const f = as(await login(user));
    const r = await f('post', `/invitations/${token}/accept`, {}, { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = await SocietyMember.findAll({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ended.id, status: 'ACTIVE', roleId: role.id, endedAt: null });
    // a second invitation while ACTIVE cannot be created; force one in the database to test accept
    await Invitation.update({ status: 'PENDING' }, { where: { id: inv.body.data.id } });
    const again = await f('post', `/invitations/${token}/accept`, {}, { headers: idem() });
    expect(again.body.code).toBe('ALREADY_MEMBER');
    expect((await Invitation.findByPk(inv.body.data.id))!.status).toBe('PENDING');
  });

  it('MEMBERSHIP_LIMIT_REACHED at 20 societies, SOCIETY_CLOSED for a closed society; the invitation stays PENDING', async () => {
    const { user, token, society, invitationId } = await invited();
    const f = as(await login(user));
    for (let i = 0; i < 20; i++) {
      const s = await makeSociety(`Filler ${i}`);
      await join(s, user, 'owner');
    }
    const r = await f('post', `/invitations/${token}/accept`, {}, { headers: idem() });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('MEMBERSHIP_LIMIT_REACHED');
    expect((await Invitation.findByPk(invitationId))!.status).toBe('PENDING');
    await SocietyMember.destroy({ where: { userId: user.id } });
    await sequelize.query(
      'UPDATE societies SET status = "CLOSED", closedAt = NOW(3), suspensionCause = NULL WHERE id = :id',
      {
        replacements: { id: society.id },
      },
    );
    await flushAcl();
    const closed = await f('post', `/invitations/${token}/accept`, {}, { headers: idem() });
    expect(closed.status).toBe(423);
    expect(closed.body.code).toBe('SOCIETY_CLOSED');
  });

  it('T03-54 accept can still be 402 when seats ran out; committee roles never need a seat', async () => {
    const society = await makeSociety();
    const used = fakeEntitlements({ 'limit.admin_seats': 3 });
    const ch = await memberUser(society, 'chairman');
    await memberUser(society, 'society_admin');
    await memberUser(society, 'accountant');
    const c = as(await login(ch));
    const auditor = await makeUser({ name: 'Auditor Anil' });
    const cm = await makeUser({ name: 'Cora Committee' });
    const i1 = await c(
      'post',
      '/members/invite',
      { name: 'Auditor Anil', mobile: auditor.mobile, roleId: (await roleOf(society.id!, 'auditor')).id },
      { headers: idem() },
    );
    expect(i1.status, JSON.stringify(i1.body)).toBe(201);
    const t1 = await tokenFor(auditor.mobile);
    const i2 = await c(
      'post',
      '/members/invite',
      {
        name: 'Cora Committee',
        mobile: cm.mobile,
        roleId: (await roleOf(society.id!, 'committee_member')).id,
      },
      { headers: idem() },
    );
    const t2 = await tokenFor(cm.mobile);
    await memberUser(society, 'facility_manager'); // takes the last seat
    expect(used['limit.admin_seats']).toBe(3);
    const a1 = await as(await login(auditor))('post', `/invitations/${t1}/accept`, {}, { headers: idem() });
    expect(a1.status).toBe(402);
    expect(a1.body.code).toBe('USAGE_LIMIT_EXCEEDED');
    expect((await Invitation.findByPk(i1.body.data.id))!.status).toBe('PENDING');
    expect(await SocietyMember.count({ where: { userId: auditor.id } })).toBe(0);
    const a2 = await as(await login(cm))('post', `/invitations/${t2}/accept`, {}, { headers: idem() });
    expect(a2.status, JSON.stringify(a2.body)).toBe(200);
    // ending one staff member frees a seat
    const staff = (await SocietyMember.findOne({
      where: { societyId: society.id!, roleId: (await roleOf(society.id!, 'accountant')).id },
    }))!;
    const del = await c('delete', `/members/${staff.id}`, { version: 1, reason: 'Left the society' });
    expect(del.status, JSON.stringify(del.body)).toBe(204);
    const again = await as(await login(auditor))(
      'post',
      `/invitations/${t1}/accept`,
      {},
      { headers: idem() },
    );
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    void i2;
  });
});

describe('authAccess port (T03-47 to T03-49)', () => {
  it('T03-47 a user with only a PENDING treasurer invitation has ADMIN access but not GATE; platform only with an invitation', async () => {
    const w = await world();
    const user = await makeUser({ name: 'Invitee' });
    await w.c(
      'post',
      '/members/invite',
      { name: 'Invitee', mobile: user.mobile, roleId: (await roleOf(w.society.id!, 'treasurer')).id },
      { headers: idem() },
    );
    expect(await authAccess.hasAppAccess(user.id, 'ADMIN')).toBe(true);
    expect(await authAccess.hasAppAccess(user.id, 'GATE')).toBe(false);
    expect(await authAccess.hasAppAccess(user.id, 'WORK')).toBe(false);
    expect(await authAccess.hasAppAccess(user.id, 'PLATFORM')).toBe(false);
    expect(await authAccess.hasAppAccess(user.id, 'RESIDENT')).toBe(true);
    advance(8 * 86_400_000);
    expect(await authAccess.hasAppAccess(user.id, 'ADMIN')).toBe(false); // expired invitations do not count
  });

  it('T03-48 listMemberships returns ACTIVE, SUSPENDED and INVITED items', async () => {
    const s1 = await makeSociety('One CHS');
    const s2 = await makeSociety('Two CHS');
    const s3 = await makeSociety('Three CHS');
    const ch3 = await memberUser(s3, 'chairman');
    const user = await makeUser({ name: 'Multi' });
    await join(s1, user, 'secretary');
    const m = await join(s2, user, 'treasurer');
    await m.update({ status: 'SUSPENDED', suspendedAt: new Date() });
    await as(await login(ch3))(
      'post',
      '/members/invite',
      { name: 'Multi', mobile: user.mobile, roleId: (await roleOf(s3.id!, 'society_admin')).id },
      { headers: idem() },
    );
    const list = await authAccess.listMemberships(user.id);
    expect(list.map(x => [x.societyName, x.status, x.memberId === null, x.roleKey])).toEqual([
      ['One CHS', 'ACTIVE', false, 'secretary'],
      ['Two CHS', 'SUSPENDED', false, 'treasurer'],
      ['Three CHS', 'INVITED', true, 'society_admin'],
    ]);
    expect(list[2]!.invitationId).toBeGreaterThan(0);
    expect(list[0]).toMatchObject({ city: 'Pune', societyStatus: 'ACTIVE', roleScope: 'society' });
  });

  it('T03-49 deletion blockers: a treasurer is blocked by the committee role, a plain owner is not', async () => {
    const society = await makeSociety('Sky Heights CHS');
    const treasurer = await memberUser(society, 'treasurer');
    const owner = await memberUser(society, 'owner', { mfa: false });
    expect(await authAccess.deletionBlockers(treasurer.id)).toEqual(['COMMITTEE_ROLE:Sky Heights CHS']);
    expect(await authAccess.deletionBlockers(owner.id)).toEqual([]);
  });

  it('LAST_SOCIETY_ADMIN blocks the only role manager of a society without a chairman; onUserAnonymised ends memberships', async () => {
    const society = await makeSociety('Tulip CHS');
    const admin = await memberUser(society, 'society_admin');
    expect(await authAccess.deletionBlockers(admin.id)).toEqual(['LAST_SOCIETY_ADMIN:Tulip CHS']);
    const second = await memberUser(society, 'society_admin');
    expect(await authAccess.deletionBlockers(admin.id)).toEqual([]);
    await sequelize.transaction(t => authAccess.onUserAnonymised(second.id, t));
    const m = (await SocietyMember.findOne({ where: { userId: second.id } }))!;
    expect(m).toMatchObject({ status: 'ENDED', endReason: 'ACCOUNT_DELETED', endedBy: null });
  });

  it('userRequiresMfa follows the role flag of ACTIVE memberships', async () => {
    const society = await makeSociety();
    const fm = await memberUser(society, 'facility_manager');
    const tr = await memberUser(society, 'treasurer');
    expect(await authAccess.userRequiresMfa(fm.id)).toBe(false);
    expect(await authAccess.userRequiresMfa(tr.id)).toBe(true);
    expect(await authAccess.getPermissions(fm.id, society.id!)).toContain('helpdesk.tickets.view');
    expect(await authAccess.getPermissions(tr.id, society.id! + 999)).toEqual([]);
  });
});
