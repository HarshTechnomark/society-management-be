import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Resident, Session, User, closeDb, sequelize } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { setAuthPorts } from '../../../src/modules/auth/auth.ports';
import type { ClientApp, MembershipView } from '../../../src/modules/auth/auth.types';
import {
  PASSWORD,
  cookiesFrom,
  get,
  inboxFor,
  lastOtp,
  makeUser,
  post,
  resetAll,
  totpNow,
  type Cookies,
} from '../../helpers/auth';
import { lifecycleSociety, resetSocieties } from '../../helpers/societies';
import { resetResidents, residentSociety } from '../../helpers/residents';
import { createLink } from '../../../src/modules/residents/residents.links.service';
import { syncMembership } from '../../../src/modules/residents/residents.sync';
import { systemCtx } from '../../../src/types/context';

/** The single sign-in address (an app origin whose first host label is not a role label). */
const U = { origin: 'https://app.societyapp.in' };

afterAll(closeDb);

let societyId = 0;
const access = new Map<number, ClientApp[]>();
const needsMfa = new Set<number>();
const residentLink = new Set<number>();

const membership = (scope: MembershipView['roleScope']): MembershipView => ({
  societyId,
  societyName: 'Sky Heights',
  city: 'Pune',
  societyStatus: 'ACTIVE',
  memberId: 1,
  roleKey: scope === 'resident' ? 'resident_owner' : 'chairman',
  roleName: scope === 'resident' ? 'Owner' : 'Chairman',
  roleScope: scope,
  status: 'ACTIVE',
});

beforeEach(async () => {
  await resetAll();
  await resetSocieties();
  societyId = Number((await lifecycleSociety('ACTIVE', { name: 'Sky Heights' })).id);
  access.clear();
  needsMfa.clear();
  residentLink.clear();
  setAuthPorts({
    authAccess: {
      // the apps a person may open; everybody is a resident unless the test says otherwise
      hasAppAccess: async (id, app) => (access.get(id) ?? ['RESIDENT']).includes(app),
      userRequiresMfa: async id => needsMfa.has(id),
      hasResidentRecord: async id => residentLink.has(id),
      listMemberships: async id => {
        const apps = access.get(id) ?? ['RESIDENT'];
        const out: MembershipView[] = [];
        if (apps.includes('ADMIN')) out.push(membership('society'));
        if (residentLink.has(id)) out.push(membership('resident'));
        return out;
      },
    },
  });
});

const grant = (id: number, apps: ClientApp[], o: { mfa?: boolean; resident?: boolean } = {}) => {
  access.set(id, apps);
  if (o.mfa) needsMfa.add(id);
  if (o.resident) residentLink.add(id);
};
const passwordLogin = (email: string, password = PASSWORD, o = {}) =>
  post('/auth/password/login', { email, password }, { ...U, ...o });
async function otpLogin(mobile: string, o = {}) {
  const s = await post('/auth/otp/send', { mobile }, { ...U, ...o });
  expect(s.status, JSON.stringify(s.body)).toBe(202);
  const code = await lastOtp(mobile);
  return post('/auth/otp/verify', { challengeId: s.body.data.challengeId, code }, { ...U, ...o });
}
const withCookies = (res: { headers: Record<string, unknown> }, into: Cookies = {}) =>
  cookiesFrom(res as never, into);

