import { describe, expect, it } from 'vitest';
import {
  allowedLevel,
  assertUrgencyAllowed,
  deriveAffectedLevel,
  defaultTitle,
  effectivePriority,
  mergeCategory,
  raisePriority,
  reporterLabel,
  reporterRoleFor,
  resolveAffected,
  scopeFits,
  upvoteRaise,
  validTitle,
  type CategoryRow,
} from '../../../src/modules/helpdesk/helpdesk.rules';
import { pickLeastLoaded } from '../../../src/modules/helpdesk/helpdesk.routing';

describe('affected level (BR-15-4, T15-05)', () => {
  it('derives the default level from the node', () => {
    expect(deriveAffectedLevel({ nodeType: 'BUILDING', buildingId: 2, floor: null })).toBe('BUILDING');
    expect(deriveAffectedLevel({ nodeType: 'FLOOR', buildingId: 2, floor: 3 })).toBe('FLOOR');
    expect(deriveAffectedLevel({ nodeType: 'AREA', areaType: 'CORRIDOR', buildingId: 2, floor: 3 })).toBe(
      'FLOOR',
    );
    expect(deriveAffectedLevel({ nodeType: 'AREA', areaType: 'LIFT', buildingId: 2, floor: 0 })).toBe(
      'BUILDING',
    );
    expect(deriveAffectedLevel({ nodeType: 'AREA', areaType: 'GATE', buildingId: null, floor: null })).toBe(
      'SOCIETY',
    );
  });
  it('allows SOCIETY always, BUILDING with a building, FLOOR with a building and a floor', () => {
    const gate = { nodeType: 'AREA', areaType: 'GATE', buildingId: null, floor: null };
    const lift = { nodeType: 'AREA', areaType: 'LIFT', buildingId: 2, floor: null };
    expect(allowedLevel('SOCIETY', gate)).toBe(true);
    expect(allowedLevel('BUILDING', gate)).toBe(false);
    expect(allowedLevel('BUILDING', lift)).toBe(true);
    expect(allowedLevel('FLOOR', lift)).toBe(false);
    expect(allowedLevel('FLOOR', { ...lift, floor: 1 })).toBe(true);
    expect(() => resolveAffected('FLOOR', lift)).toThrowError(/not possible/);
  });
  it('copies the building and floor of the chosen level', () => {
    const n = { nodeType: 'FLOOR', buildingId: 2, floor: 4 };
    expect(resolveAffected(undefined, n)).toEqual({ level: 'FLOOR', buildingId: 2, floor: 4 });
    expect(resolveAffected('BUILDING', n)).toEqual({ level: 'BUILDING', buildingId: 2, floor: null });
    expect(resolveAffected('SOCIETY', n)).toEqual({ level: 'SOCIETY', buildingId: null, floor: null });
  });
});

describe('priority (BR-15-8, T15-06)', () => {
  it('takes the more urgent of the category default and the urgency', () => {
    expect(effectivePriority('P3', 'URGENT')).toEqual({ priority: 'P2', source: 'REPORTER' });
    expect(effectivePriority('P2', 'NORMAL')).toEqual({ priority: 'P2', source: 'CATEGORY' });
    expect(effectivePriority('P2', 'URGENT')).toEqual({ priority: 'P2', source: 'CATEGORY' });
    expect(effectivePriority('P4', 'EMERGENCY')).toEqual({ priority: 'P1', source: 'REPORTER' });
    expect(effectivePriority('P3', undefined)).toEqual({ priority: 'P3', source: 'CATEGORY' });
    expect(effectivePriority('P3', 'EMERGENCY', 'P4')).toEqual({ priority: 'P4', source: 'ADMIN' });
  });
  it('EMERGENCY is for building issues when a resident reports', () => {
    expect(() => assertUrgencyAllowed('PERSONAL', 'EMERGENCY', true)).toThrowError(/building issues only/);
    expect(() => assertUrgencyAllowed('BUILDING', 'EMERGENCY', true)).not.toThrow();
    expect(() => assertUrgencyAllowed('PERSONAL', 'EMERGENCY', false)).not.toThrow();
  });
  it('raises one level and stops at P1', () => {
    expect([raisePriority('P4'), raisePriority('P3'), raisePriority('P2'), raisePriority('P1')]).toEqual([
      'P3',
      'P2',
      'P1',
      'P1',
    ]);
  });
  it('BR-15-38: raises once, not from P1, only with the feature and at the threshold', () => {
    const t = {
      upvoteCount: 10,
      priority: 'P3' as const,
      priorityAutoRaisedAt: null,
      threshold: 10,
      featureOn: true,
    };
    expect(upvoteRaise(t)).toBe('P2');
    expect(upvoteRaise({ ...t, upvoteCount: 9 })).toBeNull();
    expect(upvoteRaise({ ...t, priorityAutoRaisedAt: new Date() })).toBeNull();
    expect(upvoteRaise({ ...t, priority: 'P1' })).toBeNull();
    expect(upvoteRaise({ ...t, featureOn: false })).toBeNull();
  });
});

