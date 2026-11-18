import { Op } from 'sequelize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog, SlaPolicy, TicketCategory, closeDb } from '../../../src/models';
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
  w = await helpdeskApiWorld('PREMIUM', ['chairman', 'facility_manager', 'accountant', 'treasurer']);
  admin = await w.api('chairman');
});

const targets = (o: Record<string, unknown> = {}) => ({
  p1ResponseMinutes: 15,
  p1ResolutionMinutes: 120,
  p2ResponseMinutes: 60,
  p2ResolutionMinutes: 480,
  p3ResponseMinutes: 240,
  p3ResolutionMinutes: 1440,
  p4ResponseMinutes: 480,
  p4ResolutionMinutes: 4320,
  ...o,
});
const policy = (name: string, o: Record<string, unknown> = {}) => ({ name, ...targets(), ...o });
const audits = (action: string) => AuditLog.count({ where: { societyId: w.sid, action } });
const defaults = () => SlaPolicy.findAll({ where: { societyId: w.sid, isDefault: true, status: 'ACTIVE' } });

describe('GET /sla-policies (8.4)', () => {
  it('seeds the Standard default; status filters; viewer roles read; others 403', async () => {
    const r = await admin('get', '/sla-policies');
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.data[0]).toMatchObject({
      name: 'Standard',
      isDefault: true,
      p1ResponseMinutes: 30,
      p1ResolutionMinutes: 240,
      p1Calendar: 'TWENTY_FOUR_SEVEN',
      p4ResolutionMinutes: 10080,
      status: 'ACTIVE',
      version: 1,
    });
    expect((await admin('get', '/sla-policies?status=ARCHIVED')).body.data).toEqual([]);
    expect((await admin('get', '/sla-policies?status=ALL')).body.data).toHaveLength(1);
    expect((await admin('get', '/sla-policies?status=X')).status).toBe(400);
    expect((await (await w.api('facility_manager'))('get', '/sla-policies')).status).toBe(200);
    // settings.view is not held by the accountant or the treasurer
    expect((await (await w.api('accountant'))('get', '/sla-policies')).status).toBe(403);
    expect((await (await w.api('treasurer'))('get', '/sla-policies')).status).toBe(403);
  });
});

