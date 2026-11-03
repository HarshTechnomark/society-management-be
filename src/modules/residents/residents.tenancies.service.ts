import { Op, type Transaction, type WhereOptions } from 'sequelize';
import {
  MoveRequest,
  Resident,
  ResidentDocument,
  Tenancy,
  Unit,
  UnitResident,
  sequelize,
} from '../../models';
import type { TenancyStatus } from '../../models/tenancy.model';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, NotFoundError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { assertMakerChecker } from '../access-control/access-control.public';
import { settings, units } from '../society-setup/society-setup.public';
import { AUDIT2, ENTITY2, TENANCY_DOC_TYPES } from './residents.part2.constants';
import { LIVE_TENANCY, OPEN_MOVE_STATUSES } from './residents.constants';
import { attachDocuments, docDto, type DocInput } from './residents.documents.service';
import { inviteResidentTx } from './residents.invite.service';
import { createLink, endLinks, lockLinks } from './residents.links.service';
import { emitAfterCommit, adminRoom, notifyAfterCommit, recipients } from './residents.notify';
import { touchReports } from './residents.ports';
import { findOrCreateResident } from './residents.part2.people';
import {
  assertTenancyDates,
  canSeeContacts,
  daysBetween,
  inSavepoint,
  ownerActionOnly,
  primaryOwnerOf,
  userIdsOf,
} from './residents.part2.shared';
import {
  addDaysYmd,
  assertFeatureFor,
  featureOn,
  invalidState,
  isMinor,
  maskMobile,
  residentNotFound,
  rule,
  societyToday,
  staleVersion,
  unitNotFound,
} from './residents.shared';
import './residents.part2.templates';

/** Tenancies (sections 5.4, 6.4 and 8.13). Lock order of BR-09-19: unit, unit links, tenancy, request row. */
const tenancyNotFound = () => new NotFoundError('TENANCY_NOT_FOUND', 'Tenancy not found');
const live = { [Op.in]: [...LIVE_TENANCY] };

export interface HouseholdEntry {
  name: string;
  familyRelation?: string;
  relation?: 'CARETAKER';
  mobile?: string | null;
  dateOfBirth?: string | null;
  canLogin?: boolean;
}
export type TenantInput =
  | { residentId: number }
  | { name: string; mobile: string; email?: string | null; dateOfBirth?: string | null };
export interface TenancyFields {
  agreementType?: string;
  agreementStart: string;
  agreementEnd: string;
  agreementRegistrationNo?: string | null;
  monthlyRentPaise?: number;
  securityDepositPaise?: number;
  maintenancePayer?: 'OWNER' | 'TENANT';
  occupantCount?: number;
  inviteTenant?: boolean;
  household?: HouseholdEntry[];
}
export interface CreateTenancyInput extends TenancyFields {
  unitId: number;
  tenant: TenantInput;
  fileIds?: DocInput[];
}

// ------------------------------------------------------------------ output
export interface TenancyDto {
  id: number;
  status: string;
  unit: { id: number; label: string };
  tenant: { residentId: number; name: string; mobile: string | null };
  landlord: { residentId: number; name: string };
  agreementType: string;
  agreementStart: string;
  agreementEnd: string;
  agreementRegistrationNo: string | null;
  maintenancePayer: string;
  monthlyRentPaise: number | null;
  securityDepositPaise: number | null;
  occupantCount: number;
  inviteTenant: boolean;
  household: HouseholdEntry[];
  policeVerificationStatus: string;
  policeVerificationRef: string | null;
  policeVerifiedOn: string | null;
  policeVerificationNote: string | null;
  source: string;
  submittedAt: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  moveInDate: string | null;
  endedOn: string | null;
  endReason: string | null;
  renewalCount: number;
  previousAgreementEnd: string | null;
  daysToExpiry: number | null;
  createdAt: string;
  version: number;
}

interface DtoOptions {
  /** Contacts are shown in full (own household, or `residents.contacts.view`). */
  unmasked: boolean;
  /** Rent is visible to owner, tenant and `residents.people.view` (section 7.3). */
  showRent: (unitId: number) => boolean;
  today: string;
}

export async function tenancyDtos(rows: Tenancy[], o: DtoOptions): Promise<TenancyDto[]> {
  if (!rows.length) return [];
  const unitRows = await Unit.findAll({
    where: { id: { [Op.in]: [...new Set(rows.map(r => r.unitId))] } },
    attributes: ['id', 'label'],
  });
  const labels = new Map(unitRows.map(u => [u.id!, u.label]));
  const ids = [...new Set(rows.flatMap(r => [r.tenantResidentId, r.landlordResidentId]))];
  const people = new Map(
    (await Resident.findAll({ where: { id: { [Op.in]: ids } }, paranoid: false })).map(r => [r.id!, r]),
  );
  return rows.map(r => {
    const tenant = people.get(r.tenantResidentId);
    const landlord = people.get(r.landlordResidentId);
    const rent = o.showRent(r.unitId);
    return {
      id: r.id!,
      status: r.status,
      unit: { id: r.unitId, label: labels.get(r.unitId) ?? '' },
      tenant: {
        residentId: r.tenantResidentId,
        name: tenant?.name ?? '',
        mobile: o.unmasked ? (tenant?.mobile ?? null) : maskMobile(tenant?.mobile ?? null),
      },
      landlord: { residentId: r.landlordResidentId, name: landlord?.name ?? '' },
      agreementType: r.agreementType,
      agreementStart: r.agreementStart,
      agreementEnd: r.agreementEnd,
      agreementRegistrationNo: r.agreementRegistrationNo,
      maintenancePayer: r.maintenancePayer,
      monthlyRentPaise: rent ? Number(r.monthlyRentPaise) : null,
      securityDepositPaise: rent ? Number(r.securityDepositPaise) : null,
      occupantCount: r.occupantCount,
      inviteTenant: Boolean(r.inviteTenant),
      household: (r.householdJson as HouseholdEntry[] | null) ?? [],
      policeVerificationStatus: r.policeVerificationStatus,
      policeVerificationRef: r.policeVerificationRef,
      policeVerifiedOn: r.policeVerifiedOn,
      policeVerificationNote: r.policeVerificationNote,
      source: r.source,
      submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      decisionReason: r.decisionReason,
      moveInDate: r.moveInDate,
      endedOn: r.endedOn,
      endReason: r.endReason,
      renewalCount: r.renewalCount,
      previousAgreementEnd: r.previousAgreementEnd,
      daysToExpiry:
        r.status === 'ACTIVE' || r.status === 'EXPIRED_OVERSTAY'
          ? daysBetween(o.today, r.agreementEnd)
          : null,
      createdAt: r.createdAt!.toISOString(),
      version: r.version,
    };
  });
}

