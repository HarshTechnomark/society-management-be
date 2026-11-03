import { Op, QueryTypes, type Transaction } from 'sequelize';
import {
  JoinRequest,
  MoveRequest,
  OwnershipTransfer,
  RenovationPermit,
  Tenancy,
  UnitResident,
  sequelize,
} from '../../models';
import {
  LIVE_TENANCY,
  OPEN_JOIN_STATUSES,
  OPEN_MOVE_STATUSES,
  OPEN_PERMIT_STATUSES,
  OPEN_TRANSFER_STATUSES,
} from './residents.constants';

/**
 * Readers of the request tables for part 1 (delete guard, unit guard, unit panel, stats). The services that write those
 * tables belong to parts 2 and 3; the table shapes are fixed by section 7.
 */
export interface OpenRequest {
  kind: 'MOVE_IN' | 'MOVE_OUT' | 'RENOVATION' | 'TRANSFER' | 'JOIN';
  id: number;
  status: string;
}

export async function openRequestsOfUnit(
  societyId: number,
  unitId: number,
  t?: Transaction,
): Promise<OpenRequest[]> {
  const [moves, permits, transfers, joins] = await Promise.all([
    MoveRequest.findAll({
      where: { societyId, unitId, status: { [Op.in]: [...OPEN_MOVE_STATUSES] } },
      attributes: ['id', 'type', 'status'],
      transaction: t,
    }),
    RenovationPermit.findAll({
      where: { societyId, unitId, status: { [Op.in]: [...OPEN_PERMIT_STATUSES] } },
      attributes: ['id', 'status'],
      transaction: t,
    }),
    OwnershipTransfer.findAll({
      where: { societyId, unitId, status: { [Op.in]: [...OPEN_TRANSFER_STATUSES] } },
      attributes: ['id', 'status'],
      transaction: t,
    }),
    JoinRequest.findAll({
      where: { societyId, unitId, status: { [Op.in]: [...OPEN_JOIN_STATUSES] } },
      attributes: ['id', 'status'],
      transaction: t,
    }),
  ]);
  return [
    ...moves.map(m => ({ kind: m.type, id: m.id!, status: m.status })),
    ...permits.map(p => ({ kind: 'RENOVATION' as const, id: p.id!, status: p.status })),
    ...transfers.map(p => ({ kind: 'TRANSFER' as const, id: p.id!, status: p.status })),
    ...joins.map(p => ({ kind: 'JOIN' as const, id: p.id!, status: p.status })),
  ];
}

/** Section 8.24 unit guard: an open link, a live tenancy or an open join, move, renovation or transfer on the unit. */
export async function hasOpenPeopleOrRequests(
  societyId: number,
  unitId: number,
  t?: Transaction,
): Promise<boolean> {
  if (await UnitResident.count({ where: { societyId, unitId, toDate: null }, transaction: t })) return true;
  if (
    await Tenancy.count({
      where: { societyId, unitId, status: { [Op.in]: [...LIVE_TENANCY] } },
      transaction: t,
    })
  )
    return true;
  return (await openRequestsOfUnit(societyId, unitId, t)).length > 0;
}

/** BR-09-6: what keeps a resident from being deleted. Returns a short reason or null. */
export async function residentBlocker(
  societyId: number,
  residentId: number,
  userId: number | null,
  t?: Transaction,
): Promise<string | null> {
  if (await UnitResident.count({ where: { societyId, residentId, toDate: null }, transaction: t }))
    return 'an open unit link';
  if (
    await Tenancy.count({
      where: {
        societyId,
        status: { [Op.in]: ['ACTIVE', 'APPROVED', 'EXPIRED_OVERSTAY'] },
        [Op.or]: [{ tenantResidentId: residentId }, { landlordResidentId: residentId }],
      },
      transaction: t,
    })
  )
    return 'a live tenancy';
  const joinWhere = userId ? { [Op.or]: [{ residentId }, { userId }] } : { residentId };
  if (
    await JoinRequest.count({
      where: { societyId, status: { [Op.in]: [...OPEN_JOIN_STATUSES] }, ...joinWhere },
      transaction: t,
    })
  )
    return 'an open join request';
  if (
    await MoveRequest.count({
      where: { societyId, requestedByResidentId: residentId, status: { [Op.in]: [...OPEN_MOVE_STATUSES] } },
      transaction: t,
    })
  )
    return 'an open move request';
  if (
    await RenovationPermit.count({
      where: { societyId, requestedByResidentId: residentId, status: { [Op.in]: [...OPEN_PERMIT_STATUSES] } },
      transaction: t,
    })
  )
    return 'an open renovation permit';
  const rows = await sequelize.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ownership_transfers
      WHERE societyId = :societyId AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED')
        AND (initiatedByResidentId = :residentId
             OR JSON_CONTAINS(JSON_EXTRACT(buyersJson, '$[*].residentId'), CAST(:residentId AS JSON)))`,
    { replacements: { societyId, residentId }, type: QueryTypes.SELECT, transaction: t },
  );
  if (Number(rows[0]?.n ?? 0) > 0) return 'an open ownership transfer';
  return null;
}

/** BR-09-6 "open request" list for the resident detail (8.6 `openRequests`). */
export async function openRequestsOfResident(societyId: number, residentId: number): Promise<OpenRequest[]> {
  const [moves, permits, joins] = await Promise.all([
    MoveRequest.findAll({
      where: { societyId, requestedByResidentId: residentId, status: { [Op.in]: [...OPEN_MOVE_STATUSES] } },
      attributes: ['id', 'type', 'status'],
    }),
    RenovationPermit.findAll({
      where: { societyId, requestedByResidentId: residentId, status: { [Op.in]: [...OPEN_PERMIT_STATUSES] } },
      attributes: ['id', 'status'],
    }),
    JoinRequest.findAll({
      where: { societyId, residentId, status: { [Op.in]: [...OPEN_JOIN_STATUSES] } },
      attributes: ['id', 'status'],
    }),
  ]);
  const transfers = await sequelize.query<{ id: number; status: string }>(
    `SELECT id, status FROM ownership_transfers
      WHERE societyId = :societyId AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED')
        AND (initiatedByResidentId = :residentId
             OR JSON_CONTAINS(JSON_EXTRACT(buyersJson, '$[*].residentId'), CAST(:residentId AS JSON)))`,
    { replacements: { societyId, residentId }, type: QueryTypes.SELECT },
  );
  return [
    ...moves.map(m => ({ kind: m.type, id: m.id!, status: m.status })),
    ...permits.map(p => ({ kind: 'RENOVATION' as const, id: p.id!, status: p.status })),
    ...joins.map(p => ({ kind: 'JOIN' as const, id: p.id!, status: p.status })),
    ...transfers.map(p => ({ kind: 'TRANSFER' as const, id: Number(p.id), status: p.status })),
  ];
}
