import { afterAll, describe, expect, it } from 'vitest';
import { closeDb } from '../../../src/models';
import { setupSchemas as s } from '../../../src/modules/society-setup/society-setup.validation';
import {
  assertPatternUnique,
  parsePattern,
  renderNumber,
} from '../../../src/modules/society-setup/society-setup.generator.pattern';
import { assertGstin, gstinChecksumOk } from '../../../src/modules/society-setup/society-setup.gstin';
import {
  SETTINGS_REGISTRY,
  SETTING_KEYS,
  SETTING_NAMESPACES,
  settingDef,
} from '../../../src/modules/society-setup/society-setup.settings-registry';
import { crossKeyError } from '../../../src/modules/society-setup/society-setup.settings.service';
import {
  floorLabel,
  floorNodeName,
  newQrToken,
} from '../../../src/modules/society-setup/society-setup.shared';
import { gstinFor } from '../../helpers/society-setup';

afterAll(closeDb);

const labels = { ground: 'G', basementPrefix: 'B' };
const render = (pattern: string, o: { building?: string; floor: number; position: number; seq?: number }) =>
  renderNumber(parsePattern(pattern), { building: 'A', seq: 1, labels, ...o });

describe('generator pattern (BR-08-31)', () => {
  it('T08-01 {floor}{pos:2}, floors 1 to 20, 4 positions: 80 unique numbers 101 to 2004', () => {
    const tokens = parsePattern('{floor}{pos:2}');
    assertPatternUnique(tokens);
    const numbers: string[] = [];
    for (let f = 1; f <= 20; f++)
      for (let p = 1; p <= 4; p++)
        numbers.push(renderNumber(tokens, { building: 'A', floor: f, position: p, seq: 0, labels }));
    expect(numbers).toHaveLength(80);
    expect(new Set(numbers).size).toBe(80);
    expect(numbers[0]).toBe('101');
    expect(numbers[79]).toBe('2004');
  });

  it('T08-02 {building}-{floor:2}{posAlpha}, Tower B floors 1 to 3, 2 positions', () => {
    const out: string[] = [];
    for (let f = 1; f <= 3; f++)
      for (let p = 1; p <= 2; p++)
        out.push(render('{building}-{floor:2}{posAlpha}', { building: 'B', floor: f, position: p }));
    expect(out).toEqual(['B-01A', 'B-01B', 'B-02A', 'B-02B', 'B-03A', 'B-03B']);
  });

  it('T08-03 floor labels with 2 basements and a ground floor', () => {
    expect([-2, -1, 0, 1].map(f => floorLabel(f, labels))).toEqual(['B2', 'B1', 'G', '1']);
    expect(floorLabel(0, { ground: 'GF', basementPrefix: 'LB' })).toBe('GF');
    expect(floorLabel(-3, { ground: 'GF', basementPrefix: 'LB' })).toBe('LB3');
    expect([-1, 0, 7].map(floorNodeName)).toEqual(['Basement 1', 'Ground floor', 'Floor 7']);
  });

  it('T08-04 a pattern with only {pos} is PATTERN_NOT_UNIQUE (422)', () => {
    expect(() => assertPatternUnique(parsePattern('{pos}'))).toThrow(
      expect.objectContaining({ status: 422, code: 'PATTERN_NOT_UNIQUE' }),
    );
    expect(() => assertPatternUnique(parsePattern('{floor}'))).toThrow(
      expect.objectContaining({ code: 'PATTERN_NOT_UNIQUE' }),
    );
    expect(() => assertPatternUnique(parsePattern('{seq}'))).not.toThrow();
    expect(() => assertPatternUnique(parsePattern('{floor}{posAlpha}'))).not.toThrow();
  });

  it('{floor:N} pads upper floors but renders ground and basements as labels', () => {
    expect(render('{floor:3}{pos}', { floor: 5, position: 1 })).toBe('0051');
    expect(render('{floor:2}{pos}', { floor: 0, position: 2 })).toBe('G2');
    expect(render('{floor:2}{pos}', { floor: -1, position: 3 })).toBe('B13');
    expect(render('{floor}{pos:2}', { floor: 13, position: 4 })).toBe('1304');
  });

  it('{seq} counts across the run and pads', () => {
    expect(render('S{seq:3}', { floor: 1, position: 1, seq: 7 })).toBe('S007');
    expect(render('{seq}', { floor: 1, position: 1, seq: 120 })).toBe('120');
  });

  it('rejects unknown tokens, bad characters, bad padding and numbers that are too long, with PATTERN_INVALID (400)', () => {
    const bad = [
      '{flor}{pos}',
      'a{pos}',
      '{floor:5}{pos}',
      '{floor:0}{pos}',
      '{building:2}',
      '{posAlpha:2}',
      '{floor',
      '{floor} {pos}',
      '',
    ];
    for (const p of bad)
      expect(() => parsePattern(p), p).toThrow(
        expect.objectContaining({ status: 400, code: 'PATTERN_INVALID' }),
      );
    expect(() => parsePattern('A'.repeat(41))).toThrow(expect.objectContaining({ code: 'PATTERN_INVALID' }));
    expect(() => render('{building}-{floor:4}-{pos:4}-XXXXXXXXXXXX', { floor: 1, position: 1 })).toThrow(
      expect.objectContaining({ code: 'PATTERN_INVALID' }),
    );
    expect(() => render('{floor}{posAlpha}', { floor: 1, position: 27 })).toThrow(
      expect.objectContaining({ code: 'PATTERN_INVALID' }),
    );
    // a number may not start with a dash
    expect(() => render('-{floor}{pos}', { floor: 1, position: 1 })).toThrow(
      expect.objectContaining({ code: 'PATTERN_INVALID' }),
    );
  });
});

