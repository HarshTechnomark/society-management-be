import { randomInt } from 'node:crypto';
import { Op, QueryTypes, type Transaction, type WhereOptions } from 'sequelize';
import {
  MoveRequest,
  Resident,
  ResidentDocument,
  Tenancy,
  Unit,
  UnitResident,
  sequelize,
} from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, ForbiddenError, NotFoundError, RateLimitedError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import { systemCtx, type Ctx } from '../../types/context';
import { assertMakerChecker } from '../access-control/access-control.public';
import { holidays, settings, units } from '../society-setup/society-setup.public';
import { isJobAllowed } from '../societies/societies.guard';
import { Society } from '../../models';
import { AUDIT2, ENTITY2, FEATURE2, GATE_PASS_ALPHABET, MOVE_DOC_TYPES } from './residents.part2.constants';
import { OPEN_MOVE_STATUSES } from './residents.constants';
import { attachDocuments, docDto, type DocInput } from './residents.documents.service';
import { endLinks, liveTenancyOf, lockLinks } from './residents.links.service';
import { adminRoom, emitAfterCommit, notifyAfterCommit } from './residents.notify';
import { residentPorts, touchReports } from './residents.ports';
import { part2Ports, type ApprovalRef } from './residents.part2.ports';
import {
  callerResident,
  primaryOwnerOf,
  primaryOwnerUserIds,
  rupees,
  unitHouseholdUserIds,
  userIdsOf,
} from './residents.part2.shared';
import { activateTenancyTx, endTenancyTx } from './residents.tenancies.service';
import {
  addDaysYmd,
  assertFeatureFor,
  featureOn,
  invalidState,
  isOwnerRelation,
  isUniqueViolation,
  rule,
  societyToday,
  staleVersion,
  unitNotFound,
  weekdayOf,
} from './residents.shared';
import './residents.part2.templates';

/** Move requests (sections 5.6, 6.5 and 8.15). Lock order of BR-09-19: unit, unit links, tenancy, request row. */
const notFound = () => new NotFoundError('MOVE_REQUEST_NOT_FOUND', 'Move request not found');
const typeFeature = (type: string) => (type === 'MOVE_IN' ? FEATURE2.moveIn : FEATURE2.moveOut);
const typeLabel = (type: string) => (type === 'MOVE_IN' ? 'move-in' : 'move-out');
const HHMM = (s: string) => s.slice(0, 5);

export interface MoveInput {
  unitId: number;
  type: 'MOVE_IN' | 'MOVE_OUT';
  householdOf: 'OWNER' | 'TENANT';
  moveDate: string;
  slotStart: string;
  slotEnd: string;
  liftLabel?: string;
  vehicleNumber?: string;
  moverCompany?: string;
  moverMobile?: string;
  helperCount?: number;
  itemsNote?: string;
  fileIds?: DocInput[];
}

// ------------------------------------------------------------------ output
const nextOf = (m: MoveRequest) => {
  switch (m.status) {
    case 'BLOCKED_DUES':
      return { action: 'PAY_DUES', payUrl: `/pay?unitId=${m.unitId}` };
    case 'PENDING_OWNER':
      return { action: 'WAIT_OWNER' };
    case 'PENDING_DEPOSIT':
      return { action: 'PAY_DEPOSIT' };
    case 'PENDING_APPROVAL':
      return { action: 'WAIT_APPROVAL' };
    case 'APPROVED':
      return { action: 'SHOW_GATE_PASS' };
    default:
      return null;
  }
};

async function moveDtos(rows: MoveRequest[]) {
  if (!rows.length) return [];
  const unitRows = await Unit.findAll({
    where: { id: { [Op.in]: [...new Set(rows.map(r => r.unitId))] } },
    attributes: ['id', 'label'],
  });
  const labels = new Map(unitRows.map(u => [u.id!, u.label]));
  const reqIds = rows.map(r => r.requestedByResidentId).filter((x): x is number => x !== null);
  const people = new Map(
    (
      await Resident.findAll({
        where: { id: { [Op.in]: reqIds } },
        paranoid: false,
        attributes: ['id', 'name'],
      })
    ).map(r => [r.id!, r.name]),
  );
  return rows.map(m => ({
    id: m.id!,
    type: m.type,
    householdOf: m.householdOf,
    status: m.status,
    unitId: m.unitId,
    unitLabel: labels.get(m.unitId) ?? '',
    buildingId: m.buildingId,
    tenancyId: m.tenancyId,
    moveDate: m.moveDate,
    slotStart: HHMM(m.slotStart),
    slotEnd: HHMM(m.slotEnd),
    liftLabel: m.liftLabel,
    vehicleNumber: m.vehicleNumber,
    moverCompany: m.moverCompany,
    moverMobile: m.moverMobile,
    helperCount: m.helperCount,
    itemsNote: m.itemsNote,
    requestedBy:
      m.requestedByResidentId !== null
        ? { residentId: m.requestedByResidentId, name: people.get(m.requestedByResidentId) ?? '' }
        : null,
    duesBalancePaise: Number(m.duesBalancePaise),
    duesOverridden: m.duesOverrideBy !== null,
    depositPaise: Number(m.depositPaise),
    depositPaidAt: m.depositPaidAt ? m.depositPaidAt.toISOString() : null,
    approvalRequestId: m.approvalRequestId,
    gatePassCode: m.gatePassCode,
    decisionReason: m.decisionReason,
    cancelReason: m.cancelReason,
    startedAt: m.startedAt ? m.startedAt.toISOString() : null,
    completedAt: m.completedAt ? m.completedAt.toISOString() : null,
    inspectionStatus: m.inspectionStatus,
    damageDeductionPaise: Number(m.damageDeductionPaise),
    inspectionNote: m.inspectionNote,
    depositRefundDueOn: m.depositRefundDueOn,
    depositRefundRequestedAt: m.depositRefundRequestedAt ? m.depositRefundRequestedAt.toISOString() : null,
    createdAt: m.createdAt!.toISOString(),
    version: m.version,
    next: nextOf(m),
  }));
}

async function one(id: number, t?: Transaction) {
  return (await moveDtos([(await MoveRequest.findByPk(id, { transaction: t }))!]))[0]!;
}

async function lockMove(societyId: number, id: number, t: Transaction): Promise<MoveRequest> {
  const m = await MoveRequest.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!m) throw notFound();
  return m;
}

async function bump(m: MoveRequest, ctx: Ctx, t: Transaction): Promise<void> {
  m.version += 1;
  m.updatedBy = ctx.user?.id ?? null;
  await m.save({ transaction: t });
}

