import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TYPES,
  CATALOGUE,
  DEFAULT_RULES,
  stepName,
} from '../../../src/modules/approvals/approvals.catalogue';
import {
  assessRule,
  canonicalJson,
  creationCapacity,
  matchRule,
  needOf,
  openSlotFor,
  payloadHash,
  slotsOf,
  stepCapacity,
  type StepState,
} from '../../../src/modules/approvals/approvals.match';
import type { ApproverMember, MatchableRule, RuleStep } from '../../../src/modules/approvals/approvals.types';

const rule = (id: number, priority: number, o: Partial<MatchableRule> = {}): MatchableRule => ({
  id,
  priority,
  isActive: true,
  minAmountPaise: 0,
  maxAmountPaise: null,
  categoryKeys: null,
  requesterRoleKeys: null,
  ...o,
});
const step = (mode: RuleStep['mode'], roleKeys: string[], o: Partial<RuleStep> = {}): RuleStep => ({
  stepNo: 1,
  name: 's',
  mode,
  roleKeys,
  userIds: [],
  requiredCount: mode === 'N_OF' ? 2 : null,
  ...o,
});
const m = (userId: number, roleKey: string): ApproverMember => ({ userId, roleKey });

describe('rule matching (BR-14-3)', () => {
  const rules = [
    rule(1, 10, { minAmountPaise: 0, maxAmountPaise: 500_000 }),
    rule(2, 20, { minAmountPaise: 500_001, maxAmountPaise: 2_500_000 }),
    rule(3, 30, { minAmountPaise: 2_500_001 }),
  ];
  it('T14-01 picks rules 10, 20, 20, 30 at the band edges', () => {
    const at = (a: number) => matchRule(rules, { amountPaise: a })?.id;
    expect([at(500_000), at(500_001), at(2_500_000), at(2_500_001)]).toEqual([1, 2, 2, 3]);
  });
  it('T14-02 a category rule is skipped when the request has no category', () => {
    const r = [rule(1, 5, { categoryKeys: ['LIFT_AMC'] }), rule(2, 50)];
    expect(matchRule(r, { amountPaise: 100 })?.id).toBe(2);
    expect(matchRule(r, { amountPaise: 100, categoryKey: 'LIFT_AMC' })?.id).toBe(1);
    expect(matchRule(r, { amountPaise: 100, categoryKey: 'OTHER' })?.id).toBe(2);
  });
  it('requester role condition, inactive rules and ties by id', () => {
    const r = [
      rule(9, 10, { requesterRoleKeys: ['accountant'] }),
      rule(4, 10, { isActive: false }),
      rule(7, 10),
      rule(6, 10),
    ];
    expect(matchRule(r, { amountPaise: 1, requesterRoleKey: 'accountant' })?.id).toBe(6);
    expect(matchRule([r[0]!], { amountPaise: 1, requesterRoleKey: 'treasurer' })).toBeNull();
    expect(matchRule([r[0]!], { amountPaise: 1 })).toBeNull();
    expect(matchRule([r[1]!], { amountPaise: 1 })).toBeNull();
  });
  it('no rule matches an amount above every maximum', () => {
    expect(matchRule([rule(1, 1, { maxAmountPaise: 10 })], { amountPaise: 11 })).toBeNull();
  });
});