describe('the single sign-in address accepts sign-in without a per-role host', () => {
  it('password: a person with one app is signed in to it, and the session works on the same address', async () => {
    const u = await makeUser({ email: 'office@skyheights.in' });
    grant(u.id, ['ADMIN']);
    const r = await passwordLogin('office@skyheights.in');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('SIGNED_IN');
    expect(r.body.data.me.session.clientApp).toBe('ADMIN');
    expect(r.body.data.me.session.amr).toEqual(['PASSWORD']);
    const cookies = withCookies(r);
    const me = await get('/auth/me', { ...U, cookies });
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.data.session.clientApp).toBe('ADMIN');
    expect(me.body.data.user.id).toBe(u.id);
    expect((await Session.findAll({ where: { userId: u.id } })).map(s => s.clientApp)).toEqual(['ADMIN']);
  });

  it("mobile OTP: a resident is signed in to the resident app, with that app's long session", async () => {
    const u = await makeUser();
    const r = await otpLogin(u.mobile);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('SIGNED_IN');
    expect(r.body.data.me.session.clientApp).toBe('RESIDENT');
    const s = (await Session.findAll({ where: { userId: u.id } }))[0]!;
    expect(s.idleTimeoutMinutes).toBe(10080);
  });

  it('mobile OTP: an unknown mobile number becomes a resident, as on the resident address', async () => {
    const mobile = '9833300001';
    const r = await otpLogin(mobile);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.me.session.clientApp).toBe('RESIDENT');
    expect(await User.findOne({ where: { mobile } })).not.toBeNull();
  });

  it('the sign-up code (create a society) is available, as on the admin address', async () => {
    const r = await post('/auth/otp/send', { mobile: '9833300002', purpose: 'SIGNUP' }, U);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
  });

  it('passkey options are available', async () => {
    const r = await post('/auth/passkey/options', {}, U);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.publicKey.challenge).toBeTruthy();
  });

  it('an origin that is not configured is still refused', async () => {
    const u = await makeUser({ email: 'a@skyheights.in' });
    grant(u.id, ['ADMIN']);
    const r = await post(
      '/auth/password/login',
      { email: 'a@skyheights.in', password: PASSWORD },
      { origin: 'https://evil.example' },
    );
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('CSRF_FAILED');
  });
});

describe('the app is decided from what the person may open and how they signed in (BR-02-42, BR-02-43)', () => {
  it('a platform account signs in by password and the second step, and lands in the platform console', async () => {
    const u = await makeUser({ email: 'super@societyapp.in', mfa: true, platformRoleId: 11 });
    grant(u.id, ['PLATFORM'], { mfa: true });
    const r = await passwordLogin('super@societyapp.in');
    expect(r.body.data.status).toBe('MFA_REQUIRED');
    const v = await post(
      '/auth/mfa/verify',
      { challengeToken: r.body.data.challengeToken, method: 'TOTP', code: totpNow(u.totpSecret!) },
      U,
    );
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.data.me.session.clientApp).toBe('PLATFORM');
    expect((await Session.findAll({ where: { userId: u.id } }))[0]!.mfaVerified).toBe(true);
  });

  it('a platform-only account cannot use a mobile code (the platform has no OTP sign-in)', async () => {
    const u = await makeUser({ platformRoleId: 11 });
    grant(u.id, ['PLATFORM'], { mfa: true });
    const r = await otpLogin(u.mobile);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('LOGIN_METHOD_NOT_ALLOWED');
    expect(await Session.count({ where: { userId: u.id } })).toBe(0);
  });

  it('a platform account with no resident record is not given the resident app by a mobile code', async () => {
    const u = await makeUser({ platformRoleId: 11, mfa: true });
    grant(u.id, ['PLATFORM', 'RESIDENT'], { mfa: true }); // everybody "can" be a resident, but there is no record
    const r = await otpLogin(u.mobile);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.code).toBe('LOGIN_METHOD_NOT_ALLOWED');
    expect(r.body.message).toMatch(/email address and password/);
    expect(await Session.count({ where: { userId: u.id } })).toBe(0);
  });

  it('a resident has no password: email and password is refused for a resident-only account', async () => {
    await makeUser({ email: 'owner@flat.in' });
    const r = await passwordLogin('owner@flat.in');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('LOGIN_METHOD_NOT_ALLOWED');
  });

  it('an account with no access to any app is refused', async () => {
    const u = await makeUser({ email: 'nobody@flat.in' });
    grant(u.id, []);
    const r = await passwordLogin('nobody@flat.in');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('NO_ACCESS_FOR_APP');
  });

  it('a disabled account is refused', async () => {
    const u = await makeUser({ email: 'gone@flat.in', status: 'DISABLED' });
    grant(u.id, ['ADMIN']);
    const r = await passwordLogin('gone@flat.in');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('ACCOUNT_DISABLED');
  });

  it('wrong credentials answer the same on this address as on the others', async () => {
    const u = await makeUser({ email: 'office@skyheights.in' });
    grant(u.id, ['ADMIN']);
    const r = await passwordLogin('office@skyheights.in', 'Wrong@Password1');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('a committee member who is not also a resident is not asked to choose', async () => {
    const u = await makeUser();
    grant(u.id, ['ADMIN', 'RESIDENT']); // everybody can be a resident, but there is no resident link
    const r = await otpLogin(u.mobile);
    expect(r.body.data.status).toBe('SIGNED_IN');
    expect(r.body.data.me.session.clientApp).toBe('ADMIN');
  });
});

