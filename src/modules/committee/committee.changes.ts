import { CommitteeTerm, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { settings } from '../society-setup/society-setup.public';
import { AUDIT, ENTITY, FEATURE, MAX_SEATS_STORED, type Designation } from './committee.constants';
import { termDetail } from './committee.dto';
import { nameOfUser, type HolderToCheck } from './committee.holders';
import {
  addDaysYmd,
  duplicateProblem,
  nextSeatId,
  seatedSeats,
  type IncomingHolder,
  type OutgoingHolder,
} from './committee.planner';
import {
  assertHash,
  createDelegations,
  evaluatePlan,
  previewBody,
  runActions,
  throwFirstBlocker,
  type PlanInput,
  type PlanResult,
} from './committee.plan';
import { announce } from './committee.notify';
import type { SeatJson } from './committee.schemas';
import { assertStored, newSeat } from './committee.seats';
import { lockTerm, seatsForAudit } from './committee.service';
import {
  assertFeatureFor,
  committeeSettings,
  emitChanged,
  invalidState,
  rule,
  seatNotFound,
  societyToday,
  staleVersion,
  termNotFound,
} from './committee.shared';
import { DESIGNATION_LABEL } from './committee.constants';

/** Mid-term changes (8.9, section 6.4): co-opt, nominate, appoint, redesignate and vacate on the current term. */
export interface ChangeInput {
  op: 'ADD' | 'REDESIGNATE' | 'VACATE';
  seatId?: string;
  userId?: number;
  designation?: Designation;
  joinMode?: 'ELECTED' | 'CO_OPTED' | 'NOMINATED' | 'APPOINTED';
  unitId?: number;
  portfolios?: SeatJson['portfolios'];
  publicEmail?: string;
  replaceExistingRole?: boolean;
  resolutionRef?: string;
  exitReason?: 'RESIGNED' | 'REMOVED' | 'DECEASED' | 'DISQUALIFIED';
  note?: string;
}
export interface ChangesInput {
  version: number;
  effectiveDate?: string;
  changes: ChangeInput[];
}

interface Event {
  op: ChangeInput['op'];
  seat: SeatJson;
  /** The new seat (ADD, REDESIGNATE) or the closed seat (VACATE). */
  next: SeatJson;
  fromDesignation?: Designation;
}
interface Planned {
  input: PlanInput;
  result: PlanResult;
  seats: SeatJson[];
  events: Event[];
  effective: string;
  ins: IncomingHolder[];
}

const changeInvalid = (message: string, seatIds?: string[]) =>
  rule('COMMITTEE_CHANGE_INVALID', message, 'changes', seatIds ? { seatIds } : {});

async function planChanges(
  ctx: Ctx,
  societyId: number,
  term: CommitteeTerm,
  body: ChangesInput,
  today: string,
): Promise<Planned> {
  if (term.status !== 'ACTIVE' && term.status !== 'EXPIRED')
    throw invalidState('Changes can only be made to the current committee');
  const cfg = await committeeSettings(societyId);
  const effective = body.effectiveDate ?? today;
  const floor = term.tookChargeOn ?? term.startDate;
  if (effective > today || effective < floor)
    throw rule(
      'COMMITTEE_TERM_DATES_INVALID',
      `The effective date must be between ${floor} and today`,
      'effectiveDate',
    );
  const stored = term.members;
  let seats = stored.map(s => ({ ...s }));
  const ever: Pick<SeatJson, 'seatId'>[] = [...stored];
  const outs: OutgoingHolder[] = [];
  const ins: IncomingHolder[] = [];
  const eligibility: HolderToCheck[] = [];
  const events: Event[] = [];
  const used = new Set<string>();
  const replace = (next: SeatJson) => {
    seats = seats.map(s => (s.seatId === next.seatId ? next : s));
  };
  const newId = (): string => {
    const id = nextSeatId(ever);
    ever.push({ seatId: id });
    return id;
  };

  for (const c of body.changes) {
    if (c.op === 'ADD') {
      if (c.joinMode === 'ELECTED')
        throw changeInvalid('A member joining mid-term is co-opted, nominated or appointed, never elected');
      if (c.joinMode === 'CO_OPTED' && !cfg.coOptionAllowed)
        throw rule('COMMITTEE_COOPTION_NOT_ALLOWED', 'Co-option is switched off for this society', 'changes');
      const seatId = newId();
      const name = await nameOfUser(c.userId!);
      const seat = newSeat({
        seatId,
        userId: c.userId!,
        unitId: c.unitId ?? null,
        name,
        designation: c.designation!,
        joinMode: c.joinMode as 'CO_OPTED' | 'NOMINATED' | 'APPOINTED',
        portfolios: c.portfolios ?? [],
        publicEmail: c.publicEmail ?? null,
        showOnResidentPage: true,
        status: 'SEATED',
        fromDate: effective,
        replaceExistingRole: c.replaceExistingRole ?? false,
        resolutionRef: c.resolutionRef ?? null,
      });
      seats.push(seat);
      events.push({ op: 'ADD', seat, next: seat });
      eligibility.push({ seatId, userId: seat.userId, unitId: seat.unitId });
      ins.push({
        userId: seat.userId!,
        name,
        designation: seat.designation,
        seatId,
        replaceExistingRole: seat.replaceExistingRole,
        continuing: null,
      });
      continue;
    }
    if (used.has(c.seatId!))
      throw changeInvalid('A seat can appear only once in a set of changes', [c.seatId!]);
    used.add(c.seatId!);
    const seat = seats.find(s => s.seatId === c.seatId);
    if (!seat) throw seatNotFound();
    if (seat.status !== 'SEATED') throw invalidState('This seat is closed');
    if (effective < seat.fromDate!)
      throw rule(
        'COMMITTEE_TERM_DATES_INVALID',
        `The effective date cannot be before the seat started (${seat.fromDate})`,
        'effectiveDate',
      );
    if (c.op === 'VACATE') {
      const closed: SeatJson = {
        ...seat,
        status: 'LEFT',
        exitReason: c.exitReason!,
        exitNote: c.note ?? null,
        toDate: effective,
        flags: [],
      };
      replace(closed);
      events.push({ op: 'VACATE', seat, next: closed });
      outs.push({ userId: seat.userId!, name: seat.name, seat });
      continue;
    }
    // REDESIGNATE (BR-10-21)
    if (c.designation === seat.designation)
      throw changeInvalid('Pick a different designation', [seat.seatId]);
    const show = c.designation === 'MEMBER' ? seat.showOnResidentPage : true;
    let next: SeatJson;
    if (effective === seat.fromDate) {
      next = { ...seat, designation: c.designation!, showOnResidentPage: show };
      replace(next);
    } else {
      replace({
        ...seat,
        status: 'LEFT',
        exitReason: 'REDESIGNATED',
        exitNote: null,
        toDate: addDaysYmd(effective, -1),
        flags: [],
      });
      next = {
        ...seat,
        seatId: newId(),
        designation: c.designation!,
        showOnResidentPage: show,
        fromDate: effective,
        exitReason: null,
        exitNote: null,
        toDate: null,
        resolutionRef: null,
        flags: [],
      };
      seats.push(next);
    }
    events.push({ op: 'REDESIGNATE', seat, next, fromDesignation: seat.designation });
    ins.push({
      userId: seat.userId!,
      name: seat.name,
      designation: next.designation,
      seatId: next.seatId,
      replaceExistingRole: next.replaceExistingRole,
      continuing: seat,
    });
  }

  if (seats.length > MAX_SEATS_STORED)
    throw rule('COMMITTEE_SEAT_LIMIT', `A term holds at most ${MAX_SEATS_STORED} seat entries`, 'changes');
  const dup = duplicateProblem(seats);
  if (dup) throw rule(dup.code, dup.message, 'changes', { seatIds: dup.seatIds });
  const seated = seatedSeats(seats);
  if (!seated.some(s => s.designation === 'CHAIRMAN'))
    throw rule('COMMITTEE_CHAIRMAN_REQUIRED', 'The committee must keep a Chairman', 'changes');
  if (seated.length > term.strength)
    throw rule(
      'COMMITTEE_STRENGTH_INVALID',
      `The committee has ${term.strength} seats and no vacancy for this change`,
      'changes',
    );

  const input: PlanInput = {
    ctx,
    societyId,
    termId: term.id!,
    termVersion: term.version,
    currentTermId: term.id!,
    currentTermVersion: term.version,
    outs,
    ins,
    eligibility,
    before: seatedSeats(stored),
    after: seated,
    authority: 'ENFORCE',
    ownersOnly: cfg.ownersOnly,
  };
  return { input, result: await evaluatePlan(input), seats, events, effective, ins };
}

/** `POST /committee/terms/:id/changes/preview` (8.9). No side effects, no step-up. */
export async function changesPreview(ctx: Ctx, societyId: number, id: number, body: ChangesInput) {
  await assertFeatureFor(societyId, FEATURE.officeBearers);
  const term = await CommitteeTerm.findOne({ where: { id, societyId } });
  if (!term) throw termNotFound();
  if (term.version !== body.version && (term.status === 'ACTIVE' || term.status === 'EXPIRED'))
    throw staleVersion();
  const today = await societyToday(societyId);
  const p = await planChanges(ctx, societyId, term, body, today);
  const days = await settings.get(societyId, 'committee.handoverDelegationDays');
  return {
    ...(await previewBody(p.input, p.result, days)),
    seats: p.seats.map(s => ({
      seatId: s.seatId,
      name: s.name,
      designation: s.designation,
      status: s.status,
      fromDate: s.fromDate,
      toDate: s.toDate,
    })),
  };
}

export interface ApplyChangesInput extends ChangesInput {
  previewHash: string;
  reason: string;
}

/** `POST /committee/terms/:id/changes` (8.9, section 6.4). */
export async function applyChanges(ctx: Ctx, societyId: number, id: number, body: ApplyChangesInput) {
  await assertFeatureFor(societyId, FEATURE.officeBearers);
  const today = await societyToday(societyId);
  const { term, summary } = await sequelize.transaction(async t => {
    const term = await lockTerm(societyId, id, t);
    if (term.status !== 'ACTIVE' && term.status !== 'EXPIRED')
      throw invalidState('Changes can only be made to the current committee');
    if (term.version !== body.version) throw staleVersion();
    const p = await planChanges(ctx, societyId, term, body, today);
    throwFirstBlocker(p.result.blockers, false);
    assertHash(p.result, body.previewHash);
    throwFirstBlocker(p.result.blockers, true);

    const days = await settings.get(societyId, 'committee.handoverDelegationDays');
    const { roleChanges, membershipsEnded } = await runActions(
      ctx,
      p.result.actions,
      `Committee term ${term.name}`,
      t,
    );
    const delegations = await createDelegations(
      ctx,
      p.result.pairs,
      { termName: term.name, committeeTermId: term.id!, days },
      t,
    );
    const { memberIds, roleBefore } = p.result.built;
    const before = seatsForAudit(term.members);
    const seats = p.seats.map(s =>
      s.status === 'SEATED' && s.memberId === null
        ? { ...s, memberId: memberIds.get(s.userId!)!, roleBeforeKey: roleBefore.get(s.userId!) ?? null }
        : s,
    );
    assertStored(seats, term.status);
    term.members = seats;
    term.version += 1;
    term.updatedBy = ctx.user?.id ?? null;
    await term.save({ transaction: t });

    for (const e of p.events) {
      if (e.op === 'ADD')
        await audit(
          ctx,
          {
            action: AUDIT.seatAdded,
            entityType: ENTITY.term,
            entityId: id,
            entityLabel: `${term.name}: ${e.next.name}`,
            societyId,
            after: {
              seatId: e.next.seatId,
              name: e.next.name,
              designation: e.next.designation,
              joinMode: e.next.joinMode,
              resolutionRef: e.next.resolutionRef,
              fromDate: p.effective,
            },
            reason: body.reason,
          },
          t,
        );
      else if (e.op === 'REDESIGNATE')
        await audit(
          ctx,
          {
            action: AUDIT.seatRedesignated,
            entityType: ENTITY.term,
            entityId: id,
            entityLabel: `${term.name}: ${e.next.name}`,
            societyId,
            before: { seatId: e.seat.seatId, designation: e.fromDesignation },
            after: { seatId: e.next.seatId, designation: e.next.designation, fromDate: e.next.fromDate },
            reason: body.reason,
          },
          t,
        );
      else
        await audit(
          ctx,
          {
            action: AUDIT.seatVacated,
            entityType: ENTITY.term,
            entityId: id,
            entityLabel: `${term.name}: ${e.seat.name}`,
            societyId,
            before: { seatId: e.seat.seatId, designation: e.seat.designation },
            after: { exitReason: e.next.exitReason, exitNote: e.next.exitNote, toDate: p.effective },
            reason: body.reason,
          },
          t,
        );
    }
    const summary = {
      roleChanges,
      membershipsEnded,
      handoverDelegationsCreated: delegations.created,
      handoverDelegationsSkipped: delegations.skipped,
    };
    await audit(
      ctx,
      {
        action: AUDIT.changed,
        entityType: ENTITY.term,
        entityId: id,
        entityLabel: term.name,
        societyId,
        before,
        after: {
          effectiveDate: p.effective,
          changeCount: body.changes.length,
          seats: seatsForAudit(seats),
          actions: p.result.actions,
          ...summary,
        },
        reason: body.reason,
      },
      t,
    );
    emitChanged(t, societyId, id, term.status, 'CHANGED');
    // section 10: a seat without a role change is announced by module 10 (module 03 notifies the role changes itself)
    const unchanged = new Set(p.result.actions.filter(a => a.kind === 'NONE').map(a => a.userId));
    for (const i of p.ins)
      if (unchanged.has(i.userId))
        announce(t, ctx, societyId, {
          template: 'committee.seat_assigned',
          userIds: [i.userId],
          termName: term.name,
          designationLabel: DESIGNATION_LABEL[i.designation],
        });
    return { term, summary };
  });
  return { ...(await termDetail(ctx, term, today)), summary };
}
