import { UniqueConstraintError, type Transaction } from 'sequelize';
import { CommitteeTerm, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { AppError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { assertUnitFits } from './committee.holders';
import { holdingSeats, seatedSeats } from './committee.planner';
import { AUDIT, ENTITY, FEATURE, type Designation } from './committee.constants';
import { termDetail } from './committee.dto';
import type { SeatJson } from './committee.schemas';
import { assertStrengthRange, assertTermDates } from './committee.rules';
import { assertStored, buildDraftSeats, buildHistoricalSeats, type SeatInput } from './committee.seats';
import {
  assertFeatureFor,
  assertRecentAuth,
  committeeSettings,
  emitChanged,
  invalidState,
  rule,
  seatNotFound,
  societyToday,
  staleVersion,
  termNotFound,
} from './committee.shared';

/** Terms and seats: create, edit, delete and seat edits (8.3 to 8.6). Activation, changes and the checklist come with 10.2 and 10.3. */
export async function lockTerm(societyId: number, id: number, t: Transaction): Promise<CommitteeTerm> {
  const term = await CommitteeTerm.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!term) throw termNotFound();
  return term;
}

/** Names and designations only, no contacts (section 13). */
export const seatsForAudit = (seats: SeatJson[]) =>
  seats.map(s => ({ seatId: s.seatId, name: s.name, designation: s.designation, status: s.status }));

export interface CreateTermInput {
  name: string;
  kind?: 'ELECTED' | 'PROVISIONAL' | 'AD_HOC';
  source?: 'MANUAL' | 'HISTORICAL';
  startDate: string;
  endDate: string;
  strength: number;
  notes?: string | null;
  seats: SeatInput[];
  resolutionRef?: string | null;
}

async function existingDraftId(societyId: number, t?: Transaction): Promise<number | null> {
  const d = await CommitteeTerm.findOne({
    where: { societyId, status: 'DRAFT' },
    attributes: ['id'],
    transaction: t,
  });
  return d?.id ?? null;
}
const draftExists = (termId: number) =>
  new AppError(409, 'COMMITTEE_DRAFT_EXISTS', 'A draft committee already exists', [
    { field: 'termId', message: 'Edit or delete the existing draft first', termId },
  ]);

/** `POST /committee/terms` (8.3): a manual draft or a past committee (HISTORICAL). */
export async function createTerm(ctx: Ctx, societyId: number, input: CreateTermInput) {
  const historical = input.source === 'HISTORICAL';
  if (input.seats.some(s => s.designation !== 'MEMBER'))
    await assertFeatureFor(societyId, FEATURE.officeBearers);
  const [cfg, today] = [await committeeSettings(societyId), await societyToday(societyId)];
  const term = await sequelize
    .transaction(async t => {
      if (!historical) {
        const open = await existingDraftId(societyId, t);
        if (open) throw draftExists(open);
      }
      await assertTermDates(societyId, input, {
        draft: !historical,
        historical,
        today,
        maxTermYears: cfg.maxTermYears,
        t,
      });
      assertStrengthRange(input.strength, cfg);
      const seats = historical
        ? await buildHistoricalSeats(input.seats, input)
        : await buildDraftSeats({
            societyId,
            strength: input.strength,
            cfg,
            existing: [],
            input: input.seats,
            needsEligibility: () => true,
          });
      const row = await CommitteeTerm.create(
        {
          societyId,
          name: input.name,
          kind: input.kind ?? 'ELECTED',
          source: historical ? 'HISTORICAL' : 'MANUAL',
          status: historical ? 'ENDED' : 'DRAFT',
          startDate: input.startDate,
          endDate: input.endDate,
          actualEndDate: historical ? input.endDate : null,
          strength: input.strength,
          electionId: null,
          resultsDeclaredAt: null,
          predecessorTermId: null,
          members: seats,
          handoverChecklist: [],
          handoverCompletedAt: null,
          tookChargeOn: null,
          resolutionRef: input.resolutionRef ?? null,
          notes: input.notes ?? null,
          lastReminderDays: null,
          lastHandoverReminderDay: null,
          activatedAt: null,
          activatedBy: null,
          expiredAt: null,
          endedAt: null,
          endedBy: null,
          endReason: historical ? 'Historical record' : null,
          version: 1,
          createdBy: ctx.user?.id ?? null,
          updatedBy: ctx.user?.id ?? null,
          deletedAt: null,
        },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.created,
          entityType: ENTITY.term,
          entityId: row.id!,
          entityLabel: row.name,
          societyId,
          after: {
            name: row.name,
            source: row.source,
            status: row.status,
            startDate: row.startDate,
            endDate: row.endDate,
            strength: row.strength,
            seats: seatsForAudit(seats),
          },
        },
        t,
      );
      emitChanged(t, societyId, row.id!, row.status, 'CREATED');
      return row;
    })
    .catch(async err => {
      if (err instanceof UniqueConstraintError && !historical) {
        const open = await existingDraftId(societyId);
        if (open) throw draftExists(open);
      }
      throw err;
    });
  return termDetail(ctx, term, today);
}

