import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, OnboardingStep, Society, SocietySetting, closeDb } from '../../../src/models';
import { advance } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { getSocietyInfo } from '../../../src/modules/access-control/access-control.access';
import { placeholderFiles } from '../../../src/modules/societies/societies.ports';
import { as, login, memberUser, resetLogins } from '../../helpers/access';
import { events, inboxFor } from '../../helpers/auth';
import { gstinFor, memberOf, resetSetup, setupSociety } from '../../helpers/society-setup';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetSetup);

const PAN = 'AAAAG1234C';
const GSTIN = gstinFor('27', PAN);
const patch = (c: any, body: Record<string, unknown>) => c('patch', '/society', body);
const reload = async (id: number) => (await Society.findByPk(id))!;

describe('GET /society (8.2)', () => {
  it('returns the profile with the extras from the profile.* settings, the version and isLive', async () => {
    const { society, c } = await setupSociety();
    const r = await c('get', '/society');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      id: society.id,
      name: 'Sky Heights CHS',
      slug: society.slug,
      state: 'Maharashtra',
      timezone: 'Asia/Kolkata',
      locale: 'en-IN',
      fyStartMonth: 4,
      status: 'ACTIVE',
      isLive: false,
      logoFileId: null,
      version: 1,
      profile: {
        societyType: 'COOPERATIVE_HOUSING_SOCIETY',
        pan: null,
        tan: null,
        registrationDate: null,
        contactEmail: null,
        contactPhone: null,
      },
    });
  });
});

