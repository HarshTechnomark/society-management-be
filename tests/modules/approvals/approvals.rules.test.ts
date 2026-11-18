import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalRequest, ApprovalRule, AuditLog, closeDb } from '../../../src/models';
import { advance } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { configWorld, idem, ruleBody, step, type ConfigWorld } from '../../helpers/approvals-config';
import { as, login, makeSociety, memberUser, resetLogins } from '../../helpers/access';
import { sentNotifications } from '../../../src/modules/approvals/approvals.ports';
import { runRuleHealth, ruleHealthJob } from '../../../src/modules/approvals/approvals.rules.health';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
let w: ConfigWorld;
beforeEach(async () => {
  resetLogins();
  resetRateLimits();
  w = await configWorld();
});

const sid = () => w.society.id!;
const rulesOf = (type = 'EXPENSE') =>
  ApprovalRule.findAll({ where: { societyId: sid(), type }, order: [['priority', 'ASC']] });
const create = async (o: Record<string, unknown> = {}) =>
  (await w.api('chairman'))('post', '/approvals/rules', ruleBody(o), { headers: idem() });

describe('GET /approvals/rules (8.12, BR-14-6)', () => {
  it('seeds the defaults of a type and lists them by priority', async () => {
    const r = await (
      await w.api('treasurer')
    )('get', '/approvals/rules', undefined, { query: { type: 'EXPENSE' } });
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => [x.priority, x.name, x.action])).toEqual([
      [10, 'Small expenses', 'AUTO_APPROVE'],
      [20, 'Expenses up to ₹25,000', 'REQUIRE_APPROVAL'],
      [30, 'Expenses above ₹25,000', 'REQUIRE_APPROVAL'],
    ]);
    expect(r.body.data[2]).toMatchObject({
      isDefault: true,
      openRequests: 0,
      version: 1,
      minAmountPaise: 2500001,
    });
    expect(await AuditLog.count({ where: { action: 'approvals.rule.seeded' } })).toBe(1);
  });
  it('without a type seeds every type once; includeInactive=false hides inactive rules', async () => {
    const api = await w.api('chairman');
    const all = await api('get', '/approvals/rules');
    expect(all.body.data.length).toBeGreaterThan(30);
    const again = await api('get', '/approvals/rules');
    expect(again.body.data.length).toBe(all.body.data.length);
    const notice = all.body.data.find((x: any) => x.type === 'NOTICE_PUBLISH');
    await api('patch', `/approvals/rules/${notice.id}`, { version: 1, isActive: false });
    const live = await api('get', '/approvals/rules', undefined, {
      query: { type: 'NOTICE_PUBLISH', includeInactive: 'false' },
    });
    expect(live.body.data).toEqual([]);
  });
  it('counts open requests per rule and reads one rule', async () => {
    await w.raise('accountant', { type: 'EXPENSE', entityId: 1, amountPaise: 4_800_000 });
    const api = await w.api('chairman');
    const list = await api('get', '/approvals/rules', undefined, { query: { type: 'EXPENSE' } });
    const big = list.body.data.find((x: any) => x.priority === 30);
    expect(big.openRequests).toBe(1);
    const one = await api('get', `/approvals/rules/${big.id}`);
    expect(one.body.data.openRequests).toBe(1);
  });
  it('400 on an unknown type', async () => {
    const r = await (
      await w.api('chairman')
    )('get', '/approvals/rules', undefined, { query: { type: 'NOPE' } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /approvals/rules (8.13, BR-14-28)', () => {
  it('creates a rule with audit, version 1 and a replay with the same key', async () => {
    const api = await w.api('chairman');
    const headers = idem();
    const body = ruleBody();
    const r = await api('post', '/approvals/rules', body, { headers });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      name: 'Custom expense rule',
      version: 1,
      isDefault: false,
      isActive: true,
    });
    expect(Array.isArray(r.body.data.warnings)).toBe(true);
    expect(
      await AuditLog.count({ where: { action: 'approvals.rule.created', entityId: String(r.body.data.id) } }),
    ).toBe(1);
    const replay = await api('post', '/approvals/rules', body, { headers });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect((await rulesOf()).length).toBe(1);
    const reused = await api('post', '/approvals/rules', ruleBody({ name: 'Another name' }), { headers });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
  it('requires an Idempotency-Key', async () => {
    const r = await (await w.api('chairman'))('post', '/approvals/rules', ruleBody());
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await rulesOf()).length).toBe(0);
  });
  it('409 RULE_NAME_TAKEN, also case-insensitive', async () => {
    expect((await create()).status).toBe(201);
    const r = await create({ name: 'CUSTOM EXPENSE RULE', priority: 16 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('RULE_NAME_TAKEN');
  });
  it('T14-22: the 21st live rule of a type is refused', async () => {
    for (let i = 0; i < 20; i++)
      expect((await create({ name: `Rule number ${i}`, priority: 100 + i })).status).toBe(201);
    const r = await create({ name: 'One too many', priority: 200 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('RULE_LIMIT_REACHED');
    // another type is unaffected
    expect(
      (
        await create({
          type: 'NOTICE_PUBLISH',
          name: 'Notice rule',
          steps: [step({ roleKeys: ['secretary'] })],
        })
      ).status,
    ).toBe(201);
  });
  it('T14-23: maximum below minimum', async () => {
    const r = await create({ minAmountPaise: 1000, maxAmountPaise: 999 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('RULE_AMOUNT_RANGE_INVALID');
  });
  it('T14-21: a role without the approve permission', async () => {
    const r = await create({ steps: [step({ roleKeys: ['accountant'] })] });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('STEP_ROLE_LACKS_PERMISSION');
  });
  it('STEP_ROLE_UNKNOWN for a role of no society, also in fallback and escalation roles', async () => {
    for (const o of [
      { steps: [step({ roleKeys: ['ghost_role'] })] },
      { fallbackRoleKeys: ['ghost_role'] },
      { escalationRoleKeys: ['ghost_role'] },
      { requesterRoleKeys: ['ghost_role'] },
    ]) {
      const r = await create(o);
      expect(r.status, JSON.stringify(o)).toBe(422);
      expect(r.body.code).toBe('STEP_ROLE_UNKNOWN');
    }
  });
  it('STEP_USER_NOT_ELIGIBLE for a named member who cannot approve or is not a member', async () => {
    for (const userIds of [[w.people.facility_manager!.id], [999999]]) {
      const r = await create({ steps: [step({ roleKeys: [], userIds })] });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('STEP_USER_NOT_ELIGIBLE');
    }
    const ok = await create({ steps: [step({ roleKeys: [], userIds: [w.people.treasurer!.id] })] });
    expect(ok.status).toBe(201);
  });
  it('RULE_STEPS_INVALID: automatic rule with steps, no steps, bad numbering, no slots, N_OF and ALL_OF limits', async () => {
    const bad = [
      { action: 'AUTO_APPROVE', steps: [step()] },
      { steps: [] },
      { steps: [step({ stepNo: 2 })] },
      { steps: [step({ roleKeys: [], userIds: [] })] },
      { steps: [step({ mode: 'N_OF', requiredCount: null })] },
      { steps: [step({ mode: 'N_OF', requiredCount: 1, roleKeys: ['treasurer', 'chairman'] })] },
      { steps: [step({ mode: 'ANY_OF', requiredCount: 2 })] },
      {
        steps: [
          step({
            mode: 'ALL_OF',
            roleKeys: ['chairman', 'treasurer', 'secretary', 'society_admin', 'committee_member', 'auditor'],
          }),
        ],
      },
    ];
    for (const o of bad) {
      const r = await create(o);
      expect(r.status, JSON.stringify(o)).toBe(422);
      expect(r.body.code, JSON.stringify(o)).toBe('RULE_STEPS_INVALID');
    }
    const auto = await create({ action: 'AUTO_APPROVE', steps: [], name: 'Auto rule', maxAmountPaise: 100 });
    expect(auto.status).toBe(201);
  });
  it('STEP_CANNOT_BE_SATISFIED when N_OF needs more people than can fill the pool', async () => {
    const r = await create({
      steps: [step({ mode: 'N_OF', requiredCount: 3, roleKeys: ['treasurer', 'chairman'] })],
      fallbackRoleKeys: [],
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('STEP_CANNOT_BE_SATISFIED');
  });
  it('field rules: step-up amount on a non-money type, escalation before the SLA, unknown fields, bad names', async () => {
    const cases = [
      { type: 'NOTICE_PUBLISH', steps: [step({ roleKeys: ['secretary'] })], stepUpAbovePaise: 100 },
      { slaHours: 48, escalateAfterHours: 10 },
      { name: 'ab' },
      { priority: 1000 },
      { surprise: true },
      { categoryKeys: ['lower'] },
      { steps: [step({ roleKeys: ['treasurer', 'treasurer'] })] },
    ];
    for (const o of cases) {
      const r = await create(o);
      expect(r.status, JSON.stringify(o)).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }
  });
  it('T14-05: deleting rule 20 warns COVERAGE_GAP for 500001 to 2500000', async () => {
    const api = await w.api('chairman');
    const list = await api('get', '/approvals/rules', undefined, { query: { type: 'EXPENSE' } });
    const mid = list.body.data.find((x: any) => x.priority === 20);
    const r = await api('delete', `/approvals/rules/${mid.id}`, {
      version: 1,
      reason: 'Not needed any more',
    });
    expect(r.status).toBe(200);
    const gap = r.body.data.warnings.find((x: any) => x.code === 'COVERAGE_GAP');
    expect(gap).toMatchObject({ fromPaise: 500_001, toPaise: 2_500_000 });
    expect(gap.message).toContain('auto-approve');
  });
  it('RULE_SHADOWED when an earlier rule already matches everything', async () => {
    const api = await w.api('chairman');
    await api('get', '/approvals/rules', undefined, { query: { type: 'EXPENSE' } });
    const r = await create({
      name: 'Never reached',
      priority: 25,
      minAmountPaise: 600_000,
      maxAmountPaise: 700_000,
    });
    const sh = r.body.data.warnings.find((x: any) => x.code === 'RULE_SHADOWED');
    expect(sh.message).toContain("Rule 'Expenses up to ₹25,000' (priority 20)");
  });
  it('T14-51: N_OF 2 of [treasurer, chairman] saves with RULE_MAY_BE_UNSATISFIABLE', async () => {
    const r = await create({
      name: 'Two of two',
      steps: [
        step({
          mode: 'N_OF',
          requiredCount: 2,
          roleKeys: ['treasurer', 'chairman'],
          name: 'Two of Treasurer, Chairman',
        }),
      ],
    });
    expect(r.status).toBe(201);
    const warn = r.body.data.warnings.find((x: any) => x.code === 'RULE_MAY_BE_UNSATISFIABLE');
    expect(warn.requesterRoleKeys.sort()).toEqual(['chairman', 'treasurer']);
  });
  it('a default two-of-three rule has no unsatisfiable warning (BR-14-33)', async () => {
    const r = await create({
      name: 'Two of three',
      steps: [
        step({
          mode: 'N_OF',
          requiredCount: 2,
          roleKeys: ['chairman', 'treasurer', 'secretary'],
          name: 'Two of three',
        }),
      ],
    });
    expect(r.body.data.warnings.filter((x: any) => x.code === 'RULE_MAY_BE_UNSATISFIABLE')).toEqual([]);
  });
});

describe('PATCH /approvals/rules/:id (8.13, BR-14-5)', () => {
  it('edits with version check, bumps the version and writes before and after', async () => {
    const api = await w.api('chairman');
    const c = (await create()).body.data;
    const r = await api('patch', `/approvals/rules/${c.id}`, {
      version: 1,
      name: 'Renamed rule',
      slaHours: 24,
      escalateAfterHours: 48,
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ name: 'Renamed rule', version: 2, slaHours: 24 });
    const a = await AuditLog.findOne({ where: { action: 'approvals.rule.updated', entityId: String(c.id) } });
    expect((a!.before as any).name).toBe('Custom expense rule');
    expect((a!.after as any).name).toBe('Renamed rule');
    const stale = await api('patch', `/approvals/rules/${c.id}`, { version: 1, name: 'Again' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
  });
  it('type cannot change; unknown id is 404; switching to AUTO_APPROVE clears the steps', async () => {
    const api = await w.api('chairman');
    const c = (await create()).body.data;
    const t = await api('patch', `/approvals/rules/${c.id}`, { version: 1, type: 'NOTICE_PUBLISH' });
    expect(t.status).toBe(400);
    expect((await api('patch', '/approvals/rules/999999', { version: 1, name: 'Whatever' })).body.code).toBe(
      'APPROVAL_RULE_NOT_FOUND',
    );
    const a = await api('patch', `/approvals/rules/${c.id}`, { version: 1, action: 'AUTO_APPROVE' });
    expect(a.status).toBe(200);
    expect(a.body.data.steps).toEqual([]);
  });
  it('RULE_NAME_TAKEN and amount-range errors apply to the merged rule', async () => {
    const api = await w.api('chairman');
    const list = await api('get', '/approvals/rules', undefined, { query: { type: 'EXPENSE' } });
    const c = (await create()).body.data;
    const n = await api('patch', `/approvals/rules/${c.id}`, { version: 1, name: 'Small expenses' });
    expect(n.status).toBe(409);
    expect(n.body.code).toBe('RULE_NAME_TAKEN');
    const mid = list.body.data.find((x: any) => x.priority === 20);
    const m = await api('patch', `/approvals/rules/${mid.id}`, { version: 1, minAmountPaise: 9_000_000 });
    expect(m.status).toBe(422);
    expect(m.body.code).toBe('RULE_AMOUNT_RANGE_INVALID');
  });
  it('T14-20: an open request keeps its snapshot; the next request uses the new rule', async () => {
    const api = await w.api('chairman');
    const first = await w.raise('accountant', { type: 'EXPENSE', entityId: 1, amountPaise: 4_800_000 });
    expect(first.totalSteps).toBe(1);
    const list = await api('get', '/approvals/rules', undefined, { query: { type: 'EXPENSE' } });
    const big = list.body.data.find((x: any) => x.priority === 30);
    const r = await api('patch', `/approvals/rules/${big.id}`, {
      version: 1,
      steps: [step({ mode: 'ANY_OF', roleKeys: ['chairman', 'treasurer'], name: 'Chairman or Treasurer' })],
    });
    expect(r.status).toBe(200);
    const open = await ApprovalRequest.findByPk(first.id);
    expect(open!.ruleSnapshot!.steps[0]!.mode).toBe('N_OF');
    expect(open!.ruleVersion).toBe(1);
    const second = await w.raise('accountant', { type: 'EXPENSE', entityId: 2, amountPaise: 4_800_000 });
    const row = await ApprovalRequest.findByPk(second.id);
    expect(row!.ruleSnapshot!.steps[0]!.mode).toBe('ANY_OF');
    expect(row!.ruleVersion).toBe(2);
  });
});

describe('DELETE /approvals/rules/:id (8.14) and reset-defaults (8.15)', () => {
  it('soft-deletes, lets the name be reused, validates the body and the version', async () => {
    const api = await w.api('chairman');
    const c = (await create()).body.data;
    expect((await api('delete', `/approvals/rules/${c.id}`, { version: 1, reason: 'no' })).status).toBe(400);
    expect(
      (await api('delete', `/approvals/rules/${c.id}`, { version: 5, reason: 'Long enough reason' })).body
        .code,
    ).toBe('STALE_VERSION');
    const d = await api('delete', `/approvals/rules/${c.id}`, { version: 1, reason: 'Long enough reason' });
    expect(d.status).toBe(200);
    expect(await ApprovalRule.count({ where: { id: c.id } })).toBe(0);
    expect(await ApprovalRule.count({ where: { id: c.id }, paranoid: false })).toBe(1);
    expect((await api('get', `/approvals/rules/${c.id}`)).status).toBe(404);
    expect(await AuditLog.count({ where: { action: 'approvals.rule.deleted' } })).toBe(1);
    expect((await create()).status).toBe(201);
  });
  it('deleting every rule never re-seeds the defaults (BR-14-6)', async () => {
    const api = await w.api('chairman');
    const list = await api('get', '/approvals/rules', undefined, { query: { type: 'EXPENSE' } });
    for (const r of list.body.data)
      await api('delete', `/approvals/rules/${r.id}`, { version: 1, reason: 'Clearing everything' });
    const again = await api('get', '/approvals/rules', undefined, { query: { type: 'EXPENSE' } });
    expect(again.body.data).toEqual([]);
  });
  it('reset-defaults replaces the rules of one type only, in one transaction, with an audit row', async () => {
    const api = await w.api('chairman');
    await create();
    await create({
      type: 'NOTICE_PUBLISH',
      name: 'Custom notice rule',
      steps: [step({ roleKeys: ['secretary'] })],
    });
    const r = await api('post', '/approvals/rules/reset-defaults', {
      type: 'EXPENSE',
      reason: 'Back to the defaults',
    });
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.name)).toEqual([
      'Small expenses',
      'Expenses up to ₹25,000',
      'Expenses above ₹25,000',
    ]);
    expect(r.body.data.every((x: any) => x.isDefault)).toBe(true);
    expect(Array.isArray(r.body.warnings)).toBe(true);
    expect((await rulesOf()).length).toBe(3);
    expect((await rulesOf('NOTICE_PUBLISH')).map(x => x.name)).toEqual(['Custom notice rule']);
    expect(await AuditLog.count({ where: { action: 'approvals.rule.reset' } })).toBe(1);
    expect(
      (await api('post', '/approvals/rules/reset-defaults', { type: 'EXPENSE', reason: 'x' })).status,
    ).toBe(400);
  });
});

describe('POST /approvals/rules/simulate (8.16)', () => {
  const sim = async (role: string, body: Record<string, unknown>) =>
    (await w.api(role))('post', '/approvals/rules/simulate', body);
  it('shows the matching rule and who would approve (maker-checker removes the requester)', async () => {
    const r = await sim('treasurer', { type: 'EXPENSE', amountPaise: 4_800_000 });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      ruleName: 'Expenses above ₹25,000',
      routing: 'STEPS',
      stepUpRequired: true,
    });
    const st = r.body.data.steps[0];
    expect(st).toMatchObject({ stepNo: 1, mode: 'N_OF' });
    expect(st.eligibleNow.map((e: any) => e.roleKey).sort()).toEqual(['chairman', 'secretary']);
    expect(st.eligibleNow.every((e: any) => e.via === 'ROLE' && typeof e.name === 'string')).toBe(true);
  });
  it('auto-approves small amounts and honours requesterUserId', async () => {
    const small = await sim('chairman', { type: 'EXPENSE', amountPaise: 300_000 });
    expect(small.body.data).toMatchObject({ routing: 'AUTO_RULE', steps: [], stepUpRequired: false });
    const other = await sim('chairman', {
      type: 'EXPENSE',
      amountPaise: 1_000_000,
      requesterUserId: w.people.secretary!.id,
    });
    expect(other.body.data.steps[0].eligibleNow.map((e: any) => e.roleKey).sort()).toEqual([
      'chairman',
      'treasurer',
    ]);
  });
  it('lists vacant slots and fallback people when a role has nobody', async () => {
    w = await configWorld({ roles: ['chairman', 'treasurer', 'secretary', 'accountant'] });
    const r = await (await w.api('treasurer'))('post', '/approvals/rules/simulate', { type: 'MOVE_IN' });
    expect(r.body.data.routing).toBe('STEPS');
    expect(r.body.data.steps[0].eligibleNow.map((e: any) => e.via).sort()).toEqual(['ROLE', 'ROLE']);
    const v = await (
      await w.api('chairman')
    )('post', '/approvals/rules/simulate', {
      type: 'PURCHASE_ORDER',
      amountPaise: 100,
    });
    expect(v.body.data.steps[0].vacantSlots).toEqual([]);
  });
  it('422 when the requester is not an active member; 400 on bad input', async () => {
    const r = await sim('chairman', { type: 'EXPENSE', requesterUserId: 999999 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('STEP_USER_NOT_ELIGIBLE');
    expect((await sim('chairman', { type: 'EXPENSE', amountPaise: -1 })).status).toBe(400);
  });
  it('writes nothing but the default seed', async () => {
    await sim('chairman', { type: 'EXPENSE', amountPaise: 1 });
    expect(await ApprovalRequest.count()).toBe(0);
    expect((await rulesOf()).length).toBe(3);
  });
});

describe('access and step-up', () => {
  it('T14-39: viewers and others cannot edit; the edit routes need the edit permission', async () => {
    for (const role of ['auditor', 'treasurer', 'accountant']) {
      const api = await w.api(role);
      expect((await api('post', '/approvals/rules', ruleBody(), { headers: idem() })).status, role).toBe(403);
      expect((await api('patch', '/approvals/rules/1', { version: 1, name: 'Nope nope' })).status).toBe(403);
      expect((await api('delete', '/approvals/rules/1', { version: 1, reason: 'Long enough' })).status).toBe(
        403,
      );
      expect(
        (await api('post', '/approvals/rules/reset-defaults', { type: 'EXPENSE', reason: 'Long enough' }))
          .status,
      ).toBe(403);
    }
    expect(
      (await (await w.api('auditor'))('get', '/approvals/rules', undefined, { query: { type: 'EXPENSE' } }))
        .status,
    ).toBe(200);
    expect((await (await w.api('accountant'))('get', '/approvals/rules')).status).toBe(403);
    expect(
      (await (await w.api('accountant'))('post', '/approvals/rules/simulate', { type: 'EXPENSE' })).status,
    ).toBe(403);
  });
  it('every rule edit asks for a fresh sign-in (step-up)', async () => {
    const api = await w.api('chairman');
    const c = (await create()).body.data;
    advance(12 * 60_000);
    const calls: [string, string, unknown][] = [
      ['post', '/approvals/rules', ruleBody({ name: 'Late rule' })],
      ['patch', `/approvals/rules/${c.id}`, { version: 1, name: 'Late rename' }],
      ['delete', `/approvals/rules/${c.id}`, { version: 1, reason: 'Long enough reason' }],
      ['post', '/approvals/rules/reset-defaults', { type: 'EXPENSE', reason: 'Long enough reason' }],
    ];
    for (const [m, p, b] of calls) {
      const r = await api(m as 'post', p, b, { headers: idem() });
      expect(r.status, `${m} ${p}`).toBe(401);
      expect(r.body.code).toBe('REAUTH_REQUIRED');
    }
    expect((await rulesOf()).length).toBe(1);
    expect((await rulesOf())[0]!.name).toBe('Custom expense rule');
  });
  it('T14-36: another society cannot read or change a rule', async () => {
    const other = await makeSociety('Other Society');
    const mine = (await create()).body.data;
    const chairmanB = await memberUser(other, 'chairman', { name: 'B chairman' });
    const b = as(await login(chairmanB, { societyId: other.id! }));
    expect((await b('get', `/approvals/rules/${mine.id}`)).body.code).toBe('APPROVAL_RULE_NOT_FOUND');
    expect(
      (await b('patch', `/approvals/rules/${mine.id}`, { version: 1, name: 'Hijacked rule' })).status,
    ).toBe(404);
    expect(
      (await b('delete', `/approvals/rules/${mine.id}`, { version: 1, reason: 'Long enough' })).status,
    ).toBe(404);
    const list = await b('get', '/approvals/rules', undefined, { query: { type: 'EXPENSE' } });
    expect(list.body.data.map((x: any) => x.name)).not.toContain('Custom expense rule');
    expect((await ApprovalRule.findByPk(mine.id))!.name).toBe('Custom expense rule');
  });
});

describe('approvals:rule-health (BR-14-32, T14-53)', () => {
  const risky = () =>
    create({
      name: 'Two of two',
      steps: [
        step({
          mode: 'N_OF',
          requiredCount: 2,
          roleKeys: ['treasurer', 'chairman'],
          name: 'Two of Treasurer, Chairman',
        }),
      ],
    });
  it('finds nothing in the default rules', async () => {
    await (
      await w.api('chairman')
    )('get', '/approvals/rules');
    expect(await runRuleHealth(sid())).toEqual([]);
  });
  it('sends one notification per risky rule in 7 days, however often it runs', async () => {
    await risky();
    sentNotifications.length = 0;
    await ruleHealthJob({ societyId: sid() });
    await ruleHealthJob({ societyId: sid() });
    const n = sentNotifications.filter(s => s.template === 'approvals.rule_health');
    expect(n.length).toBe(1);
    expect(n[0]!.userIds).toContain(w.people.chairman!.id);
    expect(n[0]!.data).toMatchObject({ title: 'Two of two' });
    // the finding is still returned on every run
    expect((await runRuleHealth(sid()))[0]).toMatchObject({ ruleName: 'Two of two' });
  });
  it('a run without a society checks every society', async () => {
    await risky();
    sentNotifications.length = 0;
    await ruleHealthJob({});
    expect(sentNotifications.filter(s => s.template === 'approvals.rule_health').length).toBe(1);
  });
});
