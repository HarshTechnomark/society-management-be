import type { Transaction } from 'sequelize';
import { CommitteeTerm, Society } from '../../models';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { usersWithPermission } from '../access-control/access-control.public';
import { AUDIT, ENTITY, type Designation } from './committee.constants';
import { nameOfUser } from './committee.holders';
import { assertStrengthRange, assertTermDates } from './committee.rules';
import { assertStored, newSeat } from './committee.seats';
import { committeePorts } from './committee.ports';
import { committeeSettings, emitChanged, rule, societyToday } from './committee.shared';
import { listSeatedUserIds } from './committee.queries';
import { seatsForAudit } from './committee.service';
import './committee.templates';

/** Input of `committee.createDraftFromElection()` (section 9.2; module 22 calls it when results are declared). */
export interface DraftFromElectionInput {
  societyId: number;
  electionId: number;
  resultsDeclaredAt: Date;
  termStartDate: string;
  termEndDate: string;
  name?: string;
  strength?: number;
  winners: { userId: number; unitId?: number; designation?: Designation }[];
}

/**
 * BR-10-19. Idempotent per `electionId`; any draft that is open is soft-deleted ("Replaced by election results") and
 * audited. BR-10-7 and BR-10-8 are not enforced here (they block activation), so a declaration is never rejected for them.
 */
export async function createDraftFromElection(
  ctx: Ctx,
  input: DraftFromElectionInput,
  t: Transaction,
): Promise<{ termId: number; replacedDraftTermId: number | null }> {
  const societyId = input.societyId;
  const again = await CommitteeTerm.findOne({ where: { electionId: input.electionId }, transaction: t });
  if (again) return { termId: again.id!, replacedDraftTermId: null };

  const [cfg, today] = [await committeeSettings(societyId), await societyToday(societyId)];
  const strength = input.strength ?? input.winners.length;
  assertStrengthRange(strength, cfg);
  await assertTermDates(
    societyId,
    { startDate: input.termStartDate, endDate: input.termEndDate },
    { draft: true, today, maxTermYears: cfg.maxTermYears, t },
  );
  if (input.winners.length > strength)
    throw rule('COMMITTEE_STRENGTH_INVALID', 'There are more winners than seats', 'strength');

  let replaced: number | null = null;
  const open = await CommitteeTerm.findOne({
    where: { societyId, status: 'DRAFT' },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (open) {
    replaced = open.id!;
    const before = { name: open.name, status: open.status, seats: seatsForAudit(open.members) };
    await open.destroy({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.deleted,
        entityType: ENTITY.term,
        entityId: open.id!,
        entityLabel: open.name,
        societyId,
        before,
        reason: 'Replaced by election results',
      },
      t,
    );
    emitChanged(t, societyId, open.id!, 'DRAFT', 'UPDATED');
  }

  const seats = [];
  for (const [i, w] of input.winners.entries())
    seats.push(
      newSeat({
        seatId: `S${i + 1}`,
        userId: w.userId,
        unitId: w.unitId ?? null,
        name: await nameOfUser(w.userId),
        designation: w.designation ?? 'MEMBER',
        joinMode: 'ELECTED',
      }),
    );
  assertStored(seats, 'DRAFT');
  const startYear = input.termStartDate.slice(0, 4);
  const endYear = input.termEndDate.slice(0, 4);
  const term = await CommitteeTerm.create(
    {
      societyId,
      name: input.name ?? `Managing Committee ${startYear}–${endYear}`,
      kind: 'ELECTED',
      source: 'ELECTION',
      status: 'DRAFT',
      startDate: input.termStartDate,
      endDate: input.termEndDate,
      actualEndDate: null,
      strength,
      electionId: input.electionId,
      resultsDeclaredAt: input.resultsDeclaredAt,
      predecessorTermId: null,
      members: seats,
      handoverChecklist: [],
      handoverCompletedAt: null,
      tookChargeOn: null,
      resolutionRef: null,
      notes: null,
      lastReminderDays: null,
      lastHandoverReminderDay: null,
      activatedAt: null,
      activatedBy: null,
      expiredAt: null,
      endedAt: null,
      endedBy: null,
      endReason: null,
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
      action: AUDIT.createdFromElection,
      entityType: ENTITY.term,
      entityId: term.id!,
      entityLabel: term.name,
      societyId,
      after: {
        electionRef: input.electionId,
        name: term.name,
        strength,
        replacedDraftTermId: replaced,
        seats: seatsForAudit(seats),
      },
    },
    t,
  );
  emitChanged(t, societyId, term.id!, 'DRAFT', 'CREATED');
  t.afterCommit(() => {
    void (async () => {
      const society = await Society.findByPk(societyId, { attributes: ['name'] });
      // officers (section 10): seated Chairman and Secretary of the current term and everyone who may edit members
      const officers = [
        ...(await listSeatedUserIds(societyId, ['CHAIRMAN', 'SECRETARY'])),
        ...(await usersWithPermission(societyId, 'settings.members.edit')),
      ];
      await committeePorts().notifications.send('committee.draft_from_election', [...new Set(officers)], {
        societyName: society?.name ?? 'Your society',
        termName: term.name,
        link: '/committee',
      });
    })();
  });
  return { termId: term.id!, replacedDraftTermId: replaced };
}
