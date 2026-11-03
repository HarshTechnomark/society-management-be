import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Building, LocationNode, Unit, closeDb, sequelize } from '../../../src/models';
import { advance } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { as, login, resetLogins } from '../../helpers/access';
import {
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

const audits = (societyId: number, action: string) =>
  AuditLog.findAll({ where: { societyId, action }, order: [['id', 'ASC']] });
const create = (c: any, body: Record<string, unknown>) =>
  c('post', '/buildings', body, { headers: idemKey() });
const patch = (c: any, id: number, body: Record<string, unknown>) => c('patch', `/buildings/${id}`, body);
const archive = (c: any, id: number, version: number, reason = 'Tower closed for rebuilding') =>
  c('post', `/buildings/${id}/archive`, { version, reason });
const restore = (c: any, id: number, version: number) => c('post', `/buildings/${id}/restore`, { version });
const base = {
  code: 'A',
  name: 'Tower A',
  kind: 'TOWER',
  floorsAboveGround: 20,
  basements: 1,
  liftCount: 2,
  sortOrder: 1,
};

describe('POST /buildings (8.7)', () => {
  it('creates a building with its BUILDING location node and an audit row', async () => {
    const { society, c } = await setupSociety();
    const r = await create(c, base);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      code: 'A',
      name: 'Tower A',
      kind: 'TOWER',
      parentBuildingId: null,
      floorsAboveGround: 20,
      basements: 1,
      liftCount: 2,
      sortOrder: 1,
      status: 'ACTIVE',
      floorLabels: { min: 'B1', max: '20' },
      unitCounts: { active: 0, archived: 0, countable: 0 },
      wings: [],
      version: 1,
    });
    const node = (await LocationNode.findOne({
      where: { societyId: society.id!, buildingId: r.body.data.id },
    }))!;
    expect(r.body.data.locationNodeId).toBe(node.id);
    expect(node).toMatchObject({
      nodeType: 'BUILDING',
      name: 'Tower A',
      parentId: null,
      depth: 1,
      status: 'ACTIVE',
      path: `/${node.id}/`,
    });
    expect(node.qrToken).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(await audits(society.id!, 'setup.building.created')).toHaveLength(1);
  });

  it('requires an Idempotency-Key and replays the first response', async () => {
    const { c } = await setupSociety();
    expect((await c('post', '/buildings', base)).status).toBe(400);
    const headers = idemKey();
    const a = await c('post', '/buildings', base, { headers });
    const b = await c('post', '/buildings', base, { headers });
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await Building.count()).toBe(1);
  });

  it('BR-08-15 upper-cases the code, never reuses it (even archived), per society', async () => {
    const { society, c } = await setupSociety();
    const a = await create(c, { ...base, code: 'a' });
    expect(a.body.data.code).toBe('A');
    const dup = await create(c, { ...base, code: 'A', name: 'Another' });
    expect([dup.status, dup.body.code]).toEqual([409, 'BUILDING_CODE_TAKEN']);
    await archive(c, a.body.data.id, 1);
    expect((await create(c, { ...base, code: 'A', name: 'Another' })).body.code).toBe('BUILDING_CODE_TAKEN');
    // another society may use the same code
    const other = await setupSociety({ name: 'Other CHS' });
    expect((await create(other.c, base)).status).toBe(201);
    expect(society.id).toBeTruthy();
    const bad = await create(c, { ...base, code: 'TOOLONG7' });
    expect(bad.body.code).toBe('VALIDATION_FAILED');
  });

  it('BR-08-16 wing rules: needs an ACTIVE tower parent without a parent and without direct units', async () => {
    const { c } = await setupSociety();
    const t = await makeBuilding(c, { code: 'T' });
    const w = await create(c, {
      code: 'T1',
      name: 'Wing 1',
      kind: 'WING',
      floorsAboveGround: 5,
      parentBuildingId: t.id,
    });
    expect(w.status, JSON.stringify(w.body)).toBe(201);
    expect(w.body.data.parentBuildingId).toBe(t.id);
    const code = async (body: Record<string, unknown>) => {
      const r = await create(c, { code: 'X', name: 'Block X', kind: 'TOWER', floorsAboveGround: 3, ...body });
      return [r.status, r.body.code];
    };
    expect(await code({ kind: 'WING' })).toEqual([422, 'PARENT_BUILDING_INVALID']); // no parent
    expect(await code({ kind: 'WING', parentBuildingId: 99999 })).toEqual([422, 'PARENT_BUILDING_INVALID']);
    expect(await code({ kind: 'WING', parentBuildingId: w.body.data.id })).toEqual([
      422,
      'PARENT_BUILDING_INVALID',
    ]); // parent is a wing
    expect(await code({ kind: 'TOWER', parentBuildingId: t.id })).toEqual([422, 'PARENT_BUILDING_INVALID']); // only wings have parents
    const comm = await makeBuilding(c, { code: 'C', kind: 'COMMERCIAL' });
    expect(await code({ kind: 'WING', parentBuildingId: comm.id })).toEqual([422, 'PARENT_BUILDING_INVALID']); // parent is not a tower
    await archive(c, w.body.data.id, 1);
    const t2 = await makeBuilding(c, { code: 'T2' });
    await c('post', `/buildings/${t2.id}/archive`, { version: 1, reason: 'Not needed any more' });
    expect(await code({ kind: 'WING', parentBuildingId: t2.id })).toEqual([422, 'PARENT_BUILDING_INVALID']); // archived tower
    // a tower with units cannot receive wings
    const t3 = await makeBuilding(c, { code: 'T3' });
    await makeUnit(c, t3.id, '101', 1);
    expect(await code({ kind: 'WING', parentBuildingId: t3.id })).toEqual([
      422,
      'BUILDING_STRUCTURE_CONFLICT',
    ]);
    // another society's tower is not a valid parent
    const other = await setupSociety({ name: 'Other CHS' });
    const ot = await makeBuilding(other.c, { code: 'OT' });
    expect(await code({ kind: 'WING', parentBuildingId: ot.id })).toEqual([422, 'PARENT_BUILDING_INVALID']);
  });

  it('is limited to settings.society.edit', async () => {
    const { society } = await setupSociety();
    const m = await memberOf(society, 'committee_member');
    expect((await create(m.c, base)).status).toBe(403);
    expect((await m.c('get', '/buildings')).status).toBe(200); // residents.units.view
  });
});

