import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  AuditLog,
  AuthToken,
  Role,
  Session,
  Society,
  SocietyLifecycleEvent,
  SocietyMember,
  Subscription,
  User,
  closeDb,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { hashToken } from '../../../src/modules/auth/auth.crypto';
import { lastOtp, post, cookiesFrom } from '../../helpers/auth';
import { resetLogins } from '../../helpers/access';
import { resetSocieties } from '../../helpers/societies';

afterAll(closeDb);
beforeEach(async () => {
  setNow('2026-10-30T06:30:00Z');
  await resetSocieties();
  resetLogins();
  setNow('2026-10-30T06:30:00Z');
});

let n = 0;
async function signupToken(mobile = `91234${String(56000 + ++n).padStart(5, '0')}`): Promise<string> {
  const s = await post('/auth/otp/send', { mobile, purpose: 'SIGNUP' });
  const v = await post('/auth/otp/verify', {
    challengeId: s.body.data.challengeId,
    code: await lastOtp(mobile),
  });
  if (v.status !== 200) throw new Error(JSON.stringify(v.body));
  return v.body.data.signupToken as string;
}

const body = (
  token: string,
  o: { name?: string; pincode?: string; role?: string; confirm?: boolean } = {},
) => ({
  signupToken: token,
  person: {
    name: 'Rakesh Shah',
    email: `rakesh${token.slice(-6).toLowerCase()}@example.in`,
    role: o.role ?? 'chairman',
  },
  society: {
    name: o.name ?? 'Lotus Residency CHS',
    addressLine1: 'Plot 7, Aundh Road',
    city: 'Pune',
    state: 'Maharashtra',
    pincode: o.pincode ?? '411007',
    approxFlats: 120,
  },
  planKey: 'STANDARD',
  acceptTerms: true,
  ...(o.confirm ? { confirmNotDuplicate: true } : {}),
});
const signup = (b: unknown, key = randomUUID(), ip = '10.0.0.1') =>
  post('/public/signups', b, { headers: { 'Idempotency-Key': key }, ip });

describe('self-serve sign-up (8.1)', () => {
  it('creates a TRIAL society, makes the creator chairman, opens an admin session and lands on onboarding', async () => {
    const r = await signup(body(await signupToken('9123456789')));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.message).toBe('Society created');
    expect(r.body.data).toMatchObject({
      slug: 'lotus-residency-chs',
      status: 'TRIAL',
      trialEndsAt: '2026-11-13T06:30:00.000Z',
      role: 'chairman',
      redirectUrl: 'https://admin.societyapp.in/onboarding',
    });
    const s = (await Society.findByPk(r.body.data.societyId))!;
    const u = (await User.findOne({ where: { mobile: '9123456789' } }))!;
    expect([s.createdVia, s.creatorUserId, s.approxFlats]).toEqual(['SELF_SERVE', u.id, 120]);
    const m = (await SocietyMember.findOne({ where: { societyId: s.id!, userId: u.id! }, include: [Role] }))!;
    expect((m as unknown as { Role: Role }).Role.key).toBe('chairman');
    expect((await Subscription.findOne({ where: { societyId: s.id! } }))!.status).toBe('TRIALING');
    const ev = (await SocietyLifecycleEvent.findOne({ where: { societyId: s.id! } }))!;
    expect([ev.eventType, ev.triggerSource, ev.triggerCode, ev.actorUserId]).toEqual([
      'CREATED',
      'PUBLIC_SIGNUP',
      'SELF_SERVE_SIGNUP',
      u.id,
    ]);
    expect((await AuditLog.findOne({ where: { action: 'societies.society.signed_up' } }))!.actorUserId).toBe(
      u.id,
    );
    const cookies = cookiesFrom(r);
    expect(Object.keys(cookies)).toEqual(expect.arrayContaining(['sa_access', 'sa_csrf']));
    const session = (await Session.findOne({ where: { userId: u.id! } }))!;
    expect([session.clientApp, session.activeSocietyId]).toEqual(['ADMIN', s.id]);
  });

  it('a society admin can sign up too; a missing acceptTerms or a bad pincode is 400', async () => {
    const t = await signupToken();
    expect((await signup({ ...body(t), acceptTerms: false })).status).toBe(400);
    expect((await signup(body(t, { pincode: '011007' }))).status).toBe(400);
    const r = await signup(body(t, { role: 'society_admin' }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.role).toBe('society_admin');
  });

  it('T05-11 duplicate name and pincode is 409 with name and city only; confirmNotDuplicate creates it with a suffixed slug', async () => {
    expect((await signup(body(await signupToken()))).status).toBe(201);
    const t = await signupToken();
    const dup = await signup(body(t, { name: 'Lotus Residency Co-op. Hsg. Society Ltd' }));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('POSSIBLE_DUPLICATE_SOCIETY');
    expect(dup.body.errors).toEqual([
      { field: 'society.name', message: 'Possible duplicate', name: 'Lotus Residency CHS', city: 'Pune' },
    ]);
    const ok = await signup(body(t, { name: 'Lotus Residency CHS', confirm: true }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.slug).toBe('lotus-residency-chs-2');
  });

  it('T05-12 a creator with a society still in TRIAL gets 409 TRIAL_ALREADY_USED', async () => {
    const r = await signup(body(await signupToken('9123400001')));
    expect(r.status).toBe(201);
    // module 02 refuses a SIGNUP OTP for a registered mobile, so the second token is issued directly for this rule
    const raw = `su_${'x'.repeat(43)}`;
    await AuthToken.create({
      tokenHash: hashToken(raw),
      purpose: 'SIGNUP',
      userId: null,
      sessionId: null,
      payload: { mobile: '9123400001', clientApp: 'ADMIN' },
      attemptCount: 0,
      expiresAt: new Date('2026-10-30T06:45:00Z'),
      consumedAt: null,
      revokedAt: null,
      ip: null,
      userAgent: null,
      createdBy: null,
    } as never);
    const again = await signup(body(raw, { name: 'Another Place CHS', pincode: '411045' }));
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('TRIAL_ALREADY_USED');
  });

  it('a used, unknown or expired token is 401 SIGNUP_TOKEN_INVALID; the same Idempotency-Key replays the first answer', async () => {
    const t = await signupToken();
    const key = randomUUID();
    const a = await signup(body(t), key);
    expect(a.status).toBe(201);
    const replay = await signup(body(t), key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.data.societyId).toBe(a.body.data.societyId);
    const used = await signup(body(t, { name: 'Other CHS' }));
    expect(used.status).toBe(401);
    expect(used.body.code).toBe('SIGNUP_TOKEN_INVALID');
    const unknown = await signup(body('su_unknownunknownunknownunknownunknownunknown12'));
    expect(unknown.body.code).toBe('SIGNUP_TOKEN_INVALID');
    const t2 = await signupToken();
    setNow('2026-10-30T06:46:00Z');
    expect((await signup(body(t2, { name: 'Late CHS' }))).body.code).toBe('SIGNUP_TOKEN_INVALID');
    expect(await Society.count()).toBe(1);
  });

  it('rate limit: 5 sign-ups per hour per IP', async () => {
    await resetRateLimits();
    for (let i = 0; i < 5; i++)
      await signup({ ...body('su_x'), acceptTerms: false }, randomUUID(), '10.9.9.9');
    const r = await signup({ ...body('su_x'), acceptTerms: false }, randomUUID(), '10.9.9.9');
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('RATE_LIMITED');
  });
});
