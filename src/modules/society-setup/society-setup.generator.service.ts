import { createHash } from 'node:crypto';
import { Op, type Transaction } from 'sequelize';
import { Building, Unit, sequelize } from '../../models';
import type { Bhk, UnitType } from '../../models/unit.model';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError, ValidationError, type FieldError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { entitlements } from '../subscriptions/subscriptions.public';
import { createBuildingCore } from './society-setup.buildings.service';
import { assertPatternUnique, parsePattern, renderNumber } from './society-setup.generator.pattern';
import { adjustFlats, isCountable } from './society-setup.limits';
import { get as getSetting, canonical } from './society-setup.settings.service';
import { buildingNotFound, floorLabelSettings, inFloorRange, type FloorLabels } from './society-setup.shared';
import { assertUnitRules, billingArea, defaultBillable } from './society-setup.units.service';
import { AUDIT, ENTITY, FLATS_LIMIT, type AreaBasis } from './society-setup.types';

/**
 * Bulk unit generator (module 08 sections 5.5, 8.14): buildings x floor range x per-floor positions with a numbering
 * pattern, skips, a read-only preview with a hash, and an atomic commit that rechecks the hash and the conflicts.
 */
export const MAX_UNITS = 2000;
const INSERT_CHUNK = 100;

export interface PositionConfig {
  position: number;
  unitType?: UnitType;
  bhk?: Bhk | null;
  carpetAreaSqft?: string | null;
  builtUpAreaSqft?: string | null;
  superBuiltUpAreaSqft?: string | null;
  isBillable?: boolean;
}
export type BuildingTarget =
  | { buildingId: number; newBuilding?: undefined }
  | {
      buildingId?: undefined;
      newBuilding: {
        code: string;
        name: string;
        kind: 'TOWER' | 'WING' | 'COMMERCIAL';
        parentBuildingId?: number | null;
      };
    };
export interface GeneratorParams {
  buildings: BuildingTarget[];
  floorFrom: number;
  floorTo: number;
  positions: PositionConfig[];
  pattern: string;
  skipFloors?: number[];
  skipCells?: { floor: number; position: number }[];
}

/** Test hook: called after each inserted chunk with the running total (a throw proves the rollback, T08-08). */
export const testHooks: { afterUnitsInserted?: (total: number) => void } = {};

interface Row {
  buildingKey: string;
  buildingCode: string;
  floor: number;
  position: number;
  unitNumber: string;
  label: string;
  unitType: UnitType;
  bhk: Bhk | null;
  carpetAreaSqft: string | null;
  builtUpAreaSqft: string | null;
  superBuiltUpAreaSqft: string | null;
  isBillable: boolean;
}
interface Target {
  key: string;
  code: string;
  existing: Building | null;
  newBuilding: {
    code: string;
    name: string;
    kind: 'TOWER' | 'WING' | 'COMMERCIAL';
    parentBuildingId: number | null;
  } | null;
}
interface Plan {
  targets: Target[];
  rows: Row[];
  conflicts: string[];
  hash: string;
  labels: FloorLabels;
}

const normalisePositions = (ps: PositionConfig[]) =>
  [...ps]
    .sort((a, b) => a.position - b.position)
    .map(p => ({
      position: p.position,
      unitType: p.unitType ?? 'FLAT',
      bhk: p.bhk ?? null,
      carpetAreaSqft: p.carpetAreaSqft ?? null,
      builtUpAreaSqft: p.builtUpAreaSqft ?? null,
      superBuiltUpAreaSqft: p.superBuiltUpAreaSqft ?? null,
      isBillable: p.isBillable ?? defaultBillable(p.unitType ?? 'FLAT'),
    }));

function validateShape(p: GeneratorParams): void {
  const errors: FieldError[] = [];
  if (p.floorTo < p.floorFrom) errors.push({ field: 'floorTo', message: 'Must not be below floorFrom' });
  const positions = p.positions.map(x => x.position).sort((a, b) => a - b);
  if (positions.some((v, i) => v !== i + 1))
    errors.push({ field: 'positions', message: 'Positions must be 1 to n, each exactly once' });
  for (const f of p.skipFloors ?? [])
    if (f < p.floorFrom || f > p.floorTo)
      errors.push({ field: 'skipFloors', message: `Floor ${f} is outside the range` });
  for (const c of p.skipCells ?? []) {
    if (c.floor < p.floorFrom || c.floor > p.floorTo)
      errors.push({ field: 'skipCells', message: `Floor ${c.floor} is outside the range` });
    if (c.position < 1 || c.position > p.positions.length)
      errors.push({ field: 'skipCells', message: `Position ${c.position} does not exist` });
  }
  if (errors.length) throw new ValidationError(errors);
}

