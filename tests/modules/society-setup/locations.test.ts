import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, LocationNode, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { locations } from '../../../src/modules/society-setup/society-setup.public';
import {
  featureOff,
  idemKey,
  makeBuilding,
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
  c('post', '/locations', body, { headers: idemKey() });
const patch = (c: any, id: number, body: Record<string, unknown>) => c('patch', `/locations/${id}`, body);
const archive = (c: any, id: number, version: number) => c('post', `/locations/${id}/archive`, { version });
const restore = (c: any, id: number, version: number) => c('post', `/locations/${id}/restore`, { version });
const node = async (id: number) => (await LocationNode.findByPk(id))!;

async function tree() {
  const s = await setupSociety();
  const a = await makeBuilding(s.c, { code: 'A', floorsAboveGround: 10, basements: 2 });
  const f3 = await create(s.c, { parentId: a.locationNodeId, nodeType: 'FLOOR', floor: 3 });
  const lobby = await create(s.c, {
    parentId: f3.body.data.id,
    nodeType: 'AREA',
    areaType: 'LOBBY',
    name: 'Lift lobby',
  });
  return { ...s, a, f3: f3.body.data, lobby: lobby.body.data };
}

describe('POST /locations (8.20)', () => {
  it('US-08-09 builds Tower A > Floor 3 > Lift lobby with materialized paths, the building and the floor inherited', async () => {
    const { society, a, f3, lobby } = await tree();
    expect(f3).toMatchObject({
      nodeType: 'FLOOR',
      name: 'Floor 3',
      floor: 3,
      buildingId: a.id,
      parentId: a.locationNodeId,
      pathLabel: 'Tower A › Floor 3',
      status: 'ACTIVE',
      version: 1,
    });
    expect(lobby).toMatchObject({
      nodeType: 'AREA',
      areaType: 'LOBBY',
      name: 'Lift lobby',
      floor: 3,
      buildingId: a.id,
      parentId: f3.id,
      pathLabel: 'Tower A › Floor 3 › Lift lobby',
    });
    expect(lobby.qrToken).toMatch(/^[A-Za-z0-9]{12}$/);
    const row = await node(lobby.id);
    expect(row).toMatchObject({ depth: 3, path: `/${a.locationNodeId}/${f3.id}/${lobby.id}/` });
    expect(await audits(society.id!, 'setup.location.created')).toHaveLength(2);
  });

  it('creates root areas (a garden and a gate) that belong to no building', async () => {
    const { c } = await tree();
    const g = await create(c, {
      parentId: null,
      nodeType: 'AREA',
      areaType: 'GARDEN',
      name: 'Garden',
      notes: 'Near the clubhouse',
      sortOrder: 5,
    });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect(g.body.data).toMatchObject({
      buildingId: null,
      floor: null,
      parentId: null,
      notes: 'Near the clubhouse',
      sortOrder: 5,
      pathLabel: 'Garden',
    });
    const gate = await create(c, { parentId: null, nodeType: 'AREA', areaType: 'GATE', name: 'Main Gate' });
    expect(gate.status, JSON.stringify(gate.body)).toBe(201);
  });

  it('BR-08-40 names are unique among ACTIVE siblings (any case), free under another parent and after an archive', async () => {
    const { c, f3, a } = await tree();
    const dup = await create(c, { parentId: f3.id, nodeType: 'AREA', areaType: 'LOBBY', name: 'lift LOBBY' });
    expect([dup.status, dup.body.code]).toEqual([409, 'LOCATION_NAME_TAKEN']);
    const f4 = await create(c, { parentId: a.locationNodeId, nodeType: 'FLOOR', floor: 4 });
    expect(
      (
        await create(c, {
          parentId: f4.body.data.id,
          nodeType: 'AREA',
          areaType: 'LOBBY',
          name: 'Lift lobby',
        })
      ).status,
    ).toBe(201);
    // the same floor twice
    const again = await create(c, { parentId: a.locationNodeId, nodeType: 'FLOOR', floor: 3 });
    expect([again.status, again.body.code]).toEqual([409, 'LOCATION_NAME_TAKEN']);
    // archived siblings free their name
    const lobby = (await LocationNode.findOne({ where: { name: 'Lift lobby', floor: 3 } }))!;
    await archive(c, lobby.id, 1);
    expect(
      (await create(c, { parentId: f3.id, nodeType: 'AREA', areaType: 'LOBBY', name: 'Lift lobby' })).status,
    ).toBe(201);
    // and the archived one cannot come back while the name is used
    expect((await restore(c, lobby.id, 2)).body.code).toBe('LOCATION_NAME_TAKEN');
  });

  it('BR-08-39 floor nodes are generated from the floor and must be inside the building range', async () => {
    const { c, a } = await tree();
    const ground = await create(c, { parentId: a.locationNodeId, nodeType: 'FLOOR', floor: 0 });
    const base = await create(c, { parentId: a.locationNodeId, nodeType: 'FLOOR', floor: -1 });
    expect([ground.body.data.name, base.body.data.name]).toEqual(['Ground floor', 'Basement 1']);
    const out = await create(c, { parentId: a.locationNodeId, nodeType: 'FLOOR', floor: 11 });
    expect([out.status, out.body.code]).toEqual([422, 'FLOOR_OUT_OF_RANGE']);
    expect((await create(c, { parentId: a.locationNodeId, nodeType: 'FLOOR', floor: -3 })).body.code).toBe(
      'FLOOR_OUT_OF_RANGE',
    );
    expect((await create(c, { parentId: a.locationNodeId, nodeType: 'FLOOR' })).body.code).toBe(
      'VALIDATION_FAILED',
    );
    // a name sent for a floor is ignored: floors name themselves
    const named = await create(c, {
      parentId: a.locationNodeId,
      nodeType: 'FLOOR',
      floor: 5,
      name: 'Penthouse',
    });
    expect(named.body.data.name).toBe('Floor 5');
  });

  it('BR-08-38 tree shape: floors only under buildings, areas under buildings, floors and areas, at most 4 levels', async () => {
    const { c, a, f3, lobby } = await tree();
    const code = async (body: Record<string, unknown>) => {
      const r = await create(c, body);
      return [r.status, r.body.code];
    };
    expect(await code({ parentId: null, nodeType: 'FLOOR', floor: 1 })).toEqual([
      422,
      'LOCATION_PARENT_INVALID',
    ]);
    expect(await code({ parentId: f3.id, nodeType: 'FLOOR', floor: 4 })).toEqual([
      422,
      'LOCATION_PARENT_INVALID',
    ]);
    expect(await code({ parentId: lobby.id, nodeType: 'FLOOR', floor: 4 })).toEqual([
      422,
      'LOCATION_PARENT_INVALID',
    ]);
    expect(
      await code({ parentId: a.locationNodeId, nodeType: 'AREA', areaType: 'TERRACE', name: 'Terrace' }),
    ).toEqual([201, undefined]);
    expect(await code({ parentId: lobby.id, nodeType: 'AREA', areaType: 'LIFT', name: 'Lift 1' })).toEqual([
      201,
      undefined,
    ]); // depth 4
    const l1 = (await LocationNode.findOne({ where: { name: 'Lift 1' } }))!;
    expect(
      await code({ parentId: l1.id, nodeType: 'AREA', areaType: 'OTHER', name: 'Button panel' }),
    ).toEqual([422, 'LOCATION_DEPTH_EXCEEDED']);
    expect(await code({ parentId: 99999999, nodeType: 'AREA', areaType: 'OTHER', name: 'Nowhere' })).toEqual([
      404,
      'LOCATION_NOT_FOUND',
    ]);
    expect(await code({ parentId: null, nodeType: 'AREA', areaType: 'LOBBY' })).toEqual([
      400,
      'VALIDATION_FAILED',
    ]); // no name
    expect(await code({ parentId: null, nodeType: 'AREA', name: 'No type' })).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(await code({ parentId: null, nodeType: 'BUILDING', name: 'Tower Z' })).toEqual([
      400,
      'VALIDATION_FAILED',
    ]); // managed with the building
    expect(await code({ parentId: null, nodeType: 'AREA', areaType: 'NOT_A_TYPE', name: 'Odd' })).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    // an archived parent is not a valid parent; another society's node does not exist
    await archive(c, lobby.id, 1);
    expect(await code({ parentId: lobby.id, nodeType: 'AREA', areaType: 'OTHER', name: 'Late' })).toEqual([
      422,
      'LOCATION_PARENT_INVALID',
    ]);
    const other = await setupSociety({ name: 'Other CHS' });
    expect(
      await code.call(null, {
        parentId: (await makeBuilding(other.c)).locationNodeId,
        nodeType: 'AREA',
        areaType: 'OTHER',
        name: 'Stolen',
      }),
    ).toEqual([404, 'LOCATION_NOT_FOUND']);
  });

  it('a gate is a root area and needs property.gates_registry (402 FEATURE_NOT_IN_PLAN)', async () => {
    const { society, c, a } = await tree();
    const under = await create(c, {
      parentId: a.locationNodeId,
      nodeType: 'AREA',
      areaType: 'GATE',
      name: 'Back Gate',
    });
    expect([under.status, under.body.code]).toEqual([422, 'LOCATION_PARENT_INVALID']);
    await featureOff(society.id!, 'property.gates_registry');
    const off = await create(c, { parentId: null, nodeType: 'AREA', areaType: 'GATE', name: 'Main Gate' });
    expect([off.status, off.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    expect(
      (await create(c, { parentId: null, nodeType: 'AREA', areaType: 'GARDEN', name: 'Garden' })).status,
    ).toBe(201);
  });

  it('needs an Idempotency-Key and settings.society.edit; viewing needs residents.units.view', async () => {
    const { society, c } = await tree();
    expect(
      (
        await c('post', '/locations', {
          parentId: null,
          nodeType: 'AREA',
          areaType: 'GARDEN',
          name: 'Garden',
        })
      ).status,
    ).toBe(400);
    const m = await memberOf(society, 'committee_member');
    expect(
      (await create(m.c, { parentId: null, nodeType: 'AREA', areaType: 'GARDEN', name: 'Garden' })).status,
    ).toBe(403);
    expect((await m.c('get', '/locations')).status).toBe(200);
  });
});

describe('PATCH /locations/:id (8.20)', () => {
  it('renames, re-types, re-orders and annotates; audits changed fields; bumps the version', async () => {
    const { society, c, lobby } = await tree();
    const r = await patch(c, lobby.id, {
      version: 1,
      name: 'Main lobby',
      areaType: 'HALL',
      sortOrder: 2,
      notes: 'Key with security',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      name: 'Main lobby',
      areaType: 'HALL',
      sortOrder: 2,
      notes: 'Key with security',
      version: 2,
      pathLabel: 'Tower A › Floor 3 › Main lobby',
    });
    const log = await audits(society.id!, 'setup.location.updated');
    expect(Object.keys(log[0]!.after as object).sort()).toEqual(['areaType', 'name', 'notes', 'sortOrder']);
    expect((await patch(c, lobby.id, { version: 2, name: 'Main lobby' })).body.data.version).toBe(2);
    expect((await patch(c, lobby.id, { version: 1, name: 'Again' })).body.code).toBe('STALE_VERSION');
    expect((await patch(c, 99999999, { version: 1, name: 'Again' })).body.code).toBe('LOCATION_NOT_FOUND');
  });

  it('BUILDING nodes are managed (LOCATION_MANAGED); floors cannot be renamed or re-typed; archived nodes are INVALID_STATE', async () => {
    const { c, a, f3, lobby } = await tree();
    const b = await patch(c, a.locationNodeId, { version: 1, name: 'Renamed' });
    expect([b.status, b.body.code]).toEqual([422, 'LOCATION_MANAGED']);
    expect((await patch(c, f3.id, { version: 1, name: 'Third floor' })).body.code).toBe('VALIDATION_FAILED');
    expect((await patch(c, f3.id, { version: 1, notes: 'Refuge floor' })).status).toBe(200);
    await archive(c, lobby.id, 1);
    expect((await patch(c, lobby.id, { version: 2, notes: 'x' })).body.code).toBe('INVALID_STATE');
  });

  it('moves an area with its subtree: path, depth, building and floor are rewritten; the name must be free at the target', async () => {
    const { society, c, a, f3, lobby } = await tree();
    const lift = (await create(c, { parentId: lobby.id, nodeType: 'AREA', areaType: 'LIFT', name: 'Lift 1' }))
      .body.data;
    const f5 = (await create(c, { parentId: a.locationNodeId, nodeType: 'FLOOR', floor: 5 })).body.data;
    const r = await patch(c, lobby.id, { version: 1, parentId: f5.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      parentId: f5.id,
      floor: 5,
      buildingId: a.id,
      pathLabel: 'Tower A › Floor 5 › Lift lobby',
    });
    const child = await node(lift.id);
    expect(child).toMatchObject({
      floor: 5,
      buildingId: a.id,
      depth: 4,
      path: `/${a.locationNodeId}/${f5.id}/${lobby.id}/${lift.id}/`,
    });
    const moved = await audits(society.id!, 'setup.location.moved');
    expect(moved).toHaveLength(1);
    expect(moved[0]!.before).toMatchObject({ parentId: f3.id });
    expect(moved[0]!.after).toMatchObject({ parentId: f5.id });
    // a root node: building and floor are cleared
    const root = await patch(c, lobby.id, { version: 2, parentId: null });
    expect(root.body.data).toMatchObject({
      parentId: null,
      floor: null,
      buildingId: null,
      pathLabel: 'Lift lobby',
    });
    expect(await node(lift.id)).toMatchObject({ depth: 2, buildingId: null, floor: null });
    // name clash at the target
    await create(c, { parentId: f3.id, nodeType: 'AREA', areaType: 'LOBBY', name: 'Lift lobby' });
    expect((await patch(c, lobby.id, { version: 3, parentId: f3.id })).body.code).toBe('LOCATION_NAME_TAKEN');
  });

  it('T08-26 moving a node under its own child (or itself) is 422 LOCATION_CYCLE; too deep is LOCATION_DEPTH_EXCEEDED', async () => {
    const { c, a, f3, lobby } = await tree();
    const lift = (await create(c, { parentId: lobby.id, nodeType: 'AREA', areaType: 'LIFT', name: 'Lift 1' }))
      .body.data;
    const r = await patch(c, lobby.id, { version: 1, parentId: lift.id });
    expect([r.status, r.body.code]).toEqual([422, 'LOCATION_CYCLE']);
    expect((await patch(c, lobby.id, { version: 1, parentId: lobby.id })).body.code).toBe('LOCATION_CYCLE');
    expect((await node(lobby.id)).parentId).toBe(f3.id);
    // lobby with its lift (2 levels) moved under a depth-3 node would reach depth 5
    const t = (await create(c, { parentId: null, nodeType: 'AREA', areaType: 'OTHER', name: 'Club' })).body
      .data;
    const room = (await create(c, { parentId: t.id, nodeType: 'AREA', areaType: 'HALL', name: 'Hall' })).body
      .data;
    const stage = (await create(c, { parentId: room.id, nodeType: 'AREA', areaType: 'OTHER', name: 'Stage' }))
      .body.data;
    const deep = await patch(c, lobby.id, { version: 1, parentId: stage.id });
    expect([deep.status, deep.body.code]).toEqual([422, 'LOCATION_DEPTH_EXCEEDED']);
    // shape rules apply to moves too
    expect((await patch(c, lobby.id, { version: 1, parentId: a.locationNodeId })).status).toBe(200);
    expect((await patch(c, f3.id, { version: 1, parentId: null })).body.code).toBe('LOCATION_PARENT_INVALID');
  });

  it('a gate stays at the top level; an area can become a gate only at the root', async () => {
    const { society, c, f3 } = await tree();
    const gate = (await create(c, { parentId: null, nodeType: 'AREA', areaType: 'GATE', name: 'Main Gate' }))
      .body.data;
    expect((await patch(c, gate.id, { version: 1, parentId: f3.id })).body.code).toBe(
      'LOCATION_PARENT_INVALID',
    );
    const lobby = (await LocationNode.findOne({ where: { name: 'Lift lobby' } }))!;
    expect((await patch(c, lobby.id, { version: 1, areaType: 'GATE' })).body.code).toBe(
      'LOCATION_PARENT_INVALID',
    );
    await featureOff(society.id!, 'property.gates_registry');
    const garden = (await create(c, { parentId: null, nodeType: 'AREA', areaType: 'GARDEN', name: 'Garden' }))
      .body.data;
    expect((await patch(c, garden.id, { version: 1, areaType: 'GATE' })).body.code).toBe(
      'FEATURE_NOT_IN_PLAN',
    );
  });

  it('cannot move into an archived parent or another society', async () => {
    const { c, f3, lobby } = await tree();
    const other = await setupSociety({ name: 'Other CHS' });
    const ob = await makeBuilding(other.c);
    expect((await patch(c, lobby.id, { version: 1, parentId: ob.locationNodeId })).body.code).toBe(
      'LOCATION_NOT_FOUND',
    );
    const f6 = (await create(c, { parentId: (await node(f3.id)).parentId, nodeType: 'FLOOR', floor: 6 })).body
      .data;
    await archive(c, f6.id, 1);
    expect((await patch(c, lobby.id, { version: 1, parentId: f6.id })).body.code).toBe(
      'LOCATION_PARENT_INVALID',
    );
  });
});

describe('archive, restore and QR (8.21)', () => {
  it('archive takes the node and every ACTIVE descendant; restore brings back the node only and needs an ACTIVE parent', async () => {
    const { society, c, f3, lobby } = await tree();
    const lift = (await create(c, { parentId: lobby.id, nodeType: 'AREA', areaType: 'LIFT', name: 'Lift 1' }))
      .body.data;
    const r = await archive(c, f3.id, 1);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'ARCHIVED', version: 2 });
    expect((await node(lobby.id)).status).toBe('ARCHIVED');
    expect((await node(lift.id)).status).toBe('ARCHIVED');
    expect((await node(lift.id)).archivedAt).not.toBeNull();
    expect((await audits(society.id!, 'setup.location.archived'))[0]!.after).toMatchObject({
      archivedNodes: 3,
    });
    // the child cannot come back while its floor is archived
    const child = await restore(c, lobby.id, 2);
    expect([child.status, child.body.code]).toEqual([422, 'LOCATION_PARENT_INVALID']);
    expect((await restore(c, f3.id, 2)).status).toBe(200);
    expect((await node(lobby.id)).status).toBe('ARCHIVED'); // only the node itself
    expect((await restore(c, lobby.id, 2)).status).toBe(200);
    expect((await node(lift.id)).status).toBe('ARCHIVED');
  });

  it('INVALID_STATE, STALE_VERSION, LOCATION_MANAGED and LOCATION_NOT_FOUND', async () => {
    const { c, a, lobby } = await tree();
    expect((await restore(c, lobby.id, 1)).body.code).toBe('INVALID_STATE');
    expect((await archive(c, lobby.id, 7)).body.code).toBe('STALE_VERSION');
    await archive(c, lobby.id, 1);
    expect((await archive(c, lobby.id, 2)).body.code).toBe('INVALID_STATE');
    expect((await restore(c, lobby.id, 1)).body.code).toBe('STALE_VERSION');
    for (const f of [archive, restore])
      expect((await f(c, a.locationNodeId, 1)).body.code).toBe('LOCATION_MANAGED');
    expect((await c('post', `/locations/${a.locationNodeId}/regenerate-qr`, { version: 1 })).body.code).toBe(
      'LOCATION_MANAGED',
    );
    expect((await archive(c, 99999999, 1)).body.code).toBe('LOCATION_NOT_FOUND');
  });

  it('BR-08-41 regenerate-qr issues a new token; the old one stops resolving at once; the audit row never holds a token', async () => {
    const { society, c, lobby } = await tree();
    const old = (await node(lobby.id)).qrToken;
    expect((await locations.getByQrToken(society.id!, old))!.id).toBe(lobby.id);
    const r = await c('post', `/locations/${lobby.id}/regenerate-qr`, { version: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.qrToken).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(r.body.data.qrToken).not.toBe(old);
    expect(r.body.data.version).toBe(2);
    expect(await locations.getByQrToken(society.id!, old)).toBeNull();
    expect((await locations.getByQrToken(society.id!, r.body.data.qrToken))!.id).toBe(lobby.id);
    const log = (await audits(society.id!, 'setup.location.qr_regenerated'))[0]!;
    expect(JSON.stringify(log)).not.toContain(r.body.data.qrToken);
    expect(JSON.stringify(log)).not.toContain(old);
    expect((await c('post', `/locations/${lobby.id}/regenerate-qr`, { version: 1 })).body.code).toBe(
      'STALE_VERSION',
    );
  });

  it('QR tokens are unique platform-wide', async () => {
    const { c } = await tree();
    for (let i = 0; i < 5; i++)
      await create(c, { parentId: null, nodeType: 'AREA', areaType: 'OTHER', name: `Area ${i}` });
    const tokens = (await LocationNode.findAll({ attributes: ['qrToken'] })).map(n => n.qrToken);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('regenerate-qr needs property.unit_qr_codes; the tree hides qrToken without it', async () => {
    const { society, c, lobby } = await tree();
    expect((await c('get', '/locations')).body.data.items[0].qrToken).toBeDefined();
    await featureOff(society.id!, 'property.unit_qr_codes');
    const r = await c('post', `/locations/${lobby.id}/regenerate-qr`, { version: 1 });
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    const list = await c('get', '/locations');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain('qrToken');
    expect((await c('get', `/locations/${lobby.id}`)).body.data.qrToken).toBeUndefined();
    // the public service function still returns it (module 15 and 17 print sheets check the feature themselves)
    expect((await locations.get(society.id!, lobby.id))!.qrToken).toMatch(/^[A-Za-z0-9]{12}$/);
  });
});

describe('GET /locations and GET /locations/:id (8.19)', () => {
  it('returns a nested tree ordered by sort order and name, with path labels', async () => {
    const { c, a } = await tree();
    await create(c, { parentId: null, nodeType: 'AREA', areaType: 'GATE', name: 'Main Gate' });
    await create(c, { parentId: null, nodeType: 'AREA', areaType: 'GARDEN', name: 'Garden', sortOrder: 1 });
    await create(c, { parentId: a.locationNodeId, nodeType: 'FLOOR', floor: 1, sortOrder: 0 });
    const r = await c('get', '/locations');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const items = r.body.data.items;
    expect(items.map((n: any) => n.name)).toEqual(['Main Gate', 'Tower A', 'Garden']); // sortOrder 0 first, then name; Garden has 1
    const tower = items.find((n: any) => n.name === 'Tower A');
    expect(tower).toMatchObject({
      nodeType: 'BUILDING',
      buildingId: a.id,
      status: 'ACTIVE',
      pathLabel: 'Tower A',
    });
    expect(tower.children.map((n: any) => n.name)).toEqual(['Floor 1', 'Floor 3']);
    expect(tower.children[1].children[0]).toMatchObject({
      name: 'Lift lobby',
      pathLabel: 'Tower A › Floor 3 › Lift lobby',
      children: [],
    });
  });

  it('filters by status, building, area type and root only', async () => {
    const { c, a, f3, lobby } = await tree();
    await create(c, { parentId: null, nodeType: 'AREA', areaType: 'GATE', name: 'Main Gate' });
    const other = await makeBuilding(c, { code: 'B' });
    await archive(c, lobby.id, 1);
    const names = (items: any[]): string[] => items.flatMap(n => [n.name, ...names(n.children)]);
    const q = async (query: Record<string, string>) =>
      names((await c('get', '/locations', undefined, { query })).body.data.items);
    expect(await q({})).toEqual(['Main Gate', 'Tower A', 'Floor 3', 'Tower B']);
    expect(await q({ status: 'ALL' })).toContain('Lift lobby');
    expect(await q({ buildingId: String(other.id) })).toEqual(['Tower B']);
    expect(await q({ buildingId: String(a.id), status: 'ALL' })).toEqual([
      'Tower A',
      'Floor 3',
      'Lift lobby',
    ]);
    expect(await q({ areaType: 'GATE' })).toEqual(['Main Gate']);
    expect(await q({ rootOnly: 'true' })).toEqual(['Main Gate', 'Tower A', 'Tower B']);
    expect((await c('get', '/locations', undefined, { query: { status: 'ARCHIVED' } })).status).toBe(400);
    void f3;
  });

  it('GET /locations/:id returns the node with its path label, parent and version; unknown ids are 404', async () => {
    const { c, f3, lobby } = await tree();
    const r = await c('get', `/locations/${lobby.id}`);
    expect(r.body.data).toMatchObject({
      id: lobby.id,
      parentId: f3.id,
      pathLabel: 'Tower A › Floor 3 › Lift lobby',
      version: 1,
    });
    expect((await c('get', '/locations/99999999')).body.code).toBe('LOCATION_NOT_FOUND');
  });
});

describe('service API for other modules (8.30)', () => {
  it('get, listTree, listGates and getByQrToken scope by society', async () => {
    const { society, c, lobby } = await tree();
    const gate = (await create(c, { parentId: null, nodeType: 'AREA', areaType: 'GATE', name: 'Main Gate' }))
      .body.data;
    const back = (await create(c, { parentId: null, nodeType: 'AREA', areaType: 'GATE', name: 'Back Gate' }))
      .body.data;
    await archive(c, back.id, 1);
    const other = await setupSociety({ name: 'Other CHS' });
    expect((await locations.listGates(society.id!)).map(g => g.id)).toEqual([gate.id]);
    expect(await locations.listGates(other.society.id!)).toEqual([]);
    expect((await locations.get(society.id!, lobby.id))!.pathLabel).toBe('Tower A › Floor 3 › Lift lobby');
    expect(await locations.get(other.society.id!, lobby.id)).toBeNull();
    expect((await locations.listTree(society.id!)).length).toBe(2);
    expect((await locations.listTree(society.id!, { includeArchived: true })).length).toBe(3);
    const token = (await node(lobby.id)).qrToken;
    expect(await locations.getByQrToken(other.society.id!, token)).toBeNull();
  });
});
