import { describe, expect, it } from 'vitest';
import {
  buildActions,
  canonicalJson,
  handoverPairs,
  previewHash,
  revertRole,
  staffSeatEffect,
  type IncomingHolder,
  type OutgoingHolder,
  type PlanFacts,
} from '../../../src/modules/committee/committee.planner';
import { newSeat } from '../../../src/modules/committee/committee.seats';

const role = (key: string, scope: string, o: { isSystem?: boolean; consumesSeat?: boolean } = {}) =>
  [key, { key, scope, isSystem: o.isSystem ?? true, consumesSeat: o.consumesSeat ?? false }] as const;
const roles = new Map([
  role('owner', 'resident'),
  role('tenant', 'resident'),
  role('family_member', 'resident'),
  role('chairman', 'society'),
  role('secretary', 'society'),
  role('treasurer', 'society'),
  role('committee_member', 'society'),
  role('accountant', 'society', { consumesSeat: true }),
  role('guard', 'gate'),
  role('legal_adviser', 'society', { isSystem: false, consumesSeat: true }),
]);
const member = (userId: number, roleKey: string, status = 'ACTIVE') => ({
  userId,
  memberId: 1000 + userId,
  roleKey,
  status,
  consumesSeat: roles.get(roleKey)?.consumesSeat ?? false,
});
const facts = (list: ReturnType<typeof member>[], relations: Record<number, string[]> = {}): PlanFacts => ({
  members: new Map(list.map(m => [m.userId, m])),
  roles,
  relations: new Map(Object.entries(relations).map(([k, v]) => [Number(k), v])),
});
const seat = (userId: number, designation: any, extra: object = {}) =>
  newSeat({
    seatId: `S${userId}`,
    userId,
    memberId: 1000 + userId,
    name: `User ${userId}`,
    designation,
    status: 'SEATED',
    fromDate: '2024-04-01',
    ...extra,
  });
const out = (userId: number, designation: any, extra: object = {}): OutgoingHolder => ({
  userId,
  name: `User ${userId}`,
  seat: seat(userId, designation, extra),
});
const incoming = (userId: number, designation: any, extra: Partial<IncomingHolder> = {}): IncomingHolder => ({
  userId,
  name: `User ${userId}`,
  designation,
  seatId: `N${userId}`,
  replaceExistingRole: false,
  continuing: null,
  ...extra,
});

describe('T10-01 DESIGNATION_ROLE and revertRole (BR-10-10)', () => {
  it('roleBefore wins, then the strongest unit relation, else the membership ends', () => {
    expect(revertRole('accountant', ['OWNER'])).toEqual({ kind: 'ROLE', roleKey: 'accountant' });
    expect(revertRole(null, ['OWNER'])).toEqual({ kind: 'ROLE', roleKey: 'owner' });
    expect(revertRole(null, ['FAMILY', 'TENANT'])).toEqual({ kind: 'ROLE', roleKey: 'tenant' });
    expect(revertRole(null, ['FAMILY'])).toEqual({ kind: 'ROLE', roleKey: 'family_member' });
    expect(revertRole(null, [])).toEqual({ kind: 'END' });
  });
});

