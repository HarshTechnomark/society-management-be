import { Op, type Transaction } from 'sequelize';
import {
  OwnershipTransfer,
  Resident,
  ResidentDocument,
  Tenancy,
  UnitResident,
  sequelize,
} from '../../models';
import type { TransferBuyer, TransferSeller } from '../../models/ownership-transfer.model';
import { audit } from '../../utils/audit';
import { AppError, ForbiddenError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import { now } from '../../lib/clock';
import type { Ctx } from '../../types/context';
import { usersWithPermission } from '../access-control/access-control.public';
import { units } from '../society-setup/society-setup.public';
import { OPEN_TRANSFER_STATUSES } from './residents.constants';
import { attachDocuments, docDto, type DocInput } from './residents.documents.service';
import {
  assertShares,
  createLink,
  endLinks,
  liveTenancyOf,
  lockLinks,
  repairOwners,
} from './residents.links.service';
import { adminRoom, emitAfterCommit, notifyAfterCommit, recipients } from './residents.notify';
import {
  AUDIT3,
  DUES_POLICIES,
  ENTITY3,
  FEATURE3,
  MAX_BUYERS,
  TRANSFER_AHEAD_DAYS,
  TRANSFER_FEE_DUE_DAYS,
  CHARGE_HEAD,
  type TransferType,
} from './residents.part3.constants';
import { part3Ports, type ApprovalRequestRef } from './residents.part3.ports';
import {
  assertOwnUnit,
  callerResident,
  num,
  ownerOnly,
  primaryOwnerResidentId,
  readSettings,
  transferNotFound,
  unitLabel,
  unitLabels,
  userIdsOfResidents,
} from './residents.part3.shared';
import { residentPorts, touchReports } from './residents.ports';
import {
  addDaysYmd,
  assertFeatureFor,
  centsToShare,
  invalidState,
  isMinor,
  isUniqueViolation,
  rule,
  shareCents,
  societyToday,
  staleVersion,
} from './residents.shared';
import { computeFees, defaultPremium, type FeeInput, type FeeSettings } from './residents.transfers.fees';
import { missingDocuments } from './residents.transfers.docs';

/**
 * Ownership transfers (sections 5.8, 6.7 and 8.17). A transfer is drafted, submitted to module 14, approved (fees raised
 * through module 11) and completed in one transaction that ends the sellers' links, opens the buyers' links through
 * part 1's link services and hands the share certificate and member register to module 23.
 */
export type Actor = 'ADMIN' | 'RESIDENT';

export interface BuyerInput {
  residentId?: number;
  name?: string;
  mobile?: string | null;
  email?: string | null;
  dateOfBirth?: string | null;
  sharePercent: string;
  isPrimary: boolean;
  isResiding?: boolean;
}
export interface TransferFields {
  transferType: TransferType;
  effectiveDate: string;
  deedRegistrationNo?: string | null;
  deedDate?: string | null;
  considerationPaise?: number;
  buyers: BuyerInput[];
  transferPremiumPaise?: number;
  shareTransferFeePaise?: number;
  entranceFeePaise?: number;
  duesPolicy?: (typeof DUES_POLICIES)[number];
  endTenancy?: boolean;
  notes?: string | null;
  fileIds?: DocInput[];
}
export interface CreateTransferInput extends TransferFields {
  unitId: number;
}

const SETTINGS = [
  'residents.transferPremiumPaise',
  'residents.shareTransferFeePaise',
  'residents.entranceFeePaise',
  'residents.transferBackdateDays',
] as const;

const OWNER_IN = { [Op.in]: ['OWNER', 'CO_OWNER'] };

const lockTransfer = async (societyId: number, id: number, t: Transaction): Promise<OwnershipTransfer> => {
  const x = await OwnershipTransfer.findOne({
    where: { id, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!x) throw transferNotFound();
  return x;
};
const checkVersion = (x: OwnershipTransfer, v: number): void => {
  if (x.version !== v) throw staleVersion('This transfer');
};
const bump = (x: OwnershipTransfer, ctx: Ctx): void => {
  x.version += 1;
  x.updatedBy = ctx.user?.id ?? null;
};
const partiesInvalid = (message: string, field = 'buyers') =>
  rule(422, 'TRANSFER_PARTIES_INVALID', message, field);
const dateInvalid = (message: string, field = 'effectiveDate') =>
  rule(422, 'TRANSFER_DATE_INVALID', message, field);

async function feeSettings(societyId: number) {
  const s = await readSettings(societyId, [...SETTINGS]);
  const fees: FeeSettings = {
    transferPremiumPaise: s['residents.transferPremiumPaise'] as number,
    shareTransferFeePaise: s['residents.shareTransferFeePaise'] as number,
    entranceFeePaise: s['residents.entranceFeePaise'] as number,
  };
  return { fees, backdateDays: s['residents.transferBackdateDays'] as number };
}

// ------------------------------------------------------------------ DTO
async function buyerDtos(societyId: number, buyers: TransferBuyer[], t?: Transaction) {
  const rows = await Resident.findAll({
    where: { societyId, id: { [Op.in]: buyers.map(b => b.residentId) } },
    attributes: ['id', 'name'],
    paranoid: false,
    transaction: t,
  });
  const names = new Map(rows.map(r => [r.id!, r.name]));
  return buyers.map(b => ({
    residentId: b.residentId,
    name: names.get(b.residentId) ?? '',
    sharePercent: b.sharePercent,
    isPrimary: b.isPrimary,
    isResiding: b.isResiding,
  }));
}

const feesOf = (x: OwnershipTransfer) => ({
  transferPremiumPaise: num(x.transferPremiumPaise),
  shareTransferFeePaise: num(x.shareTransferFeePaise),
  entranceFeePaise: num(x.entranceFeePaise),
  newBuyerCount: x.newBuyerCount,
  totalFeesPaise: num(x.totalFeesPaise),
});

export async function transferDto(
  societyId: number,
  x: OwnershipTransfer,
  label: string,
  missing: string[],
  t?: Transaction,
) {
  return {
    id: x.id!,
    status: x.status,
    unitId: x.unitId,
    unitLabel: label,
    transferType: x.transferType,
    effectiveDate: x.effectiveDate,
    deedRegistrationNo: x.deedRegistrationNo,
    deedDate: x.deedDate,
    considerationPaise: num(x.considerationPaise),
    buyers: await buyerDtos(societyId, x.buyersJson, t),
    fees: feesOf(x),
    duesPolicy: x.duesPolicy,
    endTenancy: x.endTenancy,
    notes: x.notes,
    initiatedByResidentId: x.initiatedByResidentId,
    submittedAt: x.submittedAt ? x.submittedAt.toISOString() : null,
    completedAt: x.completedAt ? x.completedAt.toISOString() : null,
    missingDocuments: missing,
    createdAt: x.createdAt!.toISOString(),
    version: x.version,
  };
}

async function oneDto(societyId: number, x: OwnershipTransfer, t?: Transaction) {
  const miss = await missingDocuments(societyId, [x as never], t);
  return transferDto(societyId, x, await unitLabel(societyId, x.unitId), miss.get(x.id!) ?? [], t);
}

// ------------------------------------------------------------------ rules (BR-09-61, 62, 64)
async function checkDates(
  societyId: number,
  effectiveDate: string,
  backdateDays: number,
  deedDate: string | null | undefined,
  today: string,
  sellers?: { fromDate: string }[],
): Promise<void> {
  if (effectiveDate > addDaysYmd(today, TRANSFER_AHEAD_DAYS))
    throw dateInvalid(`The effective date can be at most ${TRANSFER_AHEAD_DAYS} days ahead`);
  if (effectiveDate < addDaysYmd(today, -backdateDays))
    throw dateInvalid(`The effective date can be at most ${backdateDays} days in the past`);
  if (deedDate && deedDate > today) throw dateInvalid('The deed date cannot be in the future', 'deedDate');
  if (sellers?.some(s => effectiveDate < s.fromDate))
    throw dateInvalid('The effective date cannot be before the seller became an owner');
}

interface ResolvedBuyers {
  buyers: TransferBuyer[];
}

/** Resolves the buyer list: existing residents by id, new people created with `source = 'TRANSFER'`. */
async function resolveBuyers(
  ctx: Ctx,
  societyId: number,
  list: BuyerInput[],
  type: string,
  today: string,
  t: Transaction,
): Promise<ResolvedBuyers> {
  if (list.length < 1 || list.length > MAX_BUYERS) throw partiesInvalid(`Add 1 to ${MAX_BUYERS} buyers`);
  const out: TransferBuyer[] = [];
  const seen = new Set<number>();
  for (const [i, b] of list.entries()) {
    let resident: Resident | null;
    if (b.residentId) {
      resident = await Resident.findOne({ where: { id: b.residentId, societyId }, transaction: t });
      if (!resident)
        throw new AppError(404, 'RESIDENT_NOT_FOUND', 'Resident not found', [
          { field: `buyers.${i}.residentId`, message: 'Resident not found' },
        ]);
    } else {
      if (!b.name || !b.mobile)
        throw partiesInvalid('A new buyer needs a name and a mobile number', `buyers.${i}`);
      const dup = await Resident.findOne({ where: { societyId, mobile: b.mobile }, transaction: t });
      if (dup)
        throw rule(
          409,
          'RESIDENT_MOBILE_EXISTS',
          'A resident with this mobile number already exists',
          `buyers.${i}.mobile`,
          {
            residentId: dup.id,
          },
        );
      try {
        resident = await Resident.create(
          {
            societyId,
            userId: null,
            memberId: null,
            name: b.name,
            mobile: b.mobile,
            alternateMobile: null,
            email: b.email ?? null,
            dateOfBirth: b.dateOfBirth ?? null,
            gender: null,
            photoFileId: null,
            preferredLanguage: 'en-IN',
            isNri: false,
            overseasPhone: null,
            localRepresentativeResidentId: null,
            status: 'ACTIVE',
            source: 'TRANSFER',
            directoryVisible: true,
            showMobileInDirectory: false,
            showEmailInDirectory: false,
            showPhotoInDirectory: false,
            adminNote: null,
            anonymisedAt: null,
            version: 1,
            createdBy: ctx.user?.id ?? null,
            updatedBy: ctx.user?.id ?? null,
            deletedAt: null,
          },
          { transaction: t },
        );
      } catch (err) {
        if (isUniqueViolation(err))
          throw rule(
            409,
            'RESIDENT_MOBILE_EXISTS',
            'A resident with this mobile number already exists',
            `buyers.${i}.mobile`,
          );
        throw err;
      }
    }
    if (seen.has(resident.id!)) throw partiesInvalid('A buyer is listed twice', `buyers.${i}`);
    seen.add(resident.id!);
    if (isMinor(resident.dateOfBirth, today) && !['INHERITANCE', 'NOMINATION'].includes(type))
      throw partiesInvalid('A minor can be a buyer only by inheritance or nomination', `buyers.${i}`);
    out.push({
      residentId: resident.id!,
      sharePercent: centsToShare(shareCents(b.sharePercent)),
      isPrimary: b.isPrimary,
      isResiding: b.isResiding ?? true,
    });
  }
  const total = out.reduce((a, b) => a + shareCents(b.sharePercent), 0);
  if (total !== 10000)
    throw partiesInvalid(`The shares must total exactly 100.00 (now ${centsToShare(total)})`, 'buyers');
  if (out.filter(b => b.isPrimary).length !== 1)
    throw partiesInvalid('Exactly one buyer must be the primary owner');
  if (out.some(b => shareCents(b.sharePercent) < 1)) throw partiesInvalid('Each share must be at least 0.01');
  return { buyers: out };
}

/** Buyers who are not already an open owner of the unit pay the entrance fee. */
async function newBuyerCountOf(societyId: number, unitId: number, buyers: TransferBuyer[], t?: Transaction) {
  const owners = await UnitResident.findAll({
    where: { societyId, unitId, toDate: null, relation: OWNER_IN },
    attributes: ['residentId'],
    transaction: t,
  });
  const ids = new Set(owners.map(o => o.residentId));
  return buyers.filter(b => !ids.has(b.residentId)).length;
}

const openOwnerLinks = (societyId: number, unitId: number, t?: Transaction) =>
  UnitResident.findAll({
    where: { societyId, unitId, toDate: null, relation: OWNER_IN },
    order: [['id', 'ASC']],
    transaction: t,
  });

async function assertInitiator(
  ctx: Ctx,
  societyId: number,
  unitId: number,
  t: Transaction,
): Promise<Resident> {
  assertOwnUnit(ctx, unitId);
  const me = await callerResident(ctx, societyId);
  const link = await UnitResident.findOne({
    where: { societyId, residentId: me.id!, unitId, toDate: null, relation: 'OWNER', isPrimary: true },
    transaction: t,
  });
  if (!link) throw ownerOnly();
  return me;
}

async function attachTransferDocs(
  ctx: Ctx,
  societyId: number,
  x: OwnershipTransfer,
  items: DocInput[] | undefined,
  t: Transaction,
): Promise<void> {
  if (!items?.length) return;
  const primary = x.buyersJson.find(b => b.isPrimary)?.residentId ?? null;
  const seller = await primaryOwnerResidentId(societyId, x.unitId, t);
  const membership = items.filter(i => i.docType === 'MEMBERSHIP_APPLICATION');
  const rest = items.filter(i => i.docType !== 'MEMBERSHIP_APPLICATION');
  for (const [group, residentId] of [
    [membership, primary],
    [rest, seller],
  ] as [DocInput[], number | null][])
    if (group.length)
      await attachDocuments(ctx, societyId, t, {
        residentId,
        unitId: x.unitId,
        refType: 'ownership_transfer',
        refId: x.id!,
        items: group,
      });
}

function changed(t: Transaction, societyId: number, x: OwnershipTransfer): void {
  emitAfterCommit(t, adminRoom(societyId), 'residents.requests.changed', {
    kind: 'TRANSFER',
    id: x.id!,
    status: x.status,
  });
  touchReports(t, societyId);
}

// ------------------------------------------------------------------ create (8.17)
export async function createTransfer(ctx: Ctx, societyId: number, input: CreateTransferInput, actor: Actor) {
  await assertFeatureFor(societyId, FEATURE3.transfers);
  return sequelize.transaction(async t => {
    const unit = await units.lockActive(societyId, input.unitId, t);
    const initiator = actor === 'RESIDENT' ? await assertInitiator(ctx, societyId, input.unitId, t) : null;
    const owners = await openOwnerLinks(societyId, input.unitId, t);
    if (!owners.length) throw partiesInvalid('The flat has no owner to transfer from', 'unitId');
    if (
      await OwnershipTransfer.count({
        where: { societyId, unitId: input.unitId, status: { [Op.in]: [...OPEN_TRANSFER_STATUSES] } },
        transaction: t,
      })
    )
      throw rule(409, 'TRANSFER_EXISTS', 'The flat already has an open ownership transfer', 'unitId');
    const today = await societyToday(societyId);
    const s = await feeSettings(societyId);
    await checkDates(societyId, input.effectiveDate, s.backdateDays, input.deedDate, today);
    const { buyers } = await resolveBuyers(ctx, societyId, input.buyers, input.transferType, today, t);
    if (unit.unitType === 'PARKING_ONLY' && buyers.some(b => b.isResiding))
      throw rule(
        422,
        'UNIT_NOT_RESIDENTIAL',
        'This unit is a parking space; buyers cannot reside in it',
        'buyers',
      );
    const fees = computeFees(
      input.transferType,
      s.fees,
      input,
      await newBuyerCountOf(societyId, input.unitId, buyers, t),
    );
    let x: OwnershipTransfer;
    try {
      x = await OwnershipTransfer.create(
        {
          societyId,
          unitId: input.unitId,
          transferType: input.transferType,
          status: 'DRAFT',
          effectiveDate: input.effectiveDate,
          deedRegistrationNo: input.deedRegistrationNo ?? null,
          deedDate: input.deedDate ?? null,
          considerationPaise: input.considerationPaise ?? 0,
          buyersJson: buyers,
          sellersJson: null,
          transferPremiumPaise: fees.transferPremiumPaise,
          shareTransferFeePaise: fees.shareTransferFeePaise,
          entranceFeePaise: fees.entranceFeePaise,
          newBuyerCount: fees.newBuyerCount,
          totalFeesPaise: fees.totalFeesPaise,
          feesRaisedAt: null,
          duesPolicy: input.duesPolicy ?? 'MUST_CLEAR',
          endTenancy: input.endTenancy ?? false,
          balanceAtSubmitPaise: 0,
          initiatedByResidentId: initiator?.id ?? null,
          approvalRequestId: null,
          submittedAt: null,
          decidedAt: null,
          decisionReason: null,
          completedAt: null,
          completedBy: null,
          shareCertificateHandoffAt: null,
          cancelledAt: null,
          cancelReason: null,
          notes: input.notes ?? null,
          version: 1,
          createdBy: ctx.user?.id ?? null,
          updatedBy: ctx.user?.id ?? null,
        },
        { transaction: t },
      );
    } catch (err) {
      if (isUniqueViolation(err))
        throw rule(409, 'TRANSFER_EXISTS', 'The flat already has an open ownership transfer', 'unitId');
      throw err;
    }
    await attachTransferDocs(ctx, societyId, x, input.fileIds, t);
    await audit(
      ctx,
      {
        action: AUDIT3.transferCreated,
        entityType: ENTITY3.transfer,
        entityId: x.id!,
        entityLabel: unit.label,
        societyId,
        after: {
          transferType: x.transferType,
          effectiveDate: x.effectiveDate,
          buyerCount: buyers.length,
          totalFeesPaise: fees.totalFeesPaise,
          duesPolicy: x.duesPolicy,
        },
      },
      t,
    );
    changed(t, societyId, x);
    return oneDto(societyId, x, t);
  });
}

// ------------------------------------------------------------------ list and read
export interface ListTransfersQuery {
  status?: string;
  unitId?: number;
  sortBy: 'effectiveDate' | 'createdAt';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

export async function listTransfers(societyId: number, q: ListTransfersQuery, unitIds?: number[]) {
  const w: Record<string, unknown> = { societyId };
  if (q.status) w.status = q.status;
  if (q.unitId) w.unitId = q.unitId;
  if (unitIds) {
    if (q.unitId && !unitIds.includes(q.unitId)) w.unitId = 0;
    else if (!q.unitId) w.unitId = { [Op.in]: unitIds };
  }
  const { rows, count } = await OwnershipTransfer.findAndCountAll({
    where: w,
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
  const missing = await missingDocuments(societyId, rows as never[]);
  const data = [];
  for (const r of rows)
    data.push(await transferDto(societyId, r, labels.get(r.unitId) ?? '', missing.get(r.id!) ?? []));
  return { data, pagination: pageMeta(q.page, q.limit, count) };
}

/** The detail adds `sellers` (the current owner links), `balancePaise`, `feeInvoices`, the documents and the approval id. */
export async function getTransfer(societyId: number, id: number) {
  const x = await OwnershipTransfer.findOne({ where: { id, societyId } });
  if (!x) throw transferNotFound();
  const snapshot = x.sellersJson;
  const owners = snapshot
    ? await UnitResident.findAll({
        where: { societyId, id: { [Op.in]: snapshot.map(s => s.linkId) } },
      })
    : await openOwnerLinks(societyId, x.unitId);
  const primaryOf = new Map(owners.map(o => [o.id!, o.isPrimary]));
  const sellerRows = snapshot
    ? snapshot.map(s => ({ ...s, isPrimary: primaryOf.get(s.linkId) ?? false }))
    : owners.map(o => ({
        linkId: o.id!,
        residentId: o.residentId,
        relation: o.relation,
        sharePercent: o.sharePercent,
        isPrimary: o.isPrimary,
      }));
  const people = await Resident.findAll({
    where: { societyId, id: { [Op.in]: sellerRows.map(o => o.residentId) } },
    attributes: ['id', 'name'],
    paranoid: false,
  });
  const names = new Map(people.map(p => [p.id!, p.name]));
  const docs = await ResidentDocument.findAll({
    where: { societyId, refType: 'ownership_transfer', refId: x.id! },
    order: [['id', 'ASC']],
  });
  return {
    ...(await oneDto(societyId, x)),
    sellers: sellerRows.map(o => ({
      linkId: o.linkId,
      residentId: o.residentId,
      name: names.get(o.residentId) ?? '',
      relation: o.relation,
      sharePercent: o.sharePercent,
      isPrimary: o.isPrimary,
    })),
    balancePaise: await residentPorts().unitLedger.balance(societyId, x.unitId),
    balanceAtSubmitPaise: num(x.balanceAtSubmitPaise),
    feeInvoices: await part3Ports().invoices.listForRef(societyId, 'ownership_transfer', x.id!),
    approvalRequestId: x.approvalRequestId,
    documents: docs.map(docDto),
    decisionReason: x.decisionReason,
    cancelReason: x.cancelReason,
  };
}

// ------------------------------------------------------------------ patch (DRAFT, or after changes were requested)
export type PatchTransferInput = Partial<TransferFields> & { version: number };

export async function patchTransfer(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: PatchTransferInput,
  actor: Actor,
) {
  return sequelize.transaction(async t => {
    const x = await lockTransfer(societyId, id, t);
    if (actor === 'RESIDENT') await assertInitiator(ctx, societyId, x.unitId, t);
    let resubmit = false;
    if (x.status === 'PENDING_APPROVAL' && actor === 'RESIDENT' && x.approvalRequestId) {
      const st = await part3Ports().approvals.publicStatus(societyId, 'OWNERSHIP_TRANSFER', x.id!);
      resubmit = st.status === 'CHANGES_REQUESTED';
    }
    if (x.status !== 'DRAFT' && !resubmit) throw invalidState('Only a draft transfer can be edited');
    checkVersion(x, input.version);
    const today = await societyToday(societyId);
    const s = await feeSettings(societyId);
    const type = input.transferType ?? (x.transferType as TransferType);
    const effectiveDate = input.effectiveDate ?? x.effectiveDate;
    const deedDate = input.deedDate === undefined ? x.deedDate : input.deedDate;
    await checkDates(societyId, effectiveDate, s.backdateDays, deedDate, today);
    let buyers = x.buyersJson;
    if (input.buyers) buyers = (await resolveBuyers(ctx, societyId, input.buyers, type, today, t)).buyers;
    else if (input.transferType && input.transferType !== x.transferType)
      buyers = (
        await resolveBuyers(
          ctx,
          societyId,
          buyers.map(b => ({ ...b })),
          type,
          today,
          t,
        )
      ).buyers;
    const given: FeeInput = {
      transferPremiumPaise:
        input.transferPremiumPaise ??
        (input.transferType && input.transferType !== x.transferType
          ? defaultPremium(type, s.fees)
          : num(x.transferPremiumPaise)),
      shareTransferFeePaise: input.shareTransferFeePaise ?? num(x.shareTransferFeePaise),
      entranceFeePaise: input.entranceFeePaise ?? num(x.entranceFeePaise),
    };
    const fees = computeFees(type, s.fees, given, await newBuyerCountOf(societyId, x.unitId, buyers, t));
    Object.assign(x, {
      transferType: type,
      effectiveDate,
      deedRegistrationNo:
        input.deedRegistrationNo === undefined ? x.deedRegistrationNo : input.deedRegistrationNo,
      deedDate,
      considerationPaise: input.considerationPaise ?? num(x.considerationPaise),
      buyersJson: buyers,
      transferPremiumPaise: fees.transferPremiumPaise,
      shareTransferFeePaise: fees.shareTransferFeePaise,
      entranceFeePaise: fees.entranceFeePaise,
      newBuyerCount: fees.newBuyerCount,
      totalFeesPaise: fees.totalFeesPaise,
      duesPolicy: input.duesPolicy ?? x.duesPolicy,
      endTenancy: input.endTenancy ?? x.endTenancy,
      notes: input.notes === undefined ? x.notes : input.notes,
    });
    bump(x, ctx);
    await x.save({ transaction: t });
    await attachTransferDocs(ctx, societyId, x, input.fileIds, t);
    const label = await unitLabel(societyId, x.unitId);
    if (resubmit) {
      const missing = (await missingDocuments(societyId, [x as never], t)).get(x.id!) ?? [];
      if (missing.length) throw docsRequired(missing);
      await part3Ports().approvals.resubmit(
        ctx,
        x.approvalRequestId!,
        { title: `Ownership transfer of ${label}`, summary: await approvalSummary(x, label) },
        t,
      );
    }
    await audit(
      ctx,
      {
        action: resubmit ? AUDIT3.transferResubmitted : AUDIT3.transferUpdated,
        entityType: ENTITY3.transfer,
        entityId: x.id!,
        entityLabel: label,
        societyId,
        after: {
          transferType: x.transferType,
          effectiveDate: x.effectiveDate,
          buyerCount: buyers.length,
          totalFeesPaise: fees.totalFeesPaise,
        },
      },
      t,
    );
    changed(t, societyId, x);
    return oneDto(societyId, x, t);
  });
}

const docsRequired = (missing: string[]) =>
  new AppError(422, 'DOCUMENTS_REQUIRED', 'Attach the required documents', [
    { field: 'fileIds', message: `Missing: ${missing.join(', ')}`, missing },
  ]);

// ------------------------------------------------------------------ submit (BR-09-61 to 64)
async function approvalSummary(x: OwnershipTransfer, label: string) {
  const buyers = await buyerDtos(x.societyId, x.buyersJson);
  return [
    { label: 'Flat', value: label },
    { label: 'Type', value: x.transferType },
    { label: 'Effective date', value: x.effectiveDate },
    { label: 'Buyers', value: buyers.map(b => `${b.name} ${b.sharePercent}%`).join(', ') },
    { label: 'Fees', value: `${num(x.totalFeesPaise) / 100} rupees` },
    { label: 'Dues policy', value: x.duesPolicy },
    { label: 'Balance at submit', value: `${num(x.balanceAtSubmitPaise) / 100} rupees` },
  ];
}

export async function submitTransfer(ctx: Ctx, societyId: number, id: number, version: number, actor: Actor) {
  return sequelize.transaction(async t => {
    const x = await lockTransfer(societyId, id, t);
    if (actor === 'RESIDENT') await assertInitiator(ctx, societyId, x.unitId, t);
    if (x.status !== 'DRAFT') throw invalidState('Only a draft transfer can be submitted');
    checkVersion(x, version);
    await units.lockActive(societyId, x.unitId, t);
    const links = await lockLinks(societyId, x.unitId, t);
    const owners = links.filter(l => l.toDate === null && ['OWNER', 'CO_OWNER'].includes(l.relation));
    if (!owners.length) throw partiesInvalid('The flat has no owner to transfer from', 'unitId');
    const today = await societyToday(societyId);
    const s = await feeSettings(societyId);
    await checkDates(societyId, x.effectiveDate, s.backdateDays, x.deedDate, today, owners);
    // parties and fees again: owners and residents may have changed since the draft
    const buyers = (
      await resolveBuyers(
        ctx,
        societyId,
        x.buyersJson.map(b => ({ ...b })),
        x.transferType,
        today,
        t,
      )
    ).buyers;
    const fees = computeFees(
      x.transferType,
      s.fees,
      {
        transferPremiumPaise: num(x.transferPremiumPaise),
        shareTransferFeePaise: num(x.shareTransferFeePaise),
        entranceFeePaise: num(x.entranceFeePaise),
      },
      await newBuyerCountOf(societyId, x.unitId, buyers, t),
    );
    if (['SALE', 'GIFT'].includes(x.transferType) && !x.deedRegistrationNo)
      throw rule(422, 'VALIDATION_FAILED', 'The deed registration number is required', 'deedRegistrationNo');
    const missing = (await missingDocuments(societyId, [x as never], t)).get(x.id!) ?? [];
    if (missing.length) throw docsRequired(missing);
    const balance = await residentPorts().unitLedger.balance(societyId, x.unitId);
    x.sellersJson = owners.map((o): TransferSeller => ({
      linkId: o.id!,
      residentId: o.residentId,
      relation: o.relation,
      sharePercent: o.sharePercent,
    }));
    Object.assign(x, {
      buyersJson: buyers,
      transferPremiumPaise: fees.transferPremiumPaise,
      shareTransferFeePaise: fees.shareTransferFeePaise,
      entranceFeePaise: fees.entranceFeePaise,
      newBuyerCount: fees.newBuyerCount,
      totalFeesPaise: fees.totalFeesPaise,
      balanceAtSubmitPaise: balance,
      status: 'PENDING_APPROVAL',
      submittedAt: now(),
    });
    bump(x, ctx);
    await x.save({ transaction: t });
    const label = await unitLabel(societyId, x.unitId);
    await audit(
      ctx,
      {
        action: AUDIT3.transferSubmitted,
        entityType: ENTITY3.transfer,
        entityId: x.id!,
        entityLabel: label,
        societyId,
        after: {
          totalFeesPaise: fees.totalFeesPaise,
          duesPolicy: x.duesPolicy,
          balanceAtSubmitPaise: balance,
        },
      },
      t,
    );
    const req = await part3Ports().approvals.request(
      ctx,
      {
        type: 'OWNERSHIP_TRANSFER',
        entityId: x.id!,
        unitId: x.unitId,
        title: `Ownership transfer of ${label}`,
        summary: await approvalSummary(x, label),
        payload: {
          transferId: x.id,
          transferType: x.transferType,
          effectiveDate: x.effectiveDate,
          fees,
          duesPolicy: x.duesPolicy,
          balanceAtSubmitPaise: balance,
          sellers: x.sellersJson,
          buyers,
        },
      },
      t,
    );
    await OwnershipTransfer.update({ approvalRequestId: req.id }, { where: { id: x.id! }, transaction: t });
    notifyAfterCommit(t, 'residents.transfer_submitted', societyId, recipients.admins, {
      unitLabel: label,
      transferType: x.transferType,
      link: '/requests',
    });
    const fresh = (await OwnershipTransfer.findByPk(x.id!, { transaction: t }))!;
    changed(t, societyId, fresh);
    return oneDto(societyId, fresh, t);
  });
}

// ------------------------------------------------------------------ cancel
const CANCELLABLE = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'];

async function cancelEffect(
  ctx: Ctx,
  x: OwnershipTransfer,
  reason: string,
  t: Transaction,
  o: { fromApprovals?: boolean } = {},
): Promise<void> {
  const was = x.status;
  x.status = 'CANCELLED';
  x.cancelledAt = now();
  x.cancelReason = reason.slice(0, 500);
  bump(x, ctx);
  await x.save({ transaction: t });
  if (was === 'PENDING_APPROVAL' && x.approvalRequestId && !o.fromApprovals)
    await part3Ports().approvals.cancel(ctx, x.approvalRequestId, reason, t);
  if (x.feesRaisedAt)
    await part3Ports().invoices.cancelForRef(
      ctx,
      { refType: 'ownership_transfer', refId: x.id!, reason: 'Transfer cancelled' },
      t,
    );
  const label = await unitLabel(x.societyId, x.unitId);
  await audit(
    ctx,
    {
      action: AUDIT3.transferCancelled,
      entityType: ENTITY3.transfer,
      entityId: x.id!,
      entityLabel: label,
      societyId: x.societyId,
      before: { status: was },
      after: { status: x.status },
      reason,
    },
    t,
  );
  changed(t, x.societyId, x);
}

export async function cancelTransfer(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { reason: string; version: number },
  actor: Actor,
) {
  return sequelize.transaction(async t => {
    const x = await lockTransfer(societyId, id, t);
    if (actor === 'RESIDENT') await assertInitiator(ctx, societyId, x.unitId, t);
    if (!CANCELLABLE.includes(x.status)) throw invalidState('This transfer can no longer be cancelled');
    checkVersion(x, input.version);
    if (x.status === 'APPROVED' && !(ctx.permissions?.has('residents.requests.approve') ?? false))
      throw new ForbiddenError('PERMISSION_DENIED', 'Only an approver can cancel an approved transfer');
    await cancelEffect(ctx, x, input.reason, t);
    return oneDto(societyId, x, t);
  });
}

// ------------------------------------------------------------------ module 14 callbacks (6.8)
const lockForApproval = (req: ApprovalRequestRef, t: Transaction) =>
  OwnershipTransfer.findOne({
    where: { id: req.entityId, societyId: req.societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

async function initiatorUserIds(x: OwnershipTransfer, t: Transaction): Promise<number[]> {
  if (x.initiatedByResidentId) return userIdsOfResidents(x.societyId, [x.initiatedByResidentId], t);
  return userIdsOfResidents(
    x.societyId,
    (x.sellersJson ?? []).map(s => s.residentId),
    t,
  );
}

export const transferApprovals = {
  /** BR-09-65: APPROVED; each non-zero fee is raised through module 11 (the entrance fee once per new buyer). */
  async onApproved(ctx: Ctx, req: ApprovalRequestRef, t: Transaction): Promise<void> {
    const x = await lockForApproval(req, t);
    if (!x || x.status !== 'PENDING_APPROVAL') return;
    const label = await unitLabel(x.societyId, x.unitId);
    const today = await societyToday(x.societyId);
    const dueDate = addDaysYmd(today, TRANSFER_FEE_DUE_DAYS);
    const raise = async (chargeHeadKey: string, amountPaise: number) => {
      if (amountPaise > 0)
        await part3Ports().invoices.createAdHoc(
          ctx,
          {
            unitId: x.unitId,
            chargeHeadKey,
            amountPaise,
            refType: 'ownership_transfer',
            refId: x.id!,
            dueDate,
          },
          t,
        );
    };
    await raise(CHARGE_HEAD.premium, num(x.transferPremiumPaise));
    await raise(CHARGE_HEAD.shareFee, num(x.shareTransferFeePaise));
    for (let i = 0; i < x.newBuyerCount; i++) await raise(CHARGE_HEAD.entrance, num(x.entranceFeePaise));
    x.status = 'APPROVED';
    x.decidedAt = now();
    x.feesRaisedAt = num(x.totalFeesPaise) > 0 ? now() : null;
    bump(x, ctx);
    await x.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT3.transferApproved,
        entityType: ENTITY3.transfer,
        entityId: x.id!,
        entityLabel: label,
        societyId: x.societyId,
        after: { status: x.status, totalFeesPaise: num(x.totalFeesPaise) },
      },
      t,
    );
    const ids = await userIdsOfResidents(
      x.societyId,
      [...(x.sellersJson ?? []).map(s => s.residentId), ...x.buyersJson.map(b => b.residentId)],
      t,
    );
    notifyAfterCommit(t, 'residents.transfer_approved', x.societyId, recipients.users(ids), {
      unitLabel: label,
      effectiveDate: x.effectiveDate,
      link: '/requests',
    });
    changed(t, x.societyId, x);
  },

  async onRejected(ctx: Ctx, req: ApprovalRequestRef, t: Transaction): Promise<void> {
    const x = await lockForApproval(req, t);
    if (!x || x.status !== 'PENDING_APPROVAL') return;
    x.status = 'REJECTED';
    x.decidedAt = now();
    x.decisionReason = req.reason?.slice(0, 500) ?? null;
    bump(x, ctx);
    await x.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT3.transferRejected,
        entityType: ENTITY3.transfer,
        entityId: x.id!,
        entityLabel: await unitLabel(x.societyId, x.unitId),
        societyId: x.societyId,
        after: { status: x.status },
        reason: x.decisionReason,
      },
      t,
    );
    changed(t, x.societyId, x);
  },

  async onChangesRequested(ctx: Ctx, req: ApprovalRequestRef, t: Transaction): Promise<void> {
    const x = await lockForApproval(req, t);
    if (!x || x.status !== 'PENDING_APPROVAL') return;
    const label = await unitLabel(x.societyId, x.unitId);
    await audit(
      ctx,
      {
        action: AUDIT3.transferChangesRequested,
        entityType: ENTITY3.transfer,
        entityId: x.id!,
        entityLabel: label,
        societyId: x.societyId,
        reason: req.reason ?? null,
      },
      t,
    );
    notifyAfterCommit(
      t,
      'residents.request_changes_requested',
      x.societyId,
      recipients.users(await initiatorUserIds(x, t)),
      { kind: 'ownership transfer', unitLabel: label, reason: req.reason ?? null, link: '/requests' },
    );
    changed(t, x.societyId, x);
  },

  async onCancelled(ctx: Ctx, req: ApprovalRequestRef, t: Transaction): Promise<void> {
    const x = await lockForApproval(req, t);
    if (!x || !CANCELLABLE.includes(x.status)) return;
    await cancelEffect(ctx, x, req.reason ?? 'Cancelled in the approval inbox', t, { fromApprovals: true });
  },

  async describe(req: ApprovalRequestRef) {
    const x = await OwnershipTransfer.findOne({ where: { id: req.entityId, societyId: req.societyId } });
    if (!x) return { title: 'Ownership transfer', lines: [] };
    const label = await unitLabel(x.societyId, x.unitId);
    return { title: `Ownership transfer of ${label}`, lines: await approvalSummary(x, label) };
  },
};

// ------------------------------------------------------------------ complete (BR-09-66, 67)
export async function completeTransfer(ctx: Ctx, societyId: number, id: number, version: number) {
  return sequelize.transaction(async t => {
    const probe = await OwnershipTransfer.findOne({ where: { id, societyId }, transaction: t });
    if (!probe) throw transferNotFound();
    // BR-09-19 lock order: unit row, the unit's links, the tenancy, then the request row
    const unit = await units.lockActive(societyId, probe.unitId, t);
    const links = await lockLinks(societyId, probe.unitId, t);
    const live = await liveTenancyOf(societyId, probe.unitId, t);
    const tenancy = live
      ? await Tenancy.findOne({ where: { id: live.id! }, transaction: t, lock: t.LOCK.UPDATE })
      : null;
    const x = await lockTransfer(societyId, id, t);
    if (x.status !== 'APPROVED') throw invalidState('Only an approved transfer can be completed');
    checkVersion(x, version);
    const today = await societyToday(societyId);
    if (today < x.effectiveDate)
      throw dateInvalid(`The transfer can be completed on or after ${x.effectiveDate}`);
    if (x.duesPolicy === 'MUST_CLEAR') {
      const balance = await residentPorts().unitLedger.balance(societyId, x.unitId);
      if (balance > 0)
        throw rule(
          422,
          'TRANSFER_DUES_PENDING',
          'The flat has dues to clear before the transfer',
          'duesPolicy',
          {
            balancePaise: balance,
          },
        );
    }
    const sellerLinks = links.filter(l => l.toDate === null && ['OWNER', 'CO_OWNER'].includes(l.relation));
    const snap = (x.sellersJson ?? []).map(s => s.linkId).sort((a, b) => a - b);
    const open = sellerLinks.map(l => l.id!).sort((a, b) => a - b);
    if (snap.length !== open.length || snap.some((v, i) => v !== open[i]))
      throw new AppError(
        409,
        'TRANSFER_SELLER_MISMATCH',
        'The owners of the flat changed after the transfer was submitted',
      );

    const dayBefore = addDaysYmd(x.effectiveDate, -1);
    const reason = x.transferType === 'SALE' ? 'SOLD' : 'TRANSFERRED';
    const buyerIds = new Set(x.buyersJson.map(b => b.residentId));
    // owner-household FAMILY and CARETAKER links end unless a seller continues as a buyer (their household stays)
    const continuing = sellerLinks.some(l => buyerIds.has(l.residentId));
    const household = continuing
      ? []
      : links.filter(
          l =>
            l.toDate === null &&
            ['FAMILY', 'CARETAKER'].includes(l.relation) &&
            l.tenancyId === null &&
            !buyerIds.has(l.residentId),
        );
    await endLinks(
      ctx,
      societyId,
      x.unitId,
      [...sellerLinks, ...household],
      { toDate: dayBefore, reason },
      t,
    );

    const primary = x.buyersJson.find(b => b.isPrimary)!;
    const ordered = [primary, ...x.buyersJson.filter(b => b !== primary)];
    for (const b of ordered)
      await createLink(
        ctx,
        societyId,
        {
          residentId: b.residentId,
          unitId: x.unitId,
          relation: b === primary ? 'OWNER' : 'CO_OWNER',
          sharePercent: x.buyersJson.length > 1 ? b.sharePercent : null,
          isPrimary: b.isPrimary,
          isResiding: b.isResiding,
          fromDate: x.effectiveDate,
          ownershipTransferId: x.id!,
          source: 'TRANSFER',
        },
        t,
        {
          internal: true,
          allowMinorOwner: ['INHERITANCE', 'NOMINATION'].includes(x.transferType),
          skipShareCheck: true,
          already: unit,
        },
      );
    const newOwners = await UnitResident.findAll({
      where: { societyId, unitId: x.unitId, toDate: null, relation: OWNER_IN },
      transaction: t,
    });
    assertShares(newOwners.map(o => ({ sharePercent: o.sharePercent })));
    await repairOwners(societyId, x.unitId, t);

    if (tenancy) {
      if (x.endTenancy) {
        const tenantLinks = (
          await UnitResident.findAll({
            where: { societyId, unitId: x.unitId, toDate: null, tenancyId: tenancy.id! },
            order: [['id', 'ASC']],
            transaction: t,
          })
        ).filter(l => l.relation === 'TENANT' || l.relation === 'FAMILY' || l.relation === 'CARETAKER');
        const endedOn = [dayBefore, tenancy.agreementStart].reduce((a, b) => (a > b ? a : b));
        await endLinks(
          ctx,
          societyId,
          x.unitId,
          tenantLinks,
          { toDate: endedOn > today ? today : endedOn, reason: 'TENANCY_ENDED' },
          t,
        );
        tenancy.status = 'ENDED';
        tenancy.endedOn = endedOn > today ? today : endedOn;
        tenancy.endReason = 'OWNER_SOLD';
      } else tenancy.landlordResidentId = primary.residentId;
      tenancy.version += 1;
      tenancy.updatedBy = ctx.user?.id ?? null;
      await tenancy.save({ transaction: t });
    }

    await part3Ports().shareCertificates.onOwnershipTransferred(
      ctx,
      {
        transferId: x.id!,
        unitId: x.unitId,
        sellerResidentIds: [...new Set((x.sellersJson ?? []).map(s => s.residentId))],
        buyers: x.buyersJson.map(b => ({
          residentId: b.residentId,
          sharePercent: b.sharePercent,
          isPrimary: b.isPrimary,
        })),
        effectiveDate: x.effectiveDate,
        transferType: x.transferType,
      },
      t,
    );
    x.shareCertificateHandoffAt = now();
    x.status = 'COMPLETED';
    x.completedAt = now();
    x.completedBy = ctx.user?.id ?? null;
    bump(x, ctx);
    await x.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT3.transferCompleted,
        entityType: ENTITY3.transfer,
        entityId: x.id!,
        entityLabel: unit.label,
        societyId,
        after: {
          effectiveDate: x.effectiveDate,
          sellerLinksEnded: sellerLinks.length,
          buyerCount: x.buyersJson.length,
          tenancyEnded: Boolean(tenancy && x.endTenancy),
          duesPolicy: x.duesPolicy,
        },
      },
      t,
    );
    const ids = await userIdsOfResidents(
      societyId,
      [...(x.sellersJson ?? []).map(s => s.residentId), ...x.buyersJson.map(b => b.residentId)],
      t,
    );
    notifyAfterCommit(
      t,
      'residents.transfer_completed',
      societyId,
      async sid => [...ids, ...(await usersWithPermission(sid, 'finance.billing.view'))],
      { unitLabel: unit.label, effectiveDate: x.effectiveDate, link: '/requests' },
    );
    changed(t, societyId, x);
    return oneDto(societyId, x, t);
  });
}
