import { Op, QueryTypes, type Order, type Transaction, type WhereOptions } from 'sequelize';
import { Building, LocationNode, Unit, sequelize } from '../../models';
import type { BuildingKind } from '../../models/building.model';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError, ValidationError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import {
  activeFloorNodesOutside,
  archiveBuildingNodes,
  createBuildingNode,
  deleteBuildingNodes,
  renameBuildingNode,
  restoreBuildingNode,
} from './society-setup.locations.service';
import {
  buildingNotFound,
  floorLabel,
  floorLabelSettings,
  invalidState,
  isForeignKeyViolation,
  isUniqueViolation,
  staleVersion,
  type FloorLabels,
} from './society-setup.shared';
import { AUDIT, ENTITY, type BuildingDto } from './society-setup.types';
import { COUNTABLE_UNIT_TYPES } from '../../models/unit.model';

/** Buildings (module 08 sections 5.3, 8.6 to 8.9): towers, wings and other blocks, with floors as a numbered range. */
const codeTaken = () =>
  new AppError(409, 'BUILDING_CODE_TAKEN', 'This building code is already used in the society', [
    { field: 'code', message: 'Codes are never reused, even by archived buildings' },
  ]);
const parentInvalid = (message: string) =>
  new UnprocessableError('PARENT_BUILDING_INVALID', message, [{ field: 'parentBuildingId', message }]);
const structureConflict = (message: string) => new UnprocessableError('BUILDING_STRUCTURE_CONFLICT', message);

// ------------------------------------------------------------------ views
interface Counts {
  active: number;
  archived: number;
  countable: number;
}

async function countsFor(societyId: number, ids: number[]): Promise<Map<number, Counts>> {
  const out = new Map<number, Counts>(ids.map(i => [i, { active: 0, archived: 0, countable: 0 }]));
  if (!ids.length) return out;
  const rows = await sequelize.query<{
    buildingId: number;
    active: string;
    archived: string;
    countable: string;
  }>(
    `SELECT buildingId, SUM(status = 'ACTIVE') AS active, SUM(status = 'ARCHIVED') AS archived,
            SUM(status = 'ACTIVE' AND unitType IN (:countable)) AS countable
       FROM units WHERE societyId = :societyId AND buildingId IN (:ids) GROUP BY buildingId`,
    { replacements: { societyId, ids, countable: [...COUNTABLE_UNIT_TYPES] }, type: QueryTypes.SELECT },
  );
  for (const r of rows)
    out.set(Number(r.buildingId), {
      active: Number(r.active),
      archived: Number(r.archived),
      countable: Number(r.countable),
    });
  return out;
}

async function toDtos(societyId: number, rows: Building[]): Promise<BuildingDto[]> {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id!);
  const labels = await floorLabelSettings(societyId);
  const counts = await countsFor(societyId, ids);
  const wings = await Building.findAll({
    where: { societyId, parentBuildingId: { [Op.in]: ids } },
    attributes: ['id', 'code', 'name', 'status', 'parentBuildingId', 'sortOrder'],
    order: [
      ['sortOrder', 'ASC'],
      ['code', 'ASC'],
    ],
  });
  const nodes = await LocationNode.findAll({
    where: { societyId, buildingId: { [Op.in]: ids }, nodeType: 'BUILDING' },
    attributes: ['id', 'buildingId'],
  });
  const nodeOf = new Map(nodes.map(n => [n.buildingId!, n.id]));
  return rows.map(b => ({
    id: b.id!,
    code: b.code,
    name: b.name,
    kind: b.kind,
    parentBuildingId: b.parentBuildingId,
    floorsAboveGround: b.floorsAboveGround,
    basements: b.basements,
    liftCount: b.liftCount,
    sortOrder: b.sortOrder,
    status: b.status,
    floorLabels: {
      min: floorLabel(-b.basements, labels),
      max: floorLabel(b.floorsAboveGround, labels),
    },
    unitCounts: counts.get(b.id!)!,
    wings: wings
      .filter(w => w.parentBuildingId === b.id)
      .map(w => ({ id: w.id!, code: w.code, name: w.name, status: w.status })),
    locationNodeId: nodeOf.get(b.id!) ?? null,
    version: b.version,
    createdAt: b.createdAt!.toISOString(),
  }));
}

