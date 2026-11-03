import { Op, QueryTypes } from 'sequelize';
import {
  MoveRequest,
  OwnershipTransfer,
  Pet,
  RenovationPermit,
  Resident,
  Tenancy,
  UnitResident,
  sequelize,
} from '../../models';
import { audit } from '../../utils/audit';
import { ForbiddenError, UnprocessableError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { units } from '../society-setup/society-setup.public';
import type { UnitDto } from '../society-setup/society-setup.types';
import {
  AUDIT,
  ENTITY,
  FEATURE,
  OPEN_JOIN_STATUSES,
  OPEN_MOVE_STATUSES,
  OPEN_PERMIT_STATUSES,
  OPEN_TRANSFER_STATUSES,
  UNIT_FILTER_LIMIT,
  type Occupancy,
} from './residents.constants';
import { linkDtos } from './residents.dto';
import { occupancyOfIn } from './residents.occupancy';
import { residentPorts } from './residents.ports';
import { billToFor } from './residents.queries';
import { openRequestsOfUnit } from './residents.requests';
import {
  addDaysYmd,
  featureOn,
  isMinor,
  isOwnerRelation,
  maskMobile,
  ymdIn,
  societyToday,
  unitNotFound,
} from './residents.shared';

/** Flats with people, the unit panel, timeline, statistics and the owner portfolio (sections 8.3, 8.4, 8.18). */
const activeWhere = (date: string) => ({
  fromDate: { [Op.lte]: date },
  [Op.or]: [{ toDate: null }, { toDate: { [Op.gte]: date } }],
});
const seeContacts = (ctx: Ctx) => ctx.permissions?.has('residents.contacts.view') ?? false;

export interface ListFlatsQuery {
  q?: string;
  buildingId?: number;
  occupancy?: Occupancy;
  hasDues?: boolean;
  sortBy: 'unitLabel' | 'duesPaise';
  sortOrder?: 'asc' | 'desc';
  page: number;
  limit: number;
}

export async function listFlats(ctx: Ctx, societyId: number, q: ListFlatsQuery) {
  let all = await units.listActive(societyId, q.buildingId ? { buildingId: q.buildingId } : {});
  const wantsDues = q.hasDues !== undefined || q.sortBy === 'duesPaise';
  if (wantsDues && !q.buildingId && all.length > UNIT_FILTER_LIMIT)
    throw new UnprocessableError('FILTER_TOO_BROAD', 'Pick a building to filter or sort by dues');
  const today = await societyToday(societyId);
  if (q.q) {
    const term = q.q.trim().toLowerCase();
    const named = await sequelize.query<{ unitId: number }>(
      `SELECT DISTINCT x.unitId FROM unit_residents x JOIN residents r ON r.id = x.residentId
        WHERE x.societyId = :societyId AND x.toDate IS NULL AND r.deletedAt IS NULL AND r.name LIKE :like`,
      {
        replacements: { societyId, like: `%${term.replace(/[\\%_]/g, m => `\\${m}`)}%` },
        type: QueryTypes.SELECT,
      },
    );
    const ids = new Set(named.map(n => Number(n.unitId)));
    all = all.filter(u => u.label.toLowerCase().includes(term) || ids.has(u.id));
  }
  const occ = await occupancyOfIn(
    societyId,
    all.map(u => u.id),
    today,
  );
  if (q.occupancy) all = all.filter(u => occ.get(u.id) === q.occupancy);
  const dues = new Map<number, number>();
  const loadDues = async (list: UnitDto[]) => {
    for (const u of list) dues.set(u.id, await residentPorts().unitLedger.balance(societyId, u.id));
  };
  if (wantsDues) {
    await loadDues(all);
    if (q.hasDues !== undefined) all = all.filter(u => dues.get(u.id)! > 0 === q.hasDues);
  }
  const dir = q.sortOrder ?? (q.sortBy === 'duesPaise' ? 'desc' : 'asc');
  if (q.sortBy === 'duesPaise')
    all.sort((a, b) => (dues.get(a.id)! - dues.get(b.id)!) * (dir === 'asc' ? 1 : -1));
  else if (dir === 'desc') all.reverse();
  const total = all.length;
  const page = all.slice((q.page - 1) * q.limit, q.page * q.limit);
  if (!wantsDues) await loadDues(page);
  const links = await UnitResident.findAll({
    where: { societyId, unitId: { [Op.in]: page.map(u => u.id) }, ...activeWhere(today) },
    order: [['id', 'ASC']],
  });
  const people = new Map(
    (
      await Resident.findAll({
        where: { societyId, id: { [Op.in]: [...new Set(links.map(l => l.residentId))] } },
      })
    ).map(r => [r.id!, r]),
  );
  const tenancies = await Tenancy.findAll({
    where: {
      societyId,
      unitId: { [Op.in]: page.map(u => u.id) },
      status: { [Op.in]: ['ACTIVE', 'EXPIRED_OVERSTAY'] },
    },
  });
  const reveal = seeContacts(ctx);
  const mob = (m: string | null) => (reveal ? m : maskMobile(m));
  const data = page.map(u => {
    const ul = links.filter(l => l.unitId === u.id);
    const owner =
      ul.filter(l => l.relation === 'OWNER').sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0] ??
      ul.find(l => l.relation === 'CO_OWNER');
    const tn = tenancies.find(x => x.unitId === u.id);
    const tl = tn ? ul.find(l => l.relation === 'TENANT' && l.tenancyId === tn.id) : undefined;
    const op = owner ? people.get(owner.residentId) : undefined;
    const tp = tl ? people.get(tl.residentId) : undefined;
    return {
      unitId: u.id,
      unitLabel: u.label,
      buildingId: u.buildingId,
      unitType: u.unitType,
      areaSqft: u.areaSqft === null ? null : Number(u.areaSqft),
      occupancy: occ.get(u.id)!,
      primaryOwner: op ? { residentId: op.id!, name: op.name, mobile: mob(op.mobile) } : null,
      tenant:
        tp && tn
          ? {
              residentId: tp.id!,
              name: tp.name,
              mobile: mob(tp.mobile),
              tenancyId: tn.id!,
              agreementEnd: tn.agreementEnd,
            }
          : null,
      residentCount: new Set(ul.map(l => l.residentId)).size,
      duesPaise: dues.get(u.id) ?? 0,
    };
  });
  return { data, pagination: pageMeta(q.page, q.limit, total) };
}

