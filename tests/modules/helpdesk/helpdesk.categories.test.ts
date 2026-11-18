import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog, SlaPolicy, TicketCategory, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { idem } from '../../helpers/access';
import { call } from '../../helpers/auth';
import { helpdeskApiWorld } from '../../helpers/helpdesk';
import { setHelpdeskPorts } from '../../../src/modules/helpdesk/helpdesk.ports';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});

let w: Awaited<ReturnType<typeof helpdeskApiWorld>>;
let admin: Awaited<ReturnType<typeof w.api>>;
beforeAll(async () => {
  w = await helpdeskApiWorld('PREMIUM', [
    'chairman',
    'facility_manager',
    'accountant',
    'treasurer',
    'owner',
    'guard',
    'maintenance_staff',
  ]);
  admin = await w.api('chairman');
});

const top = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  scope: 'BOTH',
  defaultPriority: 'P3',
  defaultAssigneeType: 'NONE',
  ...extra,
});
const audits = (action: string) => AuditLog.count({ where: { societyId: w.sid, action } });

describe('GET /ticket-categories (8.1)', () => {
  it('seeds on the first read and returns the tree sorted, with assignee fields', async () => {
    const r = await admin('get', '/ticket-categories');
    expect(r.status).toBe(200);
    const names = r.body.data.map((c: any) => c.name);
    expect(names).toContain('Lift');
    expect(names).toHaveLength(16);
    const lift = r.body.data.find((c: any) => c.name === 'Lift');
    expect(lift.children.map((c: any) => c.name)).toEqual([
      'Lift stopped',
      'Person stuck in lift',
      'Door fault',
      'Noise or jerks',
    ]);
    expect(lift).toMatchObject({
      scope: 'BUILDING',
      isSafety: true,
      defaultAssigneeType: 'NONE',
      status: 'ACTIVE',
    });
    expect(lift.children[0].defaultAssigneeType).toBe('INHERIT');
  });
  it('filters by scope and status; a viewer and the facility manager may read', async () => {
    const r = await admin('get', '/ticket-categories?scope=PERSONAL');
    const names = r.body.data.map((c: any) => c.name);
    expect(names).toContain('Carpentry');
    expect(names).not.toContain('Lift');
    expect(names).toContain('Plumbing');
    expect((await admin('get', '/ticket-categories?status=ARCHIVED')).body.data).toEqual([]);
    expect((await (await w.api('accountant'))('get', '/ticket-categories')).status).toBe(200);
    expect((await (await w.api('facility_manager'))('get', '/ticket-categories?status=ALL')).status).toBe(
      200,
    );
    expect((await admin('get', '/ticket-categories?status=NOPE')).status).toBe(400);
    expect((await admin('get', '/ticket-categories?extra=1')).status).toBe(400);
  });
  it('403 for a role without settings or ticket view', async () => {
    expect((await (await w.api('owner', 'RESIDENT'))('get', '/ticket-categories')).status).toBe(403);
    expect((await (await w.api('guard', 'GATE'))('get', '/ticket-categories')).status).toBe(403);
  });
});

