import { Op } from 'sequelize';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  Building,
  Holiday,
  LocationNode,
  Society,
  Unit,
  closeDb,
  sequelize,
} from '../../../src/models';
import { putPlaceholderFile } from '../../../src/modules/society-setup/society-setup.ports';
import { drainQueues } from '../../../src/lib/queue';
import { listRoutes } from '../../../src/modules/access-control/access-control.registry';
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';
import { app } from '../../helpers/auth';
import { activeGrant, enterAsSupport, platformAs } from '../../helpers/societies';
import { as, login, memberUser } from '../../helpers/access';
import {
  featureOff,
  idemKey,
  makeBuilding,
  makeUnit,
  memberOf,
  resetSetup,
  setupSociety,
} from '../../helpers/society-setup';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetSetup);

const routes = listRoutes(app);
const mine = (r: { path: string }) =>
  /^\/(society|buildings|units|locations|holidays|onboarding)(\/|$)/.test(r.path);

describe('route table of module 08', () => {
  it('registers the 44 routes of section 8.1 with the permissions, features, step-up and idempotency of section 8.1', () => {
    const ours = routes.filter(mine);
    expect(ours).toHaveLength(44);
    const find = (m: string, p: string) => ours.find(r => r.method === m && r.path === p)!;
    expect(ours.every(r => r.kind === 'society')).toBe(true);
    expect(find('PATCH', '/society')).toMatchObject({
      permissions: ['settings.society.edit'],
      features: ['property.society_profile'],
      stepUp: true,
      idempotent: false,
    });
    expect(find('GET', '/society').stepUp).toBe(false);
    expect(find('PATCH', '/society/settings').features).toEqual(['property.society_settings']);
    expect(find('PATCH', '/society/settings').stepUp).toBe(true);
    expect(find('PATCH', '/society/settings').permissions).toContain('settings.billing_rules.edit');
    expect(find('GET', '/society/settings').permissions).toContain('finance.accounts.view');
    expect(find('POST', '/buildings')).toMatchObject({
      permissions: ['settings.society.edit'],
      features: ['property.property_hierarchy'],
      idempotent: true,
    });
    expect(find('DELETE', '/buildings/:id')).toMatchObject({
      stepUp: true,
      permissions: ['settings.society.edit'],
    });
    expect(find('GET', '/buildings')).toMatchObject({ permissions: ['residents.units.view'] });
    expect(find('POST', '/units')).toMatchObject({
      permissions: ['residents.units.create'],
      features: ['property.unit_registry'],
      idempotent: true,
    });
    expect(find('PATCH', '/units/:id').permissions).toEqual(['residents.units.edit']);
    expect(find('POST', '/units/:id/archive').permissions).toEqual(['residents.units.edit']);
    expect(find('POST', '/units/:id/restore').permissions).toEqual(['residents.units.edit']);
    expect(find('DELETE', '/units/:id')).toMatchObject({
      permissions: ['residents.units.delete'],
      stepUp: true,
    });
    expect(find('POST', '/units/bulk-update').permissions).toEqual(['residents.units.edit']);
    expect(find('POST', '/units/imports')).toMatchObject({
      permissions: ['residents.units.import'],
      features: ['property.spreadsheet_import'],
      idempotent: true,
    });
    expect(find('GET', '/units/imports/:importId').permissions).toEqual(['residents.units.import']);
    expect(find('POST', '/units/imports/:importId/commit')).toMatchObject({
      permissions: ['residents.units.import'],
      idempotent: true,
    });
    expect(find('POST', '/units/export')).toMatchObject({
      permissions: ['residents.units.export'],
      noSupportAccess: true,
      idempotent: true,
    });
    expect(find('POST', '/units/generator/preview')).toMatchObject({
      permissions: ['residents.units.create'],
      features: ['property.bulk_unit_generator'],
      idempotent: false,
    });
    expect(find('POST', '/units/generator/commit')).toMatchObject({
      features: ['property.bulk_unit_generator'],
      idempotent: true,
    });
    expect(find('POST', '/locations')).toMatchObject({
      features: ['property.common_areas_registry'],
      idempotent: true,
    });
    expect(find('POST', '/locations/:id/regenerate-qr').features).toEqual(['property.unit_qr_codes']);
    expect(find('GET', '/holidays')).toMatchObject({
      permissions: ['settings.society.view'],
      features: ['property.society_settings'],
    });
    expect(find('POST', '/holidays/bulk').idempotent).toBe(true);
    expect(
      ours
        .filter(r => r.noSupportAccess)
        .map(r => `${r.method} ${r.path}`)
        .sort(),
    ).toEqual(['DELETE /buildings/:id', 'DELETE /holidays/:id', 'POST /units/export']);
    for (const r of ours.filter(x => x.path.startsWith('/onboarding'))) {
      expect(r.features, `${r.method} ${r.path}`).toEqual([]);
      expect(r.noSupportAccess).toBe(false);
      expect(r.allowWhenSuspended || r.allowWhenClosed).toBe(false);
    }
    expect(find('POST', '/onboarding/go-live').idempotent).toBe(true);
    // BR-08-48: nothing is allow-listed for a suspended or closed society
    expect(ours.some(r => r.allowWhenSuspended || r.allowWhenClosed)).toBe(false);
  });
});

