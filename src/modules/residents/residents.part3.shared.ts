import { Op } from 'sequelize';
import { Resident, Unit, UnitResident } from '../../models';
import type { Transaction } from 'sequelize';
import type { Ctx } from '../../types/context';
import { ForbiddenError, NotFoundError } from '../../utils/errors';
import { settings } from '../society-setup/society-setup.public';
import { OWNER_RELATIONS } from './residents.constants';
import { residentNotFound, unitNotFound } from './residents.shared';

/** Helpers shared by the renovation permit and ownership transfer services (module 09 part 3). */
export const ownerOnly = () =>
  new ForbiddenError('OWNER_ACTION_ONLY', 'Only an owner of the flat can do this');
export const permitNotFound = () => new NotFoundError('PERMIT_NOT_FOUND', 'Renovation permit not found');
export const transferNotFound = () => new NotFoundError('TRANSFER_NOT_FOUND', 'Ownership transfer not found');

/** `10:00:00` from a TIME column to `10:00`. */
export const hhmm = (v: string): string => v.slice(0, 5);
export const num = (v: number | string): number => Number(v);
/** Whole days from `a` to `b` (both `YYYY-MM-DD`). */
export const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export async function unitLabels(societyId: number, ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await Unit.findAll({
    where: { societyId, id: { [Op.in]: [...new Set(ids)] } },
    attributes: ['id', 'label'],
  });
  return new Map(rows.map(u => [u.id!, u.label]));
}

export async function unitLabel(societyId: number, unitId: number): Promise<string> {
  return (await unitLabels(societyId, [unitId])).get(unitId) ?? '';
}

export async function readSettings<K extends string>(
  societyId: number,
  keys: K[],
): Promise<Record<K, unknown>> {
  return (await settings.getMany(societyId, keys)) as Record<K, unknown>;
}

/** The caller's own resident row in the society, or 404 `RESIDENT_NOT_FOUND`. */
export async function callerResident(ctx: Ctx, societyId: number): Promise<Resident> {
  const r = ctx.user ? await Resident.findOne({ where: { societyId, userId: ctx.user.id } }) : null;
  if (!r) throw residentNotFound();
  return r;
}

const activeOn = (d: string) => ({
  fromDate: { [Op.lte]: d },
  [Op.or]: [{ toDate: null }, { toDate: { [Op.gte]: d } }],
});

/** The caller's active owner link (OWNER or CO_OWNER) on a unit today, or null. */
export function ownerLinkOf(
  societyId: number,
  residentId: number,
  unitId: number,
  today: string,
  t?: Transaction,
) {
  return UnitResident.findOne({
    where: {
      societyId,
      residentId,
      unitId,
      relation: { [Op.in]: [...OWNER_RELATIONS] },
      ...activeOn(today),
    },
    transaction: t,
  });
}

/** A resident-app route only sees the caller's own units: any other unit is `404 UNIT_NOT_FOUND`. */
export function assertOwnUnit(ctx: Ctx, unitId: number): void {
  if (!(ctx.unitIds ?? []).includes(unitId)) throw unitNotFound();
}

/** User ids of the primary owner of a unit (fallback recipient when an admin raised a request). */
export async function primaryOwnerUserIds(societyId: number, unitId: number, t?: Transaction) {
  const link = await UnitResident.findOne({
    where: { societyId, unitId, toDate: null, relation: { [Op.in]: [...OWNER_RELATIONS] } },
    order: [
      ['isPrimary', 'DESC'],
      ['id', 'ASC'],
    ],
    transaction: t,
  });
  if (!link) return [];
  const r = await Resident.findByPk(link.residentId, { transaction: t });
  return r?.userId ? [r.userId] : [];
}

export async function userIdsOfResidents(societyId: number, residentIds: number[], t?: Transaction) {
  if (!residentIds.length) return [];
  const rows = await Resident.findAll({
    where: { societyId, id: { [Op.in]: residentIds } },
    attributes: ['userId'],
    paranoid: false,
    transaction: t,
  });
  return rows.map(r => r.userId).filter((u): u is number => u !== null);
}

export const PAGE_DEFAULTS = { page: 1, limit: 20 };
