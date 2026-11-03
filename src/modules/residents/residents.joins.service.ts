import { Op, type Transaction } from 'sequelize';
import { JoinRequest, Resident, ResidentDocument, Society, Tenancy, Unit, sequelize } from '../../models';
import { now, addDays } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, NotFoundError, RateLimitedError, UnprocessableError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import { systemCtx, type Ctx } from '../../types/context';
import { settings } from '../society-setup/society-setup.public';
import { units } from '../society-setup/society-setup.public';
import { isJobAllowed } from '../societies/societies.guard';
import { AUDIT2, ENTITY2, JOIN_OWNER_WAIT_DAYS, OWNERSHIP_PROOF_TYPES } from './residents.part2.constants';
import { FEATURE, LIVE_TENANCY, OPEN_JOIN_STATUSES, isIdDoc } from './residents.constants';
import { attachDocuments, type DocInput } from './residents.documents.service';
import { createLink, lockLinks, liveTenancyOf } from './residents.links.service';
import { adminRoom, emitAfterCommit, notifyAfterCommit, recipients } from './residents.notify';
import { touchReports } from './residents.ports';
import { findOrCreateResident } from './residents.part2.people';
import { part2Ports, type ApprovalRef } from './residents.part2.ports';
import { assertTenancyDates, callerResident, primaryOwnerOf } from './residents.part2.shared';
import {
  assertFeatureFor,
  invalidState,
  isMinor,
  maskMobile,
  rule,
  societyToday,
  staleVersion,
} from './residents.shared';
import { emitToUser } from '../../lib/realtime';
import './residents.part2.templates';

/** Join requests (sections 5.3, 6.3 and 8.14). */
const notFound = () => new NotFoundError('JOIN_REQUEST_NOT_FOUND', 'Join request not found');
const JOINABLE = ['TRIAL', 'ACTIVE', 'PAST_DUE'];
const HOME = ['FLAT', 'SHOP', 'OFFICE'];
const CODE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const notJoinable = () =>
  new UnprocessableError('SOCIETY_NOT_JOINABLE', 'This society is not accepting join requests');

/** The society behind a code, checked for status and plan (`SOCIETY_NOT_JOINABLE`, `SOCIETY_CODE_NOT_FOUND`). */
async function joinableSociety(code: string): Promise<Society> {
  const s = CODE_RE.test(code) ? await Society.findOne({ where: { slug: code } }) : null;
  if (!s) throw new NotFoundError('SOCIETY_CODE_NOT_FOUND', 'No society has this code');
  if (!JOINABLE.includes(s.status)) throw notJoinable();
  try {
    await assertFeatureFor(s.id!, FEATURE.invitations);
  } catch {
    throw notJoinable();
  }
  return s;
}

export async function lookupSociety(code: string) {
  const s = await joinableSociety(code);
  return { societyId: s.id!, name: s.name, city: s.city, joinable: true as const };
}

