import { Op } from 'sequelize';
import { Resident, Tenancy, Unit, UnitResident } from '../../models';
import type { LinkRelation } from '../../models/unit-resident.model';
import type { Ctx } from '../../types/context';
import { units } from '../society-setup/society-setup.public';
import { RELATION_RANK, type AccessRelation, type Occupancy } from './residents.constants';
import { occupancyOfIn } from './residents.occupancy';
import { accessRelationOf, isOwnerRelation, societyToday } from './residents.shared';

/** Readers other modules call through `residents.public.ts` (section 8.22). Every one filters by `societyId`. */
const activeWhere = (date: string) => ({
  fromDate: { [Op.lte]: date },
  [Op.or]: [{ toDate: null }, { toDate: { [Op.gte]: date } }],
});

export interface ListedLink {
  linkId: number;
  residentId: number;
  userId: number | null;
  name: string;
  mobile: string | null;
  email: string | null;
  relation: LinkRelation;
  sharePercent: string | null;
  isPrimary: boolean;
  isResiding: boolean;
  canLogin: boolean;
  tenancyId: number | null;
  fromDate: string;
  toDate: string | null;
}

/** `residents.listForUnit(societyId, unitId, opts)`: links active on `date` (default today), or overlapping `from`..`to`. */
export async function listForUnit(
  societyId: number,
  unitId: number,
  opts: { relation?: LinkRelation | LinkRelation[]; date?: string; from?: string; to?: string } = {},
): Promise<ListedLink[]> {
  const where: Record<string, unknown> = { societyId, unitId };
  if (opts.from && opts.to) {
    where.fromDate = { [Op.lte]: opts.to };
    where[Op.or as unknown as string] = [{ toDate: null }, { toDate: { [Op.gte]: opts.from } }];
  } else Object.assign(where, activeWhere(opts.date ?? (await societyToday(societyId))));
  if (opts.relation)
    where.relation = Array.isArray(opts.relation) ? { [Op.in]: opts.relation } : opts.relation;
  const links = await UnitResident.findAll({ where, order: [['id', 'ASC']] });
  const residents = new Map(
    (
      await Resident.findAll({
        where: { societyId, id: { [Op.in]: [...new Set(links.map(l => l.residentId))] } },
        paranoid: false,
      })
    ).map(r => [r.id!, r]),
  );
  return links.map(l => {
    const r = residents.get(l.residentId);
    return {
      linkId: l.id!,
      residentId: l.residentId,
      userId: r?.userId ?? null,
      name: r?.name ?? '',
      mobile: r?.mobile ?? null,
      email: r?.email ?? null,
      relation: l.relation,
      sharePercent: l.sharePercent,
      isPrimary: Boolean(l.isPrimary),
      isResiding: Boolean(l.isResiding),
      canLogin: Boolean(l.canLogin),
      tenancyId: l.tenancyId,
      fromDate: l.fromDate,
      toDate: l.toDate,
    };
  });
}

/** `residents.changedSince(societyId, since)` for module 11. */
export async function changedSince(societyId: number, since: Date): Promise<boolean> {
  if (await UnitResident.count({ where: { societyId, updatedAt: { [Op.gt]: since } } })) return true;
  return (await Tenancy.count({ where: { societyId, updatedAt: { [Op.gt]: since } } })) > 0;
}

export interface BillTo {
  societyId: number;
  residentId: number;
  userId: number | null;
  name: string;
  mobile: string | null;
  email: string | null;
  relation: 'OWNER' | 'CO_OWNER' | 'TENANT';
  tenancyId: number | null;
}

/**
 * BR-09-70: the bill recipient of a unit on a date. A tenancy of the unit that is ACTIVE or EXPIRED_OVERSTAY (or ENDED with
 * `endedOn >= date`) with `agreementStart <= date` and `maintenancePayer = TENANT` names the tenant; else the OWNER link active
 * on the date (today: the primary owner); else the CO_OWNER link with the lowest id; else null (an unsold builder flat).
 */
export async function billToFor(unitId: number, date: string): Promise<BillTo | null> {
  const unit = await Unit.findByPk(unitId, { attributes: ['id', 'societyId'] });
  if (!unit) return null;
  const societyId = unit.societyId;
  const person = async (residentId: number) =>
    (await Resident.findOne({ where: { id: residentId, societyId }, paranoid: false }))!;
  const tenancy = await Tenancy.findOne({
    where: {
      societyId,
      unitId,
      maintenancePayer: 'TENANT',
      agreementStart: { [Op.lte]: date },
      [Op.or]: [
        { status: { [Op.in]: ['ACTIVE', 'EXPIRED_OVERSTAY'] } },
        { status: 'ENDED', endedOn: { [Op.gte]: date } },
      ],
    },
    order: [['id', 'DESC']],
  });
  if (tenancy) {
    const p = await person(tenancy.tenantResidentId);
    return {
      societyId,
      residentId: p.id!,
      userId: p.userId,
      name: p.name,
      mobile: p.mobile,
      email: p.email,
      relation: 'TENANT',
      tenancyId: tenancy.id!,
    };
  }
  const owners = await UnitResident.findAll({
    where: { societyId, unitId, relation: { [Op.in]: ['OWNER', 'CO_OWNER'] }, ...activeWhere(date) },
    order: [['id', 'ASC']],
  });
  const pick =
    owners.filter(o => o.relation === 'OWNER').sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0] ??
    owners.filter(o => o.relation === 'CO_OWNER')[0];
  if (!pick) return null;
  const p = await person(pick.residentId);
  return {
    societyId,
    residentId: p.id!,
    userId: p.userId,
    name: p.name,
    mobile: p.mobile,
    email: p.email,
    relation: pick.relation as 'OWNER' | 'CO_OWNER',
    tenancyId: null,
  };
}