export interface UpdateTermInput {
  version: number;
  name?: string;
  kind?: 'ELECTED' | 'PROVISIONAL' | 'AD_HOC';
  startDate?: string;
  endDate?: string;
  strength?: number;
  notes?: string | null;
  seats?: SeatInput[];
  reason?: string;
}

/** `PATCH /committee/terms/:id` (8.4): draft edits, and name, notes, end date and strength of a current term. */
export async function updateTerm(ctx: Ctx, societyId: number, id: number, input: UpdateTermInput) {
  const [cfg, today] = [await committeeSettings(societyId), await societyToday(societyId)];
  const term = await sequelize.transaction(async t => {
    const term = await lockTerm(societyId, id, t);
    if (term.status === 'ENDED') throw invalidState('A past committee is read-only history');
    if (term.version !== input.version) throw staleVersion();
    const draft = term.status === 'DRAFT';
    if (!draft && (input.kind !== undefined || input.startDate !== undefined || input.seats !== undefined))
      throw invalidState('Kind, start date and seats can only be changed while the term is a draft');
    const endChanges = input.endDate !== undefined && input.endDate !== term.endDate;
    const strengthChanges = input.strength !== undefined && input.strength !== term.strength;
    if (!draft && (endChanges || strengthChanges)) {
      await assertRecentAuth(ctx);
      if (!input.reason)
        throw new ValidationError([{ field: 'reason', message: 'Say why the end date or strength changes' }]);
    }

    const before = {
      name: term.name,
      kind: term.kind,
      startDate: term.startDate,
      endDate: term.endDate,
      strength: term.strength,
      notes: term.notes,
      seats: seatsForAudit(term.members),
    };
    const nextStart = input.startDate ?? term.startDate;
    const nextEnd = input.endDate ?? term.endDate;
    const nextStrength = input.strength ?? term.strength;
    const datesTouched = input.startDate !== undefined || input.endDate !== undefined;
    if (draft ? datesTouched : endChanges)
      await assertTermDates(
        societyId,
        { startDate: nextStart, endDate: nextEnd },
        { draft, exceptId: id, today, maxTermYears: cfg.maxTermYears, t },
      );
    if (strengthChanges) assertStrengthRange(nextStrength, cfg);

    let seats = term.members;
    if (input.seats !== undefined) {
      const election = term.source === 'ELECTION';
      seats = await buildDraftSeats({
        societyId,
        strength: nextStrength,
        cfg,
        existing: term.members,
        input: input.seats,
        needsEligibility: (prev, next) =>
          !election || !prev || prev.userId !== next.userId || prev.unitId !== next.unitId,
      });
      if (election) {
        const elected = (list: SeatJson[]) =>
          [
            ...new Set(list.filter(s => s.joinMode === 'ELECTED' && s.userId !== null).map(s => s.userId)),
          ].sort();
        if (JSON.stringify(elected(seats)) !== JSON.stringify(elected(term.members)))
          throw rule(
            'COMMITTEE_ELECTED_SEATS_LOCKED',
            'The people elected cannot be changed here; designations, portfolios, flats and public emails can',
          );
      }
      term.members = seats;
    } else if (strengthChanges) {
      const used = (draft ? holdingSeats(seats) : seatedSeats(seats)).length;
      if (nextStrength < used)
        throw rule(
          'COMMITTEE_STRENGTH_INVALID',
          `${used} seats are in use; the strength cannot be lower`,
          'strength',
        );
    }
    assertStored(seats, term.status);

    if (input.name !== undefined) term.name = input.name;
    if (input.kind !== undefined) term.kind = input.kind;
    if (input.startDate !== undefined) term.startDate = input.startDate;
    if (input.notes !== undefined) term.notes = input.notes;
    term.strength = nextStrength;
    let action: string = AUDIT.updated;
    if (!draft && endChanges) {
      term.lastReminderDays = null;
      if (term.status === 'EXPIRED' && nextEnd >= today) {
        term.status = 'ACTIVE';
        term.expiredAt = null;
      }
      if (nextEnd > term.endDate) action = AUDIT.extended;
    } else if (draft && endChanges) term.lastReminderDays = null;
    term.endDate = nextEnd;
    term.version += 1;
    term.updatedBy = ctx.user?.id ?? null;
    await term.save({ transaction: t });
    await audit(
      ctx,
      {
        action,
        entityType: ENTITY.term,
        entityId: id,
        entityLabel: term.name,
        societyId,
        before,
        after: {
          name: term.name,
          kind: term.kind,
          startDate: term.startDate,
          endDate: term.endDate,
          strength: term.strength,
          notes: term.notes,
          status: term.status,
          seats: seatsForAudit(term.members),
        },
        reason: input.reason ?? null,
      },
      t,
    );
    emitChanged(t, societyId, id, term.status, 'UPDATED');
    return term;
  });
  return termDetail(ctx, term, today);
}

