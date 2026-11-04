import { Op } from 'sequelize';
import { CommitteeTerm, User } from '../../models';
import { maskPhone } from '../../lib/logger';
import type { Ctx } from '../../types/context';
import { members } from '../access-control/access-control.public';
import { units } from '../society-setup/society-setup.public';
import { DESIGNATION_ROLE, type Designation } from './committee.constants';
import {
  daysLeftOf,
  designationRank,
  isOverdueOf,
  occupying,
  seatedSeats,
  vacantDesignations,
} from './committee.planner';
import type { HandoverItemJson, SeatJson } from './committee.schemas';

/** Response shapes of 8.1 and 8.2. Live values (`roleKey`, `unitLabel`, `photoFileId`, `mobile`) are read at request time. */
export function handoverSummary(items: HandoverItemJson[], completedAt: Date | null) {
  return {
    total: items.length,
    done: items.filter(i => i.status === 'DONE').length,
    notApplicable: items.filter(i => i.status === 'NOT_APPLICABLE').length,
    completedAt,
  };
}

export const officeBearersOf = (
  status: string,
  seats: SeatJson[],
): { designation: Designation; name: string }[] =>
  (status === 'DRAFT' ? seats.filter(s => s.status === 'PLANNED') : occupying(status, seats))
    .filter(s => s.designation !== 'MEMBER')
    .sort((a, b) => designationRank(a.designation) - designationRank(b.designation))
    .map(s => ({ designation: s.designation, name: s.name }));

export function listItemDto(t: CommitteeTerm) {
  const seats = t.members;
  return {
    id: t.id!,
    name: t.name,
    kind: t.kind,
    source: t.source,
    status: t.status,
    startDate: t.startDate,
    endDate: t.endDate,
    actualEndDate: t.actualEndDate,
    tookChargeOn: t.tookChargeOn,
    strength: t.strength,
    seatedCount: occupying(t.status, seats).length,
    officeBearers: officeBearersOf(t.status, seats),
    electionId: t.electionId,
    version: t.version,
  };
}

/** 8.1 `current`. */
export function currentDto(t: CommitteeTerm, today: string) {
  const seats = t.members;
  const seated = seatedSeats(seats).length;
  return {
    id: t.id!,
    name: t.name,
    kind: t.kind,
    source: t.source,
    status: t.status,
    startDate: t.startDate,
    endDate: t.endDate,
    tookChargeOn: t.tookChargeOn,
    daysLeft: daysLeftOf(t, today),
    isOverdue: isOverdueOf(t, today),
    strength: t.strength,
    seatedCount: seated,
    vacancies: Math.max(0, t.strength - seated),
    vacantDesignations: vacantDesignations(seats),
    handover: {
      total: t.handoverChecklist.length,
      done: handoverSummary(t.handoverChecklist, null).done,
      completedAt: t.handoverCompletedAt,
    },
    attentionCount: seatedSeats(seats).filter(s => s.flags.length > 0).length,
    version: t.version,
  };
}

/** 8.1 `draft` (the spec does not list its fields). */
export const draftDto = (t: CommitteeTerm) => ({
  id: t.id!,
  name: t.name,
  kind: t.kind,
  source: t.source,
  startDate: t.startDate,
  endDate: t.endDate,
  strength: t.strength,
  seatCount: t.members.length,
  electionId: t.electionId,
  version: t.version,
});

/** 8.2 detail: seats with the live fields. The mobile is masked unless the caller holds `residents.contacts.view` or it is theirs. */
export async function termDetail(ctx: Ctx, t: CommitteeTerm, today: string) {
  const seats = t.members;
  const userIds = [...new Set(seats.map(s => s.userId).filter((v): v is number => v !== null))];
  const unitIds = [...new Set(seats.map(s => s.unitId).filter((v): v is number => v !== null))];
  const [accounts, roles, unitRows, successor] = await Promise.all([
    userIds.length
      ? User.findAll({ where: { id: { [Op.in]: userIds } }, attributes: ['id', 'mobile', 'photoFileId'] })
      : [],
    userIds.length ? members.listForSociety(t.societyId, { userIds }) : [],
    Promise.all(unitIds.map(id => units.get(t.societyId, id))),
    CommitteeTerm.findOne({ where: { predecessorTermId: t.id! }, attributes: ['id'] }),
  ]);
  const account = new Map(accounts.map(u => [u.id!, u]));
  const role = new Map(roles.map(r => [r.userId, r.roleKey]));
  const label = new Map(unitRows.filter(Boolean).map(u => [u!.id, u!.label]));
  const reveal = ctx.permissions?.has('residents.contacts.view') ?? false;
  const ordered = [...seats].sort((a, b) => Number(a.seatId.slice(1)) - Number(b.seatId.slice(1)));
  return {
    id: t.id!,
    name: t.name,
    kind: t.kind,
    source: t.source,
    status: t.status,
    startDate: t.startDate,
    endDate: t.endDate,
    actualEndDate: t.actualEndDate,
    tookChargeOn: t.tookChargeOn,
    strength: t.strength,
    resolutionRef: t.resolutionRef,
    notes: t.notes,
    predecessorTermId: t.predecessorTermId,
    successorTermId: successor?.id ?? null,
    electionId: t.electionId,
    daysLeft: daysLeftOf(t, today),
    isOverdue: isOverdueOf(t, today),
    seats: ordered.map(s => {
      const u = s.userId !== null ? account.get(s.userId) : undefined;
      const mobile = u?.mobile ?? null;
      return {
        seatId: s.seatId,
        userId: s.userId,
        memberId: s.memberId,
        name: s.name,
        designation: s.designation,
        joinMode: s.joinMode,
        unitId: s.unitId,
        unitLabel: s.unitId !== null ? (label.get(s.unitId) ?? null) : null,
        portfolios: s.portfolios,
        mobile: mobile ? (reveal || s.userId === ctx.user?.id ? mobile : maskPhone(mobile)) : null,
        publicEmail: s.publicEmail,
        photoFileId: u?.photoFileId ?? null,
        showOnResidentPage: s.showOnResidentPage,
        status: s.status,
        fromDate: s.fromDate,
        toDate: s.toDate,
        roleKey: s.userId !== null && s.status !== 'LEFT' ? (role.get(s.userId) ?? null) : null,
        expectedRoleKey: DESIGNATION_ROLE[s.designation],
        roleBeforeKey: s.roleBeforeKey,
        replaceExistingRole: s.replaceExistingRole,
        exitReason: s.exitReason,
        exitNote: s.exitNote,
        resolutionRef: s.resolutionRef,
        flags: s.flags,
      };
    }),
    handover: handoverSummary(t.handoverChecklist, t.handoverCompletedAt),
    version: t.version,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}
