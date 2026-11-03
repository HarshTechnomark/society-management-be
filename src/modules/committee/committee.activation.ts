import { CommitteeTerm, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { members } from '../access-control/access-control.public';
import { residents } from '../residents/residents.public';
import { AUDIT, COMMITTEE_ROLE_KEYS, ENTITY, FEATURE, type Designation } from './committee.constants';
import { nameOfUser } from './committee.holders';
import {
  addDaysYmd,
  missingOfficeBearers,
  seatedSeats,
  type IncomingHolder,
  type OutgoingHolder,
  type PlanBlocker,
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
import type { HandoverItemJson, SeatJson } from './committee.schemas';
import { assertStored } from './committee.seats';
import { lockTerm, seatsForAudit } from './committee.service';
import {
  assertFeatureFor,
  committeeSettings,
  emitChanged,
  invalidState,
  rule,
  societyToday,
  staleVersion,
  termNotFound,
} from './committee.shared';
import { settings } from '../society-setup/society-setup.public';
import { findCurrent } from './committee.queries';

/** Activation preview (8.7) and activation (8.8, section 6.3). */
interface Planned {
  input: PlanInput;
  result: PlanResult;
  planned: SeatJson[];
  currentSeated: SeatJson[];
}

async function planActivation(
  ctx: Ctx,
  societyId: number,
  draft: CommitteeTerm,
  current: CommitteeTerm | null,
  today: string,
): Promise<Planned> {
  const cfg = await committeeSettings(societyId);
  const planned = draft.members.filter(s => s.status === 'PLANNED' && s.userId !== null);
  const currentSeated = current ? seatedSeats(current.members) : [];
  const draftUsers = new Set(planned.map(s => s.userId!));
  const outs: OutgoingHolder[] = currentSeated
    .filter(s => !draftUsers.has(s.userId!))
    .map(s => ({ userId: s.userId!, name: s.name, seat: s }));
  if (!current) {
    // BR-10-12: the first committee after onboarding: members who hold a committee role but are not in the draft
    const holding = await members.listForSociety(societyId, { roleKeys: [...COMMITTEE_ROLE_KEYS] });
    for (const h of holding)
      if (!draftUsers.has(h.userId))
        outs.push({ userId: h.userId, name: await nameOfUser(h.userId), seat: null });
  }
  const ins: IncomingHolder[] = planned.map(s => ({
    userId: s.userId!,
    name: s.name,
    designation: s.designation,
    seatId: s.seatId,
    replaceExistingRole: s.replaceExistingRole,
    continuing: currentSeated.find(c => c.userId === s.userId) ?? null,
  }));
  const extra: PlanBlocker[] = [];
  if (draft.startDate > today)
    extra.push({
      code: 'TERM_NOT_STARTED',
      message: `This committee starts on ${draft.startDate}; it cannot take charge before that`,
    });
  const missing = missingOfficeBearers(planned);
  if (missing.length)
    extra.push({
      code: 'OFFICE_BEARERS_REQUIRED',
      message: `A Chairman, a Secretary and a Treasurer are needed. Missing: ${missing
        .map(m => m.replace('_', ' ').toLowerCase())
        .join(', ')}`,
    });
  const input: PlanInput = {
    ctx,
    societyId,
    termId: draft.id!,
    termVersion: draft.version,
    currentTermId: current?.id ?? null,
    currentTermVersion: current?.version ?? null,
    outs,
    ins,
    eligibility: planned.map(s => ({ seatId: s.seatId, userId: s.userId, unitId: s.unitId })),
    before: currentSeated,
    after: planned,
    authority: draft.source === 'ELECTION' ? 'NONE' : current ? 'ENFORCE' : 'FIRST',
    ownersOnly: cfg.ownersOnly,
    extra,
  };
  return { input, result: await evaluatePlan(input), planned, currentSeated };
}

const seatsView = (seats: SeatJson[]) =>
  seats.map(s => ({
    seatId: s.seatId,
    name: s.name,
    designation: s.designation,
    status: s.status,
    fromDate: s.fromDate,
    toDate: s.toDate,
  }));

/** `GET /committee/terms/:id/activation-preview` (8.7). No side effects. */
export async function activationPreview(ctx: Ctx, societyId: number, id: number) {
  const draft = await CommitteeTerm.findOne({ where: { id, societyId } });
  if (!draft) throw termNotFound();
  if (draft.status !== 'DRAFT') throw invalidState('Only a draft committee can take charge');
  const [today, current, days] = [
    await societyToday(societyId),
    await findCurrent(societyId),
    settings.get(societyId, 'committee.handoverDelegationDays'),
  ];
  const p = await planActivation(ctx, societyId, draft, current, today);
  return {
    ...(await previewBody(p.input, p.result, await days)),
    seats: seatsView(p.planned),
  };
}

export interface ActivateInput {
  version: number;
  previewHash: string;
  tookChargeOn?: string;
  resolutionRef: string;
  reason: string;
  announceToResidents?: boolean;
}

async function checklistFromTemplate(societyId: number): Promise<HandoverItemJson[]> {
  const template = await settings.get(societyId, 'committee.handoverTemplate');
  return template.map((it, i) => ({
    itemId: `H${i + 1}`,
    title: it.title,
    ownerDesignation: (it.ownerDesignation as Designation | null) ?? null,
    status: 'PENDING' as const,
    note: null,
    evidenceFileIds: [],
    updatedByUserId: null,
    updatedAt: null,
  }));
}

/** `POST /committee/terms/:id/activate` (8.8): one transaction, section 6.3. */
export async function activate(ctx: Ctx, societyId: number, id: number, input: ActivateInput) {
  await assertFeatureFor(societyId, FEATURE.officeBearers);
  const today = await societyToday(societyId);
  const took = input.tookChargeOn ?? today;
  const preCurrent = await findCurrent(societyId);
  return sequelize.transaction(async t => {
    // BR-10-31: the draft and the current term are locked, lower id first
    const ids = [...new Set([id, ...(preCurrent ? [preCurrent.id!] : [])])].sort((a, b) => a - b);
    const locked = new Map<number, CommitteeTerm>();
    for (const x of ids) locked.set(x, await lockTerm(societyId, x, t));
    const draft = locked.get(id)!;
    if (draft.status !== 'DRAFT') throw invalidState('This committee is not a draft any more');
    const current = preCurrent ? locked.get(preCurrent.id!)! : null;
    if (current && current.status !== 'ACTIVE' && current.status !== 'EXPIRED')
      throw invalidState('The current committee changed. Review the activation again.');
    if (!current && (await findCurrent(societyId)))
      throw invalidState('A committee took charge in the meantime. Review the activation again.');
    if (draft.version !== input.version) throw staleVersion();

    if (draft.startDate <= today) {
      if (took < draft.startDate || took > today)
        throw rule(
          'COMMITTEE_TERM_DATES_INVALID',
          `The date of taking charge must be between ${draft.startDate} and today`,
          'tookChargeOn',
        );
      if (current?.tookChargeOn && took < current.tookChargeOn)
        throw rule(
          'COMMITTEE_TERM_DATES_INVALID',
          `The date of taking charge cannot be before the current committee took charge (${current.tookChargeOn})`,
          'tookChargeOn',
        );
    }
    const days = await settings.get(societyId, 'committee.handoverDelegationDays');
    const p = await planActivation(ctx, societyId, draft, current, today);
    throwFirstBlocker(p.result.blockers, false);
    assertHash(p.result, input.previewHash);
    throwFirstBlocker(p.result.blockers, true);

    const { roleChanges, membershipsEnded } = await runActions(
      ctx,
      p.result.actions,
      `Committee term ${draft.name}`,
      t,
    );
    const delegations = await createDelegations(
      ctx,
      p.result.pairs,
      { termName: draft.name, committeeTermId: draft.id!, days },
      t,
    );

    const before = {
      draft: seatsForAudit(draft.members),
      current: current ? seatsForAudit(current.members) : [],
    };
    const stamp = now();
    const left = addDaysYmd(took, -1);
    if (current) {
      current.members = current.members.map(s =>
        s.status === 'SEATED'
          ? {
              ...s,
              status: 'LEFT' as const,
              exitReason: 'TERM_ENDED' as const,
              toDate: left < s.fromDate! ? s.fromDate : left,
              flags: [],
            }
          : s,
      );
      assertStored(current.members, 'ENDED');
      current.status = 'ENDED';
      current.actualEndDate = left < current.tookChargeOn! ? current.tookChargeOn : left;
      current.endedAt = stamp;
      current.endedBy = ctx.user?.id ?? null;
      current.endReason = `Successor took charge: ${draft.name}`.slice(0, 500);
      current.version += 1;
      current.updatedBy = ctx.user?.id ?? null;
      await current.save({ transaction: t });
    }
    draft.members = draft.members.map(s =>
      s.status === 'PLANNED' && s.userId !== null
        ? {
            ...s,
            status: 'SEATED' as const,
            memberId: p.result.built.memberIds.get(s.userId)!,
            fromDate: took,
            roleBeforeKey: p.result.built.roleBefore.get(s.userId) ?? null,
            flags: [],
          }
        : s,
    );
    assertStored(draft.members, 'ACTIVE');
    draft.status = 'ACTIVE';
    draft.tookChargeOn = took;
    draft.resolutionRef = input.resolutionRef;
    draft.activatedAt = stamp;
    draft.activatedBy = ctx.user?.id ?? null;
    draft.predecessorTermId = current?.id ?? null;
    draft.handoverChecklist = await checklistFromTemplate(societyId);
    draft.handoverCompletedAt = null;
    draft.version += 1;
    draft.updatedBy = ctx.user?.id ?? null;
    await draft.save({ transaction: t });

    const summary = {
      roleChanges,
      membershipsEnded,
      handoverDelegationsCreated: delegations.created,
      handoverDelegationsSkipped: delegations.skipped,
    };
    await audit(
      ctx,
      {
        action: AUDIT.activated,
        entityType: ENTITY.term,
        entityId: draft.id!,
        entityLabel: draft.name,
        societyId,
        before: before.draft,
        after: {
          tookChargeOn: took,
          resolutionRef: input.resolutionRef,
          predecessorTermId: draft.predecessorTermId,
          seats: seatsForAudit(draft.members),
          actions: p.result.actions,
          ...summary,
        },
        reason: input.reason,
      },
      t,
    );
    if (current)
      await audit(
        ctx,
        {
          action: AUDIT.ended,
          entityType: ENTITY.term,
          entityId: current.id!,
          entityLabel: current.name,
          societyId,
          before: before.current,
          after: {
            actualEndDate: current.actualEndDate,
            successorTermId: draft.id,
            seats: seatsForAudit(current.members),
          },
          reason: input.reason,
        },
        t,
      );
    emitChanged(t, societyId, draft.id!, 'ACTIVE', 'ACTIVATED');
    announce(t, ctx, societyId, {
      template: 'committee.term_activated',
      userIds: [...new Set([...p.input.ins.map(i => i.userId), ...p.input.outs.map(o => o.userId)])],
      termName: draft.name,
      endDate: draft.endDate,
    });
    if (input.announceToResidents ?? true)
      announce(t, ctx, societyId, {
        template: 'committee.new_committee_announced',
        userIds: () => residents.audienceUserIds(societyId, { type: 'ALL' }),
        termName: draft.name,
        endDate: draft.endDate,
      });
    return {
      message: `${draft.name} has taken charge`,
      data: {
        term: { id: draft.id!, status: draft.status, tookChargeOn: took, version: draft.version },
        endedTerm: current
          ? { id: current.id!, status: current.status, actualEndDate: current.actualEndDate }
          : null,
        summary,
      },
    };
  });
}