const checkVersion = (m: { version: number }, v: number) => {
  if (m.version !== v) throw staleVersion('This move request');
};

/** Who created the request on the resident side (own flats only). */
async function mineMove(ctx: Ctx, societyId: number, id: number, t?: Transaction): Promise<MoveRequest> {
  const m = await MoveRequest.findOne({
    where: { id, societyId },
    transaction: t,
    ...(t ? { lock: t.LOCK.UPDATE } : {}),
  });
  if (!m || !(ctx.unitIds ?? []).includes(m.unitId)) throw notFound();
  return m;
}

function emitMove(
  t: Transaction,
  m: MoveRequest,
  label: string,
  event: 'gate.move.scheduled' | 'gate.move.updated' | null,
): void {
  emitAfterCommit(t, adminRoom(m.societyId), 'residents.requests.changed', {
    kind: 'MOVE',
    id: m.id!,
    status: m.status,
  });
  if (event)
    emitAfterCommit(t, `society:${m.societyId}:gate`, event, {
      moveRequestId: m.id!,
      unitLabel: label,
      type: m.type,
      moveDate: m.moveDate,
      slotStart: HHMM(m.slotStart),
      slotEnd: HHMM(m.slotEnd),
      status: m.status,
    });
  touchReports(t, m.societyId);
}

const unitLabelOf = async (unitId: number, t?: Transaction) =>
  (await Unit.findByPk(unitId, { attributes: ['label'], transaction: t }))?.label ?? '';

// ------------------------------------------------------------------ slot rules (BR-09-41, 44)
const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

async function assertSlot(
  societyId: number,
  p: { moveDate: string; slotStart: string; slotEnd: string },
  admin: boolean,
): Promise<void> {
  const bad = (m: string, f = 'slotStart') => rule(422, 'MOVE_SLOT_NOT_ALLOWED', m, f);
  const today = await societyToday(societyId);
  if (p.moveDate < (admin ? today : addDaysYmd(today, 1)) || p.moveDate > addDaysYmd(today, 90))
    throw bad('Choose a date from tomorrow to 90 days ahead', 'moveDate');
  const hours = (await settings.get(societyId, 'residents.moveHours')) as { start: string; end: string };
  const maxHours = (await settings.get(societyId, 'residents.moveMaxHours')) as number;
  const blackout = (await settings.get(societyId, 'residents.moveBlackoutWeekdays')) as number[];
  if (toMin(p.slotStart) >= toMin(p.slotEnd)) throw bad('The slot must end after it starts', 'slotEnd');
  if (toMin(p.slotStart) < toMin(hours.start) || toMin(p.slotEnd) > toMin(hours.end))
    throw bad(`Moves are allowed between ${hours.start} and ${hours.end}`);
  if (toMin(p.slotEnd) - toMin(p.slotStart) > maxHours * 60)
    throw bad(`A move can take at most ${maxHours} hours`, 'slotEnd');
  if (blackout.includes(weekdayOf(p.moveDate)))
    throw bad('Moves are not allowed on this weekday', 'moveDate');
  if (await holidays.isHoliday(societyId, p.moveDate))
    throw bad('Moves are not allowed on a holiday', 'moveDate');
}

/** BR-09-44 (Premium): APPROVED or IN_PROGRESS moves on one building, lift and date cannot overlap. */
async function assertNoConflict(
  societyId: number,
  p: { buildingId: number; liftLabel: string | null; moveDate: string; slotStart: string; slotEnd: string },
  exceptId: number | null,
  t: Transaction,
): Promise<void> {
  if (!p.liftLabel || !(await featureOn(societyId, FEATURE2.slotAndLift))) return;
  const rows = await sequelize.query<{ id: number; slotStart: string; slotEnd: string; liftLabel: string }>(
    `SELECT id, slotStart, slotEnd, liftLabel FROM move_requests
      WHERE societyId = :societyId AND buildingId = :buildingId AND moveDate = :moveDate
        AND status IN ('APPROVED','IN_PROGRESS') AND LOWER(liftLabel) = LOWER(:lift)
        AND id <> :except FOR UPDATE`,
    {
      replacements: {
        societyId,
        buildingId: p.buildingId,
        moveDate: p.moveDate,
        lift: p.liftLabel,
        except: exceptId ?? 0,
      },
      type: QueryTypes.SELECT,
      transaction: t,
    },
  );
  const busy = rows.filter(
    r => toMin(r.slotStart) < toMin(p.slotEnd) && toMin(p.slotStart) < toMin(r.slotEnd),
  );
  if (busy.length)
    throw new AppError(409, 'MOVE_SLOT_CONFLICT', 'The lift is already booked for this time', [
      {
        field: 'slotStart',
        message: 'The lift is already booked for this time',
        conflicts: busy.map(b => ({ slotStart: HHMM(b.slotStart), slotEnd: HHMM(b.slotEnd) })),
      },
    ]);
}

const normaliseVehicle = (v: string) => v.replace(/[\s-]/g, '').toUpperCase();

