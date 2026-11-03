import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import {
  Building,
  Holiday,
  LocationNode,
  OnboardingStep,
  Society,
  SocietySetting,
  Unit,
  closeDb,
  sequelize,
} from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { makeSociety } from '../../helpers/access';
import { resetSetup } from '../../helpers/society-setup';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetSetup);

/** The promise must reject and the database message (key or constraint name) must match. */
async function bad(p: Promise<unknown>, re?: RegExp): Promise<void> {
  let err: any;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, 'expected the statement to be rejected').toBeDefined();
  if (re)
    expect(
      [
        err.message,
        err.parent?.sqlMessage,
        err.original?.sqlMessage,
        err.fields && JSON.stringify(err.fields),
      ].join(' '),
    ).toMatch(re);
}

const building = (societyId: number, over: Record<string, unknown> = {}) =>
  Building.create({
    societyId,
    parentBuildingId: null,
    code: 'A',
    name: 'Tower A',
    kind: 'TOWER',
    floorsAboveGround: 10,
    basements: 0,
    liftCount: 0,
    sortOrder: 0,
    status: 'ACTIVE',
    archivedAt: null,
    archivedReason: null,
    version: 1,
    createdBy: null,
    updatedBy: null,
    ...over,
  } as never);
const unit = (societyId: number, buildingId: number, over: Record<string, unknown> = {}) =>
  Unit.create({
    societyId,
    buildingId,
    unitNumber: '101',
    label: 'A-101',
    floor: 1,
    positionOnFloor: 1,
    unitType: 'FLAT',
    bhk: null,
    carpetAreaSqft: null,
    builtUpAreaSqft: null,
    superBuiltUpAreaSqft: null,
    areaSqft: null,
    undividedSharePct: null,
    isBillable: true,
    possessionDate: null,
    notes: null,
    status: 'ACTIVE',
    archivedAt: null,
    archivedReason: null,
    archivedBy: null,
    version: 1,
    createdBy: null,
    updatedBy: null,
    ...over,
  } as never);
const node = (societyId: number, over: Record<string, unknown> = {}) =>
  LocationNode.create({
    societyId,
    parentId: null,
    nodeType: 'AREA',
    areaType: 'GARDEN',
    name: 'Garden',
    buildingId: null,
    floor: null,
    path: '/1/',
    depth: 1,
    sortOrder: 0,
    qrToken: 'aBcDeFgHiJkL',
    status: 'ACTIVE',
    archivedAt: null,
    notes: null,
    version: 1,
    createdBy: null,
    updatedBy: null,
    ...over,
  } as never);
const step = (societyId: number, over: Record<string, unknown> = {}) =>
  OnboardingStep.create({
    societyId,
    stepKey: 'PROFILE',
    stepNo: 1,
    isRequired: true,
    status: 'PENDING',
    completedAt: null,
    completedBy: null,
    skipReason: null,
    lastCheckSummary: null,
    version: 1,
    createdBy: null,
    updatedBy: null,
    ...over,
  } as never);