describe('a person who may open more than one app picks one (POST /auth/app/choose)', () => {
  it('offers the apps, then signs in to the one chosen', async () => {
    const u = await makeUser();
    grant(u.id, ['ADMIN', 'RESIDENT'], { resident: true });
    const r = await otpLogin(u.mobile);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('APP_CHOICE_REQUIRED');
    expect(r.body.data.apps).toEqual(['ADMIN', 'RESIDENT']);
    expect(r.headers['set-cookie']).toBeUndefined(); // no session yet
    const c = await post(
      '/auth/app/choose',
      { challengeToken: r.body.data.challengeToken, app: 'RESIDENT' },
      U,
    );
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.data.status).toBe('SIGNED_IN');
    expect(c.body.data.me.session.clientApp).toBe('RESIDENT');
    expect(c.body.data.me.session.amr).toEqual(['OTP']);
  });

  it('a choice that needs the second step goes on to it, and the session is for the chosen app', async () => {
    const u = await makeUser({ mfa: true });
    grant(u.id, ['ADMIN', 'RESIDENT'], { mfa: true, resident: true });
    const r = await otpLogin(u.mobile);
    const c = await post('/auth/app/choose', { challengeToken: r.body.data.challengeToken, app: 'ADMIN' }, U);
    expect(c.body.data.status).toBe('MFA_REQUIRED');
    const v = await post(
      '/auth/mfa/verify',
      { challengeToken: c.body.data.challengeToken, method: 'TOTP', code: totpNow(u.totpSecret!) },
      U,
    );
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.data.me.session.clientApp).toBe('ADMIN');
    expect(v.body.data.me.session.amr).toEqual(['OTP', 'TOTP']);
  });

  it('the challenge works once', async () => {
    const u = await makeUser();
    grant(u.id, ['ADMIN', 'RESIDENT'], { resident: true });
    const r = await otpLogin(u.mobile);
    const body = { challengeToken: r.body.data.challengeToken, app: 'ADMIN' };
    expect((await post('/auth/app/choose', body, U)).status).toBe(200);
    const again = await post('/auth/app/choose', body, U);
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('CHALLENGE_INVALID');
  });

  it('an app that was not offered is refused, and the challenge is kept for a valid choice', async () => {
    const u = await makeUser();
    grant(u.id, ['ADMIN', 'RESIDENT'], { resident: true });
    const r = await otpLogin(u.mobile);
    const bad = await post(
      '/auth/app/choose',
      { challengeToken: r.body.data.challengeToken, app: 'PLATFORM' },
      U,
    );
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('APP_NOT_ALLOWED');
    const good = await post(
      '/auth/app/choose',
      { challengeToken: r.body.data.challengeToken, app: 'ADMIN' },
      U,
    );
    expect(good.status).toBe(200);
  });

  it('access lost between the two steps is refused', async () => {
    const u = await makeUser();
    grant(u.id, ['ADMIN', 'RESIDENT'], { resident: true });
    const r = await otpLogin(u.mobile);
    access.set(u.id, ['RESIDENT']);
    const c = await post('/auth/app/choose', { challengeToken: r.body.data.challengeToken, app: 'ADMIN' }, U);
    expect(c.status).toBe(403);
    expect(c.body.code).toBe('NO_ACCESS_FOR_APP');
  });

  it('a challenge for the app step cannot be used as a second-step challenge, or the other way round', async () => {
    const u = await makeUser({ mfa: true });
    grant(u.id, ['ADMIN', 'RESIDENT'], { mfa: true, resident: true });
    const r = await otpLogin(u.mobile);
    const wrong = await post(
      '/auth/mfa/verify',
      { challengeToken: r.body.data.challengeToken, method: 'TOTP', code: totpNow(u.totpSecret!) },
      U,
    );
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('CHALLENGE_INVALID');
    const c = await post('/auth/app/choose', { challengeToken: r.body.data.challengeToken, app: 'ADMIN' }, U);
    const back = await post(
      '/auth/app/choose',
      { challengeToken: c.body.data.challengeToken, app: 'ADMIN' },
      U,
    );
    expect(back.status).toBe(401);
  });

  it('choosing an app only exists on the single sign-in address', async () => {
    const u = await makeUser();
    grant(u.id, ['ADMIN', 'RESIDENT'], { resident: true });
    const r = await otpLogin(u.mobile);
    const c = await post(
      '/auth/app/choose',
      { challengeToken: r.body.data.challengeToken, app: 'ADMIN' },
      { app: 'ADMIN' },
    );
    expect(c.status).toBe(400);
    expect(c.body.code).toBe('LOGIN_METHOD_NOT_ALLOWED');
  });

  it('a challenge made on the single address is refused on a per-role address, and the session cookie too', async () => {
    const u = await makeUser({ mfa: true, email: 'o@skyheights.in' });
    grant(u.id, ['ADMIN'], { mfa: true });
    const r = await passwordLogin('o@skyheights.in');
    const onOther = await post(
      '/auth/mfa/verify',
      { challengeToken: r.body.data.challengeToken, method: 'TOTP', code: totpNow(u.totpSecret!) },
      { app: 'PLATFORM' },
    );
    expect(onOther.status).toBe(401);
    expect(onOther.body.code).toBe('CHALLENGE_INVALID');

    const u2 = await makeUser({ email: 'p@skyheights.in' });
    grant(u2.id, ['ADMIN']);
    const ok = await passwordLogin('p@skyheights.in');
    const cookies = withCookies(ok);
    expect((await get('/auth/me', { app: 'PLATFORM', cookies })).status).toBe(401); // ADMIN session on the platform host
    expect((await get('/auth/me', { app: 'ADMIN', cookies })).status).toBe(200); // the cookie names its app; the admin host takes it
  });
});