// ------------------------------------------------------------------ pipeline (BR-09-42)
/** Runs the steps in order from the current state; stops at the first one that has to wait. Caller holds the row lock. */
async function advanceMove(ctx: Ctx, m: MoveRequest, t: Transaction): Promise<void> {
  const societyId = m.societyId;
  const label = await unitLabelOf(m.unitId, t);
  const tenancy = m.tenancyId ? await Tenancy.findByPk(m.tenancyId, { transaction: t }) : null;
  // (1) owner NOC
  if (
    !m.ownerConfirmedAt &&
    m.householdOf === 'TENANT' &&
    m.requestedByResidentId !== null &&
    tenancy &&
    tenancy.tenantResidentId === m.requestedByResidentId
  ) {
    const noc = await ResidentDocument.count({
      where: { societyId, refType: 'move_request', refId: m.id!, docType: 'NOC' },
      transaction: t,
    });
    const owners = await primaryOwnerUserIds(societyId, m.unitId);
    if (!noc && owners.length) {
      m.status = 'PENDING_OWNER';
      await bump(m, ctx, t);
      const req = await Resident.findByPk(m.requestedByResidentId, { attributes: ['name'], transaction: t });
      notifyAfterCommit(t, 'residents.move_owner_confirm', societyId, async () => owners, {
        requesterName: req?.name ?? '',
        typeLabel: typeLabel(m.type),
        moveDate: m.moveDate,
        unitLabel: label,
        link: '/me/move-requests',
      });
      return;
    }
  }
  // (2) dues, move-out only
  if (m.type === 'MOVE_OUT') {
    const balance = await residentPorts().unitLedger.balance(societyId, m.unitId);
    m.duesCheckedAt = now();
    m.duesBalancePaise = Math.max(0, balance);
    if (balance > 0 && m.duesOverrideBy === null) {
      m.status = 'BLOCKED_DUES';
      await bump(m, ctx, t);
      await audit(
        ctx,
        {
          action: AUDIT2.moveDuesBlocked,
          entityType: ENTITY2.moveRequest,
          entityId: m.id!,
          societyId,
          after: { duesBalancePaise: balance },
        },
        t,
      );
      notifyAfterCommit(
        t,
        'residents.move_blocked_dues',
        societyId,
        async s => [
          ...(await userIdsOf(s, [m.requestedByResidentId])),
          ...(m.createdBy ? [m.createdBy] : []),
          ...(await primaryOwnerUserIds(s, m.unitId)),
        ],
        { unitLabel: label, typeLabel: typeLabel(m.type), duesRupees: rupees(balance), link: '/pay' },
      );
      return;
    }
  }
  // (3) deposit
  if (Number(m.depositPaise) > 0 && !m.depositPaidAt) {
    if (!m.depositId) {
      const d = await part2Ports().deposits.request(
        ctx,
        {
          societyId,
          refType: 'move_request',
          refId: m.id!,
          unitId: m.unitId,
          amountPaise: Number(m.depositPaise),
        },
        t,
      );
      m.depositId = d.depositId;
      if (d.paid) m.depositPaidAt = now();
    }
    if (!m.depositPaidAt) {
      m.status = 'PENDING_DEPOSIT';
      await bump(m, ctx, t);
      notifyAfterCommit(
        t,
        'residents.move_deposit_due',
        societyId,
        async s => [
          ...(await userIdsOf(s, [m.requestedByResidentId])),
          ...(m.createdBy ? [m.createdBy] : []),
        ],
        {
          unitLabel: label,
          typeLabel: typeLabel(m.type),
          depositRupees: rupees(m.depositPaise),
          link: '/me/move-requests',
        },
      );
      return;
    }
    await audit(
      ctx,
      {
        action: AUDIT2.moveDepositPaid,
        entityType: ENTITY2.moveRequest,
        entityId: m.id!,
        societyId,
        after: { depositPaise: Number(m.depositPaise) },
      },
      t,
    );
  }
  // (4) approval
  m.status = 'PENDING_APPROVAL';
  await bump(m, ctx, t);
  const r = await part2Ports().approvals.request(
    ctx,
    {
      type: m.type,
      societyId,
      entityType: 'move_request',
      entityId: m.id!,
      title: `${m.type === 'MOVE_IN' ? 'Move-in' : 'Move-out'} request for ${label} on ${m.moveDate}`,
      payload: { unitId: m.unitId, householdOf: m.householdOf, moveDate: m.moveDate },
      unitId: m.unitId,
    },
    t,
  );
  await MoveRequest.update({ approvalRequestId: r.id }, { where: { id: m.id! }, transaction: t });
}

// ------------------------------------------------------------------ create (BR-09-40 to 42)
export async function createMove(ctx: Ctx, societyId: number, input: MoveInput, o: { mine?: boolean } = {}) {
  await assertFeatureFor(societyId, typeFeature(input.type));
  if (input.liftLabel) await assertFeatureFor(societyId, FEATURE2.slotAndLift);
  if (o.mine && !(ctx.unitIds ?? []).includes(input.unitId)) throw unitNotFound();
  return sequelize.transaction(async t => {
    const unit = await units.lockActive(societyId, input.unitId, t);
    if (unit.unitType === 'PARKING_ONLY')
      throw rule(422, 'UNIT_NOT_RESIDENTIAL', 'This unit is a parking space', 'unitId');
    const links = await lockLinks(societyId, unit.id, t);
    let requester: Resident | null = null;
    if (o.mine) {
      requester = await callerResident(ctx, societyId, t);
      const mineLinks = links.filter(l => l.toDate === null && l.residentId === requester!.id);
      const isOwner = mineLinks.some(l => isOwnerRelation(l.relation));
      const isTenant = mineLinks.some(l => l.relation === 'TENANT');
      if (!isOwner && !(isTenant && input.householdOf === 'TENANT'))
        throw new ForbiddenError('HOUSEHOLD_CONTROL_REQUIRED', 'You do not manage this household');
    }
    let tenancy: Tenancy | null = null;
    if (input.householdOf === 'TENANT') {
      tenancy = await liveTenancyOf(societyId, unit.id, t);
      if (!tenancy) throw rule(422, 'NO_LIVE_TENANCY', 'The flat has no live tenancy', 'householdOf');
      if (
        o.mine &&
        requester &&
        !links.some(l => l.toDate === null && l.residentId === requester.id && isOwnerRelation(l.relation)) &&
        tenancy.tenantResidentId !== requester.id
      )
        throw new ForbiddenError('HOUSEHOLD_CONTROL_REQUIRED', 'You do not manage this household');
      const okState = input.type === 'MOVE_IN' ? ['APPROVED'] : ['ACTIVE', 'EXPIRED_OVERSTAY'];
      if (!okState.includes(tenancy.status))
        throw rule(
          422,
          'TENANCY_STATE_INVALID',
          'The tenancy is not in a state that allows this move',
          'householdOf',
        );
    }
    const open = await MoveRequest.count({
      where: { unitId: unit.id, type: input.type, status: { [Op.in]: [...OPEN_MOVE_STATUSES] } },
      transaction: t,
    });
    if (open)
      throw rule(409, 'MOVE_REQUEST_EXISTS', 'There is already an open request of this type for the flat');
    const admin = !o.mine;
    await assertSlot(societyId, input, admin);
    const lift = input.liftLabel ?? null;
    await assertNoConflict(societyId, { buildingId: unit.buildingId, liftLabel: lift, ...input }, null, t);
    const deposit = (await settings.get(societyId, 'residents.moveDepositPaise')) as number;
    let m: MoveRequest;
    try {
      m = await MoveRequest.create(
        {
          societyId,
          unitId: unit.id,
          buildingId: unit.buildingId,
          type: input.type,
          householdOf: input.householdOf,
          tenancyId: tenancy?.id ?? null,
          requestedByResidentId: requester?.id ?? null,
          moveDate: input.moveDate,
          slotStart: input.slotStart,
          slotEnd: input.slotEnd,
          liftLabel: lift,
          vehicleNumber: input.vehicleNumber ? normaliseVehicle(input.vehicleNumber) : null,
          moverCompany: input.moverCompany ?? null,
          moverMobile: input.moverMobile ?? null,
          helperCount: input.helperCount ?? null,
          itemsNote: input.itemsNote ?? null,
          status: 'PENDING_APPROVAL',
          ownerConfirmedBy: null,
          ownerConfirmedAt: null,
          duesCheckedAt: null,
          duesBalancePaise: 0,
          duesOverrideBy: null,
          duesOverrideReason: null,
          depositPaise: deposit,
          depositId: null,
          depositPaidAt: null,
          approvalRequestId: null,
          decidedAt: null,
          decisionReason: null,
          gatePassCode: null,
          startedAt: null,
          startedBy: null,
          completedAt: null,
          completedBy: null,
          completionNote: null,
          inspectionStatus: 'NOT_REQUIRED',
          damageDeductionPaise: 0,
          inspectionNote: null,
          depositRefundDueOn: null,
          depositRefundRequestedAt: null,
          cancelledAt: null,
          cancelReason: null,
          version: 1,
          createdBy: ctx.user?.id ?? null,
          updatedBy: ctx.user?.id ?? null,
        },
        { transaction: t },
      );
    } catch (err) {
      if (isUniqueViolation(err))
        throw rule(409, 'MOVE_REQUEST_EXISTS', 'There is already an open request of this type for the flat');
      throw err;
    }
    if (input.fileIds?.length) await attachMoveDocs(ctx, societyId, m, input.fileIds, t);
    await audit(
      ctx,
      {
        action: AUDIT2.moveCreated,
        entityType: ENTITY2.moveRequest,
        entityId: m.id!,
        entityLabel: unit.label,
        societyId,
        after: { type: m.type, householdOf: m.householdOf, moveDate: m.moveDate, depositPaise: deposit },
      },
      t,
    );
    await advanceMove(ctx, m, t);
    emitMove(t, m, unit.label, null);
    return one(m.id!, t);
  });
}

