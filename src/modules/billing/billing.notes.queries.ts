import { Op, type WhereOptions } from 'sequelize';
import { BillingNote, Invoice } from '../../models';
import { pageMeta } from '../../utils/pagination';
import { loadNoteDto, noteDto } from './billing.notes.shared';

/** Credit and debit note reads (8.19). */
export interface NoteListQuery {
  page: number;
  limit: number;
  noteType?: 'CREDIT' | 'DEBIT';
  status?: string;
  reasonCode?: string;
  invoiceId?: number;
  unitId?: number;
  from?: string;
  to?: string;
  sortBy: 'createdAt' | 'noteDate' | 'totalPaise';
  sortOrder: 'asc' | 'desc';
}

export async function listNotes(societyId: number, q: NoteListQuery) {
  const and: WhereOptions[] = [{ societyId }];
  if (q.noteType) and.push({ noteType: q.noteType });
  if (q.status) and.push({ status: q.status });
  if (q.reasonCode) and.push({ reasonCode: q.reasonCode });
  if (q.invoiceId) and.push({ invoiceId: q.invoiceId });
  if (q.unitId) and.push({ unitId: q.unitId });
  if (q.from) and.push({ noteDate: { [Op.gte]: q.from } });
  if (q.to) and.push({ noteDate: { [Op.lte]: q.to } });
  const dir = q.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const { rows, count } = await BillingNote.findAndCountAll({
    where: { [Op.and]: and },
    order: [
      [q.sortBy, dir],
      ['id', dir],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const invoices = new Map(
    (
      await Invoice.findAll({
        where: { societyId, id: { [Op.in]: [...new Set(rows.map(r => Number(r.invoiceId)))] } },
        attributes: ['id', 'invoiceNo', 'unitLabel'],
      })
    ).map(i => [Number(i.id), i]),
  );
  return {
    data: rows.map(n => {
      const inv = invoices.get(Number(n.invoiceId));
      return noteDto(n, { invoiceNo: inv?.invoiceNo ?? '', unitLabel: inv?.unitLabel ?? '' });
    }),
    pagination: pageMeta(q.page, q.limit, count),
  };
}

export const getNote = (societyId: number, id: number) => loadNoteDto(societyId, id);
