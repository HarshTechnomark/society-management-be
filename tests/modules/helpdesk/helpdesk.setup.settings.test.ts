import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { helpdeskApiWorld } from '../../helpers/helpdesk';
import { SETTING } from '../../../src/modules/helpdesk/helpdesk.constants';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});

let w: Awaited<ReturnType<typeof helpdeskApiWorld>>;
let admin: Awaited<ReturnType<typeof w.api>>;
beforeAll(async () => {
  w = await helpdeskApiWorld('PREMIUM', ['chairman', 'facility_manager', 'accountant', 'treasurer']);
  admin = await w.api('chairman');
});

describe('GET and PATCH /helpdesk/settings (8.6, 7.9)', () => {
  it('returns the 15 keys with defaults and version 0; viewers read, others 403', async () => {
    const r = await admin('get', '/helpdesk/settings');
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.data).sort()).toEqual(Object.values(SETTING).sort());
    expect(r.body.data['helpdesk.autoCloseHours']).toEqual({ value: 72, version: 0 });
    expect(r.body.data['helpdesk.showReporterOnBuildingIssues']).toEqual({ value: false, version: 0 });
    expect(r.body.data['helpdesk.residentDailyTicketLimit'].value).toBe(20);
    expect((await (await w.api('facility_manager'))('get', '/helpdesk/settings')).status).toBe(200);
    expect((await (await w.api('accountant'))('get', '/helpdesk/settings')).status).toBe(403);
  });
  it('changes values through module 08 (versions, audit per key, defaults restored by value)', async () => {
    const r = await admin('patch', '/helpdesk/settings', {
      changes: [
        { key: 'helpdesk.autoCloseHours', value: 48, version: 0 },
        { key: 'helpdesk.showReporterOnBuildingIssues', value: true },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.data['helpdesk.autoCloseHours']).toEqual({ value: 48, version: 1 });
    expect(r.body.data['helpdesk.showReporterOnBuildingIssues'].value).toBe(true);
    expect(
      await AuditLog.count({ where: { societyId: w.sid, action: 'setup.settings.updated' } }),
    ).toBeGreaterThanOrEqual(2);
    const again = await admin('patch', '/helpdesk/settings', {
      changes: [{ key: 'helpdesk.autoCloseHours', value: 96, version: 1 }],
    });
    expect(again.body.data['helpdesk.autoCloseHours']).toEqual({ value: 96, version: 2 });
    expect((await admin('get', '/helpdesk/settings')).body.data['helpdesk.autoCloseHours'].value).toBe(96);
  });
  it('errors: 409 STALE_VERSION, 400 SETTING_VALUE_INVALID, 400 UNKNOWN_SETTING_KEY (also for other namespaces), 422 waiting rule', async () => {
    const stale = await admin('patch', '/helpdesk/settings', {
      changes: [{ key: 'helpdesk.maxReopens', value: 5, version: 3 }],
    });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const range = await admin('patch', '/helpdesk/settings', {
      changes: [{ key: 'helpdesk.autoCloseHours', value: 10 }],
    });
    expect([range.status, range.body.code]).toEqual([400, 'SETTING_VALUE_INVALID']);
    const unknown = await admin('patch', '/helpdesk/settings', {
      changes: [{ key: 'helpdesk.nothing', value: 1 }],
    });
    expect([unknown.status, unknown.body.code]).toEqual([400, 'UNKNOWN_SETTING_KEY']);
    const other = await admin('patch', '/helpdesk/settings', {
      changes: [{ key: 'office.openTime', value: '08:00' }],
    });
    expect([other.status, other.body.code]).toEqual([400, 'UNKNOWN_SETTING_KEY']);
    const rule = await admin('patch', '/helpdesk/settings', {
      changes: [
        { key: 'helpdesk.waitingReminderHours', value: 120 },
        { key: 'helpdesk.waitingAutoResolveDays', value: 2 },
      ],
    });
    expect([rule.status, rule.body.code]).toEqual([422, 'HELPDESK_WAITING_RULE_INVALID']);
    expect((await admin('get', '/helpdesk/settings')).body.data['helpdesk.waitingReminderHours'].value).toBe(
      72,
    );
  });
  it('400 for an empty list, 16 items, duplicate keys, unknown fields', async () => {
    for (const body of [
      { changes: [] },
      { changes: Array.from({ length: 16 }, () => ({ key: 'helpdesk.maxReopens', value: 3 })) },
      {
        changes: [
          { key: 'helpdesk.maxReopens', value: 3 },
          { key: 'helpdesk.maxReopens', value: 4 },
        ],
      },
      { changes: [{ key: 'helpdesk.maxReopens', value: 3, extra: 1 }] },
      { changes: [{ key: 'helpdesk.maxReopens', value: 3 }], other: 1 },
      {},
    ]) {
      const r = await admin('patch', '/helpdesk/settings', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }
  });
  it('403 without settings.edit; settings of another society are untouched', async () => {
    for (const role of ['accountant', 'treasurer'])
      expect(
        (
          await (
            await w.api(role)
          )('patch', '/helpdesk/settings', { changes: [{ key: 'helpdesk.maxReopens', value: 5 }] })
        ).status,
        role,
      ).toBe(403);
    const other = await helpdeskApiWorld('PREMIUM', ['chairman'], { reset: false });
    const oapi = await other.api('chairman');
    const r = await oapi('get', '/helpdesk/settings');
    expect(r.body.data['helpdesk.autoCloseHours']).toEqual({ value: 72, version: 0 });
    await oapi('patch', '/helpdesk/settings', { changes: [{ key: 'helpdesk.maxReopens', value: 9 }] });
    expect((await admin('get', '/helpdesk/settings')).body.data['helpdesk.maxReopens'].value).toBe(3);
  });
});

describe('plan gate of the settings (7.9)', () => {
  it('Starter cannot change the Me too raise threshold (402) but can change the others', async () => {
    const s = await helpdeskApiWorld('STARTER', ['chairman'], { reset: false });
    const api = await s.api('chairman');
    const bad = await api('patch', '/helpdesk/settings', {
      changes: [{ key: SETTING.upvoteRaiseThreshold, value: 12 }],
    });
    expect([bad.status, bad.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    const ok = await api('patch', '/helpdesk/settings', {
      changes: [{ key: SETTING.autoCloseHours, value: 48 }],
    });
    expect(ok.status).toBe(200);
    expect(
      (
        await admin('patch', '/helpdesk/settings', {
          changes: [{ key: SETTING.upvoteRaiseThreshold, value: 12 }],
        })
      ).status,
    ).toBe(200);
  });
});