/** `resident_documents.residentId` is required outside join requests: the requester, else the tenant, else the owner. */
async function docOwner(societyId: number, m: MoveRequest, t: Transaction): Promise<number> {
  if (m.requestedByResidentId) return m.requestedByResidentId;
  if (m.tenancyId) {
    const tn = await Tenancy.findByPk(m.tenancyId, { transaction: t });
    if (tn) return tn.tenantResidentId;
  }
  const links = await UnitResident.findAll({
    where: { societyId, unitId: m.unitId, toDate: null },
    transaction: t,
  });
  return primaryOwnerOf(links)!.residentId;
}

async function attachMoveDocs(
  ctx: Ctx,
  societyId: number,
  m: MoveRequest,
  items: DocInput[],
  t: Transaction,
) {
  for (const [i, it] of items.entries()) {
    if (!(MOVE_DOC_TYPES as readonly string[]).includes(it.docType))
      throw rule(
        422,
        'DOCUMENT_TYPE_NOT_ALLOWED',
        'Only a NOC or another paper is allowed here',
        `fileIds.${i}.docType`,
      );
    await attachDocuments(ctx, societyId, t, {
      residentId: await docOwner(societyId, m, t),
      unitId: m.unitId,
      refType: 'move_request',
      refId: m.id!,
      items: [it],
    });
  }
}

// ------------------------------------------------------------------ approval handlers (BR-09-44, 45)
function newPass(): string {
  return Array.from({ length: 8 }, () => GATE_PASS_ALPHABET[randomInt(GATE_PASS_ALPHABET.length)]).join('');
}

async function approveMove(ctx: Ctx, societyId: number, id: number, t: Transaction): Promise<void> {
  const m = await lockMove(societyId, id, t).catch(() => null);
  if (!m || m.status !== 'PENDING_APPROVAL') return;
  await assertNoConflict(societyId, m, m.id!, t);
  let code = newPass();
  for (let i = 0; i < 20; i++) {
    const taken = await MoveRequest.count({
      where: { societyId, gatePassCode: code, status: { [Op.in]: ['APPROVED', 'IN_PROGRESS'] } },
      transaction: t,
    });
    if (!taken) break;
    code = newPass();
  }
  m.gatePassCode = code;
  m.status = 'APPROVED';
  m.decidedAt = now();
  await bump(m, ctx, t);
  await audit(
    ctx,
    {
      action: AUDIT2.moveApproved,
      entityType: ENTITY2.moveRequest,
      entityId: m.id!,
      societyId,
      after: { status: 'APPROVED', gatePassIssued: true },
    },
    t,
  );
  const label = await unitLabelOf(m.unitId, t);
  notifyAfterCommit(
    t,
    'residents.move_approved',
    societyId,
    async s => [
      ...(await userIdsOf(s, [m.requestedByResidentId])),
      ...(m.createdBy ? [m.createdBy] : []),
      ...(await unitHouseholdUserIds(s, m.unitId)),
    ],
    {
      typeLabel: typeLabel(m.type),
      unitLabel: label,
      moveDate: m.moveDate,
      slotStart: HHMM(m.slotStart),
      slotEnd: HHMM(m.slotEnd),
      gatePass: code,
      link: '/me/move-requests',
    },
  );
  emitMove(t, m, label, 'gate.move.scheduled');
}

/** BR-09-49: a paid deposit goes back in full. */
async function refundFull(ctx: Ctx, m: MoveRequest, reason: string, t: Transaction): Promise<void> {
  if (!m.depositId || !m.depositPaidAt || m.depositRefundRequestedAt) return;
  await part2Ports().deposits.requestRefund(ctx, m.depositId, { deductionPaise: 0, reason }, t);
  m.depositRefundRequestedAt = now();
}

async function cancelCore(
  ctx: Ctx,
  m: MoveRequest,
  reason: string,
  t: Transaction,
  o: { cancelApproval: boolean },
): Promise<void> {
  const was = m.status;
  if (o.cancelApproval && m.approvalRequestId && was === 'PENDING_APPROVAL')
    await part2Ports().approvals.cancel(ctx, m.approvalRequestId, reason, t);
  await refundFull(ctx, m, reason, t);
  m.status = 'CANCELLED';
  m.cancelledAt = now();
  m.cancelReason = reason;
  await bump(m, ctx, t);
  await audit(
    ctx,
    {
      action: AUDIT2.moveCancelled,
      entityType: ENTITY2.moveRequest,
      entityId: m.id!,
      societyId: m.societyId,
      after: { status: 'CANCELLED' },
      reason,
    },
    t,
  );
  emitMove(t, m, await unitLabelOf(m.unitId, t), was === 'APPROVED' ? 'gate.move.updated' : null);
}