/** BR-09-8 and BR-09-9: the active links of a user in a society, one row per unit, the strongest relation kept. */
export async function getActiveUnitLinks(
  societyId: number,
  userId: number,
): Promise<{ unitId: number; relation: AccessRelation }[]> {
  const today = await societyToday(societyId);
  const residents = await Resident.findAll({
    where: { societyId, userId, status: 'ACTIVE' },
    attributes: ['id'],
  });
  if (!residents.length) return [];
  const links = await UnitResident.findAll({
    where: { societyId, residentId: { [Op.in]: residents.map(r => r.id!) }, ...activeWhere(today) },
    attributes: ['unitId', 'relation'],
    order: [['id', 'ASC']],
  });
  const best = new Map<number, AccessRelation>();
  for (const l of links) {
    const rel = accessRelationOf(l.relation);
    const cur = best.get(l.unitId);
    if (!cur || RELATION_RANK[rel] > RELATION_RANK[cur]) best.set(l.unitId, rel);
  }
  return [...best].map(([unitId, relation]) => ({ unitId, relation }));
}

export async function unitIdsForUser(societyId: number, userId: number): Promise<number[]> {
  return (await getActiveUnitLinks(societyId, userId)).map(l => l.unitId);
}

/**
 * `getHouseholdControl(ctx, memberId)` for module 03: the unit ids where the caller holds an active OWNER or CO_OWNER link of
 * the owner household, or the TENANT link of the tenancy household, in which the member's resident has an active FAMILY or
 * CARETAKER link of that same household; null when none.
 */
export async function getHouseholdControl(ctx: Ctx, memberId: number): Promise<{ unitIds: number[] } | null> {
  const societyId = ctx.society?.id;
  if (!societyId || !ctx.user) return null;
  const today = await societyToday(societyId);
  const target = await Resident.findOne({ where: { societyId, memberId } });
  if (!target) return null;
  const mine = await Resident.findAll({ where: { societyId, userId: ctx.user.id }, attributes: ['id'] });
  if (!mine.length) return null;
  const theirs = await UnitResident.findAll({
    where: {
      societyId,
      residentId: target.id!,
      relation: { [Op.in]: ['FAMILY', 'CARETAKER'] },
      ...activeWhere(today),
    },
  });
  const unitIds: number[] = [];
  for (const l of theirs) {
    const control = await UnitResident.findOne({
      where: {
        societyId,
        unitId: l.unitId,
        residentId: { [Op.in]: mine.map(m => m.id!) },
        ...activeWhere(today),
        ...(l.tenancyId === null
          ? { relation: { [Op.in]: ['OWNER', 'CO_OWNER'] } }
          : { relation: 'TENANT', tenancyId: l.tenancyId }),
      },
    });
    if (control) unitIds.push(l.unitId);
  }
  return unitIds.length ? { unitIds: [...new Set(unitIds)] } : null;
}

export async function activeLinkCount(societyId: number, unitId: number): Promise<number> {
  return UnitResident.count({ where: { societyId, unitId, ...activeWhere(await societyToday(societyId)) } });
}

export async function occupancyOf(societyId: number, unitIds: number[]): Promise<Map<number, Occupancy>> {
  return occupancyOfIn(societyId, unitIds, await societyToday(societyId));
}

export async function getSummary(societyId: number, residentId: number) {
  const r = await Resident.findOne({ where: { id: residentId, societyId }, paranoid: false });
  return r ? { id: r.id!, name: r.name, userId: r.userId, status: r.status } : null;
}

/** Module 17: residing links with a login; else the primary owner (a person with a login). */
export async function visitorApproverUserIds(societyId: number, unitId: number): Promise<number[]> {
  const links = await listForUnit(societyId, unitId);
  const residing = links.filter(l => l.isResiding && l.userId !== null).map(l => l.userId!);
  if (residing.length) return [...new Set(residing)];
  const owner = links
    .filter(l => isOwnerRelation(l.relation) && l.userId !== null)
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0];
  return owner ? [owner.userId!] : [];
}

/** Module 16: the users with a login in an audience of the society. */
export async function audienceUserIds(
  societyId: number,
  a: { type: 'ALL' | 'OWNERS' | 'TENANTS' | 'BUILDING' | 'UNITS'; buildingId?: number; unitIds?: number[] },
): Promise<number[]> {
  const today = await societyToday(societyId);
  const where: Record<string, unknown> = { societyId, ...activeWhere(today) };
  if (a.type === 'OWNERS') where.relation = { [Op.in]: ['OWNER', 'CO_OWNER'] };
  if (a.type === 'TENANTS') where.relation = 'TENANT';
  if (a.type === 'UNITS') where.unitId = { [Op.in]: a.unitIds ?? [] };
  if (a.type === 'BUILDING') {
    const ids = (await units.listActive(societyId, { buildingId: a.buildingId })).map(u => u.id);
    where.unitId = { [Op.in]: ids };
  }
  const links = await UnitResident.findAll({ where, attributes: ['residentId'] });
  const residents = await Resident.findAll({
    where: {
      societyId,
      status: 'ACTIVE',
      userId: { [Op.ne]: null },
      id: { [Op.in]: [...new Set(links.map(l => l.residentId))] },
    },
    attributes: ['userId'],
  });
  return [...new Set(residents.map(r => r.userId!))];
}
