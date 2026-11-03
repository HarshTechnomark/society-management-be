import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, NumberSequence, SocietySetting, Unit, closeDb, sequelize } from '../../../src/models';
import { advance } from '../../../src/lib/clock';
import { kv } from '../../../src/lib/kv';
import { drainQueues } from '../../../src/lib/queue';
import { systemCtx } from '../../../src/types/context';
import { ports } from '../../../src/modules/auth/auth.ports';
import { stepUpMinutesFor } from '../../../src/modules/auth/auth.sessions';
import { settings, societySettings } from '../../../src/modules/society-setup/society-setup.public';
import { clearSettingsCache } from '../../../src/modules/society-setup/society-setup.settings.service';
import { as, join, login, memberUser, resetLogins } from '../../helpers/access';
import { events, inboxFor } from '../../helpers/auth';
import { makeBuilding, makeUnit, memberOf, resetSetup, setupSociety } from '../../helpers/society-setup';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetSetup);

type Item = {
  key: string;
  value: unknown;
  version: number;
  canEdit: boolean;
  isDefault: boolean;
  appliesFrom?: string;
};
const read = async (c: any, query?: Record<string, string>) => {
  const r = await c('get', '/society/settings', undefined, { query });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const items = r.body.data.items as Item[];
  return { r, items, item: (k: string) => items.find(i => i.key === k)! };
};
const patch = (c: any, changes: unknown[], reason?: string) =>
  c('patch', '/society/settings', { changes, ...(reason ? { reason } : {}) });
const audits = (societyId: number, action: string) =>
  AuditLog.findAll({ where: { societyId, action }, order: [['id', 'ASC']] });