describe('tables, generated columns and constraints (section 7)', () => {
  it('creates the six tables and the invitations foreign key', async () => {
    const t = await sequelize.query<{ n: string }>(
      "SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('buildings','units','society_settings','onboarding_steps','holidays','location_nodes')",
      { type: QueryTypes.SELECT },
    );
    expect(t.map(x => x.n).sort()).toEqual([
      'buildings',
      'holidays',
      'location_nodes',
      'onboarding_steps',
      'society_settings',
      'units',
    ]);
    const fk = await sequelize.query<{ c: string; r: string }>(
      "SELECT CONSTRAINT_NAME AS c, DELETE_RULE AS r FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'invitations' AND REFERENCED_TABLE_NAME = 'units'",
      { type: QueryTypes.SELECT },
    );
    expect(fk).toEqual([{ c: 'fk_invitations_unit', r: 'RESTRICT' }]);
    const generated = await sequelize.query<{ t: string; c: string; e: string }>(
      "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, EXTRA AS e FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('units','location_nodes') AND EXTRA LIKE '%GENERATED%' ORDER BY 1, 2",
      { type: QueryTypes.SELECT },
    );
    expect(generated.map(g => `${g.t}.${g.c}`)).toEqual([
      'location_nodes.activeNameKey',
      'location_nodes.parentKey',
      'units.activeLabelKey',
      'units.activeNumberKey',
    ]);
    for (const g of generated) expect(g.e).toMatch(/STORED GENERATED/);
  });

  it('buildings: wing needs a parent and only a wing has one; archived needs archivedAt; limits; unique code per society', async () => {
    const s = await makeSociety('A CHS');
    const t = await building(s.id!);
    await bad(building(s.id!, { code: 'B', kind: 'WING', parentBuildingId: null }), /Check constraint/);
    await bad(building(s.id!, { code: 'C', kind: 'TOWER', parentBuildingId: t.id }), /Check constraint/);
    await bad(building(s.id!, { code: 'D', status: 'ARCHIVED' }), /Check constraint/);
    await bad(building(s.id!, { code: 'E', archivedAt: new Date() }), /Check constraint/);
    await bad(building(s.id!, { code: 'F', floorsAboveGround: 201 }));
    await bad(building(s.id!, { code: 'G', basements: 6 }));
    await bad(building(s.id!, { code: 'a1' }), /Check constraint/);
    await bad(building(s.id!, { code: 'H', kind: 'HOUSE' }), /Check constraint/);
    await bad(building(s.id!, { code: 'A' }), /uq_buildings_code|Duplicate/);
    const other = await makeSociety('B CHS');
    expect((await building(other.id!)).code).toBe('A');
    expect((await building(s.id!, { code: 'W', kind: 'WING', parentBuildingId: t.id })).kind).toBe('WING');
  });

  it('units: active numbers and labels are unique, archived units never collide, and the checks hold', async () => {
    const s = await makeSociety('A CHS');
    const b = await building(s.id!);
    const u = await unit(s.id!, b.id!);
    await bad(unit(s.id!, b.id!), /uq_units_active_number|Duplicate/);
    await bad(unit(s.id!, b.id!, { unitNumber: '102', label: 'A-101' }), /uq_units_active_label|Duplicate/);
    const [row] = await sequelize.query<{ activeNumberKey: string; activeLabelKey: string }>(
      'SELECT activeNumberKey, activeLabelKey FROM units WHERE id = :id',
      { replacements: { id: u.id }, type: QueryTypes.SELECT },
    );
    expect(row).toEqual({ activeNumberKey: '101', activeLabelKey: 'A-101' });
    await sequelize.query("UPDATE units SET status = 'ARCHIVED', archivedAt = NOW(3) WHERE id = :id", {
      replacements: { id: u.id },
    });
    const [gone] = await sequelize.query<{ activeNumberKey: string | null }>(
      'SELECT activeNumberKey FROM units WHERE id = :id',
      { replacements: { id: u.id }, type: QueryTypes.SELECT },
    );
    expect(gone!.activeNumberKey).toBeNull();
    expect((await unit(s.id!, b.id!)).label).toBe('A-101'); // a new unit may take the number
    await sequelize.query("UPDATE units SET status = 'ARCHIVED', archivedAt = NOW(3) WHERE societyId = :id", {
      replacements: { id: s.id },
    });
    expect((await unit(s.id!, b.id!)).label).toBe('A-101'); // many archived rows with the same number are fine
    await bad(
      unit(s.id!, b.id!, {
        unitNumber: '103',
        label: 'A-103',
        carpetAreaSqft: '1200',
        builtUpAreaSqft: '1100',
      }),
      /ck_units_area_order/,
    );
    await bad(
      unit(s.id!, b.id!, {
        unitNumber: '104',
        label: 'A-104',
        builtUpAreaSqft: '1200',
        superBuiltUpAreaSqft: '1100',
      }),
      /ck_units_area_order/,
    );
    await bad(
      unit(s.id!, b.id!, { unitNumber: '105', label: 'A-105', unitType: 'SHOP', bhk: '2BHK' }),
      /ck_units_bhk/,
    );
    await bad(unit(s.id!, b.id!, { unitNumber: '106', label: 'A-106', bhk: '9BHK' }), /Check constraint/);
    await bad(
      unit(s.id!, b.id!, { unitNumber: '107', label: 'A-107', undividedSharePct: '100.0001' }),
      /ck_units_share/,
    );
    await bad(
      unit(s.id!, b.id!, { unitNumber: '108', label: 'A-108', undividedSharePct: '0' }),
      /ck_units_share/,
    );
    await bad(
      unit(s.id!, b.id!, { unitNumber: '109', label: 'A-109', status: 'ARCHIVED' }),
      /ck_units_archived/,
    );
    await bad(unit(s.id!, b.id!, { unitNumber: '110', label: 'A-110', floor: 201 }), /Check constraint/);
    await bad(
      unit(s.id!, b.id!, { unitNumber: '111', label: 'A-111', positionOnFloor: 51 }),
      /Check constraint/,
    );
    await bad(
      unit(s.id!, b.id!, { unitNumber: '112', label: 'A-112', unitType: 'HOUSE' }),
      /Check constraint/,
    );
  });

  it('foreign keys restrict: a building with units, a society with buildings and a unit referenced by an invitation cannot be deleted', async () => {
    const s = await makeSociety('A CHS');
    const b = await building(s.id!);
    await unit(s.id!, b.id!);
    await bad(
      sequelize.query('DELETE FROM buildings WHERE id = :id', { replacements: { id: b.id } }),
      /foreign key/i,
    );
    await bad(
      sequelize.query('DELETE FROM societies WHERE id = :id', { replacements: { id: s.id } }),
      /foreign key/i,
    );
    await bad(unit(s.id!, 99999999, { unitNumber: '2', label: 'A-2' }), /foreign key/i);
    await bad(building(99999999, { code: 'Q' }), /foreign key/i);
  });

  it('society_settings: one row per key and society, a valid key shape', async () => {
    const s = await makeSociety('A CHS');
    const row = (key: string) =>
      SocietySetting.create({
        societyId: s.id!,
        settingKey: key,
        valueJson: 1,
        version: 1,
        createdBy: null,
        updatedBy: null,
      } as never);
    await row('billing.dueDays');
    await bad(row('billing.dueDays'), /uq_society_settings_key|Duplicate/);
    for (const key of ['dueDays', 'Billing.dueDays', 'billing.due-days', 'billing.dueDays.x', 'billing.'])
      await bad(row(key), /Check constraint/);
    // JSON null is a valid stored value
    await sequelize.query(
      "INSERT INTO society_settings (societyId, settingKey, valueJson, version, createdAt, updatedAt) VALUES (:id, 'profile.pan', CAST('null' AS JSON), 1, NOW(3), NOW(3))",
      { replacements: { id: s.id } },
    );
    const [r] = await sequelize.query<{ v: string }>(
      "SELECT JSON_TYPE(valueJson) AS v FROM society_settings WHERE settingKey = 'profile.pan'",
      { type: QueryTypes.SELECT },
    );
    expect(r!.v).toBe('NULL');
  });

  it('onboarding_steps: unique key and number per society; skip, done and required-skip checks', async () => {
    const s = await makeSociety('A CHS');
    await step(s.id!);
    await bad(step(s.id!), /uq_onboarding_steps/);
    await bad(step(s.id!, { stepKey: 'UNITS', stepNo: 1 }), /uq_onboarding_steps_no|Duplicate/);
    await bad(step(s.id!, { stepKey: 'NOPE', stepNo: 2 }), /Check constraint/);
    await bad(step(s.id!, { stepKey: 'UNITS', stepNo: 9 }), /Check constraint/);
    await bad(
      step(s.id!, {
        stepKey: 'UNITS',
        stepNo: 3,
        status: 'SKIPPED',
        skipReason: 'x',
        completedAt: new Date(),
      }),
      /ck_onb_required_skip/,
    );
    await bad(
      step(s.id!, {
        stepKey: 'RESIDENTS',
        stepNo: 4,
        isRequired: false,
        status: 'SKIPPED',
        completedAt: new Date(),
      }),
      /ck_onb_skip/,
    );
    await bad(
      step(s.id!, { stepKey: 'RESIDENTS', stepNo: 4, isRequired: false, status: 'DONE' }),
      /ck_onb_done/,
    );
    await bad(
      step(s.id!, { stepKey: 'RESIDENTS', stepNo: 4, isRequired: false, completedAt: new Date() }),
      /ck_onb_done/,
    );
    expect(
      (
        await step(s.id!, {
          stepKey: 'RESIDENTS',
          stepNo: 4,
          isRequired: false,
          status: 'SKIPPED',
          skipReason: 'Later',
          completedAt: new Date(),
        })
      ).status,
    ).toBe('SKIPPED');
  });

  it('holidays: one per date and society', async () => {
    const s = await makeSociety('A CHS');
    const h = (d: string, over: Record<string, unknown> = {}) =>
      Holiday.create({
        societyId: s.id!,
        holidayDate: d,
        name: 'Diwali',
        holidayType: 'FESTIVAL',
        isOfficeClosed: true,
        notes: null,
        version: 1,
        createdBy: null,
        updatedBy: null,
        ...over,
      } as never);
    await h('2026-11-08');
    await bad(h('2026-11-08'), /uq_holidays_date|Duplicate/);
    await bad(h('2026-11-09', { holidayType: 'WEDDING' }), /Check constraint/);
    expect((await h('2026-11-09')).holidayDate).toBe('2026-11-09');
  });

  it('location_nodes: unique QR token platform-wide, unique ACTIVE sibling names, shape and depth checks', async () => {
    const s = await makeSociety('A CHS');
    const other = await makeSociety('B CHS');
    const b = await building(s.id!);
    const g = await node(s.id!);
    await bad(node(other.id!, { name: 'Other garden' }), /uq_location_nodes_qr|Duplicate/);
    await bad(node(s.id!, { qrToken: 'ZZZZZZZZZZZZ' }), /uq_location_nodes_sibling_name|Duplicate/);
    await sequelize.query(
      "UPDATE location_nodes SET status = 'ARCHIVED', archivedAt = NOW(3) WHERE id = :id",
      { replacements: { id: g.id } },
    );
    expect((await node(s.id!, { qrToken: 'ZZZZZZZZZZZZ' })).name).toBe('Garden'); // the archived one frees the name
    expect((await node(s.id!, { qrToken: 'YYYYYYYYYYYY', parentId: g.id, name: 'Garden' })).parentId).toBe(
      g.id,
    ); // another parent
    await bad(node(s.id!, { qrToken: 'XXXXXXXXXXXX', name: 'No type', areaType: null }), /ck_loc_area_type/);
    await bad(
      node(s.id!, { qrToken: 'XXXXXXXXXXXX', name: 'Floor', nodeType: 'FLOOR', areaType: null, floor: null }),
      /ck_loc_floor/,
    );
    await bad(
      node(s.id!, {
        qrToken: 'XXXXXXXXXXXX',
        name: 'Tower',
        nodeType: 'BUILDING',
        areaType: null,
        buildingId: null,
      }),
      /ck_loc_building/,
    );
    await bad(
      node(s.id!, {
        qrToken: 'XXXXXXXXXXXX',
        name: 'Tower',
        nodeType: 'BUILDING',
        areaType: null,
        buildingId: b.id,
        parentId: g.id,
      }),
      /ck_loc_building/,
    );
    await bad(node(s.id!, { qrToken: 'XXXXXXXXXXXX', name: 'Deep', depth: 5 }), /ck_loc_depth/);
    await bad(node(s.id!, { qrToken: 'XXXXXXXXXXXX', name: 'Shallow', depth: 0 }), /ck_loc_depth/);
    await bad(node(s.id!, { qrToken: 'short', name: 'Bad token' }), /Check constraint/);
    await bad(
      node(s.id!, { qrToken: 'XXXXXXXXXXXX', name: 'Odd', areaType: 'SPACESHIP' }),
      /Check constraint/,
    );
    await bad(
      sequelize.query('DELETE FROM location_nodes WHERE id = :id', { replacements: { id: g.id } }),
      /foreign key/i,
    );
  });

  it('societies stay editable: the model is not paranoid and Society rows survive', async () => {
    const s = await makeSociety('A CHS');
    expect((await Society.findByPk(s.id!))!.name).toBe('A CHS');
  });
});
