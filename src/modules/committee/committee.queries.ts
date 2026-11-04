import { Op } from 'sequelize';
import { CommitteeTerm } from '../../models';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import type { Designation } from './committee.constants';
import { currentDto, draftDto, listItemDto, termDetail } from './committee.dto';
import { bannerFor, seatedSeats } from './committee.planner';
import { societyToday, termNotFound } from './committee.shared';

/** Reads of 8.1 and 8.2 and the service API of 9.2. Every query is scoped to the society (section 13). */
export const findCurrent = (societyId: number) =>
  CommitteeTerm.findOne({ where: { societyId, status: { [Op.in]: ['ACTIVE', 'EXPIRED'] } } });
export const findDraft = (societyId: number) =>
  CommitteeTerm.findOne({ where: { societyId, status: 'DRAFT' } });

/** `GET /committee` (8.1). */
export async function overview(societyId: number) {
  const [today, current, draft] = [
    await societyToday(societyId),
    await findCurrent(societyId),
    await findDraft(societyId),
  ];
  return {
    current: current ? currentDto(current, today) : null,
    draft: draft ? draftDto(draft) : null,
    banner: bannerFor(
      current,
      draft ? { id: draft.id!, source: draft.source, electionId: draft.electionId } : null,
      today,
    ),
  };
}

export interface ListTermsQuery {
  status?: 'DRAFT' | 'ACTIVE' | 'EXPIRED' | 'ENDED';
  source?: 'MANUAL' | 'ELECTION' | 'HISTORICAL';
  sortBy: 'startDate' | 'createdAt';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

/** `GET /committee/terms` (8.2). */
export async function listTerms(societyId: number, q: ListTermsQuery) {
  const where: Record<string, unknown> = { societyId };
  if (q.status) where.status = q.status;
  if (q.source) where.source = q.source;
  const { rows, count } = await CommitteeTerm.findAndCountAll({
    where,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', q.sortOrder.toUpperCase()],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: rows.map(listItemDto), pagination: pageMeta(q.page, q.limit, count) };
}

/** `GET /committee/terms/:id` (8.2). */
export async function getTerm(ctx: Ctx, societyId: number, id: number) {
  const term = await CommitteeTerm.findOne({ where: { id, societyId } });
  if (!term) throw termNotFound();
  return termDetail(ctx, term, await societyToday(societyId));
}

// ------------------------------------------------------------------ service API of section 9.2 (modules 14, 16, 22, 24, 25)
export async function getCurrent(societyId: number) {
  const t = await findCurrent(societyId);
  if (!t) return null;
  return {
    termId: t.id!,
    name: t.name,
    status: t.status as 'ACTIVE' | 'EXPIRED',
    startDate: t.startDate,
    endDate: t.endDate,
    seats: seatedSeats(t.members).map(s => ({
      seatId: s.seatId,
      userId: s.userId!,
      memberId: s.memberId!,
      designation: s.designation,
      joinMode: s.joinMode,
      fromDate: s.fromDate!,
    })),
  };
}

export async function listSeatedUserIds(societyId: number, designations?: Designation[]): Promise<number[]> {
  const cur = await getCurrent(societyId);
  if (!cur) return [];
  const ids = cur.seats.filter(s => !designations || designations.includes(s.designation)).map(s => s.userId);
  return [...new Set(ids)];
}

export async function isSeated(
  societyId: number,
  userId: number,
): Promise<{ seated: boolean; designation: Designation | null }> {
  const cur = await getCurrent(societyId);
  const seat = cur?.seats.find(s => s.userId === userId);
  return { seated: Boolean(seat), designation: seat?.designation ?? null };
}
