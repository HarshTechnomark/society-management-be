import { describe, expect, it } from 'vitest';
import {
  dueTimes,
  reprioritise,
  restartResolution,
  scan,
  settleWaiting,
  type SlaTicket,
} from '../../../src/modules/platform-ops/platform-ops.sla';
import {
  SETTINGS_REGISTRY,
  crossKeyError,
  settingDef,
} from '../../../src/modules/platform-ops/platform-ops.settings-registry';
import { parseTicketNo, ticketNo } from '../../../src/modules/platform-ops/platform-ops.types';
import { ipAllowed } from '../../../src/modules/platform-ops/platform-ops.ip-allowlist';

const SLA = SETTINGS_REGISTRY['support.slaHours'].default;
const d = (s: string) => new Date(s);

describe('SLA maths (BR-07-4 to BR-07-8)', () => {
  it('BR-07-4 due times use calendar hours by priority', () => {
    const t = dueTimes(d('2026-10-30T04:00:00Z'), 'HIGH', SLA);
    expect(t.firstResponseDueAt.toISOString()).toBe('2026-10-30T06:00:00.000Z');
    expect(t.resolutionDueAt.toISOString()).toBe('2026-10-31T04:00:00.000Z');
    expect(dueTimes(d('2026-10-30T04:00:00Z'), 'LOW', SLA).resolutionDueAt.toISOString()).toBe(
      '2026-11-04T04:00:00.000Z',
    );
  });

  it('T07-08 WAITING 12:00 to 15:30 pauses 210 whole minutes', () => {
    const r = settleWaiting(
      {
        waitingSince: d('2026-10-30T12:00:00Z'),
        pausedMinutes: 10,
        resolutionDueAt: d('2026-11-02T04:00:00Z'),
      },
      d('2026-10-30T15:30:59Z'),
    );
    expect(r.pausedMinutes).toBe(220);
    expect(r.resolutionDueAt.toISOString()).toBe('2026-11-02T07:30:00.000Z');
    expect(r.waitingSince).toBeNull();
    const none = settleWaiting(
      { waitingSince: null, pausedMinutes: 5, resolutionDueAt: d('2026-11-02T04:00:00Z') },
      d('2026-10-30T15:30:00Z'),
    );
    expect(none.pausedMinutes).toBe(5);
  });

  const base: SlaTicket = {
    createdAt: d('2026-10-30T04:00:00Z'),
    priority: 'MEDIUM',
    status: 'OPEN',
    firstResponseDueAt: d('2026-10-30T12:00:00Z'),
    resolutionDueAt: d('2026-11-02T04:00:00Z'),
    firstRespondedAt: null,
    firstResponseBreachedAt: null,
    resolutionWarnedAt: null,
    resolutionBreachedAt: null,
    waitingSince: null,
    pausedMinutes: 0,
  };

  it('BR-07-8 first response breach: only without a first response, only OPEN or IN_PROGRESS, once', () => {
    expect(scan(base, d('2026-10-30T11:59:00Z')).firstResponseBreach).toBe(false);
    expect(scan(base, d('2026-10-30T12:01:00Z')).firstResponseBreach).toBe(true);
    expect(
      scan({ ...base, firstRespondedAt: d('2026-10-30T05:00:00Z') }, d('2026-10-31T00:00:00Z'))
        .firstResponseBreach,
    ).toBe(false);
    expect(
      scan({ ...base, firstResponseBreachedAt: d('2026-10-30T12:05:00Z') }, d('2026-10-31T00:00:00Z'))
        .firstResponseBreach,
    ).toBe(false);
    expect(scan({ ...base, status: 'WAITING' }, d('2026-10-31T00:00:00Z')).firstResponseBreach).toBe(false);
  });

  it('BR-07-8 warning at 80% of the window (paused minutes are inside resolutionDueAt), breach after the due time', () => {
    // window = 72 h, 80% = 57.6 h = 2 days 9 h 36 min
    expect(scan(base, d('2026-11-01T13:35:00Z')).warn).toBe(false);
    expect(scan(base, d('2026-11-01T13:37:00Z')).warn).toBe(true);
    expect(scan(base, d('2026-11-02T03:59:00Z')).resolutionBreach).toBe(false);
    expect(scan(base, d('2026-11-02T04:01:00Z')).resolutionBreach).toBe(true);
    const paused = { ...base, pausedMinutes: 600, resolutionDueAt: d('2026-11-02T14:00:00Z') };
    expect(scan(paused, d('2026-11-02T04:01:00Z')).resolutionBreach).toBe(false);
    expect(scan({ ...base, status: 'WAITING' }, d('2026-12-01T00:00:00Z'))).toEqual({
      firstResponseBreach: false,
      warn: false,
      resolutionBreach: false,
    });
    expect(scan({ ...base, status: 'RESOLVED' }, d('2026-12-01T00:00:00Z')).resolutionBreach).toBe(false);
  });

  it('BR-07-7 priority change recomputes with paused minutes and clears stamps whose due time is in the future', () => {
    const r = reprioritise(
      {
        ...base,
        pausedMinutes: 120,
        firstResponseBreachedAt: d('2026-10-30T12:05:00Z'),
        resolutionWarnedAt: d('2026-11-01T14:00:00Z'),
        resolutionBreachedAt: d('2026-11-02T04:05:00Z'),
      },
      'LOW',
      SLA,
      d('2026-10-31T03:00:00Z'),
    );
    expect(r.resolutionDueAt.toISOString()).toBe('2026-11-04T06:00:00.000Z');
    expect(r.firstResponseDueAt.toISOString()).toBe('2026-10-31T04:00:00.000Z');
    expect(r.firstResponseBreachedAt).toBeNull();
    expect(r.resolutionWarnedAt).toBeNull();
    expect(r.resolutionBreachedAt).toBeNull();
    const past = reprioritise(
      {
        ...base,
        resolutionBreachedAt: d('2026-11-02T04:05:00Z'),
        firstRespondedAt: d('2026-10-30T05:00:00Z'),
      },
      'HIGH',
      SLA,
      d('2026-11-02T05:00:00Z'),
    );
    expect(past.resolutionDueAt.toISOString()).toBe('2026-10-31T04:00:00.000Z');
    expect(past.resolutionBreachedAt).not.toBeNull();
    expect(past.firstResponseDueAt).toEqual(base.firstResponseDueAt); // already responded: first response due untouched
  });

  it('BR-07-11 reopen restarts the resolution clock', () => {
    const r = restartResolution(d('2026-11-03T10:00:00Z'), 'HIGH', SLA);
    expect(r.resolutionDueAt.toISOString()).toBe('2026-11-04T10:00:00.000Z');
    expect(r.resolutionWarnedAt).toBeNull();
    expect(r.resolutionBreachedAt).toBeNull();
  });
});

