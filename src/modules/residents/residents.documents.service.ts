import { Op, type Transaction } from 'sequelize';
import {
  JoinRequest,
  MoveRequest,
  OwnershipTransfer,
  RenovationPermit,
  Resident,
  ResidentDocument,
  Tenancy,
  UnitResident,
  sequelize,
} from '../../models';
import { audit } from '../../utils/audit';
import { AppError } from '../../utils/errors';
import { assertMakerChecker } from '../access-control/access-control.public';
import type { Ctx } from '../../types/context';
import {
  AUDIT,
  DOC_TYPES,
  ENTITY,
  OPEN_JOIN_STATUSES,
  OPEN_MOVE_STATUSES,
  OPEN_PERMIT_STATUSES,
  OPEN_TRANSFER_STATUSES,
  isIdDoc,
  isKycDoc,
  type DocRefType,
  type DocType,
} from './residents.constants';
import { notifyAfterCommit, recipients } from './residents.notify';
import { residentPorts, touchReports } from './residents.ports';
import {
  docPurpose,
  documentNotFound,
  invalidState,
  residentNotFound,
  rule,
  societyToday,
  staleVersion,
} from './residents.shared';

/** KYC and request documents (sections 5.5 and 8.11). Only the last 4 characters of an ID number are ever stored. */
export interface DocInput {
  fileId: number;
  docType: DocType;
  title?: string | null;
  idLast4?: string | null;
  expiresOn?: string | null;
  unitId?: number | null;
}

export const docDto = (d: ResidentDocument) => ({
  id: d.id!,
  residentId: d.residentId,
  unitId: d.unitId,
  refType: d.refType,
  refId: d.refId,
  docType: d.docType,
  title: d.title,
  idLast4: d.idLast4,
  expiresOn: d.expiresOn,
  verificationStatus: d.verificationStatus,
  verifiedAt: d.verifiedAt ? d.verifiedAt.toISOString() : null,
  rejectReason: d.rejectReason,
  uploadedAt: d.createdAt!.toISOString(),
  version: d.version,
});

/** Links the files and inserts the rows, in the caller's transaction. Used by resident create and by parts 2 and 3. */
export async function attachDocuments(
  ctx: Ctx,
  societyId: number,
  t: Transaction,
  p: {
    residentId: number | null;
    unitId?: number | null;
    refType?: DocRefType | null;
    refId?: number | null;
    items: DocInput[];
    uploaderUserId?: number;
  },
): Promise<ResidentDocument[]> {
  const uploader = p.uploaderUserId ?? ctx.user?.id;
  if (!uploader) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  const today = await societyToday(societyId);
  const out: ResidentDocument[] = [];
  for (const [i, it] of p.items.entries()) {
    const f = (m: string) => `fileIds.${i}.${m}`;
    if (!(DOC_TYPES as readonly string[]).includes(it.docType))
      throw rule(422, 'DOCUMENT_TYPE_NOT_ALLOWED', 'This document type is not allowed', f('docType'));
    if (it.docType === 'OTHER' && (!it.title || it.title.trim().length < 2))
      throw rule(422, 'DOCUMENT_TYPE_NOT_ALLOWED', 'Give the document a title', f('title'));
    if (it.idLast4 && !isIdDoc(it.docType))
      throw rule(
        422,
        'DOCUMENT_TYPE_NOT_ALLOWED',
        'Only an ID document has the last 4 characters',
        f('idLast4'),
      );
    if (it.expiresOn && it.expiresOn <= today)
      throw rule(422, 'DOCUMENT_TYPE_NOT_ALLOWED', 'The expiry date must be in the future', f('expiresOn'));
    await residentPorts().files.linkDocument(
      ctx,
      { fileId: it.fileId, purpose: docPurpose(it.docType), societyId, uploaderUserId: uploader },
      t,
    );
    const doc = await ResidentDocument.create(
      {
        societyId,
        residentId: p.residentId,
        unitId: it.unitId ?? p.unitId ?? null,
        refType: p.refType ?? null,
        refId: p.refId ?? null,
        docType: it.docType,
        fileId: it.fileId,
        title: it.title ?? null,
        idLast4: it.idLast4 ?? null,
        expiresOn: it.expiresOn ?? null,
        verificationStatus: 'PENDING',
        verifiedBy: null,
        verifiedAt: null,
        rejectReason: null,
        uploadedByUserId: uploader,
        version: 1,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.documentUploaded,
        entityType: ENTITY.document,
        entityId: doc.id!,
        societyId,
        after: { residentId: p.residentId, docType: it.docType, refType: p.refType ?? null },
      },
      t,
    );
    out.push(doc);
  }
  return out;
}

