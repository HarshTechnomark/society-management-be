import { describe, expect, it } from 'vitest';
import { SOCIETY_STATUSES } from '../../../src/models/society.model';
import {
  ALLOWED,
  financialRetainUntilFor,
  isAllowed,
} from '../../../src/modules/societies/societies.lifecycle';
import { billingStanding, healthBand, healthScore } from '../../../src/modules/societies/societies.health';
import {
  isReservedSlug,
  isValidSlug,
  normaliseName,
  slugCandidates,
  slugify,
  withSuffix,
} from '../../../src/modules/societies/societies.slug';
import {
  derivedSupportPermissions,
  isJobAllowed,
  societyStateGuard,
  supportRequestGuard,
} from '../../../src/modules/societies/societies.guard';
import { readZip, ZipBuilder } from '../../../src/modules/societies/societies.zip';
import { toCsv, withRupees } from '../../../src/modules/societies/societies.exports';

describe('T05-01 transition table (6.1)', () => {
  const allowed = new Set([
    'TRIAL>ACTIVE',
    'TRIAL>SUSPENDED',
    'TRIAL>CLOSED',
    'ACTIVE>PAST_DUE',
    'ACTIVE>SUSPENDED',
    'ACTIVE>CLOSED',
    'PAST_DUE>ACTIVE',
    'PAST_DUE>SUSPENDED',
    'PAST_DUE>CLOSED',
    'SUSPENDED>ACTIVE',
    'SUSPENDED>PAST_DUE',
    'SUSPENDED>TRIAL',
    'SUSPENDED>CLOSED',
    'CLOSED>ACTIVE',
  ]);
  it('allows exactly the pairs of section 6.1', () => {
    for (const from of SOCIETY_STATUSES)
      for (const to of SOCIETY_STATUSES)
        expect(isAllowed(from, to), `${from} > ${to}`).toBe(allowed.has(`${from}>${to}`));
    expect(Object.values(ALLOWED).flat()).toHaveLength(allowed.size);
    expect(isAllowed('CLOSED', 'SUSPENDED')).toBe(false);
    expect(isAllowed('TRIAL', 'PAST_DUE')).toBe(false);
  });
});

describe('T05-02 health score (6.5)', () => {
  it('worked examples: 78, and 76 with collections missing', () => {
    const b = { adoption: 0.6, onboarding: 1, collections: 0.85, adminActivity: 0.5, billing: 1 };
    expect(healthScore(b)).toBe(78);
    expect(healthScore({ ...b, collections: null })).toBe(76);
    expect(
      healthScore({
        adoption: null,
        onboarding: null,
        collections: null,
        adminActivity: null,
        billing: null,
      }),
    ).toBe(0);
  });
  it('bands and billing standing', () => {
    expect([healthBand(75), healthBand(74), healthBand(55), healthBand(54)]).toEqual([
      'HEALTHY',
      'WATCH',
      'WATCH',
      'AT_RISK',
    ]);
    expect(billingStanding('ACTIVE', false)).toBe(1);
    expect(billingStanding('TRIAL', false)).toBe(0.7);
    expect(billingStanding('PAST_DUE', true)).toBe(0.3);
    expect(billingStanding('SUSPENDED', false)).toBe(0);
  });
});

describe('T05-03 / T05-04 slug and name rules (BR-05-6, BR-05-7)', () => {
  it('generates slugs and refuses reserved words', () => {
    expect(slugify('Lotus Residency CHS (Phase-2)')).toBe('lotus-residency-chs-phase-2');
    expect(isReservedSlug('admin')).toBe(true);
    expect(isValidSlug('ab')).toBe(false);
    expect(isValidSlug('a--b')).toBe(false);
    expect(slugify('x'.repeat(80))).toHaveLength(60);
    expect(withSuffix('a'.repeat(60), 12)).toHaveLength(60);
    expect(slugCandidates('lotus-residency', 'Pune').slice(0, 2)).toEqual([
      'lotus-residency-pune',
      'lotus-residency-2',
    ]);
  });
  it('normalises society names', () => {
    expect(normaliseName('Green Park Co-op. Hsg. Society Ltd')).toBe(normaliseName('GREEN PARK CHS'));
    expect(normaliseName('Green Park Co-operative Housing Society Limited')).toBe('greenpark');
    expect(normaliseName('Lake View CHS')).not.toBe(normaliseName('Green Park CHS'));
  });
});