describe('POST /sla-policies (BR-15-62)', () => {
  it('creates a policy, audits it and leaves the default alone', async () => {
    const r = await admin('post', '/sla-policies', policy('Premium care', { description: 'Fast' }), {
      headers: idem(),
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      name: 'Premium care',
      isDefault: false,
      p1Calendar: 'TWENTY_FOUR_SEVEN',
      p2Calendar: 'TWENTY_FOUR_SEVEN',
      version: 1,
    });
    expect(await audits('helpdesk.sla_policy.created')).toBe(1);
    expect((await defaults()).map(p => p.name)).toEqual(['Standard']);
  });
  it('isDefault true moves the default in the same transaction (one default, two audit rows)', async () => {
    const r = await admin('post', '/sla-policies', policy('New default', { isDefault: true }), {
      headers: idem(),
    });
    expect(r.status).toBe(201);
    expect((await defaults()).map(p => p.name)).toEqual(['New default']);
    expect(await audits('helpdesk.sla_policy.default_changed')).toBe(1);
    const std = (await SlaPolicy.findOne({ where: { societyId: w.sid, name: 'Standard' } }))!;
    expect(std.isDefault).toBe(false);
    expect(std.version).toBe(2);
    // back to Standard
    const back = await admin('patch', `/sla-policies/${std.id}`, { isDefault: true, version: 2 });
    expect(back.status).toBe(200);
    expect(back.body.data.isDefault).toBe(true);
    expect((await defaults()).map(p => p.name)).toEqual(['Standard']);
    expect(await audits('helpdesk.sla_policy.default_changed')).toBe(2);
  });
  it('422 SLA_TARGETS_INVALID names every failing field (T15-28)', async () => {
    const r = await admin(
      'post',
      '/sla-policies',
      policy('Broken', {
        p1ResponseMinutes: 0,
        p2ResponseMinutes: 4,
        p3ResolutionMinutes: 129601,
        p4ResponseMinutes: 5000,
        p4ResolutionMinutes: 5000,
      }),
      { headers: idem() },
    );
    expect([r.status, r.body.code]).toEqual([422, 'SLA_TARGETS_INVALID']);
    const fields = r.body.errors.map((e: any) => e.field);
    expect(fields).toEqual(
      expect.arrayContaining([
        'p1ResponseMinutes',
        'p2ResponseMinutes',
        'p3ResolutionMinutes',
        'p4ResolutionMinutes',
      ]),
    );
    const equal = await admin(
      'post',
      '/sla-policies',
      policy('Equal', { p1ResponseMinutes: 30, p1ResolutionMinutes: 30 }),
      { headers: idem() },
    );
    expect(equal.body.code).toBe('SLA_TARGETS_INVALID');
    const edge = await admin(
      'post',
      '/sla-policies',
      policy('Edge ok', { p1ResponseMinutes: 5, p1ResolutionMinutes: 129600 }),
      { headers: idem() },
    );
    expect(edge.status).toBe(201);
  });
  it('400 for missing targets, wrong types, unknown fields, p1Calendar, bad name', async () => {
    const { p4ResolutionMinutes: _omit, ...partial } = targets();
    for (const body of [
      { name: 'No p4 resolution', ...partial },
      policy('Float', { p1ResponseMinutes: 10.5 }),
      policy('Str', { p1ResponseMinutes: '10' }),
      policy('Unknown', { colour: 'red' }),
      policy('Cal', { p1Calendar: 'TWENTY_FOUR_SEVEN' }),
      policy('Cal2', { p2Calendar: 'WEEKENDS' }),
      policy('X'),
      policy('Long desc', { description: 'x'.repeat(301) }),
    ]) {
      const r = await admin('post', '/sla-policies', body, { headers: idem() });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }
  });
  it('409 SLA_POLICY_NAME_TAKEN among active policies only', async () => {
    const a = await admin('post', '/sla-policies', policy('Dup name'), { headers: idem() });
    const dup = await admin('post', '/sla-policies', policy('dup name'), { headers: idem() });
    expect([dup.status, dup.body.code]).toEqual([409, 'SLA_POLICY_NAME_TAKEN']);
    await admin('post', `/sla-policies/${a.body.data.id}/archive`, { version: 1 });
    expect((await admin('post', '/sla-policies', policy('Dup name'), { headers: idem() })).status).toBe(201);
  });
  it('BUSINESS_HOURS needs the Standard calendar entitlement: Starter 402, Standard 201', async () => {
    const starter = await helpdeskApiWorld('STARTER', ['chairman'], { reset: false });
    const sapi = await starter.api('chairman');
    const no = await sapi('post', '/sla-policies', policy('Office hours', { p3Calendar: 'BUSINESS_HOURS' }), {
      headers: idem(),
    });
    expect([no.status, no.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    expect((await sapi('post', '/sla-policies', policy('Round the clock'), { headers: idem() })).status).toBe(
      201,
    );
    const yes = await admin(
      'post',
      '/sla-policies',
      policy('Office hours', { p2Calendar: 'BUSINESS_HOURS', p3Calendar: 'BUSINESS_HOURS' }),
      { headers: idem() },
    );
    expect(yes.status).toBe(201);
    expect(yes.body.data).toMatchObject({
      p2Calendar: 'BUSINESS_HOURS',
      p3Calendar: 'BUSINESS_HOURS',
      p4Calendar: 'TWENTY_FOUR_SEVEN',
    });
  });
  it('403 for non-editors and 422 SLA_POLICY_LIMIT_REACHED at 20 active policies', async () => {
    for (const role of ['accountant', 'treasurer']) {
      expect(
        (await (await w.api(role))('post', '/sla-policies', policy('Denied'), { headers: idem() })).status,
        role,
      ).toBe(403);
    }
    const active = await SlaPolicy.count({ where: { societyId: w.sid, status: 'ACTIVE' } });
    await SlaPolicy.bulkCreate(
      Array.from({ length: 20 - active }, (_, i) => ({
        societyId: w.sid,
        name: `Filler ${i}`,
        isDefault: false,
      })) as never,
    );
    const r = await admin('post', '/sla-policies', policy('One too many'), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([422, 'SLA_POLICY_LIMIT_REACHED']);
    await SlaPolicy.destroy({ where: { societyId: w.sid, name: { [Op.like]: 'Filler %' } as never } });
  });
});

describe('PATCH /sla-policies/:id', () => {
  const make = async (name: string, o: Record<string, unknown> = {}) =>
    (await admin('post', '/sla-policies', policy(name, o), { headers: idem() })).body.data;

  it('edits with version, validates merged targets, audits, no-op changes nothing', async () => {
    const p = await make('Edit me');
    const r = await admin('patch', `/sla-policies/${p.id}`, {
      p1ResponseMinutes: 10,
      description: null,
      version: 1,
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ p1ResponseMinutes: 10, version: 2 });
    const log = (await AuditLog.findOne({
      where: { societyId: w.sid, action: 'helpdesk.sla_policy.updated', entityId: String(p.id) },
    }))!;
    expect((log.before as any).p1ResponseMinutes).toBe(15);
    expect((log.after as any).p1ResponseMinutes).toBe(10);
    const stale = await admin('patch', `/sla-policies/${p.id}`, { name: 'Late', version: 1 });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const bad = await admin('patch', `/sla-policies/${p.id}`, { p1ResponseMinutes: 200, version: 2 });
    expect([bad.status, bad.body.code]).toEqual([422, 'SLA_TARGETS_INVALID']);
    const same = await admin('patch', `/sla-policies/${p.id}`, { p1ResponseMinutes: 10, version: 2 });
    expect(same.body.data.version).toBe(2);
    expect((await admin('patch', `/sla-policies/${p.id}`, { name: 'Okay name' })).status).toBe(400);
    expect(
      (await admin('patch', `/sla-policies/${p.id}`, { p1Calendar: 'TWENTY_FOUR_SEVEN', version: 2 })).status,
    ).toBe(400);
    expect(
      (await admin('patch', '/sla-policies/99999999', { name: 'Okay name', version: 1 })).body.code,
    ).toBe('SLA_POLICY_NOT_FOUND');
  });
  it('rename to a taken name is 409; un-defaulting the default is 422 DEFAULT_POLICY_REQUIRED', async () => {
    const a = await make('Name one');
    await make('Name two');
    const r = await admin('patch', `/sla-policies/${a.id}`, { name: 'NAME TWO', version: 1 });
    expect([r.status, r.body.code]).toEqual([409, 'SLA_POLICY_NAME_TAKEN']);
    const def = (await defaults())[0]!;
    const un = await admin('patch', `/sla-policies/${def.id}`, { isDefault: false, version: def.version });
    expect([un.status, un.body.code]).toEqual([422, 'DEFAULT_POLICY_REQUIRED']);
    expect((await defaults()).length).toBe(1);
  });
  it('BUSINESS_HOURS on Starter is 402; an archived policy cannot be edited', async () => {
    const starter = await helpdeskApiWorld('STARTER', ['chairman'], { reset: false });
    const sapi = await starter.api('chairman');
    const p = (await sapi('post', '/sla-policies', policy('S policy'), { headers: idem() })).body.data;
    const r = await sapi('patch', `/sla-policies/${p.id}`, { p4Calendar: 'BUSINESS_HOURS', version: 1 });
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    const q = await make('Archived edit');
    await admin('post', `/sla-policies/${q.id}/archive`, { version: 1 });
    const e = await admin('patch', `/sla-policies/${q.id}`, { name: 'Renamed', version: 2 });
    expect([e.status, e.body.code]).toEqual([409, 'INVALID_STATE']);
  });
});

describe('POST /sla-policies/:id/archive', () => {
  it('archives an unused non-default policy; default, in-use, repeated and stale are refused', async () => {
    const p = (await admin('post', '/sla-policies', policy('To archive'), { headers: idem() })).body.data;
    const stale = await admin('post', `/sla-policies/${p.id}/archive`, { version: 5 });
    expect(stale.body.code).toBe('STALE_VERSION');
    const def = (await defaults())[0]!;
    const d = await admin('post', `/sla-policies/${def.id}/archive`, { version: def.version });
    expect([d.status, d.body.code]).toEqual([422, 'DEFAULT_POLICY_REQUIRED']);
    const cat = (
      await admin(
        'post',
        '/ticket-categories',
        {
          name: 'Uses policy',
          scope: 'BOTH',
          defaultPriority: 'P3',
          defaultAssigneeType: 'NONE',
          slaPolicyId: p.id,
        },
        { headers: idem() },
      )
    ).body.data;
    const used = await admin('post', `/sla-policies/${p.id}/archive`, { version: 1 });
    expect([used.status, used.body.code]).toEqual([409, 'SLA_POLICY_IN_USE']);
    await admin('post', `/ticket-categories/${cat.id}/archive`, { version: 1 });
    const ok = await admin('post', `/sla-policies/${p.id}/archive`, { version: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'ARCHIVED', version: 2 });
    expect(await audits('helpdesk.sla_policy.archived')).toBeGreaterThanOrEqual(1);
    const again = await admin('post', `/sla-policies/${p.id}/archive`, { version: 2 });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
    expect((await admin('get', '/sla-policies?status=ARCHIVED')).body.data.map((x: any) => x.id)).toContain(
      p.id,
    );
    // restoring the category whose policy was archived falls back to the society default
    const restored = await admin('post', `/ticket-categories/${cat.id}/restore`, { version: 2 });
    expect(restored.status).toBe(200);
    expect(restored.body.data.slaPolicyId).toBeNull();
    expect((await TicketCategory.findByPk(cat.id))!.slaPolicyId).toBeNull();
    expect(
      (await (await w.api('treasurer'))('post', `/sla-policies/${def.id}/archive`, { version: 1 })).status,
    ).toBe(403);
  });
  it('isolation: another society sees 404 and its own list only', async () => {
    const other = await helpdeskApiWorld('PREMIUM', ['chairman'], { reset: false });
    const oapi = await other.api('chairman');
    const mine = (await SlaPolicy.findOne({ where: { societyId: w.sid, name: 'Edge ok' } }))!;
    expect(
      (await oapi('patch', `/sla-policies/${mine.id}`, { name: 'Stolen name', version: 1 })).status,
    ).toBe(404);
    expect((await oapi('post', `/sla-policies/${mine.id}/archive`, { version: 1 })).status).toBe(404);
    const list = await oapi('get', '/sla-policies');
    expect(list.body.data.map((p: any) => p.name)).toEqual(['Standard']);
    const cat = await oapi(
      'post',
      '/ticket-categories',
      {
        name: 'Cross policy',
        scope: 'BOTH',
        defaultPriority: 'P3',
        defaultAssigneeType: 'NONE',
        slaPolicyId: mine.id,
      },
      { headers: idem() },
    );
    expect([cat.status, cat.body.code]).toEqual([404, 'SLA_POLICY_NOT_FOUND']);
  });
});