// ------------------------------------------------------------------ unit panel (8.3)
export async function unitPanel(ctx: Ctx, societyId: number, unitId: number, o: { reveal?: boolean } = {}) {
  const unit = await units.get(societyId, unitId);
  if (!unit) throw unitNotFound();
  if (o.reveal && !ctx.permissions?.has('residents.contacts.view')) {
    throw new ForbiddenError('PERMISSION_DENIED', 'You do not have permission to see contact details');
  }
  const today = await societyToday(societyId);
  const reveal = Boolean(o.reveal);
  if (reveal)
    await sequelize.transaction(t =>
      audit(
        ctx,
        {
          action: AUDIT.contactsRevealed,
          entityType: ENTITY.unit,
          entityId: unitId,
          entityLabel: unit.label,
          societyId,
        },
        t,
      ),
    );
  const links = await UnitResident.findAll({
    where: { societyId, unitId, ...activeWhere(today) },
    order: [['id', 'ASC']],
  });
  const people = new Map(
    (
      await Resident.findAll({
        where: { societyId, id: { [Op.in]: [...new Set(links.map(l => l.residentId))] } },
      })
    ).map(r => [r.id!, r]),
  );
  const person = (residentId: number) => {
    const r = people.get(residentId)!;
    return {
      residentId,
      name: r.name,
      mobile: reveal ? r.mobile : maskMobile(r.mobile),
      hasLogin: r.userId !== null,
      isMinor: isMinor(r.dateOfBirth, today),
    };
  };
  const dtos = await linkDtos(societyId, links);
  const dto = (id: number) => dtos.find(d => d.linkId === id)!;
  const tenancy = await Tenancy.findOne({
    where: { societyId, unitId, status: { [Op.in]: ['APPROVED', 'ACTIVE', 'EXPIRED_OVERSTAY'] } },
    order: [['id', 'DESC']],
  });
  const tenantLink = tenancy
    ? links.find(l => l.relation === 'TENANT' && l.tenancyId === tenancy.id)
    : undefined;
  const pets = (await featureOn(societyId, FEATURE.pets))
    ? await Pet.findAll({ where: { societyId, unitId, status: 'ACTIVE' }, order: [['id', 'ASC']] })
    : [];
  const occupancy = (await occupancyOfIn(societyId, [unitId], today)).get(unitId)!;
  const bill = await billToFor(unitId, today);
  return {
    unit: {
      id: unit.id,
      label: unit.label,
      unitType: unit.unitType,
      areaSqft: unit.areaSqft === null ? null : Number(unit.areaSqft),
      buildingId: unit.buildingId,
      buildingCode: unit.buildingCode,
      status: unit.status,
    },
    occupancy,
    owners: links
      .filter(l => isOwnerRelation(l.relation))
      .map(l => ({
        linkId: l.id!,
        ...person(l.residentId),
        relation: l.relation,
        sharePercent: dto(l.id!).sharePercent,
        isPrimary: Boolean(l.isPrimary),
        isResiding: Boolean(l.isResiding),
        from: l.fromDate,
        version: l.version,
      })),
    tenancy: tenancy
      ? {
          id: tenancy.id!,
          status: tenancy.status,
          agreementStart: tenancy.agreementStart,
          agreementEnd: tenancy.agreementEnd,
          maintenancePayer: tenancy.maintenancePayer,
          policeVerificationStatus: tenancy.policeVerificationStatus,
          tenant: tenantLink ? person(tenantLink.residentId) : person(tenancy.tenantResidentId),
        }
      : null,
    household: links
      .filter(l => l.relation === 'FAMILY' || l.relation === 'CARETAKER')
      .map(l => ({
        linkId: l.id!,
        ...person(l.residentId),
        relation: l.relation,
        familyRelation: l.familyRelation,
        householdOf: l.tenancyId === null ? 'OWNER' : 'TENANT',
        canLogin: Boolean(l.canLogin),
        isResiding: Boolean(l.isResiding),
        from: l.fromDate,
        version: l.version,
      })),
    pets: pets.map(p => ({ id: p.id!, name: p.name, species: p.species })),
    openRequests: await openRequestsOfUnit(societyId, unitId),
    duesPaise: await residentPorts().unitLedger.balance(societyId, unitId),
    billTo: bill
      ? { residentId: bill.residentId, name: bill.name, relation: bill.relation, tenancyId: bill.tenancyId }
      : null,
  };
}