describe('T10-02 action ordering and hash (BR-10-11, BR-10-13)', () => {
  const people = [
    member(1, 'chairman'), // outgoing chairman
    member(2, 'treasurer'), // outgoing treasurer
    member(3, 'owner'), // incoming chairman
    member(4, 'owner'), // incoming member
    member(5, 'owner'), // incoming member
    member(6, 'secretary'), // continues as secretary
  ];
  const f = facts(people, { 1: ['OWNER'], 2: ['OWNER'] });
  const outs = [out(1, 'CHAIRMAN'), out(2, 'TREASURER')];
  const ins = [
    incoming(5, 'MEMBER'),
    incoming(4, 'MEMBER'),
    incoming(3, 'CHAIRMAN'),
    incoming(6, 'SECRETARY', { continuing: seat(6, 'SECRETARY') }),
  ];

  it('A (outgoing, not chairman), B (incoming chairman), C (outgoing chairman), D (the rest); NONE last', () => {
    const p = buildActions(outs, ins, f);
    expect(p.actions.map(a => [a.kind, 'step' in a ? a.step : '-', a.userId])).toEqual([
      ['CHANGE_ROLE', 'A', 2],
      ['CHANGE_ROLE', 'B', 3],
      ['CHANGE_ROLE', 'C', 1],
      ['CHANGE_ROLE', 'D', 4],
      ['CHANGE_ROLE', 'D', 5],
      ['NONE', '-', 6],
    ]);
    expect(p.actions[0]).toMatchObject({ fromRoleKey: 'treasurer', toRoleKey: 'owner', reason: 'OUTGOING' });
    expect(p.actions[1]).toMatchObject({ fromRoleKey: 'owner', toRoleKey: 'chairman', reason: 'INCOMING' });
    expect(p.actions[5]).toMatchObject({ roleKey: 'secretary', reason: 'CONTINUING' });
    expect(p.blockers).toEqual([]);
  });

  it('the same hash for reordered input, a different hash when an action or a version changes', () => {
    const a = buildActions(outs, ins, f);
    const b = buildActions([...outs].reverse(), [...ins].reverse(), f);
    const h = (p: typeof a, v = 3) =>
      previewHash({
        termId: 14,
        termVersion: v,
        currentTermId: 12,
        currentTermVersion: 4,
        actions: p.actions,
      });
    expect(h(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(h(a)).toBe(h(b));
    expect(h(a, 4)).not.toBe(h(a));
    const c = buildActions(
      outs,
      [...ins, incoming(7, 'MEMBER')],
      facts([...people, member(7, 'owner')], { 1: ['OWNER'], 2: ['OWNER'] }),
    );
    expect(h(c)).not.toBe(h(a));
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });

  it('a continuing chairman who becomes secretary moves after the new chairman (step D, never before B)', () => {
    const p = buildActions(
      [],
      [incoming(3, 'CHAIRMAN'), incoming(1, 'SECRETARY', { continuing: seat(1, 'CHAIRMAN') })],
      facts([member(1, 'chairman'), member(3, 'owner')]),
    );
    expect(p.actions.map(a => ('step' in a ? a.step : '-'))).toEqual(['B', 'D']);
  });

  it('a holder who already has the target role gets NONE (INCOMING when new, CONTINUING when they continue)', () => {
    const p = buildActions(
      [],
      [incoming(1, 'CHAIRMAN'), incoming(2, 'TREASURER', { continuing: seat(2, 'TREASURER') })],
      facts([member(1, 'chairman'), member(2, 'treasurer')]),
    );
    expect(p.actions.map(a => [a.kind, 'reason' in a ? a.reason : ''])).toEqual([
      ['NONE', 'INCOMING'],
      ['NONE', 'CONTINUING'],
    ]);
  });
});

describe('T10-03 staff seat effect (BR-10-17)', () => {
  const f = facts([member(1, 'chairman'), member(2, 'treasurer'), member(3, 'owner')], { 1: ['OWNER'] });

  it('limit 2 used 2: an outgoing treasurer whose role before was accountant needs a seat; a chairman going to owner does not', () => {
    const p = buildActions(
      [out(1, 'CHAIRMAN'), out(2, 'TREASURER', { roleBeforeKey: 'accountant' })],
      [incoming(3, 'CHAIRMAN')],
      f,
    );
    const treasurer = p.actions.find(a => a.userId === 2)!;
    expect(treasurer).toMatchObject({ toRoleKey: 'accountant', seatDelta: 1 });
    const s = staffSeatEffect(p.actions, { limit: 2, used: 2 });
    expect(s.staffSeats).toEqual({ limit: 2, used: 2, delta: 1 });
    expect(s.blockers).toMatchObject([{ code: 'NO_FREE_SEAT', userIds: [2] }]);
    const chairmanOnly = buildActions([out(1, 'CHAIRMAN')], [incoming(3, 'CHAIRMAN')], f);
    const s2 = staffSeatEffect(chairmanOnly.actions, { limit: 2, used: 2 });
    expect(s2.staffSeats.delta).toBe(0);
    expect(s2.blockers).toEqual([]);
  });

  it('an incoming holder leaving a staff role releases a seat (-1); an unlimited plan never blocks', () => {
    const p = buildActions(
      [out(1, 'CHAIRMAN')],
      [incoming(3, 'CHAIRMAN'), incoming(4, 'MEMBER', { replaceExistingRole: true })],
      facts([member(1, 'chairman'), member(3, 'owner'), member(4, 'accountant')], { 1: ['OWNER'] }),
    );
    expect(p.actions.find(a => a.userId === 4)).toMatchObject({
      seatDelta: -1,
      toRoleKey: 'committee_member',
    });
    expect(staffSeatEffect(p.actions, { limit: 2, used: 2 }).staffSeats.delta).toBe(-1);
    expect(staffSeatEffect(p.actions, { limit: null, used: 99 }).blockers).toEqual([]);
  });
});

describe('BR-10-9 role conflict and roleBeforeKey', () => {
  const f = facts([
    member(1, 'accountant'),
    member(2, 'legal_adviser'),
    member(3, 'guard'),
    member(4, 'owner'),
  ]);

  it('a staff, custom or gate role needs replaceExistingRole (ROLE_CONFLICT blocker with the seat ids); a resident role does not', () => {
    const p = buildActions([], [incoming(1, 'MEMBER'), incoming(2, 'MEMBER'), incoming(4, 'MEMBER')], f);
    expect(p.blockers).toMatchObject([{ code: 'ROLE_CONFLICT', seatIds: ['N1', 'N2'], userIds: [1, 2] }]);
  });

  it('replacing a system role stores it as roleBeforeKey; a custom role is not restored and warns', () => {
    const p = buildActions(
      [],
      [
        incoming(1, 'MEMBER', { replaceExistingRole: true }),
        incoming(2, 'MEMBER', { replaceExistingRole: true }),
        incoming(3, 'MEMBER', { replaceExistingRole: true }),
      ],
      f,
    );
    expect(p.blockers).toEqual([]);
    expect(p.roleBefore.get(1)).toBe('accountant');
    expect(p.roleBefore.get(2)).toBeNull();
    expect(p.roleBefore.get(3)).toBe('guard');
    expect(p.warnings).toEqual([expect.objectContaining({ code: 'CUSTOM_ROLE_NOT_RESTORED', userIds: [2] })]);
  });

  it('a continuing holder keeps the roleBeforeKey of the seat they leave', () => {
    const p = buildActions(
      [],
      [incoming(4, 'CHAIRMAN', { continuing: seat(4, 'SECRETARY', { roleBeforeKey: 'accountant' }) })],
      facts([member(4, 'secretary')]),
    );
    expect(p.roleBefore.get(4)).toBe('accountant');
  });
});

describe('outgoing holders: warnings and the end of a membership (BR-10-10)', () => {
  it('no flat link ends the membership with a warning; a suspended holder warns; an ended or already moved holder is skipped', () => {
    const f = facts(
      [member(1, 'treasurer'), member(2, 'committee_member', 'SUSPENDED'), member(3, 'accountant')],
      { 2: ['TENANT'] },
    );
    const p = buildActions(
      [out(1, 'TREASURER'), out(2, 'MEMBER'), out(3, 'MEMBER'), out(9, 'MEMBER')],
      [],
      f,
    );
    expect(p.actions).toMatchObject([
      { kind: 'END_MEMBERSHIP', userId: 1, step: 'A', fromRoleKey: 'treasurer', seatDelta: 0 },
      { kind: 'CHANGE_ROLE', userId: 2, toRoleKey: 'tenant', reason: 'OUTGOING' },
    ]);
    expect(p.warnings.map(w => w.code).sort()).toEqual(['HOLDER_SUSPENDED_OUTGOING', 'MEMBERSHIP_WILL_END']);
  });

  it('a roleBeforeKey whose role no longer exists falls back to the unit relation', () => {
    const p = buildActions(
      [out(1, 'MEMBER', { roleBeforeKey: 'deleted_role' })],
      [],
      facts([member(1, 'committee_member')], { 1: ['OWNER'] }),
    );
    expect(p.actions[0]).toMatchObject({ toRoleKey: 'owner' });
  });
});

describe('BR-10-18 hand-over pairs', () => {
  it('one pair per office-bearer designation whose holder changes; MEMBER and an unchanged holder give none', () => {
    const before = [
      { designation: 'CHAIRMAN', userId: 1, name: 'A' },
      { designation: 'SECRETARY', userId: 2, name: 'B' },
      { designation: 'TREASURER', userId: 3, name: 'C' },
      { designation: 'MEMBER', userId: 4, name: 'D' },
    ] as const;
    const after = [
      { designation: 'CHAIRMAN', userId: 5, name: 'E' },
      { designation: 'SECRETARY', userId: 2, name: 'B' },
      { designation: 'MEMBER', userId: 6, name: 'F' },
    ] as const;
    expect(handoverPairs([...before], [...after])).toEqual([
      { designation: 'CHAIRMAN', fromUserId: 1, fromName: 'A', toUserId: 5, toName: 'E' },
    ]);
  });
});