async function adminDtos(ctx: Ctx, societyId: number, rows: Tenancy[]): Promise<TenancyDto[]> {
  return tenancyDtos(rows, {
    unmasked: canSeeContacts(ctx),
    showRent: () => true,
    today: await societyToday(societyId),
  });
}

/** `/me` view: the caller's own flats; rent only for owners and tenants (not family members). */
async function mineDtos(ctx: Ctx, societyId: number, rows: Tenancy[]): Promise<TenancyDto[]> {
  const rel = new Map((ctx.unitLinks ?? []).map(l => [l.unitId, l.relation]));
  return tenancyDtos(rows, {
    unmasked: true,
    showRent: unitId => rel.get(unitId) === 'OWNER' || rel.get(unitId) === 'TENANT',
    today: await societyToday(societyId),
  });
}

// ------------------------------------------------------------------ shared steps
async function lockTenancy(societyId: number, id: number, t: Transaction): Promise<Tenancy> {
  const row = await Tenancy.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!row) throw tenancyNotFound();
  return row;
}

/** `/me` routes: a tenancy of one of the caller's flats that the caller (an owner) created. */
async function lockMine(ctx: Ctx, societyId: number, id: number, t: Transaction): Promise<Tenancy> {
  const row = await lockTenancy(societyId, id, t);
  if (!(ctx.unitIds ?? []).includes(row.unitId)) throw tenancyNotFound();
  if ((ctx.unitLinks ?? []).find(l => l.unitId === row.unitId)?.relation !== 'OWNER') throw ownerActionOnly();
  if (row.createdBy !== ctx.user?.id) throw tenancyNotFound();
  return row;
}

function checkVersion(row: { version: number }, version: number): void {
  if (row.version !== version) throw staleVersion('This tenancy');
}

async function bump(row: Tenancy, ctx: Ctx, t: Transaction): Promise<void> {
  row.version += 1;
  row.updatedBy = ctx.user?.id ?? null;
  await row.save({ transaction: t });
}

/** BR-09-28: one live tenancy per unit unless several are allowed. */
async function assertNoOtherLive(societyId: number, unitId: number, exceptId: number | null, t: Transaction) {
  if (await settings.get(societyId, 'residents.allowMultipleTenancies')) return;
  const n = await Tenancy.count({
    where: { societyId, unitId, status: live, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) },
    transaction: t,
  });
  if (n) throw rule(409, 'TENANCY_ALREADY_ACTIVE', 'The flat already has a live tenancy', 'unitId');
}

function checkHousehold(list: HouseholdEntry[] | undefined, today: string): void {
  for (const [i, h] of (list ?? []).entries())
    if (!h.relation && !h.familyRelation)
      throw rule(422, 'VALIDATION_FAILED', 'Say how this person is related', `household.${i}.familyRelation`);
  void today;
}