let swSeq = 0;
describe('switching app after sign-in (POST /auth/switch-app)', () => {
  async function signedInAsAdmin(first: 'otp' | 'password') {
    const email = `sw${++swSeq}@skyheights.in`;
    const u = await makeUser({ email, mfa: first === 'password' });
    grant(u.id, first === 'password' ? ['PLATFORM', 'ADMIN'] : ['ADMIN', 'RESIDENT'], {
      resident: first === 'otp',
      mfa: first === 'password',
    });
    if (first === 'otp') {
      const r = await otpLogin(u.mobile);
      const c = await post(
        '/auth/app/choose',
        { challengeToken: r.body.data.challengeToken, app: 'ADMIN' },
        U,
      );
      return { u, cookies: withCookies(c) };
    }
    const r = await passwordLogin(email);
    expect(r.body.data.status).toBe('APP_CHOICE_REQUIRED');
    const c = await post('/auth/app/choose', { challengeToken: r.body.data.challengeToken, app: 'ADMIN' }, U);
    const v = await post(
      '/auth/mfa/verify',
      { challengeToken: c.body.data.challengeToken, method: 'TOTP', code: totpNow(u.totpSecret!) },
      U,
    );
    return { u, cookies: withCookies(v) };
  }

  it('opens another app with a new session; the old session ends and the sign-in time is kept', async () => {
    const { u, cookies } = await signedInAsAdmin('otp');
    const before = (await Session.findAll({ where: { userId: u.id } }))[0]!;
    const r = await post('/auth/switch-app', { app: 'RESIDENT' }, { ...U, cookies });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.session.clientApp).toBe('RESIDENT');
    expect(r.body.data.session.amr).toEqual(['OTP']);
    const fresh = withCookies(r);
    expect((await get('/auth/me', { ...U, cookies: fresh })).body.data.session.clientApp).toBe('RESIDENT');
    expect((await get('/auth/me', { ...U, cookies })).status).toBe(401); // the old cookies name an ended session
    const all = await Session.findAll({ where: { userId: u.id }, order: [['id', 'ASC']] });
    expect(all.map(s => [s.clientApp, s.revokedAt !== null])).toEqual([
      ['ADMIN', true],
      ['RESIDENT', false],
    ]);
    expect(all[1]!.authTime.getTime()).toBe(before.authTime.getTime());
    expect(all[1]!.idleTimeoutMinutes).toBe(10080); // the new app's own timeouts
  });

  it('switching to the app already open changes nothing', async () => {
    const { u, cookies } = await signedInAsAdmin('otp');
    const r = await post('/auth/switch-app', { app: 'ADMIN' }, { ...U, cookies });
    expect(r.status).toBe(200);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(await Session.count({ where: { userId: u.id } })).toBe(1);
  });

  it('a mobile-code sign-in cannot open the platform: sign in again with a password', async () => {
    const { u, cookies } = await signedInAsAdmin('otp');
    access.set(u.id, ['PLATFORM', 'ADMIN', 'RESIDENT']);
    const r = await post('/auth/switch-app', { app: 'PLATFORM' }, { ...U, cookies });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('LOGIN_METHOD_NOT_ALLOWED');
    expect(await Session.count({ where: { userId: u.id, revokedAt: null } })).toBe(1);
  });

  it('a password sign-in with the second step may open the platform, and keeps its second step', async () => {
    const { u, cookies } = await signedInAsAdmin('password');
    const r = await post('/auth/switch-app', { app: 'PLATFORM' }, { ...U, cookies });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.session.clientApp).toBe('PLATFORM');
    expect(r.body.data.session.amr).toEqual(['PASSWORD', 'TOTP']);
    const open = await Session.findAll({ where: { userId: u.id, revokedAt: null } });
    expect(open.map(s => [s.clientApp, s.mfaVerified])).toEqual([['PLATFORM', true]]);
  });

  it('an app the person has no access to is refused', async () => {
    const { cookies } = await signedInAsAdmin('otp');
    const r = await post('/auth/switch-app', { app: 'GATE' }, { ...U, cookies });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('NO_ACCESS_FOR_APP');
  });

  it('lists the apps the person can switch to, by how they signed in', async () => {
    const otp = await signedInAsAdmin('otp');
    access.set(otp.u.id, ['PLATFORM', 'ADMIN', 'RESIDENT']);
    const a = await get('/auth/apps', { ...U, cookies: otp.cookies });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.data).toEqual({ current: 'ADMIN', available: ['RESIDENT'] }); // an OTP sign-in never offers the platform

    const pw = await signedInAsAdmin('password');
    const b = await get('/auth/apps', { ...U, cookies: pw.cookies });
    expect(b.body.data).toEqual({ current: 'ADMIN', available: ['PLATFORM'] }); // a password sign-in has no resident app
  });

  it('lists nothing on a per-role address, and needs a session', async () => {
    const { cookies } = await signedInAsAdmin('otp');
    const onAdmin = await get('/auth/apps', { app: 'ADMIN', cookies });
    expect(onAdmin.status).toBe(200);
    expect(onAdmin.body.data).toEqual({ current: 'ADMIN', available: [] });
    expect((await get('/auth/apps', U)).status).toBe(401);
  });

  it('is only for the single sign-in address, and needs a session', async () => {
    const { cookies } = await signedInAsAdmin('otp');
    const onAdmin = await post('/auth/switch-app', { app: 'RESIDENT' }, { app: 'ADMIN', cookies });
    expect(onAdmin.status).toBe(400);
    expect((await post('/auth/switch-app', { app: 'RESIDENT' }, U)).status).toBe(401);
  });
});

