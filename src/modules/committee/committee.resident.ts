import { Op } from 'sequelize';
import { CommitteeTerm, User } from '../../models';
import { maskPhone } from '../../lib/logger';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { units } from '../society-setup/society-setup.public';
import { DESIGNATION_LABEL } from './committee.constants';
import { designationRank, isOverdueOf, seatedSeats } from './committee.planner';
import { findCurrent } from './committee.queries';
import { committeeSettings, societyToday } from './committee.shared';

/**
 * Resident committee page and past committees (8.12, 8.13, BR-10-28). Responses carry no user or member ids. Contacts are read
 * from module 02 at request time: the mobile is masked unless the viewer holds `residents.contacts.view` or it is their own.
 */
export async function myCommittee(ctx: Ctx, societyId: number) {
  const cfg = await committeeSettings(societyId);
  if (!cfg.showOnResidentApp) return { visible: false };
  const term = await findCurrent(societyId);
  if (!term) return { visible: true, term: null, members: [], vacancies: 0 };
  const today = await societyToday(societyId);
  const seated = seatedSeats(term.members);
  const shown = seated
    .filter(s => s.designation !== 'MEMBER' || s.showOnResidentPage)
    .sort(
      (a, b) =>
        designationRank(a.designation) - designationRank(b.designation) ||
        a.name.localeCompare(b.name) ||
        Number(a.seatId.slice(1)) - Number(b.seatId.slice(1)),
    );
  const userIds = [...new Set(shown.map(s => s.userId).filter((v): v is number => v !== null))];
  const unitIds = [...new Set(shown.map(s => s.unitId).filter((v): v is number => v !== null))];
  const [accounts, unitRows] = await Promise.all([
    userIds.length
      ? User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ['id', 'mobile', 'photoFileId'] })
      : [],
    Promise.all(unitIds.map(id => units.get(societyId, id))),
  ]);
  const account = new Map(accounts.map(u => [u.id!, u]));
  const label = new Map(unitRows.filter(Boolean).map(u => [u!.id, u!.label]));
  const reveal = ctx.permissions?.has('residents.contacts.view') ?? false;
  return {
    visible: true,
    term: {
      name: term.name,
      startDate: term.startDate,
      endDate: term.endDate,
      status: term.status,
      isOverdue: isOverdueOf(term, today),
    },
    members: shown.map(s => {
      const u = s.userId !== null ? account.get(s.userId) : undefined;
      const mobile = u?.mobile ?? null;
      return {
        name: s.name,
        designation: s.designation,
        designationLabel: DESIGNATION_LABEL[s.designation],
        joinMode: s.joinMode,
        unitLabel: s.unitId !== null ? (label.get(s.unitId) ?? null) : null,
        photoFileId: u?.photoFileId ?? null,
        mobile: mobile ? (reveal || s.userId === ctx.user?.id ? mobile : maskPhone(mobile)) : null,
        publicEmail: s.publicEmail,
        portfolios: s.portfolios,
        since: s.fromDate,
      };
    }),
    vacancies: Math.max(0, term.strength - seated.length),
  };
}

/** `GET /me/committee/history` (8.13): ENDED terms (past ones too), newest first, office bearers' names and dates only. */
export async function myCommitteeHistory(societyId: number, q: { page: number; limit: number }) {
  const cfg = await committeeSettings(societyId);
  if (!cfg.showOnResidentApp) return { data: [], pagination: pageMeta(q.page, q.limit, 0) };
  const { rows, count } = await CommitteeTerm.findAndCountAll({
    where: { societyId, status: 'ENDED' },
    order: [
      ['endDate', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return {
    data: rows.map(t => ({
      name: t.name,
      startDate: t.startDate,
      endDate: t.endDate,
      actualEndDate: t.actualEndDate,
      source: t.source,
      officeBearers: t.members
        .filter(s => s.designation !== 'MEMBER')
        .sort(
          (a, b) =>
            designationRank(a.designation) - designationRank(b.designation) ||
            (a.fromDate ?? '').localeCompare(b.fromDate ?? ''),
        )
        .map(s => ({
          designation: s.designation,
          designationLabel: DESIGNATION_LABEL[s.designation],
          name: s.name,
          fromDate: s.fromDate,
          toDate: s.toDate,
        })),
    })),
    pagination: pageMeta(q.page, q.limit, count),
  };
}