export const moveHandlers = {
  onApproved: async (ctx: Ctx, req: ApprovalRef, t: Transaction) =>
    approveMove(ctx, req.societyId, req.entityId, t),
  onRejected: async (ctx: Ctx, req: ApprovalRef, t: Transaction) => {
    const m = await lockMove(req.societyId, req.entityId, t).catch(() => null);
    if (!m || m.status !== 'PENDING_APPROVAL') return;
    await refundFull(ctx, m, 'The move request was rejected', t);
    m.status = 'REJECTED';
    m.decidedAt = now();
    m.decisionReason = req.reason ?? null;
    await bump(m, ctx, t);
    await audit(
      ctx,
      {
        action: AUDIT2.moveRejected,
        entityType: ENTITY2.moveRequest,
        entityId: m.id!,
        societyId: m.societyId,
        after: { status: 'REJECTED' },
        reason: req.reason ?? null,
      },
      t,
    );
    await notifyRequester(t, m, 'residents.move_rejected', { reason: req.reason ?? null });
    emitMove(t, m, await unitLabelOf(m.unitId, t), null);
  },
  onChangesRequested: async (ctx: Ctx, req: ApprovalRef, t: Transaction) => {
    const m = await MoveRequest.findOne({
      where: { id: req.entityId, societyId: req.societyId },
      transaction: t,
    });
    if (!m) return;
    await audit(
      ctx,
      {
        action: AUDIT2.moveChangesRequested,
        entityType: ENTITY2.moveRequest,
        entityId: m.id!,
        societyId: m.societyId,
      },
      t,
    );
    await notifyRequester(t, m, 'residents.request_changes_requested', { link: '/me/move-requests' });
  },
  onCancelled: async (ctx: Ctx, req: ApprovalRef, t: Transaction) => {
    const m = await lockMove(req.societyId, req.entityId, t).catch(() => null);
    if (!m || !['PENDING_APPROVAL', 'APPROVED'].includes(m.status)) return;
    await cancelCore(ctx, m, 'Cancelled from the approval inbox', t, { cancelApproval: false });
  },
  describe: async (societyId: number, entityId: number) => {
    const m = await MoveRequest.findOne({ where: { id: entityId, societyId } });
    const label = m ? await unitLabelOf(m.unitId) : '';
    return {
      title: m ? `${typeLabel(m.type)} request for ${label}` : 'Move request',
      lines: m
        ? [
            { label: 'Flat', value: label },
            { label: 'Date', value: `${m.moveDate} ${HHMM(m.slotStart)}-${HHMM(m.slotEnd)}` },
            {
              label: 'Dues',
              value: `Rs ${rupees(m.duesBalancePaise)}${m.duesOverrideBy ? ' (overridden)' : ''}`,
            },
          ]
        : [],
    };
  },
};

async function notifyRequester(
  t: Transaction,
  m: MoveRequest,
  template: string,
  extra: Record<string, unknown>,
) {
  const label = await unitLabelOf(m.unitId, t);
  const rid = m.requestedByResidentId;
  const creator = m.createdBy;
  notifyAfterCommit(
    t,
    template,
    m.societyId,
    async s => [...(await userIdsOf(s, [rid])), ...(creator ? [creator] : [])],
    { unitLabel: label, typeLabel: typeLabel(m.type), ...extra },
  );
}

