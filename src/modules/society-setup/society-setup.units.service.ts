import { Op, QueryTypes, type Order, type Transaction, type WhereOptions } from 'sequelize';
import { Building, Unit, sequelize } from '../../models';
import { COUNTABLE_UNIT_TYPES, type Bhk, type UnitType } from '../../models/unit.model';
import { istDate, now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError, ValidationError, type FieldError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { UNIT_NUMBER_RE } from './society-setup.generator.pattern';
import { adjustFlats, isCountable } from './society-setup.limits';
import { isLive } from './society-setup.onboarding.service';
import { get as getSetting } from './society-setup.settings.service';
import {
  buildingNotFound,
  floorLabel,
  floorLabelSettings,
  inFloorRange,
  invalidState,
  isForeignKeyViolation,
  isUniqueViolation,
  staleVersion,
  unitNotFound,
  type FloorLabels,
} from './society-setup.shared';
import {
  AREA_COLUMN,
  AUDIT,
  ENTITY,
  type AreaBasis,
  type UnitDto,
  type UnitGuard,
} from './society-setup.types';

/**
 * Units (module 08 sections 5.4, 8.10 to 8.13, 8.30). Lock order everywhere (BR-08-29): societies (share changes only),
 * buildings by id, units by id. Every change of the countable total happens in the same transaction as the counter.
 */

// ------------------------------------------------------------------ guards (BR-08-26)
const guards = new Map<string, UnitGuard>();
/** Module 09, 11 and 19 register a guard; a guard with the same `module` replaces the earlier one. */
export const registerUnitGuard = (g: UnitGuard): void => {
  guards.set(g.module, g);
};
/** Test helper. */
export const clearUnitGuards = (): void => guards.clear();

async function guardReasons(
  societyId: number,
  unitId: number,
  action: 'ARCHIVE' | 'DELETE',
  t: Transaction,
): Promise<FieldError[]> {
  const out: FieldError[] = [];
  for (const g of guards.values()) {
    const reason = await g.check(societyId, unitId, action, t);
    if (reason) out.push({ field: 'module', message: reason, module: g.module });
  }
  return out;
}

// ------------------------------------------------------------------ views
export interface UnitView extends UnitDto {
  buildingName: string;
  notes: string | null;
  possessionDate: string | null;
  archivedAt: string | null;
  archivedReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function unitView(u: Unit, b: Pick<Building, 'code' | 'name'>, labels: FloorLabels): UnitView {
  return {
    id: u.id,
    societyId: u.societyId,
    buildingId: u.buildingId,
    buildingCode: b.code,
    buildingName: b.name,
    label: u.label,
    unitNumber: u.unitNumber,
    floor: u.floor,
    floorLabel: floorLabel(u.floor, labels),
    positionOnFloor: u.positionOnFloor,
    unitType: u.unitType,
    bhk: u.bhk,
    carpetAreaSqft: u.carpetAreaSqft,
    builtUpAreaSqft: u.builtUpAreaSqft,
    superBuiltUpAreaSqft: u.superBuiltUpAreaSqft,
    areaSqft: u.areaSqft,
    undividedSharePct: u.undividedSharePct,
    isBillable: Boolean(u.isBillable),
    possessionDate: u.possessionDate,
    notes: u.notes,
    status: u.status,
    archivedAt: u.archivedAt ? u.archivedAt.toISOString() : null,
    archivedReason: u.archivedReason,
    version: u.version,
    createdAt: u.createdAt!.toISOString(),
    updatedAt: u.updatedAt!.toISOString(),
  };
}

/** The contract of section 8.30 (no notes, dates or versions). */
export function publicDto(u: Unit, b: Pick<Building, 'code'>, labels: FloorLabels): UnitDto {
  return {
    id: u.id,
    societyId: u.societyId,
    buildingId: u.buildingId,
    buildingCode: b.code,
    label: u.label,
    unitNumber: u.unitNumber,
    floor: u.floor,
    floorLabel: floorLabel(u.floor, labels),
    positionOnFloor: u.positionOnFloor,
    unitType: u.unitType,
    bhk: u.bhk,
    areaSqft: u.areaSqft,
    carpetAreaSqft: u.carpetAreaSqft,
    builtUpAreaSqft: u.builtUpAreaSqft,
    superBuiltUpAreaSqft: u.superBuiltUpAreaSqft,
    undividedSharePct: u.undividedSharePct,
    isBillable: Boolean(u.isBillable),
    status: u.status,
  };
}

async function viewOf(societyId: number, id: number): Promise<UnitView> {
  const u = await Unit.findOne({ where: { id, societyId }, include: [{ model: Building }] });
  if (!u) throw unitNotFound();
  return unitView(u, (u as unknown as { Building: Building }).Building, await floorLabelSettings(societyId));
}

// ------------------------------------------------------------------ rules
interface UnitFields {
  buildingId: number;
  unitNumber: string;
  floor: number;
  positionOnFloor: number | null;
  unitType: UnitType;
  bhk: Bhk | null;
  carpetAreaSqft: string | null;
  builtUpAreaSqft: string | null;
  superBuiltUpAreaSqft: string | null;
  undividedSharePct: string | null;
  isBillable: boolean;
  possessionDate: string | null;
  notes: string | null;
}

const fiveYearsAhead = (): string => {
  const today = istDate(now());
  return `${Number(today.slice(0, 4)) + 5}${today.slice(4)}`;
};

export const defaultBillable = (t: UnitType): boolean => t !== 'PARKING_ONLY';
const num = (v: string | null): number | null => (v === null ? null : Number(v));

/** BR-08-25 and BR-08-22: bhk only for flats, area order carpet <= built-up <= super. */
export function assertUnitRules(f: UnitFields, field = (c: string) => c): void {
  if (f.bhk !== null && f.unitType !== 'FLAT')
    throw new ValidationError([{ field: field('bhk'), message: 'BHK is only for flats' }]);
  if (f.possessionDate && f.possessionDate > fiveYearsAhead())
    throw new ValidationError([
      { field: field('possessionDate'), message: 'Possession date is more than 5 years away' },
    ]);
  assertAreaOrder(f, field);
}

function assertAreaOrder(f: UnitFields, field = (c: string) => c): void {
  const c = num(f.carpetAreaSqft);
  const b = num(f.builtUpAreaSqft);
  const s = num(f.superBuiltUpAreaSqft);
  if ((c !== null && b !== null && c > b) || (b !== null && s !== null && b > s))
    throw new UnprocessableError(
      'AREA_ORDER_INVALID',
      'Carpet area cannot be above built-up, nor built-up above super built-up',
      [{ field: field('carpetAreaSqft'), message: 'Carpet <= built-up <= super built-up' }],
    );
}

/** BR-08-23: the billing area is the column the basis names, or null. */
export const billingArea = (
  f: Pick<UnitFields, 'carpetAreaSqft' | 'builtUpAreaSqft' | 'superBuiltUpAreaSqft'>,
  basis: AreaBasis,
): string | null => f[AREA_COLUMN[basis]];

async function areaBasisOf(societyId: number): Promise<AreaBasis> {
  return (await getSetting(societyId, 'billing.areaBasis')) as AreaBasis;
}

const numberTaken = () =>
  new AppError(409, 'UNIT_NUMBER_TAKEN', 'This unit number is already used in the building', [
    { field: 'unitNumber', message: 'Already used by an active unit' },
  ]);

async function lockSociety(societyId: number, t: Transaction): Promise<void> {
  await sequelize.query('SELECT id FROM societies WHERE id = :societyId FOR UPDATE', {
    replacements: { societyId },
    type: QueryTypes.SELECT,
    transaction: t,
  });
}

/**
 * BR-08-24: the society total of ACTIVE shares may not pass 100. The society row is locked by the caller. The sum is a
 * locking read (`FOR SHARE`) so that it sees what a parallel edit committed while this one waited for the society lock.
 */
async function assertShareTotal(
  societyId: number,
  addPct: string,
  exceptUnitIds: number[],
  t: Transaction,
): Promise<void> {
  const rows = await sequelize.query<{ isOver: number }>(
    `SELECT (COALESCE(SUM(undividedSharePct), 0) + CAST(:add AS DECIMAL(12,4)) > 100) AS isOver FROM units
      WHERE societyId = :societyId AND status = 'ACTIVE'${exceptUnitIds.length ? ' AND id NOT IN (:except)' : ''} FOR SHARE`,
    {
      replacements: { societyId, add: addPct, except: exceptUnitIds },
      type: QueryTypes.SELECT,
      transaction: t,
    },
  );
  if (Number(rows[0]?.isOver))
    throw new UnprocessableError(
      'SHARE_TOTAL_EXCEEDS_100',
      'The undivided shares of the society would pass 100%',
      [{ field: 'undividedSharePct', message: 'The total over all units must not exceed 100' }],
    );
}

async function lockBuildings(
  societyId: number,
  ids: number[],
  t: Transaction,
): Promise<Map<number, Building>> {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  const rows = await Building.findAll({
    where: { societyId, id: { [Op.in]: unique } },
    order: [['id', 'ASC']],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  const map = new Map(rows.map(b => [b.id!, b]));
  if (map.size !== unique.length) throw buildingNotFound();
  return map;
}

/** Checks that a building accepts units: ACTIVE, no ACTIVE wings, the floor inside its range (BR-08-16, BR-08-21). */
export async function assertBuildingAccepts(
  b: Building,
  floor: number | null,
  t: Transaction,
): Promise<void> {
  if (b.status !== 'ACTIVE')
    throw new UnprocessableError('BUILDING_ARCHIVED', 'This building is archived', [
      { field: 'buildingId', message: 'Restore the building first' },
    ]);
  if (await Building.count({ where: { parentBuildingId: b.id!, status: 'ACTIVE' }, transaction: t }))
    throw new UnprocessableError(
      'BUILDING_STRUCTURE_CONFLICT',
      'This tower has wings; add the unit to a wing',
      [{ field: 'buildingId', message: 'The building has active wings' }],
    );
  if (floor !== null && !inFloorRange(b, floor))
    throw new UnprocessableError('FLOOR_OUT_OF_RANGE', 'This floor is outside the building', [
      { field: 'floor', message: `Use a floor from ${-b.basements} to ${b.floorsAboveGround}` },
    ]);
}

// ------------------------------------------------------------------ list and get (8.10)
export interface ListUnitsQuery {
  buildingId?: number;
  floor?: number;
  unitType?: UnitType[];
  status: 'ACTIVE' | 'ARCHIVED' | 'ALL';
  bhk?: Bhk;
  isBillable?: boolean;
  missingArea?: boolean;
  q?: string;
  sortBy: 'position' | 'label' | 'floor' | 'areaSqft' | 'createdAt';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

export async function listUnits(societyId: number, q: ListUnitsQuery) {
  const where: WhereOptions[] = [{ societyId }];
  if (q.status !== 'ALL') where.push({ status: q.status });
  if (q.buildingId) {
    // a tower id includes its wings
    const wings = await Building.findAll({
      where: { societyId, parentBuildingId: q.buildingId },
      attributes: ['id'],
    });
    where.push({ buildingId: { [Op.in]: [q.buildingId, ...wings.map(w => w.id!)] } });
  }
  if (q.floor !== undefined) where.push({ floor: q.floor });
  if (q.unitType) where.push({ unitType: { [Op.in]: q.unitType } });
  if (q.bhk) where.push({ bhk: q.bhk });
  if (q.isBillable !== undefined) where.push({ isBillable: q.isBillable });
  if (q.missingArea) where.push({ areaSqft: null });
  if (q.q) {
    const like = q.q.replace(/[\\%_]/g, m => `\\${m}`);
    where.push({
      [Op.or]: [{ label: { [Op.like]: `${like}%` } }, { unitNumber: { [Op.like]: `%${like}%` } }],
    });
  }
  const dir = q.sortOrder.toUpperCase() as 'ASC' | 'DESC';
  const order: Order =
    q.sortBy === 'position'
      ? [
          [Building as never, 'sortOrder', dir],
          [Building as never, 'code', dir],
          ['floor', dir],
          ['positionOnFloor', dir],
          ['unitNumber', dir],
          ['id', dir],
        ]
      : [
          [q.sortBy, dir],
          ['id', 'ASC'],
        ];
  const { rows, count } = await Unit.findAndCountAll({
    where: { [Op.and]: where },
    include: [{ model: Building, attributes: ['id', 'code', 'name', 'sortOrder'], required: true }],
    order,
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
    distinct: true,
  });
  const labels = await floorLabelSettings(societyId);
  return {
    data: rows.map(u => unitView(u, (u as unknown as { Building: Building }).Building, labels)),
    pagination: pageMeta(q.page, q.limit, count),
  };
}

export const getUnit = (societyId: number, id: number): Promise<UnitView> => viewOf(societyId, id);

// ------------------------------------------------------------------ create (8.11)
export interface CreateUnitInput {
  buildingId: number;
  unitNumber: string;
  floor: number;
  positionOnFloor?: number | null;
  unitType?: UnitType;
  bhk?: Bhk | null;
  carpetAreaSqft?: string | null;
  builtUpAreaSqft?: string | null;
  superBuiltUpAreaSqft?: string | null;
  undividedSharePct?: string | null;
  isBillable?: boolean;
  possessionDate?: string | null;
  notes?: string | null;
}

export async function createUnit(ctx: Ctx, societyId: number, input: CreateUnitInput): Promise<UnitView> {
  const basis = await areaBasisOf(societyId);
  const id = await sequelize.transaction(async t => {
    const unitType = input.unitType ?? 'FLAT';
    const fields: UnitFields = {
      buildingId: input.buildingId,
      unitNumber: input.unitNumber,
      floor: input.floor,
      positionOnFloor: input.positionOnFloor ?? null,
      unitType,
      bhk: input.bhk ?? null,
      carpetAreaSqft: input.carpetAreaSqft ?? null,
      builtUpAreaSqft: input.builtUpAreaSqft ?? null,
      superBuiltUpAreaSqft: input.superBuiltUpAreaSqft ?? null,
      undividedSharePct: input.undividedSharePct ?? null,
      isBillable: input.isBillable ?? defaultBillable(unitType),
      possessionDate: input.possessionDate ?? null,
      notes: input.notes ?? null,
    };
    if (fields.undividedSharePct !== null) await lockSociety(societyId, t);
    const [b] = [...(await lockBuildings(societyId, [input.buildingId], t)).values()];
    await assertBuildingAccepts(b!, fields.floor, t);
    assertUnitRules(fields);
    if (fields.undividedSharePct !== null) await assertShareTotal(societyId, fields.undividedSharePct, [], t);
    const label = `${b!.code}-${fields.unitNumber}`;
    if (await Unit.count({ where: { societyId, label, status: 'ACTIVE' }, transaction: t }))
      throw numberTaken();
    let unit: Unit;
    try {
      unit = await Unit.create(
        {
          societyId,
          ...fields,
          label,
          areaSqft: billingArea(fields, basis),
          status: 'ACTIVE',
          archivedAt: null,
          archivedReason: null,
          archivedBy: null,
          version: 1,
          createdBy: ctx.user?.id ?? null,
          updatedBy: ctx.user?.id ?? null,
        },
        { transaction: t },
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw numberTaken();
      throw err;
    }
    if (isCountable(unitType)) await adjustFlats(ctx, societyId, 1, t);
    await audit(
      ctx,
      {
        action: AUDIT.unitCreated,
        entityType: ENTITY.unit,
        entityId: unit.id,
        entityLabel: label,
        societyId,
        after: { ...fields, label, areaSqft: unit.areaSqft },
      },
      t,
    );
    return unit.id;
  });
  return viewOf(societyId, id);
}

// ------------------------------------------------------------------ edit (8.11)
export type PatchUnitInput = Partial<CreateUnitInput> & { version: number };
const EDITABLE: (keyof UnitFields)[] = [
  'buildingId',
  'unitNumber',
  'floor',
  'positionOnFloor',
  'unitType',
  'bhk',
  'carpetAreaSqft',
  'builtUpAreaSqft',
  'superBuiltUpAreaSqft',
  'undividedSharePct',
  'isBillable',
  'possessionDate',
  'notes',
];

const DECIMAL_FIELDS = new Set([
  'carpetAreaSqft',
  'builtUpAreaSqft',
  'superBuiltUpAreaSqft',
  'undividedSharePct',
]);
/** Equal values; decimals compare as numbers ("1150" equals "1150.000"). */
const sameValue = (key: string, a: unknown, b: unknown): boolean =>
  DECIMAL_FIELDS.has(key) && a != null && b != null ? Number(a) === Number(b) : (a ?? null) === (b ?? null);

const pickFields = (u: Unit): UnitFields =>
  Object.fromEntries(EDITABLE.map(k => [k, u.get(k)])) as unknown as UnitFields;

export async function patchUnit(
  ctx: Ctx,
  societyId: number,
  unitId: number,
  input: PatchUnitInput,
): Promise<UnitView> {
  const basis = await areaBasisOf(societyId);
  await sequelize.transaction(async t => {
    const pre = await Unit.findOne({ where: { id: unitId, societyId }, transaction: t });
    if (!pre) throw unitNotFound();
    if (input.undividedSharePct !== undefined && input.undividedSharePct !== null)
      await lockSociety(societyId, t);
    const targetBuildingId = input.buildingId ?? pre.buildingId;
    const buildings = await lockBuildings(societyId, [pre.buildingId, targetBuildingId], t);
    const unit = await Unit.findOne({
      where: { id: unitId, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!unit) throw unitNotFound();
    if (unit.status !== 'ACTIVE') throw invalidState('Restore this unit before editing it');
    if (unit.version !== input.version) throw staleVersion('This unit');

    const cur = pickFields(unit);
    const merged: UnitFields = { ...cur };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of EDITABLE) {
      const v = (input as Record<string, unknown>)[k];
      const old = (cur as unknown as Record<string, unknown>)[k];
      if (v === undefined || sameValue(k, v, old)) continue;
      before[k] = old;
      after[k] = v;
      (merged as unknown as Record<string, unknown>)[k] = v;
    }
    if (!Object.keys(after).length) return;

    const target = buildings.get(targetBuildingId)!;
    const place = 'buildingId' in after || 'floor' in after;
    if (place) await assertBuildingAccepts(target, merged.floor, t);
    assertUnitRules(merged);
    if ('undividedSharePct' in after && merged.undividedSharePct !== null)
      await assertShareTotal(societyId, merged.undividedSharePct, [unit.id], t);

    const oldLabel = unit.label;
    const label = `${target.code}-${merged.unitNumber}`;
    if (
      label !== oldLabel &&
      (await Unit.count({
        where: { societyId, label, status: 'ACTIVE', id: { [Op.ne]: unit.id } },
        transaction: t,
      }))
    )
      throw numberTaken();

    const delta = Number(isCountable(merged.unitType)) - Number(isCountable(unit.unitType));
    unit.set({
      ...merged,
      label,
      areaSqft: billingArea(merged, basis),
      version: unit.version + 1,
      updatedBy: ctx.user?.id ?? null,
    } as never);
    try {
      await unit.save({ transaction: t });
    } catch (err) {
      if (isUniqueViolation(err)) throw numberTaken();
      throw err;
    }
    await adjustFlats(ctx, societyId, delta, t);
    await audit(
      ctx,
      {
        action: AUDIT.unitUpdated,
        entityType: ENTITY.unit,
        entityId: unit.id,
        entityLabel: label,
        societyId,
        before,
        after,
      },
      t,
    );
  });
  return viewOf(societyId, unitId);
}

// ------------------------------------------------------------------ archive, restore, delete (8.12)
async function lockOne(societyId: number, unitId: number, t: Transaction) {
  const pre = await Unit.findOne({ where: { id: unitId, societyId }, transaction: t });
  if (!pre) throw unitNotFound();
  const [b] = [...(await lockBuildings(societyId, [pre.buildingId], t)).values()];
  const unit = await Unit.findOne({ where: { id: unitId, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!unit) throw unitNotFound();
  return { unit, building: b! };
}

export async function archiveUnit(
  ctx: Ctx,
  societyId: number,
  unitId: number,
  input: { reason: string; version: number },
): Promise<UnitView> {
  await sequelize.transaction(async t => {
    const { unit } = await lockOne(societyId, unitId, t);
    if (unit.status === 'ARCHIVED') throw invalidState('This unit is already archived');
    if (unit.version !== input.version) throw staleVersion('This unit');
    const blocks = await guardReasons(societyId, unit.id, 'ARCHIVE', t);
    if (blocks.length)
      throw new AppError(409, 'UNIT_ARCHIVE_BLOCKED', 'This unit cannot be archived yet', blocks);
    unit.status = 'ARCHIVED';
    unit.archivedAt = now();
    unit.archivedReason = input.reason;
    unit.archivedBy = ctx.user?.id ?? null;
    unit.version += 1;
    unit.updatedBy = ctx.user?.id ?? null;
    await unit.save({ transaction: t });
    if (isCountable(unit.unitType)) await adjustFlats(ctx, societyId, -1, t);
    await audit(
      ctx,
      {
        action: AUDIT.unitArchived,
        entityType: ENTITY.unit,
        entityId: unit.id,
        entityLabel: unit.label,
        societyId,
        before: { status: 'ACTIVE' },
        after: { status: 'ARCHIVED' },
        reason: input.reason,
      },
      t,
    );
  });
  return viewOf(societyId, unitId);
}

export async function restoreUnit(
  ctx: Ctx,
  societyId: number,
  unitId: number,
  input: { version: number },
): Promise<UnitView> {
  await sequelize.transaction(async t => {
    const { unit, building } = await lockOne(societyId, unitId, t);
    if (unit.status === 'ACTIVE') throw invalidState('This unit is already active');
    if (unit.version !== input.version) throw staleVersion('This unit');
    await assertBuildingAccepts(building, unit.floor, t);
    if (await Unit.count({ where: { societyId, label: unit.label, status: 'ACTIVE' }, transaction: t }))
      throw numberTaken();
    unit.status = 'ACTIVE';
    unit.archivedAt = null;
    unit.archivedReason = null;
    unit.archivedBy = null;
    unit.version += 1;
    unit.updatedBy = ctx.user?.id ?? null;
    try {
      await unit.save({ transaction: t });
    } catch (err) {
      if (isUniqueViolation(err)) throw numberTaken();
      throw err;
    }
    if (isCountable(unit.unitType)) await adjustFlats(ctx, societyId, 1, t);
    await audit(
      ctx,
      {
        action: AUDIT.unitRestored,
        entityType: ENTITY.unit,
        entityId: unit.id,
        entityLabel: unit.label,
        societyId,
        before: { status: 'ARCHIVED' },
        after: { status: 'ACTIVE' },
      },
      t,
    );
  });
  return viewOf(societyId, unitId);
}

const DELETE_WINDOW_MS = 24 * 3_600_000;

/** BR-08-28: hard delete is for setup mistakes (before go-live, or within 24 hours of creation). */
export async function deleteUnit(ctx: Ctx, societyId: number, unitId: number): Promise<void> {
  await sequelize.transaction(async t => {
    const { unit } = await lockOne(societyId, unitId, t);
    const recent = now().getTime() - unit.createdAt!.getTime() < DELETE_WINDOW_MS;
    if (!recent && (await isLive(societyId, t)))
      throw new AppError(
        409,
        'UNIT_DELETE_NOT_ALLOWED',
        'The society is live and this unit is older than 24 hours. Archive it instead.',
      );
    const blocks = await guardReasons(societyId, unit.id, 'DELETE', t);
    if (blocks.length)
      throw new AppError(409, 'UNIT_IN_USE', 'This unit is used elsewhere. Archive it instead.', blocks);
    const row = unit.get({ plain: true });
    const countable = unit.status === 'ACTIVE' && isCountable(unit.unitType);
    try {
      await unit.destroy({ transaction: t });
    } catch (err) {
      if (isForeignKeyViolation(err))
        throw new AppError(409, 'UNIT_IN_USE', 'This unit is used elsewhere. Archive it instead.');
      throw err;
    }
    if (countable) await adjustFlats(ctx, societyId, -1, t);
    await audit(
      ctx,
      {
        action: AUDIT.unitDeleted,
        entityType: ENTITY.unit,
        entityId: row.id,
        entityLabel: row.label,
        societyId,
        before: row,
      },
      t,
    );
  });
}

// ------------------------------------------------------------------ bulk update (8.13)
export interface BulkUpdateInput {
  unitIds?: number[];
  selector?: { buildingId: number; positions: number[]; floorFrom?: number; floorTo?: number };
  set: Partial<
    Pick<
      CreateUnitInput,
      | 'unitType'
      | 'bhk'
      | 'carpetAreaSqft'
      | 'builtUpAreaSqft'
      | 'superBuiltUpAreaSqft'
      | 'undividedSharePct'
      | 'isBillable'
      | 'possessionDate'
    >
  >;
}
const MAX_BULK = 500;

async function resolveBulkIds(societyId: number, input: BulkUpdateInput): Promise<number[]> {
  if (input.unitIds) return [...input.unitIds].sort((a, b) => a - b);
  const s = input.selector!;
  const wings = await Building.findAll({
    where: { societyId, parentBuildingId: s.buildingId },
    attributes: ['id'],
  });
  const buildingIds = [s.buildingId, ...wings.map(w => w.id!)];
  const rows = await Unit.findAll({
    where: {
      societyId,
      status: 'ACTIVE',
      buildingId: { [Op.in]: buildingIds },
      positionOnFloor: { [Op.in]: s.positions },
      ...(s.floorFrom !== undefined || s.floorTo !== undefined
        ? { floor: { [Op.between]: [s.floorFrom ?? -5, s.floorTo ?? 200] } }
        : {}),
    },
    attributes: ['id'],
    order: [['id', 'ASC']],
    limit: MAX_BULK + 1,
  });
  if (rows.length > MAX_BULK)
    throw new ValidationError([
      { field: 'selector', message: `The selector matches more than ${MAX_BULK} units` },
    ]);
  return rows.map(r => r.id);
}

export async function bulkUpdate(ctx: Ctx, societyId: number, input: BulkUpdateInput) {
  const basis = await areaBasisOf(societyId);
  const ids = await resolveBulkIds(societyId, input);
  if (!ids.length) throw unitNotFound();
  const result = await sequelize.transaction(async t => {
    const pre = await Unit.findAll({
      where: { societyId, id: { [Op.in]: ids } },
      attributes: ['id', 'buildingId'],
      transaction: t,
    });
    if (pre.length) {
      if (input.set.undividedSharePct !== undefined && input.set.undividedSharePct !== null)
        await lockSociety(societyId, t);
      await lockBuildings(
        societyId,
        pre.map(p => p.buildingId),
        t,
      );
    }
    const units = await Unit.findAll({
      where: { societyId, id: { [Op.in]: ids }, status: 'ACTIVE' },
      order: [['id', 'ASC']],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const found = new Set(units.map(u => u.id));
    const missing = ids.filter(i => !found.has(i));
    if (missing.length)
      throw new AppError(
        404,
        'UNIT_NOT_FOUND',
        'Some units were not found',
        missing.map(i => ({ field: 'unitIds', message: String(i) })),
      );

    const badBhk: FieldError[] = [];
    const rulesErrors: FieldError[] = [];
    const planned: {
      unit: Unit;
      merged: UnitFields;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }[] = [];
    for (const u of units) {
      const cur = pickFields(u);
      const merged: UnitFields = { ...cur };
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input.set)) {
        const old = (cur as unknown as Record<string, unknown>)[k];
        if (v === undefined || sameValue(k, v, old)) continue;
        before[k] = old;
        after[k] = v;
        (merged as unknown as Record<string, unknown>)[k] = v;
      }
      if (merged.unitType !== 'FLAT' && merged.bhk !== null)
        badBhk.push({ field: `${u.id}.bhk`, message: 'Clear the BHK when the unit is not a flat' });
      try {
        assertAreaOrder(merged, c => `${u.id}.${c}`);
      } catch (err) {
        if (err instanceof AppError && err.errors) rulesErrors.push(...err.errors);
        else throw err;
      }
      planned.push({ unit: u, merged, before, after });
    }
    if (badBhk.length) throw new ValidationError(badBhk);
    if (rulesErrors.length)
      throw new UnprocessableError(
        'AREA_ORDER_INVALID',
        'Carpet area cannot be above built-up, nor built-up above super built-up',
        rulesErrors,
      );

    if (input.set.undividedSharePct !== undefined && input.set.undividedSharePct !== null) {
      // every selected unit gets the same share, so the total is the rest of the society plus share × units
      const addPct = (Number(input.set.undividedSharePct) * units.length).toFixed(4);
      await assertShareTotal(
        societyId,
        addPct,
        units.map(u => u.id),
        t,
      );
    }

    let net = 0;
    const changedIds: number[] = [];
    for (const p of planned) {
      if (!Object.keys(p.after).length) continue;
      net += Number(isCountable(p.merged.unitType)) - Number(isCountable(p.unit.unitType));
      p.unit.set({
        ...p.merged,
        areaSqft: billingArea(p.merged, basis),
        version: p.unit.version + 1,
        updatedBy: ctx.user?.id ?? null,
      } as never);
      await p.unit.save({ transaction: t });
      changedIds.push(p.unit.id);
      await audit(
        ctx,
        {
          action: AUDIT.unitUpdated,
          entityType: ENTITY.unit,
          entityId: p.unit.id,
          entityLabel: p.unit.label,
          societyId,
          before: p.before,
          after: p.after,
        },
        t,
      );
    }
    await adjustFlats(ctx, societyId, net, t);
    await audit(
      ctx,
      {
        action: AUDIT.unitBulkUpdated,
        entityType: ENTITY.society,
        entityId: societyId,
        societyId,
        after: { set: input.set, unitCount: ids.length, changed: changedIds.length },
      },
      t,
    );
    return { updated: ids.length, unitIds: ids };
  });
  return result;
}

// ------------------------------------------------------------------ service API for other modules (8.30)
const countableWhere = (societyId: number | number[]) => ({
  societyId: Array.isArray(societyId) ? { [Op.in]: societyId } : societyId,
  status: 'ACTIVE' as const,
  unitType: { [Op.in]: [...COUNTABLE_UNIT_TYPES] },
});

/** BR-08-20: countable units of one society (the `limit.flats` usage provider). */
export const count = (societyId: number): Promise<number> => Unit.count({ where: countableWhere(societyId) });

/** Countable units of the given societies, or of every society (module 07 dashboard). */
export async function countUnits(societyIds?: number[]): Promise<number> {
  if (societyIds && !societyIds.length) return 0;
  return Unit.count({
    where: societyIds
      ? countableWhere(societyIds)
      : { status: 'ACTIVE', unitType: { [Op.in]: [...COUNTABLE_UNIT_TYPES] } },
  });
}

export async function getUnitDto(
  societyId: number,
  unitId: number,
  t?: Transaction,
): Promise<UnitDto | null> {
  const u = await Unit.findOne({
    where: { id: unitId, societyId },
    include: [{ model: Building }],
    transaction: t,
  });
  if (!u) return null;
  return publicDto(u, (u as unknown as { Building: Building }).Building, await floorLabelSettings(societyId));
}

export interface ListActiveFilters {
  buildingId?: number;
  unitTypes?: UnitType[];
  unitIds?: number[];
  floor?: number;
  isBillable?: boolean;
}

export async function listActive(societyId: number, f: ListActiveFilters = {}): Promise<UnitDto[]> {
  const where: Record<string, unknown> = { societyId, status: 'ACTIVE' };
  if (f.buildingId) where.buildingId = f.buildingId;
  if (f.unitTypes) where.unitType = { [Op.in]: f.unitTypes };
  if (f.unitIds) where.id = { [Op.in]: f.unitIds };
  if (f.floor !== undefined) where.floor = f.floor;
  if (f.isBillable !== undefined) where.isBillable = f.isBillable;
  const rows = await Unit.findAll({
    where,
    include: [{ model: Building, attributes: ['id', 'code', 'name', 'sortOrder'], required: true }],
    order: [
      [Building as never, 'sortOrder', 'ASC'],
      [Building as never, 'code', 'ASC'],
      ['floor', 'ASC'],
      ['positionOnFloor', 'ASC'],
      ['unitNumber', 'ASC'],
    ],
  });
  const labels = await floorLabelSettings(societyId);
  return rows.map(u => publicDto(u, (u as unknown as { Building: Building }).Building, labels));
}

/** ACTIVE only, case-insensitive (the column collation is case-insensitive). */
export async function getByLabel(societyId: number, label: string): Promise<UnitDto | null> {
  const u = await Unit.findOne({
    where: { societyId, label: label.trim(), status: 'ACTIVE' },
    include: [{ model: Building }],
  });
  if (!u) return null;
  return publicDto(u, (u as unknown as { Building: Building }).Building, await floorLabelSettings(societyId));
}

/** `FOR UPDATE`; `404 UNIT_NOT_FOUND` when the unit is missing or archived. */
export async function lockActive(societyId: number, unitId: number, t: Transaction): Promise<UnitDto> {
  const u = await Unit.findOne({
    where: { id: unitId, societyId, status: 'ACTIVE' },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!u) throw unitNotFound();
  const b = await Building.findByPk(u.buildingId, { transaction: t });
  return publicDto(u, b!, await floorLabelSettings(societyId));
}

/** Used by the building grid and the generator preview. */
export { UNIT_NUMBER_RE, lockSociety, assertShareTotal, lockBuildings };
