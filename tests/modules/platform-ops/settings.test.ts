import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, PlatformSetting, Session, closeDb, sequelize } from '../../../src/models';
import { advance, setNow } from '../../../src/lib/clock';
import { ports } from '../../../src/modules/auth/auth.ports';
import { billingSettings } from '../../../src/modules/platform-billing/platform-billing.settings';
import { societyPorts } from '../../../src/modules/societies/societies.ports';
import {
  SETTINGS_REGISTRY,
  SETTING_KEYS,
} from '../../../src/modules/platform-ops/platform-ops.settings-registry';
import {
  clearSettingsCache,
  getPlatformSetting,
  getStoredSetting,
  seedPlatformSettings,
  settingsEvents,
} from '../../../src/modules/platform-ops/platform-ops.settings.service';
import { call, cookiesFrom } from '../../helpers/auth';
import { as, memberUser, login, resetLogins } from '../../helpers/access';
import { platformAs } from '../../helpers/societies';
import { opsSociety, resetOps } from '../../helpers/platform-ops';

afterAll(closeDb);
beforeEach(async () => {
  await resetOps();
  resetLogins();
  setNow('2026-10-30T04:00:00Z');
});

type Cat = Record<string, { key: string; version: number; value: unknown }[]>;
const read = async (c: any) => {
  const r = await c('get', '/platform/settings');
  const flat = Object.values(r.body.data.categories as Cat).flat();
  return {
    r,
    flat,
    ver: (k: string) => flat.find(s => s.key === k)!.version,
    val: (k: string) => flat.find(s => s.key === k)!.value,
  };
};
const patch = (c: any, changes: unknown[], reason?: string) =>
  c('patch', '/platform/settings', { changes, ...(reason ? { reason } : {}) });

describe('GET /platform/settings (8.10)', () => {
  it('lists every key by category without the archive manifest; Platform Support may read', async () => {
    const agent = await platformAs('platform_support');
    const { r, flat } = await read(agent.c);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Object.keys(r.body.data.categories)).toEqual([
      'GENERAL',
      'BILLING',
      'LIFECYCLE',
      'SECURITY',
      'NOTIFICATIONS',
      'SUPPORT',
      'DATA',
      'STATUS',
    ]);
    expect(flat).toHaveLength(39);
    expect(flat.some(s => s.key === 'audit.archiveManifest')).toBe(false);
    expect(r.body.data.categories.SUPPORT.map((s: any) => s.key)).toEqual([
      'support.slaHours',
      'support.autoCloseDays',
      'support.waitingAutoResolveDays',
      'support.maxOpenTicketsPerSociety',
    ]);
    expect(r.body.data.categories.BILLING[0]).toMatchObject({
      key: 'billing.sacCode',
      valueType: 'STRING',
      value: '998314',
      isReadOnly: false,
      version: 1,
      updatedBy: null,
    });
    expect(await PlatformSetting.count()).toBe(40);
  });

  it('T07-22 Platform Support cannot PATCH settings', async () => {
    const agent = await platformAs('platform_support');
    const r = await patch(agent.c, [{ key: 'support.autoCloseDays', value: 10, version: 1 }]);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PERMISSION_DENIED');
  });
});

