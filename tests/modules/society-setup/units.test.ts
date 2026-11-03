import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, Invitation, Subscription, Unit, closeDb, sequelize } from '../../../src/models';
import { advance } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { subscriptions } from '../../../src/modules/subscriptions/subscriptions.public';
import { units } from '../../../src/modules/society-setup/society-setup.public';
import { as, login, resetLogins, roleOf } from '../../helpers/access';
import {
  flatsUsed,
  idemKey,
  makeBuilding,
  makeUnit,
  markLive,
  memberOf,
  rawUnits,
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
const patch = (c: any, id: number, body: Record<string, unknown>) => c('patch', `/units/${id}`, body);
const archive = (c: any, id: number, version: number, reason = 'Merged with the next flat') =>
  c('post', `/units/${id}/archive`, { version, reason });
const restore = (c: any, id: number, version: number) => c('post', `/units/${id}/restore`, { version });
const reload = async (id: number) => (await Unit.findByPk(id))!;

describe('POST /units (8.11)', () => {
  it('creates a unit with its label, a derived billing area and the plan counter; audits it', async () => {
    const { society, c } = await setupSociety();
    const spy = vi.spyOn(subscriptions, 'onFlatCountChanged');
    const b = await makeBuilding(c, { floorsAboveGround: 5, basements: 1 });
    const r = await c(
      'post',
      '/units',
      {
        buildingId: b.id,
        unitNumber: ' a-201 ',
        floor: 2,
        positionOnFloor: 1,
        bhk: '3BHK',
        carpetAreaSqft: '1150',
        builtUpAreaSqft: '1380.5',
        superBuiltUpAreaSqft: '1610',
        undividedSharePct: '1.25',
        possessionDate: '2010-04-01',
        notes: 'Corner flat',
      },
      { headers: idemKey() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      buildingId: b.id,
      buildingCode: 'A',
      buildingName: 'Tower A',
      label: 'A-A-201',
      unitNumber: 'A-201',
      floor: 2,
      floorLabel: '2',
      positionOnFloor: 1,
      unitType: 'FLAT',
      bhk: '3BHK',
      carpetAreaSqft: '1150.000',
      builtUpAreaSqft: '1380.500',
      superBuiltUpAreaSqft: '1610.000',
      areaSqft: '1150.000',
      undividedSharePct: '1.2500',
      isBillable: true,
      possessionDate: '2010-04-01',
      notes: 'Corner flat',
      status: 'ACTIVE',
      archivedAt: null,
      version: 1,
    });
    expect(await flatsUsed(society.id!)).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await Subscription.findOne({ where: { societyId: society.id! } }))!.billableFlats).toBe(1);
    const log = await audits(society.id!, 'setup.unit.created');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      entityType: 'unit',
      entityId: String(r.body.data.id),
      entityLabel: 'A-A-201',
    });
    spy.mockRestore();
  });

  it('requires an Idempotency-Key and replays the first response for the same key and body', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const body = { buildingId: b.id, unitNumber: '101', floor: 1 };
    expect((await c('post', '/units', body)).status).toBe(400);
    const headers = idemKey();
    const a = await c('post', '/units', body, { headers });
    const again = await c('post', '/units', body, { headers });
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.data.id).toBe(a.body.data.id);
    expect(await flatsUsed(society.id!)).toBe(1);
    const reused = await c('post', '/units', { ...body, unitNumber: '102' }, { headers });
    expect([reused.status, reused.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
  });

  it('the billing area follows billing.areaBasis (BR-08-23)', async () => {
    const { c } = await setupSociety();
    const b = await makeBuilding(c);
    await c('patch', '/society/settings', {
      changes: [{ key: 'billing.areaBasis', value: 'SUPER_BUILT_UP', version: 0 }],
      reason: 'As per the bye-laws',
    });
    const withSuper = await makeUnit(c, b.id, '101', 1, {
      carpetAreaSqft: '900',
      builtUpAreaSqft: '1000',
      superBuiltUpAreaSqft: '1100',
    });
    const without = await makeUnit(c, b.id, '102', 1, { carpetAreaSqft: '900' });
    expect(withSuper.areaSqft).toBe('1100.000');
    expect(without.areaSqft).toBeNull();
  });

  it('T08-14 carpet 1200 with built-up 1100 is 422 AREA_ORDER_INVALID; built-up above super too', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const r = await c(
      'post',
      '/units',
      { buildingId: b.id, unitNumber: '101', floor: 1, carpetAreaSqft: '1200', builtUpAreaSqft: '1100' },
      { headers: idemKey() },
    );
    expect([r.status, r.body.code]).toEqual([422, 'AREA_ORDER_INVALID']);
    const r2 = await c(
      'post',
      '/units',
      {
        buildingId: b.id,
        unitNumber: '101',
        floor: 1,
        builtUpAreaSqft: '1200',
        superBuiltUpAreaSqft: '1100',
      },
      { headers: idemKey() },
    );
    expect(r2.body.code).toBe('AREA_ORDER_INVALID');
    expect(await flatsUsed(society.id!)).toBe(0);
    const equal = await makeUnit(c, b.id, '103', 1, {
      carpetAreaSqft: '1000',
      builtUpAreaSqft: '1000',
      superBuiltUpAreaSqft: '1000',
    });
    expect(equal.areaSqft).toBe('1000.000');
  });

  it('BR-08-25 bhk only for flats; isBillable defaults by type; shops and offices are countable', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const shopBhk = await c(
      'post',
      '/units',
      { buildingId: b.id, unitNumber: 'S1', floor: 0, unitType: 'SHOP', bhk: '2BHK' },
      { headers: idemKey() },
    );
    expect([shopBhk.status, shopBhk.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const shop = await c(
      'post',
      '/units',
      { buildingId: b.id, unitNumber: 'S1', floor: 0, unitType: 'SHOP' },
      { headers: idemKey() },
    );
    expect(shop.body.data.isBillable).toBe(true);
    const office = await c(
      'post',
      '/units',
      { buildingId: b.id, unitNumber: 'O1', floor: 0, unitType: 'OFFICE', isBillable: false },
      { headers: idemKey() },
    );
    expect(office.body.data.isBillable).toBe(false);
    const parking = await c(
      'post',
      '/units',
      { buildingId: b.id, unitNumber: 'P1', floor: 0, unitType: 'PARKING_ONLY' },
      { headers: idemKey() },
    );
    expect(parking.body.data.isBillable).toBe(false);
    // shop, office (billable or not) count; parking does not
    expect(await flatsUsed(society.id!)).toBe(2);
    expect(await units.count(society.id!)).toBe(2);
  });

  it('T08-10 a full Starter plan refuses a FLAT with 402 USAGE_LIMIT_EXCEEDED but accepts PARKING_ONLY', async () => {
    const { society, c } = await setupSociety({ plan: 'STARTER', flats: 300 });
    const b = await makeBuilding(c);
    const flat = await c(
      'post',
      '/units',
      { buildingId: b.id, unitNumber: '101', floor: 1 },
      { headers: idemKey() },
    );
    expect([flat.status, flat.body.code]).toEqual([402, 'USAGE_LIMIT_EXCEEDED']);
    expect(await Unit.count({ where: { societyId: society.id! } })).toBe(0);
    const parking = await c(
      'post',
      '/units',
      { buildingId: b.id, unitNumber: 'P1', floor: 0, unitType: 'PARKING_ONLY' },
      { headers: idemKey() },
    );
    expect(parking.status, JSON.stringify(parking.body)).toBe(201);
    expect(await flatsUsed(society.id!)).toBe(300);
  });

  it('BR-08-19 a number is unique among ACTIVE units of the building, in any case; other buildings and archived numbers are free', async () => {
    const { c } = await setupSociety();
    const a = await makeBuilding(c, { code: 'A' });
    const b = await makeBuilding(c, { code: 'B' });
    const first = await makeUnit(c, a.id, '101', 1);
    const dup = await c(
      'post',
      '/units',
      { buildingId: a.id, unitNumber: '101', floor: 1 },
      { headers: idemKey() },
    );
    expect([dup.status, dup.body.code]).toEqual([409, 'UNIT_NUMBER_TAKEN']);
    expect(
      (await c('post', '/units', { buildingId: a.id, unitNumber: ' 101 ', floor: 2 }, { headers: idemKey() }))
        .body.code,
    ).toBe('UNIT_NUMBER_TAKEN');
    const other = await makeUnit(c, b.id, '101', 1);
    expect(other.label).toBe('B-101');
    expect((await archive(c, first.id, 1)).status).toBe(200);
    const again = await makeUnit(c, a.id, '101', 1);
    expect(again.label).toBe('A-101');
    // restoring the old one now clashes (edge case table)
    const r = await restore(c, first.id, 2);
    expect([r.status, r.body.code]).toEqual([409, 'UNIT_NUMBER_TAKEN']);
  });

  it('BR-08-21 and BR-08-16 floor range, archived buildings, buildings with wings and unknown buildings', async () => {
    const { society, c } = await setupSociety();
    const a = await makeBuilding(c, { code: 'A', floorsAboveGround: 3, basements: 1 });
    const code = async (body: Record<string, unknown>) => {
      const r = await c('post', '/units', { unitNumber: '1', floor: 1, ...body }, { headers: idemKey() });
      return [r.status, r.body.code];
    };
    expect(await code({ buildingId: a.id, floor: 4 })).toEqual([422, 'FLOOR_OUT_OF_RANGE']);
    expect(await code({ buildingId: a.id, floor: -2 })).toEqual([422, 'FLOOR_OUT_OF_RANGE']);
    expect(await code({ buildingId: a.id, floor: -1, unitNumber: 'B1' })).toEqual([201, undefined]);
    expect(await code({ buildingId: a.id, floor: 201 })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code({ buildingId: 99999999 })).toEqual([404, 'BUILDING_NOT_FOUND']);
    // a tower that holds units cannot receive wings, so the wing case uses a fresh tower
    const t = await makeBuilding(c, { code: 'T', floorsAboveGround: 3 });
    const w = await makeBuilding(c, {
      code: 'T1',
      kind: 'WING',
      parentBuildingId: t.id,
      floorsAboveGround: 3,
    });
    expect(await code({ buildingId: t.id })).toEqual([422, 'BUILDING_STRUCTURE_CONFLICT']);
    expect(await code({ buildingId: w.id })).toEqual([201, undefined]);
    const arch = await makeBuilding(c, { code: 'Z', floorsAboveGround: 3 });
    await c('post', `/buildings/${arch.id}/archive`, { version: 1, reason: 'Demolished tower' });
    expect(await code({ buildingId: arch.id })).toEqual([422, 'BUILDING_ARCHIVED']);
    // another society's building is not found
    const other = await setupSociety({ name: 'Other CHS' });
    const ob = await makeBuilding(other.c, { code: 'A' });
    expect(await code({ buildingId: ob.id })).toEqual([404, 'BUILDING_NOT_FOUND']);
    void society;
  });

  it('BR-08-24 the society total of undivided shares may not pass 100', async () => {
    const { c } = await setupSociety();
    const b = await makeBuilding(c);
    await makeUnit(c, b.id, '101', 1, { undividedSharePct: '60' });
    const r = await c(
      'post',
      '/units',
      { buildingId: b.id, unitNumber: '102', floor: 1, undividedSharePct: '40.0001' },
      { headers: idemKey() },
    );
    expect([r.status, r.body.code]).toEqual([422, 'SHARE_TOTAL_EXCEEDS_100']);
    const ok = await makeUnit(c, b.id, '102', 1, { undividedSharePct: '40' });
    expect(ok.label).toBe('A-102');
    // archived units free their share
    const first = (await Unit.findOne({ where: { unitNumber: '101' } }))!;
    await archive(c, first.id, 1);
    expect((await makeUnit(c, b.id, '103', 1, { undividedSharePct: '60' })).label).toBe('A-103');
  });

  it('refuses a possession date more than 5 years away', async () => {
    const { c } = await setupSociety();
    const b = await makeBuilding(c);
    const r = await c(
      'post',
      '/units',
      { buildingId: b.id, unitNumber: '101', floor: 1, possessionDate: '2032-01-01' },
      { headers: idemKey() },
    );
    expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(
      (
        await c(
          'post',
          '/units',
          { buildingId: b.id, unitNumber: '101', floor: 1, possessionDate: '2031-06-01' },
          { headers: idemKey() },
        )
      ).status,
    ).toBe(201);
  });
});