describe('PATCH /society (8.3)', () => {
  it('US-08-01 saves legal details with a reason, audits the change, bumps the version and notifies the billing approvers', async () => {
    const { society, user, c } = await setupSociety();
    const r = await patch(c, {
      version: 1,
      legalName: 'Sky Heights Co-operative Housing Society Ltd',
      registrationNo: 'PNA/PNA(2)/HSG/TC/1234/2009',
      gstin: GSTIN,
      state: 'Maharashtra',
      profile: { pan: PAN },
      reason: 'Registration certificate received',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ gstin: GSTIN, version: 2, profile: { pan: PAN } });
    const row = await reload(society.id!);
    expect([row.legalName, row.registrationNo, row.gstin, row.version, row.updatedBy]).toEqual([
      'Sky Heights Co-operative Housing Society Ltd',
      'PNA/PNA(2)/HSG/TC/1234/2009',
      GSTIN,
      2,
      user.id,
    ]);
    const log = await AuditLog.findAll({
      where: { societyId: society.id!, action: 'setup.society.updated' },
    });
    expect(log).toHaveLength(1);
    expect(log[0]!.reason).toBe('Registration certificate received');
    expect(Object.keys(log[0]!.after as object).sort()).toEqual([
      'gstin',
      'legalName',
      'profile.pan',
      'registrationNo',
    ]);
    expect((log[0]!.before as any).gstin).toBeNull();
    // the profile.* key is stored without a separate settings audit row
    expect(
      await AuditLog.count({ where: { societyId: society.id!, action: 'setup.settings.updated' } }),
    ).toBe(0);
    expect(await SocietySetting.count({ where: { societyId: society.id!, settingKey: 'profile.pan' } })).toBe(
      1,
    );
    await new Promise(res => setTimeout(res, 50));
    expect((await inboxFor(user.email!)).some(m => /Legal details/.test(m.subject ?? ''))).toBe(true);
  });

  it('BR-08-1 never writes slug, organization, financial-year start, status or lifecycle columns; unknown fields are 400', async () => {
    const { c } = await setupSociety();
    for (const k of [
      'slug',
      'organizationId',
      'fyStartMonth',
      'status',
      'approxFlats',
      'trialEndsAt',
      'createdBy',
    ])
      expect((await patch(c, { version: 1, [k]: 1 })).status, k).toBe(400);
  });

  it('BR-08-1 version mismatch is STALE_VERSION and writes nothing', async () => {
    const { society, c } = await setupSociety();
    const r = await patch(c, { version: 5, name: 'Another Name' });
    expect([r.status, r.body.code]).toEqual([409, 'STALE_VERSION']);
    expect((await reload(society.id!)).name).toBe('Sky Heights CHS');
    expect((await patch(c, { name: 'No Version' })).status).toBe(400);
  });

  it('a non-legal edit needs no step-up and no reason; a request that changes nothing does not bump the version', async () => {
    const { society, user, c } = await setupSociety();
    advance(10 * 60_000);
    const r = await patch(c, {
      version: 1,
      name: 'Sky Heights Residents Society',
      city: 'Pune City',
      addressLine2: 'Near the lake',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.version).toBe(2);
    const same = await patch(c, { version: 2, name: 'Sky Heights Residents Society' });
    expect(same.status).toBe(200);
    expect(same.body.data.version).toBe(2);
    expect(await AuditLog.count({ where: { societyId: society.id!, action: 'setup.society.updated' } })).toBe(
      1,
    );
    void user;
  });

  it('BR-08-4 a legal change needs step-up (401 REAUTH_REQUIRED) and then a reason (400); an unchanged legal field needs neither', async () => {
    const { society, user, c } = await setupSociety();
    await patch(c, { version: 1, registrationNo: 'REG/1', reason: 'First registration entered' });
    advance(12 * 60_000);
    const stale = await patch(c, { version: 2, registrationNo: 'REG/2', reason: 'Corrected number' });
    expect([stale.status, stale.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    // the same value again is not a change, so no step-up
    const unchanged = await patch(c, { version: 2, registrationNo: 'REG/1', name: 'Sky Heights CHS Ltd' });
    expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);
    resetLogins();
    const fresh = as(await login(user));
    const noReason = await patch(fresh, { version: 3, registrationNo: 'REG/2' });
    expect([noReason.status, noReason.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(noReason.body.errors[0].field).toBe('reason');
    const ok = await patch(fresh, { version: 3, registrationNo: 'REG/2', reason: 'Corrected number' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await reload(society.id!)).registrationNo).toBe('REG/2');
  });

  it('BR-08-2 GSTIN: pattern 400, checksum, state and PAN mismatches 422', async () => {
    const { society, c } = await setupSociety();
    const send = (gstin: string, extra: Record<string, unknown> = {}) =>
      patch(c, { version: 1, gstin, reason: 'GST registration done', ...extra });
    expect((await send('NOTAGSTIN')).body.code).toBe('VALIDATION_FAILED');
    const wrongDigit = `${GSTIN.slice(0, 14)}${GSTIN[14] === '0' ? '1' : '0'}`;
    expect((await send(wrongDigit)).body.code).toBe('GSTIN_CHECKSUM_INVALID');
    const karnataka = gstinFor('29', PAN);
    const mismatch = await send(karnataka);
    expect([mismatch.status, mismatch.body.code]).toEqual([422, 'GSTIN_STATE_MISMATCH']);
    expect((await send(GSTIN, { profile: { pan: 'AAAAH9999Z' } })).body.code).toBe('GSTIN_PAN_MISMATCH');
    expect((await reload(society.id!)).gstin).toBeNull();
    // the same Karnataka GSTIN is fine when the state changes with it
    const ok = await send(karnataka, { state: 'Karnataka' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // lower case input is upper-cased
    const lower = await patch(c, {
      version: 2,
      gstin: GSTIN.toLowerCase().replace('z', 'z'),
      state: 'Maharashtra',
      reason: 'Moved the society',
    });
    expect(lower.status, JSON.stringify(lower.body)).toBe(200);
    expect(lower.body.data.gstin).toBe(GSTIN);
    // a PAN or state change that no longer fits the stored GSTIN is refused too
    expect((await patch(c, { version: 3, profile: { pan: 'AAAAH9999Z' } })).body.code).toBe(
      'GSTIN_PAN_MISMATCH',
    );
    expect((await patch(c, { version: 3, state: 'Goa' })).body.code).toBe('GSTIN_STATE_MISMATCH');
    // null clears the GSTIN
    const cleared = await patch(c, { version: 3, gstin: null, reason: 'Registration cancelled' });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.data.gstin).toBeNull();
  });

  it('the GSTIN cannot be removed while billing.applyGst is on', async () => {
    const { c } = await setupSociety();
    await patch(c, { version: 1, gstin: GSTIN, reason: 'GST registration done' });
    const on = await c('patch', '/society/settings', {
      changes: [{ key: 'billing.applyGst', value: true, version: 0 }],
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    const r = await patch(c, { version: 2, gstin: null, reason: 'Registration cancelled' });
    expect([r.status, r.body.code]).toEqual([422, 'GST_REQUIRES_GSTIN']);
  });

  it('BR-08-3 time zone and language change before go-live only (TIMEZONE_LOCKED after)', async () => {
    const { society, c } = await setupSociety();
    const before = await patch(c, { version: 1, timezone: 'Asia/Dubai', locale: 'hi-IN' });
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.data).toMatchObject({ timezone: 'Asia/Dubai', locale: 'hi-IN' });
    await OnboardingStep.bulkCreate([
      {
        societyId: society.id!,
        stepKey: 'GO_LIVE',
        stepNo: 8,
        isRequired: true,
        status: 'DONE',
        completedAt: new Date(),
        completedBy: null,
        skipReason: null,
        lastCheckSummary: null,
        version: 1,
        createdBy: null,
        updatedBy: null,
      },
    ]);
    const after = await patch(c, { version: 2, timezone: 'Asia/Kolkata' });
    expect([after.status, after.body.code]).toEqual([422, 'TIMEZONE_LOCKED']);
    expect((await patch(c, { version: 2, locale: 'en-IN' })).body.code).toBe('TIMEZONE_LOCKED');
    // an unchanged value is not a change
    expect((await patch(c, { version: 2, timezone: 'Asia/Dubai', name: 'Sky Heights Live' })).status).toBe(
      200,
    );
    expect((await c('get', '/society')).body.data.isLive).toBe(true);
    // invalid zones and locales are rejected by the schema
    expect((await patch(c, { version: 3, timezone: 'Mars/Base' })).status).toBe(400);
    expect((await patch(c, { version: 3, locale: 'fr-FR' })).status).toBe(400);
  });

  it('validates the fields of 8.3', async () => {
    const { c } = await setupSociety();
    const bad: Record<string, unknown>[] = [
      { name: 'ab' },
      { legalName: 'ab' },
      { registrationNo: '###' },
      { addressLine1: 'abc' },
      { city: 'x' },
      { state: 'Atlantis' },
      { pincode: '011045' },
      { logoFileId: 0 },
      { profile: { pan: 'bad' } },
      { profile: { unknown: 1 } },
      { reason: 'abc' },
    ];
    for (const b of bad) expect((await patch(c, { version: 1, ...b })).status, JSON.stringify(b)).toBe(400);
  });

  it('stores the profile extras with their own versions, lower-cases the e-mail and masks the phone in the audit row', async () => {
    const { society, c } = await setupSociety();
    const r = await patch(c, {
      version: 1,
      profile: {
        societyType: 'APARTMENT_OWNERS_ASSOCIATION',
        tan: 'PUNS12345A',
        registrationDate: '2009-06-15',
        contactEmail: 'Office@SkyHeights.IN',
        contactPhone: '9820011111',
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.profile).toMatchObject({
      societyType: 'APARTMENT_OWNERS_ASSOCIATION',
      tan: 'PUNS12345A',
      registrationDate: '2009-06-15',
      contactEmail: 'office@skyheights.in',
      contactPhone: '9820011111',
    });
    const log = (await AuditLog.findOne({
      where: { societyId: society.id!, action: 'setup.society.updated' },
    }))!;
    expect((log.after as any)['profile.contactPhone']).toBe('98XXXXX111');
    expect(JSON.stringify(log.after)).not.toContain('9820011111');
    // another save of one key bumps only that key
    await patch(c, { version: 2, profile: { contactPhone: '9820022222' } });
    const rows = await SocietySetting.findAll({ where: { societyId: society.id! } });
    expect(rows.find(x => x.settingKey === 'profile.contactPhone')!.version).toBe(2);
    expect(rows.find(x => x.settingKey === 'profile.tan')!.version).toBe(1);
    // null clears a profile value
    const clear = await patch(c, { version: 3, profile: { tan: null } });
    expect(clear.status, JSON.stringify(clear.body)).toBe(200);
    expect(clear.body.data.profile.tan).toBeNull();
  });

  it('masks the office phone for roles without residents.contacts.view', async () => {
    const { society, c } = await setupSociety();
    await patch(c, { version: 1, profile: { contactPhone: '9820011111' } });
    const member = await memberOf(society, 'committee_member');
    expect((await member.c('get', '/society')).body.data.profile.contactPhone).toBe('98XXXXX111');
    expect((await c('get', '/society')).body.data.profile.contactPhone).toBe('9820011111');
  });

  it('BR-08-5 the logo must be a SOCIETY_LOGO file of this society; it is linked in the same transaction', async () => {
    const { society, c } = await setupSociety();
    const file = (fileId: number, over: Record<string, unknown> = {}) =>
      placeholderFiles.set(fileId, {
        fileId,
        societyId: society.id!,
        purpose: 'SOCIETY_LOGO',
        name: 'logo.png',
        contentType: 'image/png',
        content: Buffer.from('x'),
        ownerUserId: null,
        status: 'CLEAN',
        ...over,
      });
    file(901);
    file(902, { purpose: 'IMPORT_FILE' });
    file(903, { societyId: society.id! + 999 });
    file(904, { status: 'DELETED' });
    for (const id of [902, 903, 904, 999]) {
      const r = await patch(c, { version: 1, logoFileId: id });
      expect([r.status, r.body.code], String(id)).toEqual([422, 'FILE_NOT_LINKABLE']);
    }
    expect((await reload(society.id!)).logoFileId).toBeNull();
    const ok = await patch(c, { version: 1, logoFileId: 901 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.logoFileId).toBe(901);
    expect((await patch(c, { version: 2, logoFileId: null })).body.data.logoFileId).toBeNull();
  });

  it('BR-08-6 the cached society info of module 03 is refreshed after commit, so the next request sees the new name', async () => {
    const { society, c } = await setupSociety();
    expect((await getSocietyInfo(society.id!))!.name).toBe('Sky Heights CHS'); // warms the cache
    await patch(c, { version: 1, name: 'Sky Heights Renamed', timezone: 'Asia/Dubai' });
    const info = (await getSocietyInfo(society.id!))!;
    expect([info.name, info.timezone]).toEqual(['Sky Heights Renamed', 'Asia/Dubai']);
  });

  it('is refused for a member who only views, and for another society (the id always comes from the session)', async () => {
    const { society } = await setupSociety();
    const auditor = as(await login(await memberUser(society, 'auditor')));
    expect((await auditor('get', '/society')).status).toBe(200);
    const r = await patch(auditor, { version: 1, name: 'Hacked Name' });
    expect([r.status, r.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(events.filter(e => e.event === 'setup.settings.updated')).toHaveLength(0);
  });
});