describe('GSTIN (BR-08-2)', () => {
  const pan = 'AAAAG1234C';
  const good = gstinFor('27', pan);
  it('T08-05 a correct GSTIN passes; checksum, state and PAN mismatches are reported in that order', () => {
    expect(gstinChecksumOk(good)).toBe(true);
    expect(() => assertGstin(good, 'Maharashtra', pan)).not.toThrow();
    expect(() => assertGstin(good, 'Maharashtra', null)).not.toThrow();
    // the real GSTIN 27AAPFU0939F1ZV carries the check digit V
    expect(gstinChecksumOk('27AAPFU0939F1ZV')).toBe(true);
    expect(gstinChecksumOk('27AAPFU0939F1ZW')).toBe(false);
    const bad = `${good.slice(0, 14)}${good[14] === '0' ? '1' : '0'}`;
    expect(() => assertGstin(bad, 'Maharashtra', pan)).toThrow(
      expect.objectContaining({ status: 422, code: 'GSTIN_CHECKSUM_INVALID' }),
    );
    const karnataka = gstinFor('29', pan);
    expect(() => assertGstin(karnataka, 'Maharashtra', pan)).toThrow(
      expect.objectContaining({ status: 422, code: 'GSTIN_STATE_MISMATCH' }),
    );
    expect(() => assertGstin(karnataka, 'Karnataka', pan)).not.toThrow();
    expect(() => assertGstin(good, 'Maharashtra', 'AAAAH9999Z')).toThrow(
      expect.objectContaining({ status: 422, code: 'GSTIN_PAN_MISMATCH' }),
    );
    // a state without a GST code (free text) never matches
    expect(() => assertGstin(good, 'Nowhere', pan)).toThrow(
      expect.objectContaining({ code: 'GSTIN_STATE_MISMATCH' }),
    );
  });
});