// ------------------------------------------------------------------ timeline (8.4)
export async function unitTimeline(societyId: number, unitId: number) {
  const unit = await units.get(societyId, unitId);
  if (!unit) throw unitNotFound();
  const tz =
    (
      await sequelize.query<{ timezone: string }>('SELECT timezone FROM societies WHERE id = :societyId', {
        replacements: { societyId },
        type: QueryTypes.SELECT,
      })
    )[0]?.timezone ?? 'Asia/Kolkata';
  const day = (d: Date | null): string => (d ? ymdIn(tz, d) : '');
  interface Ev {
    at: string;
    kind: string;
    label: string;
    refType: string;
    refId: number;
  }
  const ev: Ev[] = [];
  const links = await UnitResident.findAll({
    where: { societyId, unitId },
    order: [['id', 'DESC']],
    limit: 200,
  });
  const names = new Map(
    (
      await Resident.findAll({
        where: { societyId, id: { [Op.in]: [...new Set(links.map(l => l.residentId))] } },
        paranoid: false,
        attributes: ['id', 'name'],
      })
    ).map(r => [r.id!, r.name]),
  );
  for (const l of links) {
    const n = names.get(l.residentId) ?? 'A resident';
    ev.push({
      at: l.fromDate,
      kind: 'LINK_STARTED',
      label: `${n} became ${l.relation.replace('_', ' ').toLowerCase()} of ${unit.label}`,
      refType: 'unit_resident',
      refId: l.id!,
    });
    if (l.toDate && l.endReason !== 'CORRECTION')
      ev.push({
        at: l.toDate,
        kind: 'LINK_ENDED',
        label: `${n} ended as ${l.relation.replace('_', ' ').toLowerCase()} (${l.endReason})`,
        refType: 'unit_resident',
        refId: l.id!,
      });
  }
  const tenancies = await Tenancy.findAll({
    where: { societyId, unitId },
    order: [['id', 'DESC']],
    limit: 100,
  });
  const tn = new Map(
    (
      await Resident.findAll({
        where: { societyId, id: { [Op.in]: tenancies.map(t => t.tenantResidentId) } },
        paranoid: false,
        attributes: ['id', 'name'],
      })
    ).map(r => [r.id!, r.name]),
  );
  for (const t of tenancies) {
    const n = tn.get(t.tenantResidentId) ?? 'The tenant';
    ev.push({
      at: day(t.createdAt!),
      kind: 'TENANCY_CREATED',
      label: `Tenancy of ${n} created`,
      refType: 'tenancy',
      refId: t.id!,
    });
    if (['APPROVED', 'ACTIVE', 'EXPIRED_OVERSTAY', 'ENDED'].includes(t.status) && t.decidedAt)
      ev.push({
        at: day(t.decidedAt),
        kind: 'TENANCY_APPROVED',
        label: `Tenancy of ${n} approved`,
        refType: 'tenancy',
        refId: t.id!,
      });
    if (t.moveInDate)
      ev.push({
        at: t.moveInDate,
        kind: 'TENANCY_ACTIVATED',
        label: `${n} moved in`,
        refType: 'tenancy',
        refId: t.id!,
      });
    if (t.renewalCount > 0)
      ev.push({
        at: day(t.updatedAt!),
        kind: 'TENANCY_RENEWED',
        label: `Tenancy of ${n} renewed to ${t.agreementEnd}`,
        refType: 'tenancy',
        refId: t.id!,
      });
    if (t.endedOn)
      ev.push({
        at: t.endedOn,
        kind: 'TENANCY_ENDED',
        label: `Tenancy of ${n} ended`,
        refType: 'tenancy',
        refId: t.id!,
      });
  }
  for (const m of await MoveRequest.findAll({
    where: { societyId, unitId, status: 'COMPLETED' },
    order: [['id', 'DESC']],
    limit: 50,
  }))
    ev.push({
      at: day(m.completedAt),
      kind: 'MOVE_COMPLETED',
      label: `${m.type === 'MOVE_IN' ? 'Move-in' : 'Move-out'} completed`,
      refType: 'move_request',
      refId: m.id!,
    });
  for (const p of await RenovationPermit.findAll({
    where: {
      societyId,
      unitId,
      status: { [Op.in]: ['APPROVED', 'IN_PROGRESS', 'SUSPENDED', 'INSPECTION_PENDING', 'COMPLETED'] },
    },
    order: [['id', 'DESC']],
    limit: 50,
  })) {
    if (p.decidedAt)
      ev.push({
        at: day(p.decidedAt),
        kind: 'PERMIT_APPROVED',
        label: `Renovation permit approved (${p.workCategory})`,
        refType: 'renovation_permit',
        refId: p.id!,
      });
    if (p.completedAt)
      ev.push({
        at: day(p.completedAt),
        kind: 'PERMIT_COMPLETED',
        label: 'Renovation completed',
        refType: 'renovation_permit',
        refId: p.id!,
      });
  }
  for (const o of await OwnershipTransfer.findAll({
    where: { societyId, unitId, status: 'COMPLETED' },
    order: [['id', 'DESC']],
    limit: 50,
  })) {
    const ids = (o.buyersJson ?? []).map(b => b.residentId);
    const buyers = await Resident.findAll({
      where: { societyId, id: { [Op.in]: ids } },
      paranoid: false,
      attributes: ['name'],
    });
    ev.push({
      at: o.effectiveDate,
      kind: 'OWNERSHIP_TRANSFERRED',
      label: `${unit.label} transferred to ${buyers.map(b => b.name).join(', ') || 'new owners'} (${o.transferType})`,
      refType: 'ownership_transfer',
      refId: o.id!,
    });
  }
  return ev
    .filter(e => e.at)
    .sort((a, b) => (a.at === b.at ? b.refId - a.refId : a.at < b.at ? 1 : -1))
    .slice(0, 200);
}

