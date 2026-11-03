import { Op, type Transaction } from 'sequelize';
import { Resident, Society, UnitResident, sequelize } from '../../models';
import type { Ctx } from '../../types/context';
import { ForbiddenError } from '../../utils/errors';
import { settings } from '../society-setup/society-setup.public';
import { isOwnerRelation, residentNotFound, rule, societyToday, addDaysYmd } from './residents.shared';

/** Helpers shared by the part 2 services (join requests, tenancies and moves). */

/** The resident record of the signed-in user in this society. */
export async function callerResident(ctx: Ctx, societyId: number, t?: Transaction): Promise<Resident> {
  const r = ctx.user
    ? await Resident.findOne({ where: { societyId, userId: ctx.user.id }, transaction: t })
    : null;
  if (!r) throw residentNotFound();
  return r;
}

/** BR-09-27 on a pair of agreement dates; `field` names the first date in the error. */
export async function assertTenancyDates(
  societyId: number,
  start: string,
  end: string,
  field = 'agreementStart',
): Promise<void> {
  const today = await societyToday(societyId);
  const maxMonths = (await settings.get(societyId, 'residents.tenancyMaxMonths')) as number;
  const bad = (message: string, f = field) => rule(422, 'TENANCY_DATES_INVALID', message, f);
  if (end <= start) throw bad('The agreement must end after it starts', 'agreementEnd');
  if (start < addDaysYmd(today, -365)) throw bad('The agreement started more than 365 days ago');
  if (start > addDaysYmd(today, 90)) throw bad('The agreement starts too far ahead');
  const limit = new Date(`${start}T00:00:00Z`);
  limit.setUTCMonth(limit.getUTCMonth() + maxMonths);
  if (new Date(`${end}T00:00:00Z`) > limit)
    throw bad(`The agreement cannot be longer than ${maxMonths} months`, 'agreementEnd');
}

/** The open owner link that is the primary contact, else any open owner link (BR-09-28 landlord). */
export const primaryOwnerOf = (links: UnitResident[]): UnitResident | undefined => {
  const owners = links.filter(l => l.toDate === null && isOwnerRelation(l.relation));
  return owners.find(l => l.isPrimary) ?? owners.find(l => l.relation === 'OWNER') ?? owners[0];
};

/** User ids (logins) of the residents with these ids. */
export async function userIdsOf(societyId: number, residentIds: (number | null)[]): Promise<number[]> {
  const ids = residentIds.filter((x): x is number => x !== null);
  if (!ids.length) return [];
  const rows = await Resident.findAll({
    where: { societyId, id: { [Op.in]: ids }, userId: { [Op.ne]: null } },
    attributes: ['userId'],
    paranoid: false,
  });
  return rows.map(r => r.userId!);
}

/** Logins of the people who live in a unit today: residing links with a login (move approvals), else the primary owner. */
export async function unitHouseholdUserIds(societyId: number, unitId: number): Promise<number[]> {
  const today = await societyToday(societyId);
  const links = await UnitResident.findAll({
    where: {
      societyId,
      unitId,
      fromDate: { [Op.lte]: today },
      [Op.or]: [{ toDate: null }, { toDate: { [Op.gte]: today } }],
    },
  });
  const ids = links
    .filter(l => l.isResiding || (isOwnerRelation(l.relation) && l.isPrimary))
    .map(l => l.residentId);
  return userIdsOf(societyId, ids);
}

/** Login of the primary owner of the unit, when there is one. */
export async function primaryOwnerUserIds(societyId: number, unitId: number): Promise<number[]> {
  const links = await UnitResident.findAll({ where: { societyId, unitId, toDate: null } });
  const p = primaryOwnerOf(links);
  return p ? userIdsOf(societyId, [p.residentId]) : [];
}

/** Runs `fn` inside a savepoint: a business failure rolls back only what `fn` wrote and is returned, not thrown. */
let spSeq = 0;
export async function inSavepoint<T>(
  t: Transaction,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const name = `sp_p2_${++spSeq}`;
  await sequelize.query(`SAVEPOINT ${name}`, { transaction: t });
  try {
    const value = await fn();
    await sequelize.query(`RELEASE SAVEPOINT ${name}`, { transaction: t });
    return { ok: true, value };
  } catch (error) {
    await sequelize.query(`ROLLBACK TO SAVEPOINT ${name}`, { transaction: t });
    return { ok: false, error };
  }
}

export const ownerActionOnly = () =>
  new ForbiddenError('OWNER_ACTION_ONLY', 'Only an owner of the flat can do this');

export const rupees = (paise: number | string): string => (Number(paise) / 100).toFixed(2);

export const num = (v: number | string): number => Number(v);

/** Society name for notification data. */
export async function societyName(societyId: number): Promise<string> {
  return (await Society.findByPk(societyId, { attributes: ['name'] }))?.name ?? 'Your society';
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`). */
export const daysBetween = (from: string, to: string): number =>
  Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);

/** The caller may see contacts unmasked (`residents.contacts.view`). */
export const canSeeContacts = (ctx: Ctx): boolean => ctx.permissions?.has('residents.contacts.view') ?? false;