async function resolveTenant(
  ctx: Ctx,
  societyId: number,
  tenant: TenantInput,
  links: UnitResident[],
  today: string,
  t: Transaction,
): Promise<Resident> {
  let r: Resident;
  if ('residentId' in tenant) {
    const found = await Resident.findOne({
      where: { id: tenant.residentId, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!found) throw residentNotFound();
    r = found;
  } else {
    r = (
      await findOrCreateResident(
        ctx,
        societyId,
        { name: tenant.name, mobile: tenant.mobile, email: tenant.email, dateOfBirth: tenant.dateOfBirth },
        'TENANCY',
        t,
      )
    ).resident;
  }
  if (links.some(l => l.residentId === r.id && l.toDate === null))
    throw rule(409, 'LINK_ALREADY_ACTIVE', 'This person is already linked to the flat', 'tenant');
  if (isMinor(r.dateOfBirth, today))
    throw rule(422, 'MINOR_NOT_ALLOWED', 'A minor cannot be a tenant', 'tenant');
  return r;
}

async function attachTenancyDocs(
  ctx: Ctx,
  societyId: number,
  tenancy: Tenancy,
  items: DocInput[],
  t: Transaction,
): Promise<void> {
  for (const [i, it] of items.entries()) {
    if (!(TENANCY_DOC_TYPES as readonly string[]).includes(it.docType))
      throw rule(
        422,
        'DOCUMENT_TYPE_NOT_ALLOWED',
        'This document type is not allowed here',
        `fileIds.${i}.docType`,
      );
    await attachDocuments(ctx, societyId, t, {
      residentId: tenancy.tenantResidentId,
      unitId: tenancy.unitId,
      refType: 'tenancy',
      refId: tenancy.id!,
      items: [it],
    });
  }
}

function notifyTenancy(
  t: Transaction,
  template: string,
  societyId: number,
  who: (societyId: number) => Promise<number[]>,
  tenancy: Tenancy,
  data: Record<string, unknown>,
  unitLabel: string,
  tenantName: string,
): void {
  notifyAfterCommit(t, template, societyId, who, {
    unitLabel,
    tenantName,
    agreementStart: tenancy.agreementStart,
    agreementEnd: tenancy.agreementEnd,
    link: '/residents/tenancies',
    ...data,
  });
}

const partiesOf = (tenancy: Tenancy) => async (societyId: number) =>
  userIdsOf(societyId, [tenancy.landlordResidentId, tenancy.tenantResidentId]);

async function labelsOf(tenancy: Tenancy, t?: Transaction): Promise<{ unit: string; tenant: string }> {
  const u = await Unit.findByPk(tenancy.unitId, { attributes: ['label'], transaction: t });
  const r = await Resident.findByPk(tenancy.tenantResidentId, {
    attributes: ['name'],
    paranoid: false,
    transaction: t,
  });
  return { unit: u?.label ?? '', tenant: r?.name ?? '' };
}

function changed(t: Transaction, societyId: number, unitId: number, id: number, status: string): void {
  emitAfterCommit(t, adminRoom(societyId), 'residents.requests.changed', { kind: 'TENANCY', id, status });
  emitAfterCommit(t, `unit:${unitId}`, 'household.changed', { unitId });
  touchReports(t, societyId);
}

// ------------------------------------------------------------------ create (8.13 POST)
export async function createTenancy(
  ctx: Ctx,
  societyId: number,
  input: CreateTenancyInput,
  o: { mine?: boolean } = {},
): Promise<TenancyDto> {
  if (o.mine) {
    const rel = (ctx.unitLinks ?? []).find(l => l.unitId === input.unitId);
    if (!(ctx.unitIds ?? []).includes(input.unitId) || !rel) throw unitNotFound();
    if (rel.relation !== 'OWNER') throw ownerActionOnly();
  }
  return sequelize.transaction(async t => {
    const unit = await units.lockActive(societyId, input.unitId, t);
    if (unit.unitType === 'PARKING_ONLY')
      throw rule(
        422,
        'UNIT_NOT_RESIDENTIAL',
        'This unit is a parking space and cannot be rented to a tenant',
        'unitId',
      );
    const today = await societyToday(societyId);
    const links = await lockLinks(societyId, unit.id, t);
    const owner = primaryOwnerOf(links);
    if (!owner) throw rule(422, 'OWNER_REQUIRED', 'The flat needs an owner before a tenant', 'unitId');
    await assertTenancyDates(societyId, input.agreementStart, input.agreementEnd);
    await assertNoOtherLive(societyId, unit.id, null, t);
    checkHousehold(input.household, today);
    const tenant = await resolveTenant(ctx, societyId, input.tenant, links, today, t);
    const row = await Tenancy.create(
      {
        societyId,
        unitId: unit.id,
        tenantResidentId: tenant.id!,
        landlordResidentId: owner.residentId,
        status: 'DRAFT',
        agreementType: input.agreementType ?? 'LEAVE_AND_LICENCE',
        agreementStart: input.agreementStart,
        agreementEnd: input.agreementEnd,
        agreementRegistrationNo: input.agreementRegistrationNo ?? null,
        monthlyRentPaise: input.monthlyRentPaise ?? 0,
        securityDepositPaise: input.securityDepositPaise ?? 0,
        maintenancePayer: input.maintenancePayer ?? 'OWNER',
        occupantCount: input.occupantCount ?? 1,
        householdJson: input.household?.length ? input.household : null,
        inviteTenant: input.inviteTenant ?? true,
        policeVerificationStatus: 'NOT_SUBMITTED',
        policeVerificationRef: null,
        policeVerifiedOn: null,
        policeVerificationNote: null,
        policeReminderSentAt: null,
        source: o.mine ? 'OWNER' : 'ADMIN',
        submittedAt: null,
        submittedBy: null,
        decidedBy: null,
        decidedAt: null,
        decisionReason: null,
        moveInDate: null,
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
    if (input.fileIds?.length) await attachTenancyDocs(ctx, societyId, row, input.fileIds, t);
    await audit(
      ctx,
      {
        action: AUDIT2.tenancyCreated,
        entityType: ENTITY2.tenancy,
        entityId: row.id!,
        entityLabel: unit.label,
        societyId,
        after: {
          unitId: unit.id,
          tenantResidentId: tenant.id,
          agreementStart: row.agreementStart,
          agreementEnd: row.agreementEnd,
          maintenancePayer: row.maintenancePayer,
        },
      },
      t,
    );
    changed(t, societyId, unit.id, row.id!, row.status);
    return (o.mine ? await mineDtos(ctx, societyId, [row]) : await adminDtos(ctx, societyId, [row]))[0]!;
  });
}

// ------------------------------------------------------------------ list and detail
export interface TenancyListQuery {
  page: number;
  limit: number;
  unitId?: number;
  status?: string[];
  policeVerificationStatus?: string;
  expiringWithinDays?: number;
  maintenancePayer?: 'OWNER' | 'TENANT';
  sortBy: 'agreementEnd' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
}

export function tenancyWhere(
  societyId: number,
  q: Omit<TenancyListQuery, 'page' | 'limit' | 'sortBy'>,
  today: string,
) {
  const where: WhereOptions = { societyId };
  const w = where as Record<string, unknown>;
  if (q.unitId) w.unitId = q.unitId;
  if (q.status?.length) w.status = { [Op.in]: q.status };
  if (q.policeVerificationStatus) w.policeVerificationStatus = q.policeVerificationStatus;
  if (q.maintenancePayer) w.maintenancePayer = q.maintenancePayer;
  if (q.expiringWithinDays) {
    w.agreementEnd = { [Op.lte]: addDaysYmd(today, q.expiringWithinDays) };
    if (!q.status?.length) w.status = { [Op.in]: ['ACTIVE', 'EXPIRED_OVERSTAY'] };
  }
  return where;
}

export async function listTenancies(ctx: Ctx, societyId: number, q: TenancyListQuery) {
  const today = await societyToday(societyId);
  const where = tenancyWhere(societyId, q, today);
  const dir = (q.sortOrder ?? (q.sortBy === 'agreementEnd' ? 'asc' : 'desc')).toUpperCase();
  const { rows, count } = await Tenancy.findAndCountAll({
    where,
    order: [
      [q.sortBy, dir],
      ['id', 'ASC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: await adminDtos(ctx, societyId, rows), pagination: pageMeta(q.page, q.limit, count) };
}

async function detail(ctx: Ctx, societyId: number, row: Tenancy, mine: boolean) {
  const dto = (mine ? await mineDtos(ctx, societyId, [row]) : await adminDtos(ctx, societyId, [row]))[0]!;
  const docs = await ResidentDocument.findAll({
    where: { societyId, refType: 'tenancy', refId: row.id! },
    order: [['id', 'ASC']],
  });
  const links = await UnitResident.findAll({
    where: { societyId, tenancyId: row.id! },
    order: [['id', 'ASC']],
  });
  const people = new Map(
    (
      await Resident.findAll({ where: { id: { [Op.in]: links.map(l => l.residentId) } }, paranoid: false })
    ).map(r => [r.id!, r]),
  );
  return {
    ...dto,
    documents: docs.map(docDto),
    links: links.map(l => ({
      linkId: l.id!,
      residentId: l.residentId,
      name: people.get(l.residentId)?.name ?? '',
      relation: l.relation,
      familyRelation: l.familyRelation,
      isResiding: Boolean(l.isResiding),
      fromDate: l.fromDate,
      toDate: l.toDate,
    })),
  };
}

export async function getTenancy(ctx: Ctx, societyId: number, id: number) {
  const row = await Tenancy.findOne({ where: { id, societyId } });
  if (!row) throw tenancyNotFound();
  return detail(ctx, societyId, row, false);
}

export async function listMyTenancies(ctx: Ctx, societyId: number) {
  const unitIds = (ctx.unitIds ?? []).filter(u => {
    const r = (ctx.unitLinks ?? []).find(l => l.unitId === u)?.relation;
    return r === 'OWNER' || r === 'TENANT';
  });
  if (!unitIds.length) return [];
  const rows = await Tenancy.findAll({
    where: { societyId, unitId: { [Op.in]: unitIds } },
    order: [['id', 'DESC']],
  });
  return mineDtos(ctx, societyId, rows);
}

export async function getMyTenancy(ctx: Ctx, societyId: number, id: number) {
  const row = await Tenancy.findOne({ where: { id, societyId } });
  if (!row || !(ctx.unitIds ?? []).includes(row.unitId)) throw tenancyNotFound();
  return detail(ctx, societyId, row, true);
}

// ------------------------------------------------------------------ patch (8.13)
export interface PatchTenancyInput extends Partial<TenancyFields> {
  version: number;
  fileIds?: DocInput[];
}

export async function patchTenancy(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: PatchTenancyInput,
): Promise<TenancyDto> {
  return sequelize.transaction(async t => {
    const row = await lockTenancy(societyId, id, t);
    checkVersion(row, input.version);
    const editable = row.status === 'DRAFT' || row.status === 'PENDING_APPROVAL';
    const always: (keyof PatchTenancyInput)[] = ['maintenancePayer', 'monthlyRentPaise'];
    const touched = (Object.keys(input) as (keyof PatchTenancyInput)[]).filter(
      k => k !== 'version' && input[k] !== undefined,
    );
    const lateOk = row.status === 'APPROVED' || row.status === 'ACTIVE' || row.status === 'EXPIRED_OVERSTAY';
    if (!editable && !(lateOk && touched.every(k => always.includes(k))))
      throw invalidState('This tenancy can no longer be edited');
    const before = { maintenancePayer: row.maintenancePayer, monthlyRentPaise: Number(row.monthlyRentPaise) };
    const start = input.agreementStart ?? row.agreementStart;
    const end = input.agreementEnd ?? row.agreementEnd;
    if (input.agreementStart !== undefined || input.agreementEnd !== undefined)
      await assertTenancyDates(societyId, start, end);
    if (input.household) checkHousehold(input.household, await societyToday(societyId));
    if (input.agreementType !== undefined) row.agreementType = input.agreementType;
    row.agreementStart = start;
    row.agreementEnd = end;
    if (input.agreementRegistrationNo !== undefined)
      row.agreementRegistrationNo = input.agreementRegistrationNo;
    if (input.monthlyRentPaise !== undefined) row.monthlyRentPaise = input.monthlyRentPaise;
    if (input.securityDepositPaise !== undefined) row.securityDepositPaise = input.securityDepositPaise;
    if (input.maintenancePayer !== undefined) row.maintenancePayer = input.maintenancePayer;
    if (input.occupantCount !== undefined) row.occupantCount = input.occupantCount;
    if (input.inviteTenant !== undefined) row.inviteTenant = input.inviteTenant;
    if (input.household !== undefined) row.householdJson = input.household.length ? input.household : null;
    if (row.status === 'PENDING_APPROVAL') {
      row.status = 'DRAFT';
      row.submittedAt = null;
      row.submittedBy = null;
    }
    if (input.fileIds?.length) await attachTenancyDocs(ctx, societyId, row, input.fileIds, t);
    await bump(row, ctx, t);
    await audit(
      ctx,
      {
        action: AUDIT2.tenancyUpdated,
        entityType: ENTITY2.tenancy,
        entityId: row.id!,
        societyId,
        before,
        after: { maintenancePayer: row.maintenancePayer, monthlyRentPaise: Number(row.monthlyRentPaise) },
      },
      t,
    );
    changed(t, societyId, row.unitId, row.id!, row.status);
    return (await adminDtos(ctx, societyId, [row]))[0]!;
  });
}

// ------------------------------------------------------------------ submit (BR-09-29, 30)
export async function submitTenancy(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number },
  o: { mine?: boolean } = {},
): Promise<TenancyDto> {
  return sequelize.transaction(async t => {
    const row = o.mine ? await lockMine(ctx, societyId, id, t) : await lockTenancy(societyId, id, t);
    checkVersion(row, input.version);
    if (row.status !== 'DRAFT') throw invalidState('Only a draft tenancy can be submitted');
    const agreement = await ResidentDocument.count({
      where: { societyId, refType: 'tenancy', refId: row.id!, docType: 'RENT_AGREEMENT' },
      transaction: t,
    });
    if (!agreement) throw rule(422, 'DOCUMENTS_REQUIRED', 'Attach the rent agreement first', 'fileIds');
    const tenant = await Resident.findByPk(row.tenantResidentId, { transaction: t });
    if (!tenant?.mobile)
      throw rule(422, 'DOCUMENTS_REQUIRED', 'The tenant needs a mobile number first', 'tenant');
    const needsApproval =
      row.source === 'OWNER' || (await settings.get(societyId, 'residents.tenancyRequiresApproval')) === true;
    row.submittedAt = now();
    row.submittedBy = ctx.user?.id ?? null;
    const { unit, tenant: tenantName } = await labelsOf(row, t);
    if (needsApproval) {
      row.status = 'PENDING_APPROVAL';
      await bump(row, ctx, t);
      await audit(
        ctx,
        {
          action: AUDIT2.tenancySubmitted,
          entityType: ENTITY2.tenancy,
          entityId: row.id!,
          societyId,
          after: { status: row.status },
        },
        t,
      );
      notifyTenancy(
        t,
        'residents.tenancy_submitted',
        societyId,
        async s => [...(await recipients.admins(s)), ...(await userIdsOf(s, [row.landlordResidentId]))],
        row,
        {},
        unit,
        tenantName,
      );
    } else {
      await audit(
        ctx,
        {
          action: AUDIT2.tenancySubmitted,
          entityType: ENTITY2.tenancy,
          entityId: row.id!,
          societyId,
          after: { status: 'APPROVED' },
        },
        t,
      );
      await approveCore(ctx, societyId, row, t, null);
    }
    changed(t, societyId, row.unitId, row.id!, row.status);
    return (o.mine ? await mineDtos(ctx, societyId, [row]) : await adminDtos(ctx, societyId, [row]))[0]!;
  });
}

// ------------------------------------------------------------------ approve (BR-09-28, 31)
async function approveCore(
  ctx: Ctx,
  societyId: number,
  row: Tenancy,
  t: Transaction,
  note: string | null,
): Promise<void> {
  const unit = await units.lockActive(societyId, row.unitId, t);
  const links = await lockLinks(societyId, unit.id, t);
  const owner = primaryOwnerOf(links);
  if (!owner) throw rule(422, 'OWNER_REQUIRED', 'The flat needs an owner before a tenant', 'unitId');
  await assertNoOtherLive(societyId, unit.id, row.id!, t);
  const today = await societyToday(societyId);
  const tenant = await Resident.findOne({
    where: { id: row.tenantResidentId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!tenant) throw residentNotFound();
  if (links.some(l => l.residentId === tenant.id && l.toDate === null))
    throw rule(409, 'LINK_ALREADY_ACTIVE', 'This person is already linked to the flat', 'tenant');
  if (isMinor(tenant.dateOfBirth, today))
    throw rule(422, 'MINOR_NOT_ALLOWED', 'A minor cannot be a tenant', 'tenant');
  row.landlordResidentId = owner.residentId;
  row.status = 'APPROVED';
  row.decidedBy = ctx.user?.id ?? null;
  row.decidedAt = now();
  row.decisionReason = note;
  await bump(row, ctx, t);
  await createLink(
    ctx,
    societyId,
    {
      residentId: tenant.id!,
      unitId: unit.id,
      relation: 'TENANT',
      tenancyId: row.id!,
      isPrimary: false,
      isResiding: false,
      canLogin: true,
      fromDate: row.agreementStart,
      source: 'TENANCY',
    },
    t,
    { internal: true, already: unit },
  );
  for (const h of (row.householdJson as HouseholdEntry[] | null) ?? []) {
    const { resident } = await findOrCreateResident(
      ctx,
      societyId,
      { name: h.name, mobile: h.mobile ?? null, dateOfBirth: h.dateOfBirth ?? null },
      'TENANCY',
      t,
    );
    await createLink(
      ctx,
      societyId,
      {
        residentId: resident.id!,
        unitId: unit.id,
        relation: h.relation === 'CARETAKER' ? 'CARETAKER' : 'FAMILY',
        familyRelation: h.relation === 'CARETAKER' ? null : ((h.familyRelation ?? 'OTHER') as never),
        householdOf: 'TENANT',
        isResiding: false,
        ...(h.canLogin !== undefined ? { canLogin: h.canLogin } : {}),
        fromDate: row.agreementStart,
        source: 'TENANCY',
      },
      t,
      { already: unit },
    );
  }
  if (row.inviteTenant && tenant.mobile) {
    // an invitation that cannot be sent (already pending, already a member) never stops the approval
    await inSavepoint(t, () => inviteResidentTx(ctx, societyId, tenant.id!, {}, t));
  }
  await audit(
    ctx,
    {
      action: AUDIT2.tenancyApproved,
      entityType: ENTITY2.tenancy,
      entityId: row.id!,
      societyId,
      after: { status: 'APPROVED', landlordResidentId: owner.residentId, note },
    },
    t,
  );
  const { unit: label, tenant: tenantName } = await labelsOf(row, t);
  notifyTenancy(t, 'residents.tenancy_approved', societyId, partiesOf(row), row, {}, label, tenantName);
}

export async function approveTenancy(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number; note?: string },
): Promise<TenancyDto> {
  return sequelize.transaction(async t => {
    const row = await lockTenancy(societyId, id, t);
    checkVersion(row, input.version);
    if (row.status !== 'PENDING_APPROVAL')
      throw invalidState('Only a tenancy waiting for approval can be approved');
    if (row.createdBy) assertMakerChecker(ctx, row.createdBy);
    if (row.submittedBy) assertMakerChecker(ctx, row.submittedBy);
    await approveCore(ctx, societyId, row, t, input.note ?? null);
    changed(t, societyId, row.unitId, row.id!, row.status);
    return (await adminDtos(ctx, societyId, [row]))[0]!;
  });
}

export async function rejectTenancy(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number; reason: string },
): Promise<TenancyDto> {
  return sequelize.transaction(async t => {
    const row = await lockTenancy(societyId, id, t);
    checkVersion(row, input.version);
    if (row.status !== 'PENDING_APPROVAL')
      throw invalidState('Only a tenancy waiting for approval can be rejected');
    row.status = 'REJECTED';
    row.decidedBy = ctx.user?.id ?? null;
    row.decidedAt = now();
    row.decisionReason = input.reason;
    await bump(row, ctx, t);
    await audit(
      ctx,
      {
        action: AUDIT2.tenancyRejected,
        entityType: ENTITY2.tenancy,
        entityId: row.id!,
        societyId,
        after: { status: 'REJECTED' },
        reason: input.reason,
      },
      t,
    );
    const { unit, tenant } = await labelsOf(row, t);
    const creator = row.createdBy;
    notifyTenancy(
      t,
      'residents.tenancy_rejected',
      societyId,
      async () => (creator ? [creator] : []),
      row,
      { reason: input.reason },
      unit,
      tenant,
    );
    changed(t, societyId, row.unitId, row.id!, row.status);
    return (await adminDtos(ctx, societyId, [row]))[0]!;
  });
}

export async function cancelTenancy(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number; reason: string },
  o: { mine?: boolean } = {},
): Promise<TenancyDto> {
  return sequelize.transaction(async t => {
    const row = o.mine ? await lockMine(ctx, societyId, id, t) : await lockTenancy(societyId, id, t);
    checkVersion(row, input.version);
    if (row.status !== 'DRAFT' && row.status !== 'PENDING_APPROVAL')
      throw invalidState('Only a draft or waiting tenancy can be cancelled');
    row.status = 'CANCELLED';
    row.decisionReason = input.reason;
    await bump(row, ctx, t);
    await audit(
      ctx,
      {
        action: AUDIT2.tenancyCancelled,
        entityType: ENTITY2.tenancy,
        entityId: row.id!,
        societyId,
        after: { status: 'CANCELLED' },
        reason: input.reason,
      },
      t,
    );
    changed(t, societyId, row.unitId, row.id!, row.status);
    return (o.mine ? await mineDtos(ctx, societyId, [row]) : await adminDtos(ctx, societyId, [row]))[0]!;
  });
}

/** Documents of a tenancy added by the owner who created it (`POST /me/tenancies/:id/documents`). */
export async function attachMyTenancyDocuments(ctx: Ctx, societyId: number, id: number, items: DocInput[]) {
  return sequelize.transaction(async t => {
    const row = await lockMine(ctx, societyId, id, t);
    if (['REJECTED', 'CANCELLED', 'ENDED'].includes(row.status))
      throw invalidState('Documents can no longer be added to this tenancy');
    await attachTenancyDocs(ctx, societyId, row, items, t);
    touchReports(t, societyId);
    const docs = await ResidentDocument.findAll({
      where: { societyId, refType: 'tenancy', refId: row.id! },
      order: [['id', 'ASC']],
      transaction: t,
    });
    return docs.map(docDto);
  });
}

// ------------------------------------------------------------------ activate (BR-09-31) and move-in
/** APPROVED to ACTIVE: the tenancy links start residing. Used by `activate`, MOVE_IN completion and the daily job. */
export async function activateTenancyTx(
  ctx: Ctx,
  societyId: number,
  row: Tenancy,
  moveInDate: string,
  t: Transaction,
): Promise<void> {
  const links = await UnitResident.findAll({
    where: { societyId, tenancyId: row.id!, toDate: null },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  for (const l of links) {
    if (l.isResiding) continue;
    l.isResiding = true;
    l.version += 1;
    await l.save({ transaction: t });
  }
  row.status = 'ACTIVE';
  row.moveInDate = moveInDate;
  await bump(row, ctx, t);
  await audit(
    ctx,
    {
      action: AUDIT2.tenancyActivated,
      entityType: ENTITY2.tenancy,
      entityId: row.id!,
      societyId,
      after: { status: 'ACTIVE', moveInDate },
    },
    t,
  );
  changed(t, societyId, row.unitId, row.id!, row.status);
}

export async function activateTenancy(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number; moveInDate: string },
): Promise<TenancyDto> {
  return sequelize.transaction(async t => {
    const row = await lockTenancy(societyId, id, t);
    checkVersion(row, input.version);
    if (row.status !== 'APPROVED') throw invalidState('Only an approved tenancy can be marked as moved in');
    const today = await societyToday(societyId);
    if (input.moveInDate > today || input.moveInDate < addDaysYmd(row.agreementStart, -15))
      throw rule(
        422,
        'TENANCY_DATES_INVALID',
        'The move-in date is between 15 days before the agreement starts and today',
        'moveInDate',
      );
    await activateTenancyTx(ctx, societyId, row, input.moveInDate, t);
    return (await adminDtos(ctx, societyId, [row]))[0]!;
  });
}

// ------------------------------------------------------------------ renew (BR-09-35)
export async function renewTenancy(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number; agreementEnd: string; fileId?: number; monthlyRentPaise?: number },
): Promise<TenancyDto> {
  return sequelize.transaction(async t => {
    const row = await lockTenancy(societyId, id, t);
    checkVersion(row, input.version);
    if (row.status !== 'ACTIVE' && row.status !== 'EXPIRED_OVERSTAY')
      throw invalidState('Only an active tenancy can be renewed');
    const today = await societyToday(societyId);
    if (input.agreementEnd <= row.agreementEnd || input.agreementEnd <= today)
      throw rule(
        422,
        'TENANCY_DATES_INVALID',
        'The new end date must be later than the current end date and later than today',
        'agreementEnd',
      );
    const maxMonths = (await settings.get(societyId, 'residents.tenancyMaxMonths')) as number;
    const limit = new Date(`${row.agreementStart}T00:00:00Z`);
    limit.setUTCMonth(limit.getUTCMonth() + maxMonths);
    if (new Date(`${input.agreementEnd}T00:00:00Z`) > limit)
      throw rule(
        422,
        'TENANCY_DATES_INVALID',
        `The agreement cannot be longer than ${maxMonths} months`,
        'agreementEnd',
      );
    if (!input.fileId) throw rule(422, 'DOCUMENTS_REQUIRED', 'Attach the new rent agreement', 'fileId');
    await attachTenancyDocs(ctx, societyId, row, [{ fileId: input.fileId, docType: 'RENT_AGREEMENT' }], t);
    row.previousAgreementEnd = row.agreementEnd;
    row.agreementEnd = input.agreementEnd;
    row.renewalCount += 1;
    row.lastExpiryReminderDays = null;
    row.overstayAlertedAt = null;
    row.status = 'ACTIVE';
    if (input.monthlyRentPaise !== undefined) row.monthlyRentPaise = input.monthlyRentPaise;
    await bump(row, ctx, t);
    await audit(
      ctx,
      {
        action: AUDIT2.tenancyRenewed,
        entityType: ENTITY2.tenancy,
        entityId: row.id!,
        societyId,
        before: { agreementEnd: row.previousAgreementEnd },
        after: { agreementEnd: row.agreementEnd, renewalCount: row.renewalCount },
      },
      t,
    );
    changed(t, societyId, row.unitId, row.id!, row.status);
    return (await adminDtos(ctx, societyId, [row]))[0]!;
  });
}

// ------------------------------------------------------------------ end (BR-09-36)
export interface EndTenancySpec {
  endedOn: string;
  endReason: 'MOVED_OUT' | 'AGREEMENT_ENDED' | 'TERMINATED' | 'OWNER_SOLD' | 'OTHER';
  endNote?: string | null;
  /** The MOVE_OUT being completed does not count as an open move (BR-09-36). */
  ignoreMoveId?: number;
}

/**
 * Ends a live tenancy inside the caller's transaction: every link with this tenancy ends on `endedOn` (`TENANCY_ENDED`; the
 * tenant link `MOVED_OUT` for a move-out; `TERMINATED` when the tenant never moved in). Called by `end`, MOVE_OUT completion
 * and, in part 3, an ownership transfer with `endTenancy`. The caller holds the tenancy row lock.
 */
export async function endTenancyTx(
  ctx: Ctx,
  societyId: number,
  row: Tenancy,
  spec: EndTenancySpec,
  t: Transaction,
): Promise<void> {
  const unit = await units.lockActive(societyId, row.unitId, t);
  const links = await lockLinks(societyId, unit.id, t);
  const neverMoved = row.status === 'APPROVED';
  const mine = links.filter(l => l.toDate === null && l.tenancyId === row.id);
  const endedOn = neverMoved && spec.endedOn < row.agreementStart ? row.agreementStart : spec.endedOn;
  const tenantRows = mine.filter(l => l.relation === 'TENANT');
  const rest = mine.filter(l => l.relation !== 'TENANT');
  const note = spec.endNote ?? null;
  if (tenantRows.length)
    await endLinks(
      ctx,
      societyId,
      unit.id,
      tenantRows,
      {
        toDate: endedOn,
        reason: neverMoved ? 'TERMINATED' : spec.endReason === 'MOVED_OUT' ? 'MOVED_OUT' : 'TENANCY_ENDED',
        note,
      },
      t,
    );
  if (rest.length)
    await endLinks(
      ctx,
      societyId,
      unit.id,
      rest,
      { toDate: endedOn, reason: neverMoved ? 'TERMINATED' : 'TENANCY_ENDED', note },
      t,
    );
  row.status = 'ENDED';
  row.endedOn = endedOn;
  row.endReason = neverMoved ? 'TERMINATED' : spec.endReason;
  row.endNote = note;
  await bump(row, ctx, t);
  await audit(
    ctx,
    {
      action: AUDIT2.tenancyEnded,
      entityType: ENTITY2.tenancy,
      entityId: row.id!,
      societyId,
      after: { status: 'ENDED', endedOn, endReason: row.endReason, endedLinks: mine.length },
    },
    t,
  );
  const { unit: label, tenant } = await labelsOf(row, t);
  notifyTenancy(t, 'residents.tenancy_ended', societyId, partiesOf(row), row, { endedOn }, label, tenant);
  changed(t, societyId, row.unitId, row.id!, row.status);
}

export async function endTenancy(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number } & EndTenancySpec,
): Promise<TenancyDto> {
  return sequelize.transaction(async t => {
    const row = await lockTenancy(societyId, id, t);
    checkVersion(row, input.version);
    if (!(LIVE_TENANCY as readonly string[]).includes(row.status))
      throw invalidState('Only a live tenancy can be ended');
    const today = await societyToday(societyId);
    if (row.status !== 'APPROVED' && (input.endedOn > today || input.endedOn < row.agreementStart))
      throw rule(
        422,
        'TENANCY_DATES_INVALID',
        'The end date is between the agreement start and today',
        'endedOn',
      );
    const open = await MoveRequest.count({
      where: { societyId, tenancyId: id, status: { [Op.in]: [...OPEN_MOVE_STATUSES] } },
      transaction: t,
    });
    if (open)
      throw new AppError(
        409,
        'MOVE_REQUEST_EXISTS',
        'Complete or cancel the open move request of this tenancy first',
      );
    await endTenancyTx(ctx, societyId, row, input, t);
    return (await adminDtos(ctx, societyId, [row]))[0]!;
  });
}

// ------------------------------------------------------------------ police verification (BR-09-33)
export async function updatePoliceVerification(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: {
    version: number;
    status: 'NOT_REQUIRED' | 'NOT_SUBMITTED' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED';
    verifiedOn?: string;
    reference?: string;
    note?: string;
    fileId?: number;
  },
): Promise<TenancyDto> {
  await assertFeatureFor(societyId, 'residents.police_verification_tracking');
  return sequelize.transaction(async t => {
    const row = await lockTenancy(societyId, id, t);
    checkVersion(row, input.version);
    if (row.status === 'CANCELLED' || row.status === 'REJECTED') throw invalidState('This tenancy is closed');
    const today = await societyToday(societyId);
    const need = (message: string, field: string) =>
      rule(422, 'VERIFICATION_DETAILS_REQUIRED', message, field);
    if (input.fileId)
      await attachTenancyDocs(
        ctx,
        societyId,
        row,
        [{ fileId: input.fileId, docType: 'POLICE_VERIFICATION' }],
        t,
      );
    if (input.status === 'VERIFIED') {
      if (!input.verifiedOn || input.verifiedOn > today)
        throw need('Give the verification date (not in the future)', 'verifiedOn');
      const hasDoc = await ResidentDocument.count({
        where: { societyId, refType: 'tenancy', refId: row.id!, docType: 'POLICE_VERIFICATION' },
        transaction: t,
      });
      if (!input.reference && !hasDoc)
        throw need('Give the verification reference or attach the police document', 'reference');
    }
    if (input.status === 'NOT_REQUIRED' && (!input.note || input.note.length < 5))
      throw need('Give the reason (at least 5 characters)', 'note');
    const before = { status: row.policeVerificationStatus };
    row.policeVerificationStatus = input.status;
    row.policeVerifiedOn = input.status === 'VERIFIED' ? (input.verifiedOn ?? null) : null;
    row.policeVerificationRef = input.status === 'VERIFIED' ? (input.reference ?? null) : null;
    row.policeVerificationNote =
      input.status === 'NOT_REQUIRED' || input.status === 'REJECTED' ? (input.note ?? null) : null;
    await bump(row, ctx, t);
    await audit(
      ctx,
      {
        action: AUDIT2.tenancyPolice,
        entityType: ENTITY2.tenancy,
        entityId: row.id!,
        societyId,
        before,
        after: { status: row.policeVerificationStatus, verifiedOn: row.policeVerifiedOn },
      },
      t,
    );
    changed(t, societyId, row.unitId, row.id!, row.status);
    return (await adminDtos(ctx, societyId, [row]))[0]!;
  });
}

// ------------------------------------------------------------------ jobs (9.1)
/** `residents:tenancy-reminders`: 30 and 7 day reminders and the day-after overstay (BR-09-34). Idempotent. */
export async function runTenancyReminders(
  societyId: number,
  ctx: Ctx,
): Promise<{ reminded: number; overstayed: number }> {
  const today = await societyToday(societyId);
  let reminded = 0;
  let overstayed = 0;
  if (await featureOn(societyId, 'residents.agreement_expiry_reminders')) {
    const days = ((await settings.get(societyId, 'residents.agreementReminderDays')) as number[])
      .slice()
      .sort((a, b) => a - b);
    const rows = await Tenancy.findAll({
      where: {
        societyId,
        status: 'ACTIVE',
        agreementEnd: { [Op.gte]: today, [Op.lte]: addDaysYmd(today, Math.max(...days)) },
      },
      attributes: ['id'],
    });
    for (const { id } of rows)
      await sequelize.transaction(async t => {
        const row = await Tenancy.findOne({
          where: { id: id!, societyId },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!row || row.status !== 'ACTIVE') return;
        const left = daysBetween(today, row.agreementEnd);
        const d = days.find(x => left <= x);
        if (d === undefined || left < 0) return;
        if (row.lastExpiryReminderDays !== null && row.lastExpiryReminderDays <= d) return;
        row.lastExpiryReminderDays = d;
        await row.save({ transaction: t });
        const { unit, tenant } = await labelsOf(row, t);
        notifyTenancy(
          t,
          'residents.tenancy_expiring',
          societyId,
          async s => [...(await partiesOf(row)(s)), ...(await recipients.admins(s))],
          row,
          { days: left },
          unit,
          tenant,
        );
        reminded += 1;
      });
  }
  const late = await Tenancy.findAll({
    where: { societyId, status: 'ACTIVE', agreementEnd: { [Op.lt]: today } },
    attributes: ['id'],
  });
  for (const { id } of late)
    await sequelize.transaction(async t => {
      const row = await Tenancy.findOne({
        where: { id: id!, societyId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!row || row.status !== 'ACTIVE' || row.agreementEnd >= today) return;
      row.status = 'EXPIRED_OVERSTAY' as TenancyStatus;
      row.overstayAlertedAt = now();
      await bump(row, ctx, t);
      await audit(
        ctx,
        {
          action: AUDIT2.tenancyOverstayed,
          entityType: ENTITY2.tenancy,
          entityId: row.id!,
          societyId,
          after: { status: row.status, agreementEnd: row.agreementEnd },
        },
        t,
      );
      const { unit, tenant } = await labelsOf(row, t);
      notifyTenancy(
        t,
        'residents.tenancy_overstay',
        societyId,
        async s => [...(await userIdsOf(s, [row.landlordResidentId])), ...(await recipients.admins(s))],
        row,
        {},
        unit,
        tenant,
      );
      changed(t, societyId, row.unitId, row.id!, row.status);
      overstayed += 1;
    });
  return { reminded, overstayed };
}

/** `residents:police-reminders` (Mondays): ACTIVE tenancies with no police verification for long enough. */
export async function runPoliceReminders(societyId: number): Promise<number> {
  if (!(await featureOn(societyId, 'residents.police_verification_tracking'))) return 0;
  const today = await societyToday(societyId);
  const afterDays = (await settings.get(societyId, 'residents.policeVerificationReminderDays')) as number;
  const rows = await Tenancy.findAll({
    where: {
      societyId,
      status: 'ACTIVE',
      policeVerificationStatus: { [Op.in]: ['NOT_SUBMITTED', 'REJECTED'] },
    },
    attributes: ['id'],
  });
  let n = 0;
  for (const { id } of rows)
    await sequelize.transaction(async t => {
      const row = await Tenancy.findOne({
        where: { id: id!, societyId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!row || row.status !== 'ACTIVE') return;
      if (!['NOT_SUBMITTED', 'REJECTED'].includes(row.policeVerificationStatus)) return;
      if (daysBetween(row.moveInDate ?? row.agreementStart, today) < afterDays) return;
      if (row.policeReminderSentAt && now().getTime() - row.policeReminderSentAt.getTime() < 6 * 86_400_000)
        return;
      row.policeReminderSentAt = now();
      await row.save({ transaction: t });
      const { unit, tenant } = await labelsOf(row, t);
      notifyTenancy(
        t,
        'residents.police_verification_pending',
        societyId,
        partiesOf(row),
        row,
        {},
        unit,
        tenant,
      );
      n += 1;
    });
  return n;
}

/** Sync step of `residents:sync-links`: APPROVED tenancies start on `agreementStart` when no move request is required. */
export async function activateDueTenancies(societyId: number, ctx: Ctx): Promise<number> {
  if (await settings.get(societyId, 'residents.requireMoveInRequest')) return 0;
  const today = await societyToday(societyId);
  const rows = await Tenancy.findAll({
    where: { societyId, status: 'APPROVED', agreementStart: { [Op.lte]: today } },
    attributes: ['id'],
  });
  let n = 0;
  for (const { id } of rows)
    await sequelize.transaction(async t => {
      const row = await lockTenancy(societyId, id!, t);
      if (row.status !== 'APPROVED') return;
      await activateTenancyTx(ctx, societyId, row, row.agreementStart, t);
      n += 1;
    });
  return n;
}

// ------------------------------------------------------------------ module 24 reader (8.22)
export class ReadTimeoutError extends Error {
  constructor() {
    super('The report read timed out');
    this.name = 'ReadTimeoutError';
  }
}

export interface TenancyExpiryQuery {
  piiClass?: 'masked' | 'unmasked';
  expiringWithinDays?: number;
  status?: ('ACTIVE' | 'EXPIRED_OVERSTAY')[];
  policeVerificationStatus?: string;
  maintenancePayer?: 'OWNER' | 'TENANT';
  unitId?: number;
}
export interface TenancyExpiryOptions {
  deadlineMs: number;
  replica?: boolean;
  page?: number;
  limit?: number;
  sortBy?: 'agreementEnd' | 'unitLabel' | 'tenantName';
  sortDir?: 'asc' | 'desc';
  buildingIds?: number[];
}

/** Read-only `residentsReports.tenancyExpiry` for module 24; same filter as `GET /tenancies?expiringWithinDays=`. */
export async function tenancyExpiry(societyId: number, q: TenancyExpiryQuery, opts: TenancyExpiryOptions) {
  const started = Date.now();
  const guard = () => {
    if (Date.now() - started > opts.deadlineMs) throw new ReadTimeoutError();
  };
  const today = await societyToday(societyId);
  const where = tenancyWhere(
    societyId,
    {
      ...(q.unitId ? { unitId: q.unitId } : {}),
      status: q.status ?? ['ACTIVE', 'EXPIRED_OVERSTAY'],
      ...(q.policeVerificationStatus ? { policeVerificationStatus: q.policeVerificationStatus } : {}),
      ...(q.maintenancePayer ? { maintenancePayer: q.maintenancePayer } : {}),
      ...(q.expiringWithinDays ? { expiringWithinDays: q.expiringWithinDays } : {}),
    },
    today,
  );
  guard();
  const rows = await Tenancy.findAll({ where });
  guard();
  const unitRows = await Unit.findAll({
    where: { id: { [Op.in]: [...new Set(rows.map(r => r.unitId))] } },
    attributes: ['id', 'label', 'buildingId'],
  });
  const unitMap = new Map(unitRows.map(u => [u.id!, u]));
  const people = new Map(
    (
      await Resident.findAll({
        where: {
          id: { [Op.in]: [...new Set(rows.flatMap(r => [r.tenantResidentId, r.landlordResidentId]))] },
        },
        paranoid: false,
      })
    ).map(r => [r.id!, r]),
  );
  guard();
  const scoped = rows.filter(
    r => !opts.buildingIds || opts.buildingIds.includes(unitMap.get(r.unitId)?.buildingId ?? -1),
  );
  const mapped = scoped.map(r => {
    const u = unitMap.get(r.unitId);
    const tenant = people.get(r.tenantResidentId);
    return {
      tenancyId: r.id!,
      unitId: r.unitId,
      unitLabel: u?.label ?? '',
      buildingId: u?.buildingId ?? 0,
      tenantName: tenant?.name ?? '',
      tenantMobile: q.piiClass === 'unmasked' ? (tenant?.mobile ?? null) : maskMobile(tenant?.mobile ?? null),
      landlordName: people.get(r.landlordResidentId)?.name ?? '',
      agreementStart: r.agreementStart,
      agreementEnd: r.agreementEnd,
      daysToExpiry: daysBetween(today, r.agreementEnd),
      status: r.status,
      policeVerificationStatus: r.policeVerificationStatus,
      maintenancePayer: r.maintenancePayer,
    };
  });
  const dir = opts.sortDir === 'desc' ? -1 : 1;
  const key = opts.sortBy ?? 'agreementEnd';
  mapped.sort((a, b) => {
    const av = key === 'unitLabel' ? a.unitLabel : key === 'tenantName' ? a.tenantName : a.agreementEnd;
    const bv = key === 'unitLabel' ? b.unitLabel : key === 'tenantName' ? b.tenantName : b.agreementEnd;
    return (av < bv ? -1 : av > bv ? 1 : a.tenancyId - b.tenancyId) * dir;
  });
  const limit = Math.min(1000, Math.max(1, opts.limit ?? 100));
  const page = Math.max(1, opts.page ?? 1);
  guard();
  return {
    rows: mapped.slice((page - 1) * limit, page * limit),
    total: mapped.length,
    totals: {
      expiring30: mapped.filter(m => m.status === 'ACTIVE' && m.daysToExpiry >= 0 && m.daysToExpiry <= 30)
        .length,
      expiring60: mapped.filter(m => m.status === 'ACTIVE' && m.daysToExpiry >= 0 && m.daysToExpiry <= 60)
        .length,
      expiring90: mapped.filter(m => m.status === 'ACTIVE' && m.daysToExpiry >= 0 && m.daysToExpiry <= 90)
        .length,
      overstaying: mapped.filter(m => m.status === 'EXPIRED_OVERSTAY').length,
    },
  };
}