// ------------------------------------------------------------------ module 13 callbacks
export async function onMoveDepositPaid(
  ctx: Ctx,
  input: { refId: number; depositId: number },
  t: Transaction,
): Promise<void> {
  const m = await MoveRequest.findOne({ where: { id: input.refId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!m || m.status !== 'PENDING_DEPOSIT' || m.depositId !== input.depositId) return;
  m.depositPaidAt = now();
  await advanceMove(ctx, m, t);
  emitMove(t, m, await unitLabelOf(m.unitId, t), null);
}

// ------------------------------------------------------------------ list and detail
export interface MoveListQuery {
  page: number;
  limit: number;
  type?: 'MOVE_IN' | 'MOVE_OUT';
  status?: string[];
  unitId?: number;
  buildingId?: number;
  dateFrom?: string;
  dateTo?: string;
  sortBy: 'moveDate' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
}

async function assertAnyMoveFeature(societyId: number, type?: string) {
  if (type) return assertFeatureFor(societyId, typeFeature(type) as never, 'read');
  try {
    await assertFeatureFor(societyId, FEATURE2.moveIn, 'read');
  } catch (err) {
    if (!(await featureOn(societyId, FEATURE2.moveOut))) throw err;
  }
}

export async function listMoves(societyId: number, q: MoveListQuery) {
  await assertAnyMoveFeature(societyId, q.type);
  const where: WhereOptions = { societyId };
  const w = where as Record<string, unknown>;
  if (q.type) w.type = q.type;
  if (q.status?.length) w.status = { [Op.in]: q.status };
  if (q.unitId) w.unitId = q.unitId;
  if (q.buildingId) w.buildingId = q.buildingId;
  if (q.dateFrom || q.dateTo)
    w.moveDate = {
      ...(q.dateFrom ? { [Op.gte]: q.dateFrom } : {}),
      ...(q.dateTo ? { [Op.lte]: q.dateTo } : {}),
    };
  const { rows, count } = await MoveRequest.findAndCountAll({
    where,
    order: [
      [q.sortBy, (q.sortOrder ?? (q.sortBy === 'moveDate' ? 'asc' : 'desc')).toUpperCase()],
      ['id', 'ASC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: await moveDtos(rows), pagination: pageMeta(q.page, q.limit, count) };
}

export async function listMyMoves(ctx: Ctx, societyId: number) {
  const unitIds = ctx.unitIds ?? [];
  if (!unitIds.length) return [];
  const rows = await MoveRequest.findAll({
    where: { societyId, unitId: { [Op.in]: unitIds } },
    order: [['id', 'DESC']],
  });
  return moveDtos(rows);
}

async function withDocs(m: MoveRequest) {
  const dto = (await moveDtos([m]))[0]!;
  const docs = await ResidentDocument.findAll({
    where: { societyId: m.societyId, refType: 'move_request', refId: m.id! },
    order: [['id', 'ASC']],
  });
  return { ...dto, documents: docs.map(docDto) };
}

export async function getMove(societyId: number, id: number) {
  const m = await MoveRequest.findOne({ where: { id, societyId } });
  if (!m) throw notFound();
  await assertFeatureFor(societyId, typeFeature(m.type) as never, 'read');
  return withDocs(m);
}

export async function getMyMove(ctx: Ctx, societyId: number, id: number) {
  const m = await mineMove(ctx, societyId, id);
  await assertFeatureFor(societyId, typeFeature(m.type) as never, 'read');
  return withDocs(m);
}

// ------------------------------------------------------------------ dues (BR-09-43)
export async function recheckDues(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number },
  o: { mine?: boolean } = {},
) {
  return sequelize.transaction(async t => {
    const m = o.mine ? await mineMove(ctx, societyId, id, t) : await lockMove(societyId, id, t);
    await assertFeatureFor(societyId, typeFeature(m.type) as never);
    checkVersion(m, input.version);
    if (m.status !== 'BLOCKED_DUES') throw invalidState('This request is not waiting for dues');
    if (o.mine) {
      const me = await callerResident(ctx, societyId, t);
      if (m.requestedByResidentId !== me.id) throw notFound();
    }
    if (m.duesCheckedAt && now().getTime() - m.duesCheckedAt.getTime() < 60_000)
      throw new RateLimitedError(60 - (now().getTime() - m.duesCheckedAt.getTime()) / 1000);
    await audit(
      ctx,
      { action: AUDIT2.moveDuesRechecked, entityType: ENTITY2.moveRequest, entityId: m.id!, societyId },
      t,
    );
    await advanceMove(ctx, m, t);
    emitMove(t, m, await unitLabelOf(m.unitId, t), null);
    return one(m.id!, t);
  });
}

export async function overrideDues(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number; reason: string },
) {
  return sequelize.transaction(async t => {
    const m = await lockMove(societyId, id, t);
    await assertFeatureFor(societyId, FEATURE2.moveOut);
    checkVersion(m, input.version);
    if (m.status !== 'BLOCKED_DUES') throw invalidState('This request is not blocked by dues');
    if (m.createdBy) assertMakerChecker(ctx, m.createdBy);
    const [uid] = await userIdsOf(societyId, [m.requestedByResidentId]);
    if (uid) assertMakerChecker(ctx, uid);
    m.duesOverrideBy = ctx.user!.id;
    m.duesOverrideReason = input.reason;
    await audit(
      ctx,
      {
        action: AUDIT2.moveDuesOverridden,
        entityType: ENTITY2.moveRequest,
        entityId: m.id!,
        societyId,
        after: { duesBalancePaise: Number(m.duesBalancePaise) },
        reason: input.reason,
      },
      t,
    );
    await advanceMove(ctx, m, t);
    emitMove(t, m, await unitLabelOf(m.unitId, t), null);
    return one(m.id!, t);
  });
}

// ------------------------------------------------------------------ owner NOC
async function ownerOnly(ctx: Ctx, societyId: number, m: MoveRequest, t: Transaction): Promise<void> {
  const me = await callerResident(ctx, societyId, t);
  const links = await UnitResident.findAll({
    where: { societyId, unitId: m.unitId, toDate: null },
    transaction: t,
  });
  const p = primaryOwnerOf(links);
  if (!p || p.residentId !== me.id)
    throw new ForbiddenError('OWNER_ACTION_ONLY', 'Only the primary owner of the flat can do this');
}

export async function ownerConfirm(ctx: Ctx, societyId: number, id: number, input: { version: number }) {
  return sequelize.transaction(async t => {
    const m = await mineMove(ctx, societyId, id, t);
    await assertFeatureFor(societyId, typeFeature(m.type) as never);
    await ownerOnly(ctx, societyId, m, t);
    checkVersion(m, input.version);
    if (m.status !== 'PENDING_OWNER') throw invalidState('This request is not waiting for the owner');
    m.ownerConfirmedBy = ctx.user!.id;
    m.ownerConfirmedAt = now();
    await audit(
      ctx,
      { action: AUDIT2.moveOwnerConfirmed, entityType: ENTITY2.moveRequest, entityId: m.id!, societyId },
      t,
    );
    await advanceMove(ctx, m, t);
    emitMove(t, m, await unitLabelOf(m.unitId, t), null);
    return one(m.id!, t);
  });
}

export async function ownerDecline(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number; reason: string },
) {
  return sequelize.transaction(async t => {
    const m = await mineMove(ctx, societyId, id, t);
    await assertFeatureFor(societyId, typeFeature(m.type) as never);
    await ownerOnly(ctx, societyId, m, t);
    checkVersion(m, input.version);
    if (m.status !== 'PENDING_OWNER') throw invalidState('This request is not waiting for the owner');
    m.status = 'REJECTED';
    m.decidedAt = now();
    m.decisionReason = input.reason;
    await bump(m, ctx, t);
    await audit(
      ctx,
      {
        action: AUDIT2.moveOwnerDeclined,
        entityType: ENTITY2.moveRequest,
        entityId: m.id!,
        societyId,
        after: { status: 'REJECTED' },
        reason: input.reason,
      },
      t,
    );
    await notifyRequester(t, m, 'residents.move_rejected', { reason: input.reason });
    emitMove(t, m, await unitLabelOf(m.unitId, t), null);
    return one(m.id!, t);
  });
}

// ------------------------------------------------------------------ start and complete (BR-09-46, 47)
export async function startMove(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number; gatePassCode?: string },
  o: { gate?: boolean } = {},
) {
  return sequelize.transaction(async t => {
    const m = await lockMove(societyId, id, t);
    await assertFeatureFor(societyId, typeFeature(m.type) as never);
    checkVersion(m, input.version);
    if (m.status !== 'APPROVED') throw invalidState('Only an approved move can be started');
    const bad = (msg: string) => rule(422, 'GATE_PASS_INVALID', msg, 'gatePassCode');
    if (o.gate && (input.gatePassCode ?? '').toUpperCase() !== m.gatePassCode)
      throw bad('The gate pass does not match');
    if (m.moveDate !== (await societyToday(societyId))) throw bad('A move can start only on its date');
    m.status = 'IN_PROGRESS';
    m.startedAt = now();
    m.startedBy = ctx.user?.id ?? null;
    await bump(m, ctx, t);
    await audit(
      ctx,
      {
        action: AUDIT2.moveStarted,
        entityType: ENTITY2.moveRequest,
        entityId: m.id!,
        societyId,
        after: { status: m.status },
      },
      t,
    );
    emitMove(t, m, await unitLabelOf(m.unitId, t), 'gate.move.updated');
    return one(m.id!, t);
  });
}

export async function completeMove(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number; note?: string },
) {
  return sequelize.transaction(async t => {
    const m = await lockMove(societyId, id, t);
    await assertFeatureFor(societyId, typeFeature(m.type) as never);
    checkVersion(m, input.version);
    if (m.status !== 'IN_PROGRESS') throw invalidState('Only a move in progress can be completed');
    const today = await societyToday(societyId);
    const unit = await units.lockActive(societyId, m.unitId, t);
    const links = await lockLinks(societyId, unit.id, t);
    const open = links.filter(l => l.toDate === null);
    const touch = async (rows: UnitResident[], residing: boolean) => {
      for (const l of rows)
        if (Boolean(l.isResiding) !== residing) {
          l.isResiding = residing;
          l.version += 1;
          await l.save({ transaction: t });
        }
    };
    const ownerHousehold = open.filter(l => l.tenancyId === null);
    if (m.householdOf === 'TENANT') {
      const tn = m.tenancyId
        ? await Tenancy.findOne({
            where: { id: m.tenancyId, societyId },
            transaction: t,
            lock: t.LOCK.UPDATE,
          })
        : null;
      if (tn && m.type === 'MOVE_IN' && tn.status === 'APPROVED')
        await activateTenancyTx(ctx, societyId, tn, today, t);
      else if (tn && m.type === 'MOVE_OUT' && ['ACTIVE', 'EXPIRED_OVERSTAY'].includes(tn.status))
        await endTenancyTx(
          ctx,
          societyId,
          tn,
          {
            endedOn: today < tn.agreementStart ? tn.agreementStart : today,
            endReason: 'MOVED_OUT',
            ignoreMoveId: m.id!,
          },
          t,
        );
    } else if (m.type === 'MOVE_IN') {
      await touch(ownerHousehold, true);
    } else {
      await touch(
        ownerHousehold.filter(l => isOwnerRelation(l.relation)),
        false,
      );
      const family = ownerHousehold.filter(l => l.relation === 'FAMILY' || l.relation === 'CARETAKER');
      if (family.length)
        await endLinks(ctx, societyId, unit.id, family, { toDate: today, reason: 'MOVED_OUT' }, t);
    }
    if (m.depositId && m.depositPaidAt) {
      m.inspectionStatus = 'PENDING';
      const days = (await settings.get(societyId, 'residents.depositInspectionDays')) as number;
      m.depositRefundDueOn = addDaysYmd(today, days);
    }
    m.status = 'COMPLETED';
    m.completedAt = now();
    m.completedBy = ctx.user?.id ?? null;
    m.completionNote = input.note ?? null;
    await bump(m, ctx, t);
    await audit(
      ctx,
      {
        action: AUDIT2.moveCompleted,
        entityType: ENTITY2.moveRequest,
        entityId: m.id!,
        societyId,
        after: { status: m.status },
      },
      t,
    );
    notifyAfterCommit(
      t,
      'residents.move_completed',
      societyId,
      async s => [
        ...(await userIdsOf(s, [m.requestedByResidentId])),
        ...(m.createdBy ? [m.createdBy] : []),
        ...(await primaryOwnerUserIds(s, m.unitId)),
      ],
      { unitLabel: unit.label, typeLabel: typeLabel(m.type), completedOn: today },
    );
    emitMove(t, m, unit.label, 'gate.move.updated');
    return one(m.id!, t);
  });
}

// ------------------------------------------------------------------ inspection and refund (BR-09-48)
export async function inspectMove(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number; result: 'PASSED' | 'DAMAGE_FOUND'; damageDeductionPaise: number; note: string },
) {
  return sequelize.transaction(async t => {
    const m = await lockMove(societyId, id, t);
    await assertFeatureFor(societyId, typeFeature(m.type) as never);
    checkVersion(m, input.version);
    if (m.status !== 'COMPLETED' || m.inspectionStatus !== 'PENDING')
      throw invalidState('This move has no deposit waiting for inspection');
    if (input.damageDeductionPaise > Number(m.depositPaise))
      throw rule(422, 'DEDUCTION_TOO_HIGH', 'The deduction is more than the deposit', 'damageDeductionPaise');
    m.inspectionStatus = input.result;
    m.damageDeductionPaise = input.damageDeductionPaise;
    m.inspectionNote = input.note;
    await part2Ports().deposits.requestRefund(
      ctx,
      m.depositId!,
      { deductionPaise: input.damageDeductionPaise, reason: input.note },
      t,
    );
    m.depositRefundRequestedAt = now();
    await bump(m, ctx, t);
    await audit(
      ctx,
      {
        action: AUDIT2.moveInspected,
        entityType: ENTITY2.moveRequest,
        entityId: m.id!,
        societyId,
        after: { result: input.result, deductionPaise: input.damageDeductionPaise },
      },
      t,
    );
    await audit(
      ctx,
      {
        action: AUDIT2.moveRefundRequested,
        entityType: ENTITY2.moveRequest,
        entityId: m.id!,
        societyId,
        after: { refundPaise: Number(m.depositPaise) - input.damageDeductionPaise },
      },
      t,
    );
    touchReports(t, societyId);
    return one(m.id!, t);
  });
}

