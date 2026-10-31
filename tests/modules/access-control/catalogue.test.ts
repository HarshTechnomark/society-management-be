import { describe, expect, it } from 'vitest';
import {
  ALL_DEFS,
  CATALOGUE,
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_SOCIETY_ROLES,
  DEF_BY_KEY,
  KEY_PATTERN,
  PLATFORM_ROLE_PERMISSIONS,
  HOUSEHOLD_ALLOW_KEYS,
  HOUSEHOLD_DENY_KEYS,
  isPrivilegedKey,
  keysOfScope,
} from '../../../src/modules/access-control/access-control.permissions';

describe('T03-01 catalogue expansion', () => {
  it('has the counts of section 7.7 and every key matches BR-03-1', () => {
    const count = (s: string) => ALL_DEFS.filter(d => d.scope === s).length;
    expect(count('platform')).toBe(39);
    expect(count('society')).toBe(211);
    expect(count('resident')).toBe(29);
    expect(count('gate')).toBe(15);
    expect(count('work')).toBe(6);
    expect(ALL_DEFS).toHaveLength(300);
    for (const d of ALL_DEFS) expect(d.key, d.key).toMatch(KEY_PATTERN);
    expect(new Set(ALL_DEFS.map(d => d.key)).size).toBe(300);
    expect(Object.keys(CATALOGUE)).toHaveLength(5);
  });
  it('builds labels like "Approve expenses and cash book"', () => {
    expect(DEF_BY_KEY.get('finance.expenses.approve')!.label).toBe('Approve expenses and cash book');
    expect(DEF_BY_KEY.get('finance.expenses.approve')!.moduleNo).toBe(13);
  });
});

describe('T03-02 default role matrix', () => {
  it('every key exists and has the scope of the role', () => {
    const scopeOf = new Map(DEFAULT_SOCIETY_ROLES.map(r => [r.key, r.scope]));
    for (const [role, keys] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      expect(scopeOf.has(role), role).toBe(true);
      for (const k of keys) {
        expect(DEF_BY_KEY.get(k)?.scope, `${role} ${k}`).toBe(scopeOf.get(role));
      }
    }
    for (const r of DEFAULT_SOCIETY_ROLES)
      expect(DEFAULT_ROLE_PERMISSIONS[r.key]?.length, r.key).toBeGreaterThan(0);
  });
  it('chairman holds every society key and guard every gate key', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.chairman).toEqual(keysOfScope('society').sort());
    expect(DEFAULT_ROLE_PERMISSIONS.guard).toEqual(keysOfScope('gate').sort());
    expect(DEFAULT_ROLE_PERMISSIONS.owner).toEqual(
      expect.arrayContaining(['resident.payments.create', 'resident.visitors.approve']),
    );
  });
  it('BR-03-35: chairman, secretary and treasurer hold approve on billing, payments, expenses and accounts', () => {
    for (const role of ['chairman', 'secretary', 'treasurer'])
      for (const sub of ['billing', 'payments', 'expenses', 'accounts'])
        expect(DEFAULT_ROLE_PERMISSIONS[role], `${role} ${sub}`).toContain(`finance.${sub}.approve`);
  });
  it('seat and MFA flags follow section 7.8', () => {
    const seat = DEFAULT_SOCIETY_ROLES.filter(r => r.consumesSeat).map(r => r.key);
    expect(seat.sort()).toEqual(
      ['accountant', 'auditor', 'facility_manager', 'security_supervisor', 'society_admin'].sort(),
    );
    const mfa = DEFAULT_SOCIETY_ROLES.filter(r => r.requiresMfa).map(r => r.key);
    expect(mfa.sort()).toEqual(['accountant', 'chairman', 'secretary', 'society_admin', 'treasurer']);
    expect(DEFAULT_SOCIETY_ROLES).toHaveLength(15);
  });
  it('platform roles: super admin 39 keys, support 17 keys', () => {
    expect(PLATFORM_ROLE_PERMISSIONS.super_admin).toHaveLength(39);
    expect(PLATFORM_ROLE_PERMISSIONS.platform_support).toHaveLength(17);
  });
  it('household lists are real resident keys', () => {
    for (const k of [...HOUSEHOLD_ALLOW_KEYS, ...HOUSEHOLD_DENY_KEYS])
      expect(DEF_BY_KEY.get(k)?.scope).toBe('resident');
  });
});

describe('T03-05 isPrivileged', () => {
  const p = (k: string) => DEF_BY_KEY.get(k)!.isPrivileged;
  it('matches section 5.1', () => {
    expect(p('platform.dashboard.view')).toBe(true);
    expect(p('finance.expenses.view')).toBe(false);
    expect(p('finance.expenses.create')).toBe(true);
    expect(p('residents.units.import')).toBe(true);
    expect(p('residents.units.export')).toBe(true);
    expect(p('settings.roles.view')).toBe(false);
    expect(p('settings.roles.edit')).toBe(true);
    expect(p('settings.members.export')).toBe(true);
    expect(p('residents.contacts.view')).toBe(true);
    expect(p('communication.notices.create')).toBe(false);
    expect(p('resident.payments.create')).toBe(false);
    expect(p('gate.visitors.create')).toBe(false);
    expect(isPrivilegedKey('settings.integrations.approve', 'society')).toBe(false);
    expect(isPrivilegedKey('settings.integrations.edit', 'society')).toBe(true);
  });
});