describe('T05-05 permissions under a grant (6.4)', () => {
  it('READ_ONLY is view only; READ_WRITE adds create and edit; never approve or the deny list', () => {
    const ro = derivedSupportPermissions('READ_ONLY');
    const rw = derivedSupportPermissions('READ_WRITE');
    expect(ro.length).toBeGreaterThan(20);
    expect(ro.every(k => k.endsWith('.view'))).toBe(true);
    for (const k of [...ro, ...rw]) {
      expect(k).not.toMatch(/\.(approve|delete|import|export)$/);
      expect(k).not.toMatch(/^(resident|gate|work)\./);
      expect(k).not.toMatch(/^settings\.(roles|members|support_access|data_export)\./);
    }
    expect(rw).not.toContain('residents.contacts.view');
    expect(rw).not.toContain('communication.emergency.create');
    expect(rw).not.toContain('settings.subscription.edit');
    expect(rw).toContain('helpdesk.tickets.edit');
    expect(rw.filter(k => k.endsWith('.view'))).toEqual(ro);
  });
  it('route checks: read-only scope and noSupportAccess', () => {
    expect(supportRequestGuard({ scope: 'READ_ONLY', method: 'PATCH' })?.code).toBe(
      'SUPPORT_SCOPE_READ_ONLY',
    );
    expect(supportRequestGuard({ scope: 'READ_ONLY', method: 'GET' })).toBeNull();
    expect(
      supportRequestGuard({ scope: 'READ_WRITE', method: 'GET', policy: { noSupportAccess: true } })?.code,
    ).toBe('SUPPORT_ROUTE_FORBIDDEN');
  });
});

describe('state guard and job policy (BR-05-11, BR-05-14)', () => {
  it('default policy blocks writes while SUSPENDED and everything while CLOSED', () => {
    expect(societyStateGuard({ status: 'SUSPENDED', method: 'POST' })?.code).toBe('SOCIETY_SUSPENDED');
    expect(societyStateGuard({ status: 'SUSPENDED', method: 'GET' })).toBeNull();
    expect(
      societyStateGuard({ status: 'SUSPENDED', method: 'POST', policy: { suspended: 'allow' } }),
    ).toBeNull();
    expect(societyStateGuard({ status: 'CLOSED', method: 'GET' })?.status).toBe(423);
    expect(societyStateGuard({ status: 'CLOSED', method: 'GET', policy: { closed: 'allow' } })).toBeNull();
    expect(societyStateGuard({ status: 'PAST_DUE', method: 'DELETE' })).toBeNull();
  });
  it('isJobAllowed', () => {
    expect(isJobAllowed('ACTIVE', 'normal')).toBe(true);
    expect(isJobAllowed('SUSPENDED', 'normal')).toBe(false);
    expect(isJobAllowed('SUSPENDED', 'safety')).toBe(true);
    expect(isJobAllowed('CLOSED', 'safety')).toBe(false);
    expect(isJobAllowed('CLOSED', 'export')).toBe(true);
  });
});

describe('BR-05-38 financial retention date', () => {
  it('31 March of FY start year + 9 (IST)', () => {
    expect(financialRetainUntilFor(new Date('2026-10-30T06:00:00Z'))).toBe('2035-03-31');
    expect(financialRetainUntilFor(new Date('2027-03-31T18:29:00Z'))).toBe('2035-03-31');
    expect(financialRetainUntilFor(new Date('2027-03-31T18:30:00Z'))).toBe('2036-03-31');
  });
});

describe('export archive format (6.6)', () => {
  it('CSV has a BOM, RFC 4180 quoting and a Rupees column next to Paise', () => {
    const row = withRupees({ id: 1, name: 'A "quoted", name', amountPaise: 1030000 });
    expect(row).toEqual({ id: 1, name: 'A "quoted", name', amountPaise: 1030000, amountRupees: '10300.00' });
    const { csv } = toCsv([row]);
    const text = csv.toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('"A ""quoted"", name"');
  });
  it('zip round trip', () => {
    const z = new ZipBuilder(new Date('2026-10-30T07:10:00Z'));
    z.add('data/x/a.csv', Buffer.from('a,b\r\n1,2\r\n'));
    z.add('README.txt', Buffer.from('hello'));
    const files = readZip(z.finish());
    expect([...files.keys()]).toEqual(['data/x/a.csv', 'README.txt']);
    expect(files.get('README.txt')!.toString()).toBe('hello');
  });
});
