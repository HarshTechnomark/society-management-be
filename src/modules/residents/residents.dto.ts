import { Op } from 'sequelize';
import { Unit, UnitResident } from '../../models';
import { isOwnerRelation, shareOut } from './residents.shared';

/** The link as the API sends it (8.2, 8.5, 8.8). A sole owner without a stored share is shown as 100.00 (BR-09-12). */
export interface LinkDto {
  linkId: number;
  unitId: number;
  unitLabel: string;
  relation: string;
  familyRelation: string | null;
  sharePercent: string | null;
  isPrimary: boolean;
  isResiding: boolean;
  canLogin: boolean;
  tenancyId: number | null;
  fromDate: string;
  toDate: string | null;
  endReason: string | null;
  version: number;
}

export async function linkDtos(societyId: number, links: UnitResident[]): Promise<LinkDto[]> {
  if (!links.length) return [];
  const unitIds = [...new Set(links.map(l => l.unitId))];
  const labels = new Map(
    (await Unit.findAll({ where: { societyId, id: { [Op.in]: unitIds } }, attributes: ['id', 'label'] })).map(
      u => [u.id!, u.label],
    ),
  );
  const owners = await UnitResident.findAll({
    where: {
      societyId,
      unitId: { [Op.in]: unitIds },
      toDate: null,
      relation: { [Op.in]: ['OWNER', 'CO_OWNER'] },
    },
    attributes: ['unitId'],
  });
  const ownerCount = new Map<number, number>();
  for (const o of owners) ownerCount.set(o.unitId, (ownerCount.get(o.unitId) ?? 0) + 1);
  return links.map(l => ({
    linkId: l.id!,
    unitId: l.unitId,
    unitLabel: labels.get(l.unitId) ?? '',
    relation: l.relation,
    familyRelation: l.familyRelation,
    sharePercent:
      l.sharePercent !== null
        ? shareOut(l.sharePercent)
        : isOwnerRelation(l.relation) && l.toDate === null && ownerCount.get(l.unitId) === 1
          ? '100.00'
          : null,
    isPrimary: Boolean(l.isPrimary),
    isResiding: Boolean(l.isResiding),
    canLogin: Boolean(l.canLogin),
    tenancyId: l.tenancyId,
    fromDate: l.fromDate,
    toDate: l.toDate,
    endReason: l.endReason,
    version: l.version,
  }));
}
