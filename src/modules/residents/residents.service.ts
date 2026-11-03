import { Op, QueryTypes } from 'sequelize';
import { EmergencyProfile, Resident, ResidentDocument, UnitResident, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { AppError, ForbiddenError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { users } from '../auth/auth.public';
import { AUDIT, ENTITY, FEATURE, ID_DOC_TYPES, type Household } from './residents.constants';
import { attachDocuments, docDto, type DocInput } from './residents.documents.service';
import { linkDtos, type LinkDto } from './residents.dto';
import { inviteResidentTx, type InviteResult } from './residents.invite.service';
import { createLink } from './residents.links.service';
import { residentPorts, touchReports } from './residents.ports';
import { openRequestsOfResident, residentBlocker } from './residents.requests';
import {
  assertFeatureFor,
  featureOn,
  isMinor,
  isUniqueViolation,
  maskMail,
  maskMobile,
  residentNotFound,
  rule,
  societyToday,
  staleVersion,
} from './residents.shared';
import type { FamilyRelation, LinkRelation } from '../../models/unit-resident.model';
import type { ResidentSource } from '../../models/resident.model';

/** Resident records (sections 5.1 and 8.2 to 8.7). */
export interface ResidentFields {
  name: string;
  mobile?: string | null;
  alternateMobile?: string | null;
  email?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  photoFileId?: number | null;
  preferredLanguage?: string;
  isNri?: boolean;
  overseasPhone?: string | null;
  localRepresentativeResidentId?: number | null;
  adminNote?: string | null;
}
export interface LinkFields {
  unitId: number;
  relation: LinkRelation;
  familyRelation?: FamilyRelation | null;
  householdOf?: Household | null;
  sharePercent?: string | null;
  isPrimary?: boolean;
  isResiding?: boolean;
  canLogin?: boolean;
  fromDate: string;
}
export interface CreateResidentInput extends ResidentFields {
  link?: LinkFields;
  invite?: boolean;
  fileIds?: DocInput[];
}

const mobileExists = (residentId: number) =>
  rule(409, 'RESIDENT_MOBILE_EXISTS', 'A resident with this mobile number already exists', 'mobile', {
    residentId,
  });

/** BR-09-7: NRI fields are a Premium feature and the local representative is an active resident of the society. */
async function checkNri(
  societyId: number,
  f: Pick<ResidentFields, 'isNri' | 'overseasPhone' | 'localRepresentativeResidentId'>,
  selfId: number | null,
  t: import('sequelize').Transaction,
): Promise<void> {
  if (!f.isNri && !f.overseasPhone && !f.localRepresentativeResidentId) return;
  await assertFeatureFor(societyId, FEATURE.nri);
  if (f.overseasPhone && (!/^\+[1-9]\d{6,14}$/.test(f.overseasPhone) || f.overseasPhone.startsWith('+91')))
    throw rule(
      422,
      'VALIDATION_FAILED',
      'Use an overseas number like +14155550123, not +91',
      'overseasPhone',
    );
  if (f.localRepresentativeResidentId) {
    if (f.localRepresentativeResidentId === selfId)
      throw rule(
        422,
        'VALIDATION_FAILED',
        'A resident cannot represent themselves',
        'localRepresentativeResidentId',
      );
    const rep = await Resident.findOne({
      where: { id: f.localRepresentativeResidentId, societyId, status: 'ACTIVE' },
      transaction: t,
    });
    if (!rep)
      throw rule(
        422,
        'VALIDATION_FAILED',
        'The local representative must be an active resident of this society',
        'localRepresentativeResidentId',
      );
  }
}

export interface CreatedResident {
  id: number;
  name: string;
  mobile: string | null;
  status: string;
  version: number;
  links: LinkDto[];
  invitation: { id: number; status: string; expiresAt: string } | null;
  warnings: string[];
}

/** `POST /residents`: the resident, its first link, its documents and the invitation, in one transaction (8.5). */
export async function createResident(
  ctx: Ctx,
  societyId: number,
  input: CreateResidentInput,
  o: { source?: ResidentSource } = {},
): Promise<CreatedResident> {
  if (input.invite && (!input.mobile || !input.link))
    throw rule(422, 'INVITE_NOT_POSSIBLE', 'To invite, add a mobile number and a flat', 'invite');
  const done = await sequelize.transaction(async t => {
    await checkNri(societyId, input, null, t);
    if (input.mobile) {
      const dup = await Resident.findOne({ where: { societyId, mobile: input.mobile }, transaction: t });
      if (dup) throw mobileExists(dup.id!);
    }
    const warnings: string[] = [];
    if (input.dateOfBirth && (await featureOn(societyId, FEATURE.duplicates))) {
      const same = await Resident.findAll({
        where: { societyId, name: input.name, dateOfBirth: input.dateOfBirth },
        attributes: ['id'],
        transaction: t,
      });
      for (const s of same) warnings.push(`POSSIBLE_DUPLICATE:${s.id}`);
    }
    if (input.photoFileId)
      await residentPorts().files.linkPhoto(ctx, { fileId: input.photoFileId, societyId }, t);
    let resident: Resident;
    try {
      resident = await Resident.create(
        {
          societyId,
          userId: null,
          memberId: null,
          name: input.name,
          mobile: input.mobile ?? null,
          alternateMobile: input.alternateMobile ?? null,
          email: input.email ?? null,
          dateOfBirth: input.dateOfBirth ?? null,
          gender: input.gender ?? null,
          photoFileId: input.photoFileId ?? null,
          preferredLanguage: input.preferredLanguage ?? 'en-IN',
          isNri: input.isNri ?? false,
          overseasPhone: input.overseasPhone ?? null,
          localRepresentativeResidentId: input.localRepresentativeResidentId ?? null,
          status: 'ACTIVE',
          source: o.source ?? 'ADMIN',
          directoryVisible: true,
          showMobileInDirectory: false,
          showEmailInDirectory: false,
          showPhotoInDirectory: false,
          adminNote: input.adminNote ?? null,
          anonymisedAt: null,
          version: 1,
          createdBy: ctx.user?.id ?? null,
          updatedBy: ctx.user?.id ?? null,
          deletedAt: null,
        },
        { transaction: t },
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        const dup = await Resident.findOne({ where: { societyId, mobile: input.mobile ?? '' } });
        throw mobileExists(dup?.id ?? 0);
      }
      throw err;
    }
    await audit(
      ctx,
      {
        action: AUDIT.residentCreated,
        entityType: ENTITY.resident,
        entityId: resident.id!,
        entityLabel: resident.name,
        societyId,
        after: {
          name: resident.name,
          mobile: resident.mobile,
          email: resident.email,
          source: resident.source,
        },
      },
      t,
    );
    let linkRows: UnitResident[] = [];
    if (input.link)
      linkRows = [
        await createLink(
          ctx,
          societyId,
          { ...input.link, residentId: resident.id!, source: o.source ?? 'ADMIN' },
          t,
        ),
      ];
    if (input.fileIds?.length)
      await attachDocuments(ctx, societyId, t, {
        residentId: resident.id!,
        unitId: input.link?.unitId ?? null,
        items: input.fileIds,
      });
    let invitation: CreatedResident['invitation'] = null;
    if (input.invite) {
      const r: InviteResult = await inviteResidentTx(ctx, societyId, resident.id!, {}, t);
      if (r.mode === 'INVITED') invitation = r.invitation;
    }
    touchReports(t, societyId);
    const fresh = (await Resident.findByPk(resident.id!, { transaction: t }))!;
    return { fresh, linkRows, invitation, warnings };
  });
  // read after the commit: the share shown for a sole owner depends on the owner links of the flat
  return {
    id: done.fresh.id!,
    name: done.fresh.name,
    mobile: done.fresh.mobile,
    status: done.fresh.status,
    version: done.fresh.version,
    links: await linkDtos(societyId, done.linkRows),
    invitation: done.invitation,
    warnings: done.warnings,
  };
}

// ------------------------------------------------------------------ list (8.2)
export interface ListResidentsQuery {
  q?: string;
  unitId?: number;
  buildingId?: number;
  relation?: LinkRelation;
  status?: 'ACTIVE' | 'INACTIVE';
  hasLogin?: boolean;
  kycStatus?: 'NONE' | 'PENDING' | 'VERIFIED' | 'REJECTED';
  sortBy: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
  page: number;
  limit: number;
}

const ID_LIST = ID_DOC_TYPES.map(t => `'${t}'`).join(',');

/** WHERE parts and replacements shared by the list and the CSV export. */
export function residentFilter(
  societyId: number,
  q: Omit<ListResidentsQuery, 'page' | 'limit' | 'sortBy' | 'sortOrder'>,
) {
  const where = ['r.societyId = :societyId', 'r.deletedAt IS NULL'];
  const rep: Record<string, unknown> = { societyId };
  if (q.status) {
    where.push('r.status = :status');
    rep.status = q.status;
  }
  if (q.hasLogin !== undefined) where.push(q.hasLogin ? 'r.userId IS NOT NULL' : 'r.userId IS NULL');
  if (q.q) {
    const term = q.q.trim();
    rep.prefix = `${term.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    const parts = ['r.name LIKE :prefix'];
    parts.push(
      `EXISTS (SELECT 1 FROM unit_residents x JOIN units xu ON xu.id = x.unitId WHERE x.residentId = r.id AND x.societyId = r.societyId AND xu.label LIKE :prefix)`,
    );
    if (/^\d{4,10}$/.test(term)) {
      rep.tail = term;
      parts.push('RIGHT(r.mobile, CHAR_LENGTH(:tail)) = :tail');
    }
    where.push(`(${parts.join(' OR ')})`);
  }
  if (q.unitId || q.buildingId || q.relation) {
    const c = ['x.residentId = r.id', 'x.societyId = r.societyId', 'x.toDate IS NULL'];
    if (q.unitId) {
      c.push('x.unitId = :unitId');
      rep.unitId = q.unitId;
    }
    if (q.buildingId) {
      c.push('xu.buildingId = :buildingId');
      rep.buildingId = q.buildingId;
    }
    if (q.relation) {
      c.push('x.relation = :relation');
      rep.relation = q.relation;
    }
    where.push(
      `EXISTS (SELECT 1 FROM unit_residents x JOIN units xu ON xu.id = x.unitId WHERE ${c.join(' AND ')})`,
    );
  }
  if (q.kycStatus === 'NONE')
    where.push(
      `NOT EXISTS (SELECT 1 FROM resident_documents d WHERE d.residentId = r.id AND d.deletedAt IS NULL AND d.docType IN (${ID_LIST}))`,
    );
  else if (q.kycStatus) {
    where.push(
      `EXISTS (SELECT 1 FROM resident_documents d WHERE d.residentId = r.id AND d.deletedAt IS NULL AND d.docType IN (${ID_LIST}) AND d.verificationStatus = :kyc)`,
    );
    rep.kyc = q.kycStatus;
  }
  return { sql: where.join(' AND '), rep };
}

/** The KYC state of each resident: VERIFIED beats PENDING beats REJECTED; NONE without an ID document. */
export async function kycStatusOf(societyId: number, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>(ids.map(i => [i, 'NONE']));
  if (!ids.length) return out;
  const docs = await ResidentDocument.findAll({
    where: { societyId, residentId: { [Op.in]: ids }, docType: { [Op.in]: [...ID_DOC_TYPES] } },
    attributes: ['residentId', 'verificationStatus'],
  });
  const rank: Record<string, number> = { NONE: 0, REJECTED: 1, PENDING: 2, VERIFIED: 3 };
  for (const d of docs) {
    const cur = out.get(d.residentId!)!;
    if (rank[d.verificationStatus]! > rank[cur]!) out.set(d.residentId!, d.verificationStatus);
  }
  return out;
}

export interface ResidentItem {
  id: number;
  name: string;
  mobile: string | null;
  email: string | null;
  status: string;
  hasLogin: boolean;
  isMinor: boolean;
  photoFileId: number | null;
  links: LinkDto[];
  kycStatus: string;
}

const canSeeContacts = (ctx: Ctx, r: Resident): boolean =>
  (ctx.permissions?.has('residents.contacts.view') ?? false) ||
  (r.userId !== null && r.userId === ctx.user?.id);

export async function listResidents(ctx: Ctx, societyId: number, q: ListResidentsQuery) {
  const f = residentFilter(societyId, q);
  const total = Number(
    (
      await sequelize.query<{ n: number }>(`SELECT COUNT(*) AS n FROM residents r WHERE ${f.sql}`, {
        replacements: f.rep,
        type: QueryTypes.SELECT,
      })
    )[0]?.n ?? 0,
  );
  const col = q.sortBy === 'name' ? 'r.name' : q.sortBy === 'createdAt' ? 'r.createdAt' : 'r.updatedAt';
  const dir = (q.sortOrder ?? (q.sortBy === 'name' ? 'asc' : 'desc')) === 'asc' ? 'ASC' : 'DESC';
  const idRows = await sequelize.query<{ id: number }>(
    `SELECT r.id FROM residents r WHERE ${f.sql} ORDER BY ${col} ${dir}, r.id ASC LIMIT :limit OFFSET :offset`,
    {
      replacements: { ...f.rep, limit: q.limit, offset: (q.page - 1) * q.limit },
      type: QueryTypes.SELECT,
    },
  );
  const ids = idRows.map(r => Number(r.id));
  const rows = await Resident.findAll({ where: { id: { [Op.in]: ids }, societyId } });
  const byId = new Map(rows.map(r => [r.id!, r]));
  const links = await UnitResident.findAll({
    where: { societyId, residentId: { [Op.in]: ids }, toDate: null },
    order: [['id', 'ASC']],
  });
  const dtos = await linkDtos(societyId, links);
  const kyc = await kycStatusOf(societyId, ids);
  const today = await societyToday(societyId);
  const data: ResidentItem[] = ids.map(id => {
    const r = byId.get(id)!;
    const reveal = canSeeContacts(ctx, r);
    return {
      id,
      name: r.name,
      mobile: reveal ? r.mobile : maskMobile(r.mobile),
      email: reveal ? r.email : maskMail(r.email),
      status: r.status,
      hasLogin: r.userId !== null,
      isMinor: isMinor(r.dateOfBirth, today),
      photoFileId: r.photoFileId,
      links: dtos.filter(d => links.some(l => l.id === d.linkId && l.residentId === id)),
      kycStatus: kyc.get(id) ?? 'NONE',
    };
  });
  return { data, pagination: pageMeta(q.page, q.limit, total) };
}

// ------------------------------------------------------------------ detail (8.6)
export async function getResident(ctx: Ctx, societyId: number, id: number, o: { reveal?: boolean } = {}) {
  const r = await Resident.findOne({ where: { id, societyId } });
  if (!r) throw residentNotFound();
  const own = r.userId !== null && r.userId === ctx.user?.id;
  if (o.reveal && !ctx.permissions?.has('residents.contacts.view'))
    throw new ForbiddenError('PERMISSION_DENIED', 'You do not have permission to see contact details');
  const reveal = own || Boolean(o.reveal);
  if (o.reveal && !own)
    await sequelize.transaction(t =>
      audit(
        ctx,
        {
          action: AUDIT.contactsRevealed,
          entityType: ENTITY.resident,
          entityId: id,
          societyId,
          entityLabel: r.name,
        },
        t,
      ),
    );
  const links = await UnitResident.findAll({
    where: { societyId, residentId: id },
    order: [
      ['toDate', 'ASC'],
      ['id', 'DESC'],
    ],
  });
  const kyc = await kycStatusOf(societyId, [id]);
  const docs = await ResidentDocument.findAll({
    where: { societyId, residentId: id },
    order: [['id', 'DESC']],
  });
  const profile = await EmergencyProfile.findOne({ where: { societyId, residentId: id } });
  const summary = r.userId ? await users.getUserSummary(r.userId).catch(() => null) : null;
  const today = await societyToday(societyId);
  const m = (v: string | null) => (reveal ? v : maskMobile(v));
  return {
    id,
    name: r.name,
    mobile: m(r.mobile),
    email: reveal ? r.email : maskMail(r.email),
    alternateMobile: m(r.alternateMobile),
    dateOfBirth: r.dateOfBirth,
    gender: r.gender,
    photoFileId: r.photoFileId,
    preferredLanguage: r.preferredLanguage,
    isNri: Boolean(r.isNri),
    overseasPhone: m(r.overseasPhone),
    localRepresentativeResidentId: r.localRepresentativeResidentId,
    status: r.status,
    source: r.source,
    hasLogin: r.userId !== null,
    isMinor: isMinor(r.dateOfBirth, today),
    directoryVisible: Boolean(r.directoryVisible),
    showMobileInDirectory: Boolean(r.showMobileInDirectory),
    showEmailInDirectory: Boolean(r.showEmailInDirectory),
    showPhotoInDirectory: Boolean(r.showPhotoInDirectory),
    adminNote: r.adminNote,
    userStatus: summary?.status ?? null,
    memberId: r.memberId,
    links: await linkDtos(societyId, links),
    kycStatus: kyc.get(id) ?? 'NONE',
    documents: docs.map(docDto),
    emergencyProfile: {
      exists: Boolean(profile),
      hasCareFlags: Boolean(profile && (profile.isSeniorCitizen || profile.isDifferentlyAbled)),
    },
    openRequests: await openRequestsOfResident(societyId, id),
    version: r.version,
    createdAt: r.createdAt!.toISOString(),
  };
}

// ------------------------------------------------------------------ edit (8.6 PATCH)
export type PatchResidentInput = Partial<ResidentFields> & { version: number };

export async function patchResident(ctx: Ctx, societyId: number, id: number, input: PatchResidentInput) {
  await sequelize.transaction(async t => {
    const r = await Resident.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!r) throw residentNotFound();
    if (r.version !== input.version) throw staleVersion('This resident');
    const { version: _version, ...fields } = input;
    void _version;
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (fields.mobile !== undefined && fields.mobile !== r.mobile) {
      if (r.userId !== null)
        throw rule(
          422,
          'MOBILE_MANAGED_BY_USER',
          'The person changes their mobile number in their own security settings',
          'mobile',
        );
      if (fields.mobile) {
        const dup = await Resident.findOne({
          where: { societyId, mobile: fields.mobile, id: { [Op.ne]: id } },
          transaction: t,
        });
        if (dup) throw mobileExists(dup.id!);
      }
    }
    await checkNri(
      societyId,
      {
        isNri: fields.isNri ?? false,
        overseasPhone: fields.overseasPhone ?? null,
        localRepresentativeResidentId: fields.localRepresentativeResidentId ?? null,
      },
      id,
      t,
    );
    if (fields.dateOfBirth !== undefined && fields.dateOfBirth !== r.dateOfBirth) {
      const today = await societyToday(societyId);
      if (isMinor(fields.dateOfBirth, today)) {
        const adult = await UnitResident.count({
          where: {
            societyId,
            residentId: id,
            toDate: null,
            ownershipTransferId: null,
            relation: { [Op.in]: ['OWNER', 'CO_OWNER', 'TENANT'] },
          },
          transaction: t,
        });
        if (adult)
          throw rule(
            422,
            'MINOR_NOT_ALLOWED',
            'This person holds a link that a minor cannot hold',
            'dateOfBirth',
          );
      }
    }
    if (fields.photoFileId && fields.photoFileId !== r.photoFileId)
      await residentPorts().files.linkPhoto(ctx, { fileId: fields.photoFileId, societyId }, t);
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      const cur = (r as unknown as Record<string, unknown>)[k];
      if (cur === v || (cur === null && v === null)) continue;
      before[k] = cur;
      after[k] = v;
      (r as unknown as Record<string, unknown>)[k] = v;
    }
    if (!Object.keys(after).length) return;
    r.version += 1;
    r.updatedBy = ctx.user?.id ?? null;
    try {
      await r.save({ transaction: t });
    } catch (err) {
      if (isUniqueViolation(err)) throw mobileExists(0);
      throw err;
    }
    await audit(
      ctx,
      {
        action: AUDIT.residentUpdated,
        entityType: ENTITY.resident,
        entityId: id,
        entityLabel: r.name,
        societyId,
        before,
        after,
      },
      t,
    );
    touchReports(t, societyId);
  });
  return getResident(ctx, societyId, id);
}

// ------------------------------------------------------------------ delete (BR-09-6)
export async function deleteResident(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { reason: string; version: number },
): Promise<void> {
  await sequelize.transaction(async t => {
    const r = await Resident.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!r) throw residentNotFound();
    if (r.version !== input.version) throw staleVersion('This resident');
    const why = await residentBlocker(societyId, id, r.userId, t);
    if (why) throw new AppError(409, 'RESIDENT_HAS_ACTIVE_LINKS', `This person cannot be deleted: ${why}`);
    const before = { name: r.name, mobile: r.mobile, email: r.email };
    // the login and the membership are released first so the mobile and the user are free again (BR-09-6)
    r.userId = null;
    r.memberId = null;
    r.version += 1;
    r.updatedBy = ctx.user?.id ?? null;
    await r.save({ transaction: t });
    await r.destroy({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.residentDeleted,
        entityType: ENTITY.resident,
        entityId: id,
        entityLabel: r.name,
        societyId,
        before,
        reason: input.reason,
      },
      t,
    );
    touchReports(t, societyId);
  });
}

/** The caller's own resident row in the society (own-record routes). */
export async function ownResident(ctx: Ctx, societyId: number): Promise<Resident> {
  const r = ctx.user ? await Resident.findOne({ where: { societyId, userId: ctx.user.id } }) : null;
  if (!r) throw residentNotFound();
  return r;
}

/** `POST /residents/:id/links` (8.8): one link for an existing resident, with the response of the link. */
export async function addLinkToResident(ctx: Ctx, societyId: number, residentId: number, input: LinkFields) {
  const l = await sequelize.transaction(async t => {
    const r = await Resident.findOne({ where: { id: residentId, societyId }, transaction: t });
    if (!r) throw residentNotFound();
    return createLink(ctx, societyId, { ...input, residentId }, t);
  });
  return (await linkDtos(societyId, [l]))[0]!;
}

/** The owner links of a unit with their people, for the answers of the shares and promote routes. */
export async function ownersOfUnit(societyId: number, unitId: number) {
  const links = await UnitResident.findAll({
    where: { societyId, unitId, toDate: null, relation: { [Op.in]: ['OWNER', 'CO_OWNER'] } },
    order: [['id', 'ASC']],
  });
  const names = new Map(
    (await Resident.findAll({ where: { societyId, id: { [Op.in]: links.map(l => l.residentId) } } })).map(
      r => [r.id!, r.name],
    ),
  );
  return (await linkDtos(societyId, links)).map(d => ({
    ...d,
    name: names.get(links.find(l => l.id === d.linkId)!.residentId) ?? '',
  }));
}