describe('PATCH /units/:id (8.11)', () => {
  it('edits fields, recomputes the label and area, audits only the changed fields and bumps the version', async () => {
    const { society, c } = await setupSociety();
    const a = await makeBuilding(c, { code: 'A' });
    const b = await makeBuilding(c, { code: 'B' });
    const u = await makeUnit(c, a.id, '101', 1, { carpetAreaSqft: '800' });
    const r = await patch(c, u.id, {
      version: 1,
      unitNumber: '102',
      buildingId: b.id,
      floor: 2,
      carpetAreaSqft: '900',
      bhk: '2BHK',
      notes: 'Moved',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      label: 'B-102',
      unitNumber: '102',
      buildingId: b.id,
      floor: 2,
      areaSqft: '900.000',
      bhk: '2BHK',
      version: 2,
    });
    const log = await audits(society.id!, 'setup.unit.updated');
    expect(log).toHaveLength(1);
    expect(Object.keys(log[0]!.after as object).sort()).toEqual([
      'bhk',
      'buildingId',
      'carpetAreaSqft',
      'floor',
      'notes',
      'unitNumber',
    ]);
    expect((log[0]!.before as any).unitNumber).toBe('101');
  });

  it('a request that changes nothing keeps the version; decimals compare as numbers', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const u = await makeUnit(c, b.id, '101', 1, { carpetAreaSqft: '800' });
    const r = await patch(c, u.id, { version: 1, carpetAreaSqft: '800.0', unitNumber: '101' });
    expect(r.status).toBe(200);
    expect(r.body.data.version).toBe(1);
    expect(await audits(society.id!, 'setup.unit.updated')).toHaveLength(0);
  });

  it('BR-08-23 areaSqft, label and status are not accepted from clients', async () => {
    const { c } = await setupSociety();
    const b = await makeBuilding(c);
    const u = await makeUnit(c, b.id, '101', 1);
    for (const k of ['areaSqft', 'label', 'status', 'archivedReason'])
      expect((await patch(c, u.id, { version: 1, [k]: 'x' })).status, k).toBe(400);
  });

  it('STALE_VERSION on a wrong version; INVALID_STATE on an archived unit; UNIT_NOT_FOUND on an unknown id', async () => {
    const { c } = await setupSociety();
    const b = await makeBuilding(c);
    const u = await makeUnit(c, b.id, '101', 1);
    expect((await patch(c, u.id, { version: 3, notes: 'x' })).body.code).toBe('STALE_VERSION');
    expect((await patch(c, 99999999, { version: 1, notes: 'x' })).body.code).toBe('UNIT_NOT_FOUND');
    await archive(c, u.id, 1);
    const r = await patch(c, u.id, { version: 2, notes: 'x' });
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('checks the rules on the merged unit: area order, floor range, number taken, wings, archived building, share', async () => {
    const { c } = await setupSociety();
    const a = await makeBuilding(c, { code: 'A', floorsAboveGround: 3 });
    const z = await makeBuilding(c, { code: 'Z', floorsAboveGround: 3 });
    const u1 = await makeUnit(c, a.id, '101', 1, { carpetAreaSqft: '800', builtUpAreaSqft: '900' });
    const u2 = await makeUnit(c, a.id, '102', 1, { undividedSharePct: '70' });
    expect((await patch(c, u1.id, { version: 1, carpetAreaSqft: '950' })).body.code).toBe(
      'AREA_ORDER_INVALID',
    );
    expect((await patch(c, u1.id, { version: 1, floor: 9 })).body.code).toBe('FLOOR_OUT_OF_RANGE');
    expect((await patch(c, u1.id, { version: 1, unitNumber: '102' })).body.code).toBe('UNIT_NUMBER_TAKEN');
    expect((await patch(c, u1.id, { version: 1, undividedSharePct: '31' })).body.code).toBe(
      'SHARE_TOTAL_EXCEEDS_100',
    );
    expect((await patch(c, u2.id, { version: 1, undividedSharePct: '100' })).status).toBe(200); // own share does not count twice
    await c('post', `/buildings/${z.id}/archive`, { version: 1, reason: 'Empty tower archived' });
    expect((await patch(c, u1.id, { version: 1, buildingId: z.id })).body.code).toBe('BUILDING_ARCHIVED');
    expect((await patch(c, u1.id, { version: 1, buildingId: 99999999 })).body.code).toBe(
      'BUILDING_NOT_FOUND',
    );
  });

  it('BR-08-20 a type change adjusts the counter; FLAT to PARKING_ONLY needs the BHK cleared in the same request', async () => {
    const { society, c } = await setupSociety();
    const spy = vi.spyOn(subscriptions, 'onFlatCountChanged');
    const b = await makeBuilding(c);
    const u = await makeUnit(c, b.id, '101', 1, { bhk: '2BHK' });
    expect(await flatsUsed(society.id!)).toBe(1);
    spy.mockClear();
    const noClear = await patch(c, u.id, { version: 1, unitType: 'PARKING_ONLY' });
    expect([noClear.status, noClear.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const r = await patch(c, u.id, { version: 1, unitType: 'PARKING_ONLY', bhk: null });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.isBillable).toBe(true); // unchanged unless sent
    expect(await flatsUsed(society.id!)).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    const back = await patch(c, u.id, { version: 2, unitType: 'SHOP' });
    expect(back.status).toBe(200);
    expect(await flatsUsed(society.id!)).toBe(1);
    // a full plan refuses a change to a countable type (402) and keeps the old type
    const p = await makeUnit(c, b.id, 'P1', 0, { unitType: 'PARKING_ONLY' });
    await setFlatsUsed(society.id!, 1000);
    const full = await patch(c, p.id, { version: 1, unitType: 'FLAT' });
    expect([full.status, full.body.code]).toEqual([402, 'USAGE_LIMIT_EXCEEDED']);
    expect((await reload(p.id)).unitType).toBe('PARKING_ONLY');
    spy.mockRestore();
  });

  it('T08-15 two parallel share edits that together pass 100: one succeeds, the other is SHARE_TOTAL_EXCEEDS_100', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const u1 = await makeUnit(c, b.id, '101', 1);
    const u2 = await makeUnit(c, b.id, '102', 1);
    const rs = await Promise.all([
      patch(c, u1.id, { version: 1, undividedSharePct: '60' }),
      patch(c, u2.id, { version: 1, undividedSharePct: '60' }),
    ]);
    expect(rs.map(r => r.status).sort()).toEqual([200, 422]);
    expect(rs.find(r => r.status === 422)!.body.code).toBe('SHARE_TOTAL_EXCEEDS_100');
    const rows = await Unit.findAll({ where: { societyId: society.id! } });
    expect(rows.filter(r => r.undividedSharePct !== null)).toHaveLength(1);
  });
});

describe('archive and restore (8.12, BR-08-26, BR-08-27)', () => {
  it('T08-12 archive then restore a FLAT: counter -1 then +1 and onFlatCountChanged twice', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const u = await makeUnit(c, b.id, '101', 1);
    const spy = vi.spyOn(subscriptions, 'onFlatCountChanged');
    const a = await archive(c, u.id, 1);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.data).toMatchObject({
      status: 'ARCHIVED',
      archivedReason: 'Merged with the next flat',
      version: 2,
    });
    expect(a.body.data.archivedAt).toBeTruthy();
    expect(await flatsUsed(society.id!)).toBe(0);
    const r = await restore(c, u.id, 2);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      status: 'ACTIVE',
      archivedAt: null,
      archivedReason: null,
      version: 3,
    });
    expect(await flatsUsed(society.id!)).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await audits(society.id!, 'setup.unit.archived'))[0]!.reason).toBe('Merged with the next flat');
    expect(await audits(society.id!, 'setup.unit.restored')).toHaveLength(1);
    spy.mockRestore();
  });

  it('archiving a PARKING_ONLY unit does not touch the counter or module 04', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const p = await makeUnit(c, b.id, 'P1', 0, { unitType: 'PARKING_ONLY' });
    const spy = vi.spyOn(subscriptions, 'onFlatCountChanged');
    await archive(c, p.id, 1);
    await restore(c, p.id, 2);
    expect(spy).not.toHaveBeenCalled();
    expect(await flatsUsed(society.id!)).toBe(0);
    spy.mockRestore();
  });

  it('T08-11 a registered guard blocks the archive: 409 UNIT_ARCHIVE_BLOCKED with the reasons, counter unchanged', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const u = await makeUnit(c, b.id, '101', 1);
    units.registerUnitGuard({ module: 'residents', check: async () => 'UNIT_HAS_RESIDENTS' });
    units.registerUnitGuard({
      module: 'billing',
      check: async (_s, _u, action) => (action === 'ARCHIVE' ? 'UNIT_HAS_BALANCE' : null),
    });
    units.registerUnitGuard({ module: 'parking', check: async () => null });
    const r = await archive(c, u.id, 1);
    expect([r.status, r.body.code]).toEqual([409, 'UNIT_ARCHIVE_BLOCKED']);
    expect(r.body.errors.map((e: any) => [e.field, e.message, e.module])).toEqual([
      ['module', 'UNIT_HAS_RESIDENTS', 'residents'],
      ['module', 'UNIT_HAS_BALANCE', 'billing'],
    ]);
    expect(await flatsUsed(society.id!)).toBe(1);
    expect((await reload(u.id)).status).toBe('ACTIVE');
    // a guard that lets the unit go (or a replaced guard) does not block
    units.registerUnitGuard({ module: 'residents', check: async () => null });
    units.registerUnitGuard({ module: 'billing', check: async () => null });
    expect((await archive(c, u.id, 1)).status).toBe(200);
  });

  it('guards receive the society, the unit, the action and the transaction', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const u = await makeUnit(c, b.id, '101', 1);
    const seen: unknown[][] = [];
    units.registerUnitGuard({
      module: 'spy',
      check: async (s, id, action, t) => {
        seen.push([s, id, action, typeof (t as any).commit]);
        return null;
      },
    });
    await archive(c, u.id, 1);
    expect(seen).toEqual([[society.id, u.id, 'ARCHIVE', 'function']]);
  });

  it('T08-37 restoring an ACTIVE unit, or archiving an ARCHIVED one, is 409 INVALID_STATE; a stale version is 409 STALE_VERSION', async () => {
    const { c } = await setupSociety();
    const b = await makeBuilding(c);
    const u = await makeUnit(c, b.id, '101', 1);
    const r = await restore(c, u.id, 1);
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
    expect((await archive(c, u.id, 4)).body.code).toBe('STALE_VERSION');
    await archive(c, u.id, 1);
    expect((await archive(c, u.id, 2)).body.code).toBe('INVALID_STATE');
    expect((await restore(c, u.id, 9)).body.code).toBe('STALE_VERSION');
    expect((await c('post', `/units/${u.id}/archive`, { version: 3, reason: 'abc' })).body.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('BR-08-27 restore needs an ACTIVE building and, for a countable unit, a free plan slot (402)', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const u = await makeUnit(c, b.id, '101', 1);
    await archive(c, u.id, 1);
    await setFlatsUsed(society.id!, 1000);
    const full = await restore(c, u.id, 2);
    expect([full.status, full.body.code]).toEqual([402, 'USAGE_LIMIT_EXCEEDED']);
    expect((await reload(u.id)).status).toBe('ARCHIVED');
    await setFlatsUsed(society.id!, 0);
    await c('post', `/buildings/${b.id}/archive`, { version: 1, reason: 'Tower archived for now' });
    const arch = await restore(c, u.id, 2);
    expect([arch.status, arch.body.code]).toEqual([422, 'BUILDING_ARCHIVED']);
  });
});