describe('request schemas', () => {
  const area = (v: string) =>
    s.unitCreate.safeParse({ buildingId: 1, unitNumber: '101', floor: 1, carpetAreaSqft: v });
  it('T08-06 areas 100000.001, 0.999 and 1150.1234 fail; 1150.125 passes', () => {
    for (const v of ['100000.001', '0.999', '1150.1234', '0', '-5', 'abc', '1,150'])
      expect(area(v).success, v).toBe(false);
    for (const v of ['1150.125', '1', '100000', '1150.5', '1150']) expect(area(v).success, v).toBe(true);
  });

  it('unit numbers are trimmed and upper-cased; bad numbers fail', () => {
    const ok = s.unitCreate.parse({ buildingId: 1, unitNumber: ' a-12/b ', floor: 1 });
    expect(ok.unitNumber).toBe('A-12/B');
    for (const v of ['', '-1', 'A B', 'A'.repeat(21), 'a$1'])
      expect(s.unitCreate.safeParse({ buildingId: 1, unitNumber: v, floor: 1 }).success, v).toBe(false);
  });

  it('share must be above 0 and at most 100 with 4 decimals; derived and unknown fields are refused', () => {
    const share = (v: string) =>
      s.unitCreate.safeParse({ buildingId: 1, unitNumber: '1', floor: 1, undividedSharePct: v });
    expect(share('0').success).toBe(false);
    expect(share('100.0001').success).toBe(false);
    expect(share('1.23456').success).toBe(false);
    expect(share('100').success).toBe(true);
    expect(share('1.2500').success).toBe(true);
    for (const k of ['areaSqft', 'label', 'status', 'archivedAt'])
      expect(s.unitCreate.safeParse({ buildingId: 1, unitNumber: '1', floor: 1, [k]: 'x' }).success, k).toBe(
        false,
      );
  });

  it('building codes are upper-cased and limited to 1 to 6 letters or digits', () => {
    expect(
      s.buildingCreate.parse({ code: 'a1', name: 'Tower A', kind: 'TOWER', floorsAboveGround: 5 }).code,
    ).toBe('A1');
    expect(
      s.buildingCreate.safeParse({ code: 'ABCDEFG', name: 'Tower', kind: 'TOWER', floorsAboveGround: 5 })
        .success,
    ).toBe(false);
    expect(
      s.buildingCreate.safeParse({ code: 'A-1', name: 'Tower', kind: 'TOWER', floorsAboveGround: 5 }).success,
    ).toBe(false);
    expect(
      s.buildingCreate.safeParse({ code: 'A', name: 'T', kind: 'TOWER', floorsAboveGround: 5 }).success,
    ).toBe(false);
    expect(
      s.buildingCreate.safeParse({ code: 'A', name: 'Tower', kind: 'TOWER', floorsAboveGround: 201 }).success,
    ).toBe(false);
    expect(
      s.buildingCreate.safeParse({
        code: 'A',
        name: 'Tower',
        kind: 'TOWER',
        floorsAboveGround: 5,
        basements: 6,
      }).success,
    ).toBe(false);
  });

  it('generator limits: 1 to 10 buildings, floors -5 to 200, 1 to 50 positions, 200 skipped cells', () => {
    const base = {
      buildings: [{ buildingId: 1 }],
      floorFrom: 1,
      floorTo: 3,
      positions: [{ position: 1 }],
      pattern: '{floor}{pos}',
    };
    expect(s.generatorPreview.safeParse(base).success).toBe(true);
    expect(s.generatorPreview.safeParse({ ...base, buildings: [] }).success).toBe(false);
    expect(
      s.generatorPreview.safeParse({
        ...base,
        buildings: Array.from({ length: 11 }, (_, i) => ({ buildingId: i + 1 })),
      }).success,
    ).toBe(false);
    expect(s.generatorPreview.safeParse({ ...base, floorFrom: -6 }).success).toBe(false);
    expect(s.generatorPreview.safeParse({ ...base, floorTo: 0 }).success).toBe(false);
    expect(s.generatorPreview.safeParse({ ...base, floorTo: 201 }).success).toBe(false);
    expect(s.generatorPreview.safeParse({ ...base, positions: [] }).success).toBe(false);
    expect(s.generatorPreview.safeParse({ ...base, pattern: 'A'.repeat(41) }).success).toBe(false);
    expect(
      s.generatorPreview.safeParse({
        ...base,
        skipCells: Array.from({ length: 201 }, () => ({ floor: 1, position: 1 })),
      }).success,
    ).toBe(false);
    expect(s.generatorCommit.safeParse({ ...base, previewHash: 'abc' }).success).toBe(false);
    expect(s.generatorCommit.safeParse({ ...base, previewHash: 'a'.repeat(64) }).success).toBe(true);
  });

  it('settings changes: 1 to 30 items with unique keys and a version of 0 or more', () => {
    const one = { key: 'billing.dueDays', value: 9, version: 0 };
    expect(s.settingsPatch.safeParse({ changes: [one] }).success).toBe(true);
    expect(s.settingsPatch.safeParse({ changes: [] }).success).toBe(false);
    expect(s.settingsPatch.safeParse({ changes: [one, one] }).success).toBe(false);
    expect(s.settingsPatch.safeParse({ changes: [{ key: 'a.b', version: 0 }] }).success).toBe(false);
    expect(s.settingsPatch.safeParse({ changes: [{ ...one, version: -1 }] }).success).toBe(false);
    expect(s.settingsPatch.safeParse({ changes: [one], reason: 'abc' }).success).toBe(false);
    expect(
      s.settingsPatch.safeParse({
        changes: Array.from({ length: 31 }, (_, i) => ({ key: `k.k${i}`, value: 1, version: 0 })),
      }).success,
    ).toBe(false);
  });
});