/** Resolves the buildings, renders every unit number and finds conflicts. `lock` takes FOR UPDATE on existing buildings. */
async function buildPlan(societyId: number, p: GeneratorParams, t?: Transaction): Promise<Plan> {
  validateShape(p);
  const tokens = parsePattern(p.pattern);
  assertPatternUnique(tokens);
  const labels = await floorLabelSettings(societyId);

  const taken = await Building.findAll({ where: { societyId }, attributes: ['code'], transaction: t });
  const usedCodes = new Set(taken.map(b => b.code));
  const targets: Target[] = [];
  const seenCodes = new Set<string>();
  const ids = p.buildings.filter(b => b.buildingId).map(b => b.buildingId!);
  const existing = ids.length
    ? await Building.findAll({
        where: { societyId, id: { [Op.in]: ids } },
        order: [['id', 'ASC']],
        transaction: t,
        ...(t ? { lock: t.LOCK.UPDATE } : {}),
      })
    : [];
  const byId = new Map(existing.map(b => [b.id!, b]));
  for (const [i, bt] of p.buildings.entries()) {
    if (bt.buildingId) {
      const b = byId.get(bt.buildingId);
      if (!b) throw buildingNotFound();
      if (seenCodes.has(b.code))
        throw new ValidationError([{ field: `buildings.${i}`, message: 'Building listed twice' }]);
      seenCodes.add(b.code);
      if (b.status !== 'ACTIVE')
        throw new UnprocessableError('BUILDING_ARCHIVED', `Building ${b.code} is archived`);
      if (
        await Building.count({
          where: { parentBuildingId: b.id!, societyId, status: 'ACTIVE' },
          transaction: t,
        })
      )
        throw new UnprocessableError(
          'BUILDING_STRUCTURE_CONFLICT',
          `Building ${b.code} has wings; generate into a wing`,
        );
      if (!inFloorRange(b, p.floorFrom) || !inFloorRange(b, p.floorTo))
        throw new UnprocessableError(
          'FLOOR_OUT_OF_RANGE',
          `Building ${b.code} does not cover floors ${p.floorFrom} to ${p.floorTo}`,
        );
      targets.push({ key: `id:${b.id}`, code: b.code, existing: b, newBuilding: null });
    } else {
      const nb = bt.newBuilding!;
      const code = nb.code.toUpperCase();
      if (usedCodes.has(code) || seenCodes.has(code))
        throw new AppError(409, 'BUILDING_CODE_TAKEN', `The building code ${code} is already used`, [
          { field: 'code', message: code },
        ]);
      seenCodes.add(code);
      targets.push({
        key: `new:${code}`,
        code,
        existing: null,
        newBuilding: { code, name: nb.name, kind: nb.kind, parentBuildingId: nb.parentBuildingId ?? null },
      });
    }
  }

  const positions = normalisePositions(p.positions);
  for (const pos of positions)
    assertUnitRules({
      buildingId: 0,
      unitNumber: 'X',
      floor: 0,
      positionOnFloor: pos.position,
      unitType: pos.unitType,
      bhk: pos.bhk,
      carpetAreaSqft: pos.carpetAreaSqft,
      builtUpAreaSqft: pos.builtUpAreaSqft,
      superBuiltUpAreaSqft: pos.superBuiltUpAreaSqft,
      undividedSharePct: null,
      isBillable: pos.isBillable,
      possessionDate: null,
      notes: null,
    });

  const skipFloors = new Set(p.skipFloors ?? []);
  const skipCells = new Set((p.skipCells ?? []).map(c => `${c.floor}:${c.position}`));
  const rows: Row[] = [];
  let seq = 0;
  for (const target of targets)
    for (let floor = p.floorFrom; floor <= p.floorTo; floor++) {
      if (skipFloors.has(floor)) continue;
      for (const pos of positions) {
        if (skipCells.has(`${floor}:${pos.position}`)) continue;
        seq += 1;
        const unitNumber = renderNumber(tokens, {
          building: target.code,
          floor,
          position: pos.position,
          seq,
          labels,
        });
        rows.push({
          buildingKey: target.key,
          buildingCode: target.code,
          floor,
          position: pos.position,
          unitNumber,
          label: `${target.code}-${unitNumber}`,
          unitType: pos.unitType,
          bhk: pos.bhk,
          carpetAreaSqft: pos.carpetAreaSqft,
          builtUpAreaSqft: pos.builtUpAreaSqft,
          superBuiltUpAreaSqft: pos.superBuiltUpAreaSqft,
          isBillable: pos.isBillable,
        });
      }
      if (rows.length > MAX_UNITS)
        throw new UnprocessableError('GENERATOR_TOO_LARGE', `A run can create at most ${MAX_UNITS} units`);
    }
  if (!rows.length)
    throw new ValidationError([{ field: 'positions', message: 'Nothing would be generated' }]);

  // a pattern that gives the same number to two cells of one building cannot be committed
  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.buildingKey}|${r.unitNumber}`;
    if (seen.has(k))
      throw new UnprocessableError(
        'PATTERN_NOT_UNIQUE',
        `The pattern gives "${r.unitNumber}" to more than one unit in ${r.buildingCode}`,
      );
    seen.add(k);
  }

  const existingIds = targets.filter(x => x.existing).map(x => x.existing!.id!);
  const conflicts: string[] = [];
  if (existingIds.length) {
    const clash = await Unit.findAll({
      where: {
        societyId,
        status: 'ACTIVE',
        buildingId: { [Op.in]: existingIds },
        unitNumber: { [Op.in]: [...new Set(rows.map(r => r.unitNumber))] },
      },
      attributes: ['buildingId', 'unitNumber', 'label'],
      transaction: t,
      // a locking read sees what a parallel commit into the same building committed while this one waited for the lock
      ...(t ? { lock: t.LOCK.UPDATE } : {}),
    });
    const taken2 = new Set(clash.map(c => `${c.buildingId}|${c.unitNumber}`));
    for (const r of rows) {
      const tgt = targets.find(x => x.key === r.buildingKey)!;
      if (tgt.existing && taken2.has(`${tgt.existing.id}|${r.unitNumber}`)) conflicts.push(r.label);
    }
  }

  const normal = {
    buildings: targets.map(x =>
      x.existing ? { buildingId: x.existing.id } : { newBuilding: x.newBuilding },
    ),
    floorFrom: p.floorFrom,
    floorTo: p.floorTo,
    positions,
    pattern: p.pattern,
    skipFloors: [...skipFloors].sort((a, b) => a - b),
    skipCells: [...skipCells].sort(),
  };
  const hash = createHash('sha256')
    .update(
      canonical({ params: normal, labels: rows.map(r => `${r.buildingKey}|${r.label}`), structure: labels }),
    )
    .digest('hex');
  return { targets, rows, conflicts, hash, labels };
}

// ------------------------------------------------------------------ preview (8.14)
export async function preview(_ctx: Ctx, societyId: number, p: GeneratorParams) {
  const plan = await buildPlan(societyId, p);
  const countable = plan.rows.filter(r => isCountable(r.unitType)).length;
  const { limit, used } = await entitlements.getUsage(societyId, FLATS_LIMIT);
  return {
    previewHash: plan.hash,
    summary: {
      buildings: plan.targets.length,
      newBuildings: plan.targets.filter(x => x.newBuilding).length,
      units: plan.rows.length,
      countableUnits: countable,
      conflicts: plan.conflicts.length,
      limit,
      used,
      limitRemaining: limit === null ? null : Math.max(0, limit - used),
    },
    conflicts: plan.conflicts,
    sample: plan.rows.slice(0, 200).map(r => ({
      building: r.buildingCode,
      floor: r.floor,
      position: r.position,
      unitNumber: r.unitNumber,
      label: r.label,
      unitType: r.unitType,
      bhk: r.bhk,
    })),
    sampleCount: plan.rows.length,
  };
}

// ------------------------------------------------------------------ commit (8.14, BR-08-32)
/** A duplicate number that slipped past the conflict check (a parallel writer) is still a conflict, never a 500. */
async function insertChunk(rows: object[], t: Transaction): Promise<void> {
  try {
    await Unit.bulkCreate(rows as never, { transaction: t });
  } catch (err) {
    if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError')
      throw new AppError(409, 'UNIT_NUMBER_CONFLICT', 'Some unit numbers already exist');
    throw err;
  }
}

export async function commit(ctx: Ctx, societyId: number, p: GeneratorParams & { previewHash: string }) {
  const basis = (await getSetting(societyId, 'billing.areaBasis')) as AreaBasis;
  const { previewHash, ...params } = p;
  const result = await sequelize.transaction(async t => {
    const plan = await buildPlan(societyId, params, t); // locks the existing target buildings FOR UPDATE
    if (plan.hash !== previewHash)
      throw new AppError(409, 'PREVIEW_STALE', 'The inputs changed since the preview. Preview again.');
    if (plan.conflicts.length)
      throw new AppError(
        409,
        'UNIT_NUMBER_CONFLICT',
        'Some unit numbers already exist',
        plan.conflicts.map(label => ({ field: 'unitNumber', message: label })),
      );

    // new buildings first, in request order; they sort after the buildings that exist
    const [max] = (await Building.findAll({
      where: { societyId },
      attributes: ['sortOrder'],
      order: [['sortOrder', 'DESC']],
      limit: 1,
      transaction: t,
    })) as { sortOrder: number }[];
    let sortOrder = (max?.sortOrder ?? 0) + 1;
    const created: Building[] = [];
    const buildingIds = new Map<string, number>();
    for (const tg of plan.targets) {
      if (tg.existing) {
        buildingIds.set(tg.key, tg.existing.id!);
        continue;
      }
      const nb = tg.newBuilding!;
      const b = await createBuildingCore(
        ctx,
        societyId,
        {
          code: nb.code,
          name: nb.name,
          kind: nb.kind,
          parentBuildingId: nb.parentBuildingId,
          floorsAboveGround: Math.max(params.floorTo, 0),
          basements: Math.max(0, -params.floorFrom),
          sortOrder: Math.min(sortOrder++, 9999),
        },
        t,
      );
      created.push(b);
      buildingIds.set(tg.key, b.id!);
    }

    const countable = plan.rows.filter(r => isCountable(r.unitType)).length;
    if (countable) await adjustFlats(ctx, societyId, countable, t);

    const userId = ctx.user?.id ?? null;
    let inserted = 0;
    for (let i = 0; i < plan.rows.length; i += INSERT_CHUNK) {
      const chunk = plan.rows.slice(i, i + INSERT_CHUNK);
      await insertChunk(
        chunk.map(r => ({
          societyId,
          buildingId: buildingIds.get(r.buildingKey)!,
          unitNumber: r.unitNumber,
          label: r.label,
          floor: r.floor,
          positionOnFloor: r.position,
          unitType: r.unitType,
          bhk: r.bhk,
          carpetAreaSqft: r.carpetAreaSqft,
          builtUpAreaSqft: r.builtUpAreaSqft,
          superBuiltUpAreaSqft: r.superBuiltUpAreaSqft,
          areaSqft: billingArea(r, basis),
          undividedSharePct: null,
          isBillable: r.isBillable,
          possessionDate: null,
          notes: null,
          status: 'ACTIVE' as const,
          archivedAt: null,
          archivedReason: null,
          archivedBy: null,
          version: 1,
          createdBy: userId,
          updatedBy: userId,
        })),
        t,
      );
      inserted += chunk.length;
      testHooks.afterUnitsInserted?.(inserted);
    }

    // ids of the new rows, per building, by label
    const idRows = await Unit.findAll({
      where: {
        societyId,
        buildingId: { [Op.in]: [...buildingIds.values()] },
        label: { [Op.in]: plan.rows.map(r => r.label) },
        status: 'ACTIVE',
      },
      attributes: ['id', 'buildingId', 'label'],
      order: [['id', 'ASC']],
      transaction: t,
    });
    const idByLabel = new Map(idRows.map(r => [`${r.buildingId}|${r.label}`, r.id]));
    const unitIds: number[] = [];
    for (const tg of plan.targets) {
      const bid = buildingIds.get(tg.key)!;
      const mine = plan.rows
        .filter(r => r.buildingKey === tg.key)
        .map(r => idByLabel.get(`${bid}|${r.label}`)!);
      unitIds.push(...mine);
      await audit(
        ctx,
        {
          action: AUDIT.unitGenerated,
          entityType: ENTITY.building,
          entityId: bid,
          entityLabel: tg.code,
          societyId,
          after: {
            floorFrom: params.floorFrom,
            floorTo: params.floorTo,
            positions: params.positions.length,
            pattern: params.pattern,
            skipFloors: params.skipFloors ?? [],
            skipCells: params.skipCells ?? [],
            created: mine.length,
            unitIds: mine,
          },
        },
        t,
      );
    }
    return {
      created: plan.rows.length,
      buildingsCreated: created.map(b => b.id!),
      unitIds,
    };
  });
  // the counter after the commit (the transaction's own reads are not visible to other connections before it)
  const usage = await entitlements.getUsage(societyId, FLATS_LIMIT);
  return { ...result, used: usage.used, limit: usage.limit };
}