describe('links in messages use the single sign-in address when no per-role address is configured for the app', () => {
  it('the password reset link points at it', async () => {
    const u = await makeUser({ email: 'reset@skyheights.in' });
    grant(u.id, ['ADMIN']);
    const r = await post('/auth/password/forgot', { email: 'reset@skyheights.in' }, U);
    expect(r.status).toBe(202);
    const mail = (await inboxFor('reset@skyheights.in'))[0]!;
    expect(mail.body).toMatch(/https:\/\/app\.societyapp\.in\/reset\?token=/);
  });
});

describe('with the real module 03 and module 09 access: the resident app needs a resident record', () => {
  /** Makes `user` the owner of a flat through module 09 (resident row, unit link, membership sync), keeping their role. */
  async function ownFlat(societyId: number, user: { id: number; mobile: string }, unitId: number) {
    const resident = await Resident.create({
      societyId,
      userId: user.id,
      memberId: null,
      name: 'Rajesh Kulkarni',
      mobile: user.mobile,
      alternateMobile: null,
      email: null,
      dateOfBirth: null,
      gender: null,
      photoFileId: null,
      preferredLanguage: 'en-IN',
      isNri: false,
      overseasPhone: null,
      localRepresentativeResidentId: null,
      status: 'ACTIVE',
      source: 'ADMIN',
      directoryVisible: true,
      showMobileInDirectory: false,
      showEmailInDirectory: false,
      showPhotoInDirectory: false,
      adminNote: null,
      anonymisedAt: null,
      version: 1,
      createdBy: null,
      updatedBy: null,
      deletedAt: null,
    } as never);
    await sequelize.transaction(async t => {
      await createLink(
        systemCtx('test'),
        societyId,
        { residentId: resident.id!, unitId, relation: 'OWNER', fromDate: '2026-01-01' },
        t,
        { internal: true, checkFeature: false },
      );
      await syncMembership(systemCtx('test'), t, resident.id!, { societyId });
    });
  }

  beforeEach(async () => {
    await resetResidents();
  });
  // the fixtures signed the chairman in with this minute's authenticator code; a code works once
  const nextMinute = () => setNow('2026-11-01T04:32:00Z');

  async function adminViaChoice(u: { mobile: string; totpSecret?: string | null }) {
    const r = await otpLogin(u.mobile);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('APP_CHOICE_REQUIRED');
    expect(r.body.data.apps).toEqual(['ADMIN', 'RESIDENT']);
    const c = await post('/auth/app/choose', { challengeToken: r.body.data.challengeToken, app: 'ADMIN' }, U);
    expect(c.body.data.status).toBe('MFA_REQUIRED');
    const v = await post(
      '/auth/mfa/verify',
      { challengeToken: c.body.data.challengeToken, method: 'TOTP', code: totpNow(u.totpSecret!) },
      U,
    );
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    return withCookies(v);
  }

  it('a chairman who owns a flat chooses between the society admin and the resident app, and can switch', async () => {
    const { society, user, unit } = await residentSociety();
    await ownFlat(society.id!, user, unit(1).id);
    nextMinute();
    const cookies = await adminViaChoice(user);
    const apps = await get('/auth/apps', { ...U, cookies });
    expect(apps.status, JSON.stringify(apps.body)).toBe(200);
    expect(apps.body.data).toEqual({ current: 'ADMIN', available: ['RESIDENT'] });
    const sw = await post('/auth/switch-app', { app: 'RESIDENT' }, { ...U, cookies });
    expect(sw.status, JSON.stringify(sw.body)).toBe(200);
    expect(sw.body.data.session.clientApp).toBe('RESIDENT');
  });

  it('a chairman with no resident record goes straight to the society admin and cannot switch to the resident app', async () => {
    const { user } = await residentSociety();
    nextMinute();
    const r = await otpLogin(user.mobile);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('MFA_REQUIRED');
    const v = await post(
      '/auth/mfa/verify',
      { challengeToken: r.body.data.challengeToken, method: 'TOTP', code: totpNow(user.totpSecret!) },
      U,
    );
    expect(v.body.data.me.session.clientApp).toBe('ADMIN');
    const cookies = withCookies(v);
    expect((await get('/auth/apps', { ...U, cookies })).body.data).toEqual({
      current: 'ADMIN',
      available: [],
    });
    const sw = await post('/auth/switch-app', { app: 'RESIDENT' }, { ...U, cookies });
    expect(sw.status).toBe(403);
    expect(sw.body.code).toBe('NO_ACCESS_FOR_APP');
  });

  it('a platform account signing in by mobile is refused and gets no resident session', async () => {
    const u = await makeUser({ platformRoleId: 11, mfa: true });
    const r = await otpLogin(u.mobile);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.code).toBe('LOGIN_METHOD_NOT_ALLOWED');
    expect(await Session.count({ where: { userId: u.id } })).toBe(0);
  });

  it('an unknown mobile number still signs up and lands in the resident app', async () => {
    const r = await otpLogin('9833300009');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.me.session.clientApp).toBe('RESIDENT');
  });
});