describe('auto-assignment pick (BR-15-37, T15-07)', () => {
  const d = (n: number) => new Date(2026, 10, n);
  it('picks the fewest current assignments, then the oldest last assignment, then the lowest id', () => {
    expect(
      pickLeastLoaded([
        { userId: 1, load: 2, lastAssignedAt: d(1) },
        { userId: 2, load: 1, lastAssignedAt: d(5) },
        { userId: 3, load: 1, lastAssignedAt: d(2) },
      ]),
    ).toBe(3);
    expect(
      pickLeastLoaded([
        { userId: 5, load: 0, lastAssignedAt: d(1) },
        { userId: 4, load: 0, lastAssignedAt: null },
      ]),
    ).toBe(4);
    expect(
      pickLeastLoaded([
        { userId: 9, load: 1, lastAssignedAt: null },
        { userId: 7, load: 1, lastAssignedAt: null },
      ]),
    ).toBe(7);
    expect(pickLeastLoaded([])).toBeNull();
  });
});

const row = (o: Partial<CategoryRow>): CategoryRow => ({
  id: 1,
  name: 'Plumbing',
  scope: 'BOTH',
  defaultPriority: 'P3',
  slaPolicyId: null,
  defaultAssigneeType: 'ROLE',
  defaultRoleKey: 'facility_manager',
  defaultAssigneeUserId: null,
  defaultStaffId: null,
  defaultVendorId: null,
  isChargeable: false,
  requiresAfterPhoto: true,
  isSafety: false,
  linksInvoice: false,
  ...o,
});

describe('category merge, titles, labels', () => {
  it('BR-15-7: a sub-category inherits assignee and priority; flags are the union', () => {
    const e = mergeCategory(
      row({}),
      row({
        id: 2,
        name: 'Tap leak',
        defaultPriority: null,
        defaultAssigneeType: 'INHERIT',
        defaultRoleKey: null,
        requiresAfterPhoto: false,
        isSafety: true,
      }),
    );
    expect(e).toMatchObject({
      categoryId: 1,
      subCategoryId: 2,
      subCategoryName: 'Tap leak',
      defaultPriority: 'P3',
      defaultAssigneeType: 'ROLE',
      defaultRoleKey: 'facility_manager',
      requiresAfterPhoto: true,
      isSafety: true,
    });
    const own = mergeCategory(
      row({}),
      row({ id: 3, defaultPriority: 'P1', defaultAssigneeType: 'NONE', defaultRoleKey: null }),
    );
    expect(own).toMatchObject({ defaultPriority: 'P1', defaultAssigneeType: 'NONE', defaultRoleKey: null });
  });
  it('BR-15-6: scope must include the kind', () => {
    expect(scopeFits('BOTH', 'BUILDING')).toBe(true);
    expect(scopeFits('PERSONAL', 'BUILDING')).toBe(false);
    expect(scopeFits('BUILDING', 'BUILDING')).toBe(true);
  });
  it('BR-15-9 titles', () => {
    expect(defaultTitle('Lift stopped', 'Tower B › Ground floor › Lift 2')).toBe(
      'Lift stopped – Tower B › Ground floor › Lift 2',
    );
    expect(defaultTitle('x', 'y'.repeat(200))).toHaveLength(150);
    expect(validTitle('abcd')).toBe(false);
    expect(validTitle('abcde')).toBe(true);
    expect(validTitle('bad\u0007title')).toBe(false);
    expect(validTitle('a'.repeat(151))).toBe(false);
  });
  it('BR-15-15 and BR-15-49', () => {
    expect(reporterRoleFor('RESIDENT', false)).toBe('RESIDENT');
    expect(reporterRoleFor('GATE', false)).toBe('GUARD');
    expect(reporterRoleFor('WORK', false)).toBe('STAFF');
    expect(reporterRoleFor('ADMIN', true)).toBe('COMMITTEE');
    expect(reporterRoleFor('ADMIN', false)).toBe('OFFICE');
    expect(reporterLabel('RESIDENT', false, 'A-1203')).toBe('A resident');
    expect(reporterLabel('RESIDENT', true, 'A-1203')).toBe('Resident, A-1203');
    expect(reporterLabel('GUARD', true, null)).toBe('Security');
    expect(reporterLabel('STAFF', false, null)).toBe('Maintenance staff');
    expect(reporterLabel('COMMITTEE', false, null)).toBe('Committee');
    expect(reporterLabel('OFFICE', false, null)).toBe('Society office');
  });
});
