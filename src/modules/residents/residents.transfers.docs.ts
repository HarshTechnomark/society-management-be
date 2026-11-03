import { Op, type Transaction } from 'sequelize';
import { ResidentDocument } from '../../models';
import { part3Ports } from './residents.part3.ports';
import type { TransferType } from './residents.part3.constants';

/** BR-09-63: the documents a transfer needs at submit. */
export function requiredDocs(type: TransferType | string, hasShareCertificate: boolean): string[] {
  const need: Record<string, string[]> = {
    SALE: ['SALE_DEED', 'INDEX_II'],
    GIFT: ['SALE_DEED'],
    INHERITANCE: ['DEATH_CERTIFICATE', 'SUCCESSION_CERTIFICATE'],
    NOMINATION: ['DEATH_CERTIFICATE'],
    COURT_ORDER: ['OTHER'],
    FAMILY_SETTLEMENT: ['OTHER'],
  };
  const list = [...(need[type] ?? []), 'MEMBERSHIP_APPLICATION'];
  if (hasShareCertificate) list.push('ORIGINAL_SHARE_CERTIFICATE');
  return list;
}

export interface TransferDocRef {
  id: number;
  unitId: number;
  transferType: string;
  status: string;
  buyersJson: { residentId: number; isPrimary: boolean }[];
}

/** The document types still missing for each transfer (empty once the transfer is closed). */
export async function missingDocuments(
  societyId: number,
  rows: TransferDocRef[],
  t?: Transaction,
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  const open = rows.filter(r => ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(r.status));
  for (const r of rows) if (!open.includes(r)) out.set(r.id, []);
  if (!open.length) return out;
  const docs = await ResidentDocument.findAll({
    where: { societyId, refType: 'ownership_transfer', refId: { [Op.in]: open.map(r => r.id) } },
    attributes: ['refId', 'docType', 'residentId', 'title'],
    transaction: t,
  });
  const certs = new Map<number, boolean>();
  for (const unitId of new Set(open.map(r => r.unitId)))
    certs.set(unitId, (await part3Ports().shareCertificates.currentForUnit(societyId, unitId)) !== null);
  for (const r of open) {
    const mine = docs.filter(d => d.refId === r.id);
    const primary = r.buyersJson.find(b => b.isPrimary)?.residentId;
    out.set(
      r.id,
      requiredDocs(r.transferType, certs.get(r.unitId) ?? false).filter(type =>
        type === 'MEMBERSHIP_APPLICATION'
          ? !mine.some(d => d.docType === type && d.residentId === primary)
          : type === 'OTHER'
            ? !mine.some(d => d.docType === 'OTHER' && (d.title ?? '').trim().length >= 2)
            : !mine.some(d => d.docType === type),
      ),
    );
  }
  return out;
}
