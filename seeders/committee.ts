import { CommitteeTerm, Society, SocietyMember, User } from '../src/models';
import { units } from '../src/modules/society-setup/society-setup.public';
import { DEFAULT_HANDOVER_TEMPLATE, type Designation } from '../src/modules/committee/committee.constants';
import type { HandoverItemJson, SeatJson } from '../src/modules/committee/committee.schemas';
import { newSeat } from '../src/modules/committee/committee.seats';
import { addDaysYmd } from '../src/modules/committee/committee.planner';
import { societyToday } from '../src/modules/committee/committee.shared';

/**
 * Module 10 demo seed (section 7.6), not run in production. Rows are inserted directly (roles already match the memberships
 * of module 03's seed, so no module 03 call). Sky Heights CHS: "Managing Committee 2024-2029" ACTIVE (strength 5, three
 * seats, two vacancies, hand-over done except H8) and the past committee 2019-2024 (HISTORICAL, ENDED). Green Park CHS:
 * "Managing Committee 2025-2026" ACTIVE (strength 3, three seats) built for the module 10.3 screens: its term ends in 24 days
 * (the TERM_ENDING banner), the hand-over checklist is half done (five DONE, one NOT_APPLICABLE, four PENDING) and one seat
 * carries the attention flag MEMBERSHIP_SUSPENDED (a stored flag only; the reconcile job recomputes it from module 03).
 * Idempotent per society and term; a Green Park term seeded by 10.1 ("2025-2030", untouched) is tuned to this once.
 */
interface SeatPlan {
  mobile: string | null;
  name: string;
  designation: Designation;
  flat: string | null;
  portfolios?: SeatJson['portfolios'];
  publicEmail?: string;
  flags?: SeatJson['flags'];
}
interface TermPlan {
  slug: string;
  name: string;
  historical: boolean;
  startDate: string;
  endDate: string;
  strength: number;
  resolutionRef: string;
  /** Hand-over items still PENDING (all other items are DONE); undefined = the whole checklist is pending. */
  pending?: string[];
  /** Items DONE and items NOT_APPLICABLE (the rest is PENDING); used instead of `pending` when set. */
  partial?: { done: string[]; notApplicable: string[] };
  /** The end date is this many days after today (overrides `endDate`; the term then starts at `startDate` as given). */
  endsInDays?: number;
  seats: SeatPlan[];
}

const PLANS: TermPlan[] = [
  {
    slug: 'sky-heights',
    name: 'Managing Committee 2024–2029',
    historical: false,
    startDate: '2024-04-01',
    endDate: '2029-03-31',
    strength: 5,
    resolutionRef: 'CM/2024-25/01',
    pending: ['H8'],
    seats: [
      {
        mobile: '9820011111',
        name: 'Rajesh Kulkarni',
        designation: 'CHAIRMAN',
        flat: 'A-501',
        portfolios: ['LEGAL'],
        publicEmail: 'chairman@skyheights.in',
      },
      { mobile: '9820033333', name: 'Arjun Shah', designation: 'SECRETARY', flat: 'C-104' },
      {
        mobile: '9820022222',
        name: 'Meera Iyer',
        designation: 'TREASURER',
        flat: 'B-302',
        portfolios: ['ACCOUNTS'],
      },
    ],
  },
  {
    slug: 'sky-heights',
    name: 'Managing Committee 2019–2024',
    historical: true,
    startDate: '2019-04-01',
    endDate: '2024-03-31',
    strength: 5,
    resolutionRef: 'CM/2019-20/01',
    seats: [
      { mobile: null, name: 'Vinod Bhide', designation: 'CHAIRMAN', flat: null },
      { mobile: '9820011111', name: 'Rajesh Kulkarni', designation: 'SECRETARY', flat: null },
      { mobile: null, name: 'Shalini Rao', designation: 'TREASURER', flat: null },
    ],
  },
  {
    slug: 'green-park',
    name: 'Managing Committee 2025–2026',
    historical: false,
    startDate: '2025-07-01',
    endDate: '2026-12-31',
    endsInDays: 24,
    strength: 3,
    resolutionRef: 'CM/2025-26/01',
    partial: { done: ['H1', 'H2', 'H3', 'H4', 'H5'], notApplicable: ['H7'] },
    seats: [
      { mobile: '9820066666', name: 'Suresh Pillai', designation: 'CHAIRMAN', flat: 'A-101' },
      { mobile: '9820011111', name: 'Rajesh Kulkarni', designation: 'SECRETARY', flat: 'B-203' },
      {
        mobile: '9820077777',
        name: 'Ritu Agarwal',
        designation: 'TREASURER',
        flat: 'A-202',
        flags: ['MEMBERSHIP_SUSPENDED'],
      },
    ],
  },
];

type ItemStatus = HandoverItemJson['status'];
function checklistStatus(plan: TermPlan, itemId: string): ItemStatus {
  if (plan.partial)
    return plan.partial.done.includes(itemId)
      ? 'DONE'
      : plan.partial.notApplicable.includes(itemId)
        ? 'NOT_APPLICABLE'
        : 'PENDING';
  return plan.pending !== undefined && !plan.pending.includes(itemId) ? 'DONE' : 'PENDING';
}