/** `residents:deposit-refunds`: full refund for moves nobody inspected by the due date. One refund per move. */
export async function runDepositRefunds(societyId: number): Promise<number> {
  const today = await societyToday(societyId);
  const ctx = systemCtx('deposit-refunds');
  const rows = await MoveRequest.findAll({
    where: {
      societyId,
      status: 'COMPLETED',
      inspectionStatus: 'PENDING',
      depositRefundRequestedAt: null,
      depositRefundDueOn: { [Op.lte]: today },
    },
    attributes: ['id'],
  });
  let n = 0;
  for (const { id } of rows)
    await sequelize.transaction(async t => {
      const m = await lockMove(societyId, id!, t);
      if (m.inspectionStatus !== 'PENDING' || m.depositRefundRequestedAt || !m.depositId) return;
      await part2Ports().deposits.requestRefund(
        ctx,
        m.depositId,
        { deductionPaise: 0, reason: 'No damage reported' },
        t,
      );
      m.inspectionStatus = 'PASSED';
      m.inspectionNote = 'No damage reported';
      m.depositRefundRequestedAt = now();
      await bump(m, ctx, t);
      await audit(
        ctx,
        {
          action: AUDIT2.moveRefundRequested,
          entityType: ENTITY2.moveRequest,
          entityId: m.id!,
          societyId,
          after: { refundPaise: Number(m.depositPaise), automatic: true },
        },
        t,
      );
      n += 1;
    });
  return n;
}