describe('settings registry (section 7.3, BR-08-7)', () => {
  it('declares 17 namespaces, unique keys of the form namespace.name, and defaults that pass their own schema', () => {
    expect(SETTING_NAMESPACES).toHaveLength(17);
    expect(new Set(SETTING_KEYS).size).toBe(SETTING_KEYS.length);
    expect(SETTING_KEYS.length).toBe(185);
    for (const k of SETTING_KEYS) {
      expect(k, k).toMatch(/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/);
      const d = SETTINGS_REGISTRY[k]!;
      expect(SETTING_NAMESPACES, k).toContain(d.namespace);
      expect(d.schema.safeParse(d.default).success, k).toBe(true);
    }
  });

  it('keeps the defaults of the spec for the keys other modules depend on', () => {
    const dv = (k: string) => settingDef(k).default;
    expect(dv('billing.billingDay')).toBe(1);
    expect(dv('billing.dueDays')).toBe(15);
    expect(dv('billing.lateFeeDefaultRatePct')).toBe('18.0000');
    expect(dv('billing.invoicePrefix')).toBe('INV');
    expect(dv('billing.receiptPrefix')).toBe('RCT');
    expect(dv('billing.gstExemptLimitPerUnitPaise')).toBe(750000);
    expect(dv('approvals.stepUpAbovePaise')).toBe(2500000);
    expect(dv('security.adminIdleMinutes')).toBe(30);
    expect(dv('security.stepUpMinutes')).toBe(5);
    expect(dv('office.weeklyOffDays')).toEqual([0]);
    expect(dv('office.openTime')).toBe('09:00');
    expect(dv('communication.quietHoursStart')).toBe('22:00');
    expect(dv('visitors.overstayMinutes')).toEqual({
      GUEST: 720,
      DELIVERY: 20,
      CAB: 15,
      SERVICE: 480,
      OTHER: 240,
    });
    expect(dv('staff.shiftTemplates')).toHaveLength(4);
    expect(dv('committee.handoverTemplate')).toHaveLength(10);
    expect(dv('committee.reminderDays')).toEqual([90, 30, 7]);
    expect(dv('payments.convenienceFeeMethods')).toEqual(['CARD', 'NETBANKING', 'WALLET']);
    expect(dv('profile.societyType')).toBe('COOPERATIVE_HOUSING_SOCIETY');
    expect(dv('profile.pan')).toBeNull();
    expect(dv('residents.renovationBlackoutWeekdays')).toEqual([0]);
    expect(dv('residents.moveHours')).toEqual({ start: '09:00', end: '18:00' });
    expect(dv('visitors.patrolPlans')).toEqual([]);
  });

  it('carries the flags and permissions of section 2', () => {
    const d = (k: string) => settingDef(k);
    for (const k of ['security.adminIdleMinutes', 'security.stepUpMinutes'])
      expect([d(k).requiresStepUp, d(k).requiresReason]).toEqual([true, true]);
    expect([
      d('finance.showFinancesToResidents').requiresStepUp,
      d('finance.showFinancesToResidents').requiresReason,
    ]).toEqual([true, true]);
    expect([d('finance.maxUnlockHours').requiresStepUp, d('finance.maxUnlockHours').requiresReason]).toEqual([
      true,
      false,
    ]);
    expect([d('billing.areaBasis').requiresStepUp, d('billing.areaBasis').requiresReason]).toEqual([
      false,
      true,
    ]);
    expect(d('billing.dueDays').editPermission).toBe('settings.billing_rules.edit');
    expect(d('billing.dueDays').viewPermission).toBe('settings.billing_rules.view');
    expect(d('finance.billRequiredAbovePaise').editPermission).toBe('finance.accounts.edit');
    expect(d('payments.orderExpiryMinutes').editPermission).toBe('finance.payments.edit');
    expect(d('approvals.stepUpAbovePaise').editPermission).toBe('settings.approval_rules.edit');
    expect(d('committee.minStrength').editPermission).toBe('settings.members.edit');
    expect(d('vendors.minQuotations').editPermission).toBe('vendors.vendors.edit');
    expect(d('vendors.readingPhotoRequired').editPermission).toBe('vendors.assets.edit');
    expect(d('vendors.highConsumptionFactor').viewPermission).toBe('vendors.assets.view');
    expect(d('office.openTime').editPermission).toBe('settings.society.edit');
    expect(d('profile.pan').editVia).toBe('PROFILE');
    expect(d('visitors.patrolPlans').editVia).toBe('MODULE17');
    expect(d('billing.dueDays').editVia).toBe('SETTINGS');
  });

  it('validates values the way the spec says', () => {
    const ok = (k: string, v: unknown) => settingDef(k).schema.safeParse(v).success;
    expect(ok('security.adminIdleMinutes', 20)).toBe(false);
    expect([5, 15, 30, 60].every(v => ok('security.adminIdleMinutes', v))).toBe(true);
    expect(ok('security.stepUpMinutes', 10)).toBe(true);
    expect(ok('security.stepUpMinutes', 7)).toBe(false);
    expect(ok('approvals.stepUpAbovePaise', 99999)).toBe(false);
    expect(ok('approvals.stepUpAbovePaise', 5_000_000)).toBe(true);
    expect(ok('committee.minStrength', 30)).toBe(false);
    expect(ok('billing.billingDay', 29)).toBe(false);
    expect(ok('billing.lateFeeDefaultRatePct', '21.0000')).toBe(true);
    expect(ok('billing.lateFeeDefaultRatePct', '21.0001')).toBe(false);
    expect(ok('billing.lateFeeDefaultRatePct', '18')).toBe(false);
    expect(ok('billing.invoicePrefix', 'inv')).toBe(false);
    expect(ok('billing.invoicePrefix', 'A')).toBe(false);
    expect(ok('billing.invoicePrefix', 'FY27INV')).toBe(true);
    expect(ok('structure.groundFloorLabel', 'GF')).toBe(true);
    expect(ok('structure.groundFloorLabel', 'g')).toBe(false);
    expect(ok('office.weeklyOffDays', [0, 6])).toBe(true);
    expect(ok('office.weeklyOffDays', [6, 0])).toBe(false);
    expect(ok('office.weeklyOffDays', [0, 1, 2])).toBe(false);
    expect(ok('office.weeklyOffDays', [])).toBe(true);
    expect(ok('office.openTime', '24:00')).toBe(false);
    expect(ok('office.openTime', '9:00')).toBe(false);
    expect(ok('communication.defaultLanguage', 'fr')).toBe(false);
    expect(ok('payments.convenienceFeeMethods', ['UPI', 'UPI'])).toBe(false);
    expect(ok('payments.convenienceFeeMethods', [])).toBe(false);
    expect(ok('committee.reminderDays', [90, 30, 7, 1])).toBe(false);
    expect(ok('staff.verificationReminderDays', [7, 30])).toBe(false);
    expect(ok('staff.verificationReminderDays', [30, 7, 0])).toBe(true);
    expect(ok('staff.shiftTemplates', [{ name: 'A1', start: '06:00', end: '06:00' }])).toBe(false);
    expect(ok('staff.shiftTemplates', [])).toBe(false);
    expect(ok('visitors.overstayMinutes', { GUEST: 720 })).toBe(false);
    expect(
      ok('visitors.overstayMinutes', { GUEST: 4, DELIVERY: 20, CAB: 15, SERVICE: 480, OTHER: 240 }),
    ).toBe(false);
    expect(ok('visitors.accessCardDepositPaise', 0)).toBe(true);
    expect(ok('visitors.accessCardDepositPaise', 50)).toBe(false);
    expect(ok('residents.moveHours', { start: '18:00', end: '09:00' })).toBe(false);
    expect(ok('vendors.contractReminderDays', '60,30,7')).toBe(true);
    expect(ok('vendors.contractReminderDays', '60,30,7,1')).toBe(false);
    expect(ok('vendors.highConsumptionFactor', '1.0000')).toBe(false);
    expect(ok('profile.pan', 'AAAAG1234C')).toBe(true);
    expect(ok('profile.pan', null)).toBe(true);
    expect(ok('profile.pan', 'aaaag1234c')).toBe(false);
    expect(ok('profile.tan', 'PUNE12345A')).toBe(true);
    expect(ok('profile.contactPhone', '9820011111')).toBe(true);
    expect(ok('profile.contactPhone', '02025551234')).toBe(true);
    expect(ok('profile.contactPhone', '1234567890')).toBe(false);
    expect(ok('profile.registrationDate', '2999-01-01')).toBe(false);
    expect(ok('profile.registrationDate', '2009-06-15')).toBe(true);
    expect(settingDef('profile.contactEmail').schema.parse('Office@SkyHeights.IN')).toBe(
      'office@skyheights.in',
    );
    expect(ok('profile.contactEmail', 'not-an-email')).toBe(false);
  });
});