describe('hash (BR-14-16)', () => {
  it('is stable across key order and changes with content', () => {
    const base = { title: 'T', summary: null, amountPaise: 5, categoryKey: null };
    expect(payloadHash({ ...base, payload: { a: 1, b: { x: 1, y: 2 } } })).toBe(
      payloadHash({ ...base, payload: { b: { y: 2, x: 1 }, a: 1 } }),
    );
    expect(payloadHash({ ...base, payload: { a: 1 } })).not.toBe(
      payloadHash({ ...base, amountPaise: 6, payload: { a: 1 } }),
    );
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
});

describe('step capacity (BR-14-11, 6.4)', () => {
  const tri = step('N_OF', ['chairman', 'treasurer', 'secretary']);
  const people = [m(1, 'chairman'), m(2, 'treasurer'), m(3, 'secretary')];
  it('N_OF 2 of 3: the requester leaves two, still fine', () => {
    const c = stepCapacity(tri, slotsOf(tri), people, new Set([1]), ['chairman']);
    expect(c).toMatchObject({ need: 2, ok: true, widened: false });
  });
  it('no secretary: Chairman raising is stuck even after widening (edge case table)', () => {
    const c = stepCapacity(tri, slotsOf(tri), [m(1, 'chairman'), m(2, 'treasurer')], new Set([1]), [
      'chairman',
    ]);
    expect(c).toMatchObject({ ok: false, widened: true });
  });
  it('widening to the fallback role rescues a short ANY_OF step', () => {
    const s = step('ANY_OF', ['treasurer']);
    const c = stepCapacity(s, slotsOf(s), [m(1, 'chairman')], new Set(), ['chairman']);
    expect(c).toMatchObject({ ok: true, widened: true });
  });
  it('ALL_OF needs a distinct person per slot; a fallback role covers the short slot', () => {
    const s = step('ALL_OF', ['treasurer', 'secretary']);
    const ok = stepCapacity(s, slotsOf(s), [m(2, 'secretary'), m(1, 'chairman')], new Set(), ['chairman']);
    expect(ok).toMatchObject({ ok: true, widened: true, vacantRefs: ['treasurer'] });
    const no = stepCapacity(s, slotsOf(s), [m(2, 'secretary')], new Set(), ['chairman']);
    expect(no.ok).toBe(false);
  });
  it('later steps assume the earlier steps people are gone (creation worst case)', () => {
    const snap = {
      fallbackRoleKeys: [],
      steps: [step('ANY_OF', ['treasurer']), { ...step('ANY_OF', ['treasurer']), stepNo: 2 }],
    };
    expect(creationCapacity(snap, [m(2, 'treasurer')], null)).toMatchObject({ ok: false, blockedStep: 2 });
    expect(creationCapacity(snap, [m(2, 'treasurer'), m(3, 'treasurer')], null).ok).toBe(true);
  });
  it('need: 1, requiredCount, uncovered slots', () => {
    const all = step('ALL_OF', ['a', 'b', 'c']);
    expect(needOf(step('ANY_OF', ['a']), [])).toBe(1);
    expect(needOf(tri, [])).toBe(2);
    expect(needOf(all, slotsOf(all), new Set(['a']))).toBe(2);
  });
});

describe('slot matching (6.2)', () => {
  const state = (o: Partial<StepState> = {}): StepState => ({
    slots: [],
    coveredRefs: new Set(),
    widened: false,
    fallbackRoleKeys: ['chairman'],
    vacantRefs: [],
    escalationOpen: false,
    escalationRoleKeys: ['chairman'],
    ...o,
  });
  it('USER before ROLE; a covered ALL_OF slot is closed; FALLBACK only when widened; ESCALATION only when open', () => {
    const s = step('ANY_OF', ['treasurer'], { userIds: [7] });
    const st = state({ slots: slotsOf(s) });
    expect(openSlotFor(m(7, 'treasurer'), s, st)).toEqual({ slotType: 'USER', slotRef: '7' });
    expect(openSlotFor(m(2, 'treasurer'), s, st)).toEqual({ slotType: 'ROLE', slotRef: 'treasurer' });
    expect(openSlotFor(m(1, 'chairman'), s, st)).toBeNull();
    expect(openSlotFor(m(1, 'chairman'), s, { ...st, widened: true })).toEqual({
      slotType: 'FALLBACK',
      slotRef: 'chairman',
    });
    expect(openSlotFor(m(1, 'chairman'), s, { ...st, escalationOpen: true })).toEqual({
      slotType: 'ESCALATION',
      slotRef: 'chairman',
    });
    const all = step('ALL_OF', ['treasurer', 'secretary']);
    const ast = state({ slots: slotsOf(all), coveredRefs: new Set(['treasurer']) });
    expect(openSlotFor(m(2, 'treasurer'), all, ast)).toBeNull();
    expect(openSlotFor(m(3, 'secretary'), all, ast)).toEqual({ slotType: 'ROLE', slotRef: 'secretary' });
  });
  it('reassign overrides replace an ALL_OF slot or join a pool (BR-14-21)', () => {
    const all = step('ALL_OF', ['treasurer', 'secretary']);
    const ov = [{ stepNo: 1, round: 1, slotIndex: 0, userId: 9, byUserId: 1, at: '' }];
    expect(slotsOf(all, ov, 1).map(s => s.ref)).toEqual(['9', 'secretary']);
    const any = step('ANY_OF', ['treasurer']);
    expect(slotsOf(any, ov, 1).map(s => s.ref)).toEqual(['treasurer', '9']);
    expect(slotsOf(any, ov, 2).map(s => s.ref)).toEqual(['treasurer']);
  });
});

describe('catalogue and defaults', () => {
  it('has the 31 types of 5.1 and every default rule names a catalogued type', () => {
    expect(APPROVAL_TYPES).toHaveLength(31);
    expect(Object.keys(DEFAULT_RULES).sort()).toEqual([...APPROVAL_TYPES].sort());
    expect(CATALOGUE.PERIOD_UNLOCK).toMatchObject({ isMoney: false, alwaysStepUp: true, owner: '13' });
    expect(CATALOGUE.EXPENSE).toMatchObject({
      isMoney: true,
      allowBulk: true,
      approvePermission: 'finance.expenses.approve',
    });
  });
  it('default rules follow 7.5: bands are contiguous and two-approval rules are N_OF 2 of 3', () => {
    for (const [type, rules] of Object.entries(DEFAULT_RULES)) {
      let next = 0;
      for (const r of [...rules].sort((a, b) => a.priority - b.priority)) {
        expect(r.minAmountPaise, type).toBe(next === 0 ? 0 : next);
        if (r.maxAmountPaise !== null) next = r.maxAmountPaise + 1;
        if (r.action === 'AUTO_APPROVE') expect(r.steps).toEqual([]);
        else expect(r.steps.length).toBeGreaterThan(0);
        for (const s of r.steps)
          if (s.mode === 'N_OF') expect([s.requiredCount, s.roleKeys.length]).toEqual([2, 3]);
      }
    }
    expect(DEFAULT_RULES.EXPENSE![2]!.steps[0]!.name).toBe('Two of Chairman, Treasurer, Secretary');
    expect(stepName('ANY_OF', ['secretary', 'chairman'], null)).toBe('Secretary or Chairman');
  });
  it('the migration CHECK list equals the catalogue', () => {
    const { TYPES } = createRequire(__filename)(
      '../../../migrations/20261119000100-create-approval-rules.js',
    ) as { TYPES: string[] };
    expect([...TYPES].sort()).toEqual([...APPROVAL_TYPES].sort());
    expect(readFileSync('migrations/20261119000200-create-approval-requests.js', 'utf8')).toContain('TYPES');
  });
});

describe('assessRule (BR-14-32)', () => {
  const tri = {
    fallbackRoleKeys: ['chairman'],
    steps: [step('N_OF', ['chairman', 'treasurer', 'secretary'])],
  };
  const all = [m(1, 'chairman'), m(2, 'treasurer'), m(3, 'secretary')];
  it('is clean with one member per signatory role', () => {
    expect(assessRule(tri, all, all)).toEqual([]);
  });
  it('T14-51 N_OF 2 of [treasurer, chairman] is risky for both of them', () => {
    const risky = { fallbackRoleKeys: ['chairman'], steps: [step('N_OF', ['treasurer', 'chairman'])] };
    expect(assessRule(risky, all, all).sort()).toEqual(['chairman', 'treasurer']);
  });
  it('an AUTO_APPROVE rule has nothing to assess', () => {
    expect(assessRule({ fallbackRoleKeys: [], steps: [] }, [], all)).toEqual([]);
  });
});