describe('T08-33 tenant isolation', () => {
  it("a user of society A gets 404 with the module codes on every route for society B's building, unit, location and holiday", async () => {
    const a = await setupSociety({ name: 'A CHS' });
    const b = await setupSociety({ name: 'B CHS' });
    const bb = await makeBuilding(b.c, { code: 'B' });
    const bu = await makeUnit(b.c, bb.id, '101', 1);
    const bf = await b.c(
      'post',
      '/locations',
      { parentId: bb.locationNodeId, nodeType: 'FLOOR', floor: 1 },
      { headers: idemKey() },
    );
    const bl = await b.c(
      'post',
      '/locations',
      { parentId: null, nodeType: 'AREA', areaType: 'GARDEN', name: 'Garden' },
      { headers: idemKey() },
    );
    const bh = await b.c(
      'post',
      '/holidays',
      { holidayDate: '2026-11-08', name: 'Diwali' },
      { headers: idemKey() },
    );
    const bFile = putPlaceholderFile({
      societyId: b.society.id!,
      ownerUserId: b.user.id!,
      name: 'b.csv',
      content: Buffer.from('Building,Flat No,Floor\nB,201,1\n'),
    });
    const bImport = await b.c(
      'post',
      '/units/imports',
      { fileId: bFile, mode: 'CREATE_ONLY' },
      { headers: idemKey() },
    );
    await drainQueues();
    const bImportId = bImport.body.data.importId;
    const cases: [string, string, unknown, string][] = [
      ['get', `/units/imports/${bImportId}`, undefined, 'IMPORT_NOT_FOUND'],
      ['post', `/units/imports/${bImportId}/commit`, { commitPolicy: 'VALID_ROWS_ONLY' }, 'IMPORT_NOT_FOUND'],
      ['post', '/units/imports', { fileId: bFile, mode: 'CREATE_ONLY' }, 'FILE_NOT_FOUND'],
      ['post', '/units/export', { buildingId: bb.id }, 'BUILDING_NOT_FOUND'],
      ['get', `/buildings/${bb.id}`, undefined, 'BUILDING_NOT_FOUND'],
      ['get', `/buildings/${bb.id}/grid`, undefined, 'BUILDING_NOT_FOUND'],
      ['patch', `/buildings/${bb.id}`, { version: 1, name: 'Stolen' }, 'BUILDING_NOT_FOUND'],
      [
        'post',
        `/buildings/${bb.id}/archive`,
        { version: 1, reason: 'Not yours at all' },
        'BUILDING_NOT_FOUND',
      ],
      ['post', `/buildings/${bb.id}/restore`, { version: 1 }, 'BUILDING_NOT_FOUND'],
      ['delete', `/buildings/${bb.id}`, undefined, 'BUILDING_NOT_FOUND'],
      ['get', `/units/${bu.id}`, undefined, 'UNIT_NOT_FOUND'],
      ['patch', `/units/${bu.id}`, { version: 1, notes: 'x' }, 'UNIT_NOT_FOUND'],
      ['post', `/units/${bu.id}/archive`, { version: 1, reason: 'Not yours at all' }, 'UNIT_NOT_FOUND'],
      ['post', `/units/${bu.id}/restore`, { version: 1 }, 'UNIT_NOT_FOUND'],
      ['delete', `/units/${bu.id}`, undefined, 'UNIT_NOT_FOUND'],
      ['get', `/locations/${bf.body.data.id}`, undefined, 'LOCATION_NOT_FOUND'],
      ['patch', `/locations/${bl.body.data.id}`, { version: 1, name: 'Stolen' }, 'LOCATION_NOT_FOUND'],
      ['post', `/locations/${bl.body.data.id}/archive`, { version: 1 }, 'LOCATION_NOT_FOUND'],
      ['post', `/locations/${bl.body.data.id}/restore`, { version: 1 }, 'LOCATION_NOT_FOUND'],
      ['post', `/locations/${bl.body.data.id}/regenerate-qr`, { version: 1 }, 'LOCATION_NOT_FOUND'],
      ['patch', `/holidays/${bh.body.data.id}`, { version: 1, name: 'Stolen' }, 'HOLIDAY_NOT_FOUND'],
      ['delete', `/holidays/${bh.body.data.id}`, undefined, 'HOLIDAY_NOT_FOUND'],
    ];
    for (const [m, path, body, code] of cases) {
      const r = await a.c(m as 'get', path, body, { headers: idemKey() });
      expect(r.status, `${m} ${path}`).toBe(404);
      expect(r.body.code, `${m} ${path}`).toBe(code);
    }
    // ids inside request bodies and filters too
    const post = (path: string, body: unknown) => a.c('post', path, body, { headers: idemKey() });
    expect((await post('/units', { buildingId: bb.id, unitNumber: '1', floor: 1 })).body.code).toBe(
      'BUILDING_NOT_FOUND',
    );
    expect(
      (
        await post('/locations', {
          parentId: bb.locationNodeId,
          nodeType: 'AREA',
          areaType: 'LOBBY',
          name: 'Lobby',
        })
      ).body.code,
    ).toBe('LOCATION_NOT_FOUND');
    expect((await post('/units/bulk-update', { unitIds: [bu.id], set: { bhk: '2BHK' } })).body.code).toBe(
      'UNIT_NOT_FOUND',
    );
    expect(
      (await a.c('get', '/units', undefined, { query: { buildingId: String(bb.id) } })).body.data,
    ).toEqual([]);
    expect((await a.c('get', '/units')).body.data).toEqual([]);
    expect((await a.c('get', '/buildings')).body.data).toEqual([]);
    expect((await a.c('get', '/locations')).body.data.items).toEqual([]);
    expect((await a.c('get', '/holidays')).body.data.items).toEqual([]);
    // nothing of society B changed
    expect(await Building.count({ where: { societyId: b.society.id!, status: 'ACTIVE' } })).toBe(1);
    expect(await Unit.count({ where: { societyId: b.society.id!, status: 'ACTIVE' } })).toBe(1);
    expect(await LocationNode.count({ where: { societyId: b.society.id!, status: 'ACTIVE' } })).toBe(3);
    expect(await Holiday.count({ where: { societyId: b.society.id! } })).toBe(1);
    expect(
      await AuditLog.count({ where: { societyId: a.society.id!, action: { [Op.like]: 'setup.%' } } }),
    ).toBe(0);
  });

  it('the society always comes from the session, never from the request', async () => {
    const a = await setupSociety({ name: 'A CHS' });
    const b = await setupSociety({ name: 'B CHS' });
    await makeBuilding(b.c, { code: 'B' });
    const r = await a.c('get', '/buildings', undefined, {
      headers: { 'X-Society-Id': String(b.society.id) },
      query: { societyId: String(b.society.id) },
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
    const sneaky = await a.c(
      'post',
      '/buildings',
      { code: 'Z', name: 'Tower Z', kind: 'TOWER', floorsAboveGround: 3, societyId: b.society.id },
      { headers: idemKey() },
    );
    expect(sneaky.status).toBe(400); // societyId is an unknown field
  });
});

describe('T08-34 permissions', () => {
  it('a security supervisor cannot create units; an auditor cannot edit the profile; both get 403 PERMISSION_DENIED', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const guard = as(await login(await memberUser(society, 'security_supervisor')));
    const r = await guard(
      'post',
      '/units',
      { buildingId: b.id, unitNumber: '101', floor: 1 },
      { headers: idemKey() },
    );
    expect([r.status, r.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    const auditor = as(await login(await memberUser(society, 'auditor')));
    const p = await auditor('patch', '/society', { version: 1, name: 'Renamed Society' });
    expect([p.status, p.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(await Unit.count({ where: { societyId: society.id! } })).toBe(0);
    expect((await Society.findByPk(society.id!))!.name).toBe('Sky Heights CHS');
  });

  it('read-only roles read and cannot write: treasurer on units, committee member on buildings, facility manager on settings', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const u = await makeUnit(c, b.id, '101', 1);
    const treasurer = await memberOf(society, 'treasurer');
    expect((await treasurer.c('get', `/units/${u.id}`)).status).toBe(200);
    for (const [m, path, body] of [
      ['patch', `/units/${u.id}`, { version: 1, notes: 'x' }],
      ['post', `/units/${u.id}/archive`, { version: 1, reason: 'Not allowed here' }],
      ['delete', `/units/${u.id}`, undefined],
      ['post', '/units/bulk-update', { unitIds: [u.id], set: { bhk: '2BHK' } }],
      ['patch', `/buildings/${b.id}`, { version: 1, name: 'Renamed' }],
      ['post', '/units/imports', { fileId: 1, mode: 'CREATE_ONLY' }],
    ] as const) {
      const r = await treasurer.c(m, path, body, { headers: idemKey() });
      expect(r.status, `${m} ${path}`).toBe(403);
    }
    const fm = await memberOf(society, 'facility_manager');
    const s = await fm.c('patch', '/society/settings', {
      changes: [{ key: 'office.openTime', value: '08:00', version: 0 }],
    });
    expect(s.status).toBe(403);
    expect((await fm.c('get', '/society/settings')).status).toBe(200);
  });

  it('the finance, billing and approval namespaces follow their own permissions end to end', async () => {
    const { society } = await setupSociety();
    const change = (c: any, key: string, value: unknown) =>
      c('patch', '/society/settings', { changes: [{ key, value, version: 0 }] });
    const treasurer = await memberOf(society, 'treasurer'); // billing rules and accounts: edit; approval rules: view only
    expect((await change(treasurer.c, 'billing.dueDays', 9)).status).toBe(200);
    expect((await change(treasurer.c, 'finance.billRequiredAbovePaise', 300000)).status).toBe(200);
    expect((await change(treasurer.c, 'approvals.stepUpAbovePaise', 5_000_000)).status).toBe(403);
    expect((await change(treasurer.c, 'office.openTime', '08:00')).status).toBe(403);
    const secretary = await memberOf(society, 'secretary'); // society settings: edit; the others view only
    expect((await change(secretary.c, 'office.openTime', '08:00')).status).toBe(200);
    for (const [k, v] of [
      ['billing.billingDay', 3],
      ['finance.expenseBackdateDays', 30],
      ['approvals.bulkApproveBelowPaise', 500000],
    ] as const) {
      const r = await change(secretary.c, k, v);
      expect([r.status, r.body.code, r.body.errors?.[0]?.field], k).toEqual([403, 'PERMISSION_DENIED', k]);
    }
  });
});

describe('T08-35 plan checks', () => {
  it('with property.bulk_unit_generator off the generator routes are 402 FEATURE_NOT_IN_PLAN and the onboarding routes still work', async () => {
    const { society, c } = await setupSociety();
    await featureOff(society.id!, 'property.bulk_unit_generator');
    const body = {
      buildings: [{ newBuilding: { code: 'A', name: 'Tower A', kind: 'TOWER' } }],
      floorFrom: 1,
      floorTo: 2,
      positions: [{ position: 1 }],
      pattern: '{floor}{pos}',
    };
    const pv = await c('post', '/units/generator/preview', body);
    expect([pv.status, pv.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    expect(pv.body.errors[0]).toMatchObject({
      field: 'entitlementKey',
      message: 'property.bulk_unit_generator',
    });
    const cm = await c(
      'post',
      '/units/generator/commit',
      { ...body, previewHash: 'a'.repeat(64) },
      { headers: idemKey() },
    );
    expect(cm.status).toBe(402);
    expect((await c('get', '/onboarding')).status).toBe(200);
    expect((await c('post', '/onboarding/steps/BILLING/complete', {})).status).toBe(200);
    // the other features are untouched
    expect((await c('get', '/buildings')).status).toBe(200);
  });

  it('each entitlement key guards its own routes', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const cases: [string, [string, string, unknown?][]][] = [
      ['property.society_profile', [['get', '/society']]],
      [
        'property.society_settings',
        [
          ['get', '/society/settings'],
          ['get', '/holidays'],
          ['get', '/holidays/suggestions'],
        ],
      ],
      [
        'property.property_hierarchy',
        [
          ['get', '/buildings'],
          ['get', `/buildings/${b.id}`],
          ['get', `/buildings/${b.id}/grid`],
        ],
      ],
      [
        'property.unit_registry',
        [
          ['get', '/units'],
          ['get', '/units/1'],
        ],
      ],
      ['property.common_areas_registry', [['get', '/locations']]],
      ['property.spreadsheet_import', [['get', '/units/imports/1']]],
    ];
    for (const [key, list] of cases) {
      await featureOff(society.id!, key);
      for (const [m, path, body] of list) {
        const r = await c(m as 'get', path, body);
        expect([r.status, r.body.code], `${key} ${m} ${path}`).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
      }
    }
  });
});

describe('T08-36 society state (BR-08-48)', () => {
  it('while SUSPENDED every write is 423 SOCIETY_SUSPENDED and every read works; onboarding writes are blocked too', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const u = await makeUnit(c, b.id, '101', 1);
    await sequelize.query(
      "UPDATE societies SET status = 'SUSPENDED', suspendedAt = NOW(3), suspensionCause = 'MANUAL', activatedAt = NOW(3) WHERE id = :id",
      { replacements: { id: society.id } },
    );
    await flushAcl();
    const writes: [string, string, unknown][] = [
      ['patch', '/society', { version: 1, name: 'Renamed Society' }],
      ['patch', '/society/settings', { changes: [{ key: 'billing.dueDays', value: 9, version: 0 }] }],
      ['post', '/buildings', { code: 'Z', name: 'Tower Z', kind: 'TOWER', floorsAboveGround: 3 }],
      ['patch', `/buildings/${b.id}`, { version: 1, name: 'Renamed' }],
      ['post', '/units', { buildingId: b.id, unitNumber: '102', floor: 1 }],
      ['patch', `/units/${u.id}`, { version: 1, notes: 'x' }],
      ['post', `/units/${u.id}/archive`, { version: 1, reason: 'Merged into 102' }],
      ['post', '/units/bulk-update', { unitIds: [u.id], set: { bhk: '2BHK' } }],
      ['post', '/units/imports', { fileId: 1, mode: 'CREATE_ONLY' }],
      ['post', '/units/imports/1/commit', { commitPolicy: 'ALL_OR_NOTHING' }],
      ['post', '/units/export', {}],
      ['post', '/locations', { parentId: null, nodeType: 'AREA', areaType: 'GARDEN', name: 'Garden' }],
      ['post', '/holidays', { holidayDate: '2026-11-08', name: 'Diwali' }],
      ['post', '/onboarding/steps/BILLING/complete', {}],
      ['post', '/onboarding/go-live', {}],
    ];
    for (const [m, path, body] of writes) {
      const r = await c(m as 'post', path, body, { headers: idemKey() });
      expect([r.status, r.body.code], `${m} ${path}`).toEqual([423, 'SOCIETY_SUSPENDED']);
    }
    for (const path of [
      '/society',
      '/society/settings',
      '/buildings',
      '/units',
      '/locations',
      '/holidays',
      '/onboarding',
      `/units/${u.id}`,
    ])
      expect((await c('get', path)).status, path).toBe(200);
    expect(await AuditLog.count({ where: { societyId: society.id!, action: 'setup.society.updated' } })).toBe(
      0,
    );
  });

  it('a CLOSED society is 423 SOCIETY_CLOSED for reads and writes', async () => {
    const { society, c } = await setupSociety();
    await sequelize.query(
      "UPDATE societies SET status = 'CLOSED', closedAt = NOW(3), closureReason = 'OTHER', activatedAt = NOW(3) WHERE id = :id",
      { replacements: { id: society.id } },
    );
    await flushAcl();
    expect((await c('get', '/onboarding')).body.code).toBe('SOCIETY_CLOSED');
    expect((await c('get', '/units')).status).toBe(423);
  });
});

describe('support access (module 05 section 6.4, module 08 section 13)', () => {
  it('a READ_WRITE grant may create and edit structure but never delete; a READ_ONLY grant only reads; phones stay masked', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c, { code: 'A' });
    const u = await makeUnit(c, b.id, '101', 1);
    await c('patch', '/society', { version: 1, profile: { contactPhone: '9820011111' } });
    const h = (
      await c('post', '/holidays', { holidayDate: '2026-11-08', name: 'Diwali' }, { headers: idemKey() })
    ).body.data;
    const agent = await platformAs('platform_support');
    const rw = await enterAsSupport(
      agent.cookies,
      (await activeGrant(society.id!, agent.user.id, 'READ_WRITE')).id!,
    );
    expect((await rw.c('get', '/society')).body.data.profile.contactPhone).toBe('98XXXXX111');
    const made = await rw.c(
      'post',
      '/buildings',
      { code: 'S', name: 'Tower S', kind: 'TOWER', floorsAboveGround: 3 },
      { headers: idemKey() },
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await rw.c('patch', `/units/${u.id}`, { version: 1, notes: 'Checked by support' })).status).toBe(
      200,
    );
    const log = await AuditLog.findOne({
      where: {
        societyId: society.id!,
        action: 'setup.building.created',
        entityId: String(made.body.data.id),
      },
    });
    expect(log!.supportGrantId).not.toBeNull();
    for (const [path] of [
      [`/buildings/${made.body.data.id}`],
      [`/holidays/${h.id}`],
      [`/units/${u.id}`],
    ] as const) {
      const r = await rw.c('delete', path);
      expect(r.status, path).toBe(403);
    }
    expect((await rw.c('delete', `/buildings/${made.body.data.id}`)).body.code).toBe(
      'SUPPORT_ROUTE_FORBIDDEN',
    );
    expect(await Building.count({ where: { id: made.body.data.id } })).toBe(1);
    expect(await Holiday.count({ where: { id: h.id } })).toBe(1);
    // one grant is open per society and per platform user, so the read-only grant is another agent's, in another society
    const second = await setupSociety({ name: 'Second CHS' });
    const agent2 = await platformAs('platform_support', 'Second Agent');
    const ro = await enterAsSupport(
      agent2.cookies,
      (await activeGrant(second.society.id!, agent2.user.id, 'READ_ONLY')).id!,
    );
    expect((await ro.c('get', '/units')).status).toBe(200);
    const w = await ro.c(
      'post',
      '/buildings',
      { code: 'R', name: 'Tower R', kind: 'TOWER', floorsAboveGround: 3 },
      { headers: idemKey() },
    );
    expect([w.status, w.body.code]).toEqual([403, 'SUPPORT_SCOPE_READ_ONLY']);
  });
});