export async function searchUnits(code: string, q: string) {
  const s = await joinableSociety(code);
  const like = `${q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
  const rows = await Unit.findAll({
    where: { societyId: s.id!, status: 'ACTIVE', label: { [Op.like]: like } },
    attributes: ['id', 'label'],
    order: [['label', 'ASC']],
    limit: 20,
  });
  return rows.map(u => ({ unitId: u.id!, label: u.label }));
}

// ------------------------------------------------------------------ output
async function dtos(societyId: number | null, rows: JoinRequest[], o: { masked: boolean }) {
  if (!rows.length) return [];
  const unitRows = await Unit.findAll({
    where: { id: { [Op.in]: [...new Set(rows.map(r => r.unitId))] } },
    attributes: ['id', 'label'],
  });
  const labels = new Map(unitRows.map(u => [u.id!, u.label]));
  const docs = await ResidentDocument.findAll({
    where: { refType: 'join_request', refId: { [Op.in]: rows.map(r => r.id!) } },
    order: [['id', 'ASC']],
  });
  void societyId;
  return rows.map(r => {
    const mine = docs.filter(d => d.refId === r.id);
    return {
      id: r.id!,
      societyId: r.societyId,
      requesterName: r.name,
      name: r.name,
      mobile: o.masked ? maskMobile(r.mobile) : r.mobile,
      relation: r.relation,
      familyRelation: r.familyRelation,
      householdOf: r.householdOf,
      unitId: r.unitId,
      unitLabel: labels.get(r.unitId) ?? '',
      status: r.status,
      message: r.message,
      agreementStart: r.agreementStart,
      agreementEnd: r.agreementEnd,
      ownerDecisionNote: r.ownerDecisionNote,
      decisionReason: r.decisionReason,
      createdAt: r.createdAt!.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      documentsReceived: mine.length,
      approvalRequestId: r.approvalRequestId,
      version: r.version,
      documents: mine.map(d => ({
        id: d.id!,
        docType: d.docType,
        title: d.title,
        verificationStatus: d.verificationStatus,
        uploadedAt: d.createdAt!.toISOString(),
      })),
    };
  });
}

// ------------------------------------------------------------------ submit (BR-09-22 to 25)
export interface JoinInput {
  societyCode: string;
  unitId: number;
  relation: 'OWNER' | 'CO_OWNER' | 'TENANT' | 'FAMILY' | 'CARETAKER';
  familyRelation?: string;
  householdOf?: 'OWNER' | 'TENANT';
  agreementStart?: string;
  agreementEnd?: string;
  email?: string | null;
  dateOfBirth?: string | null;
  message?: string | null;
  fileIds: DocInput[];
}

const relationLabel = (r: string) =>
  ({
    OWNER: 'owner',
    CO_OWNER: 'co-owner',
    TENANT: 'tenant',
    FAMILY: 'family member',
    CARETAKER: 'caretaker',
  })[r] ?? r;

/** Moves a request to PENDING_ADMIN and raises the module 14 request (BR-09-25). Caller holds the row lock. */
async function enterPendingAdmin(
  ctx: Ctx,
  jr: JoinRequest,
  unitLabel: string,
  t: Transaction,
): Promise<void> {
  jr.status = 'PENDING_ADMIN';
  jr.version += 1;
  await jr.save({ transaction: t });
  if (!(await settings.get(jr.societyId, 'residents.joinRequestNeedsApproval'))) {
    await approveJoin(systemCtx('join-auto'), jr.societyId, jr.id!, t);
  } else {
    const r = await part2Ports().approvals.request(
      systemCtx(ctx.requestId),
      {
        type: 'JOIN_REQUEST',
        societyId: jr.societyId,
        entityType: 'join_request',
        entityId: jr.id!,
        title: `Join request: ${jr.name} (${relationLabel(jr.relation)}) for ${unitLabel}`,
        payload: { unitId: jr.unitId, relation: jr.relation, name: jr.name },
        unitId: jr.unitId,
      },
      t,
    );
    await JoinRequest.update({ approvalRequestId: r.id }, { where: { id: jr.id! }, transaction: t });
    if (r.autoApproved) return;
  }
  const fresh = await JoinRequest.findByPk(jr.id!, { transaction: t });
  if (fresh?.status !== 'PENDING_ADMIN') return;
  notifyAfterCommit(t, 'residents.join_request_received', jr.societyId, recipients.admins, {
    name: jr.name,
    relation: relationLabel(jr.relation),
    unitLabel,
    link: '/residents/join-requests',
  });
  emitAfterCommit(t, adminRoom(jr.societyId), 'residents.requests.changed', {
    kind: 'JOIN',
    id: jr.id!,
    status: 'PENDING_ADMIN',
  });
}

export async function submitJoinRequest(ctx: Ctx, input: JoinInput) {
  const user = ctx.user!;
  if (!user.name || !user.mobile)
    throw new UnprocessableError('PROFILE_INCOMPLETE', 'Add your name to your profile first');
  const userName = user.name;
  const userMobile = user.mobile;
  const society = await joinableSociety(input.societyCode);
  const societyId = society.id!;
  return sequelize.transaction(async t => {
    const today = await societyToday(societyId);
    const day = await JoinRequest.count({
      where: { userId: user.id, createdAt: { [Op.gte]: addDays(now(), -1) } },
      transaction: t,
    });
    if (day >= 5) throw new RateLimitedError(3600);
    const unit = await units.lockActive(societyId, input.unitId, t);
    const links = await lockLinks(societyId, unit.id, t);
    if (input.relation !== 'OWNER' && input.relation !== 'CO_OWNER' && !HOME.includes(unit.unitType))
      throw rule(422, 'UNIT_NOT_RESIDENTIAL', 'This unit is not a home or an office', 'unitId');
    if (['OWNER', 'CO_OWNER', 'TENANT'].includes(input.relation) && isMinor(input.dateOfBirth ?? null, today))
      throw rule(422, 'MINOR_NOT_ALLOWED', 'You must be 18 or older for this relation', 'dateOfBirth');
    const pending = await JoinRequest.count({
      where: { societyId, userId: user.id, status: { [Op.in]: [...OPEN_JOIN_STATUSES] } },
      transaction: t,
    });
    if (pending) throw rule(409, 'JOIN_REQUEST_EXISTS', 'You already have a request waiting in this society');
    const mine = await Resident.findAll({
      where: { societyId, [Op.or]: [{ userId: user.id }, { mobile: userMobile }] },
      transaction: t,
    });
    if (links.some(l => l.toDate === null && mine.some(r => r.id === l.residentId)))
      throw rule(409, 'ALREADY_LINKED', 'You are already linked to this flat', 'unitId');
    const hasOwner = links.some(l => l.toDate === null && l.relation === 'OWNER');
    if (input.relation === 'OWNER' && hasOwner)
      throw rule(
        409,
        'OWNER_ALREADY_EXISTS',
        'The flat already has an owner. Ask to join as a co-owner.',
        'relation',
      );
    if (input.relation === 'CO_OWNER' && !hasOwner)
      throw rule(422, 'OWNER_REQUIRED', 'A co-owner needs an owner on the flat first', 'relation');
    let tenant: Resident | null = null;
    if (input.relation === 'TENANT') {
      if (!hasOwner) throw rule(422, 'OWNER_REQUIRED', 'The flat needs an owner before a tenant', 'relation');
      await assertTenancyDates(societyId, input.agreementStart!, input.agreementEnd!);
      if (
        !(await settings.get(societyId, 'residents.allowMultipleTenancies')) &&
        (await liveTenancyOf(societyId, unit.id, t))
      )
        throw rule(409, 'TENANCY_ALREADY_ACTIVE', 'The flat already has a live tenancy', 'relation');
    }
    if (input.householdOf === 'TENANT') {
      const tn = await liveTenancyOf(societyId, unit.id, t);
      if (!tn) throw rule(422, 'NO_LIVE_TENANCY', 'The flat has no live tenancy', 'householdOf');
      tenant = await Resident.findByPk(tn.tenantResidentId, { transaction: t });
    }
    const types = input.fileIds.map(f => f.docType as string);
    const missing =
      !types.some(isIdDoc) ||
      (input.relation === 'TENANT' && !types.includes('RENT_AGREEMENT')) ||
      ((input.relation === 'OWNER' || input.relation === 'CO_OWNER') &&
        !types.some(x => (OWNERSHIP_PROOF_TYPES as readonly string[]).includes(x)));
    if (missing)
      throw rule(
        422,
        'DOCUMENTS_REQUIRED',
        'Attach an ID document and the proof for your relation (rent agreement or ownership paper)',
        'fileIds',
      );
    // the confirmer (BR-09-24): primary owner, or the tenant of a tenant household
    let confirmer: Resident | null = null;
    if (['TENANT', 'FAMILY', 'CARETAKER'].includes(input.relation)) {
      if (input.householdOf === 'TENANT') confirmer = tenant;
      else {
        const p = primaryOwnerOf(links);
        confirmer = p ? await Resident.findByPk(p.residentId, { transaction: t }) : null;
      }
      if (!confirmer?.userId || confirmer.userId === user.id) confirmer = null;
    }
    const days = (await settings.get(societyId, 'residents.joinRequestExpiryDays')) as number;
    const jr = await JoinRequest.create(
      {
        societyId,
        userId: user.id,
        unitId: unit.id,
        relation: input.relation,
        familyRelation: input.relation === 'FAMILY' ? (input.familyRelation ?? null) : null,
        householdOf:
          input.relation === 'FAMILY' || input.relation === 'CARETAKER' ? (input.householdOf ?? null) : null,
        name: userName,
        mobile: userMobile,
        email: input.email ?? user.email ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        message: input.message ?? null,
        agreementStart: input.relation === 'TENANT' ? input.agreementStart! : null,
        agreementEnd: input.relation === 'TENANT' ? input.agreementEnd! : null,
        status: confirmer ? 'PENDING_OWNER' : 'PENDING_ADMIN',
        confirmerResidentId: confirmer?.id ?? null,
        confirmerDecidedAt: null,
        ownerDecisionNote: null,
        approvalRequestId: null,
        decidedAt: null,
        decisionReason: null,
        residentId: null,
        expiresAt: addDays(now(), days),
        version: 1,
        createdBy: user.id,
        updatedBy: user.id,
      },
      { transaction: t },
    );
    await attachDocuments(ctx, societyId, t, {
      residentId: null,
      unitId: unit.id,
      refType: 'join_request',
      refId: jr.id!,
      items: input.fileIds,
      uploaderUserId: user.id,
    });
    await audit(
      ctx,
      {
        action: AUDIT2.joinSubmitted,
        entityType: ENTITY2.joinRequest,
        entityId: jr.id!,
        entityLabel: unit.label,
        societyId,
        after: { unitId: unit.id, relation: jr.relation, status: jr.status },
      },
      t,
    );
    if (confirmer) {
      const cu = confirmer.userId!;
      notifyAfterCommit(t, 'residents.join_request_confirm', societyId, async () => [cu], {
        name: jr.name,
        relationLabel: relationLabel(jr.relation),
        unitLabel: unit.label,
        link: '/me/household/join-requests',
      });
      emitAfterCommit(t, adminRoom(societyId), 'residents.requests.changed', {
        kind: 'JOIN',
        id: jr.id!,
        status: jr.status,
      });
    } else await enterPendingAdmin(ctx, jr, unit.label, t);
    const fresh = (await JoinRequest.findByPk(jr.id!, { transaction: t }))!;
    touchReports(t, societyId);
    return {
      id: fresh.id!,
      societyName: society.name,
      unitLabel: unit.label,
      relation: fresh.relation,
      status: fresh.status,
      expiresAt: fresh.expiresAt.toISOString(),
      message: confirmer ? `Request sent to the owner of ${unit.label}` : 'Request sent to the committee',
    };
  });
}

// ------------------------------------------------------------------ approval handlers (BR-09-25)
async function lockJoin(societyId: number, id: number, t: Transaction) {
  return JoinRequest.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
}

/** Completion of an approved request; also used when the setting turns module 14 off. Idempotent. */
async function approveJoin(ctx: Ctx, societyId: number, id: number, t: Transaction): Promise<void> {
  const jr = await lockJoin(societyId, id, t);
  if (!jr || jr.status !== 'PENDING_ADMIN') return;
  const unit = await units.lockActive(societyId, jr.unitId, t);
  const today = await societyToday(societyId);
  if (['OWNER', 'CO_OWNER', 'TENANT'].includes(jr.relation) && isMinor(jr.dateOfBirth, today))
    throw rule(422, 'MINOR_NOT_ALLOWED', 'You must be 18 or older for this relation', 'dateOfBirth');
  let resident = await Resident.findOne({
    where: { societyId, userId: jr.userId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!resident) {
    const byMobile = await Resident.findOne({
      where: { societyId, mobile: jr.mobile },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (byMobile && byMobile.userId !== null && byMobile.userId !== jr.userId)
      throw new AppError(409, 'ALREADY_LINKED', 'This mobile number belongs to another login');
    resident = (
      await findOrCreateResident(
        ctx,
        societyId,
        { name: jr.name, mobile: jr.mobile, email: jr.email, dateOfBirth: jr.dateOfBirth },
        'JOIN_REQUEST',
        t,
      )
    ).resident;
  }
  if (resident.userId !== jr.userId) {
    resident.userId = jr.userId;
    resident.version += 1;
    await resident.save({ transaction: t });
  }
  const links = await lockLinks(societyId, unit.id, t);
  if (links.some(l => l.residentId === resident!.id && l.toDate === null))
    throw rule(409, 'ALREADY_LINKED', 'This person is already linked to the flat', 'unitId');
  const sourceOpts = { already: unit } as const;
  if (jr.relation === 'TENANT') {
    const owner = primaryOwnerOf(links);
    if (!owner) throw rule(422, 'OWNER_REQUIRED', 'The flat needs an owner before a tenant', 'relation');
    await assertTenancyDates(societyId, jr.agreementStart!, jr.agreementEnd!);
    if (
      !(await settings.get(societyId, 'residents.allowMultipleTenancies')) &&
      (await Tenancy.count({
        where: { societyId, unitId: unit.id, status: { [Op.in]: [...LIVE_TENANCY] } },
        transaction: t,
      }))
    )
      throw rule(409, 'TENANCY_ALREADY_ACTIVE', 'The flat already has a live tenancy', 'relation');
    const moved = jr.agreementStart! <= today;
    const tn = await Tenancy.create(
      {
        societyId,
        unitId: unit.id,
        tenantResidentId: resident.id!,
        landlordResidentId: owner.residentId,
        status: moved ? 'ACTIVE' : 'APPROVED',
        agreementType: 'LEAVE_AND_LICENCE',
        agreementStart: jr.agreementStart!,
        agreementEnd: jr.agreementEnd!,
        agreementRegistrationNo: null,
        monthlyRentPaise: 0,
        securityDepositPaise: 0,
        maintenancePayer: 'OWNER',
        occupantCount: 1,
        householdJson: null,
        inviteTenant: false,
        policeVerificationStatus: 'NOT_SUBMITTED',
        policeVerificationRef: null,
        policeVerifiedOn: null,
        policeVerificationNote: null,
        policeReminderSentAt: null,
        source: 'JOIN_REQUEST',
        submittedAt: null,
        submittedBy: null,
        decidedBy: ctx.user?.id ?? null,
        decidedAt: now(),
        decisionReason: null,
        moveInDate: moved ? jr.agreementStart! : null,
        endedOn: null,
        endReason: null,
        endNote: null,
        renewalCount: 0,
        previousAgreementEnd: null,
        lastExpiryReminderDays: null,
        overstayAlertedAt: null,
        version: 1,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
    await createLink(
      ctx,
      societyId,
      {
        residentId: resident.id!,
        unitId: unit.id,
        relation: 'TENANT',
        tenancyId: tn.id!,
        isResiding: moved,
        canLogin: true,
        fromDate: jr.agreementStart!,
        source: 'JOIN_REQUEST',
      },
      t,
      { internal: true, ...sourceOpts },
    );
  } else {
    await createLink(
      ctx,
      societyId,
      {
        residentId: resident.id!,
        unitId: unit.id,
        relation: jr.relation as 'OWNER',
        familyRelation: jr.familyRelation as never,
        householdOf: jr.householdOf,
        canLogin: true,
        fromDate: today,
        source: 'JOIN_REQUEST',
      },
      t,
      sourceOpts,
    );
  }
  await ResidentDocument.update(
    { residentId: resident.id! },
    { where: { societyId, refType: 'join_request', refId: jr.id! }, transaction: t },
  );
  jr.status = 'APPROVED';
  jr.residentId = resident.id!;
  jr.decidedAt = now();
  jr.version += 1;
  jr.updatedBy = ctx.user?.id ?? null;
  await jr.save({ transaction: t });
  await audit(
    ctx,
    {
      action: AUDIT2.joinApproved,
      entityType: ENTITY2.joinRequest,
      entityId: jr.id!,
      societyId,
      after: { status: 'APPROVED', residentId: resident.id, relation: jr.relation },
    },
    t,
  );
  const uid = jr.userId;
  notifyAfterCommit(t, 'residents.join_request_approved', societyId, async () => [uid], {
    unitLabel: unit.label,
    link: '/home',
  });
  emitAfterCommit(t, adminRoom(societyId), 'residents.requests.changed', {
    kind: 'JOIN',
    id: jr.id!,
    status: 'APPROVED',
  });
  t.afterCommit(() => emitToUser(uid, 'residents.join_request.updated', { id: jr.id!, status: 'APPROVED' }));
  touchReports(t, societyId);
}

async function closeJoin(
  ctx: Ctx,
  jr: JoinRequest,
  status: 'REJECTED' | 'EXPIRED' | 'WITHDRAWN',
  action: string,
  reason: string | null,
  t: Transaction,
  notifyTemplate: string | null,
): Promise<void> {
  jr.status = status;
  jr.decidedAt = now();
  jr.decisionReason = reason;
  jr.version += 1;
  jr.updatedBy = ctx.user?.id ?? null;
  await jr.save({ transaction: t });
  await audit(
    ctx,
    {
      action,
      entityType: ENTITY2.joinRequest,
      entityId: jr.id!,
      societyId: jr.societyId,
      after: { status },
      reason,
    },
    t,
  );
  const unit = await Unit.findByPk(jr.unitId, { attributes: ['label'], transaction: t });
  const society = await Society.findByPk(jr.societyId, { attributes: ['name'], transaction: t });
  const uid = jr.userId;
  if (notifyTemplate)
    notifyAfterCommit(t, notifyTemplate, jr.societyId, async () => [uid], {
      unitLabel: unit?.label ?? '',
      societyName: society?.name ?? '',
      reason,
      link: '/home',
    });
  emitAfterCommit(t, adminRoom(jr.societyId), 'residents.requests.changed', {
    kind: 'JOIN',
    id: jr.id!,
    status,
  });
  t.afterCommit(() => emitToUser(uid, 'residents.join_request.updated', { id: jr.id!, status }));
}

export const joinRequestHandlers = {
  onApproved: async (ctx: Ctx, req: ApprovalRef, t: Transaction) =>
    approveJoin(ctx, req.societyId, req.entityId, t),
  onRejected: async (ctx: Ctx, req: ApprovalRef, t: Transaction) => {
    const jr = await lockJoin(req.societyId, req.entityId, t);
    if (!jr || jr.status !== 'PENDING_ADMIN') return;
    await closeJoin(
      ctx,
      jr,
      'REJECTED',
      AUDIT2.joinRejected,
      req.reason ?? null,
      t,
      'residents.join_request_rejected',
    );
  },
  describe: async (societyId: number, entityId: number) => {
    const jr = await JoinRequest.findOne({ where: { id: entityId, societyId } });
    const unit = jr ? await Unit.findByPk(jr.unitId, { attributes: ['label'] }) : null;
    return {
      title: `Join request: ${jr?.name ?? ''}`,
      lines: [
        { label: 'Flat', value: unit?.label ?? '' },
        { label: 'Relation', value: jr ? relationLabel(jr.relation) : '' },
      ],
    };
  },
};

// ------------------------------------------------------------------ requester side
export async function listMine(ctx: Ctx) {
  const rows = await JoinRequest.findAll({
    where: { userId: ctx.user!.id },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: 20,
  });
  const names = new Map(
    (
      await Society.findAll({
        where: { id: { [Op.in]: [...new Set(rows.map(r => r.societyId))] } },
        attributes: ['id', 'name'],
      })
    ).map(s => [s.id!, s.name]),
  );
  const list = await dtos(null, rows, { masked: false });
  return list.map(d => ({ ...d, societyName: names.get(d.societyId) ?? '' }));
}

export async function withdraw(ctx: Ctx, id: number, input: { version: number }) {
  return sequelize.transaction(async t => {
    const jr = await JoinRequest.findOne({
      where: { id, userId: ctx.user!.id },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!jr) throw notFound();
    if (jr.version !== input.version) throw staleVersion('This request');
    if (!(OPEN_JOIN_STATUSES as readonly string[]).includes(jr.status))
      throw invalidState('This request is closed');
    if (jr.approvalRequestId)
      await part2Ports().approvals.cancel(ctx, jr.approvalRequestId, 'Withdrawn by the requester', t);
    await closeJoin(ctx, jr, 'WITHDRAWN', AUDIT2.joinWithdrawn, null, t, null);
    return { id: jr.id!, status: jr.status, version: jr.version };
  });
}

// ------------------------------------------------------------------ confirmer side (BR-09-24)
export async function listForConfirmer(ctx: Ctx, societyId: number) {
  const me = await callerResident(ctx, societyId);
  const rows = await JoinRequest.findAll({
    where: { societyId, confirmerResidentId: me.id!, status: 'PENDING_OWNER' },
    order: [['createdAt', 'ASC']],
  });
  return dtos(societyId, rows, { masked: true });
}

async function myConfirmable(ctx: Ctx, societyId: number, id: number, t: Transaction) {
  const me = await callerResident(ctx, societyId, t);
  const jr = await JoinRequest.findOne({
    where: { id, societyId, confirmerResidentId: me.id! },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!jr) throw notFound();
  return jr;
}

export async function confirm(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { note?: string; version: number },
) {
  return sequelize.transaction(async t => {
    const jr = await myConfirmable(ctx, societyId, id, t);
    if (jr.version !== input.version) throw staleVersion('This request');
    if (jr.status !== 'PENDING_OWNER') throw invalidState('This request is not waiting for you');
    jr.confirmerDecidedAt = now();
    jr.ownerDecisionNote = input.note ?? null;
    await audit(
      ctx,
      { action: AUDIT2.joinOwnerConfirmed, entityType: ENTITY2.joinRequest, entityId: jr.id!, societyId },
      t,
    );
    const unit = await Unit.findByPk(jr.unitId, { attributes: ['label'], transaction: t });
    await enterPendingAdmin(ctx, jr, unit?.label ?? '', t);
    const fresh = (await JoinRequest.findByPk(jr.id!, { transaction: t }))!;
    return { id: fresh.id!, status: fresh.status, version: fresh.version };
  });
}

export async function decline(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { reason: string; version: number },
) {
  return sequelize.transaction(async t => {
    const jr = await myConfirmable(ctx, societyId, id, t);
    if (jr.version !== input.version) throw staleVersion('This request');
    if (jr.status !== 'PENDING_OWNER') throw invalidState('This request is not waiting for you');
    jr.confirmerDecidedAt = now();
    jr.ownerDecisionNote = input.reason;
    await closeJoin(
      ctx,
      jr,
      'REJECTED',
      AUDIT2.joinOwnerDeclined,
      input.reason,
      t,
      'residents.join_request_rejected',
    );
    return { id: jr.id!, status: jr.status, version: jr.version };
  });
}

// ------------------------------------------------------------------ admin side
export interface JoinListQuery {
  page: number;
  limit: number;
  status?: string[];
  unitId?: number;
  relation?: string;
  sortOrder?: 'asc' | 'desc';
}

export async function listJoinRequests(ctx: Ctx, societyId: number, q: JoinListQuery) {
  const where: Record<string, unknown> = {
    societyId,
    status: { [Op.in]: q.status?.length ? q.status : ['PENDING_OWNER', 'PENDING_ADMIN'] },
  };
  if (q.unitId) where.unitId = q.unitId;
  if (q.relation) where.relation = q.relation;
  const { rows, count } = await JoinRequest.findAndCountAll({
    where,
    order: [
      ['createdAt', (q.sortOrder ?? 'asc').toUpperCase()],
      ['id', 'ASC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return {
    data: await dtos(societyId, rows, { masked: !ctx.permissions?.has('residents.contacts.view') }),
    pagination: pageMeta(q.page, q.limit, count),
  };
}

export async function getJoinRequest(ctx: Ctx, societyId: number, id: number) {
  const jr = await JoinRequest.findOne({ where: { id, societyId } });
  if (!jr) throw notFound();
  const [d] = await dtos(societyId, [jr], { masked: !ctx.permissions?.has('residents.contacts.view') });
  const confirmer = jr.confirmerResidentId ? await Resident.findByPk(jr.confirmerResidentId) : null;
  return {
    ...d!,
    confirmerName: confirmer?.name ?? null,
    confirmerDecidedAt: jr.confirmerDecidedAt?.toISOString() ?? null,
  };
}

// ------------------------------------------------------------------ jobs (9.1 `residents:join-requests`)
/** Escalates unanswered owner confirmations after 3 days and expires old requests. Batches of 500; idempotent. */
export async function runJoinRequestJob(): Promise<{ escalated: number; expired: number }> {
  const ctx = systemCtx('join-requests');
  let escalated = 0;
  let expired = 0;
  const societyOk = new Map<number, boolean>();
  const allowed = async (id: number) => {
    if (!societyOk.has(id)) {
      const s = await Society.findByPk(id, { attributes: ['status'] });
      societyOk.set(id, !!s && isJobAllowed(s.status, 'normal') && s.status !== 'CLOSED');
    }
    return societyOk.get(id)!;
  };
  const cutoff = addDays(now(), -JOIN_OWNER_WAIT_DAYS);
  const stale = await JoinRequest.findAll({
    where: { status: 'PENDING_OWNER', createdAt: { [Op.lte]: cutoff }, expiresAt: { [Op.gt]: now() } },
    attributes: ['id', 'societyId'],
    limit: 500,
  });
  for (const s of stale) {
    if (!(await allowed(s.societyId))) continue;
    await sequelize.transaction(async t => {
      const jr = await lockJoin(s.societyId, s.id!, t);
      if (!jr || jr.status !== 'PENDING_OWNER') return;
      jr.ownerDecisionNote = 'No response in 3 days';
      await audit(
        ctx,
        {
          action: AUDIT2.joinEscalated,
          entityType: ENTITY2.joinRequest,
          entityId: jr.id!,
          societyId: jr.societyId,
        },
        t,
      );
      const unit = await Unit.findByPk(jr.unitId, { attributes: ['label'], transaction: t });
      await enterPendingAdmin(ctx, jr, unit?.label ?? '', t);
      escalated += 1;
    });
  }
  const old = await JoinRequest.findAll({
    where: { status: { [Op.in]: [...OPEN_JOIN_STATUSES] }, expiresAt: { [Op.lte]: now() } },
    attributes: ['id', 'societyId'],
    limit: 500,
  });
  for (const s of old) {
    if (!(await allowed(s.societyId))) continue;
    await sequelize.transaction(async t => {
      const jr = await lockJoin(s.societyId, s.id!, t);
      if (!jr || !(OPEN_JOIN_STATUSES as readonly string[]).includes(jr.status) || jr.expiresAt > now())
        return;
      if (jr.approvalRequestId)
        await part2Ports().approvals.cancel(ctx, jr.approvalRequestId, 'The join request expired', t);
      await closeJoin(
        ctx,
        jr,
        'EXPIRED',
        AUDIT2.joinExpired,
        'The request expired',
        t,
        'residents.join_request_rejected',
      );
      expired += 1;
    });
  }
  return { escalated, expired };
}