describe('GET /buildings and /buildings/:id (8.6)', () => {
  it('lists with counts, wings and filters; sorts and paginates', async () => {
    const { c } = await setupSociety();
    const a = await makeBuilding(c, { code: 'A', floorsAboveGround: 5 });
    const b = await makeBuilding(c, { code: 'B', name: 'Block Beta', floorsAboveGround: 5 });
    const w = await makeBuilding(c, {
      code: 'B1',
      kind: 'WING',
      parentBuildingId: b.id,
      name: 'Wing Beta 1',
    });
    await makeUnit(c, a.id, '101', 1);
    await makeUnit(c, a.id, '102', 1, { unitType: 'PARKING_ONLY' });
    const u3 = await makeUnit(c, a.id, '103', 1);
    await c('post', `/units/${u3.id}/archive`, { version: 1, reason: 'Merged into 102' });
    const r = await c('get', '/buildings');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.map((x: any) => x.code)).toEqual(['A', 'B', 'B1']);
    expect(r.body.data[0].unitCounts).toEqual({ active: 2, archived: 1, countable: 1 });
    expect(r.body.data[1].wings).toEqual([{ id: w.id, code: 'B1', name: 'Wing Beta 1', status: 'ACTIVE' }]);
    expect(r.body.pagination.total).toBe(3);
    const q = async (query: Record<string, string>) =>
      (await c('get', '/buildings', undefined, { query })).body.data.map((x: any) => x.code);
    expect(await q({ kind: 'WING' })).toEqual(['B1']);
    expect(await q({ parentBuildingId: String(b.id) })).toEqual(['B1']);
    expect(await q({ q: 'beta' })).toEqual(['B', 'B1']);
    expect(await q({ q: 'b1' })).toEqual(['B1']);
    expect(await q({ sortBy: 'code', sortOrder: 'desc' })).toEqual(['B1', 'B', 'A']);
    expect(await q({ sortBy: 'name', sortOrder: 'asc' })).toEqual(['B', 'A', 'B1']);
    expect(await q({ limit: '1', page: '3' })).toEqual(['B1']);
    await archive(c, w.id, 1);
    expect(await q({})).toEqual(['A', 'B']);
    expect(await q({ status: 'ARCHIVED' })).toEqual(['B1']);
    expect(await q({ status: 'ALL' })).toHaveLength(3);
    expect((await c('get', '/buildings', undefined, { query: { sortBy: 'floors' } })).status).toBe(400);
  });

  it('GET /buildings/:id returns the object; unknown and other societies ids are BUILDING_NOT_FOUND', async () => {
    const { c } = await setupSociety();
    const a = await makeBuilding(c, { basements: 2 });
    const r = await c('get', `/buildings/${a.id}`);
    expect(r.body.data).toMatchObject({
      id: a.id,
      floorLabels: { min: 'B2', max: '10' },
      createdAt: expect.any(String),
    });
    expect((await c('get', '/buildings/99999999')).body.code).toBe('BUILDING_NOT_FOUND');
    const other = await setupSociety({ name: 'Other CHS' });
    expect((await other.c('get', `/buildings/${a.id}`)).body.code).toBe('BUILDING_NOT_FOUND');
  });

  it('floor labels follow structure.groundFloorLabel and structure.basementPrefix', async () => {
    const { c } = await setupSociety();
    await c('patch', '/society/settings', {
      changes: [
        { key: 'structure.groundFloorLabel', value: 'GF', version: 0 },
        { key: 'structure.basementPrefix', value: 'LB', version: 0 },
      ],
    });
    const a = await makeBuilding(c, { floorsAboveGround: 0, basements: 2 });
    expect((await c('get', `/buildings/${a.id}`)).body.data.floorLabels).toEqual({ min: 'LB2', max: 'GF' });
  });
});

