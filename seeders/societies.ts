import {
  Society,
  SocietyLifecycleEvent,
  SocietyNote,
  SupportAccessGrant,
  User,
  sequelize,
} from '../src/models';
import type { HealthBreakdown } from '../src/models/society.model';
import { addDays, addMinutes, now } from '../src/lib/clock';
import { subscriptions } from '../src/modules/subscriptions/subscriptions.public';

/**
 * Module 05 seed (spec 7.1 and 16 step 11), not run in production: lifecycle columns of the three demo societies,
 * their CREATED events, the two historic support grants of the prototype (G-0041 EXPIRED, G-0042 ENDED) and one note.
 * Idempotent: a society is set once (while `healthComputedAt` is null); grants and the note are created by id or body.
 */
interface DemoLifecycle {
  slug: string;
  status: 'ACTIVE' | 'TRIAL';
  approxFlats: number;
  healthScore: number;
  breakdown: HealthBreakdown;
  requiresSupportConsent: boolean;
}

const DEMO: DemoLifecycle[] = [
  {
    slug: 'sky-heights',
    status: 'ACTIVE',
    approxFlats: 72,
    healthScore: 94,
    breakdown: { adoption: 0.9, onboarding: 1, collections: 0.95, adminActivity: 0.85, billing: 1 },
    requiresSupportConsent: true,
  },
  {
    slug: 'green-park',
    status: 'ACTIVE',
    approxFlats: 30,
    healthScore: 72,
    breakdown: { adoption: 0.6, onboarding: 0.9, collections: 0.7, adminActivity: 0.5, billing: 1 },
    requiresSupportConsent: false,
  },
  {
    slug: 'tulip-gardens',
    status: 'TRIAL',
    approxFlats: 60,
    healthScore: 40,
    breakdown: { adoption: 0.1, onboarding: 0.25, collections: null, adminActivity: 0.4, billing: 0.7 },
    requiresSupportConsent: true,
  },
];

export interface SocietiesSeedReport {
  societies: string[];
  grants: string[];
  notes: number;
}

export async function seedSocieties(): Promise<SocietiesSeedReport> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('demo society lifecycle must not run in production');
  const report: SocietiesSeedReport = { societies: [], grants: [], notes: 0 };
  const t0 = now();
  for (const d of DEMO) {
    const s = await Society.findOne({ where: { slug: d.slug } });
    if (!s || s.healthComputedAt) continue;
    await sequelize.transaction(async t => {
      const trialEndsAt = d.status === 'TRIAL' ? addDays(t0, 14) : null;
      await s.update(
        {
          status: d.status,
          statusChangedAt: s.createdAt ?? t0,
          approxFlats: d.approxFlats,
          trialEndsAt,
          activatedAt: d.status === 'ACTIVE' ? (s.createdAt ?? t0) : null,
          requiresSupportConsent: d.requiresSupportConsent,
          healthScore: d.healthScore,
          healthBreakdown: d.breakdown,
          healthComputedAt: t0,
          unitsSnapshot: 0,
        },
        { transaction: t },
      );
      if (trialEndsAt) await subscriptions.extendTrial(s.id!, trialEndsAt, t);
      if (!(await SocietyLifecycleEvent.count({ where: { societyId: s.id! }, transaction: t })))
        await SocietyLifecycleEvent.create(
          {
            societyId: s.id!,
            eventType: 'CREATED',
            fromStatus: null,
            toStatus: d.status,
            triggerSource: 'PLATFORM_USER',
            triggerCode: 'ASSISTED_CREATE',
            actorName: 'Platform Admin',
            metadata: { seeded: true },
            createdAt: s.createdAt ?? t0,
          } as never,
          { transaction: t },
        );
    });
    report.societies.push(d.slug);
  }

  const sky = await Society.findOne({ where: { slug: 'sky-heights' } });
  const green = await Society.findOne({ where: { slug: 'green-park' } });
  const agent = await User.findOne({ where: { mobile: '9000000002' } });
  const isha = await User.findOne({ where: { mobile: '9000000003' } });
  const chairSky = await User.findOne({ where: { mobile: '9820011111' } });
  const historic = [
    {
      id: 41,
      society: sky,
      user: agent,
      scope: 'READ_ONLY' as const,
      reason: 'Check bank statement import errors reported in TKT-2041',
      ticketRef: 'TKT-2041',
      minutes: 60,
      daysAgo: 9,
      status: 'EXPIRED' as const,
      endReason: 'EXPIRED' as const,
    },
    {
      id: 42,
      society: green,
      user: isha,
      scope: 'READ_WRITE' as const,
      reason: 'Fix duplicated flats after the opening balance import',
      ticketRef: 'TKT-2058',
      minutes: 120,
      daysAgo: 4,
      status: 'ENDED' as const,
      endReason: 'ENDED_BY_REQUESTER' as const,
    },
  ];
  for (const h of historic) {
    if (!h.society || !h.user || (await SupportAccessGrant.findByPk(h.id))) continue;
    const startedAt = addDays(t0, -h.daysAgo);
    const endsAt = addMinutes(startedAt, h.minutes);
    await SupportAccessGrant.create({
      id: h.id,
      societyId: h.society.id!,
      platformUserId: h.user.id!,
      scope: h.scope,
      reason: h.reason,
      ticketRef: h.ticketRef,
      durationMinutes: h.minutes,
      isEmergency: false,
      status: h.status,
      consentRequired: h.society.requiresSupportConsent,
      consentStatus: h.society.requiresSupportConsent ? 'APPROVED' : 'NOT_REQUIRED',
      consentExpiresAt: null,
      decidedByUserId: h.society.requiresSupportConsent ? (chairSky?.id ?? null) : null,
      decidedAt: h.society.requiresSupportConsent ? startedAt : null,
      decisionNote: null,
      startedAt,
      endsAt,
      endedAt: h.status === 'ENDED' ? addMinutes(startedAt, 75) : endsAt,
      endedByUserId: h.status === 'ENDED' ? h.user.id! : null,
      endReason: h.endReason,
      endNote: null,
      enteredAt: addMinutes(startedAt, 1),
      requestCount: h.status === 'ENDED' ? 64 : 37,
      writeCount: h.status === 'ENDED' ? 6 : 0,
      lastActivityAt: addMinutes(startedAt, 55),
      version: 3,
      createdBy: h.user.id!,
      updatedBy: h.user.id!,
      createdAt: addMinutes(startedAt, -5),
    } as never);
    report.grants.push(`G-00${h.id}`);
  }

  const tulip = await Society.findOne({ where: { slug: 'tulip-gardens' } });
  const admin = await User.findOne({ where: { mobile: '9000000001' } });
  const body =
    'Onboarding call booked with the secretary for Monday 11:00. They want help importing 60 flats.';
  if (
    tulip &&
    admin &&
    !(await SocietyNote.count({ where: { societyId: tulip.id!, body }, paranoid: false }))
  ) {
    await SocietyNote.create({
      societyId: tulip.id!,
      category: 'ONBOARDING',
      body,
      isPinned: true,
      version: 1,
      createdBy: admin.id!,
      updatedBy: admin.id!,
    });
    report.notes++;
  }
  return report;
}