describe('category lists of the apps', () => {
  it('/me/ticket-categories: active, scope including kind, no assignee fields, kind required', async () => {
    const res = await w.api('owner', 'RESIDENT');
    const r = await res('get', '/me/ticket-categories?kind=PERSONAL');
    expect(r.status).toBe(200);
    const names = r.body.data.map((c: any) => c.name);
    expect(names).toContain('Carpentry');
    expect(names).toContain('Plumbing');
    expect(names).not.toContain('Lift');
    expect(r.body.data[0]).not.toHaveProperty('defaultAssigneeType');
    expect(r.body.data[0]).not.toHaveProperty('defaultAssigneeUserId');
    const b = await res('get', '/me/ticket-categories?kind=BUILDING');
    expect(b.body.data.map((c: any) => c.name)).toContain('Lift');
    expect(b.body.data.map((c: any) => c.name)).not.toContain('Carpentry');
    expect((await res('get', '/me/ticket-categories')).status).toBe(400);
    expect((await res('get', '/me/ticket-categories?kind=BOTH')).status).toBe(400);
  });
  it('/gate and /work return the BUILDING categories for their audience only', async () => {
    const g = await (await w.api('guard', 'GATE'))('get', '/gate/ticket-categories');
    expect(g.status).toBe(200);
    expect(g.body.data.map((c: any) => c.name)).toContain('Lift');
    expect(g.body.data.map((c: any) => c.name)).not.toContain('Noise');
    expect(g.body.data[0]).not.toHaveProperty('defaultStaffId');
    const k = await (await w.api('maintenance_staff', 'WORK'))('get', '/work/ticket-categories');
    expect(k.status).toBe(200);
    expect(k.body.data.length).toBe(g.body.data.length);
    expect((await (await w.api('guard', 'GATE'))('get', '/work/ticket-categories')).status).toBe(403);
    expect((await (await w.api('maintenance_staff', 'WORK'))('get', '/gate/ticket-categories')).status).toBe(
      403,
    );
    expect((await (await w.api('owner', 'RESIDENT'))('get', '/gate/ticket-categories')).status).toBe(403);
  });
});