export interface ListBuildingsQuery {
  status: 'ACTIVE' | 'ARCHIVED' | 'ALL';
  kind?: BuildingKind;
  parentBuildingId?: number;
  q?: string;
  sortBy: 'sortOrder' | 'code' | 'name' | 'createdAt';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

export async function listBuildings(societyId: number, q: ListBuildingsQuery) {
  const where: WhereOptions[] = [{ societyId }];
  if (q.status !== 'ALL') where.push({ status: q.status });
  if (q.kind) where.push({ kind: q.kind });
  if (q.parentBuildingId) where.push({ parentBuildingId: q.parentBuildingId });
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    where.push({ [Op.or]: [{ code: { [Op.like]: like } }, { name: { [Op.like]: like } }] });
  }
  const dir = q.sortOrder.toUpperCase() as 'ASC' | 'DESC';
  const order: Order =
    q.sortBy === 'sortOrder'
      ? [
          ['sortOrder', dir],
          ['code', 'ASC'],
        ]
      : [
          [q.sortBy, dir],
          ['id', 'ASC'],
        ];
  const { rows, count } = await Building.findAndCountAll({
    where: { [Op.and]: where },
    order,
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: await toDtos(societyId, rows), pagination: pageMeta(q.page, q.limit, count) };
}

async function findOr404(societyId: number, id: number, t?: Transaction): Promise<Building> {
  const b = await Building.findOne({ where: { id, societyId }, transaction: t });
  if (!b) throw buildingNotFound();
  return b;
}

export async function getBuilding(societyId: number, id: number): Promise<BuildingDto> {
  const [dto] = await toDtos(societyId, [await findOr404(societyId, id)]);
  return dto!;
}

/** Public `buildings.list` (section 8.30). */
export async function listForSociety(
  societyId: number,
  opts: { includeArchived?: boolean } = {},
): Promise<BuildingDto[]> {
  const rows = await Building.findAll({
    where: { societyId, ...(opts.includeArchived ? {} : { status: 'ACTIVE' }) },
    order: [
      ['sortOrder', 'ASC'],
      ['code', 'ASC'],
    ],
  });
  return toDtos(societyId, rows);
}

// ------------------------------------------------------------------ create (8.7)
export interface BuildingInput {
  code: string;
  name: string;
  kind: BuildingKind;
  parentBuildingId?: number | null;
  floorsAboveGround: number;
  basements?: number;
  liftCount?: number;
  sortOrder?: number;
}

async function assertWingParent(
  societyId: number,
  kind: BuildingKind,
  parentId: number | null | undefined,
  t: Transaction,
): Promise<void> {
  if (kind !== 'WING') {
    if (parentId) throw parentInvalid('Only a wing can have a parent building');
    return;
  }
  if (!parentId) throw parentInvalid('A wing needs a parent tower');
  const parent = await Building.findOne({
    where: { id: parentId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!parent || parent.status !== 'ACTIVE' || parent.kind !== 'TOWER' || parent.parentBuildingId !== null)
    throw parentInvalid('The parent must be an active tower');
  if (await Unit.count({ where: { buildingId: parent.id!, societyId, status: 'ACTIVE' }, transaction: t }))
    throw structureConflict('This tower holds units directly, so it cannot receive wings');
}

/** Creates the building and its BUILDING location node inside the caller's transaction (also used by the generator). */
export async function createBuildingCore(
  ctx: Ctx,
  societyId: number,
  input: BuildingInput,
  t: Transaction,
): Promise<Building> {
  const code = input.code.toUpperCase();
  if (await Building.count({ where: { societyId, code }, transaction: t })) throw codeTaken();
  await assertWingParent(societyId, input.kind, input.parentBuildingId, t);
  let b: Building;
  try {
    b = await Building.create(
      {
        societyId,
        parentBuildingId: input.kind === 'WING' ? (input.parentBuildingId ?? null) : null,
        code,
        name: input.name,
        kind: input.kind,
        floorsAboveGround: input.floorsAboveGround,
        basements: input.basements ?? 0,
        liftCount: input.liftCount ?? 0,
        sortOrder: input.sortOrder ?? 0,
        status: 'ACTIVE',
        archivedAt: null,
        archivedReason: null,
        version: 1,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw codeTaken();
    throw err;
  }
  await createBuildingNode(ctx, b, t);
  await audit(
    ctx,
    {
      action: AUDIT.buildingCreated,
      entityType: ENTITY.building,
      entityId: b.id!,
      entityLabel: `${b.code} ${b.name}`,
      societyId,
      after: {
        buildingCode: b.code, // not `code`: the audit redaction masks keys named code
        name: b.name,
        kind: b.kind,
        parentBuildingId: b.parentBuildingId,
        floorsAboveGround: b.floorsAboveGround,
        basements: b.basements,
      },
    },
    t,
  );
  return b;
}

export async function createBuilding(
  ctx: Ctx,
  societyId: number,
  input: BuildingInput,
): Promise<BuildingDto> {
  const id = await sequelize.transaction(async t => (await createBuildingCore(ctx, societyId, input, t)).id!);
  return getBuilding(societyId, id);
}

// ------------------------------------------------------------------ edit (8.7)
export type PatchBuildingInput = Partial<BuildingInput> & { version: number };

export async function patchBuilding(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: PatchBuildingInput,
): Promise<BuildingDto> {
  await sequelize.transaction(async t => {
    const b = await Building.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!b) throw buildingNotFound();
    if (b.status !== 'ACTIVE') throw invalidState('Restore this building before editing it');
    if (b.version !== input.version) throw staleVersion('This building');

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const next = {
      code: input.code !== undefined ? input.code.toUpperCase() : b.code,
      name: input.name ?? b.name,
      kind: input.kind ?? b.kind,
      parentBuildingId: input.parentBuildingId !== undefined ? input.parentBuildingId : b.parentBuildingId,
      floorsAboveGround: input.floorsAboveGround ?? b.floorsAboveGround,
      basements: input.basements ?? b.basements,
      liftCount: input.liftCount ?? b.liftCount,
      sortOrder: input.sortOrder ?? b.sortOrder,
    };
    for (const k of Object.keys(next) as (keyof typeof next)[])
      if (next[k] !== b[k]) {
        const field = k === 'code' ? 'buildingCode' : k; // the audit redaction masks keys named code
        before[field] = b[k];
        after[field] = next[k];
      }
    if (!Object.keys(after).length) return;

    const hasUnits = () => Unit.count({ where: { buildingId: b.id!, societyId }, transaction: t });
    if ('buildingCode' in after) {
      if (await hasUnits())
        throw new AppError(409, 'BUILDING_CODE_LOCKED', 'The code cannot change once the building has units');
      if (
        await Building.count({
          where: { societyId, code: next.code, id: { [Op.ne]: b.id! } },
          transaction: t,
        })
      )
        throw codeTaken();
    }
    if ('kind' in after || 'parentBuildingId' in after) {
      if (await hasUnits())
        throw structureConflict('The kind and parent cannot change once the building has units');
      if (
        'kind' in after &&
        (await Building.count({
          where: { parentBuildingId: b.id!, societyId, status: 'ACTIVE' },
          transaction: t,
        }))
      )
        throw structureConflict('This tower has wings, so its kind cannot change');
      await assertWingParent(societyId, next.kind as BuildingKind, next.parentBuildingId, t);
    }
    if ('floorsAboveGround' in after || 'basements' in after) {
      const min = -next.basements;
      const max = next.floorsAboveGround;
      const used =
        (await Unit.count({
          where: {
            buildingId: b.id!,
            societyId,
            status: 'ACTIVE',
            [Op.or]: [{ floor: { [Op.lt]: min } }, { floor: { [Op.gt]: max } }],
          },
          transaction: t,
        })) + (await activeFloorNodesOutside(societyId, b.id!, min, max, t));
      if (used)
        throw new UnprocessableError(
          'BUILDING_FLOORS_IN_USE',
          'A floor that is being used would fall outside the new range',
        );
    }
    b.set({ ...next, version: b.version + 1, updatedBy: ctx.user?.id ?? null } as never);
    try {
      await b.save({ transaction: t });
    } catch (err) {
      if (isUniqueViolation(err)) throw codeTaken();
      throw err;
    }
    if ('name' in after || 'sortOrder' in after)
      await renameBuildingNode(societyId, b.id!, b.name, b.sortOrder, t);
    await audit(
      ctx,
      {
        action: AUDIT.buildingUpdated,
        entityType: ENTITY.building,
        entityId: b.id!,
        entityLabel: `${b.code} ${b.name}`,
        societyId,
        before,
        after,
      },
      t,
    );
  });
  return getBuilding(societyId, id);
}

// ------------------------------------------------------------------ archive, restore, delete (8.8)
export async function archiveBuilding(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { reason: string; version: number },
): Promise<BuildingDto> {
  await sequelize.transaction(async t => {
    const b = await Building.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!b) throw buildingNotFound();
    if (b.status === 'ARCHIVED') throw invalidState('This building is already archived');
    if (b.version !== input.version) throw staleVersion('This building');
    const units = await Unit.count({
      where: { buildingId: b.id!, societyId, status: 'ACTIVE' },
      transaction: t,
    });
    const wings = await Building.count({
      where: { parentBuildingId: b.id!, societyId, status: 'ACTIVE' },
      transaction: t,
    });
    if (units || wings)
      throw new AppError(
        409,
        'BUILDING_HAS_ACTIVE_UNITS',
        'Archive or move the active units and wings of this building first',
        [
          ...(units ? [{ field: 'units', message: `${units} active unit${units === 1 ? '' : 's'}` }] : []),
          ...(wings ? [{ field: 'wings', message: `${wings} active wing${wings === 1 ? '' : 's'}` }] : []),
        ],
      );
    b.status = 'ARCHIVED';
    b.archivedAt = now();
    b.archivedReason = input.reason;
    b.version += 1;
    b.updatedBy = ctx.user?.id ?? null;
    await b.save({ transaction: t });
    await archiveBuildingNodes(societyId, b.id!, t);
    await audit(
      ctx,
      {
        action: AUDIT.buildingArchived,
        entityType: ENTITY.building,
        entityId: b.id!,
        entityLabel: `${b.code} ${b.name}`,
        societyId,
        before: { status: 'ACTIVE' },
        after: { status: 'ARCHIVED' },
        reason: input.reason,
      },
      t,
    );
  });
  return getBuilding(societyId, id);
}

export async function restoreBuilding(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number },
): Promise<BuildingDto> {
  await sequelize.transaction(async t => {
    const b = await Building.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!b) throw buildingNotFound();
    if (b.status === 'ACTIVE') throw invalidState('This building is already active');
    if (b.version !== input.version) throw staleVersion('This building');
    if (b.parentBuildingId) {
      const parent = await Building.findOne({ where: { id: b.parentBuildingId, societyId }, transaction: t });
      if (!parent || parent.status !== 'ACTIVE') throw parentInvalid('Restore the parent tower first');
    }
    b.status = 'ACTIVE';
    b.archivedAt = null;
    b.archivedReason = null;
    b.version += 1;
    b.updatedBy = ctx.user?.id ?? null;
    await b.save({ transaction: t });
    await restoreBuildingNode(societyId, b.id!, t);
    await audit(
      ctx,
      {
        action: AUDIT.buildingRestored,
        entityType: ENTITY.building,
        entityId: b.id!,
        entityLabel: `${b.code} ${b.name}`,
        societyId,
        before: { status: 'ARCHIVED' },
        after: { status: 'ACTIVE' },
      },
      t,
    );
  });
  return getBuilding(societyId, id);
}

const inUse = () =>
  new AppError(
    409,
    'BUILDING_IN_USE',
    'This building has units, wings or is used by another part of the app',
  );

/** BR-08-18: only an empty building (no units of any status, no wings, no references) can be deleted. */
export async function deleteBuilding(ctx: Ctx, societyId: number, id: number): Promise<void> {
  await sequelize.transaction(async t => {
    const b = await Building.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!b) throw buildingNotFound();
    if (
      (await Unit.count({ where: { buildingId: b.id!, societyId }, transaction: t })) ||
      (await Building.count({ where: { parentBuildingId: b.id!, societyId }, transaction: t }))
    )
      throw inUse();
    const { code, ...rest } = b.get({ plain: true });
    const row = { ...rest, buildingCode: code }; // the audit redaction masks keys named code
    try {
      await deleteBuildingNodes(societyId, b.id!, t);
      await b.destroy({ transaction: t });
    } catch (err) {
      if (isForeignKeyViolation(err) || /foreign key/i.test(String((err as { message?: string }).message)))
        throw inUse();
      throw err;
    }
    await audit(
      ctx,
      {
        action: AUDIT.buildingDeleted,
        entityType: ENTITY.building,
        entityId: row.id!,
        entityLabel: `${row.buildingCode} ${row.name}`,
        societyId,
        before: row,
      },
      t,
    );
  });
}

