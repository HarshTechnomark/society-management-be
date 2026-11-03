import { Op, QueryTypes, type Transaction, type WhereOptions } from 'sequelize';
import { RenovationPermit, ResidentDocument, Resident, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { AppError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { holidays, units } from '../society-setup/society-setup.public';
import { logger } from '../../lib/logger';
import { now } from '../../lib/clock';
import { systemCtx } from '../../types/context';
import {
  AUDIT3,
  ENTITY3,
  FEATURE3,
  PERMIT_MAX_EXTENSIONS,
  PERMIT_START_WINDOW_DAYS,
} from './residents.part3.constants';
import { OPEN_PERMIT_STATUSES, type DocType } from './residents.constants';
import { attachDocuments, docDto, type DocInput } from './residents.documents.service';
import { adminRoom, emitAfterCommit, notifyAfterCommit, recipients } from './residents.notify';
import { part3Ports, type ApprovalRequestRef } from './residents.part3.ports';
import {
  assertOwnUnit,
  callerResident,
  daysBetween,
  hhmm,
  num,
  ownerLinkOf,
  ownerOnly,
  permitNotFound,
  primaryOwnerUserIds,
  readSettings,
  unitLabel,
  unitLabels,
  userIdsOfResidents,
} from './residents.part3.shared';
import { touchReports } from './residents.ports';
import {
  addDaysYmd,
  assertFeatureFor,
  featureOn,
  invalidState,
  isUniqueViolation,
  maskMobile,
  rule,
  societyToday,
  staleVersion,
  weekdayOf,
} from './residents.shared';

/**
 * Renovation permits (sections 5.7, 6.6 and 8.16). Every action locks the permit row, checks `version`, changes the status
 * through the guards of 6.6 and writes its audit row in the same transaction. Deposits, approvals, fee invoices, fines and
 * deposit refunds go through the ports of `residents.part3.ports.ts` (modules 11, 13, 14 and 23 are not built yet).
 */
export type Actor = 'ADMIN' | 'RESIDENT';

export interface PermitFields {
  workCategory: string;
  workDescription: string;
  involvesStructuralChange?: boolean;
  contractorName: string;
  contractorCompany?: string | null;
  contractorMobile: string;
  workerCount: number;
  startDate: string;
  endDate: string;
  dailyStartTime: string;
  dailyEndTime: string;
  fileIds: DocInput[];
}
export interface CreatePermitInput extends PermitFields {
  unitId: number;
}

const SETTING_KEYS = [
  'residents.renovationHours',
  'residents.renovationBlackoutWeekdays',
  'residents.renovationMaxDays',
  'residents.renovationDepositPaise',
  'residents.renovationFeePaise',
] as const;

const lockPermit = async (societyId: number, id: number, t: Transaction): Promise<RenovationPermit> => {
  const p = await RenovationPermit.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!p) throw permitNotFound();
  return p;
};

function checkVersion(p: RenovationPermit, version: number): void {
  if (p.version !== version) throw staleVersion('This permit');
}

const bump = (p: RenovationPermit, ctx: Ctx): void => {
  p.version += 1;
  p.updatedBy = ctx.user?.id ?? null;
};

// ------------------------------------------------------------------ DTOs
export function permitDto(p: RenovationPermit, label: string) {
  return {
    id: p.id!,
    unitId: p.unitId,
    unitLabel: label,
    status: p.status,
    workCategory: p.workCategory,
    workDescription: p.workDescription,
    involvesStructuralChange: p.involvesStructuralChange,
    contractorName: p.contractorName,
    contractorCompany: p.contractorCompany,
    contractorMobile: maskMobile(p.contractorMobile),
    workerCount: p.workerCount,
    startDate: p.startDate,
    endDate: p.endDate,
    originalEndDate: p.originalEndDate,
    dailyStartTime: hhmm(p.dailyStartTime),
    dailyEndTime: hhmm(p.dailyEndTime),
    conditions: p.conditions,
    depositPaise: num(p.depositPaise),
    feePaise: num(p.feePaise),
    requestedByResidentId: p.requestedByResidentId,
    violationCount: p.violationCount,
    extensionCount: p.extensionCount,
    inspectionResult: p.inspectionResult,
    damageDeductionPaise: num(p.damageDeductionPaise),
    createdAt: p.createdAt!.toISOString(),
    version: p.version,
  };
}

/** The detail adds the approval link, the inspection, the violation summary and the documents. */
export async function permitDetail(societyId: number, p: RenovationPermit) {
  const docs = await ResidentDocument.findAll({
    where: { societyId, refType: 'renovation_permit', refId: p.id! },
    order: [['id', 'ASC']],
  });
  return {
    ...permitDto(p, await unitLabel(societyId, p.unitId)),
    approvalRequestId: p.approvalRequestId,
    depositId: p.depositId,
    depositPaidAt: p.depositPaidAt ? p.depositPaidAt.toISOString() : null,
    feeInvoiceId: p.feeInvoiceId,
    decidedAt: p.decidedAt ? p.decidedAt.toISOString() : null,
    decisionReason: p.decisionReason,
    startedAt: p.startedAt ? p.startedAt.toISOString() : null,
    workDoneAt: p.workDoneAt ? p.workDoneAt.toISOString() : null,
    inspectedAt: p.inspectedAt ? p.inspectedAt.toISOString() : null,
    inspectionNote: p.inspectionNote,
    lastViolationAt: p.lastViolationAt ? p.lastViolationAt.toISOString() : null,
    lastViolationCategory: p.lastViolationCategory,
    lastViolationNote: p.lastViolationNote,
    suspendedAt: p.suspendedAt ? p.suspendedAt.toISOString() : null,
    suspendReason: p.suspendReason,
    completedAt: p.completedAt ? p.completedAt.toISOString() : null,
    depositRefundRequestedAt: p.depositRefundRequestedAt ? p.depositRefundRequestedAt.toISOString() : null,
    cancelledAt: p.cancelledAt ? p.cancelledAt.toISOString() : null,
    cancelReason: p.cancelReason,
    documents: docs.map(docDto),
  };
}

// ------------------------------------------------------------------ validation (BR-09-50 to 53)
const hoursOf = (v: unknown) => v as { start: string; end: string };

async function validatePermit(
  societyId: number,
  f: Pick<PermitFields, 'startDate' | 'endDate' | 'dailyStartTime' | 'dailyEndTime'>,
  actor: Actor,
  maxDays: number,
  window: { start: string; end: string },
): Promise<void> {
  const today = await societyToday(societyId);
  const earliest = actor === 'ADMIN' ? today : addDaysYmd(today, 1);
  const bad = (field: string, message: string) => rule(422, 'PERMIT_DATES_INVALID', message, field);
  if (f.startDate < earliest)
    throw bad(
      'startDate',
      actor === 'ADMIN' ? 'The start date cannot be in the past' : 'The start date must be from tomorrow',
    );
  if (f.startDate > addDaysYmd(today, PERMIT_START_WINDOW_DAYS))
    throw bad('startDate', `The start date can be at most ${PERMIT_START_WINDOW_DAYS} days ahead`);
  if (f.endDate < f.startDate) throw bad('endDate', 'The end date cannot be before the start date');
  if (daysBetween(f.startDate, f.endDate) + 1 > maxDays)
    throw bad('endDate', `The work can last at most ${maxDays} days`);
  const hours = (field: string) =>
    rule(422, 'PERMIT_HOURS_NOT_ALLOWED', `Work is allowed between ${window.start} and ${window.end}`, field);
  if (f.dailyStartTime >= f.dailyEndTime) throw hours('dailyEndTime');
  if (f.dailyStartTime < window.start) throw hours('dailyStartTime');
  if (f.dailyEndTime > window.end) throw hours('dailyEndTime');
}

function missingPermitDocs(structural: boolean, types: string[]): DocType[] {
  const missing: DocType[] = [];
  if (!types.includes('CONTRACTOR_ID')) missing.push('CONTRACTOR_ID');
  if (structural && !types.includes('STRUCTURAL_CERTIFICATE')) missing.push('STRUCTURAL_CERTIFICATE');
  return missing;
}
const docsRequired = (missing: string[]) =>
  new AppError(422, 'DOCUMENTS_REQUIRED', 'Attach the required documents', [
    { field: 'fileIds', message: `Missing: ${missing.join(', ')}`, missing },
  ]);

// ------------------------------------------------------------------ approval payload
const approvalSummary = (p: RenovationPermit, label: string) => [
  { label: 'Flat', value: label },
  { label: 'Work', value: `${p.workCategory}: ${p.workDescription.slice(0, 80)}` },
  { label: 'Dates', value: `${p.startDate} to ${p.endDate}` },
  { label: 'Hours', value: `${hhmm(p.dailyStartTime)} to ${hhmm(p.dailyEndTime)}` },
  { label: 'Contractor', value: `${p.contractorName} (${p.workerCount} workers)` },
  { label: 'Structural change', value: p.involvesStructuralChange ? 'Yes' : 'No' },
];

/**
 * Moves a permit into PENDING_APPROVAL and asks module 14. A module 14 rule that matches nothing auto-approves inside the
 * call, so the permit row is read again afterwards.
 */
async function requestApproval(ctx: Ctx, p: RenovationPermit, t: Transaction): Promise<void> {
  const label = await unitLabel(p.societyId, p.unitId);
  const req = await part3Ports().approvals.request(
    ctx,
    {
      type: 'RENOVATION_PERMIT',
      entityId: p.id!,
      unitId: p.unitId,
      title: `Renovation permit for ${label}`,
      summary: approvalSummary(p, label),
      payload: { permitId: p.id, depositPaise: num(p.depositPaise), feePaise: num(p.feePaise) },
    },
    t,
  );
  await RenovationPermit.update({ approvalRequestId: req.id }, { where: { id: p.id! }, transaction: t });
}

function changed(t: Transaction, societyId: number, p: RenovationPermit, label: string, gate = false): void {
  emitAfterCommit(t, adminRoom(societyId), 'residents.requests.changed', {
    kind: 'RENOVATION',
    id: p.id!,
    status: p.status,
  });
  if (gate)
    emitAfterCommit(t, `society:${societyId}:gate`, 'gate.renovation.updated', {
      permitId: p.id!,
      unitLabel: label,
      contractorName: p.contractorName,
      status: p.status,
      startDate: p.startDate,
      endDate: p.endDate,
    });
  touchReports(t, societyId);
}

async function requesterUserIds(p: RenovationPermit, t?: Transaction): Promise<number[]> {
  const ids = p.requestedByResidentId
    ? await userIdsOfResidents(p.societyId, [p.requestedByResidentId], t)
    : [];
  return ids.length ? ids : primaryOwnerUserIds(p.societyId, p.unitId, t);
}

// ------------------------------------------------------------------ create (8.16)
export async function createPermit(ctx: Ctx, societyId: number, input: CreatePermitInput, actor: Actor) {
  await assertFeatureFor(societyId, FEATURE3.permits);
  return sequelize.transaction(async t => {
    const unit = await units.lockActive(societyId, input.unitId, t);
    let requester: Resident | null = null;
    const today = await societyToday(societyId);
    if (actor === 'RESIDENT') {
      assertOwnUnit(ctx, input.unitId);
      requester = await callerResident(ctx, societyId);
      if (!(await ownerLinkOf(societyId, requester.id!, input.unitId, today, t))) throw ownerOnly();
    }
    const s = await readSettings(societyId, [...SETTING_KEYS]);
    await validatePermit(
      societyId,
      input,
      actor,
      s['residents.renovationMaxDays'] as number,
      hoursOf(s['residents.renovationHours']),
    );
    const structural = input.involvesStructuralChange ?? false;
    const missing = missingPermitDocs(
      structural,
      input.fileIds.map(f => f.docType),
    );
    if (missing.length) throw docsRequired(missing);
    if (
      await RenovationPermit.count({
        where: { societyId, unitId: input.unitId, status: { [Op.in]: [...OPEN_PERMIT_STATUSES] } },
        transaction: t,
      })
    )
      throw rule(409, 'PERMIT_EXISTS', 'The flat already has an open renovation permit', 'unitId');
    const deposit = s['residents.renovationDepositPaise'] as number;
    const fee = s['residents.renovationFeePaise'] as number;
    let p: RenovationPermit;
    try {
      p = await RenovationPermit.create(
        {
          societyId,
          unitId: input.unitId,
          requestedByResidentId: requester?.id ?? null,
          workCategory: input.workCategory,
          workDescription: input.workDescription,
          involvesStructuralChange: structural,
          contractorName: input.contractorName,
          contractorCompany: input.contractorCompany ?? null,
          contractorMobile: input.contractorMobile,
          workerCount: input.workerCount,
          startDate: input.startDate,
          endDate: input.endDate,
          originalEndDate: input.endDate,
          dailyStartTime: input.dailyStartTime,
          dailyEndTime: input.dailyEndTime,
          conditions: null,
          status: deposit > 0 ? 'PENDING_DEPOSIT' : 'PENDING_APPROVAL',
          depositPaise: deposit,
          depositId: null,
          depositPaidAt: null,
          feePaise: fee,
          feeInvoiceId: null,
          approvalRequestId: null,
          decidedAt: null,
          decisionReason: null,
          startedAt: null,
          workDoneAt: null,
          inspectedAt: null,
          inspectedBy: null,
          inspectionResult: null,
          inspectionNote: null,
          damageDeductionPaise: 0,
          violationCount: 0,
          lastViolationAt: null,
          lastViolationCategory: null,
          lastViolationNote: null,
          suspendedAt: null,
          suspendReason: null,
          extensionCount: 0,
          completedAt: null,
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
        throw rule(409, 'PERMIT_EXISTS', 'The flat already has an open renovation permit', 'unitId');
      throw err;
    }
    await attachDocuments(ctx, societyId, t, {
      residentId: requester?.id ?? null,
      unitId: input.unitId,
      refType: 'renovation_permit',
      refId: p.id!,
      items: input.fileIds,
    });
    let depositPayment: { depositId: number; paymentOrderId: number } | null = null;
    if (deposit > 0) {
      depositPayment = await part3Ports().deposits.request(
        ctx,
        {
          unitId: input.unitId,
          kind: 'RENOVATION',
          refType: 'renovation_permit',
          refId: p.id!,
          amountPaise: deposit,
          payerResidentId: requester?.id ?? null,
        },
        t,
      );
      await RenovationPermit.update(
        { depositId: depositPayment.depositId },
        { where: { id: p.id! }, transaction: t },
      );
    }
    await audit(
      ctx,
      {
        action: AUDIT3.permitCreated,
        entityType: ENTITY3.permit,
        entityId: p.id!,
        entityLabel: unit.label,
        societyId,
        after: {
          unitId: input.unitId,
          workCategory: input.workCategory,
          startDate: input.startDate,
          endDate: input.endDate,
          depositPaise: deposit,
          feePaise: fee,
          status: p.status,
        },
      },
      t,
    );
    if (deposit === 0) await requestApproval(ctx, p, t);
    const fresh = (await RenovationPermit.findByPk(p.id!, { transaction: t }))!;
    changed(t, societyId, fresh, unit.label);
    return { ...permitDto(fresh, unit.label), depositPayment };
  });
}

// ------------------------------------------------------------------ list and read
export interface ListPermitsQuery {
  status?: string;
  unitId?: number;
  activeOn?: string;
  sortBy: 'startDate' | 'createdAt';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

export async function listPermits(societyId: number, q: ListPermitsQuery, unitIds?: number[]) {
  const where: WhereOptions<RenovationPermit> = { societyId };
  const w = where as Record<string | symbol, unknown>;
  if (q.status) w.status = q.status;
  if (q.unitId) w.unitId = q.unitId;
  if (unitIds) {
    if (q.unitId && !unitIds.includes(q.unitId)) w.unitId = 0;
    else if (!q.unitId) w.unitId = { [Op.in]: unitIds };
  }
  if (q.activeOn) {
    w.startDate = { [Op.lte]: q.activeOn };
    w.endDate = { [Op.gte]: q.activeOn };
  }
  const { rows, count } = await RenovationPermit.findAndCountAll({
    where,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'ASC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const labels = await unitLabels(
    societyId,
    rows.map(r => r.unitId),
  );
  return {
    data: rows.map(r => permitDto(r, labels.get(r.unitId) ?? '')),
    pagination: pageMeta(q.page, q.limit, count),
  };
}

export async function getPermit(societyId: number, id: number) {
  const p = await RenovationPermit.findOne({ where: { id, societyId } });
  if (!p) throw permitNotFound();
  return permitDetail(societyId, p);
}

// ------------------------------------------------------------------ patch (conditions, contractor)
export interface PatchPermitInput {
  conditions?: string | null;
  contractorName?: string;
  contractorCompany?: string | null;
  contractorMobile?: string;
  workerCount?: number;
  version: number;
}

export async function patchPermit(ctx: Ctx, societyId: number, id: number, input: PatchPermitInput) {
  return sequelize.transaction(async t => {
    const p = await lockPermit(societyId, id, t);
    if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(p.status))
      throw invalidState('This permit can no longer be changed');
    checkVersion(p, input.version);
    if (
      input.conditions !== undefined &&
      !['PENDING_DEPOSIT', 'PENDING_APPROVAL', 'APPROVED'].includes(p.status)
    )
      throw invalidState('Conditions can only be set before the work starts');
    const before = {
      contractorName: p.contractorName,
      workerCount: p.workerCount,
      conditions: p.conditions,
    };
    if (input.conditions !== undefined) p.conditions = input.conditions;
    if (input.contractorName !== undefined) p.contractorName = input.contractorName;
    if (input.contractorCompany !== undefined) p.contractorCompany = input.contractorCompany;
    if (input.contractorMobile !== undefined) p.contractorMobile = input.contractorMobile;
    if (input.workerCount !== undefined) p.workerCount = input.workerCount;
    bump(p, ctx);
    await p.save({ transaction: t });
    const label = await unitLabel(societyId, p.unitId);
    await audit(
      ctx,
      {
        action: AUDIT3.permitUpdated,
        entityType: ENTITY3.permit,
        entityId: p.id!,
        entityLabel: label,
        societyId,
        before,
        after: { contractorName: p.contractorName, workerCount: p.workerCount, conditions: p.conditions },
      },
      t,
    );
    changed(t, societyId, p, label, true);
    return permitDto(p, label);
  });
}

// ------------------------------------------------------------------ resubmit after changes were requested (8.23)
export async function resubmitPermit(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: Omit<PermitFields, 'fileIds'> & { fileIds?: DocInput[]; version: number },
) {
  return sequelize.transaction(async t => {
    const p = await lockPermit(societyId, id, t);
    assertOwnUnit(ctx, p.unitId);
    await assertCanActAsOwner(ctx, p, t);
    if (p.status !== 'PENDING_APPROVAL' || !p.approvalRequestId)
      throw invalidState('This permit is not waiting for changes');
    checkVersion(p, input.version);
    const status = await part3Ports().approvals.publicStatus(societyId, 'RENOVATION_PERMIT', p.id!);
    if (status.status !== 'CHANGES_REQUESTED') throw invalidState('No changes were requested on this permit');
    const s = await readSettings(societyId, [...SETTING_KEYS]);
    await validatePermit(
      societyId,
      input,
      'RESIDENT',
      s['residents.renovationMaxDays'] as number,
      hoursOf(s['residents.renovationHours']),
    );
    const structural = input.involvesStructuralChange ?? false;
    const existing = (
      await ResidentDocument.findAll({
        where: { societyId, refType: 'renovation_permit', refId: p.id! },
        attributes: ['docType'],
        transaction: t,
      })
    ).map(d => d.docType);
    const missing = missingPermitDocs(structural, [
      ...existing,
      ...(input.fileIds ?? []).map(f => f.docType),
    ]);
    if (missing.length) throw docsRequired(missing);
    if (input.fileIds?.length)
      await attachDocuments(ctx, societyId, t, {
        residentId: p.requestedByResidentId,
        unitId: p.unitId,
        refType: 'renovation_permit',
        refId: p.id!,
        items: input.fileIds,
      });
    Object.assign(p, {
      workCategory: input.workCategory,
      workDescription: input.workDescription,
      involvesStructuralChange: structural,
      contractorName: input.contractorName,
      contractorCompany: input.contractorCompany ?? null,
      contractorMobile: input.contractorMobile,
      workerCount: input.workerCount,
      startDate: input.startDate,
      endDate: input.endDate,
      originalEndDate: input.endDate,
      dailyStartTime: input.dailyStartTime,
      dailyEndTime: input.dailyEndTime,
    });
    bump(p, ctx);
    await p.save({ transaction: t });
    const label = await unitLabel(societyId, p.unitId);
    await part3Ports().approvals.resubmit(
      ctx,
      p.approvalRequestId,
      { title: `Renovation permit for ${label}`, summary: approvalSummary(p, label) },
      t,
    );
    await audit(
      ctx,
      {
        action: AUDIT3.permitResubmitted,
        entityType: ENTITY3.permit,
        entityId: p.id!,
        entityLabel: label,
        societyId,
        after: { startDate: p.startDate, endDate: p.endDate },
      },
      t,
    );
    changed(t, societyId, p, label);
    return permitDto(p, label);
  });
}

/** Resident-app actions: the requester or an owner of the flat (BR-09-50). */
async function assertCanActAsOwner(ctx: Ctx, p: RenovationPermit, t: Transaction): Promise<void> {
  const me = await callerResident(ctx, p.societyId);
  if (p.requestedByResidentId === me.id) return;
  if (!(await ownerLinkOf(p.societyId, me.id!, p.unitId, await societyToday(p.societyId), t)))
    throw ownerOnly();
}

// ------------------------------------------------------------------ start
export async function startPermit(ctx: Ctx, societyId: number, id: number, version: number) {
  return sequelize.transaction(async t => {
    const p = await lockPermit(societyId, id, t);
    if (p.status !== 'APPROVED') throw invalidState('Only an approved permit can be started');
    checkVersion(p, version);
    if ((await societyToday(societyId)) < p.startDate)
      throw rule(422, 'PERMIT_DATES_INVALID', 'The work cannot start before the start date', 'startDate');
    await toInProgress(ctx, p, t, AUDIT3.permitStarted);
    return permitDto(p, await unitLabel(societyId, p.unitId));
  });
}

async function toInProgress(ctx: Ctx, p: RenovationPermit, t: Transaction, action: string): Promise<void> {
  p.status = 'IN_PROGRESS';
  p.startedAt = now();
  bump(p, ctx);
  await p.save({ transaction: t });
  const label = await unitLabel(p.societyId, p.unitId);
  await audit(
    ctx,
    {
      action,
      entityType: ENTITY3.permit,
      entityId: p.id!,
      entityLabel: label,
      societyId: p.societyId,
      after: { status: p.status },
    },
    t,
  );
  changed(t, p.societyId, p, label, true);
}

// ------------------------------------------------------------------ extend (BR-09-57)
export async function extendPermit(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { endDate: string; reason: string; version: number },
) {
  return sequelize.transaction(async t => {
    const p = await lockPermit(societyId, id, t);
    if (!['APPROVED', 'IN_PROGRESS', 'SUSPENDED'].includes(p.status))
      throw invalidState('This permit cannot be extended now');
    checkVersion(p, input.version);
    if (p.extensionCount >= PERMIT_MAX_EXTENSIONS)
      throw rule(422, 'EXTENSION_LIMIT_REACHED', 'A permit can be extended at most 3 times', 'endDate');
    const maxDays = (await readSettings(societyId, ['residents.renovationMaxDays']))[
      'residents.renovationMaxDays'
    ] as number;
    if (input.endDate <= p.endDate)
      throw rule(
        422,
        'PERMIT_DATES_INVALID',
        'The new end date must be after the current end date',
        'endDate',
      );
    if (daysBetween(p.startDate, input.endDate) + 1 > maxDays)
      throw rule(422, 'PERMIT_DATES_INVALID', `The work can last at most ${maxDays} days`, 'endDate');
    const before = p.endDate;
    p.endDate = input.endDate;
    p.extensionCount += 1;
    bump(p, ctx);
    await p.save({ transaction: t });
    const label = await unitLabel(societyId, p.unitId);
    await audit(
      ctx,
      {
        action: AUDIT3.permitExtended,
        entityType: ENTITY3.permit,
        entityId: p.id!,
        entityLabel: label,
        societyId,
        before: { endDate: before },
        after: { endDate: p.endDate, extensionCount: p.extensionCount },
        reason: input.reason,
      },
      t,
    );
    changed(t, societyId, p, label, true);
    return permitDto(p, label);
  });
}

// ------------------------------------------------------------------ violations, suspend, resume (BR-09-56)
export async function recordViolation(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { category: string; note: string; stopWork: boolean; finePaise: number; version: number },
) {
  return sequelize.transaction(async t => {
    const p = await lockPermit(societyId, id, t);
    if (!['IN_PROGRESS', 'SUSPENDED'].includes(p.status))
      throw invalidState('A violation can only be recorded while the work is on');
    checkVersion(p, input.version);
    p.violationCount += 1;
    p.lastViolationAt = now();
    p.lastViolationCategory = input.category;
    p.lastViolationNote = input.note;
    if (input.stopWork && p.status === 'IN_PROGRESS') {
      p.status = 'SUSPENDED';
      p.suspendedAt = now();
      p.suspendReason = input.note;
    }
    bump(p, ctx);
    await p.save({ transaction: t });
    const label = await unitLabel(societyId, p.unitId);
    if (input.finePaise > 0)
      await part3Ports().ruleViolations.create(
        ctx,
        {
          unitId: p.unitId,
          ruleKey: 'RENOVATION',
          description: `Renovation violation (${input.category}): ${input.note}`,
          finePaise: input.finePaise,
          refType: 'renovation_permit',
          refId: p.id!,
        },
        t,
      );
    await audit(
      ctx,
      {
        action: AUDIT3.permitViolation,
        entityType: ENTITY3.permit,
        entityId: p.id!,
        entityLabel: label,
        societyId,
        after: {
          category: input.category,
          stopWork: input.stopWork,
          finePaise: input.finePaise,
          violationCount: p.violationCount,
          status: p.status,
        },
        reason: input.note,
      },
      t,
    );
    const to = [...(await requesterUserIds(p, t)), ...(await primaryOwnerUserIds(societyId, p.unitId, t))];
    notifyAfterCommit(t, 'residents.renovation_violation', societyId, recipients.users(to), {
      unitLabel: label,
      category: input.category,
      note: input.note,
      stopWork: input.stopWork,
      link: '/requests',
    });
    changed(t, societyId, p, label, input.stopWork);
    return permitDto(p, label);
  });
}

export async function suspendPermit(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { reason: string; version: number },
) {
  return sequelize.transaction(async t => {
    const p = await lockPermit(societyId, id, t);
    if (p.status !== 'IN_PROGRESS') throw invalidState('Only work in progress can be stopped');
    checkVersion(p, input.version);
    p.status = 'SUSPENDED';
    p.suspendedAt = now();
    p.suspendReason = input.reason;
    bump(p, ctx);
    await p.save({ transaction: t });
    const label = await unitLabel(societyId, p.unitId);
    await audit(
      ctx,
      {
        action: AUDIT3.permitSuspended,
        entityType: ENTITY3.permit,
        entityId: p.id!,
        entityLabel: label,
        societyId,
        after: { status: p.status },
        reason: input.reason,
      },
      t,
    );
    changed(t, societyId, p, label, true);
    return permitDto(p, label);
  });
}

export async function resumePermit(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { note?: string; version: number },
) {
  return sequelize.transaction(async t => {
    const p = await lockPermit(societyId, id, t);
    if (p.status !== 'SUSPENDED') throw invalidState('Only stopped work can be resumed');
    checkVersion(p, input.version);
    if ((await societyToday(societyId)) > p.endDate)
      throw rule(422, 'PERMIT_EXPIRED', 'The permit has ended. Extend it first.', 'endDate');
    p.status = 'IN_PROGRESS';
    p.suspendedAt = null;
    p.suspendReason = null;
    bump(p, ctx);
    await p.save({ transaction: t });
    const label = await unitLabel(societyId, p.unitId);
    await audit(
      ctx,
      {
        action: AUDIT3.permitResumed,
        entityType: ENTITY3.permit,
        entityId: p.id!,
        entityLabel: label,
        societyId,
        after: { status: p.status },
        reason: input.note ?? null,
      },
      t,
    );
    changed(t, societyId, p, label, true);
    return permitDto(p, label);
  });
}

// ------------------------------------------------------------------ work done and inspection (BR-09-58)
async function toInspection(
  ctx: Ctx,
  p: RenovationPermit,
  t: Transaction,
  note: string | null,
): Promise<void> {
  p.status = 'INSPECTION_PENDING';
  p.workDoneAt = now();
  bump(p, ctx);
  await p.save({ transaction: t });
  const label = await unitLabel(p.societyId, p.unitId);
  await audit(
    ctx,
    {
      action: AUDIT3.permitWorkDone,
      entityType: ENTITY3.permit,
      entityId: p.id!,
      entityLabel: label,
      societyId: p.societyId,
      after: { status: p.status },
      reason: note,
    },
    t,
  );
  notifyAfterCommit(t, 'residents.renovation_inspection_due', p.societyId, recipients.admins, {
    unitLabel: label,
    link: '/requests',
  });
  changed(t, p.societyId, p, label);
}

export async function workDone(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { note?: string; version: number },
  actor: Actor,
) {
  return sequelize.transaction(async t => {
    const p = await lockPermit(societyId, id, t);
    if (actor === 'RESIDENT') {
      assertOwnUnit(ctx, p.unitId);
      await assertCanActAsOwner(ctx, p, t);
    }
    if (p.status !== 'IN_PROGRESS')
      throw invalidState('Work can only be marked done while it is in progress');
    checkVersion(p, input.version);
    await toInspection(ctx, p, t, input.note ?? null);
    return permitDto(p, await unitLabel(societyId, p.unitId));
  });
}

export async function inspectPermit(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { result: 'PASSED' | 'FAILED'; note: string; damageDeductionPaise: number; version: number },
) {
  return sequelize.transaction(async t => {
    const p = await lockPermit(societyId, id, t);
    if (p.status !== 'INSPECTION_PENDING') throw invalidState('This permit is not waiting for an inspection');
    checkVersion(p, input.version);
    const label = await unitLabel(societyId, p.unitId);
    const today = await societyToday(societyId);
    p.inspectionResult = input.result;
    p.inspectionNote = input.note;
    p.inspectedAt = now();
    p.inspectedBy = ctx.user?.id ?? null;
    if (input.result === 'PASSED') {
      if (input.damageDeductionPaise > num(p.depositPaise))
        throw rule(
          422,
          'DEDUCTION_TOO_HIGH',
          'The deduction cannot be more than the deposit',
          'damageDeductionPaise',
        );
      p.status = 'COMPLETED';
      p.completedAt = now();
      p.damageDeductionPaise = input.damageDeductionPaise;
      if (p.depositId && p.depositPaidAt && !p.depositRefundRequestedAt) {
        await part3Ports().deposits.requestRefund(
          ctx,
          p.depositId,
          { deductionPaise: input.damageDeductionPaise, reason: 'Renovation completed' },
          t,
        );
        p.depositRefundRequestedAt = now();
      }
    } else {
      if (p.endDate < today)
        throw rule(
          422,
          'PERMIT_EXPIRED',
          'The permit has ended. Extend it before a failed inspection.',
          'endDate',
        );
      p.status = 'IN_PROGRESS';
      p.workDoneAt = null;
    }
    bump(p, ctx);
    await p.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT3.permitInspected,
        entityType: ENTITY3.permit,
        entityId: p.id!,
        entityLabel: label,
        societyId,
        after: { result: input.result, damageDeductionPaise: input.damageDeductionPaise, status: p.status },
        reason: input.note,
      },
      t,
    );
    if (input.result === 'PASSED') {
      await audit(
        ctx,
        {
          action: AUDIT3.permitCompleted,
          entityType: ENTITY3.permit,
          entityId: p.id!,
          entityLabel: label,
          societyId,
          after: { depositRefundRequested: p.depositRefundRequestedAt !== null },
        },
        t,
      );
      notifyAfterCommit(
        t,
        'residents.renovation_completed',
        societyId,
        recipients.users(await requesterUserIds(p, t)),
        {
          unitLabel: label,
          deductionPaise: input.damageDeductionPaise,
          link: '/requests',
        },
      );
    }
    changed(t, societyId, p, label, input.result === 'PASSED');
    return permitDto(p, label);
  });
}

// ------------------------------------------------------------------ cancel (6.6)
async function cancelEffect(
  ctx: Ctx,
  p: RenovationPermit,
  reason: string,
  t: Transaction,
  o: { fromApprovals?: boolean } = {},
): Promise<void> {
  p.status = 'CANCELLED';
  p.cancelledAt = now();
  p.cancelReason = reason.slice(0, 300);
  bump(p, ctx);
  await p.save({ transaction: t });
  if (p.depositId && p.depositPaidAt && !p.depositRefundRequestedAt) {
    await part3Ports().deposits.requestRefund(
      ctx,
      p.depositId,
      { deductionPaise: 0, reason: 'Permit cancelled' },
      t,
    );
    p.depositRefundRequestedAt = now();
    await p.save({ transaction: t });
  }
  if (p.feeInvoiceId)
    await part3Ports().invoices.cancelForRef(
      ctx,
      { refType: 'renovation_permit', refId: p.id!, reason: 'Permit cancelled' },
      t,
    );
  if (p.approvalRequestId && !o.fromApprovals)
    await part3Ports().approvals.cancel(ctx, p.approvalRequestId, reason, t);
  const label = await unitLabel(p.societyId, p.unitId);
  await audit(
    ctx,
    {
      action: AUDIT3.permitCancelled,
      entityType: ENTITY3.permit,
      entityId: p.id!,
      entityLabel: label,
      societyId: p.societyId,
      after: { status: p.status },
      reason,
    },
    t,
  );
  changed(t, p.societyId, p, label, true);
}

export async function cancelPermit(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { reason: string; version: number },
  actor: Actor,
) {
  return sequelize.transaction(async t => {
    const p = await lockPermit(societyId, id, t);
    if (actor === 'RESIDENT') {
      assertOwnUnit(ctx, p.unitId);
      await assertCanActAsOwner(ctx, p, t);
    }
    if (!['PENDING_DEPOSIT', 'PENDING_APPROVAL', 'APPROVED'].includes(p.status))
      throw invalidState('This permit can no longer be cancelled');
    checkVersion(p, input.version);
    await cancelEffect(ctx, p, input.reason, t);
    return permitDto(p, await unitLabel(societyId, p.unitId));
  });
}

// ------------------------------------------------------------------ module 14 callbacks (6.8)
async function lockForApproval(req: ApprovalRequestRef, t: Transaction): Promise<RenovationPermit | null> {
  return RenovationPermit.findOne({
    where: { id: req.entityId, societyId: req.societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
}

export const permitApprovals = {
  /** BR-09-54, 55: APPROVED; the fee is raised through module 11. Returns without change when no longer pending. */
  async onApproved(ctx: Ctx, req: ApprovalRequestRef, t: Transaction): Promise<void> {
    const p = await lockForApproval(req, t);
    if (!p || p.status !== 'PENDING_APPROVAL') return;
    const label = await unitLabel(p.societyId, p.unitId);
    p.status = 'APPROVED';
    p.decidedAt = now();
    if (num(p.feePaise) > 0) {
      const inv = await part3Ports().invoices.createAdHoc(
        ctx,
        {
          unitId: p.unitId,
          chargeHeadKey: 'RENOVATION_FEE',
          amountPaise: num(p.feePaise),
          refType: 'renovation_permit',
          refId: p.id!,
          dueDate: p.startDate,
        },
        t,
      );
      p.feeInvoiceId = inv.invoiceId;
    }
    bump(p, ctx);
    await p.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT3.permitApproved,
        entityType: ENTITY3.permit,
        entityId: p.id!,
        entityLabel: label,
        societyId: p.societyId,
        after: { status: p.status, feeInvoiceId: p.feeInvoiceId },
      },
      t,
    );
    notifyAfterCommit(
      t,
      'residents.renovation_approved',
      p.societyId,
      recipients.users(await requesterUserIds(p, t)),
      {
        unitLabel: label,
        startDate: p.startDate,
        dailyStartTime: hhmm(p.dailyStartTime),
        dailyEndTime: hhmm(p.dailyEndTime),
        link: '/requests',
      },
    );
    changed(t, p.societyId, p, label, true);
  },

  /** REJECTED, with the decision reason and a full refund of a paid deposit. */
  async onRejected(ctx: Ctx, req: ApprovalRequestRef, t: Transaction): Promise<void> {
    const p = await lockForApproval(req, t);
    if (!p || p.status !== 'PENDING_APPROVAL') return;
    const label = await unitLabel(p.societyId, p.unitId);
    p.status = 'REJECTED';
    p.decidedAt = now();
    p.decisionReason = req.reason?.slice(0, 500) ?? null;
    if (p.depositId && p.depositPaidAt && !p.depositRefundRequestedAt) {
      await part3Ports().deposits.requestRefund(
        ctx,
        p.depositId,
        { deductionPaise: 0, reason: 'Permit rejected' },
        t,
      );
      p.depositRefundRequestedAt = now();
    }
    bump(p, ctx);
    await p.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT3.permitRejected,
        entityType: ENTITY3.permit,
        entityId: p.id!,
        entityLabel: label,
        societyId: p.societyId,
        after: { status: p.status },
        reason: p.decisionReason,
      },
      t,
    );
    notifyAfterCommit(
      t,
      'residents.renovation_rejected',
      p.societyId,
      recipients.users(await requesterUserIds(p, t)),
      {
        unitLabel: label,
        reason: p.decisionReason,
        link: '/requests',
      },
    );
    changed(t, p.societyId, p, label);
  },

  /** Audit and a notice to the requester; the permit keeps PENDING_APPROVAL (8.23). */
  async onChangesRequested(ctx: Ctx, req: ApprovalRequestRef, t: Transaction): Promise<void> {
    const p = await lockForApproval(req, t);
    if (!p || p.status !== 'PENDING_APPROVAL') return;
    const label = await unitLabel(p.societyId, p.unitId);
    await audit(
      ctx,
      {
        action: AUDIT3.permitChangesRequested,
        entityType: ENTITY3.permit,
        entityId: p.id!,
        entityLabel: label,
        societyId: p.societyId,
        reason: req.reason ?? null,
      },
      t,
    );
    notifyAfterCommit(
      t,
      'residents.request_changes_requested',
      p.societyId,
      recipients.users(await requesterUserIds(p, t)),
      { kind: 'renovation permit', unitLabel: label, reason: req.reason ?? null, link: '/requests' },
    );
    changed(t, p.societyId, p, label);
  },

  /** Same effect as the permit's own cancel (BR-09-49). */
  async onCancelled(ctx: Ctx, req: ApprovalRequestRef, t: Transaction): Promise<void> {
    const p = await lockForApproval(req, t);
    if (!p || !['PENDING_DEPOSIT', 'PENDING_APPROVAL', 'APPROVED'].includes(p.status)) return;
    await cancelEffect(ctx, p, req.reason ?? 'Cancelled in the approval inbox', t, { fromApprovals: true });
  },

  async describe(req: ApprovalRequestRef) {
    const p = await RenovationPermit.findOne({ where: { id: req.entityId, societyId: req.societyId } });
    if (!p) return { title: 'Renovation permit', lines: [] };
    const label = await unitLabel(p.societyId, p.unitId);
    return { title: `Renovation permit for ${label}`, lines: approvalSummary(p, label) };
  },
};

// ------------------------------------------------------------------ module 13 hooks (deposit paid and refunded)
export async function onRenovationDepositPaid(
  ctx: Ctx,
  societyId: number,
  input: { refId: number; depositId: number },
  t: Transaction,
): Promise<void> {
  const p = await RenovationPermit.findOne({
    where: { id: input.refId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!p || p.status !== 'PENDING_DEPOSIT') return;
  p.depositId = input.depositId;
  p.depositPaidAt = now();
  p.status = 'PENDING_APPROVAL';
  bump(p, ctx);
  await p.save({ transaction: t });
  const label = await unitLabel(societyId, p.unitId);
  await audit(
    ctx,
    {
      action: AUDIT3.permitDepositPaid,
      entityType: ENTITY3.permit,
      entityId: p.id!,
      entityLabel: label,
      societyId,
      after: { depositId: input.depositId, depositPaise: num(p.depositPaise) },
    },
    t,
  );
  await requestApproval(ctx, p, t);
  changed(t, societyId, (await RenovationPermit.findByPk(p.id!, { transaction: t }))!, label);
}

export async function onRenovationDepositRefunded(
  ctx: Ctx,
  societyId: number,
  input: { refId: number; depositId: number; refundedPaise: number },
  t: Transaction,
): Promise<void> {
  const p = await RenovationPermit.findOne({ where: { id: input.refId, societyId }, transaction: t });
  if (!p) return;
  await audit(
    ctx,
    {
      action: 'residents.renovation_permit.deposit_refunded',
      entityType: ENTITY3.permit,
      entityId: p.id!,
      societyId,
      after: { depositId: input.depositId, refundedPaise: input.refundedPaise },
    },
    t,
  );
}

// ------------------------------------------------------------------ gate (BR-09-59)
export interface GatePermit {
  id: number;
  unitLabel: string;
  contractorName: string;
  contractorCompany: string | null;
  contractorMobile: string;
  workerCount: number;
  dailyStartTime: string;
  dailyEndTime: string;
  status: 'IN_PROGRESS' | 'SUSPENDED';
  conditions: string | null;
}

/** Is `date` a day on which renovation work is allowed (not a blackout weekday, not a module 08 holiday)? */
export async function isWorkDay(societyId: number, date: string): Promise<boolean> {
  const blackout = (await readSettings(societyId, ['residents.renovationBlackoutWeekdays']))[
    'residents.renovationBlackoutWeekdays'
  ] as number[];
  if (blackout.includes(weekdayOf(date))) return false;
  return !(await holidays.isHoliday(societyId, date));
}

/**
 * Permits valid on `date` by BR-09-59 except the time of day: IN_PROGRESS or SUSPENDED, `startDate <= date <= endDate`, not a
 * blackout weekday and not a holiday. Contractor mobile is masked. A suspended permit is listed so the guard can deny entry.
 */
export async function listForGate(societyId: number, date: string): Promise<GatePermit[]> {
  if (!(await isWorkDay(societyId, date))) return [];
  const rows = await RenovationPermit.findAll({
    where: {
      societyId,
      status: { [Op.in]: ['IN_PROGRESS', 'SUSPENDED'] },
      startDate: { [Op.lte]: date },
      endDate: { [Op.gte]: date },
    },
    order: [['id', 'ASC']],
  });
  const labels = await unitLabels(
    societyId,
    rows.map(r => r.unitId),
  );
  return rows.map(r => ({
    id: r.id!,
    unitLabel: labels.get(r.unitId) ?? '',
    contractorName: r.contractorName,
    contractorCompany: r.contractorCompany,
    contractorMobile: maskMobile(r.contractorMobile) ?? '',
    workerCount: r.workerCount,
    dailyStartTime: hhmm(r.dailyStartTime),
    dailyEndTime: hhmm(r.dailyEndTime),
    status: r.status as 'IN_PROGRESS' | 'SUSPENDED',
    conditions: r.conditions,
  }));
}

/** BR-09-59 in full: is a contractor pass valid at the gate at this date and time (`HH:mm`)? */
export async function passValidAt(
  societyId: number,
  permitId: number,
  date: string,
  time: string,
): Promise<boolean> {
  const p = await RenovationPermit.findOne({ where: { id: permitId, societyId } });
  if (!p || p.status !== 'IN_PROGRESS') return false;
  if (date < p.startDate || date > p.endDate) return false;
  if (!(await isWorkDay(societyId, date))) return false;
  return time >= hhmm(p.dailyStartTime) && time <= hhmm(p.dailyEndTime);
}

// ------------------------------------------------------------------ daily job (9.1 residents:renovation-daily)
/**
 * APPROVED permits with `startDate <= today` become IN_PROGRESS; IN_PROGRESS or SUSPENDED permits with `endDate < today`
 * become INSPECTION_PENDING and the admins are told. Each row is re-read under its lock, so a second run changes nothing.
 */
export async function runRenovationDaily(
  societyId: number,
  ctx: Ctx = systemCtx('renovation-daily'),
): Promise<{ started: number; inspection: number }> {
  if (!(await featureOn(societyId, FEATURE3.permits))) return { started: 0, inspection: 0 };
  const today = await societyToday(societyId);
  const out = { started: 0, inspection: 0 };
  const start = await sequelize.query<{ id: number }>(
    `SELECT id FROM renovation_permits WHERE societyId = :societyId AND status = 'APPROVED' AND startDate <= :today ORDER BY id`,
    { replacements: { societyId, today }, type: QueryTypes.SELECT },
  );
  for (const { id } of start)
    try {
      await sequelize.transaction(async t => {
        const p = await lockPermit(societyId, Number(id), t);
        if (p.status !== 'APPROVED' || p.startDate > today) return;
        await toInProgress(ctx, p, t, AUDIT3.permitStarted);
        out.started += 1;
      });
    } catch (err) {
      logger.error({ err, permitId: id }, 'residents:renovation-daily start failed');
    }
  const over = await sequelize.query<{ id: number }>(
    `SELECT id FROM renovation_permits WHERE societyId = :societyId AND status IN ('IN_PROGRESS','SUSPENDED') AND endDate < :today ORDER BY id`,
    { replacements: { societyId, today }, type: QueryTypes.SELECT },
  );
  for (const { id } of over)
    try {
      await sequelize.transaction(async t => {
        const p = await lockPermit(societyId, Number(id), t);
        if (!['IN_PROGRESS', 'SUSPENDED'].includes(p.status) || p.endDate >= today) return;
        await toInspection(ctx, p, t, 'The permit end date passed');
        out.inspection += 1;
      });
    } catch (err) {
      logger.error({ err, permitId: id }, 'residents:renovation-daily inspection failed');
    }
  return out;
}
