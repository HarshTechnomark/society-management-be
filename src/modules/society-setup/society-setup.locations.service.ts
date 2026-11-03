import { Op, QueryTypes, type Transaction } from 'sequelize';
import { Building, LocationNode, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { entitlements } from '../subscriptions/subscriptions.public';
import { FEATURE, AUDIT, ENTITY, type LocationDto, type LocationTreeDto } from './society-setup.types';
import {
  floorNodeName,
  inFloorRange,
  invalidState,
  isUniqueViolation,
  locationNotFound,
  newQrToken,
  staleVersion,
} from './society-setup.shared';

/**
 * Location tree (module 08 sections 5.7, 8.19 to 8.21): buildings, floors and common areas with a materialized path.
 * BUILDING nodes are managed by the buildings service; the functions marked "building" below are its hooks.
 */
const MAX_DEPTH = 4;
const managed = () =>
  new UnprocessableError('LOCATION_MANAGED', 'Building nodes are managed with the building itself');
const parentInvalid = (message = 'This location cannot be placed here') =>
  new UnprocessableError('LOCATION_PARENT_INVALID', message);
const nameTaken = () =>
  new AppError(409, 'LOCATION_NAME_TAKEN', 'A location with this name already exists here', [
    { field: 'name', message: 'Already used at this level' },
  ]);

const CHILDREN: Record<string, string[]> = { BUILDING: ['FLOOR', 'AREA'], FLOOR: ['AREA'], AREA: ['AREA'] };

// ------------------------------------------------------------------ views
async function pathLabels(societyId: number, nodes: LocationNode[]): Promise<Map<number, string>> {
  const ids = new Set<number>();
  for (const n of nodes) for (const p of n.path.split('/').filter(Boolean)) ids.add(Number(p));
  const rows = ids.size
    ? await LocationNode.findAll({
        where: { societyId, id: { [Op.in]: [...ids] } },
        attributes: ['id', 'name'],
      })
    : [];
  const name = new Map(rows.map(r => [r.id, r.name]));
  return new Map(
    nodes.map(n => [
      n.id,
      n.path
        .split('/')
        .filter(Boolean)
        .map(p => name.get(Number(p)) ?? '?')
        .join(' › '),
    ]),
  );
}

function toDto(n: LocationNode, pathLabel: string, withQr: boolean): LocationDto {
  const dto: LocationDto = {
    id: n.id,
    nodeType: n.nodeType,
    areaType: n.areaType,
    name: n.name,
    buildingId: n.buildingId,
    floor: n.floor,
    parentId: n.parentId,
    pathLabel,
    sortOrder: n.sortOrder,
    status: n.status,
    notes: n.notes,
    version: n.version,
  };
  if (withQr) dto.qrToken = n.qrToken;
  return dto;
}

const qrOn = (societyId: number): Promise<boolean> => entitlements.isFeatureOn(societyId, FEATURE.qr);

export async function getNode(
  societyId: number,
  nodeId: number,
  withQr?: boolean,
): Promise<LocationDto | null> {
  const n = await LocationNode.findOne({ where: { id: nodeId, societyId } });
  if (!n) return null;
  const labels = await pathLabels(societyId, [n]);
  return toDto(n, labels.get(n.id)!, withQr ?? true);
}

export async function getNodeOrThrow(societyId: number, nodeId: number): Promise<LocationDto> {
  const n = await getNode(societyId, nodeId, await qrOn(societyId));
  if (!n) throw locationNotFound();
  return n;
}

export async function listTree(
  societyId: number,
  opts: {
    includeArchived?: boolean;
    buildingId?: number;
    areaType?: string;
    rootOnly?: boolean;
    withQr?: boolean;
  } = {},
): Promise<LocationTreeDto[]> {
  const where: Record<string, unknown> = { societyId };
  if (!opts.includeArchived) where.status = 'ACTIVE';
  if (opts.buildingId) where.buildingId = opts.buildingId;
  if (opts.areaType) where.areaType = opts.areaType;
  if (opts.rootOnly) where.parentId = null;
  const rows = await LocationNode.findAll({
    where,
    order: [
      ['depth', 'ASC'],
      ['sortOrder', 'ASC'],
      ['name', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const labels = await pathLabels(societyId, rows);
  const withQr = opts.withQr ?? (await qrOn(societyId));
  const byId = new Map<number, LocationTreeDto>();
  const roots: LocationTreeDto[] = [];
  for (const n of rows) {
    const { pathLabel, ...rest } = toDto(n, labels.get(n.id)!, withQr);
    const node: LocationTreeDto = { ...rest, pathLabel, children: [] };
    byId.set(n.id, node);
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export const listGates = async (societyId: number): Promise<LocationDto[]> => {
  const rows = await LocationNode.findAll({
    where: { societyId, nodeType: 'AREA', areaType: 'GATE', status: 'ACTIVE' },
    order: [
      ['sortOrder', 'ASC'],
      ['name', 'ASC'],
    ],
  });
  const labels = await pathLabels(societyId, rows);
  return rows.map(n => toDto(n, labels.get(n.id)!, true));
};

export async function getByQrToken(societyId: number, qrToken: string): Promise<LocationDto | null> {
  const n = await LocationNode.findOne({ where: { societyId, qrToken } });
  if (!n) return null;
  return toDto(n, (await pathLabels(societyId, [n])).get(n.id)!, true);
}

// ------------------------------------------------------------------ building hooks
async function insertNode(
  values: Record<string, unknown> & { parentPath: string },
  t: Transaction,
): Promise<LocationNode> {
  const { parentPath, ...rest } = values;
  for (let attempt = 0; ; attempt++) {
    try {
      const n = await LocationNode.create({ ...rest, path: '/', qrToken: newQrToken() } as never, {
        transaction: t,
      });
      n.path = `${parentPath}${n.id}/`;
      await n.save({ transaction: t });
      return n;
    } catch (err) {
      // a QR collision (62^12) is retried; a sibling name clash is reported
      if (isUniqueViolation(err) && /qr/i.test(String((err as { message?: string }).message)) && attempt < 3)
        continue;
      throw err;
    }
  }
}

/** Building hook: the BUILDING node of a new building (BR-08-39). */
export async function createBuildingNode(ctx: Ctx, b: Building, t: Transaction): Promise<LocationNode> {
  return insertNode(
    {
      societyId: b.societyId,
      parentId: null,
      nodeType: 'BUILDING',
      areaType: null,
      name: b.name,
      buildingId: b.id!,
      floor: null,
      depth: 1,
      sortOrder: b.sortOrder,
      status: 'ACTIVE',
      archivedAt: null,
      notes: null,
      version: 1,
      createdBy: ctx.user?.id ?? null,
      updatedBy: ctx.user?.id ?? null,
      parentPath: '/',
    },
    t,
  );
}

export async function renameBuildingNode(
  societyId: number,
  buildingId: number,
  name: string,
  sortOrder: number,
  t: Transaction,
) {
  await sequelize.query(
    `UPDATE location_nodes SET name = :name, sortOrder = :sortOrder, version = version + 1, updatedAt = :at
      WHERE societyId = :societyId AND buildingId = :buildingId AND nodeType = 'BUILDING'`,
    { replacements: { name, sortOrder, societyId, buildingId, at: now() }, transaction: t },
  );
}

/** Building hook: archive the whole subtree of the building (BR-08-18). */
export async function archiveBuildingNodes(
  societyId: number,
  buildingId: number,
  t: Transaction,
): Promise<void> {
  await sequelize.query(
    `UPDATE location_nodes SET status = 'ARCHIVED', archivedAt = :at, version = version + 1, updatedAt = :at
      WHERE societyId = :societyId AND buildingId = :buildingId AND status = 'ACTIVE'`,
    { replacements: { societyId, buildingId, at: now() }, transaction: t },
  );
}

/** Building hook: restore the BUILDING node only; floors and areas are restored one by one. */
export async function restoreBuildingNode(
  societyId: number,
  buildingId: number,
  t: Transaction,
): Promise<void> {
  await sequelize.query(
    `UPDATE location_nodes SET status = 'ACTIVE', archivedAt = NULL, version = version + 1, updatedAt = :at
      WHERE societyId = :societyId AND buildingId = :buildingId AND nodeType = 'BUILDING'`,
    { replacements: { societyId, buildingId, at: now() }, transaction: t },
  );
}

/** Building hook: delete every node of the building leaf first. A foreign key from another module raises the FK error. */
export async function deleteBuildingNodes(
  societyId: number,
  buildingId: number,
  t: Transaction,
): Promise<void> {
  for (let depth = MAX_DEPTH; depth >= 1; depth--)
    await sequelize.query(
      'DELETE FROM location_nodes WHERE societyId = :societyId AND buildingId = :buildingId AND depth = :depth',
      { replacements: { societyId, buildingId, depth }, transaction: t },
    );
}

export async function activeFloorNodesOutside(
  societyId: number,
  buildingId: number,
  min: number,
  max: number,
  t: Transaction,
): Promise<number> {
  return LocationNode.count({
    where: {
      societyId,
      buildingId,
      nodeType: 'FLOOR',
      status: 'ACTIVE',
      [Op.or]: [{ floor: { [Op.lt]: min } }, { floor: { [Op.gt]: max } }],
    },
    transaction: t,
  });
}

// ------------------------------------------------------------------ create (8.20)
export interface CreateLocationInput {
  parentId: number | null;
  nodeType: 'FLOOR' | 'AREA';
  floor?: number;
  areaType?: string;
  name?: string;
  sortOrder?: number;
  notes?: string | null;
}

async function lockNode(societyId: number, id: number, t: Transaction): Promise<LocationNode> {
  const n = await LocationNode.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!n) throw locationNotFound();
  return n;
}

async function assertSiblingFree(
  societyId: number,
  parentId: number | null,
  name: string,
  t: Transaction,
  exceptId?: number,
): Promise<void> {
  const clash = await LocationNode.findOne({
    where: {
      societyId,
      parentId,
      name,
      status: 'ACTIVE',
      ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}),
    },
    attributes: ['id'],
    transaction: t,
  });
  if (clash) throw nameTaken();
}

async function assertGateAllowed(ctx: Ctx, parent: LocationNode | null): Promise<void> {
  if (parent) throw parentInvalid('A gate must be at the top level');
  await entitlements.assertFeature(ctx, FEATURE.gates);
}

export async function createNode(
  ctx: Ctx,
  societyId: number,
  input: CreateLocationInput,
): Promise<LocationDto> {
  const id = await sequelize.transaction(async t => {
    let parent: LocationNode | null = null;
    if (input.parentId !== null) {
      parent = await lockNode(societyId, input.parentId, t);
      if (parent.status !== 'ACTIVE') throw parentInvalid('The parent location is archived');
      if (!CHILDREN[parent.nodeType]!.includes(input.nodeType))
        throw parentInvalid(
          `A ${input.nodeType.toLowerCase()} cannot be placed under a ${parent.nodeType.toLowerCase()}`,
        );
    } else if (input.nodeType === 'FLOOR') throw parentInvalid('A floor belongs to a building');
    const depth = (parent?.depth ?? 0) + 1;
    if (depth > MAX_DEPTH)
      throw new UnprocessableError(
        'LOCATION_DEPTH_EXCEEDED',
        'Locations can be nested at most 4 levels deep',
      );

    let name: string;
    let floor: number | null = parent?.floor ?? null;
    let areaType: string | null = null;
    if (input.nodeType === 'FLOOR') {
      if (input.floor === undefined)
        throw new ValidationError([{ field: 'floor', message: 'A floor node needs a floor number' }]);
      const b = await Building.findOne({ where: { id: parent!.buildingId!, societyId }, transaction: t });
      if (!b || !inFloorRange(b, input.floor))
        throw new UnprocessableError('FLOOR_OUT_OF_RANGE', 'This floor is outside the building', [
          {
            field: 'floor',
            message: `Use a floor from ${-(b?.basements ?? 0)} to ${b?.floorsAboveGround ?? 0}`,
          },
        ]);
      name = floorNodeName(input.floor);
      floor = input.floor;
    } else {
      if (!input.name) throw new ValidationError([{ field: 'name', message: 'An area needs a name' }]);
      if (!input.areaType)
        throw new ValidationError([{ field: 'areaType', message: 'An area needs a type' }]);
      name = input.name;
      areaType = input.areaType;
      if (areaType === 'GATE') await assertGateAllowed(ctx, parent);
    }
    await assertSiblingFree(societyId, input.parentId, name, t);
    let node: LocationNode;
    try {
      node = await insertNode(
        {
          societyId,
          parentId: input.parentId,
          nodeType: input.nodeType,
          areaType,
          name,
          buildingId: parent?.buildingId ?? null,
          floor,
          depth,
          sortOrder: input.sortOrder ?? 0,
          status: 'ACTIVE',
          archivedAt: null,
          notes: input.notes ?? null,
          version: 1,
          createdBy: ctx.user?.id ?? null,
          updatedBy: ctx.user?.id ?? null,
          parentPath: parent?.path ?? '/',
        },
        t,
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
    await audit(
      ctx,
      {
        action: AUDIT.locationCreated,
        entityType: ENTITY.location,
        entityId: node.id,
        entityLabel: name,
        societyId,
        after: { nodeType: node.nodeType, areaType, name, parentId: node.parentId, floor },
      },
      t,
    );
    return node.id;
  });
  return getNodeOrThrow(societyId, id);
}

// ------------------------------------------------------------------ edit and move
export interface PatchLocationInput {
  version: number;
  name?: string;
  areaType?: string;
  sortOrder?: number;
  notes?: string | null;
  parentId?: number | null;
}

export async function patchNode(
  ctx: Ctx,
  societyId: number,
  nodeId: number,
  input: PatchLocationInput,
): Promise<LocationDto> {
  await sequelize.transaction(async t => {
    const node = await lockNode(societyId, nodeId, t);
    if (node.nodeType === 'BUILDING') throw managed();
    if (node.version !== input.version) throw staleVersion('This location');
    if (node.status !== 'ACTIVE') throw invalidState('Restore this location before editing it');
    if (node.nodeType === 'FLOOR') {
      if (input.name !== undefined || input.areaType !== undefined)
        throw new ValidationError([
          { field: input.name !== undefined ? 'name' : 'areaType', message: 'Floors name themselves' },
        ]);
      if (input.parentId !== undefined && input.parentId !== node.parentId)
        throw parentInvalid('A floor stays in its building');
    }

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const updates: Record<string, unknown> = {};
    for (const field of ['name', 'areaType', 'sortOrder', 'notes'] as const) {
      const value = input[field];
      if (value === undefined || node[field] === value) continue;
      before[field] = node[field];
      after[field] = value;
      updates[field] = value;
    }

    let newParent: LocationNode | null = null;
    const moved = input.parentId !== undefined && input.parentId !== node.parentId;
    if (moved && input.parentId !== null) {
      newParent = await lockNode(societyId, input.parentId!, t);
      if (newParent.path.startsWith(node.path))
        throw new UnprocessableError('LOCATION_CYCLE', 'A location cannot be moved under itself');
      if (newParent.status !== 'ACTIVE') throw parentInvalid('The parent location is archived');
      if (!CHILDREN[newParent.nodeType]!.includes(node.nodeType))
        throw parentInvalid(
          `A ${node.nodeType.toLowerCase()} cannot be placed under a ${newParent.nodeType.toLowerCase()}`,
        );
    }

    const targetParentId = moved ? (input.parentId ?? null) : node.parentId;
    const targetAreaType = input.areaType ?? node.areaType;
    if (targetAreaType === 'GATE' && (input.areaType === 'GATE' || moved)) {
      if (targetParentId !== null) throw parentInvalid('A gate must be at the top level');
      if (input.areaType === 'GATE' && node.areaType !== 'GATE')
        await entitlements.assertFeature(ctx, FEATURE.gates);
    }
    if (input.name !== undefined || moved)
      await assertSiblingFree(societyId, targetParentId, input.name ?? node.name, t, node.id);

    if (moved) {
      const oldParentPath = node.path.slice(0, node.path.length - `${node.id}/`.length);
      const newDepth = (newParent?.depth ?? 0) + 1;
      const [deepest] = await sequelize.query<{ d: number }>(
        'SELECT MAX(depth) AS d FROM location_nodes WHERE societyId = :societyId AND path LIKE :like',
        { replacements: { societyId, like: `${node.path}%` }, type: QueryTypes.SELECT, transaction: t },
      );
      const delta = newDepth - node.depth;
      if (Number(deepest?.d ?? node.depth) + delta > MAX_DEPTH)
        throw new UnprocessableError(
          'LOCATION_DEPTH_EXCEEDED',
          'Locations can be nested at most 4 levels deep',
        );
      before.parentId = node.parentId;
      after.parentId = input.parentId ?? null;
      try {
        await sequelize.query(
          `UPDATE location_nodes SET path = CONCAT(:newParentPath, SUBSTRING(path, :cut)), depth = depth + :delta,
                  buildingId = :buildingId, floor = :floor, updatedAt = :at
            WHERE societyId = :societyId AND path LIKE :like`,
          {
            replacements: {
              newParentPath: newParent?.path ?? '/',
              cut: oldParentPath.length + 1,
              delta,
              buildingId: newParent?.buildingId ?? null,
              floor: newParent?.floor ?? null,
              societyId,
              like: `${node.path}%`,
              at: now(),
            },
            transaction: t,
          },
        );
      } catch (err) {
        if (isUniqueViolation(err)) throw nameTaken();
        throw err;
      }
      // the raw UPDATE wrote path, depth, buildingId and floor; reload so that `save` does not write stale values back
      await node.reload({ transaction: t });
      updates.parentId = input.parentId ?? null;
    }

    if (!Object.keys(after).length) return;
    node.set(updates as never);
    node.version += 1;
    node.updatedBy = ctx.user?.id ?? null;
    try {
      await node.save({ transaction: t });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
    await audit(
      ctx,
      {
        action: moved ? AUDIT.locationMoved : AUDIT.locationUpdated,
        entityType: ENTITY.location,
        entityId: node.id,
        entityLabel: node.name,
        societyId,
        before,
        after,
      },
      t,
    );
  });
  return getNodeOrThrow(societyId, nodeId);
}

// ------------------------------------------------------------------ archive, restore, QR
export async function archiveNode(
  ctx: Ctx,
  societyId: number,
  nodeId: number,
  version: number,
): Promise<LocationDto> {
  await sequelize.transaction(async t => {
    const node = await lockNode(societyId, nodeId, t);
    if (node.nodeType === 'BUILDING') throw managed();
    if (node.status === 'ARCHIVED') throw invalidState('This location is already archived');
    if (node.version !== version) throw staleVersion('This location');
    const [, count] = (await sequelize.query(
      `UPDATE location_nodes SET status = 'ARCHIVED', archivedAt = :at, version = version + 1, updatedBy = :by, updatedAt = :at
        WHERE societyId = :societyId AND path LIKE :like AND status = 'ACTIVE'`,
      {
        replacements: { societyId, like: `${node.path}%`, at: now(), by: ctx.user?.id ?? null },
        type: QueryTypes.UPDATE,
        transaction: t,
      },
    )) as unknown as [unknown, number];
    await audit(
      ctx,
      {
        action: AUDIT.locationArchived,
        entityType: ENTITY.location,
        entityId: nodeId,
        entityLabel: node.name,
        societyId,
        after: { archivedNodes: count },
      },
      t,
    );
  });
  return getNodeOrThrow(societyId, nodeId);
}

export async function restoreNode(
  ctx: Ctx,
  societyId: number,
  nodeId: number,
  version: number,
): Promise<LocationDto> {
  await sequelize.transaction(async t => {
    const node = await lockNode(societyId, nodeId, t);
    if (node.nodeType === 'BUILDING') throw managed();
    if (node.status === 'ACTIVE') throw invalidState('This location is already active');
    if (node.version !== version) throw staleVersion('This location');
    if (node.parentId) {
      const parent = await LocationNode.findOne({ where: { id: node.parentId, societyId }, transaction: t });
      if (!parent || parent.status !== 'ACTIVE') throw parentInvalid('Restore the parent location first');
    }
    await assertSiblingFree(societyId, node.parentId, node.name, t, node.id);
    node.status = 'ACTIVE';
    node.archivedAt = null;
    node.version += 1;
    node.updatedBy = ctx.user?.id ?? null;
    try {
      await node.save({ transaction: t });
    } catch (err) {
      if (isUniqueViolation(err)) throw nameTaken();
      throw err;
    }
    await audit(
      ctx,
      {
        action: AUDIT.locationRestored,
        entityType: ENTITY.location,
        entityId: nodeId,
        entityLabel: node.name,
        societyId,
      },
      t,
    );
  });
  return getNodeOrThrow(societyId, nodeId);
}

export async function regenerateQr(
  ctx: Ctx,
  societyId: number,
  nodeId: number,
  version: number,
): Promise<LocationDto> {
  await sequelize.transaction(async t => {
    const node = await lockNode(societyId, nodeId, t);
    if (node.nodeType === 'BUILDING') throw managed();
    if (node.version !== version) throw staleVersion('This location');
    for (let attempt = 0; ; attempt++) {
      try {
        node.qrToken = newQrToken();
        node.version += 1;
        node.updatedBy = ctx.user?.id ?? null;
        await node.save({ transaction: t });
        break;
      } catch (err) {
        if (isUniqueViolation(err) && attempt < 3) {
          node.version -= 1;
          continue;
        }
        throw err;
      }
    }
    // the audit row never holds the token itself
    await audit(
      ctx,
      {
        action: AUDIT.locationQrRegenerated,
        entityType: ENTITY.location,
        entityId: nodeId,
        entityLabel: node.name,
        societyId,
      },
      t,
    );
  });
  return getNodeOrThrow(societyId, nodeId);
}