describe('POST /ticket-categories (8.2, BR-15-63)', () => {
  it('creates a top-level category and a sub-category with audit', async () => {
    const r = await admin(
      'post',
      '/ticket-categories',
      top('Roof leak', { icon: 'wrench', isSafety: true, sortOrder: 5 }),
      { headers: idem() },
    );
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      name: 'Roof leak',
      scope: 'BOTH',
      icon: 'wrench',
      version: 1,
      status: 'ACTIVE',
    });
    const sub = await admin(
      'post',
      '/ticket-categories',
      { parentId: r.body.data.id, name: 'Terrace', scope: 'BUILDING' },
      { headers: idem() },
    );
    expect(sub.status).toBe(201);
    expect(sub.body.data).toMatchObject({
      defaultAssigneeType: 'INHERIT',
      defaultPriority: null,
      parentId: r.body.data.id,
    });
    expect(await audits('helpdesk.category.created')).toBeGreaterThanOrEqual(2);
    const tree = await admin('get', '/ticket-categories');
    expect(tree.body.data.find((c: any) => c.name === 'Roof leak').children.map((c: any) => c.name)).toEqual([
      'Terrace',
    ]);
  });
  it('validation: strict body, name length, scope, priority, icon, sortOrder', async () => {
    for (const body of [
      top('A'),
      top('x'.repeat(61)),
      top('Okay one', { scope: 'ALL' }),
      top('Okay one', { defaultPriority: 'P9' }),
      top('Okay one', { icon: 'Bad Icon' }),
      top('Okay one', { sortOrder: 10000 }),
      top('Okay one', { unknown: 1 }),
      top('Okay one', { version: 1 }),
    ]) {
      const r = await admin('post', '/ticket-categories', body, { headers: idem() });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }
  });
  it('422 CATEGORY_DEFAULTS_REQUIRED without priority or assignee type, or with INHERIT on top level', async () => {
    for (const body of [
      { name: 'No priority', scope: 'BOTH', defaultAssigneeType: 'NONE' },
      { name: 'No type', scope: 'BOTH', defaultPriority: 'P3' },
      top('Inherit top', { defaultAssigneeType: 'INHERIT' }),
    ]) {
      const r = await admin('post', '/ticket-categories', body, { headers: idem() });
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.body.code).toBe('CATEGORY_DEFAULTS_REQUIRED');
    }
  });
  it('409 CATEGORY_NAME_TAKEN among active siblings (case-insensitive) but free under another parent', async () => {
    expect((await admin('post', '/ticket-categories', top('Twin'), { headers: idem() })).status).toBe(201);
    const dup = await admin('post', '/ticket-categories', top('twin'), { headers: idem() });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CATEGORY_NAME_TAKEN');
    const lift = (await TicketCategory.findOne({ where: { societyId: w.sid, name: 'Lift' } }))!;
    const sub = await admin(
      'post',
      '/ticket-categories',
      { parentId: lift.id, name: 'Twin', scope: 'BUILDING' },
      { headers: idem() },
    );
    expect(sub.status).toBe(201);
  });
  it('depth, scope and flag rules', async () => {
    const lift = (await TicketCategory.findOne({ where: { societyId: w.sid, name: 'Lift' } }))!;
    const door = (await TicketCategory.findOne({ where: { societyId: w.sid, name: 'Door fault' } }))!;
    const deep = await admin(
      'post',
      '/ticket-categories',
      { parentId: door.id, name: 'Too deep', scope: 'BUILDING' },
      { headers: idem() },
    );
    expect([deep.status, deep.body.code]).toEqual([422, 'CATEGORY_DEPTH_EXCEEDED']);
    const wide = await admin(
      'post',
      '/ticket-categories',
      { parentId: lift.id, name: 'Wide sub', scope: 'BOTH' },
      { headers: idem() },
    );
    expect([wide.status, wide.body.code]).toEqual([422, 'CATEGORY_SCOPE_MISMATCH']);
    const personal = await admin(
      'post',
      '/ticket-categories',
      { parentId: lift.id, name: 'Personal sub', scope: 'PERSONAL' },
      { headers: idem() },
    );
    expect([personal.status, personal.body.code]).toEqual([422, 'CATEGORY_SCOPE_MISMATCH']);
    for (const flag of ['isChargeable', 'linksInvoice']) {
      const r = await admin(
        'post',
        '/ticket-categories',
        top('Flagged building', { scope: 'BUILDING', [flag]: true }),
        { headers: idem() },
      );
      expect([r.status, r.body.code], flag).toEqual([422, 'CATEGORY_SCOPE_MISMATCH']);
    }
    const missing = await admin(
      'post',
      '/ticket-categories',
      { parentId: 999999, name: 'Orphan', scope: 'BUILDING' },
      { headers: idem() },
    );
    expect([missing.status, missing.body.code]).toEqual([404, 'CATEGORY_NOT_FOUND']);
  });
  it('SLA policy must be an active policy of the society', async () => {
    const r = await admin('post', '/ticket-categories', top('Bad policy', { slaPolicyId: 999999 }), {
      headers: idem(),
    });
    expect([r.status, r.body.code]).toEqual([404, 'SLA_POLICY_NOT_FOUND']);
    const p = (await SlaPolicy.findOne({ where: { societyId: w.sid, isDefault: true } }))!;
    const ok = await admin('post', '/ticket-categories', top('With policy', { slaPolicyId: p.id }), {
      headers: idem(),
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.slaPolicyId).toBe(p.id);
  });
  it('default assignee: field match, role key, member eligibility, staff and vendor', async () => {
    const fm = w.people.facility_manager!;
    const mismatch = await admin(
      'post',
      '/ticket-categories',
      top('Mismatch', { defaultAssigneeType: 'ROLE' }),
      { headers: idem() },
    );
    expect([mismatch.status, mismatch.body.code]).toEqual([422, 'DEFAULT_ASSIGNEE_INVALID']);
    const extra = await admin(
      'post',
      '/ticket-categories',
      top('Extra', { defaultAssigneeType: 'NONE', defaultRoleKey: 'guard' }),
      { headers: idem() },
    );
    expect([extra.status, extra.body.code]).toEqual([422, 'DEFAULT_ASSIGNEE_INVALID']);
    const badRole = await admin(
      'post',
      '/ticket-categories',
      top('Bad role', { defaultAssigneeType: 'ROLE', defaultRoleKey: 'no_such_role' }),
      { headers: idem() },
    );
    expect([badRole.status, badRole.body.code]).toEqual([422, 'DEFAULT_ASSIGNEE_INVALID']);
    const residentRole = await admin(
      'post',
      '/ticket-categories',
      top('Resident role', { defaultAssigneeType: 'ROLE', defaultRoleKey: 'owner' }),
      { headers: idem() },
    );
    expect([residentRole.status, residentRole.body.code]).toEqual([422, 'DEFAULT_ASSIGNEE_INVALID']);
    const role = await admin(
      'post',
      '/ticket-categories',
      top('Role ok', { defaultAssigneeType: 'ROLE', defaultRoleKey: 'facility_manager' }),
      { headers: idem() },
    );
    expect(role.status).toBe(201);
    expect(role.body.data).toMatchObject({ defaultAssigneeType: 'ROLE', defaultRoleKey: 'facility_manager' });
    const member = await admin(
      'post',
      '/ticket-categories',
      top('Member ok', { defaultAssigneeType: 'MEMBER', defaultAssigneeUserId: fm.id }),
      { headers: idem() },
    );
    expect(member.status).toBe(201);
    const unknown = await admin(
      'post',
      '/ticket-categories',
      top('Member none', { defaultAssigneeType: 'MEMBER', defaultAssigneeUserId: 99999999 }),
      { headers: idem() },
    );
    expect([unknown.status, unknown.body.code]).toEqual([404, 'ASSIGNEE_NOT_FOUND']);
    const resident = await admin(
      'post',
      '/ticket-categories',
      top('Member res', { defaultAssigneeType: 'MEMBER', defaultAssigneeUserId: w.people.owner!.id }),
      { headers: idem() },
    );
    expect([resident.status, resident.body.code]).toEqual([422, 'DEFAULT_ASSIGNEE_INVALID']);
    const staffNone = await admin(
      'post',
      '/ticket-categories',
      top('Staff none', { defaultAssigneeType: 'STAFF', defaultStaffId: 5 }),
      { headers: idem() },
    );
    expect([staffNone.status, staffNone.body.code]).toEqual([404, 'ASSIGNEE_NOT_FOUND']);
    setHelpdeskPorts({
      staffDirectory: {
        getSummary: async (_s: number, id: number) => ({ id, userId: null, name: 'Raju', status: 'ACTIVE' }),
      } as never,
      vendors: { getAssignable: async (_s: number, id: number) => ({ id, name: 'Otis' }) } as never,
    });
    try {
      const staff = await admin(
        'post',
        '/ticket-categories',
        top('Staff ok', { defaultAssigneeType: 'STAFF', defaultStaffId: 5 }),
        { headers: idem() },
      );
      expect(staff.status).toBe(201);
      expect(staff.body.data.defaultStaffId).toBe(5);
      const vendor = await admin(
        'post',
        '/ticket-categories',
        top('Vendor ok', { defaultAssigneeType: 'VENDOR', defaultVendorId: 7 }),
        { headers: idem() },
      );
      expect(vendor.status).toBe(201);
    } finally {
      setHelpdeskPorts();
    }
  });
  it('replaying the same Idempotency-Key returns the same category; a changed body is refused', async () => {
    const h = idem();
    const a = await admin('post', '/ticket-categories', top('Idem cat'), { headers: h });
    const b = await admin('post', '/ticket-categories', top('Idem cat'), { headers: h });
    expect(b.body.data.id).toBe(a.body.data.id);
    const c = await admin('post', '/ticket-categories', top('Idem cat other'), { headers: h });
    expect(c.status).toBe(409);
    expect(c.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
  it('422 CATEGORY_LIMIT_REACHED at 30 sub-categories of a parent', async () => {
    const p = await admin('post', '/ticket-categories', top('Many subs'), { headers: idem() });
    await TicketCategory.bulkCreate(
      Array.from({ length: 30 }, (_, i) => ({
        societyId: w.sid,
        parentId: p.body.data.id,
        name: `Sub ${i}`,
        scope: 'BOTH' as const,
        defaultAssigneeType: 'INHERIT' as const,
        sortOrder: i,
      })) as never,
    );
    const r = await admin(
      'post',
      '/ticket-categories',
      { parentId: p.body.data.id, name: 'Sub 31', scope: 'BOTH' },
      { headers: idem() },
    );
    expect([r.status, r.body.code]).toEqual([422, 'CATEGORY_LIMIT_REACHED']);
  });
});

describe('permissions, plan and isolation', () => {
  it('writes need helpdesk.settings.edit: accountant, treasurer, facility manager read-only roles', async () => {
    for (const role of ['accountant', 'treasurer']) {
      const api = await w.api(role);
      expect((await api('post', '/ticket-categories', top('Denied'), { headers: idem() })).status, role).toBe(
        403,
      );
      expect((await api('patch', '/ticket-categories/1', { name: 'Denied', version: 1 })).status, role).toBe(
        403,
      );
      expect((await api('post', '/ticket-categories/1/archive', { version: 1 })).status, role).toBe(403);
      expect((await api('post', '/ticket-categories/1/restore', { version: 1 })).status, role).toBe(403);
    }
    const fm = await (
      await w.api('facility_manager')
    )('post', '/ticket-categories', top('FM cat'), { headers: idem() });
    expect(fm.status).toBe(201);
  });
  it('401 without a session', async () => {
    expect((await call('get', '/ticket-categories', undefined, {})).status).toBe(401);
  });
  it('another society cannot see or change these categories (404)', async () => {
    const other = await helpdeskApiWorld('PREMIUM', ['chairman'], { reset: false });
    const oadmin = await other.api('chairman');
    const lift = (await TicketCategory.findOne({ where: { societyId: w.sid, name: 'Lift' } }))!;
    expect(
      (await oadmin('patch', `/ticket-categories/${lift.id}`, { name: 'Hacked', version: 1 })).status,
    ).toBe(404);
    expect((await oadmin('post', `/ticket-categories/${lift.id}/archive`, { version: 1 })).status).toBe(404);
    expect((await oadmin('post', `/ticket-categories/${lift.id}/restore`, { version: 1 })).status).toBe(404);
    const list = await oadmin('get', '/ticket-categories');
    expect(list.body.data.some((c: any) => c.id === lift.id)).toBe(false);
    expect(
      (
        await oadmin(
          'post',
          '/ticket-categories',
          { parentId: lift.id, name: 'Cross', scope: 'BUILDING' },
          { headers: idem() },
        )
      ).status,
    ).toBe(404);
    expect((await TicketCategory.findByPk(lift.id))!.name).toBe('Lift');
    // the other society is seeded on its own
    expect(list.body.data).toHaveLength(16);
    const mine = await admin('get', '/ticket-categories');
    expect(mine.body.data.some((c: any) => c.id === list.body.data[0].id)).toBe(false);
  });
  it('Starter keeps the catalogue (always included) but refuses STAFF and VENDOR defaults with 402', async () => {
    const s = await helpdeskApiWorld('STARTER', ['chairman'], { reset: false });
    const api = await s.api('chairman');
    expect((await api('get', '/ticket-categories')).status).toBe(200);
    expect((await api('post', '/ticket-categories', top('Starter cat'), { headers: idem() })).status).toBe(
      201,
    );
    for (const [type, field] of [
      ['STAFF', 'defaultStaffId'],
      ['VENDOR', 'defaultVendorId'],
    ] as const) {
      const r = await api(
        'post',
        '/ticket-categories',
        top(`Starter ${type}`, { defaultAssigneeType: type, [field]: 3 }),
        { headers: idem() },
      );
      expect([r.status, r.body.code], type).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    }
  });
});

describe('PATCH, archive and restore (8.2, 8.3)', () => {
  const make = async (name: string, extra: Record<string, unknown> = {}) =>
    (await admin('post', '/ticket-categories', top(name, extra), { headers: idem() })).body.data;

  it('edits with the version, bumps it and audits; stale version is 409; same values change nothing', async () => {
    const c = await make('Patch me');
    const before = await audits('helpdesk.category.updated');
    const r = await admin('patch', `/ticket-categories/${c.id}`, {
      name: 'Patched',
      defaultPriority: 'P2',
      isSafety: true,
      version: 1,
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ name: 'Patched', defaultPriority: 'P2', isSafety: true, version: 2 });
    expect(await audits('helpdesk.category.updated')).toBe(before + 1);
    const log = (await AuditLog.findOne({
      where: { societyId: w.sid, action: 'helpdesk.category.updated', entityId: String(c.id) },
    }))!;
    expect((log.before as any).name).toBe('Patch me');
    expect((log.after as any).name).toBe('Patched');
    const st = await admin('patch', `/ticket-categories/${c.id}`, { name: 'Again', version: 1 });
    expect([st.status, st.body.code]).toEqual([409, 'STALE_VERSION']);
    const same = await admin('patch', `/ticket-categories/${c.id}`, { name: 'Patched', version: 2 });
    expect(same.status).toBe(200);
    expect(same.body.data.version).toBe(2);
    expect(await audits('helpdesk.category.updated')).toBe(before + 1);
  });
  it('validation: version required, parentId immutable, unknown id', async () => {
    const c = await make('Strict patch');
    expect((await admin('patch', `/ticket-categories/${c.id}`, { name: 'No version' })).status).toBe(400);
    expect((await admin('patch', `/ticket-categories/${c.id}`, { parentId: 1, version: 1 })).status).toBe(
      400,
    );
    expect((await admin('patch', '/ticket-categories/abc', { name: 'Okay', version: 1 })).status).toBe(400);
    expect((await admin('patch', '/ticket-categories/0', { name: 'Okay', version: 1 })).status).toBe(400);
    const nf = await admin('patch', '/ticket-categories/99999999', { name: 'Okay', version: 1 });
    expect([nf.status, nf.body.code]).toEqual([404, 'CATEGORY_NOT_FOUND']);
  });
  it('rename to a taken sibling name is 409; defaults and scope rules apply to the merged state', async () => {
    const a = await make('Name A');
    await make('Name B');
    const r = await admin('patch', `/ticket-categories/${a.id}`, { name: 'name b', version: 1 });
    expect([r.status, r.body.code]).toEqual([409, 'CATEGORY_NAME_TAKEN']);
    const nullPrio = await admin('patch', `/ticket-categories/${a.id}`, {
      defaultPriority: null,
      version: 1,
    });
    expect([nullPrio.status, nullPrio.body.code]).toEqual([422, 'CATEGORY_DEFAULTS_REQUIRED']);
    const flagged = await admin('patch', `/ticket-categories/${a.id}`, {
      scope: 'BUILDING',
      isChargeable: true,
      version: 1,
    });
    expect([flagged.status, flagged.body.code]).toEqual([422, 'CATEGORY_SCOPE_MISMATCH']);
    const narrow = await make('Narrow parent');
    await admin(
      'post',
      '/ticket-categories',
      { parentId: narrow.id, name: 'Both child', scope: 'BOTH' },
      { headers: idem() },
    );
    const shrink = await admin('patch', `/ticket-categories/${narrow.id}`, { scope: 'BUILDING', version: 1 });
    expect([shrink.status, shrink.body.code]).toEqual([422, 'CATEGORY_SCOPE_MISMATCH']);
  });
  it('changing the assignee type resets the other assignee fields', async () => {
    const fm = w.people.facility_manager!;
    const c = await make('Switch type', { defaultAssigneeType: 'MEMBER', defaultAssigneeUserId: fm.id });
    const r = await admin('patch', `/ticket-categories/${c.id}`, {
      defaultAssigneeType: 'ROLE',
      defaultRoleKey: 'facility_manager',
      version: 1,
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      defaultAssigneeType: 'ROLE',
      defaultRoleKey: 'facility_manager',
      defaultAssigneeUserId: null,
    });
    const none = await admin('patch', `/ticket-categories/${c.id}`, {
      defaultAssigneeType: 'NONE',
      version: 2,
    });
    expect(none.body.data).toMatchObject({ defaultAssigneeType: 'NONE', defaultRoleKey: null });
  });
  it('archive takes the sub-categories with it; PATCH of an archived category is 422; double archive 409', async () => {
    const p = await make('Archive parent');
    const s1 = (
      await admin(
        'post',
        '/ticket-categories',
        { parentId: p.id, name: 'Kid 1', scope: 'BOTH' },
        { headers: idem() },
      )
    ).body.data;
    await admin(
      'post',
      '/ticket-categories',
      { parentId: p.id, name: 'Kid 2', scope: 'BOTH' },
      { headers: idem() },
    );
    expect((await admin('post', `/ticket-categories/${p.id}/archive`, { version: 9 })).body.code).toBe(
      'STALE_VERSION',
    );
    const r = await admin('post', `/ticket-categories/${p.id}/archive`, { version: 1 });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'ARCHIVED', version: 2 });
    const kids = await TicketCategory.findAll({ where: { parentId: p.id } });
    expect(kids.map(k => [k.status, k.version, k.archivedAt !== null])).toEqual([
      ['ARCHIVED', 2, true],
      ['ARCHIVED', 2, true],
    ]);
    expect(await audits('helpdesk.category.archived')).toBeGreaterThanOrEqual(1);
    const patch = await admin('patch', `/ticket-categories/${p.id}`, { name: 'Renamed', version: 2 });
    expect([patch.status, patch.body.code]).toEqual([422, 'CATEGORY_ARCHIVED']);
    const again = await admin('post', `/ticket-categories/${p.id}/archive`, { version: 2 });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
    const act = await admin('get', '/ticket-categories');
    expect(act.body.data.some((c: any) => c.id === p.id)).toBe(false);
    const arch = await admin('get', '/ticket-categories?status=ARCHIVED');
    expect(arch.body.data.find((c: any) => c.id === p.id).children).toHaveLength(2);
    const res = await (await w.api('owner', 'RESIDENT'))('get', '/me/ticket-categories?kind=PERSONAL');
    expect(res.body.data.some((c: any) => c.id === p.id)).toBe(false);
    // a sub-category of an archived parent cannot be restored first
    const sub = await admin('post', `/ticket-categories/${s1.id}/restore`, { version: 2 });
    expect([sub.status, sub.body.code]).toEqual([422, 'CATEGORY_ARCHIVED']);
  });
  it('restore: parent first, then a sub-category; active category 409; name clash 409; the archived name can be reused meanwhile', async () => {
    const p = await make('Restore parent');
    const s1 = (
      await admin(
        'post',
        '/ticket-categories',
        { parentId: p.id, name: 'Rkid', scope: 'BOTH' },
        { headers: idem() },
      )
    ).body.data;
    expect((await admin('post', `/ticket-categories/${p.id}/restore`, { version: 1 })).body.code).toBe(
      'INVALID_STATE',
    );
    await admin('post', `/ticket-categories/${p.id}/archive`, { version: 1 });
    const reuse = await admin('post', '/ticket-categories', top('Restore parent'), { headers: idem() });
    expect(reuse.status).toBe(201);
    const clash = await admin('post', `/ticket-categories/${p.id}/restore`, { version: 2 });
    expect([clash.status, clash.body.code]).toEqual([409, 'CATEGORY_NAME_TAKEN']);
    await admin('post', `/ticket-categories/${reuse.body.data.id}/archive`, { version: 1 });
    const ok = await admin('post', `/ticket-categories/${p.id}/restore`, { version: 2 });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'ACTIVE', version: 3 });
    expect((await TicketCategory.findByPk(p.id))!.archivedAt).toBeNull();
    const kid = await admin('post', `/ticket-categories/${s1.id}/restore`, { version: 2 });
    expect(kid.status).toBe(200);
    expect(await audits('helpdesk.category.restored')).toBeGreaterThanOrEqual(2);
  });
});