/** The Green Park term seeded by 10.1 ("2025–2030", nothing done on it yet) is turned into the 10.3 demo term once. */
async function tuneGreenPark(plan: TermPlan, societyId: number): Promise<boolean> {
  if (plan.slug !== 'green-park' || !plan.endsInDays) return false;
  const old = await CommitteeTerm.findOne({
    where: { societyId, source: 'MANUAL', status: 'ACTIVE', name: 'Managing Committee 2025–2030' },
  });
  if (!old) return false;
  const chair = old.members.find(s => s.designation === 'CHAIRMAN')?.userId ?? null;
  old.name = plan.name;
  old.endDate = addDaysYmd(await societyToday(societyId), plan.endsInDays);
  old.lastReminderDays = null;
  old.members = old.members.map(s => {
    const sp = plan.seats.find(p => p.designation === s.designation);
    return sp?.flags ? { ...s, flags: sp.flags } : s;
  });
  old.handoverChecklist = old.handoverChecklist.map(i => {
    const status = checklistStatus(plan, i.itemId);
    return status === 'PENDING'
      ? i
      : {
          ...i,
          status,
          note: status === 'NOT_APPLICABLE' ? 'No society premises at this address' : null,
          updatedByUserId: chair,
          updatedAt: `${plan.startDate}T06:30:00.000Z`,
        };
  });
  old.version += 1;
  await old.save();
  return true;
}

export interface CommitteeSeedReport {
  created: string[];
  skipped: string[];
}

export async function seedCommittee(): Promise<CommitteeSeedReport> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('committee demo seed must not run in production');
  const report: CommitteeSeedReport = { created: [], skipped: [] };
  for (const plan of PLANS) {
    const label = `${plan.slug}: ${plan.name}`;
    const society = await Society.findOne({ where: { slug: plan.slug } });
    if (!society) continue;
    const societyId = society.id!;
    const exists = await CommitteeTerm.count({
      where: plan.historical ? { societyId, name: plan.name } : { societyId, source: 'MANUAL' },
      paranoid: false,
    });
    if (exists > 0) {
      if (await tuneGreenPark(plan, societyId)) report.created.push(`${label} (tuned)`);
      else report.skipped.push(label);
      continue;
    }
    const endDate =
      plan.endsInDays !== undefined
        ? addDaysYmd(await societyToday(societyId), plan.endsInDays)
        : plan.endDate;
    const seats: SeatJson[] = [];
    let chairmanUserId: number | null = null;
    let complete = true;
    for (const [i, sp] of plan.seats.entries()) {
      const user = sp.mobile ? await User.findOne({ where: { mobile: sp.mobile } }) : null;
      const member = user ? await SocietyMember.findOne({ where: { societyId, userId: user.id! } }) : null;
      if (!plan.historical && (!user || !member)) {
        complete = false;
        break;
      }
      const unit = sp.flat ? await units.getByLabel(societyId, sp.flat) : null;
      if (sp.designation === 'CHAIRMAN') chairmanUserId = user?.id ?? null;
      seats.push(
        newSeat({
          seatId: `S${i + 1}`,
          userId: user?.id ?? null,
          memberId: plan.historical ? null : (member?.id ?? null),
          unitId: unit?.id ?? null,
          name: sp.name,
          designation: sp.designation,
          portfolios: sp.portfolios ?? [],
          publicEmail: sp.publicEmail ?? null,
          status: plan.historical ? 'LEFT' : 'SEATED',
          fromDate: plan.startDate,
          toDate: plan.historical ? plan.endDate : null,
          exitReason: plan.historical ? 'TERM_ENDED' : null,
          flags: sp.flags ?? [],
        }),
      );
    }
    if (!complete) {
      report.skipped.push(label);
      continue;
    }
    const checklist: HandoverItemJson[] = plan.historical
      ? []
      : DEFAULT_HANDOVER_TEMPLATE.map((it, i) => {
          const itemId = `H${i + 1}`;
          const status = checklistStatus(plan, itemId);
          const touched = status !== 'PENDING';
          return {
            itemId,
            title: it.title,
            ownerDesignation: it.ownerDesignation,
            status,
            note: status === 'NOT_APPLICABLE' ? 'No society premises at this address' : null,
            evidenceFileIds: [],
            updatedByUserId: touched ? chairmanUserId : null,
            updatedAt: touched ? `${plan.startDate}T06:30:00.000Z` : null,
          };
        });
    const activatedAt = new Date(`${plan.startDate}T04:30:00.000Z`);
    await CommitteeTerm.create({
      societyId,
      name: plan.name,
      kind: 'ELECTED',
      source: plan.historical ? 'HISTORICAL' : 'MANUAL',
      status: plan.historical ? 'ENDED' : 'ACTIVE',
      startDate: plan.startDate,
      endDate,
      actualEndDate: plan.historical ? endDate : null,
      strength: plan.strength,
      electionId: null,
      resultsDeclaredAt: null,
      predecessorTermId: null,
      members: seats,
      handoverChecklist: checklist,
      handoverCompletedAt: null,
      tookChargeOn: plan.historical ? null : plan.startDate,
      resolutionRef: plan.resolutionRef,
      notes: null,
      lastReminderDays: null,
      lastHandoverReminderDay: null,
      activatedAt: plan.historical ? null : activatedAt,
      activatedBy: plan.historical ? null : chairmanUserId,
      expiredAt: null,
      endedAt: null,
      endedBy: null,
      endReason: plan.historical ? 'Historical record' : null,
      version: 1,
      createdBy: null,
      updatedBy: null,
      deletedAt: null,
    });
    report.created.push(label);
  }
  return report;
}