describe('ticket numbers and the settings registry', () => {
  it('BR-07-2 numbers are TKT- plus six digits and parse back', () => {
    expect(ticketNo(2041)).toBe('TKT-002041');
    expect(parseTicketNo('tkt-002041')).toBe(2041);
    expect(parseTicketNo('TKT-1')).toBe(1);
    expect(parseTicketNo('TKT-1234567')).toBeNull();
    expect(parseTicketNo('hello')).toBeNull();
  });

  it('every key has a default that passes its own schema, and the cross-key rules hold for the defaults', () => {
    for (const [key, def] of Object.entries(SETTINGS_REGISTRY))
      expect(def.schema.safeParse(def.default).success, key).toBe(true);
    expect(Object.keys(SETTINGS_REGISTRY)).toHaveLength(40);
    expect(crossKeyError(k => settingDef(k).default)).toBeNull();
    expect(settingDef('audit.archiveManifest').readOnly).toBe(true);
  });

  it('validation rules of section 7.1', () => {
    const ok = (k: keyof typeof SETTINGS_REGISTRY, v: unknown) => settingDef(k).schema.safeParse(v).success;
    expect(ok('security.idleMinutes', 15)).toBe(true);
    expect(ok('security.idleMinutes', 20)).toBe(false);
    expect(ok('security.stepUpMinutes', 10)).toBe(true);
    expect(ok('security.stepUpMinutes', 15)).toBe(false);
    expect(ok('billing.gstRatePct', '18.0000')).toBe(true);
    expect(ok('billing.gstRatePct', '29.0000')).toBe(false);
    expect(ok('billing.gstRatePct', 18)).toBe(false);
    expect(ok('billing.reminderOffsetsDays', [-7, 0, 3])).toBe(true);
    expect(ok('billing.reminderOffsetsDays', [3, 0])).toBe(false);
    expect(ok('billing.reminderOffsetsDays', [-16])).toBe(false);
    expect(ok('lifecycle.autoCloseSuspendedDays', 0)).toBe(true);
    expect(ok('lifecycle.autoCloseSuspendedDays', 10)).toBe(false);
    expect(ok('company.stateCode', '99')).toBe(false);
    expect(ok('company.gstin', '27ABCDE1234F1Z5')).toBe(true);
    expect(ok('company.gstin', 'bad')).toBe(false);
    expect(ok('security.ipAllowlist', ['10.0.0.0/8', '2001:db8::/32'])).toBe(true);
    expect(ok('security.ipAllowlist', ['10.0.0.0/8', '10.0.0.0/8'])).toBe(false);
    expect(ok('security.ipAllowlist', ['not-a-cidr'])).toBe(false);
    expect(ok('support.slaHours', { ...SLA, HIGH: { firstResponse: 30, resolution: 24 } })).toBe(false);
    expect(ok('support.slaHours', { HIGH: SLA.HIGH })).toBe(false);
    expect(ok('support.autoCloseDays', 2)).toBe(false);
    expect(ok('audit.archiveAfterMonths', 23)).toBe(false);
  });

  it('cross-key rules return the spec error codes', () => {
    const merged = (o: Record<string, unknown>) => (k: keyof typeof SETTINGS_REGISTRY) =>
      k in o ? o[k] : settingDef(k).default;
    expect(crossKeyError(merged({ 'company.stateCode': '29' }))?.code).toBe('GSTIN_STATE_MISMATCH');
    expect(crossKeyError(merged({ 'company.pan': 'ZZZZZ9999Z' }))?.code).toBe('GSTIN_STATE_MISMATCH');
    expect(crossKeyError(merged({ 'billing.suspendAfterDays': 1 }))?.code).toBe('SUSPEND_NOT_AFTER_PAST_DUE');
    expect(
      crossKeyError(merged({ 'billing.netTermsDays': 7, 'billing.reminderOffsetsDays': [-10, 0] }))?.code,
    ).toBe('REMINDER_BEFORE_ISSUE');
  });

  it('BR-07-43 CIDR matching, including IPv4-mapped IPv6', () => {
    expect(ipAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('203.0.113.24', ['10.0.0.0/8'])).toBe(false);
    expect(ipAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(ipAllowed('2001:db9::1', ['2001:db8::/32'])).toBe(false);
    expect(ipAllowed('garbage', ['10.0.0.0/8'])).toBe(false);
  });
});