describe('cross-key rules (BR-08-10)', () => {
  const from = (o: Record<string, unknown>) => (k: string) => (k in o ? o[k] : settingDef(k).default);
  const rule = (o: Record<string, unknown>, gstin: string | null = null) =>
    crossKeyError(from(o), new Set(Object.keys(o)), gstin)?.code ?? null;
  it('detects each broken rule and passes the defaults', () => {
    expect(rule({ 'billing.invoicePrefix': 'RCT' })).toBe('PREFIX_CLASH');
    expect(rule({ 'billing.receiptPrefix': 'INV' })).toBe('PREFIX_CLASH');
    expect(rule({ 'billing.invoicePrefix': 'FEE' })).toBeNull();
    expect(rule({ 'office.openTime': '18:00' })).toBe('OFFICE_HOURS_INVALID');
    expect(rule({ 'office.closeTime': '08:00' })).toBe('OFFICE_HOURS_INVALID');
    expect(rule({ 'office.openTime': '08:00', 'office.closeTime': '20:30' })).toBeNull();
    expect(rule({ 'communication.quietHoursEnd': '22:00' })).toBe('QUIET_HOURS_INVALID');
    expect(rule({ 'billing.applyGst': true })).toBe('GST_REQUIRES_GSTIN');
    expect(rule({ 'billing.applyGst': true }, '27AAAAG1234C1ZE')).toBeNull();
    expect(rule({ 'billing.lateFeeDefaultRatePct': '0.0000' })).toBe('LATE_FEE_DEFAULT_INVALID');
    expect(rule({ 'billing.lateFeeDefaultMode': 'FLAT' })).toBe('LATE_FEE_DEFAULT_INVALID');
    expect(
      rule({ 'billing.lateFeeDefaultMode': 'FLAT', 'billing.lateFeeDefaultFlatPaise': 5000 }),
    ).toBeNull();
    expect(
      rule({ 'billing.lateFeeDefaultMode': 'NONE', 'billing.lateFeeDefaultRatePct': '0.0000' }),
    ).toBeNull();
    expect(rule({ 'committee.minStrength': 10, 'committee.maxStrength': 8 })).toBe(
      'COMMITTEE_STRENGTH_INVALID',
    );
    expect(rule({ 'committee.minStrength': 10 })).toBeNull();
    expect(rule({ 'helpdesk.waitingAutoResolveDays': 2, 'helpdesk.waitingReminderHours': 48 })).toBe(
      'HELPDESK_WAITING_RULE_INVALID',
    );
    expect(rule({ 'helpdesk.waitingAutoResolveDays': 3, 'helpdesk.waitingReminderHours': 48 })).toBeNull();
    expect(crossKeyError(from({}), new Set(), null)).toBeNull();
  });
});

describe('QR tokens (BR-08-41)', () => {
  it('are 12 base62 characters and random', () => {
    const t = Array.from({ length: 50 }, newQrToken);
    for (const x of t) expect(x).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(new Set(t).size).toBe(50);
  });
});