describe('PATCH /buildings/:id (8.7)', () => {
  it('edits fields, renames the location node, audits changed fields and bumps the version', async () => {
    const { society, c } = await setupSociety();
    const a = await makeBuilding(c);
    const r = await patch(c, a.id, {
      version: 1,
      name: 'Tower Alpha',
      liftCount: 4,
      sortOrder: 7,
      floorsAboveGround: 25,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      name: 'Tower Alpha',
      liftCount: 4,
      sortOrder: 7,
      floorsAboveGround: 25,
      version: 2,
    });
    expect((await LocationNode.findByPk(a.locationNodeId))!.name).toBe('Tower Alpha');
    const log = await audits(society.id!, 'setup.building.updated');
    expect(Object.keys(log[0]!.after as object).sort()).toEqual([
      'floorsAboveGround',
      'liftCount',
      'name',
      'sortOrder',
    ]);
    const same = await patch(c, a.id, { version: 2, name: 'Tower Alpha' });
    expect(same.body.data.version).toBe(2);
    expect(await audits(society.id!, 'setup.building.updated')).toHaveLength(1);
  });

  it('STALE_VERSION, unknown id, archived building (INVALID_STATE)', async () => {
    const { c } = await setupSociety();
    const a = await makeBuilding(c);
    expect((await patch(c, a.id, { version: 2, name: 'Tower B' })).body.code).toBe('STALE_VERSION');
    expect((await patch(c, 99999999, { version: 1, name: 'Tower B' })).body.code).toBe('BUILDING_NOT_FOUND');
    await archive(c, a.id, 1);
    const r = await patch(c, a.id, { version: 2, name: 'Tower B' });
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('BR-08-15 the code can change until the building has a unit (any status), then BUILDING_CODE_LOCKED', async () => {
    const { c } = await setupSociety();
    const a = await makeBuilding(c, { code: 'A' });
    await makeBuilding(c, { code: 'B' });
    expect((await patch(c, a.id, { version: 1, code: 'B' })).body.code).toBe('BUILDING_CODE_TAKEN');
    const ok = await patch(c, a.id, { version: 1, code: 'c' });
    expect(ok.body.data.code).toBe('C');
    const u = await makeUnit(c, a.id, '101', 1);
    const locked = await patch(c, a.id, { version: 2, code: 'D' });
    expect([locked.status, locked.body.code]).toEqual([409, 'BUILDING_CODE_LOCKED']);
    await c('post', `/units/${u.id}/archive`, { version: 1, reason: 'Merged into 102' });
    expect((await patch(c, a.id, { version: 2, code: 'D' })).body.code).toBe('BUILDING_CODE_LOCKED');
    // the same code is not a change
    expect((await patch(c, a.id, { version: 2, code: 'C', name: 'Tower C' })).status).toBe(200);
  });

  it('kind and parent cannot change once the building has units, or while a tower has wings', async () => {
    const { c } = await setupSociety();
    const t = await makeBuilding(c, { code: 'T' });
    const t2 = await makeBuilding(c, { code: 'U' });
    const w = await makeBuilding(c, { code: 'T1', kind: 'WING', parentBuildingId: t.id });
    const r = await patch(c, t.id, { version: 1, kind: 'COMMERCIAL' });
    expect([r.status, r.body.code]).toEqual([422, 'BUILDING_STRUCTURE_CONFLICT']);
    await makeUnit(c, w.id, '101', 1);
    expect((await patch(c, w.id, { version: 1, parentBuildingId: t2.id })).body.code).toBe(
      'BUILDING_STRUCTURE_CONFLICT',
    );
    expect((await patch(c, w.id, { version: 1, kind: 'TOWER', parentBuildingId: null })).body.code).toBe(
      'BUILDING_STRUCTURE_CONFLICT',
    );
    // a building without units can be turned into a wing
    const free = await makeBuilding(c, { code: 'F' });
    const turned = await patch(c, free.id, { version: 1, kind: 'WING', parentBuildingId: t2.id });
    expect(turned.status, JSON.stringify(turned.body)).toBe(200);
    expect(turned.body.data).toMatchObject({ kind: 'WING', parentBuildingId: t2.id });
    expect((await patch(c, free.id, { version: 2, kind: 'WING', parentBuildingId: null })).body.code).toBe(
      'PARENT_BUILDING_INVALID',
    );
  });

  it('BR-08-17 the floor range cannot shrink below a floor used by an ACTIVE unit or an ACTIVE floor node', async () => {
    const { c } = await setupSociety();
    const a = await makeBuilding(c, { floorsAboveGround: 10, basements: 2 });
    await makeUnit(c, a.id, '1001', 10);
    await makeUnit(c, a.id, 'B1', -2, { unitType: 'PARKING_ONLY' });
    const code = async (v: number, body: Record<string, unknown>) => {
      const r = await patch(c, a.id, { version: v, ...body });
      return [r.status, r.body.code];
    };
    expect(await code(1, { floorsAboveGround: 9 })).toEqual([422, 'BUILDING_FLOORS_IN_USE']);
    expect(await code(1, { basements: 1 })).toEqual([422, 'BUILDING_FLOORS_IN_USE']);
    expect(await code(1, { floorsAboveGround: 12, basements: 3 })).toEqual([200, undefined]);
    // an ACTIVE floor node blocks too; an archived unit does not
    await c(
      'post',
      '/locations',
      { parentId: a.locationNodeId, nodeType: 'FLOOR', floor: 12 },
      { headers: idemKey() },
    );
    expect(await code(2, { floorsAboveGround: 11 })).toEqual([422, 'BUILDING_FLOORS_IN_USE']);
    const node = (await LocationNode.findOne({ where: { buildingId: a.id, floor: 12 } }))!;
    await c('post', `/locations/${node.id}/archive`, { version: 1 });
    expect(await code(2, { floorsAboveGround: 11 })).toEqual([200, undefined]);
    const u = (await Unit.findOne({ where: { unitNumber: '1001' } }))!;
    await c('post', `/units/${u.id}/archive`, { version: 1, reason: 'Removed from the register' });
    expect(await code(3, { floorsAboveGround: 5 })).toEqual([200, undefined]);
  });
});

describe('archive, restore, delete (8.8, BR-08-18)', () => {
  it('T08-27 archiving cascades to the whole location subtree and restoring brings back the building node only', async () => {
    const { society, c } = await setupSociety();
    const a = await makeBuilding(c);
    const floor = await c(
      'post',
      '/locations',
      { parentId: a.locationNodeId, nodeType: 'FLOOR', floor: 3 },
      { headers: idemKey() },
    );
    const area = await c(
      'post',
      '/locations',
      { parentId: floor.body.data.id, nodeType: 'AREA', areaType: 'LOBBY', name: 'Lift lobby' },
      { headers: idemKey() },
    );
    expect(area.status, JSON.stringify(area.body)).toBe(201);
    const r = await archive(c, a.id, 1);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('ARCHIVED');
    const nodes = await LocationNode.findAll({
      where: { societyId: society.id! },
      order: [['depth', 'ASC']],
    });
    expect(nodes.map(n => [n.nodeType, n.status])).toEqual([
      ['BUILDING', 'ARCHIVED'],
      ['FLOOR', 'ARCHIVED'],
      ['AREA', 'ARCHIVED'],
    ]);
    expect(nodes.every(n => n.archivedAt !== null)).toBe(true);
    const log = (await audits(society.id!, 'setup.building.archived'))[0]!;
    expect(log.reason).toBe('Tower closed for rebuilding');
    const back = await restore(c, a.id, 2);
    expect(back.body.data).toMatchObject({ status: 'ACTIVE', version: 3 });
    const after = await LocationNode.findAll({
      where: { societyId: society.id! },
      order: [['depth', 'ASC']],
    });
    expect(after.map(n => n.status)).toEqual(['ACTIVE', 'ARCHIVED', 'ARCHIVED']);
  });

  it('refuses to archive a building with ACTIVE units or wings, with the counts in errors[]', async () => {
    const { c } = await setupSociety();
    const t = await makeBuilding(c, { code: 'T' });
    const w = await makeBuilding(c, { code: 'T1', kind: 'WING', parentBuildingId: t.id });
    const r1 = await archive(c, t.id, 1);
    expect([r1.status, r1.body.code]).toEqual([409, 'BUILDING_HAS_ACTIVE_UNITS']);
    expect(r1.body.errors[0]).toMatchObject({ field: 'wings', message: '1 active wing' });
    const u = await makeUnit(c, w.id, '101', 1);
    const r2 = await archive(c, w.id, 1);
    expect(r2.body.code).toBe('BUILDING_HAS_ACTIVE_UNITS');
    expect(r2.body.errors[0].field).toBe('units');
    await c('post', `/units/${u.id}/archive`, { version: 1, reason: 'Merged into 102' });
    expect((await archive(c, w.id, 1)).status).toBe(200);
    expect((await archive(c, t.id, 1)).status).toBe(200);
  });

  it('INVALID_STATE for archiving an ARCHIVED or restoring an ACTIVE building; STALE_VERSION; reason of 5 to 300', async () => {
    const { c } = await setupSociety();
    const a = await makeBuilding(c);
    expect((await restore(c, a.id, 1)).body.code).toBe('INVALID_STATE');
    expect((await archive(c, a.id, 5)).body.code).toBe('STALE_VERSION');
    expect((await c('post', `/buildings/${a.id}/archive`, { version: 1, reason: 'abc' })).body.code).toBe(
      'VALIDATION_FAILED',
    );
    await archive(c, a.id, 1);
    expect((await archive(c, a.id, 2)).body.code).toBe('INVALID_STATE');
    expect((await restore(c, a.id, 1)).body.code).toBe('STALE_VERSION');
  });

  it('restoring a wing needs its tower ACTIVE (422 PARENT_BUILDING_INVALID)', async () => {
    const { c } = await setupSociety();
    const t = await makeBuilding(c, { code: 'T' });
    const w = await makeBuilding(c, { code: 'T1', kind: 'WING', parentBuildingId: t.id });
    await archive(c, w.id, 1);
    await archive(c, t.id, 1);
    const r = await restore(c, w.id, 2);
    expect([r.status, r.body.code]).toEqual([422, 'PARENT_BUILDING_INVALID']);
    await restore(c, t.id, 2);
    expect((await restore(c, w.id, 2)).status).toBe(200);
  });

  it('deletes an empty building with its nodes (step-up needed); a building with units, wings or references is BUILDING_IN_USE', async () => {
    const { society, user, c } = await setupSociety();
    const a = await makeBuilding(c, { code: 'A' });
    await c(
      'post',
      '/locations',
      { parentId: a.locationNodeId, nodeType: 'FLOOR', floor: 1 },
      { headers: idemKey() },
    );
    const withUnit = await makeBuilding(c, { code: 'B' });
    const u = await makeUnit(c, withUnit.id, '101', 1);
    const tower = await makeBuilding(c, { code: 'T' });
    await makeBuilding(c, { code: 'T1', kind: 'WING', parentBuildingId: tower.id });
    expect((await c('delete', `/buildings/${withUnit.id}`)).body.code).toBe('BUILDING_IN_USE');
    expect((await c('delete', `/buildings/${tower.id}`)).body.code).toBe('BUILDING_IN_USE');
    await c('post', `/units/${u.id}/archive`, { version: 1, reason: 'Merged into 102' });
    expect((await c('delete', `/buildings/${withUnit.id}`)).body.code).toBe('BUILDING_IN_USE'); // archived units still count
    const r = await c('delete', `/buildings/${a.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    expect(await Building.count({ where: { id: a.id } })).toBe(0);
    expect(await LocationNode.count({ where: { buildingId: a.id } })).toBe(0);
    const log = (await audits(society.id!, 'setup.building.deleted'))[0]!;
    expect(log.before).toMatchObject({ buildingCode: 'A', name: 'Tower A' });
    expect((await c('delete', `/buildings/${a.id}`)).body.code).toBe('BUILDING_NOT_FOUND');
    // step-up
    const b = await makeBuilding(c, { code: 'D' });
    advance(10 * 60_000);
    expect((await c('delete', `/buildings/${b.id}`)).body.code).toBe('REAUTH_REQUIRED');
    resetLogins();
    expect((await as(await login(user))('delete', `/buildings/${b.id}`)).status).toBe(204);
  });

  it('a location node referenced by another table blocks the delete with BUILDING_IN_USE and keeps everything', async () => {
    const { c } = await setupSociety();
    const a = await makeBuilding(c, { code: 'A' });
    // stand-in for modules 15, 17, 18 and 21: a table with a RESTRICT foreign key to location_nodes
    await sequelize.query(
      'CREATE TABLE IF NOT EXISTS tmp_location_refs (id INT PRIMARY KEY AUTO_INCREMENT, nodeId BIGINT UNSIGNED NOT NULL, CONSTRAINT fk_tmp_loc FOREIGN KEY (nodeId) REFERENCES location_nodes (id) ON DELETE RESTRICT)',
    );
    try {
      await sequelize.query('INSERT INTO tmp_location_refs (nodeId) VALUES (:id)', {
        replacements: { id: a.locationNodeId },
      });
      const r = await c('delete', `/buildings/${a.id}`);
      expect([r.status, r.body.code]).toEqual([409, 'BUILDING_IN_USE']);
      expect(await Building.count({ where: { id: a.id } })).toBe(1);
      expect(await LocationNode.count({ where: { buildingId: a.id } })).toBe(1);
    } finally {
      await sequelize.query('DROP TABLE IF EXISTS tmp_location_refs');
    }
  });
});

describe('GET /buildings/:id/grid (8.9)', () => {
  it('returns floors in descending order with units by position, labels and totals', async () => {
    const { c } = await setupSociety();
    const a = await makeBuilding(c, { floorsAboveGround: 3, basements: 1 });
    await makeUnit(c, a.id, '202', 2, { positionOnFloor: 2, bhk: '2BHK', carpetAreaSqft: '900' });
    await makeUnit(c, a.id, '201', 2, { positionOnFloor: 1, bhk: '3BHK', carpetAreaSqft: '1150' });
    await makeUnit(c, a.id, 'G1', 0, { positionOnFloor: 1, unitType: 'SHOP' });
    await makeUnit(c, a.id, 'B1', -1, { unitType: 'PARKING_ONLY' });
    const gone = await makeUnit(c, a.id, '203', 2, { positionOnFloor: 3 });
    await c('post', `/units/${gone.id}/archive`, { version: 1, reason: 'Merged into 202' });
    const r = await c('get', `/buildings/${a.id}/grid`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.building).toEqual({ id: a.id, code: 'A', name: 'Tower A' });
    expect(
      r.body.data.floors.map((f: any) => [f.floor, f.floorLabel, f.units.map((u: any) => u.unitNumber)]),
    ).toEqual([
      [2, '2', ['201', '202']],
      [0, 'G', ['G1']],
      [-1, 'B1', ['B1']],
    ]);
    expect(r.body.data.floors[0].units[0]).toEqual({
      id: expect.any(Number),
      label: 'A-201',
      unitNumber: '201',
      positionOnFloor: 1,
      unitType: 'FLAT',
      bhk: '3BHK',
      areaSqft: '1150.000',
      isBillable: true,
      status: 'ACTIVE',
    });
    expect(r.body.data.totals).toEqual({ units: 4, missingArea: 2 });
    const all = await c('get', `/buildings/${a.id}/grid`, undefined, { query: { includeArchived: 'true' } });
    expect(all.body.data.totals.units).toBe(5);
    expect(all.body.data.floors[0].units.map((u: any) => u.status)).toEqual(['ACTIVE', 'ACTIVE', 'ARCHIVED']);
  });

  it('a tower with wings is 400 with the hint to open a wing; unknown ids are 404', async () => {
    const { c } = await setupSociety();
    const t = await makeBuilding(c, { code: 'T' });
    await makeBuilding(c, { code: 'T1', kind: 'WING', parentBuildingId: t.id });
    const r = await c('get', `/buildings/${t.id}/grid`);
    expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(r.body.errors[0].message).toMatch(/wing/);
    expect((await c('get', '/buildings/99999999/grid')).body.code).toBe('BUILDING_NOT_FOUND');
  });
});