export async function listDocuments(societyId: number, residentId: number) {
  if (!(await Resident.count({ where: { id: residentId, societyId } }))) throw residentNotFound();
  const rows = await ResidentDocument.findAll({
    where: { societyId, residentId },
    order: [['id', 'DESC']],
  });
  return rows.map(docDto);
}

/** `POST /residents/:id/documents` (admin) and `POST /me/documents` (own record, only the types of `SELF_DOC_TYPES`). */
export async function uploadDocument(ctx: Ctx, societyId: number, residentId: number, input: DocInput) {
  return sequelize.transaction(async t => {
    const r = await Resident.findOne({ where: { id: residentId, societyId }, transaction: t });
    if (!r) throw residentNotFound();
    if (input.unitId) {
      const linked = await UnitResident.count({
        where: { societyId, residentId, unitId: input.unitId },
        transaction: t,
      });
      if (!linked)
        throw rule(422, 'DOCUMENT_TYPE_NOT_ALLOWED', 'The person is not linked to that flat', 'unitId');
    }
    const [doc] = await attachDocuments(ctx, societyId, t, { residentId, items: [input] });
    touchReports(t, societyId);
    return docDto(doc!);
  });
}

// ------------------------------------------------------------------ verify (BR-09-39)
export async function verifyDocument(
  ctx: Ctx,
  societyId: number,
  docId: number,
  input: { decision: 'VERIFIED' | 'REJECTED'; reason?: string; version: number },
) {
  return sequelize.transaction(async t => {
    const d = await ResidentDocument.findOne({
      where: { id: docId, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!d) throw documentNotFound();
    if (d.version !== input.version) throw staleVersion('This document');
    if (d.verificationStatus !== 'PENDING') throw invalidState('This document has already been checked');
    assertMakerChecker(ctx, d.uploadedByUserId);
    if (input.decision === 'REJECTED' && !input.reason)
      throw rule(422, 'VERIFICATION_DETAILS_REQUIRED', 'Give the reason for rejecting it', 'reason');
    d.verificationStatus = input.decision;
    d.verifiedBy = ctx.user?.id ?? null;
    d.verifiedAt = new Date();
    d.rejectReason = input.decision === 'REJECTED' ? (input.reason ?? null) : null;
    d.version += 1;
    d.updatedBy = ctx.user?.id ?? null;
    await d.save({ transaction: t });
    await audit(
      ctx,
      {
        action: input.decision === 'VERIFIED' ? AUDIT.documentVerified : AUDIT.documentRejected,
        entityType: ENTITY.document,
        entityId: d.id!,
        societyId,
        after: { docType: d.docType, residentId: d.residentId },
        reason: input.reason ?? null,
      },
      t,
    );
    if (input.decision === 'REJECTED' && d.residentId) {
      const r = await Resident.findByPk(d.residentId, { transaction: t });
      if (r?.userId)
        notifyAfterCommit(t, 'residents.document_rejected', societyId, recipients.users([r.userId]), {
          docType: d.docType,
          reason: input.reason,
          link: '/documents',
        });
    }
    touchReports(t, societyId);
    return docDto(d);
  });
}

// ------------------------------------------------------------------ delete
async function referencedByPending(societyId: number, refType: string, refId: number): Promise<boolean> {
  const idWhere = { id: refId, societyId };
  switch (refType) {
    case 'join_request':
      return (
        (await JoinRequest.count({ where: { ...idWhere, status: { [Op.in]: [...OPEN_JOIN_STATUSES] } } })) > 0
      );
    case 'tenancy':
      return (
        (await Tenancy.count({ where: { ...idWhere, status: { [Op.in]: ['DRAFT', 'PENDING_APPROVAL'] } } })) >
        0
      );
    case 'move_request':
      return (
        (await MoveRequest.count({ where: { ...idWhere, status: { [Op.in]: [...OPEN_MOVE_STATUSES] } } })) > 0
      );
    case 'renovation_permit':
      return (
        (await RenovationPermit.count({
          where: { ...idWhere, status: { [Op.in]: [...OPEN_PERMIT_STATUSES] } },
        })) > 0
      );
    case 'ownership_transfer':
      return (
        (await OwnershipTransfer.count({
          where: { ...idWhere, status: { [Op.in]: [...OPEN_TRANSFER_STATUSES] } },
        })) > 0
      );
    default:
      return false;
  }
}

export async function deleteDocument(
  ctx: Ctx,
  societyId: number,
  docId: number,
  reason: string,
): Promise<void> {
  await sequelize.transaction(async t => {
    const d = await ResidentDocument.findOne({
      where: { id: docId, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!d) throw documentNotFound();
    if (d.refType && d.refId && (await referencedByPending(societyId, d.refType, d.refId)))
      throw new AppError(409, 'DOCUMENT_IN_USE', 'This document is attached to a pending request');
    await d.destroy({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.documentDeleted,
        entityType: ENTITY.document,
        entityId: docId,
        societyId,
        before: { docType: d.docType, residentId: d.residentId },
        reason,
      },
      t,
    );
    const fileId = d.fileId;
    t.afterCommit(() => {
      void residentPorts().files.deleteFile(fileId);
    });
    touchReports(t, societyId);
  });
}

// ------------------------------------------------------------------ download (BR-09-38)
/** May the caller download this document? Never answers 403: the caller gets 404 instead. */
function mayDownload(ctx: Ctx, d: ResidentDocument, ownerUserId: number | null): boolean {
  const userId = ctx.user?.id;
  const has = (k: string) => ctx.permissions?.has(k) ?? false;
  if (isKycDoc(d.docType))
    return (
      (userId !== undefined && ownerUserId === userId) ||
      (has('residents.people.view') && has('residents.contacts.view'))
    );
  if (userId !== undefined && d.uploadedByUserId === userId) return true;
  if (
    d.unitId &&
    (ctx.unitLinks ?? []).some(
      l => l.unitId === d.unitId && (l.relation === 'OWNER' || l.relation === 'TENANT'),
    )
  )
    return true;
  return has('residents.people.view') || has('residents.requests.view');
}

export async function downloadUrl(
  ctx: Ctx,
  societyId: number,
  docId: number,
  disposition: 'inline' | 'attachment',
  o: { ownOnly?: boolean } = {},
) {
  const d = await ResidentDocument.findOne({ where: { id: docId, societyId } });
  if (!d) throw documentNotFound();
  const owner = d.residentId ? await Resident.findOne({ where: { id: d.residentId, societyId } }) : null;
  if (o.ownOnly) {
    if (!owner || owner.userId === null || owner.userId !== ctx.user?.id) throw documentNotFound();
  } else if (!mayDownload(ctx, d, owner?.userId ?? null)) throw documentNotFound();
  const link = await residentPorts().files.downloadUrl(ctx, d.fileId, { disposition });
  await sequelize.transaction(t =>
    audit(
      ctx,
      {
        action: AUDIT.documentDownloaded,
        entityType: ENTITY.document,
        entityId: d.id!,
        societyId,
        after: { docType: d.docType, disposition },
      },
      t,
    ),
  );
  return { url: link.url, expiresAt: link.expiresAt.toISOString() };
}