describe('DELETE /units/:id (8.12, BR-08-28)', () => {
  it('before go-live a unit can be deleted; the counter and module 04 follow; the audit row holds the whole row', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const u = await makeUnit(c, b.id, '101', 1, { carpetAreaSqft: '800' });
    const r = await c('delete', `/units/${u.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(204);
    expect(await Unit.count({ where: { societyId: society.id! } })).toBe(0);
    expect(await flatsUsed(society.id!)).toBe(0);
    const log = (await audits(society.id!, 'setup.unit.deleted'))[0]!;
    expect(log.before).toMatchObject({ label: 'A-101', carpetAreaSqft: '800.000' });
    expect((await c('delete', `/units/${u.id}`)).body.code).toBe('UNIT_NOT_FOUND');
  });

  it('deleting an ARCHIVED unit does not release the counter again', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const keep = await makeUnit(c, b.id, '102', 1);
    const u = await makeUnit(c, b.id, '101', 1);
    await archive(c, u.id, 1);
    expect(await flatsUsed(society.id!)).toBe(1);
    expect((await c('delete', `/units/${u.id}`)).status).toBe(204);
    expect(await flatsUsed(society.id!)).toBe(1);
    void keep;
  });

  it('T08-13 after go-live a unit older than 24 hours cannot be deleted (409 UNIT_DELETE_NOT_ALLOWED); a young one can', async () => {
    const { society, user, c } = await setupSociety();
    const b = await makeBuilding(c);
    const old = await makeUnit(c, b.id, '101', 1);
    advance(25 * 3_600_000);
    resetLogins();
    const c2 = as(await login(user));
    const young = await makeUnit(c2, b.id, '102', 1);
    await markLive(society.id!);
    const r = await c2('delete', `/units/${old.id}`);
    expect([r.status, r.body.code]).toEqual([409, 'UNIT_DELETE_NOT_ALLOWED']);
    expect((await c2('delete', `/units/${young.id}`)).status).toBe(204);
    // older than a day but the society is not live: allowed
    const other = await setupSociety({ name: 'Not Live CHS' });
    const ob = await makeBuilding(other.c);
    const ou = await makeUnit(other.c, ob.id, '101', 1);
    advance(48 * 3_600_000);
    resetLogins();
    const oc = as(await login(other.user));
    expect((await oc('delete', `/units/${ou.id}`)).status).toBe(204);
  });

  it('a delete guard blocks with UNIT_IN_USE; a foreign key from another table does too', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c);
    const u = await makeUnit(c, b.id, '101', 1);
    units.registerUnitGuard({
      module: 'billing',
      check: async (_s, _u, action) => (action === 'DELETE' ? 'UNIT_HAS_BALANCE' : null),
    });
    const g = await c('delete', `/units/${u.id}`);
    expect([g.status, g.body.code]).toEqual([409, 'UNIT_IN_USE']);
    expect(g.body.errors[0].message).toBe('UNIT_HAS_BALANCE');
    units.registerUnitGuard({ module: 'billing', check: async () => null });
    // module 03 invitations reference units (foreign key added by this module)
    const role = await roleOf(society.id!, 'owner');
    await Invitation.create({
      societyId: society.id!,
      roleId: role.id!,
      name: 'Ravi',
      mobile: '9820055502',
      unitId: u.id,
      tokenHash: 'a'.repeat(64),
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 86_400_000),
      lastSentAt: new Date(),
      invitedUserId: (await Unit.findByPk(u.id))!.createdBy!,
    } as never);
    const fk = await c('delete', `/units/${u.id}`);
    expect([fk.status, fk.body.code]).toEqual([409, 'UNIT_IN_USE']);
    expect(await flatsUsed(society.id!)).toBe(1);
    expect(await Unit.count({ where: { id: u.id } })).toBe(1);
  });

  it('needs a recent sign-in (step-up) and residents.units.delete', async () => {
    const { society, user, c } = await setupSociety();
    const b = await makeBuilding(c);
    const u = await makeUnit(c, b.id, '101', 1);
    const treasurer = await memberOf(society, 'treasurer'); // view only
    expect((await treasurer.c('delete', `/units/${u.id}`)).status).toBe(403);
    advance(10 * 60_000);
    expect((await c('delete', `/units/${u.id}`)).body.code).toBe('REAUTH_REQUIRED');
    resetLogins();
    const fresh = as(await login(user));
    expect((await fresh('delete', `/units/${u.id}`)).status).toBe(204);
  });
});

describe('POST /units/bulk-update (8.13)', () => {
  async function tower() {
    const s = await setupSociety();
    const b = await makeBuilding(s.c, { floorsAboveGround: 5 });
    const ids: number[] = [];
    for (let f = 1; f <= 3; f++)
      for (let p = 1; p <= 2; p++)
        ids.push(
          (await makeUnit(s.c, b.id, `${f}0${p}`, f, { positionOnFloor: p, carpetAreaSqft: '800' })).id,
        );
    return { ...s, b, ids };
  }
  const bulk = (c: any, body: Record<string, unknown>) => c('post', '/units/bulk-update', body);

  it('updates units by id in one transaction, bumps versions and writes one audit row per unit plus a summary', async () => {
    const { society, c, ids } = await tower();
    const r = await bulk(c, {
      unitIds: ids,
      set: { bhk: '2BHK', builtUpAreaSqft: '950', isBillable: false },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual({ updated: 6, unitIds: [...ids].sort((a, b) => a - b) });
    const rows = await Unit.findAll({ where: { societyId: society.id! } });
    expect(
      rows.every(
        u => u.bhk === '2BHK' && u.builtUpAreaSqft === '950.000' && !u.isBillable && u.version === 2,
      ),
    ).toBe(true);
    expect(await audits(society.id!, 'setup.unit.updated')).toHaveLength(6);
    const summary = await audits(society.id!, 'setup.unit.bulk_updated');
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ entityType: 'society' });
  });

  it('selects by building, positions and a floor range', async () => {
    const { b, c, society } = await tower();
    const r = await bulk(c, {
      selector: { buildingId: b.id, positions: [2], floorFrom: 2, floorTo: 3 },
      set: { bhk: '3BHK' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.updated).toBe(2);
    const changed = await Unit.findAll({
      where: { societyId: society.id!, bhk: '3BHK' },
      order: [['id', 'ASC']],
    });
    expect(changed.map(u => u.unitNumber)).toEqual(['202', '302']);
    const wholeColumn = await bulk(c, {
      selector: { buildingId: b.id, positions: [1] },
      set: { possessionDate: '2025-01-01' },
    });
    expect(wholeColumn.body.data.updated).toBe(3);
  });

  it('refuses both or neither of unitIds and selector, an empty set, unknown fields and a selector over 500 units', async () => {
    const { b, c, ids } = await tower();
    expect((await bulk(c, { set: { bhk: '2BHK' } })).status).toBe(400);
    expect(
      (await bulk(c, { unitIds: ids, selector: { buildingId: b.id, positions: [1] }, set: { bhk: '2BHK' } }))
        .status,
    ).toBe(400);
    expect((await bulk(c, { unitIds: ids, set: {} })).status).toBe(400);
    expect((await bulk(c, { unitIds: ids, set: { notes: 'x' } })).status).toBe(400);
    expect((await bulk(c, { unitIds: [ids[0], ids[0]], set: { bhk: '2BHK' } })).status).toBe(400);
    const none = await bulk(c, { selector: { buildingId: b.id, positions: [9] }, set: { bhk: '2BHK' } });
    expect([none.status, none.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
  });

  it('a selector that matches more than 500 units is VALIDATION_FAILED', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c, { floorsAboveGround: 200 });
    await rawUnits(society.id!, b.id, 'A', 501);
    const r = await bulk(c, {
      selector: { buildingId: b.id, positions: Array.from({ length: 50 }, (_, i) => i + 1) },
      set: { bhk: '2BHK' },
    });
    expect([r.status, r.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(r.body.errors[0].field).toBe('selector');
    const rows = await Unit.findAll({ where: { societyId: society.id! }, attributes: ['id'], limit: 501 });
    const many = await bulk(c, { unitIds: rows.map(x => x.id).slice(0, 500), set: { bhk: '2BHK' } });
    expect(many.status, JSON.stringify(many.body)).toBe(200);
    expect(many.body.data.updated).toBe(500);
    expect((await bulk(c, { unitIds: rows.map(x => x.id), set: { bhk: '2BHK' } })).status).toBe(400);
  });

  it('404 UNIT_NOT_FOUND lists unknown, archived and other societies ids; nothing is written', async () => {
    const { society, c, ids } = await tower();
    const other = await setupSociety({ name: 'Other CHS' });
    const ob = await makeBuilding(other.c);
    const ou = await makeUnit(other.c, ob.id, '101', 1);
    await archive(c, ids[0]!, 1);
    const r = await bulk(c, { unitIds: [ids[0]!, ids[1]!, ou.id, 99999999], set: { bhk: '2BHK' } });
    expect([r.status, r.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
    expect(r.body.errors.map((e: any) => e.message).sort()).toEqual(
      [String(ids[0]), String(ou.id), '99999999'].sort(),
    );
    expect(await Unit.count({ where: { societyId: society.id!, bhk: '2BHK' } })).toBe(0);
  });

  it('collects area order errors for every unit (422) and bhk-on-non-flat errors (400); nothing is written', async () => {
    const { society, c, ids } = await tower();
    const area = await bulk(c, { unitIds: ids, set: { carpetAreaSqft: '900', builtUpAreaSqft: '850' } });
    expect([area.status, area.body.code]).toEqual([422, 'AREA_ORDER_INVALID']);
    expect(area.body.errors).toHaveLength(6);
    expect(area.body.errors[0].field).toMatch(/^\d+\.carpetAreaSqft$/);
    await bulk(c, { unitIds: [ids[0]!], set: { bhk: '2BHK' } });
    const bhk = await bulk(c, { unitIds: [ids[0]!, ids[1]!], set: { unitType: 'PARKING_ONLY' } });
    expect([bhk.status, bhk.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(bhk.body.errors[0].field).toBe(`${ids[0]}.bhk`);
    expect(await Unit.count({ where: { societyId: society.id!, carpetAreaSqft: '900.000' } })).toBe(0);
  });

  it('adjusts limit.flats by the net change once, refuses when the plan is full, and share totals count the whole selection', async () => {
    const { society, c, ids } = await tower();
    const spy = vi.spyOn(subscriptions, 'onFlatCountChanged');
    spy.mockClear();
    const park = await bulk(c, { unitIds: ids.slice(0, 4), set: { unitType: 'PARKING_ONLY', bhk: null } });
    expect(park.status, JSON.stringify(park.body)).toBe(200);
    expect(await flatsUsed(society.id!)).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);
    await setFlatsUsed(society.id!, 999);
    const back = await bulk(c, { unitIds: ids.slice(0, 4), set: { unitType: 'FLAT' } });
    expect([back.status, back.body.code]).toEqual([402, 'USAGE_LIMIT_EXCEEDED']);
    expect(await Unit.count({ where: { societyId: society.id!, unitType: 'PARKING_ONLY' } })).toBe(4);
    await setFlatsUsed(society.id!, 2);
    const share = await bulk(c, { unitIds: ids, set: { undividedSharePct: '20' } });
    expect([share.status, share.body.code]).toEqual([422, 'SHARE_TOTAL_EXCEEDS_100']);
    expect((await bulk(c, { unitIds: ids, set: { undividedSharePct: '16' } })).status).toBe(200);
    spy.mockRestore();
  });

  it('needs residents.units.edit', async () => {
    const { society, ids } = await tower();
    const treasurer = await memberOf(society, 'treasurer');
    expect((await bulk(treasurer.c, { unitIds: ids, set: { bhk: '2BHK' } })).status).toBe(403);
  });
});

describe('GET /units and GET /units/:id (8.10)', () => {
  async function sample() {
    const s = await setupSociety();
    const a = await makeBuilding(s.c, { code: 'A', floorsAboveGround: 5 });
    const b = await makeBuilding(s.c, { code: 'B', floorsAboveGround: 5, name: 'Tower B' });
    await s.c('patch', `/buildings/${b.id}`, { version: 1, sortOrder: 5 });
    const mk = (bid: number, n: string, f: number, extra: Record<string, unknown> = {}) =>
      makeUnit(s.c, bid, n, f, extra);
    const a101 = await mk(a.id, '101', 1, { positionOnFloor: 1, bhk: '2BHK', carpetAreaSqft: '800' });
    const a102 = await mk(a.id, '102', 1, { positionOnFloor: 2, bhk: '3BHK' });
    const a201 = await mk(a.id, '201', 2, { positionOnFloor: 1, bhk: '3BHK', carpetAreaSqft: '1200' });
    const b101 = await mk(b.id, '101', 1, { positionOnFloor: 1 });
    const shop = await mk(a.id, 'S1', 0, { unitType: 'SHOP' });
    await archive(s.c, a102.id, 1);
    return { ...s, a, b, a101, a102, a201, b101, shop };
  }
  const labels = (r: any) => r.body.data.map((u: any) => u.label);

  it('lists ACTIVE units in position order (building order, floor, position) with pagination', async () => {
    const { c } = await sample();
    const r = await c('get', '/units');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(labels(r)).toEqual(['A-S1', 'A-101', 'A-201', 'B-101']);
    expect(r.body.pagination).toEqual({ page: 1, limit: 20, total: 4, totalPages: 1 });
    expect(r.body.data[1]).toMatchObject({
      buildingCode: 'A',
      floorLabel: '1',
      areaSqft: '800.000',
      status: 'ACTIVE',
    });
    const page = await c('get', '/units', undefined, { query: { limit: '2', page: '2' } });
    expect(labels(page)).toEqual(['A-201', 'B-101']);
    expect(page.body.pagination).toEqual({ page: 2, limit: 2, total: 4, totalPages: 2 });
  });

  it('filters by status, building, floor, type, bhk, billable and missing area', async () => {
    const { c, a } = await sample();
    const q = async (query: Record<string, string>) => labels(await c('get', '/units', undefined, { query }));
    expect(await q({ status: 'ARCHIVED' })).toEqual(['A-102']);
    expect((await q({ status: 'ALL' })).length).toBe(5);
    expect(await q({ buildingId: String(a.id) })).toEqual(['A-S1', 'A-101', 'A-201']);
    expect(await q({ floor: '1' })).toEqual(['A-101', 'B-101']);
    expect(await q({ unitType: 'SHOP' })).toEqual(['A-S1']);
    expect(await q({ unitType: 'SHOP,FLAT' })).toHaveLength(4);
    expect(await q({ bhk: '3BHK' })).toEqual(['A-201']);
    expect(await q({ isBillable: 'false' })).toEqual([]);
    expect(await q({ missingArea: 'true' })).toEqual(['A-S1', 'B-101']);
    expect((await c('get', '/units', undefined, { query: { unitType: 'HOUSE' } })).status).toBe(400);
  });

  it('searches by label prefix or unit number and sorts', async () => {
    const { c } = await sample();
    const q = async (query: Record<string, string>) => labels(await c('get', '/units', undefined, { query }));
    expect(await q({ q: 'A-1' })).toEqual(['A-101']);
    expect(await q({ q: '101' })).toEqual(['A-101', 'B-101']);
    expect(await q({ q: 'b-' })).toEqual(['B-101']);
    expect(await q({ q: '%' })).toEqual([]);
    expect(await q({ sortBy: 'label', sortOrder: 'desc' })).toEqual(['B-101', 'A-S1', 'A-201', 'A-101']);
    expect(await q({ sortBy: 'areaSqft', sortOrder: 'desc' })).toContain('A-201');
    expect((await q({ sortBy: 'floor', sortOrder: 'asc' }))[0]).toBe('A-S1');
    expect((await c('get', '/units', undefined, { query: { sortBy: 'password' } })).status).toBe(400);
  });

  it('a tower id includes the units of its wings', async () => {
    const { society, c } = await setupSociety();
    const t = await makeBuilding(c, { code: 'T' });
    const w1 = await makeBuilding(c, { code: 'T1', kind: 'WING', parentBuildingId: t.id });
    const w2 = await makeBuilding(c, { code: 'T2', kind: 'WING', parentBuildingId: t.id });
    await makeUnit(c, w1.id, '101', 1);
    await makeUnit(c, w2.id, '101', 1);
    const r = await c('get', '/units', undefined, { query: { buildingId: String(t.id) } });
    expect(labels(r)).toEqual(['T1-101', 'T2-101']);
    expect(society.id).toBeTruthy();
  });

  it('GET /units/:id returns the full object; unknown and other societies ids are UNIT_NOT_FOUND', async () => {
    const { c, a101 } = await sample();
    const r = await c('get', `/units/${a101.id}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      label: 'A-101',
      buildingName: 'Tower A',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect((await c('get', '/units/99999999')).body.code).toBe('UNIT_NOT_FOUND');
    expect((await c('get', '/units/abc')).status).toBe(400);
    expect((await c('get', '/units/0')).status).toBe(400);
  });
});

