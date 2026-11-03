import { CommitteeTerm, Society, SocietyMember, User } from '../src/models';
import { units } from '../src/modules/society-setup/society-setup.public';
import { DEFAULT_HANDOVER_TEMPLATE, type Designation } from '../src/modules/committee/committee.constants';
import type { HandoverItemJson, SeatJson } from '../src/modules/committee/committee.schemas';
import { newSeat } from '../src/modules/committee/committee.seats';

/**
 * Module 10 demo seed (section 7.6), not run in production. Rows are inserted directly (roles already match the memberships
 * of module 03's seed, so no module 03 call). Sky Heights CHS: "Managing Committee 2024-2029" ACTIVE (strength 5, three
 * seats, two vacancies, hand-over done except H8) and the past committee 2019-2024 (HISTORICAL, ENDED). Green Park CHS:
 * "Managing Committee 2025-2030" ACTIVE (strength 3, three seats, hand-over pending). Idempotent per society and term.
 */
interface SeatPlan {
  mobile: string | null;
  name: string;
  designation: Designation;
  flat: string | null;
  portfolios?: SeatJson['portfolios'];
  publicEmail?: string;
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
    name: 'Managing Committee 2025–2030',
    historical: false,
    startDate: '2025-07-01',
    endDate: '2030-06-30',
    strength: 3,
    resolutionRef: 'CM/2025-26/01',
    seats: [
      { mobile: '9820066666', name: 'Suresh Pillai', designation: 'CHAIRMAN', flat: 'A-101' },
      { mobile: '9820011111', name: 'Rajesh Kulkarni', designation: 'SECRETARY', flat: 'B-203' },
      { mobile: '9820077777', name: 'Ritu Agarwal', designation: 'TREASURER', flat: 'A-202' },
    ],
  },
];

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
      report.skipped.push(label);
      continue;
    }
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
          const done = plan.pending !== undefined && !plan.pending.includes(itemId);
          return {
            itemId,
            title: it.title,
            ownerDesignation: it.ownerDesignation,
            status: done ? ('DONE' as const) : ('PENDING' as const),
            note: null,
            evidenceFileIds: [],
            updatedByUserId: done ? chairmanUserId : null,
            updatedAt: done ? `${plan.startDate}T06:30:00.000Z` : null,
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
      endDate: plan.endDate,
      actualEndDate: plan.historical ? plan.endDate : null,
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