// ------------------------------------------------------------------ cancel (BR-09-49)
export async function cancelMove(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number; reason: string },
  o: { mine?: boolean } = {},
) {
  return sequelize.transaction(async t => {
    const m = o.mine ? await mineMove(ctx, societyId, id, t) : await lockMove(societyId, id, t);
    await assertFeatureFor(societyId, typeFeature(m.type) as never);
    if (o.mine) {
      const me = await callerResident(ctx, societyId, t);
      if (m.requestedByResidentId !== me.id) throw notFound();
    }
    checkVersion(m, input.version);
    if (
      !['PENDING_OWNER', 'BLOCKED_DUES', 'PENDING_DEPOSIT', 'PENDING_APPROVAL', 'APPROVED'].includes(m.status)
    )
      throw invalidState('This move can no longer be cancelled');
    await cancelCore(ctx, m, input.reason, t, { cancelApproval: true });
    return one(m.id!, t);
  });
}

// ------------------------------------------------------------------ edit after changes requested (8.23)
export async function patchMove(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: Partial<Omit<MoveInput, 'unitId' | 'type' | 'householdOf'>> & { version: number },
  o: { mine?: boolean } = {},
) {
  return sequelize.transaction(async t => {
    const m = o.mine ? await mineMove(ctx, societyId, id, t) : await lockMove(societyId, id, t);
    await assertFeatureFor(societyId, typeFeature(m.type) as never);
    if (o.mine) {
      const me = await callerResident(ctx, societyId, t);
      if (m.requestedByResidentId !== me.id) throw notFound();
    }
    checkVersion(m, input.version);
    const st =
      m.status === 'PENDING_APPROVAL'
        ? await part2Ports().approvals.publicStatus(societyId, m.type, m.id!)
        : null;
    if (st?.status !== 'CHANGES_REQUESTED')
      throw invalidState('Changes can be made only when the committee asked for them');
    const next = {
      moveDate: input.moveDate ?? m.moveDate,
      slotStart: input.slotStart ?? HHMM(m.slotStart),
      slotEnd: input.slotEnd ?? HHMM(m.slotEnd),
    };
    await assertSlot(societyId, next, !o.mine);
    const lift = input.liftLabel ?? m.liftLabel;
    if (input.liftLabel) await assertFeatureFor(societyId, FEATURE2.slotAndLift);
    await assertNoConflict(societyId, { buildingId: m.buildingId, liftLabel: lift, ...next }, m.id!, t);
    Object.assign(m, next, { liftLabel: lift });
    if (input.vehicleNumber !== undefined) m.vehicleNumber = normaliseVehicle(input.vehicleNumber);
    if (input.moverCompany !== undefined) m.moverCompany = input.moverCompany;
    if (input.moverMobile !== undefined) m.moverMobile = input.moverMobile;
    if (input.helperCount !== undefined) m.helperCount = input.helperCount;
    if (input.itemsNote !== undefined) m.itemsNote = input.itemsNote;
    if (input.fileIds?.length) await attachMoveDocs(ctx, societyId, m, input.fileIds, t);
    await bump(m, ctx, t);
    const label = await unitLabelOf(m.unitId, t);
    await part2Ports().approvals.resubmit(
      ctx,
      m.approvalRequestId!,
      {
        title: `${typeLabel(m.type)} request for ${label} on ${m.moveDate}`,
        summary: 'Resubmitted after changes',
      },
      t,
    );
    await audit(
      ctx,
      { action: AUDIT2.moveResubmitted, entityType: ENTITY2.moveRequest, entityId: m.id!, societyId },
      t,
    );
    emitMove(t, m, label, null);
    return one(m.id!, t);
  });
}

// ------------------------------------------------------------------ gate (8.15, 8.22)
export async function listForGate(societyId: number, date: string) {
  const rows = await MoveRequest.findAll({
    where: { societyId, moveDate: date, status: { [Op.in]: ['APPROVED', 'IN_PROGRESS'] } },
    order: [
      ['slotStart', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  const labels = new Map(
    (
      await Unit.findAll({
        where: { id: { [Op.in]: [...new Set(rows.map(r => r.unitId))] } },
        attributes: ['id', 'label'],
      })
    ).map(u => [u.id!, u.label]),
  );
  return rows.map(m => ({
    id: m.id!,
    unitLabel: labels.get(m.unitId) ?? '',
    type: m.type,
    slotStart: HHMM(m.slotStart),
    slotEnd: HHMM(m.slotEnd),
    liftLabel: m.liftLabel,
    vehicleNumber: m.vehicleNumber,
    moverCompany: m.moverCompany,
    helperCount: m.helperCount,
    itemsNote: m.itemsNote,
    status: m.status as 'APPROVED' | 'IN_PROGRESS',
  }));
}

export async function gateList(societyId: number, date: string | undefined) {
  const today = await societyToday(societyId);
  const d = date ?? today;
  if (d < addDaysYmd(today, -1) || d > addDaysYmd(today, 7))
    throw rule(422, 'VALIDATION_FAILED', 'The date must be from yesterday to 7 days ahead', 'date');
  return listForGate(societyId, d);
}

// ------------------------------------------------------------------ jobs
/** Sync step of `residents:sync-links`: APPROVED moves whose date passed unstarted are cancelled (BR-09-49). */
export async function cancelStaleMoves(societyId: number, ctx: Ctx): Promise<number> {
  const s = await Society.findByPk(societyId, { attributes: ['status'] });
  if (!s || !isJobAllowed(s.status, 'normal')) return 0;
  const today = await societyToday(societyId);
  const rows = await MoveRequest.findAll({
    where: { societyId, status: 'APPROVED', moveDate: { [Op.lt]: today } },
    attributes: ['id'],
  });
  let n = 0;
  for (const { id } of rows)
    await sequelize.transaction(async t => {
      const m = await lockMove(societyId, id!, t);
      if (m.status !== 'APPROVED' || m.moveDate >= today) return;
      await cancelCore(ctx, m, 'Not started on the booked date', t, { cancelApproval: false });
      n += 1;
    });
  return n;
}