describe('PATCH /platform/settings (BR-07-48)', () => {
  it('saves several keys at once: version + 1 each, one audit row per key, cache and event after commit', async () => {
    const sa = await platformAs('super_admin', 'Asha Admin');
    const { ver } = await read(sa.c);
    const heard: unknown[] = [];
    settingsEvents.once('platform-ops:settings-changed', e => heard.push(e));
    expect(await getPlatformSetting('support.autoCloseDays')).toBe(7); // warms the cache
    const r = await patch(sa.c, [
      { key: 'support.autoCloseDays', value: 10, version: ver('support.autoCloseDays') },
      { key: 'alerts.pastDue', value: false, version: ver('alerts.pastDue') },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const flat = Object.values(r.body.data.categories as Cat).flat();
    expect(flat.find(s => s.key === 'support.autoCloseDays')).toMatchObject({
      value: 10,
      version: 2,
      updatedBy: { id: sa.user.id, name: 'Asha Admin' },
    });
    const rows = await AuditLog.findAll({
      where: { action: 'platform.setting.updated' },
      order: [['id', 'ASC']],
    });
    expect(rows.map(a => [a.entityType, a.entityId, a.societyId])).toEqual([
      ['platform_setting', 'support.autoCloseDays', null],
      ['platform_setting', 'alerts.pastDue', null],
    ]);
    expect(rows[0]!.before).toEqual({ value: 7, version: 1 });
    expect(rows[0]!.after).toEqual({ value: 10, version: 2 });
    expect(await getPlatformSetting('support.autoCloseDays')).toBe(10); // cache dropped on commit
    expect(heard).toEqual([{ keys: ['support.autoCloseDays', 'alerts.pastDue'] }]);
  });

  it('a value equal to the current one is skipped: no version bump, no audit', async () => {
    const sa = await platformAs('super_admin');
    const { ver } = await read(sa.c);
    const r = await patch(sa.c, [
      { key: 'support.autoCloseDays', value: 7, version: ver('support.autoCloseDays') },
    ]);
    expect(r.status).toBe(200);
    expect((await read(sa.c)).ver('support.autoCloseDays')).toBe(1);
    expect(await AuditLog.count({ where: { action: 'platform.setting.updated' } })).toBe(0);
  });

  it('T07-49 an unknown key is 400 UNKNOWN_SETTING_KEY', async () => {
    const sa = await platformAs('super_admin');
    const r = await patch(sa.c, [{ key: 'billing.foo', value: 1, version: 1 }]);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('UNKNOWN_SETTING_KEY');
  });

  it('T07-48 a read-only key is 422 SETTING_READ_ONLY', async () => {
    const sa = await platformAs('super_admin');
    const r = await patch(sa.c, [{ key: 'audit.archiveManifest', value: [], version: 1 }]);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('SETTING_READ_ONLY');
  });

  it('an invalid value is 400 SETTING_VALUE_INVALID with errors per key and nothing is saved', async () => {
    const sa = await platformAs('super_admin');
    const { ver } = await read(sa.c);
    const r = await patch(sa.c, [
      { key: 'alerts.pastDue', value: false, version: ver('alerts.pastDue') },
      { key: 'billing.netTermsDays', value: 3, version: ver('billing.netTermsDays') },
      { key: 'billing.gstRatePct', value: 18, version: ver('billing.gstRatePct') },
    ]);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('SETTING_VALUE_INVALID');
    expect(r.body.errors.map((e: any) => e.field).sort()).toEqual([
      'billing.gstRatePct',
      'billing.netTermsDays',
    ]);
    expect((await read(sa.c)).val('alerts.pastDue')).toBe(true);
  });

  it('stale version is 409 STALE_VERSION and saves nothing; different keys by two admins both succeed', async () => {
    const sa = await platformAs('super_admin');
    const { ver } = await read(sa.c);
    expect((await patch(sa.c, [{ key: 'support.autoCloseDays', value: 9, version: 1 }])).status).toBe(200);
    const stale = await patch(sa.c, [
      { key: 'alerts.pastDue', value: false, version: ver('alerts.pastDue') },
      { key: 'support.autoCloseDays', value: 12, version: 1 },
    ]);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    expect((await read(sa.c)).val('alerts.pastDue')).toBe(true);
    expect((await patch(sa.c, [{ key: 'alerts.pastDue', value: false, version: 1 }])).status).toBe(200);
  });

  it('T07-47 cross-key rules are checked on the merged result', async () => {
    const sa = await platformAs('super_admin');
    const { ver } = await read(sa.c);
    const a = await patch(sa.c, [
      { key: 'billing.suspendAfterDays', value: 2, version: ver('billing.suspendAfterDays') },
    ]);
    expect(a.status).toBe(200); // default pastDueAfterDays is 1: 2 is allowed
    const b = await patch(sa.c, [
      { key: 'billing.pastDueAfterDays', value: 3, version: ver('billing.pastDueAfterDays') },
    ]);
    expect(b.status).toBe(422);
    expect(b.body.code).toBe('SUSPEND_NOT_AFTER_PAST_DUE'); // suspend 2 < 3 + 1
    const c2 = await patch(sa.c, [
      { key: 'billing.pastDueAfterDays', value: 3, version: ver('billing.pastDueAfterDays') },
      { key: 'billing.suspendAfterDays', value: 4, version: 2 },
    ]);
    expect(c2.status, JSON.stringify(c2.body)).toBe(200);
    const d = await patch(sa.c, [
      { key: 'billing.netTermsDays', value: 7, version: ver('billing.netTermsDays') },
    ]);
    expect(d.status).toBe(200); // offsets start at -7: fine
    const e = await patch(sa.c, [
      { key: 'billing.reminderOffsetsDays', value: [-10, 0], version: ver('billing.reminderOffsetsDays') },
    ]);
    expect(e.body.code).toBe('REMINDER_BEFORE_ISSUE');
    const f = await patch(sa.c, [
      { key: 'company.stateCode', value: '29', version: ver('company.stateCode') },
    ]);
    expect(f.body.code).toBe('GSTIN_STATE_MISMATCH');
    const g = await patch(sa.c, [
      { key: 'company.stateCode', value: '29', version: ver('company.stateCode') },
      { key: 'company.gstin', value: '29ABCDE1234F1Z5', version: ver('company.gstin') },
    ]);
    expect(g.status, JSON.stringify(g.body)).toBe(200);
  });

  it('a SECURITY key needs a reason and a recent sign-in (step-up)', async () => {
    const sa = await platformAs('super_admin');
    const { ver } = await read(sa.c);
    const key = { key: 'security.idleMinutes', value: 15, version: ver('security.idleMinutes') };
    const noReason = await patch(sa.c, [key]);
    expect(noReason.status).toBe(400);
    expect(noReason.body.errors[0].field).toBe('reason');
    const ok = await patch(sa.c, [key], 'Shorter sessions after the audit');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await AuditLog.findOne({ where: { entityId: 'security.idleMinutes' } }))!.reason).toBe(
      'Shorter sessions after the audit',
    );
    // not a security key: no reason, no step-up
    advance(6 * 60_000);
    const plain = await patch(sa.c, [
      { key: 'alerts.pastDue', value: false, version: ver('alerts.pastDue') },
    ]);
    expect(plain.status).toBe(200);
    const stale = await patch(
      sa.c,
      [{ key: 'security.stepUpMinutes', value: 10, version: ver('security.stepUpMinutes') }],
      'Longer step-up',
    );
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
  });

  it('T07-50 the IP allowlist: refuses to lock the saver out, then blocks other addresses on every platform route', async () => {
    const sa = await platformAs('super_admin');
    const { ver } = await read(sa.c);
    const excl = await patch(
      sa.c,
      [{ key: 'security.ipAllowlist', value: ['10.0.0.0/8'], version: ver('security.ipAllowlist') }],
      'Office network only',
    );
    expect(excl.status).toBe(422);
    expect(excl.body.code).toBe('ALLOWLIST_EXCLUDES_YOU');
    const mine = await sa.c(
      'patch',
      '/platform/settings',
      {
        changes: [
          { key: 'security.ipAllowlist', value: ['10.0.0.0/8'], version: ver('security.ipAllowlist') },
        ],
        reason: 'Office network only',
      },
      { headers: { 'X-Forwarded-For': '10.1.2.3' } },
    );
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    await clearSettingsCache();
    const blocked = await sa.c('get', '/platform/settings', undefined, {
      headers: { 'X-Forwarded-For': '203.0.113.24' },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('IP_NOT_ALLOWED');
    const blocked2 = await sa.c('get', '/platform/societies', undefined, {
      headers: { 'X-Forwarded-For': '203.0.113.24' },
    });
    expect(blocked2.body.code).toBe('IP_NOT_ALLOWED'); // other modules' platform routes too
    const allowed = await sa.c('get', '/platform/settings', undefined, {
      headers: { 'X-Forwarded-For': '10.9.9.9' },
    });
    expect(allowed.status).toBe(200);
    // society routes are not affected
    const society = await opsSociety();
    const user = await memberUser(society, 'treasurer');
    expect(
      (
        await as(await login(user))('get', '/support-tickets', undefined, {
          headers: { 'X-Forwarded-For': '203.0.113.24' },
        })
      ).status,
    ).toBe(200);
  });

  it('validation: 1 to 30 unique changes, strict body', async () => {
    const sa = await platformAs('super_admin');
    expect((await patch(sa.c, [])).status).toBe(400);
    expect(
      (
        await patch(sa.c, [
          { key: 'alerts.pastDue', value: true, version: 1 },
          { key: 'alerts.pastDue', value: false, version: 1 },
        ])
      ).status,
    ).toBe(400);
    expect(
      (
        await sa.c('patch', '/platform/settings', {
          changes: [{ key: 'alerts.pastDue', value: true, version: 0 }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await sa.c('patch', '/platform/settings', {
          changes: [{ key: 'alerts.pastDue', value: true, version: 1 }],
          extra: 1,
        })
      ).status,
    ).toBe(400);
  });
});

describe('settings reader and wiring into modules 02, 05 and 06 (7.1, 8.13)', () => {
  it('the seeder inserts every missing key with its default and never overwrites', async () => {
    expect((await seedPlatformSettings()).added).toBe(40);
    expect(await PlatformSetting.count()).toBe(40);
    await PlatformSetting.update(
      { valueJson: 21 as never },
      { where: { settingKey: 'lifecycle.trialDays' } },
    );
    await PlatformSetting.destroy({ where: { settingKey: 'status.publicEnabled' } });
    expect((await seedPlatformSettings()).added).toBe(1);
    expect((await PlatformSetting.findOne({ where: { settingKey: 'lifecycle.trialDays' } }))!.valueJson).toBe(
      21,
    );
    const rows = await PlatformSetting.findAll();
    for (const k of SETTING_KEYS) {
      const row = rows.find(r => r.settingKey === k)!;
      if (k !== 'lifecycle.trialDays') expect(row.valueJson, k).toEqual(SETTINGS_REGISTRY[k].default);
      expect(row.category).toBe(SETTINGS_REGISTRY[k].category);
      expect(row.valueType).toBe(SETTINGS_REGISTRY[k].type);
    }
  });

  it('the database CHECK refuses a malformed key and a wrong category', async () => {
    const base = {
      valueType: 'INTEGER',
      valueJson: 1,
      isReadOnly: false,
      description: 'x',
      version: 1,
      createdBy: null,
      updatedBy: null,
    } as const;
    await expect(
      PlatformSetting.create({ ...base, settingKey: 'Bad Key', category: 'GENERAL' }),
    ).rejects.toThrow();
    await expect(
      PlatformSetting.create({ ...base, settingKey: 'single', category: 'GENERAL' }),
    ).rejects.toThrow();
    await expect(
      PlatformSetting.create({ ...base, settingKey: 'a.b', category: 'NOPE' as never }),
    ).rejects.toThrow();
    await PlatformSetting.create({ ...base, settingKey: 'a.b', category: 'GENERAL' });
    await expect(
      PlatformSetting.create({ ...base, settingKey: 'a.b', category: 'GENERAL' }),
    ).rejects.toThrow();
  });

  it('getPlatformSetting: registry default without a row, stored value with one, cached for 60 seconds', async () => {
    expect(await getPlatformSetting('billing.netTermsDays')).toBe(15);
    expect(await getStoredSetting('billing.netTermsDays')).toBeUndefined();
    await seedPlatformSettings(); // drops the cached "missing"
    expect(await getStoredSetting('billing.netTermsDays')).toBe(15);
    await PlatformSetting.update(
      { valueJson: 20 as never },
      { where: { settingKey: 'billing.netTermsDays' } },
    );
    expect(await getPlatformSetting('billing.netTermsDays')).toBe(15); // cached for 60 s
    advance(61_000);
    expect(await getPlatformSetting('billing.netTermsDays')).toBe(20);
    await PlatformSetting.update(
      { valueJson: 99 as never },
      { where: { settingKey: 'billing.netTermsDays' } },
    );
    advance(61_000);
    expect(await getPlatformSetting('billing.netTermsDays')).toBe(15); // an invalid stored value falls back to the default
  });

  it('module 05 settings port, module 06 billing settings and module 02 session policy read the saved values', async () => {
    const sa = await platformAs('super_admin');
    expect((await billingSettings())['company.address']).toContain('Registered office'); // module 06 default while no row exists
    const { ver } = await read(sa.c);
    expect(await societyPorts().settings.get('lifecycle.trialDays')).toBe(14);
    expect((await billingSettings())['billing.netTermsDays']).toBe(15);
    expect((await billingSettings())['company.address']).toBe(
      'Office 401, Baner Road, Pune, Maharashtra 411045',
    ); // seeded registry default
    const r = await patch(
      sa.c,
      [
        { key: 'lifecycle.trialDays', value: 21, version: ver('lifecycle.trialDays') },
        { key: 'billing.netTermsDays', value: 30, version: ver('billing.netTermsDays') },
        { key: 'security.idleMinutes', value: 15, version: ver('security.idleMinutes') },
      ],
      'Align with policy',
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await societyPorts().settings.get('lifecycle.trialDays')).toBe(21);
    expect((await billingSettings())['billing.netTermsDays']).toBe(30);
    expect(await ports().getPlatformSetting('security.idleMinutes')).toBe(15);
    expect(await ports().getPlatformSetting('security.stepUpMinutes')).toBe(5);
    // a new platform session picks up the 15-minute idle timeout
    const u = await platformAs('platform_support');
    const s = await Session.findOne({ where: { userId: u.user.id }, order: [['id', 'DESC']] });
    expect(s!.idleTimeoutMinutes).toBe(15);
    void call;
    void cookiesFrom;
    void sequelize;
  });
});
