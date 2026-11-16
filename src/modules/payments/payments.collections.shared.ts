import { Op } from 'sequelize';
import { Collection, CollectionRequest, Resident, UnitResident, User } from '../../models';
import { emitToRoom } from '../../lib/realtime';
import type { Ctx } from '../../types/context';
import { ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import { residents } from '../residents/residents.public';
import { units } from '../society-setup/society-setup.public';
import type { UnitDto } from '../society-setup/society-setup.types';
import { ERR, RT, roomFinance, roomPublic } from './payments.constants';

/** Small helpers shared by the sub-module 12.5 files (collections). */
export const societyIdOf = (ctx: Ctx): number => {
  const id = ctx.society?.id;
  if (!id) throw new Error('society context missing');
  return id;
};
export const userIdOf = (ctx: Ctx): number | null => ctx.user?.id ?? null;

export const collectionNotFound = () => new NotFoundError(ERR.collectionNotFound, 'Collection not found');
export const requestNotFound = () => new NotFoundError(ERR.requestNotFound, 'Collection request not found');
export const invalidState = (message: string) => new ConflictError(ERR.invalidState, message);
export const staleVersion = () =>
  new ConflictError(ERR.staleVersion, 'This was changed by someone else. Reload and try again.');
export const noAudience = () =>
  new UnprocessableError(ERR.collectionNoAudience, 'No flat matches this audience');

/** `percent = min(100, floor(collected x 100 / target))`. */
export const percentOf = (collectedPaise: number, targetPaise: number): number =>
  targetPaise > 0 ? Math.min(100, Math.floor((collectedPaise * 100) / targetPaise)) : 0;

export const title = (id: number) => `COL-${id}`;

/** Escapes `%`, `_` and the escape character itself for a LIKE pattern. */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

/** Names of the users by id (creator and approver of the DTOs). */
export async function userNames(ids: (number | null)[]): Promise<Map<number, string>> {
  const list = [...new Set(ids.filter((i): i is number => i !== null && i !== undefined))];
  if (!list.length) return new Map();
  const rows = await User.findAll({ where: { id: { [Op.in]: list } }, attributes: ['id', 'name'] });
  return new Map(rows.map(u => [Number(u.id), u.name ?? 'User']));
}

export interface AudienceSpec {
  audienceType: 'ALL' | 'BUILDINGS' | 'UNITS';
  audienceIds: number[] | null;
  includeVacant: boolean;
}

/**
 * BR-12-41: the active units of the audience, limited to the chosen buildings or units; units with no current resident
 * (module 09) are dropped unless `includeVacant`.
 */
export async function resolveAudience(
  societyId: number,
  spec: AudienceSpec,
  today: string,
  onlyUnitIds?: number[],
): Promise<UnitDto[]> {
  const ids = onlyUnitIds ?? (spec.audienceType === 'UNITS' ? (spec.audienceIds ?? []) : undefined);
  if (ids && ids.length === 0) return [];
  let list = await units.listActive(societyId, ids ? { unitIds: ids } : {});
  if (spec.audienceType === 'BUILDINGS') {
    const b = new Set(spec.audienceIds ?? []);
    list = list.filter(u => b.has(u.buildingId));
  }
  if (!spec.includeVacant && list.length) {
    const occupied = new Set<number>();
    const unitIds = list.map(u => u.id);
    for (let i = 0; i < unitIds.length; i += 1000) {
      const rows = await UnitResident.findAll({
        where: {
          societyId,
          unitId: { [Op.in]: unitIds.slice(i, i + 1000) },
          fromDate: { [Op.lte]: today },
          [Op.or]: [{ toDate: null }, { toDate: { [Op.gte]: today } }],
        },
        attributes: ['unitId'],
      });
      for (const r of rows) occupied.add(Number(r.unitId));
    }
    list = list.filter(u => occupied.has(u.id));
  }
  return list;
}

/** Bill-to user ids of the given requests (distinct, null users dropped). */
export async function billToUserIds(societyId: number, residentIds: (number | null)[]): Promise<number[]> {
  const ids = [...new Set(residentIds.filter((i): i is number => i !== null))];
  if (!ids.length) return [];
  const rows = await Resident.findAll({
    where: { societyId, id: { [Op.in]: ids } },
    attributes: ['userId'],
    paranoid: false,
  });
  return [
    ...new Set(
      rows
        .map(r => r.userId)
        .filter((u): u is number => !!u)
        .map(Number),
    ),
  ];
}

/** Bill-to of a unit today (module 09). */
export const billToOf = (unitId: number, today: string) => residents.billToFor(unitId, today);

/** Section 9.3 `collection.progress` to the finance room (with counts) and the public room (no counts when HIDDEN). */
export function emitProgress(
  c: Pick<
    Collection,
    | 'id'
    | 'societyId'
    | 'collectedPaise'
    | 'targetPaise'
    | 'contributorCount'
    | 'requestCount'
    | 'payListVisibility'
  >,
): void {
  const societyId = Number(c.societyId);
  const base = {
    collectionId: Number(c.id),
    collectedPaise: Number(c.collectedPaise),
    targetPaise: Number(c.targetPaise),
  };
  emitToRoom(roomFinance(societyId), RT.collectionProgress, {
    ...base,
    contributorCount: Number(c.contributorCount),
    requestCount: Number(c.requestCount),
  });
  emitToRoom(
    roomPublic(societyId),
    RT.collectionProgress,
    c.payListVisibility === 'HIDDEN'
      ? base
      : { ...base, contributorCount: Number(c.contributorCount), requestCount: Number(c.requestCount) },
  );
}

/** BR-12-57: module 24 `reportsCache.touch(societyId, 'finance')` after commit. Module 24 is not built: a no-op hook. */
export const reportsCacheHook: { touch: (societyId: number, area: 'finance') => void } = {
  touch: () => undefined,
};
export function touchReports(t: { afterCommit(fn: () => void): void }, societyId: number): void {
  t.afterCommit(() => {
    try {
      reportsCacheHook.touch(societyId, 'finance');
    } catch {
      /* never fails the write */
    }
  });
}

export type { CollectionRequest };

/**
 * Module 13 `expenses.listForCollection(societyId, collectionId)` (spending of a collection fund). Module 13 is not built:
 * the placeholder says nothing was spent. The owner replaces `expensesPort.listForCollection` at start-up.
 */
export interface CollectionExpense {
  title: string;
  category: string;
  date: string;
  amountPaise: number;
}
export const expensesPort: {
  listForCollection: (
    societyId: number,
    collectionId: number,
  ) => Promise<{ spentPaise: number; expenses: CollectionExpense[] }>;
} = {
  listForCollection: async () => ({ spentPaise: 0, expenses: [] }),
};