// ------------------------------------------------------------------ statistics (8.4)
export async function residentStats(societyId: number) {
  const today = await societyToday(societyId);
  const all = (await units.listActive(societyId)).filter(u => u.unitType !== 'PARKING_ONLY');
  const occ = await occupancyOfIn(
    societyId,
    all.map(u => u.id),
    today,
  );
  let ownerOccupied = 0;
  let rented = 0;
  let vacant = 0;
  for (const u of all) {
    const o = occ.get(u.id);
    if (o === 'OWNER_OCCUPIED') ownerOccupied += 1;
    else if (o === 'RENTED') rented += 1;
    else vacant += 1;
  }
  const n = async (sql: string, rep: Record<string, unknown> = {}): Promise<number> =>
    Number(
      (
        await sequelize.query<{ n: number }>(sql, {
          replacements: { societyId, today, ...rep },
          type: QueryTypes.SELECT,
        })
      )[0]?.n ?? 0,
    );
  const expiring = (days: number) =>
    n(
      `SELECT COUNT(*) AS n FROM tenancies WHERE societyId = :societyId AND status = 'ACTIVE'
         AND agreementEnd BETWEEN :today AND :limit`,
      { limit: addDaysYmd(today, days) },
    );
  const live = `societyId = :societyId AND status IN ('ACTIVE','EXPIRED_OVERSTAY') AND policeVerificationStatus <> 'NOT_REQUIRED'`;
  const inList = (xs: readonly string[]) => xs.map(x => `'${x}'`).join(',');
  return {
    units: all.length,
    ownerOccupied,
    rented,
    vacant,
    tenanciesExpiringIn30: await expiring(30),
    tenanciesExpiringIn60: await expiring(60),
    tenanciesExpiringIn90: await expiring(90),
    overstaying: await n(
      `SELECT COUNT(*) AS n FROM tenancies WHERE societyId = :societyId AND status = 'EXPIRED_OVERSTAY'`,
    ),
    policeVerification: {
      active: await n(`SELECT COUNT(*) AS n FROM tenancies WHERE ${live}`),
      verified: await n(
        `SELECT COUNT(*) AS n FROM tenancies WHERE ${live} AND policeVerificationStatus = 'VERIFIED'`,
      ),
      pending: await n(
        `SELECT COUNT(*) AS n FROM tenancies WHERE ${live} AND policeVerificationStatus <> 'VERIFIED'`,
      ),
    },
    openRequests: {
      join: await n(
        `SELECT COUNT(*) AS n FROM join_requests WHERE societyId = :societyId AND status IN (${inList(OPEN_JOIN_STATUSES)})`,
      ),
      moveIn: await n(
        `SELECT COUNT(*) AS n FROM move_requests WHERE societyId = :societyId AND type = 'MOVE_IN' AND status IN (${inList(OPEN_MOVE_STATUSES)})`,
      ),
      moveOut: await n(
        `SELECT COUNT(*) AS n FROM move_requests WHERE societyId = :societyId AND type = 'MOVE_OUT' AND status IN (${inList(OPEN_MOVE_STATUSES)})`,
      ),
      renovation: await n(
        `SELECT COUNT(*) AS n FROM renovation_permits WHERE societyId = :societyId AND status IN (${inList(OPEN_PERMIT_STATUSES)})`,
      ),
      transfer: await n(
        `SELECT COUNT(*) AS n FROM ownership_transfers WHERE societyId = :societyId AND status IN (${inList(OPEN_TRANSFER_STATUSES)})`,
      ),
    },
    residentsWithLogin: await n(
      `SELECT COUNT(*) AS n FROM residents WHERE societyId = :societyId AND deletedAt IS NULL AND userId IS NOT NULL`,
    ),
    residents: await n(
      `SELECT COUNT(*) AS n FROM residents WHERE societyId = :societyId AND deletedAt IS NULL`,
    ),
    petsVaccinationExpired: await n(
      `SELECT COUNT(*) AS n FROM pets WHERE societyId = :societyId AND deletedAt IS NULL AND status = 'ACTIVE' AND vaccinationValidUntil < :today`,
    ),
  };
}

// ------------------------------------------------------------------ portfolio (8.18)
export async function portfolio(ctx: Ctx, societyId: number) {
  const mine = (ctx.unitLinks ?? []).filter(l => l.relation === 'OWNER').map(l => l.unitId);
  if (!mine.length) return { units: [] };
  const today = await societyToday(societyId);
  const list = await units.listActive(societyId, { unitIds: mine });
  const occ = await occupancyOfIn(societyId, mine, today);
  const out = [];
  for (const u of list) {
    const tn = await Tenancy.findOne({
      where: { societyId, unitId: u.id, status: { [Op.in]: ['APPROVED', 'ACTIVE', 'EXPIRED_OVERSTAY'] } },
      order: [['id', 'DESC']],
    });
    out.push({
      unitId: u.id,
      unitLabel: u.label,
      occupancy: occ.get(u.id)!,
      duesPaise: await residentPorts().unitLedger.balance(societyId, u.id),
      tenancy: tn
        ? {
            status: tn.status,
            agreementEnd: tn.agreementEnd,
            policeVerificationStatus: tn.policeVerificationStatus,
          }
        : null,
      openRequests: await openRequestsOfUnit(societyId, u.id),
    });
  }
  return { units: out };
}
