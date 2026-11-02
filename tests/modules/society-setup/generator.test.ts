import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, Building, LocationNode, Unit, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { subscriptions } from '../../../src/modules/subscriptions/subscriptions.public';
import { testHooks } from '../../../src/modules/society-setup/society-setup.generator.service';
import {
  flatsUsed,
  idemKey,
  makeBuilding,
  makeUnit,
  memberOf,
  resetSetup,
  setFlatsUsed,
  setupSociety,
} from '../../helpers/society-setup';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetSetup);

const audits = (societyId: number, action: string) =>
  AuditLog.findAll({ where: { societyId, action }, order: [['id', 'ASC']] });
const tower = (code = 'A', extra: Record<string, unknown> = {}) => ({
  newBuilding: { code, name: `Tower ${code}`, kind: 'TOWER', ...extra },
});
const params = (over: Record<string, unknown> = {}) => ({
  buildings: [tower('A')],
  floorFrom: 1,
  floorTo: 20,
  positions: [1, 2, 3, 4].map(position => ({ position, bhk: '3BHK' })),
  pattern: '{floor}{pos:2}',
  skipFloors: [13],
  ...over,
});
const preview = (c: any, body: unknown) => c('post', '/units/generator/preview', body);
const commit = async (c: any, body: Record<string, unknown>, headers = idemKey()) => {
  const p = await preview(c, body);
  if (p.status !== 200) return p;
  return c('post', '/units/generator/commit', { ...body, previewHash: p.body.data.previewHash }, { headers });
};