describe('service API for other modules (8.30)', () => {
  it('get, listActive, getByLabel, lockActive and count scope by society and honour status', async () => {
    const { society, c } = await setupSociety();
    const other = await setupSociety({ name: 'Other CHS' });
    const b = await makeBuilding(c, { basements: 1 });
    const u1 = await makeUnit(c, b.id, '101', 1, { carpetAreaSqft: '900', bhk: '2BHK' });
    const u2 = await makeUnit(c, b.id, 'B1', -1, { unitType: 'PARKING_ONLY' });
    const u3 = await makeUnit(c, b.id, '103', 1);
    await archive(c, u3.id, 1);
    const dto = await units.get(society.id!, u1.id);
    expect(dto).toMatchObject({
      id: u1.id,
      societyId: society.id,
      buildingCode: 'A',
      label: 'A-101',
      floorLabel: '1',
      areaSqft: '900.000',
      status: 'ACTIVE',
    });
    expect(await units.get(society.id!, u3.id)).toMatchObject({ status: 'ARCHIVED' });
    expect(await units.get(other.society.id!, u1.id)).toBeNull();
    expect((await units.listActive(society.id!)).map(x => x.label)).toEqual(['A-B1', 'A-101']);
    expect((await units.listActive(society.id!, { unitTypes: ['PARKING_ONLY'] })).map(x => x.id)).toEqual([
      u2.id,
    ]);
    expect((await units.listActive(society.id!, { unitIds: [u1.id, u3.id] })).map(x => x.id)).toEqual([
      u1.id,
    ]);
    expect((await units.listActive(society.id!, { floor: -1 }))[0]).toMatchObject({ floorLabel: 'B1' });
    expect(await units.listActive(society.id!, { isBillable: false })).toHaveLength(1);
    expect(await units.listActive(other.society.id!)).toEqual([]);
    expect((await units.getByLabel(society.id!, 'a-101'))!.id).toBe(u1.id);
    expect(await units.getByLabel(society.id!, 'A-103')).toBeNull(); // archived
    expect(await units.getByLabel(other.society.id!, 'A-101')).toBeNull();
    expect(await units.count(society.id!)).toBe(1);
    await sequelize.transaction(async t => {
      expect((await units.lockActive(society.id!, u1.id, t)).label).toBe('A-101');
      await expect(units.lockActive(society.id!, u3.id, t)).rejects.toMatchObject({
        status: 404,
        code: 'UNIT_NOT_FOUND',
      });
      await expect(units.lockActive(other.society.id!, u1.id, t)).rejects.toMatchObject({
        code: 'UNIT_NOT_FOUND',
      });
    });
  });
});

void Subscription;
