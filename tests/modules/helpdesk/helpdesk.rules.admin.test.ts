import { Op } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog, EscalationRule, TicketCategory, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { idem } from '../../helpers/access';
import { helpdeskApiWorld } from '../../helpers/helpdesk';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});

let w: Awaited<ReturnType<typeof helpdeskApiWorld>>;
let admin: Awaited<ReturnType<typeof w.api>>;
beforeAll(async () => {
  w = await helpdeskApiWorld('PREMIUM', ['chairman', 'facility_manager', 'accountant', 'treasurer', 'owner']);
  admin = await w.api('chairman');
});

const rule = (name: string, o: Record<string, unknown> = {}) => ({
  name,
  triggerType: 'RESOLUTION_SLA',
  thresholdPercent: 90,
  level: 1,
  targetType: 'ROLE',
  targetRoleKey: 'facility_manager',
  ...o,
});
const audits = (action: string) => AuditLog.count({ where: { societyId: w.sid, action } });
const make = async (name: string, o: Record<string, unknown> = {}) => {
  const r = await admin('post', '/escalation-rules', rule(name, o), { headers: idem() });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.data;
};

describe('GET /escalation-rules (8.5)', () => {
  it('seeds the six rules, ordered by level; status filter; viewer 200, others 403', async () => {
    const r = await admin('get', '/escalation-rules');
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: any) => x.name)).toEqual([
      'Low rating',
      'SLA warning',
      'No response',
      'Resident escalation',
      'SLA breached',
      'SLA severe',
    ]);
    const breached = r.body.data.find((x: any) => x.name === 'SLA breached');
    expect(breached).toMatchObject({
      triggerType: 'RESOLUTION_SLA',
      thresholdPercent: 100,
      level: 2,
      targetType: 'DESIGNATION',
      targetDesignation: 'SECRETARY',
      notifyAssignee: true,
      status: 'ACTIVE',
      categoryName: null,
    });
    expect((await admin('get', '/escalation-rules?status=INACTIVE')).body.data).toEqual([]);
    expect((await admin('get', '/escalation-rules?status=ACTIVE')).body.data).toHaveLength(6);
    expect((await admin('get', '/escalation-rules?status=NOPE')).status).toBe(400);
    expect((await (await w.api('facility_manager'))('get', '/escalation-rules')).status).toBe(200);
    expect((await (await w.api('accountant'))('get', '/escalation-rules')).status).toBe(403);
    expect((await (await w.api('owner', 'RESIDENT'))('get', '/escalation-rules')).status).toBe(403);
  });
});