describe('POST /units/generator/preview (8.14)', () => {
  it('US-08-02 Tower A, floors 1 to 20, 4 positions, skip floor 13: 76 units labelled A-101 to A-2004, nothing written', async () => {
    const { society, c } = await setupSociety();
    const r = await preview(c, params());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body.data;
    expect(d.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.summary).toEqual({
      buildings: 1,
      newBuildings: 1,
      units: 76,
      countableUnits: 76,
      conflicts: 0,
      limit: 1000,
      used: 0,
      limitRemaining: 1000,
    });
    expect(d.conflicts).toEqual([]);
    expect(d.sampleCount).toBe(76);
    expect(d.sample).toHaveLength(76);
    expect(d.sample[0]).toEqual({
      building: 'A',
      floor: 1,
      position: 1,
      unitNumber: '101',
      label: 'A-101',
      unitType: 'FLAT',
      bhk: '3BHK',
    });
    expect(d.sample[75]).toMatchObject({ floor: 20, position: 4, unitNumber: '2004', label: 'A-2004' });
    expect(d.sample.some((s: any) => s.floor === 13)).toBe(false);
    expect(await Unit.count({ where: { societyId: society.id! } })).toBe(0);
    expect(await Building.count({ where: { societyId: society.id! } })).toBe(0);
    // without the skip floor: 80 units
    expect((await preview(c, params({ skipFloors: [] }))).body.data.summary.units).toBe(80);
  });

  it('the hash is stable for the same inputs and changes with any input, the pattern or the floor labels', async () => {
    const { c } = await setupSociety();
    const h = async (body: unknown) => (await preview(c, body)).body.data.previewHash as string;
    const a = await h(params());
    expect(await h(params())).toBe(a);
    // key order and optional defaults do not matter
    expect(
      await h({
        pattern: '{floor}{pos:2}',
        skipFloors: [13],
        floorTo: 20,
        floorFrom: 1,
        buildings: [tower('A')],
        positions: [4, 3, 2, 1].map(position => ({ bhk: '3BHK', position, unitType: 'FLAT' })),
      }),
    ).toBe(a);
    expect(await h(params({ floorTo: 19 }))).not.toBe(a);
    expect(await h(params({ pattern: '{floor}0{pos}' }))).not.toBe(a);
    expect(await h(params({ skipFloors: [12] }))).not.toBe(a);
    expect(await h(params({ buildings: [tower('B')] }))).not.toBe(a);
    expect(
      await h(params({ positions: [1, 2, 3, 4].map(position => ({ position, bhk: '2BHK' })) })),
    ).not.toBe(a);
    const g = params({ floorFrom: 0, floorTo: 2, skipFloors: [], pattern: '{floor}{pos}' });
    const before = await h(g);
    await c('patch', '/society/settings', {
      changes: [{ key: 'structure.groundFloorLabel', value: 'GF', version: 0 }],
    });
    expect(await h(g)).not.toBe(before);
  });

  it('skip floors and skip cells, per-position types and areas, countable total, and a pattern with the building and a running number', async () => {
    const { c } = await setupSociety();
    const r = await preview(
      c,
      params({
        buildings: [tower('A'), tower('B')],
        floorFrom: 1,
        floorTo: 3,
        skipFloors: [2],
        skipCells: [{ floor: 3, position: 2 }],
        positions: [
          { position: 1, unitType: 'FLAT', bhk: '2BHK', carpetAreaSqft: '800' },
          { position: 2, unitType: 'SHOP' },
          { position: 3, unitType: 'PARKING_ONLY' },
        ],
        pattern: '{building}{seq:3}',
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // 2 buildings x (floor 1: 3 cells, floor 3: 2 cells) = 10 units; 3 of the 5 cells of a building are countable
    expect(r.body.data.summary).toMatchObject({ units: 10, countableUnits: 6 });
    expect(r.body.data.sample.map((s: any) => s.unitNumber)).toEqual([
      'A001',
      'A002',
      'A003',
      'A004',
      'A005',
      'B006',
      'B007',
      'B008',
      'B009',
      'B010',
    ]);
    expect(r.body.data.sample.map((s: any) => s.label).slice(0, 2)).toEqual(['A-A001', 'A-A002']);
  });

  it('basement and ground floors render as labels', async () => {
    const { c } = await setupSociety();
    const r = await preview(
      c,
      params({
        floorFrom: -2,
        floorTo: 1,
        skipFloors: [],
        positions: [{ position: 1 }, { position: 2 }],
        pattern: '{floor}{pos}',
      }),
    );
    expect(r.body.data.sample.map((s: any) => s.unitNumber)).toEqual([
      'B21',
      'B22',
      'B11',
      'B12',
      'G1',
      'G2',
      '11',
      '12',
    ]);
  });

  it('BR-08-30 the limits of a run: 2,000 units, 200 skipped cells, floors and positions', async () => {
    const { c } = await setupSociety();
    const many = (n: number) => Array.from({ length: n }, (_, i) => tower(`T${i}`));
    const fifty = Array.from({ length: 50 }, (_, i) => ({ position: i + 1 }));
    const ok = await preview(
      c,
      params({
        buildings: many(8),
        floorFrom: 1,
        floorTo: 5,
        skipFloors: [],
        positions: fifty,
        pattern: '{floor}{pos:2}',
      }),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.summary.units).toBe(2000);
    expect(ok.body.data.sample).toHaveLength(200);
    expect(ok.body.data.sampleCount).toBe(2000);
    const big = await preview(
      c,
      params({
        buildings: many(9),
        floorFrom: 1,
        floorTo: 5,
        skipFloors: [],
        positions: fifty,
        pattern: '{floor}{pos:2}',
      }),
    );
    expect([big.status, big.body.code]).toEqual([422, 'GENERATOR_TOO_LARGE']);
    // one skipped cell makes the 2,001st unit fit
    const fits = await preview(
      c,
      params({
        buildings: many(9),
        floorFrom: 1,
        floorTo: 5,
        skipFloors: [],
        skipCells: [],
        positions: fifty,
        pattern: '{building}{seq}',
      }),
    );
    expect(fits.body.code).toBe('GENERATOR_TOO_LARGE');
    const cells = Array.from({ length: 201 }, (_, i) => ({ floor: 1 + (i % 5), position: 1 + (i % 50) }));
    expect((await preview(c, params({ skipCells: cells }))).body.code).toBe('VALIDATION_FAILED');
  });

  it('pattern errors: unknown token or character is 400 PATTERN_INVALID; no floor and position is 422 PATTERN_NOT_UNIQUE', async () => {
    const { c } = await setupSociety();
    const code = async (pattern: string, over: Record<string, unknown> = {}) => {
      const r = await preview(c, params({ pattern, ...over }));
      return [r.status, r.body.code];
    };
    expect(await code('a{pos}')).toEqual([400, 'PATTERN_INVALID']);
    expect(await code('{flor}{pos}')).toEqual([400, 'PATTERN_INVALID']);
    expect(await code('{floor:9}{pos}')).toEqual([400, 'PATTERN_INVALID']);
    expect(await code('{pos}')).toEqual([422, 'PATTERN_NOT_UNIQUE']);
    expect(await code('{floor}')).toEqual([422, 'PATTERN_NOT_UNIQUE']);
    expect(
      await code('{building}{building}{floor}{pos}ABCDEFGH', {
        buildings: [tower('ABCDEF')],
        floorTo: 3,
        skipFloors: [],
      }),
    ).toEqual([400, 'PATTERN_INVALID']); // 22 characters
    const wide = Array.from({ length: 30 }, (_, i) => ({ position: i + 1 }));
    expect(await code('{floor}{posAlpha}', { positions: wide })).toEqual([400, 'PATTERN_INVALID']);
    // {floor}{pos} gives 111 to (1, 11) and (11, 1): the run cannot be committed
    const eleven = Array.from({ length: 11 }, (_, i) => ({ position: i + 1 }));
    expect(await code('{floor}{pos}', { floorTo: 12, skipFloors: [], positions: eleven })).toEqual([
      422,
      'PATTERN_NOT_UNIQUE',
    ]);
  });

  it('request validation: positions 1 to n each once, skips inside the range, floor order', async () => {
    const { c } = await setupSociety();
    const code = async (over: Record<string, unknown>) => {
      const r = await preview(c, params(over));
      return [r.status, r.body.code];
    };
    expect(await code({ positions: [{ position: 1 }, { position: 3 }] })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code({ positions: [{ position: 1 }, { position: 1 }] })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code({ skipFloors: [25] })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code({ skipCells: [{ floor: 1, position: 9 }] })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code({ floorFrom: 5, floorTo: 2, skipFloors: [] })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code({ positions: [{ position: 1, bhk: '2BHK', unitType: 'SHOP' }] })).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
    expect(
      await code({ positions: [{ position: 1, carpetAreaSqft: '900', builtUpAreaSqft: '800' }] }),
    ).toEqual([422, 'AREA_ORDER_INVALID']);
    expect(await code({ skipFloors: Array.from({ length: 20 }, (_, i) => i + 1) })).toEqual([
      400,
      'VALIDATION_FAILED',
    ]); // nothing left
  });

  it('existing buildings: unknown, other society, archived, wings and floor range are refused', async () => {
    const { c } = await setupSociety();
    const a = await makeBuilding(c, { code: 'A', floorsAboveGround: 10 });
    const code = async (b: Record<string, unknown>, over: Record<string, unknown> = {}) => {
      const r = await preview(c, params({ buildings: [b], floorTo: 5, skipFloors: [], ...over }));
      return [r.status, r.body.code];
    };
    expect(await code({ buildingId: a.id })).toEqual([200, undefined]);
    expect(await code({ buildingId: 99999999 })).toEqual([404, 'BUILDING_NOT_FOUND']);
    expect(await code({ buildingId: a.id }, { floorTo: 11 })).toEqual([422, 'FLOOR_OUT_OF_RANGE']);
    expect(await code({ buildingId: a.id }, { floorFrom: -1 })).toEqual([422, 'FLOOR_OUT_OF_RANGE']);
    const other = await setupSociety({ name: 'Other CHS' });
    const ob = await makeBuilding(other.c, { code: 'A' });
    expect(await code({ buildingId: ob.id })).toEqual([404, 'BUILDING_NOT_FOUND']);
    const t = await makeBuilding(c, { code: 'T' });
    await makeBuilding(c, { code: 'T1', kind: 'WING', parentBuildingId: t.id });
    expect(await code({ buildingId: t.id })).toEqual([422, 'BUILDING_STRUCTURE_CONFLICT']);
    const z = await makeBuilding(c, { code: 'Z' });
    await c('post', `/buildings/${z.id}/archive`, { version: 1, reason: 'Closed for rebuilding' });
    expect(await code({ buildingId: z.id })).toEqual([422, 'BUILDING_ARCHIVED']);
    // a building listed twice
    const dup = await preview(
      c,
      params({ buildings: [{ buildingId: a.id }, { buildingId: a.id }], floorTo: 5, skipFloors: [] }),
    );
    expect(dup.status).toBe(400);
  });

  it('new buildings: a used code (any status) is 409 BUILDING_CODE_TAKEN, also twice in one request; wings need a valid tower', async () => {
    const { c } = await setupSociety();
    const a = await makeBuilding(c, { code: 'A' });
    await c('post', `/buildings/${a.id}/archive`, { version: 1, reason: 'Closed for rebuilding' });
    const code = async (b: unknown[]) => {
      const r = await preview(c, params({ buildings: b, floorTo: 3, skipFloors: [] }));
      return [r.status, r.body.code];
    };
    expect(await code([tower('A')])).toEqual([409, 'BUILDING_CODE_TAKEN']);
    expect(await code([tower('b'), tower('B')])).toEqual([409, 'BUILDING_CODE_TAKEN']);
    expect(await code([tower('B'), tower('C')])).toEqual([200, undefined]);
    expect(await code([tower('W', { kind: 'WING' })])).toEqual([200, undefined]); // checked at commit by the building rules
    const r = await commit(
      c,
      params({ buildings: [tower('W', { kind: 'WING' })], floorTo: 3, skipFloors: [] }),
    );
    expect([r.status, r.body.code]).toEqual([422, 'PARENT_BUILDING_INVALID']);
  });

  it('is limited to residents.units.create and rate limited to 60 a minute per user', async () => {
    const { society, c } = await setupSociety();
    const m = await memberOf(society, 'committee_member');
    expect((await preview(m.c, params())).status).toBe(403);
    const body = params({ floorTo: 1, skipFloors: [] });
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await preview(c, body)).status);
    expect(statuses.filter(s => s === 200)).toHaveLength(60);
    expect(statuses[60]).toBe(429);
  });
});

describe('POST /units/generator/commit (8.14, BR-08-32)', () => {
  it('T08-07 creates 76 units in one transaction: counter 76, onFlatCountChanged once, audit rows, location node, STRUCTURE check passes', async () => {
    const { society, c } = await setupSociety();
    const spy = vi.spyOn(subscriptions, 'onFlatCountChanged');
    const body = params();
    const p = await preview(c, body);
    const r = await c(
      'post',
      '/units/generator/commit',
      { ...body, previewHash: p.body.data.previewHash },
      { headers: idemKey() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const d = r.body.data;
    expect(d).toMatchObject({ created: 76, used: 76, limit: 1000 });
    expect(d.unitIds).toHaveLength(76);
    expect(d.buildingsCreated).toHaveLength(1);
    expect(await flatsUsed(society.id!)).toBe(76);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await Unit.count({ where: { societyId: society.id!, status: 'ACTIVE' } })).toBe(76);
    const b = (await Building.findByPk(d.buildingsCreated[0]))!;
    expect(b).toMatchObject({
      code: 'A',
      name: 'Tower A',
      kind: 'TOWER',
      floorsAboveGround: 20,
      basements: 0,
      status: 'ACTIVE',
    });
    expect(await LocationNode.count({ where: { buildingId: b.id!, nodeType: 'BUILDING' } })).toBe(1);
    const u = (await Unit.findOne({ where: { societyId: society.id!, label: 'A-2004' } }))!;
    expect(u).toMatchObject({
      floor: 20,
      positionOnFloor: 4,
      unitNumber: '2004',
      unitType: 'FLAT',
      bhk: '3BHK',
      isBillable: true,
      version: 1,
    });
    const generated = await audits(society.id!, 'setup.unit.generated');
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ entityType: 'building', entityId: String(b.id) });
    expect((generated[0]!.after as any).unitIds).toHaveLength(76);
    expect(await audits(society.id!, 'setup.building.created')).toHaveLength(1);
    const onb = await c('get', '/onboarding');
    expect(onb.body.data.steps.find((s: any) => s.stepKey === 'STRUCTURE')).toMatchObject({
      checkState: 'PASS',
      summary: '1 building, 76 units',
    });
    spy.mockRestore();
  });

  it('new buildings take their floors from the run and sort after the existing ones; several buildings in one run', async () => {
    const { society, c } = await setupSociety();
    await makeBuilding(c, { code: 'X', floorsAboveGround: 1 });
    const r = await commit(
      c,
      params({
        buildings: [tower('A'), tower('B')],
        floorFrom: -1,
        floorTo: 3,
        skipFloors: [],
        positions: [{ position: 1 }],
        pattern: '{floor}{pos}',
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ created: 10, used: 10 });
    const rows = await Building.findAll({
      where: { societyId: society.id! },
      order: [
        ['sortOrder', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    expect(rows.map(b => [b.code, b.floorsAboveGround, b.basements])).toEqual([
      ['X', 1, 0],
      ['A', 3, 1],
      ['B', 3, 1],
    ]);
    expect((await audits(society.id!, 'setup.unit.generated')).map(a => a.entityLabel)).toEqual(['A', 'B']);
    expect(await Unit.count({ where: { societyId: society.id!, label: 'B-B11' } })).toBe(1);
  });

  it('generates into an existing building and derives the billing area from billing.areaBasis', async () => {
    const { society, c } = await setupSociety();
    const a = await makeBuilding(c, { code: 'A', floorsAboveGround: 5 });
    await c('patch', '/society/settings', {
      changes: [{ key: 'billing.areaBasis', value: 'BUILT_UP', version: 0 }],
      reason: 'As per the bye-laws',
    });
    const r = await commit(c, {
      buildings: [{ buildingId: a.id }],
      floorFrom: 1,
      floorTo: 2,
      positions: [
        { position: 1, carpetAreaSqft: '900', builtUpAreaSqft: '1000' },
        { position: 2, carpetAreaSqft: '800' },
      ],
      pattern: '{floor}0{pos}',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.buildingsCreated).toEqual([]);
    const rows = await Unit.findAll({ where: { societyId: society.id! }, order: [['id', 'ASC']] });
    expect(rows.map(u => [u.label, u.areaSqft])).toEqual([
      ['A-101', '1000.000'],
      ['A-102', null],
      ['A-201', '1000.000'],
      ['A-202', null],
    ]);
  });

  it('PARKING_ONLY positions are created but do not count against the plan', async () => {
    const { society, c } = await setupSociety();
    const r = await commit(
      c,
      params({
        floorTo: 2,
        skipFloors: [],
        positions: [{ position: 1 }, { position: 2, unitType: 'PARKING_ONLY' }],
        pattern: '{floor}{pos}',
      }),
    );
    expect(r.body.data).toMatchObject({ created: 4, used: 2 });
    expect(await flatsUsed(society.id!)).toBe(2);
    expect(await Unit.count({ where: { societyId: society.id!, isBillable: false } })).toBe(2);
  });

  it('T08-08 a failure after the first inserts rolls everything back: no units, no building, no node, counter and audit untouched', async () => {
    const { society, c } = await setupSociety();
    const body = params({ floorTo: 30, skipFloors: [] }); // 120 units: two chunks
    const p = await preview(c, body);
    testHooks.afterUnitsInserted = n => {
      if (n >= 100) throw new Error('injected failure');
    };
    const r = await c(
      'post',
      '/units/generator/commit',
      { ...body, previewHash: p.body.data.previewHash },
      { headers: idemKey() },
    );
    testHooks.afterUnitsInserted = undefined;
    expect(r.status).toBe(500);
    expect(await Unit.count({ where: { societyId: society.id! } })).toBe(0);
    expect(await Building.count({ where: { societyId: society.id! } })).toBe(0);
    expect(await LocationNode.count({ where: { societyId: society.id! } })).toBe(0);
    expect(await flatsUsed(society.id!)).toBe(0);
    expect(await audits(society.id!, 'setup.unit.generated')).toHaveLength(0);
    expect(await audits(society.id!, 'setup.building.created')).toHaveLength(0);
    // the key was freed and the same request can be retried
    const again = await c(
      'post',
      '/units/generator/commit',
      { ...body, previewHash: p.body.data.previewHash },
      { headers: idemKey() },
    );
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it('T08-09 a hash from other inputs is 409 PREVIEW_STALE; nothing is written', async () => {
    const { society, c } = await setupSociety();
    const p = await preview(c, params());
    const changed = await c(
      'post',
      '/units/generator/commit',
      { ...params({ floorTo: 19 }), previewHash: p.body.data.previewHash },
      { headers: idemKey() },
    );
    expect([changed.status, changed.body.code]).toEqual([409, 'PREVIEW_STALE']);
    const junk = await c(
      'post',
      '/units/generator/commit',
      { ...params(), previewHash: 'a'.repeat(64) },
      { headers: idemKey() },
    );
    expect(junk.body.code).toBe('PREVIEW_STALE');
    const noHash = await c('post', '/units/generator/commit', params(), { headers: idemKey() });
    expect(noHash.body.code).toBe('VALIDATION_FAILED');
    expect(await Unit.count({ where: { societyId: society.id! } })).toBe(0);
    expect(await Building.count({ where: { societyId: society.id! } })).toBe(0);
  });

  it('US-08-02 a unit number that already exists is listed as a conflict in the preview and 409 UNIT_NUMBER_CONFLICT at commit', async () => {
    const { society, c } = await setupSociety();
    const a = await makeBuilding(c, { code: 'A', floorsAboveGround: 8 });
    await makeUnit(c, a.id, '702', 7);
    const body = {
      buildings: [{ buildingId: a.id }],
      floorFrom: 6,
      floorTo: 8,
      positions: [{ position: 1 }, { position: 2 }],
      pattern: '{floor}0{pos}',
    };
    const p = await preview(c, body);
    expect(p.body.data.conflicts).toEqual(['A-702']);
    expect(p.body.data.summary.conflicts).toBe(1);
    const r = await c(
      'post',
      '/units/generator/commit',
      { ...body, previewHash: p.body.data.previewHash },
      { headers: idemKey() },
    );
    expect([r.status, r.body.code]).toEqual([409, 'UNIT_NUMBER_CONFLICT']);
    expect(r.body.errors).toEqual([{ field: 'unitNumber', message: 'A-702' }]);
    expect(await Unit.count({ where: { societyId: society.id! } })).toBe(1);
    expect(await flatsUsed(society.id!)).toBe(1);
    // an ARCHIVED unit with the number is no conflict
    const u = (await Unit.findOne({ where: { unitNumber: '702' } }))!;
    await c('post', `/units/${u.id}/archive`, { version: 1, reason: 'Merged into 701' });
    expect((await commit(c, body)).status).toBe(201);
  });

  it('US-08-05 Starter with 290 flats: preview shows limitRemaining 10 and commit of 20 is 402 USAGE_LIMIT_EXCEEDED with nothing written', async () => {
    const { society, c } = await setupSociety({ plan: 'STARTER', flats: 290 });
    const body = params({
      floorTo: 5,
      skipFloors: [],
      positions: Array.from({ length: 4 }, (_, i) => ({ position: i + 1 })),
      pattern: '{floor}0{pos}',
    });
    const p = await preview(c, body);
    expect(p.body.data.summary).toMatchObject({
      units: 20,
      countableUnits: 20,
      limit: 300,
      used: 290,
      limitRemaining: 10,
    });
    const r = await c(
      'post',
      '/units/generator/commit',
      { ...body, previewHash: p.body.data.previewHash },
      { headers: idemKey() },
    );
    expect([r.status, r.body.code]).toEqual([402, 'USAGE_LIMIT_EXCEEDED']);
    expect(await Unit.count({ where: { societyId: society.id! } })).toBe(0);
    expect(await Building.count({ where: { societyId: society.id! } })).toBe(0);
    expect(await flatsUsed(society.id!)).toBe(290);
    // 10 fit exactly
    const ten = {
      ...body,
      floorTo: 3,
      skipCells: [
        { floor: 3, position: 3 },
        { floor: 3, position: 4 },
      ],
    };
    expect((await commit(c, ten)).body.data).toMatchObject({ created: 10, used: 300 });
  });

  it('a retry with the same Idempotency-Key replays the response: units are not created twice and the counter is consumed once', async () => {
    const { society, c } = await setupSociety();
    const body = params({ floorTo: 3, skipFloors: [] });
    const p = await preview(c, body);
    const headers = idemKey();
    const full = { ...body, previewHash: p.body.data.previewHash };
    const a = await c('post', '/units/generator/commit', full, { headers });
    const b = await c('post', '/units/generator/commit', full, { headers });
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.data).toEqual(a.body.data);
    expect(await Unit.count({ where: { societyId: society.id! } })).toBe(12);
    expect(await flatsUsed(society.id!)).toBe(12);
    expect((await c('post', '/units/generator/commit', full)).status).toBe(400); // no key at all
  });

  it('two parallel commits into the same building: one succeeds, the other is a conflict', async () => {
    const { society, c } = await setupSociety();
    const a = await makeBuilding(c, { code: 'A', floorsAboveGround: 10 });
    const body = {
      buildings: [{ buildingId: a.id }],
      floorFrom: 1,
      floorTo: 3,
      positions: [{ position: 1 }, { position: 2 }],
      pattern: '{floor}0{pos}',
    };
    const p = await preview(c, body);
    const full = { ...body, previewHash: p.body.data.previewHash };
    const rs = await Promise.all([
      c('post', '/units/generator/commit', full, { headers: idemKey() }),
      c('post', '/units/generator/commit', full, { headers: idemKey() }),
    ]);
    expect(rs.map(r => r.status).sort()).toEqual([201, 409]);
    expect(rs.find(r => r.status === 409)!.body.code).toBe('UNIT_NUMBER_CONFLICT');
    expect(await Unit.count({ where: { societyId: society.id! } })).toBe(6);
    expect(await flatsUsed(society.id!)).toBe(6);
  });

  it('a new WING of a tower without units is created with its units; the tower then refuses direct units', async () => {
    const { c } = await setupSociety();
    const t = await makeBuilding(c, { code: 'T', floorsAboveGround: 5 });
    const r = await commit(
      c,
      params({
        buildings: [tower('T1', { kind: 'WING', parentBuildingId: t.id })],
        floorTo: 2,
        skipFloors: [],
        positions: [{ position: 1 }],
        pattern: '{floor}0{pos}',
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const w = (await Building.findOne({ where: { code: 'T1' } }))!;
    expect(w).toMatchObject({ kind: 'WING', parentBuildingId: t.id });
    const direct = await c(
      'post',
      '/units',
      { buildingId: t.id, unitNumber: '101', floor: 1 },
      { headers: idemKey() },
    );
    expect(direct.body.code).toBe('BUILDING_STRUCTURE_CONFLICT');
  });

  it('is limited to residents.units.create', async () => {
    const { society, c } = await setupSociety();
    const m = await memberOf(society, 'committee_member');
    const p = await preview(c, params());
    const r = await m.c(
      'post',
      '/units/generator/commit',
      { ...params(), previewHash: p.body.data.previewHash },
      { headers: idemKey() },
    );
    expect(r.status).toBe(403);
    void setFlatsUsed;
  });
});
