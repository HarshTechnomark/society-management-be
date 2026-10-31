import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthLockout, closeDb } from '../../../src/models';
import { advance, setNow } from '../../../src/lib/clock';
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  groupSecret,
  hashPassword,
  matchTotpStep,
  newChallengeId,
  newOtpCode,
  newRecoveryCode,
  newTotpSecret,
  normaliseRecoveryCode,
  RECOVERY_CODE_RE,
  totpCode,
  verifyPassword,
} from '../../../src/modules/auth/auth.crypto';
import {
  LOCKOUT_POLICY,
  lockRemainingSeconds,
  recordFailure,
  resetLock,
} from '../../../src/modules/auth/auth.lockout';
import { checkPasswordPolicy } from '../../../src/modules/auth/auth.password';
import { mobileSchema, nameSchema, normaliseMobile } from '../../../src/modules/auth/auth.normalise';
import { deviceLabelFor } from '../../../src/modules/auth/auth.tokens';
import { resetAll } from '../../helpers/auth';

afterAll(closeDb);

describe('password policy (BR-02-13)', () => {
  it('T02-01 Demo@Society2026 with office@skyheights.in passes all six rules', async () => {
    expect(
      await checkPasswordPolicy('Demo@Society2026', { email: 'office@skyheights.in', localOnly: true }),
    ).toEqual([]);
  });
  it('T02-02 a password containing the email local part fails only the email rule', async () => {
    expect(
      await checkPasswordPolicy('Rajesh@chairman1', { email: 'chairman@skyheights.in', localOnly: true }),
    ).toEqual(['email']);
  });
  it('T02-03 length boundaries 11, 12, 128 and 129', async () => {
    const mk = (n: number) => 'Aa1!' + 'x'.repeat(n - 4);
    const lenFails = async (n: number) =>
      (await checkPasswordPolicy(mk(n), { localOnly: true })).includes('len');
    expect(await lenFails(11)).toBe(true);
    expect(await lenFails(12)).toBe(false);
    expect(await lenFails(128)).toBe(false);
    expect(await lenFails(129)).toBe(true);
  });
  it('reports each rule that fails', async () => {
    expect(await checkPasswordPolicy('alllowercaseletters', { localOnly: true })).toEqual([
      'case',
      'num',
      'sym',
    ]);
    expect(await checkPasswordPolicy('NoDigitsHere!!!!', { localOnly: true })).toEqual(['num']);
    expect(await checkPasswordPolicy('Password1234', { localOnly: true })).toContain('breach');
    expect(await checkPasswordPolicy('Strong pass 99 Z', { localOnly: true })).toEqual([]); // a space counts as a symbol
  });
  it('the email rule ignores local parts shorter than 3 characters', async () => {
    expect(await checkPasswordPolicy('Ab@Society2026!', { email: 'ab@x.in', localOnly: true })).toEqual([]);
  });
});

describe('TOTP (BR-02-20)', () => {
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the RFC 6238 SHA-1 vectors', () => {
    const at = (s: number) => totpCode(rfcSecret, Math.floor(s / 30));
    expect(at(59)).toBe('287082');
    expect(at(1111111109)).toBe('081804');
    expect(at(1111111111)).toBe('050471');
    expect(at(1234567890)).toBe('005924');
    expect(at(2000000000)).toBe('279037');
  });
  it('T02-04 accepts steps -1, 0 and +1 and rejects -2 and +2', () => {
    const ms = 1_700_000_000_000;
    const step = Math.floor(ms / 30000);
    for (const d of [-1, 0, 1])
      expect(matchTotpStep(rfcSecret, totpCode(rfcSecret, step + d), ms)).toBe(step + d);
    expect(matchTotpStep(rfcSecret, totpCode(rfcSecret, step - 2), ms)).toBeNull();
    expect(matchTotpStep(rfcSecret, totpCode(rfcSecret, step + 2), ms)).toBeNull();
  });
  it('secrets are 32 base32 characters, shown in groups of four', () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(groupSecret(s)).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
    expect(base32Decode(s)).toHaveLength(20);
  });
  it('AES-256-GCM round trip, format v1:iv:ct:tag, tamper detected (BR-02-21)', () => {
    const enc = encryptSecret('JBSWY3DPEHPK3PXP');
    expect(enc).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(enc.split(':')[1], 'base64')).toHaveLength(12);
    expect(decryptSecret(enc)).toBe('JBSWY3DPEHPK3PXP');
    const parts = enc.split(':');
    parts[2] = Buffer.from('tampered!!!!').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });
});