describe('POST /escalation-rules (BR-15-64)', () => {
  it('creates ROLE, DESIGNATION and MEMBER rules with category and priority, and audits', async () => {
    const cat = (await TicketCategory.findOne({
      where: { societyId: w.sid, name: 'Lift', parentId: null },
    }))!;
    const a = await make('Lift P1 warning', { categoryId: cat.id, priority: 'P1', notifyAssignee: true });
    expect(a).toMatchObject({
      categoryId: cat.id,
      categoryName: 'Lift',
      priority: 'P1',
      level: 1,
      version: 1,
      status: 'ACTIVE',
      notifyAssignee: true,
    });
    const b = await make('Treasurer eyes', {
      targetType: 'DESIGNATION',
      targetRoleKey: undefined,
      targetDesignation: 'TREASURER',
      level: 2,
    });
    expect(b.targetDesignation).toBe('TREASURER');
    const fm = w.people.facility_manager!;
    const c = await make('FM direct', {
      targetType: 'MEMBER',
      targetRoleKey: undefined,
      targetUserId: fm.id,
      level: 3,
    });
    expect(c).toMatchObject({ targetUserId: fm.id, targetUserName: 'facility_manager' });
    const d = await make('Resident asks', { triggerType: 'RESIDENT_REQUEST', thresholdPercent: undefined });
    expect(d.thresholdPercent).toBeNull();
    expect(await audits('helpdesk.escalation_rule.created')).toBe(4);
  });
  it('threshold: required 25..1000 for SLA triggers, null for the others (400)', async () => {
    for (const body of [
      rule('No threshold', { thresholdPercent: undefined }),
      rule('Low threshold', { thresholdPercent: 24 }),
      rule('High threshold', { thresholdPercent: 1001 }),
      rule('Csat threshold', { triggerType: 'LOW_CSAT', thresholdPercent: 50 }),
      rule('Bad level', { level: 4 }),
      rule('Zero level', { level: 0 }),
      rule('Bad trigger', { triggerType: 'ANYTHING' }),
      rule('Bad priority', { priority: 'P0' }),
      rule('Bad designation', {
        targetType: 'DESIGNATION',
        targetRoleKey: undefined,
        targetDesignation: 'PRESIDENT',
      }),
      rule('X'),
      rule('Unknown field', { extra: true }),
      rule('Status', { status: 'DELETED' }),
    ]) {
      const r = await admin('post', '/escalation-rules', body, { headers: idem() });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }
    expect(
      (
        await admin('post', '/escalation-rules', rule('Boundary 25', { thresholdPercent: 25 }), {
          headers: idem(),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await admin('post', '/escalation-rules', rule('Boundary 1000', { thresholdPercent: 1000 }), {
          headers: idem(),
        })
      ).status,
    ).toBe(201);
  });
  it('422 ESCALATION_TARGET_INVALID: field mismatch, unknown role, resident role, non-member, inactive member', async () => {
    const owner = w.people.owner!;
    for (const [label, body] of [
      ['no role key', rule('T1', { targetRoleKey: undefined })],
      ['two fields', rule('T2', { targetDesignation: 'SECRETARY' })],
      ['member without user', rule('T3', { targetType: 'MEMBER', targetRoleKey: undefined })],
      ['unknown role', rule('T4', { targetRoleKey: 'nope_role' })],
      ['resident role', rule('T5', { targetRoleKey: 'owner' })],
      [
        'not a member',
        rule('T6', { targetType: 'MEMBER', targetRoleKey: undefined, targetUserId: 99999999 }),
      ],
    ] as const) {
      const r = await admin('post', '/escalation-rules', body, { headers: idem() });
      expect([r.status, r.body.code], label).toEqual([422, 'ESCALATION_TARGET_INVALID']);
    }
    // a resident member is still an active member of the society
    expect(
      (
        await admin(
          'post',
          '/escalation-rules',
          rule('T7', { targetType: 'MEMBER', targetRoleKey: undefined, targetUserId: owner.id }),
          { headers: idem() },
        )
      ).status,
    ).toBe(201);
  });
  it('category must be an active top-level category of the society', async () => {
    const door = (await TicketCategory.findOne({ where: { societyId: w.sid, name: 'Door fault' } }))!;
    const sub = await admin('post', '/escalation-rules', rule('Sub cat', { categoryId: door.id }), {
      headers: idem(),
    });
    expect([sub.status, sub.body.code]).toEqual([422, 'CATEGORY_DEPTH_EXCEEDED']);
    const nf = await admin('post', '/escalation-rules', rule('Ghost cat', { categoryId: 99999999 }), {
      headers: idem(),
    });
    expect([nf.status, nf.body.code]).toEqual([404, 'CATEGORY_NOT_FOUND']);
    const garden = (await TicketCategory.findOne({ where: { societyId: w.sid, name: 'Garden' } }))!;
    await admin('post', `/ticket-categories/${garden.id}/archive`, { version: 1 });
    const arch = await admin('post', '/escalation-rules', rule('Archived cat', { categoryId: garden.id }), {
      headers: idem(),
    });
    expect([arch.status, arch.body.code]).toEqual([422, 'CATEGORY_ARCHIVED']);
  });
  it('403 for non-editors; replayed Idempotency-Key does not create twice', async () => {
    expect(
      (await (await w.api('treasurer'))('post', '/escalation-rules', rule('Denied'), { headers: idem() }))
        .status,
    ).toBe(403);
    const h = idem();
    const a = await admin('post', '/escalation-rules', rule('Replay'), { headers: h });
    const b = await admin('post', '/escalation-rules', rule('Replay'), { headers: h });
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await EscalationRule.count({ where: { societyId: w.sid, name: 'Replay' } })).toBe(1);
  });
  it('422 ESCALATION_RULE_LIMIT_REACHED at 30 active rules; inactive rules do not count', async () => {
    const active = await EscalationRule.count({ where: { societyId: w.sid, status: 'ACTIVE' } });
    await EscalationRule.bulkCreate(
      Array.from({ length: 30 - active }, (_, i) => ({
        societyId: w.sid,
        name: `Filler ${i}`,
        triggerType: 'LOW_CSAT',
        thresholdPercent: null,
        level: 1,
        targetType: 'ROLE',
        targetRoleKey: 'facility_manager',
      })) as never,
    );
    const r = await admin('post', '/escalation-rules', rule('Rule 31'), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([422, 'ESCALATION_RULE_LIMIT_REACHED']);
    const inactive = await admin('post', '/escalation-rules', rule('Rule 31 off', { status: 'INACTIVE' }), {
      headers: idem(),
    });
    expect(inactive.status).toBe(201);
    const turnOn = await admin('patch', `/escalation-rules/${inactive.body.data.id}`, {
      status: 'ACTIVE',
      version: 1,
    });
    expect([turnOn.status, turnOn.body.code]).toEqual([422, 'ESCALATION_RULE_LIMIT_REACHED']);
    await EscalationRule.destroy({
      where: { societyId: w.sid, name: { [Op.like]: 'Filler %' } as never },
      force: true,
    });
  });
});

describe('PATCH and DELETE /escalation-rules/:id', () => {
  it('edits with version, audits before and after, keeps trigger immutable', async () => {
    const r0 = await make('Editable');
    const r = await admin('patch', `/escalation-rules/${r0.id}`, {
      name: 'Edited',
      thresholdPercent: 120,
      level: 2,
      notifyAssignee: true,
      version: 1,
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      name: 'Edited',
      thresholdPercent: 120,
      level: 2,
      notifyAssignee: true,
      version: 2,
    });
    const log = (await AuditLog.findOne({
      where: { societyId: w.sid, action: 'helpdesk.escalation_rule.updated', entityId: String(r0.id) },
    }))!;
    expect((log.before as any).name).toBe('Editable');
    expect((log.after as any).thresholdPercent).toBe(120);
    expect(
      (await admin('patch', `/escalation-rules/${r0.id}`, { triggerType: 'LOW_CSAT', version: 2 })).status,
    ).toBe(400);
    expect((await admin('patch', `/escalation-rules/${r0.id}`, { name: 'No version' })).status).toBe(400);
    const stale = await admin('patch', `/escalation-rules/${r0.id}`, { name: 'Late', version: 1 });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const same = await admin('patch', `/escalation-rules/${r0.id}`, { level: 2, version: 2 });
    expect(same.body.data.version).toBe(2);
    const nf = await admin('patch', '/escalation-rules/99999999', { name: 'Okay name', version: 1 });
    expect([nf.status, nf.body.code]).toEqual([404, 'ESCALATION_RULE_NOT_FOUND']);
  });
  it('changing the target type swaps the target fields; the new target is validated; threshold null is refused for SLA rules', async () => {
    const r0 = await make('Retarget');
    const r = await admin('patch', `/escalation-rules/${r0.id}`, {
      targetType: 'DESIGNATION',
      targetDesignation: 'CHAIRMAN',
      version: 1,
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      targetType: 'DESIGNATION',
      targetDesignation: 'CHAIRMAN',
      targetRoleKey: null,
    });
    const bad = await admin('patch', `/escalation-rules/${r0.id}`, {
      targetType: 'ROLE',
      targetRoleKey: 'nope_role',
      version: 2,
    });
    expect([bad.status, bad.body.code]).toEqual([422, 'ESCALATION_TARGET_INVALID']);
    const noTarget = await admin('patch', `/escalation-rules/${r0.id}`, { targetType: 'MEMBER', version: 2 });
    expect([noTarget.status, noTarget.body.code]).toEqual([422, 'ESCALATION_TARGET_INVALID']);
    const nullThreshold = await admin('patch', `/escalation-rules/${r0.id}`, {
      thresholdPercent: null,
      version: 2,
    });
    expect([nullThreshold.status, nullThreshold.body.code]).toEqual([400, 'VALIDATION_FAILED']);
  });
  it('soft deletes with ?version, hides from lists, keeps the row, audits; stale and repeated deletes fail', async () => {
    const r0 = await make('Delete me');
    const stale = await admin('delete', `/escalation-rules/${r0.id}?version=7`);
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    expect((await admin('delete', `/escalation-rules/${r0.id}`)).status).toBe(400);
    const del = await admin('delete', `/escalation-rules/${r0.id}?version=1`);
    expect(del.status).toBe(200);
    expect(await audits('helpdesk.escalation_rule.deleted')).toBe(1);
    expect(
      (await admin('get', '/escalation-rules?status=ALL')).body.data.some((x: any) => x.id === r0.id),
    ).toBe(false);
    const row = await EscalationRule.findByPk(r0.id, { paranoid: false });
    expect(row!.deletedAt).not.toBeNull();
    const again = await admin('delete', `/escalation-rules/${r0.id}?version=2`);
    expect([again.status, again.body.code]).toEqual([404, 'ESCALATION_RULE_NOT_FOUND']);
    expect((await (await w.api('treasurer'))('delete', `/escalation-rules/${r0.id}?version=1`)).status).toBe(
      403,
    );
  });
  it('isolation: another society gets 404 on patch and delete and cannot target our category', async () => {
    const other = await helpdeskApiWorld('PREMIUM', ['chairman'], { reset: false });
    const oapi = await other.api('chairman');
    const mine = await make('Mine only');
    expect((await oapi('patch', `/escalation-rules/${mine.id}`, { name: 'Hijack', version: 1 })).status).toBe(
      404,
    );
    expect((await oapi('delete', `/escalation-rules/${mine.id}?version=1`)).status).toBe(404);
    const list = await oapi('get', '/escalation-rules');
    expect(list.body.data.some((x: any) => x.id === mine.id)).toBe(false);
    expect(list.body.data).toHaveLength(6);
    const cat = (await TicketCategory.findOne({
      where: { societyId: w.sid, name: 'Lift', parentId: null },
    }))!;
    expect(
      (
        await oapi('post', '/escalation-rules', rule('Cross cat', { categoryId: cat.id }), {
          headers: idem(),
        })
      ).status,
    ).toBe(404);
    expect((await EscalationRule.findByPk(mine.id))!.name).toBe('Mine only');
  });
});
