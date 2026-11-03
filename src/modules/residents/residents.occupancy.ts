import { Op, type Transaction } from 'sequelize';
import { Tenancy, UnitResident } from '../../models';
import { isOwnerRelation } from './residents.shared';
import type { Occupancy } from './residents.constants';

/**
 * Occupancy of units (BR-09-16, derived, never stored): RENTED when an ACTIVE or EXPIRED_OVERSTAY tenancy exists and its
 * tenant link has `isResiding = 1`; else OWNER_OCCUPIED when an active OWNER or CO_OWNER link has `isResiding = 1`; else
 * VACANT. One query for the links and one for the tenancies of the whole unit set.
 */
export async function occupancyOfIn(
  societyId: number,
  unitIds: number[],
  date: string,
  t?: Transaction,
): Promise<Map<number, Occupancy>> {
  const out = new Map<number, Occupancy>(unitIds.map(u => [u, 'VACANT']));
  if (!unitIds.length) return out;
  const links = await UnitResident.findAll({
    where: {
      societyId,
      unitId: { [Op.in]: unitIds },
      fromDate: { [Op.lte]: date },
      [Op.or]: [{ toDate: null }, { toDate: { [Op.gte]: date } }],
      isResiding: true,
    },
    attributes: ['unitId', 'relation', 'tenancyId'],
    transaction: t,
  });
  const tenancies = await Tenancy.findAll({
    where: { societyId, unitId: { [Op.in]: unitIds }, status: { [Op.in]: ['ACTIVE', 'EXPIRED_OVERSTAY'] } },
    attributes: ['id', 'unitId'],
    transaction: t,
  });
  const rented = new Set(
    tenancies
      .filter(tn => links.some(l => l.relation === 'TENANT' && l.tenancyId === tn.id))
      .map(tn => tn.unitId),
  );
  for (const u of unitIds) {
    if (rented.has(u)) out.set(u, 'RENTED');
    else if (links.some(l => l.unitId === u && isOwnerRelation(l.relation))) out.set(u, 'OWNER_OCCUPIED');
  }
  return out;
}