describe('GET /society/settings (8.4)', () => {
  it('returns every viewable key with its default, version 0 and rules; hides keys written elsewhere', async () => {
    const { c } = await setupSociety();
    const { items, item } = await read(c);
    expect(items.length).toBe(184); // 185 keys minus visitors.patrolPlans (hidden, editVia MODULE17)
    expect(items.some(i => i.key === 'visitors.patrolPlans')).toBe(false);
    expect(item('billing.dueDays')).toMatchObject({
      namespace: 'billing',
      type: 'INT',
      value: 15,
      default: 15,
      isDefault: true,
      version: 0,
      canEdit: true,
      requiresStepUp: false,
      requiresReason: false,
      editVia: 'SETTINGS',
      rules: { min: 0, max: 60 },
    });
    expect(item('security.adminIdleMinutes')).toMatchObject({
      requiresStepUp: true,
      requiresReason: true,
      rules: { oneOf: [5, 15, 30, 60] },
    });
    expect(item('profile.pan')).toMatchObject({ editVia: 'PROFILE', canEdit: false });
  });

  it('filters by namespace and by the view permission of the namespace', async () => {
    const { society, c } = await setupSociety();
    expect((await read(c, { namespace: 'office' })).items.map(i => i.key)).toEqual([
      'office.weeklyOffDays',
      'office.openTime',
      'office.closeTime',
    ]);
    // the accountant holds no settings.society.view but can see the finance, billing and payments keys
    const acc = as(await login(await memberUser(society, 'accountant')));
    const { items } = await read(acc);
    const namespaces = new Set(items.map(i => i.key.split('.')[0]));
    expect(namespaces.has('billing')).toBe(true);
    expect(namespaces.has('finance')).toBe(true);
    expect(namespaces.has('payments')).toBe(true);
    expect(namespaces.has('security')).toBe(false);
    expect(namespaces.has('office')).toBe(false);
    const bad = await c('get', '/society/settings', undefined, { query: { namespace: 'nope' } });
    expect([bad.status, bad.body.code]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('canEdit follows the namespace edit permission', async () => {
    const { society } = await setupSociety();
    const acc = as(await login(await memberUser(society, 'accountant')));
    const { item } = await read(acc);
    expect(item('billing.dueDays').canEdit).toBe(false); // billing_rules view only
    expect(item('finance.billRequiredAbovePaise').canEdit).toBe(true);
  });

  it('shows "applies from" on the prefix keys once a sequence row of the current year exists (BR-08-14)', async () => {
    const { society, c } = await setupSociety();
    expect((await read(c)).item('billing.invoicePrefix').appliesFrom).toBeUndefined();
    await NumberSequence.create({
      societyId: society.id!,
      series: 'INVOICE',
      financialYear: '2026-27',
      prefix: 'INV',
      nextValue: 5,
      padding: 6,
    });
    const { item } = await read(c);
    expect(item('billing.invoicePrefix').appliesFrom).toBe('2027-28');
    expect(item('billing.receiptPrefix').appliesFrom).toBe('2027-28');
    expect(item('billing.dueDays').appliesFrom).toBeUndefined();
  });
});

describe('PATCH /society/settings (8.5, BR-08-8, BR-08-9)', () => {
  it('saves a key, bumps the version, audits it with before and after, and tells the admin room', async () => {
    const { society, c } = await setupSociety();
    const r = await patch(c, [{ key: 'billing.dueDays', value: 9, version: 0 }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.items[0]).toMatchObject({
      key: 'billing.dueDays',
      value: 9,
      version: 1,
      isDefault: false,
    });
    const again = await patch(c, [{ key: 'billing.dueDays', value: 12, version: 1 }]);
    expect(again.body.data.items[0]).toMatchObject({ value: 12, version: 2 });
    const rows = await audits(society.id!, 'setup.settings.updated');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ entityType: 'society_setting', entityId: 'billing.dueDays' });
    expect(rows[0]!.before).toMatchObject({ value: 15, version: 0 });
    expect(rows[0]!.after).toMatchObject({ value: 9, version: 1 });
    expect(rows[1]!.before).toMatchObject({ value: 9 });
    const ev = events.filter(e => e.event === 'setup.settings.updated');
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({
      room: `society:${society.id}:admin`,
      payload: { keys: ['billing.dueDays'] },
    });
  });

  it('a value equal to the stored one is skipped: no version bump and no audit (BR-08-9)', async () => {
    const { society, c } = await setupSociety();
    await patch(c, [{ key: 'billing.dueDays', value: 9, version: 0 }]);
    const r = await patch(c, [{ key: 'billing.dueDays', value: 9, version: 1 }]);
    expect(r.status).toBe(200);
    expect(r.body.data.items[0].version).toBe(1);
    expect(await audits(society.id!, 'setup.settings.updated')).toHaveLength(1);
    expect(events.filter(e => e.event === 'setup.settings.updated')).toHaveLength(1);
  });

  it('T08-17 two parallel saves of a never-saved key: one 200 and one 409 STALE_VERSION', async () => {
    const { society, c } = await setupSociety();
    const rs = await Promise.all([
      patch(c, [{ key: 'billing.dueDays', value: 9, version: 0 }]),
      patch(c, [{ key: 'billing.dueDays', value: 10, version: 0 }]),
    ]);
    expect(rs.map(r => r.status).sort()).toEqual([200, 409]);
    expect(rs.find(r => r.status === 409)!.body.code).toBe('STALE_VERSION');
    expect(
      await SocietySetting.count({ where: { societyId: society.id!, settingKey: 'billing.dueDays' } }),
    ).toBe(1);
  });

  it('US-08-06 a stale version saves nothing, even for the other keys of the request', async () => {
    const { society, c } = await setupSociety();
    await patch(c, [{ key: 'billing.dueDays', value: 9, version: 0 }]);
    const r = await patch(c, [
      { key: 'billing.billingDay', value: 5, version: 0 },
      { key: 'billing.dueDays', value: 20, version: 0 },
    ]);
    expect([r.status, r.body.code]).toEqual([409, 'STALE_VERSION']);
    expect(r.body.errors.map((e: any) => e.field)).toEqual(['billing.dueDays']);
    expect(
      await SocietySetting.count({ where: { societyId: society.id!, settingKey: 'billing.billingDay' } }),
    ).toBe(0);
    // a version above the stored one is also stale
    expect((await patch(c, [{ key: 'billing.dueDays', value: 20, version: 7 }])).body.code).toBe(
      'STALE_VERSION',
    );
  });

  it('is all or nothing across keys: one invalid value refuses the lot', async () => {
    const { society, c } = await setupSociety();
    const r = await patch(c, [
      { key: 'billing.billingDay', value: 5, version: 0 },
      { key: 'billing.dueDays', value: 99, version: 0 },
    ]);
    expect([r.status, r.body.code]).toEqual([400, 'SETTING_VALUE_INVALID']);
    expect(r.body.errors).toHaveLength(1);
    expect(r.body.errors[0].field).toBe('billing.dueDays');
    expect(await SocietySetting.count({ where: { societyId: society.id! } })).toBe(0);
  });

  it('refuses unknown keys, malformed requests and keys edited elsewhere', async () => {
    const { c } = await setupSociety();
    const unknown = await patch(c, [{ key: 'billing.nothing', value: 1, version: 0 }]);
    expect([unknown.status, unknown.body.code]).toEqual([400, 'UNKNOWN_SETTING_KEY']);
    expect((await patch(c, [])).body.code).toBe('VALIDATION_FAILED');
    const dup = await patch(c, [
      { key: 'billing.dueDays', value: 1, version: 0 },
      { key: 'billing.dueDays', value: 2, version: 0 },
    ]);
    expect(dup.body.code).toBe('VALIDATION_FAILED');
    const profileKey = await patch(c, [{ key: 'profile.pan', value: 'AAAAG1234C', version: 0 }]);
    expect([profileKey.status, profileKey.body.code]).toEqual([422, 'SETTING_NOT_EDITABLE_HERE']);
    const patrol = await patch(c, [{ key: 'visitors.patrolPlans', value: [], version: 0 }]);
    expect([patrol.status, patrol.body.code]).toEqual([422, 'SETTING_NOT_EDITABLE_HERE']);
  });

  it('T08-18 an accountant without settings.billing_rules.edit gets 403 PERMISSION_DENIED naming the key', async () => {
    const { society, c } = await setupSociety();
    const acc = as(await login(await memberUser(society, 'accountant')));
    const r = await patch(acc, [{ key: 'billing.dueDays', value: 9, version: 0 }]);
    expect([r.status, r.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(r.body.errors[0].field).toBe('billing.dueDays');
    // finance keys are the accountant's own
    const ok = await patch(acc, [{ key: 'finance.billRequiredAbovePaise', value: 300000, version: 0 }]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // one key without permission refuses the whole request
    const mixed = await patch(acc, [
      { key: 'finance.expenseBackdateDays', value: 30, version: 0 },
      { key: 'billing.billingDay', value: 3, version: 0 },
    ]);
    expect(mixed.status).toBe(403);
    expect((await read(c)).item('finance.expenseBackdateDays').version).toBe(0);
  });

  it('a member without any edit permission is refused at the route; a view-only role cannot edit', async () => {
    const { society } = await setupSociety();
    const sec = as(await login(await memberUser(society, 'security_supervisor')));
    expect((await patch(sec, [{ key: 'billing.dueDays', value: 9, version: 0 }])).status).toBe(403);
    const treasurer = as(await login(await memberUser(society, 'committee_member')));
    const r = await patch(treasurer, [{ key: 'office.openTime', value: '08:00', version: 0 }]);
    expect([r.status, r.body.code]).toEqual([403, 'PERMISSION_DENIED']);
  });

  it('T08-20 and BR-08-10: cross-key rules on the merged result', async () => {
    const { society, c } = await setupSociety();
    const code = async (changes: unknown[]) => {
      const r = await patch(c, changes);
      return [r.status, r.body.code];
    };
    expect(await code([{ key: 'billing.invoicePrefix', value: 'RCT', version: 0 }])).toEqual([
      422,
      'PREFIX_CLASH',
    ]);
    expect(
      await code([
        { key: 'billing.invoicePrefix', value: 'FEE', version: 0 },
        { key: 'billing.receiptPrefix', value: 'FEE', version: 0 },
      ]),
    ).toEqual([422, 'PREFIX_CLASH']);
    expect(await code([{ key: 'office.openTime', value: '19:00', version: 0 }])).toEqual([
      422,
      'OFFICE_HOURS_INVALID',
    ]);
    expect(await code([{ key: 'communication.quietHoursStart', value: '07:00', version: 0 }])).toEqual([
      422,
      'QUIET_HOURS_INVALID',
    ]);
    expect(await code([{ key: 'billing.applyGst', value: true, version: 0 }])).toEqual([
      422,
      'GST_REQUIRES_GSTIN',
    ]);
    expect(await code([{ key: 'billing.lateFeeDefaultMode', value: 'FLAT', version: 0 }])).toEqual([
      422,
      'LATE_FEE_DEFAULT_INVALID',
    ]);
    expect(await code([{ key: 'billing.lateFeeDefaultRatePct', value: '0.0000', version: 0 }])).toEqual([
      422,
      'LATE_FEE_DEFAULT_INVALID',
    ]);
    expect(await code([{ key: 'committee.minStrength', value: 26, version: 0 }])).toEqual([
      400,
      'SETTING_VALUE_INVALID',
    ]);
    expect(await code([{ key: 'helpdesk.waitingAutoResolveDays', value: 2, version: 0 }])).toEqual([
      422,
      'HELPDESK_WAITING_RULE_INVALID',
    ]);
    expect(await SocietySetting.count({ where: { societyId: society.id! } })).toBe(0);
    // a valid combination is saved
    const ok = await patch(c, [
      { key: 'billing.lateFeeDefaultMode', value: 'FLAT', version: 0 },
      { key: 'billing.lateFeeDefaultFlatPaise', value: 50000, version: 0 },
      { key: 'office.openTime', value: '08:30', version: 0 },
      { key: 'office.closeTime', value: '20:00', version: 0 },
    ]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('GST can be switched on once the society has a GSTIN', async () => {
    const { society, c } = await setupSociety();
    await sequelize.query('UPDATE societies SET gstin = :g, state = "Maharashtra" WHERE id = :id', {
      replacements: { g: '27AAAAG1234C1ZE', id: society.id },
    });
    const r = await patch(c, [{ key: 'billing.applyGst', value: true, version: 0 }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('BR-08-11 keys that need a reason refuse a request without one (400 on reason)', async () => {
    const { c } = await setupSociety();
    const r = await patch(c, [{ key: 'billing.areaBasis', value: 'BUILT_UP', version: 0 }]);
    expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(r.body.errors[0].field).toBe('reason');
    const short = await patch(c, [{ key: 'billing.areaBasis', value: 'BUILT_UP', version: 0 }], 'ok');
    expect(short.body.code).toBe('VALIDATION_FAILED');
    // the first save of a never-saved key stores a row even with the default value, so it needs the reason too
    const same = await patch(c, [{ key: 'billing.areaBasis', value: 'CARPET', version: 0 }]);
    expect(same.status).toBe(400);
  });
});

describe('step-up keys (BR-08-11, T08-19, US-08-07)', () => {
  const change = (v = 15) => [{ key: 'security.adminIdleMinutes', value: v, version: 0 }];

  it('T08-19 needs a recent sign-in; after step-up it saves and getSessionPolicy returns 15', async () => {
    const { society, user, c } = await setupSociety();
    advance(10 * 60_000);
    const stale = await patch(c, change(), 'Committee decision 12 Oct 2026');
    expect([stale.status, stale.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    expect((await societySettings.getSessionPolicy(society.id!)).adminIdleMinutes).toBe(30);
    resetLogins();
    const fresh = as(await login(user));
    const ok = await patch(fresh, change(), 'Committee decision 12 Oct 2026');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.items[0]).toMatchObject({
      value: 15,
      default: 30,
      version: 1,
      requiresStepUp: true,
      requiresReason: true,
    });
    expect(await societySettings.getSessionPolicy(society.id!)).toEqual({
      adminIdleMinutes: 15,
      stepUpMinutes: 5,
    });
    expect(await ports().societySettings.getSessionPolicy(society.id!)).toEqual({
      adminIdleMinutes: 15,
      stepUpMinutes: 5,
    });
  });

  it('US-08-07 20 minutes is SETTING_VALUE_INVALID; a missing reason is VALIDATION_FAILED', async () => {
    const { c } = await setupSociety();
    const bad = await patch(c, change(20), 'Committee decision 12 Oct 2026');
    expect([bad.status, bad.body.code]).toEqual([400, 'SETTING_VALUE_INVALID']);
    const noReason = await patch(c, change());
    expect([noReason.status, noReason.body.code]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('notifies the people who can edit settings, audits the reason, and the new step-up window applies', async () => {
    const { society, user, c } = await setupSociety();
    const other = await memberUser(society, 'society_admin', { name: 'Admin' });
    const r = await patch(
      c,
      [{ key: 'security.stepUpMinutes', value: 10, version: 0 }],
      'Longer window for the committee',
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await drainQueues();
    expect((await audits(society.id!, 'setup.settings.updated'))[0]!.reason).toBe(
      'Longer window for the committee',
    );
    expect(await stepUpMinutesFor('ADMIN', society.id!)).toBe(10);
    await new Promise(res => setTimeout(res, 50));
    const mails = [...(await inboxFor(other.email!)), ...(await inboxFor(user.email!))].filter(m =>
      /Security settings changed/.test(m.subject ?? ''),
    );
    expect(mails.length).toBe(2);
  });

  it('finance.showFinancesToResidents needs step-up and a reason; finance.maxUnlockHours needs step-up only', async () => {
    const { user, c } = await setupSociety();
    const show = [{ key: 'finance.showFinancesToResidents', value: true, version: 0 }];
    expect((await patch(c, show)).body.code).toBe('VALIDATION_FAILED');
    expect((await patch(c, show, 'Committee approved sharing')).status).toBe(200);
    const unlock = [{ key: 'finance.maxUnlockHours', value: 48, version: 0 }];
    advance(10 * 60_000);
    expect((await patch(c, unlock)).body.code).toBe('REAUTH_REQUIRED');
    resetLogins();
    const fresh = as(await login(user));
    expect((await patch(fresh, unlock)).status).toBe(200);
  });
});

describe('BR-08-12 billing.areaBasis', () => {
  it('T08-16 recomputes every unit area in the same transaction and writes one audit row with the count', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const u1 = await makeUnit(c, b.id, '101', 1, { carpetAreaSqft: '1000', builtUpAreaSqft: '1200' });
    const u2 = await makeUnit(c, b.id, '102', 1, { carpetAreaSqft: '900' }); // no built-up area
    expect(u1.areaSqft).toBe('1000.000');
    const r = await patch(
      c,
      [{ key: 'billing.areaBasis', value: 'BUILT_UP', version: 0 }],
      'Bye-law amendment 2026',
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = await Unit.findAll({ where: { societyId: society.id! }, order: [['id', 'ASC']] });
    expect(rows.map(x => x.areaSqft)).toEqual(['1200.000', null]);
    const log = await audits(society.id!, 'setup.unit.area_recomputed');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ entityType: 'society', entityId: String(society.id) });
    expect(log[0]!.after).toMatchObject({ areaBasis: 'BUILT_UP', unitsRecomputed: 2 });
    expect(rows[0]!.version).toBeGreaterThan(u1.version);
    // new units follow the basis, and the units step now fails for the one without a built-up area
    const u3 = await makeUnit(c, b.id, '103', 1, { carpetAreaSqft: '800', builtUpAreaSqft: '950' });
    expect(u3.areaSqft).toBe('950.000');
    const onb = await c('get', '/onboarding');
    expect(onb.body.data.steps.find((s: any) => s.stepKey === 'UNITS').summary).toBe(
      '1 billable unit has no area',
    );
    void u2;
  });
});

describe('settings.get, getMany, getNamespace and the cache (BR-08-13)', () => {
  it('reads stored values over the registry defaults; a key without a row reads its default', async () => {
    const { society, c } = await setupSociety();
    expect(await settings.get(society.id!, 'billing.dueDays')).toBe(15);
    await patch(c, [
      { key: 'billing.dueDays', value: 9, version: 0 },
      { key: 'billing.billingDay', value: 5, version: 0 },
    ]);
    expect(await settings.get(society.id!, 'billing.dueDays')).toBe(9);
    expect(await settings.getMany(society.id!, ['billing.dueDays', 'billing.cycle'])).toEqual({
      'billing.dueDays': 9,
      'billing.cycle': 'MONTHLY',
    });
    const ns = await settings.getNamespace(society.id!, 'billing');
    expect(ns['billing.billingDay']).toBe(5);
    expect(Object.keys(ns)).toHaveLength(15);
    await expect(settings.get(society.id!, 'billing.nope')).rejects.toMatchObject({
      code: 'UNKNOWN_SETTING_KEY',
    });
  });

  it('caches all rows of the society under ss:set:<id> and deletes the entry after a save', async () => {
    const { society, c } = await setupSociety();
    await settings.get(society.id!, 'billing.dueDays');
    const key = `ss:set:${society.id}`;
    expect(await kv().cacheGet(key)).not.toBeNull();
    await patch(c, [{ key: 'billing.dueDays', value: 9, version: 0 }]);
    // the entry was deleted after commit; the next read loads and caches the new value
    expect(await settings.get(society.id!, 'billing.dueDays')).toBe(9);
    expect(JSON.parse((await kv().cacheGet(key))!)).toMatchObject({
      'billing.dueDays': { value: 9, version: 1 },
    });
    await clearSettingsCache(society.id!);
    expect(await kv().cacheGet(key)).toBeNull();
  });

  it('an invalid stored value is ignored and the default is used', async () => {
    const { society } = await setupSociety();
    await SocietySetting.create({
      societyId: society.id!,
      settingKey: 'billing.dueDays',
      valueJson: 999,
      version: 1,
      createdBy: null,
      updatedBy: null,
    });
    await clearSettingsCache(society.id!);
    expect(await settings.get(society.id!, 'billing.dueDays')).toBe(15);
  });

  it('a society never sees another society values', async () => {
    const a = await setupSociety({ name: 'A CHS' });
    const b = await setupSociety({ name: 'B CHS' });
    await patch(a.c, [{ key: 'billing.dueDays', value: 9, version: 0 }]);
    expect(await settings.get(b.society.id!, 'billing.dueDays')).toBe(15);
    expect((await read(b.c)).item('billing.dueDays').version).toBe(0);
  });
});

describe('settings.set and settings.setMany for other modules (BR-08-10a, T08-41)', () => {
  const sys = systemCtx('t');

  it('T08-41 validates with the registry, saves with one audit row and applies the cross-key rules', async () => {
    const { society } = await setupSociety();
    const sid = society.id!;
    await expect(
      sequelize.transaction(t => settings.set(sys, sid, 'approvals.stepUpAbovePaise', 99999, t)),
    ).rejects.toMatchObject({ status: 400, code: 'SETTING_VALUE_INVALID' });
    const saved = await sequelize.transaction(t =>
      settings.set(sys, sid, 'approvals.stepUpAbovePaise', 5_000_000, t),
    );
    expect(saved).toMatchObject({
      key: 'approvals.stepUpAbovePaise',
      value: 5_000_000,
      version: 1,
      changed: true,
    });
    expect(await audits(sid, 'setup.settings.updated')).toHaveLength(1);
    expect(await settings.get(sid, 'approvals.stepUpAbovePaise')).toBe(5_000_000);
    await expect(
      sequelize.transaction(t => settings.set(sys, sid, 'committee.minStrength', 30, t)),
    ).rejects.toMatchObject({ status: 400, code: 'SETTING_VALUE_INVALID' });
    await expect(
      sequelize.transaction(t =>
        settings.setMany(
          sys,
          sid,
          [
            { key: 'committee.minStrength', value: 10 },
            { key: 'committee.maxStrength', value: 8 },
          ],
          t,
        ),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'COMMITTEE_STRENGTH_INVALID' });
    expect(await settings.get(sid, 'committee.minStrength')).toBe(3);
  });

  it('an equal value is changed:false without an audit row; a given version is compared; no version means no comparison', async () => {
    const { society } = await setupSociety();
    const sid = society.id!;
    await sequelize.transaction(t => settings.set(sys, sid, 'billing.dueDays', 9, t));
    const same = await sequelize.transaction(t => settings.set(sys, sid, 'billing.dueDays', 9, t));
    expect(same).toMatchObject({ changed: false, version: 1 });
    expect(await audits(sid, 'setup.settings.updated')).toHaveLength(1);
    await expect(
      sequelize.transaction(t => settings.set(sys, sid, 'billing.dueDays', 10, t, { version: 0 })),
    ).rejects.toMatchObject({ status: 409, code: 'STALE_VERSION' });
    const ok = await sequelize.transaction(t =>
      settings.set(sys, sid, 'billing.dueDays', 10, t, { version: 1, reason: 'Module 11 request' }),
    );
    expect(ok).toMatchObject({ version: 2, changed: true });
    expect((await audits(sid, 'setup.settings.updated'))[1]!.reason).toBe('Module 11 request');
  });

  it('writes in the caller transaction: a rollback leaves nothing behind and no cache or event', async () => {
    const { society } = await setupSociety();
    const sid = society.id!;
    await expect(
      sequelize.transaction(async t => {
        await settings.set(sys, sid, 'billing.dueDays', 9, t);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await SocietySetting.count({ where: { societyId: sid } })).toBe(0);
    expect(await audits(sid, 'setup.settings.updated')).toHaveLength(0);
    expect(events.filter(e => e.event === 'setup.settings.updated')).toHaveLength(0);
  });

  it('checks the namespace edit permission when the context is a user; PROFILE and MODULE17 keys may be written by their owners', async () => {
    const { society, user } = await setupSociety();
    const sid = society.id!;
    const acc = await memberUser(society, 'accountant');
    const userCtx = (u: { id: number }, perms: string[]) => ({
      ...systemCtx('t'),
      user: { id: u.id, name: 'U', mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' },
      permissions: new Set(perms),
    });
    await expect(
      sequelize.transaction(t =>
        settings.set(userCtx(acc, ['finance.accounts.edit']), sid, 'billing.dueDays', 9, t),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    await sequelize.transaction(t =>
      settings.set(userCtx(user, ['settings.billing_rules.edit']), sid, 'billing.dueDays', 9, t),
    );
    const plans = await sequelize.transaction(t =>
      settings.set(sys, sid, 'visitors.patrolPlans', [{ key: 'night' }], t),
    );
    expect(plans.changed).toBe(true);
    void join;
  });

  it('keys with a row of a removed registry key are ignored on read', async () => {
    const { society } = await setupSociety();
    await SocietySetting.create({
      societyId: society.id!,
      settingKey: 'old.removed',
      valueJson: 1,
      version: 1,
      createdBy: null,
      updatedBy: null,
    });
    await clearSettingsCache(society.id!);
    expect(await settings.getMany(society.id!, ['billing.dueDays'])).toEqual({ 'billing.dueDays': 15 });
  });
});

describe('support and other roles', () => {
  it('a committee member can read the settings and sees the office phone masked', async () => {
    const { society, c } = await setupSociety();
    const set = await c('patch', '/society', { version: 1, profile: { contactPhone: '9820011111' } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const member = await memberOf(society, 'committee_member');
    const { item } = await read(member.c);
    expect(item('profile.contactPhone').value).toBe('98XXXXX111');
    expect((await read(c)).item('profile.contactPhone').value).toBe('9820011111');
  });
});

void Unit;