describe('codes and identifiers', () => {
  it('T02-05 recovery code normalisation', () => {
    expect(normaliseRecoveryCode('rc 7k2m q9xd')).toBe('RC-7K2M-Q9XD');
    expect(normaliseRecoveryCode('7k2mq9xd')).toBe('RC-7K2M-Q9XD');
    expect(normaliseRecoveryCode('RC-7K2M-Q9XD')).toBe('RC-7K2M-Q9XD');
  });
  it('generated recovery codes use the Crockford alphabet', () => {
    for (let i = 0; i < 50; i++) expect(newRecoveryCode()).toMatch(RECOVERY_CODE_RE);
  });
  it('OTP codes are six digits with leading zeros kept; challenge ids match the schema', () => {
    for (let i = 0; i < 200; i++) expect(newOtpCode()).toMatch(/^\d{6}$/);
    expect(newChallengeId()).toMatch(/^otp_[a-z2-7]{24}$/);
  });
  it('Argon2id hashes verify, wrong passwords and garbage hashes do not (BR-02-15)', async () => {
    const h = await hashPassword('Demo@Society2026');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    expect(await verifyPassword(h, 'Demo@Society2026')).toBe(true);
    expect(await verifyPassword(h, 'Demo@Society2027')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});

describe('normalisation (BR-02-1, BR-02-6)', () => {
  it('mobile strips spaces, hyphens, +91, 91 and 0', () => {
    for (const v of ['+91 98200 11111', '91-98200-11111', '09820011111', '9820011111', '+919820011111'])
      expect(normaliseMobile(v)).toBe('9820011111');
    expect(mobileSchema.safeParse('1234567890').success).toBe(false);
    expect(mobileSchema.safeParse('98200').success).toBe(false);
  });
  it('names accept Unicode letters and collapse spaces; reject digits and short names', () => {
    expect(nameSchema.parse('  Meera   Iyer ')).toBe('Meera Iyer');
    expect(nameSchema.parse("Ananya D'Souza-Rao")).toBe("Ananya D'Souza-Rao");
    expect(nameSchema.parse('राजेश कुलकर्णी')).toBe('राजेश कुलकर्णी');
    expect(nameSchema.safeParse('A').success).toBe(false);
    expect(nameSchema.safeParse('R2D2').success).toBe(false);
    expect(nameSchema.safeParse('x'.repeat(121)).success).toBe(false);
  });
  it('device label from the user agent', () => {
    expect(deviceLabelFor('Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537')).toBe(
      'Chrome on Android',
    );
    expect(deviceLabelFor('Mozilla/5.0 (Windows NT 10.0) Chrome/120 Edg/120')).toBe('Edge on Windows');
    expect(deviceLabelFor('')).toBe('Unknown device');
  });
});

describe('lockout counters (BR-02-28)', () => {
  beforeEach(resetAll);
  it('T02-06 four failures, a 16 minute wait, one failure: the count restarts at 1 with no lock', async () => {
    setNow('2026-11-01T04:00:00Z');
    for (let i = 0; i < 4; i++) await recordFailure('OTP', '9820011111');
    advance(16 * 60_000);
    const r = await recordFailure('OTP', '9820011111');
    expect(r).toMatchObject({ newlyLocked: false, alreadyLocked: false, attemptsLeft: 4 });
    expect(await lockRemainingSeconds('OTP', '9820011111')).toBe(0);
  });
  it('the fifth failure inside the window locks for 15 minutes; later failures are not counted', async () => {
    setNow('2026-11-01T04:00:00Z');
    let r;
    for (let i = 0; i < 5; i++) r = await recordFailure('OTP', '9820011111');
    expect(r).toMatchObject({ newlyLocked: true, attemptsLeft: 0, retryAfterSeconds: 900 });
    expect(await lockRemainingSeconds('OTP', '9820011111')).toBe(900);
    expect(await recordFailure('OTP', '9820011111')).toMatchObject({ alreadyLocked: true });
    advance(15 * 60_000 + 1);
    expect(await lockRemainingSeconds('OTP', '9820011111')).toBe(0);
    expect(await recordFailure('OTP', '9820011111')).toMatchObject({ newlyLocked: false, attemptsLeft: 4 });
  });
  it('a success resets the count', async () => {
    for (let i = 0; i < 3; i++) await recordFailure('MFA', '7');
    await resetLock('MFA', '7');
    expect((await recordFailure('MFA', '7')).attemptsLeft).toBe(4);
  });
  it('passwords lock after 10 failures for 30 minutes; the table holds only hashes', async () => {
    expect(LOCKOUT_POLICY.PASSWORD).toMatchObject({
      threshold: 10,
      windowMs: 30 * 60_000,
      lockMs: 30 * 60_000,
    });
    for (let i = 0; i < 10; i++) await recordFailure('PASSWORD', 'Chairman@SkyHeights.in');
    expect(await lockRemainingSeconds('PASSWORD', 'chairman@skyheights.in')).toBe(1800);
    const rows = await AuthLockout.findAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].subjectHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('unknown subjects lock exactly like real ones', async () => {
    for (let i = 0; i < 5; i++) await recordFailure('OTP', '6000000000');
    expect(await lockRemainingSeconds('OTP', '6000000000')).toBeGreaterThan(0);
  });
});