/** `DELETE /committee/terms/:id` (8.5): a draft only; soft delete. */
export async function deleteTerm(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { version: number; reason: string },
): Promise<void> {
  await sequelize.transaction(async t => {
    const term = await lockTerm(societyId, id, t);
    if (term.status !== 'DRAFT') throw invalidState('Only a draft committee can be deleted');
    if (term.version !== input.version) throw staleVersion();
    const before = { name: term.name, status: term.status, seats: seatsForAudit(term.members) };
    await term.destroy({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.deleted,
        entityType: ENTITY.term,
        entityId: id,
        entityLabel: term.name,
        societyId,
        before,
        reason: input.reason,
      },
      t,
    );
    emitChanged(t, societyId, id, 'DRAFT', 'UPDATED');
  });
}

export interface SeatPatchInput {
  version: number;
  portfolios?: SeatJson['portfolios'];
  publicEmail?: string | null;
  showOnResidentPage?: boolean;
  unitId?: number;
}

/** `PATCH /committee/terms/:id/seats/:seatId` (8.6): portfolios, public email, visibility and flat of one seat. */
export async function patchSeat(
  ctx: Ctx,
  societyId: number,
  id: number,
  seatId: string,
  input: SeatPatchInput,
) {
  const [cfg, today] = [await committeeSettings(societyId), await societyToday(societyId)];
  const term = await sequelize.transaction(async t => {
    const term = await lockTerm(societyId, id, t);
    if (term.status === 'ENDED') throw invalidState('A past committee is read-only history');
    if (term.version !== input.version) throw staleVersion();
    const seats = term.members;
    const seat = seats.find(s => s.seatId === seatId);
    if (!seat) throw seatNotFound();
    if (seat.status === 'LEFT') throw invalidState('This seat is closed');
    if (input.showOnResidentPage === false && seat.designation !== 'MEMBER')
      throw rule(
        'COMMITTEE_CHANGE_INVALID',
        'An office bearer must be shown on the resident page',
        'showOnResidentPage',
        {
          seatIds: [seatId],
        },
      );
    if (input.unitId !== undefined && input.unitId !== seat.unitId) {
      if (seat.userId === null) throw rule('COMMITTEE_HOLDER_INELIGIBLE', 'The seat has no holder', 'unitId');
      await assertUnitFits(societyId, seatId, seat.userId, input.unitId, cfg.ownersOnly);
    }
    const before = {
      seatId,
      portfolios: seat.portfolios,
      showOnResidentPage: seat.showOnResidentPage,
      unitId: seat.unitId,
      hasPublicEmail: seat.publicEmail !== null,
    };
    const next: SeatJson = {
      ...seat,
      portfolios: input.portfolios ?? seat.portfolios,
      publicEmail: input.publicEmail !== undefined ? input.publicEmail : seat.publicEmail,
      showOnResidentPage: input.showOnResidentPage ?? seat.showOnResidentPage,
      unitId: input.unitId ?? seat.unitId,
    };
    term.members = seats.map(s => (s.seatId === seatId ? next : s));
    term.version += 1;
    term.updatedBy = ctx.user?.id ?? null;
    await term.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.seatUpdated,
        entityType: ENTITY.term,
        entityId: id,
        entityLabel: `${term.name}: ${next.name}`,
        societyId,
        before,
        after: {
          seatId,
          designation: next.designation as Designation,
          portfolios: next.portfolios,
          showOnResidentPage: next.showOnResidentPage,
          unitId: next.unitId,
          hasPublicEmail: next.publicEmail !== null,
        },
      },
      t,
    );
    emitChanged(t, societyId, id, term.status, 'UPDATED');
    return term;
  });
  return termDetail(ctx, term, today);
}