// ------------------------------------------------------------------ grid (8.9)
export async function getGrid(societyId: number, id: number, includeArchived: boolean) {
  const b = await findOr404(societyId, id);
  if (await Building.count({ where: { parentBuildingId: b.id!, societyId, status: 'ACTIVE' } }))
    throw new ValidationError([
      { field: 'id', message: 'This tower has wings; open a wing to see its grid' },
    ]);
  const labels: FloorLabels = await floorLabelSettings(societyId);
  const units = await Unit.findAll({
    where: { societyId, buildingId: b.id!, ...(includeArchived ? {} : { status: 'ACTIVE' }) },
    order: [
      ['floor', 'DESC'],
      ['positionOnFloor', 'ASC'],
      ['unitNumber', 'ASC'],
    ],
  });
  const floors = new Map<number, unknown[]>();
  for (const u of units) {
    const row = {
      id: u.id,
      label: u.label,
      unitNumber: u.unitNumber,
      positionOnFloor: u.positionOnFloor,
      unitType: u.unitType,
      bhk: u.bhk,
      areaSqft: u.areaSqft,
      isBillable: Boolean(u.isBillable),
      status: u.status,
    };
    const list = floors.get(u.floor);
    if (list) list.push(row);
    else floors.set(u.floor, [row]);
  }
  return {
    building: { id: b.id!, code: b.code, name: b.name },
    floors: [...floors.entries()].map(([floor, list]) => ({
      floor,
      floorLabel: floorLabel(floor, labels),
      units: list,
    })),
    totals: { units: units.length, missingArea: units.filter(u => u.areaSqft === null).length },
  };
}
