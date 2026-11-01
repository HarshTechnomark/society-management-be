import { Op, QueryTypes } from 'sequelize';
import { Society, sequelize } from '../../models';
import type { HealthBreakdown } from '../../models/society.model';
import { addDays, istDate, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, ConflictError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { auth } from '../auth/auth.public';
import { subscriptions } from '../subscriptions/subscriptions.public';
import { societyPorts } from './societies.ports';
import { AUDIT, type HealthBand, type SocietyStatus } from './societies.types';
import { groups, send } from './societies.notify';
import { lockSociety, societyNotFound } from './societies.lifecycle';

/** Daily health score (6.5, BR-05-35), at-risk list for module 07 and the success-team nudge (BR-05-36). */

export const WEIGHTS: Record<keyof HealthBreakdown, number> = {
  adoption: 30,
  onboarding: 20,
  collections: 20,
  adminActivity: 15,
  billing: 15,
};

/** `roundHalfUp(100 × Σ(weight × value) ÷ Σ(weight of non-null components))`; 0 when every component is null. */
export function healthScore(b: HealthBreakdown): number {
  let num = 0;
  let den = 0;
  for (const [k, w] of Object.entries(WEIGHTS) as [keyof HealthBreakdown, number][]) {
    const v = b[k];
    if (v === null || v === undefined) continue;
    num += w * v;
    den += w;
  }
  if (den === 0) return 0;
  const raw = Math.round(((100 * num) / den) * 1e6) / 1e6;
  return Math.min(100, Math.max(0, Math.floor(raw + 0.5)));
}

export const healthBand = (score: number): HealthBand =>
  score >= 75 ? 'HEALTHY' : score >= 55 ? 'WATCH' : 'AT_RISK';

export function billingStanding(status: SocietyStatus, overdue: boolean): number {
  if (status === 'ACTIVE') return overdue ? 0.3 : 1;
  if (status === 'TRIAL') return 0.7;
  if (status === 'PAST_DUE') return 0.3;
  return 0;
}

const NON_ADMIN_ROLES = [
  'owner',
  'tenant',
  'family_member',
  'guard',
  'maintenance_staff',
  'vendor',
  'system',
];

/** Distinct days with an admin write in the last `days` days (module 01 audit). */
export async function adminActiveDays(societyId: number, days: number): Promise<number> {
  const rows = await sequelize.query<{ n: number }>(
    `SELECT COUNT(DISTINCT DATE(createdAt)) AS n FROM audit_logs
     WHERE societyId = :societyId AND actorUserId IS NOT NULL AND createdAt >= :since
       AND actorRole NOT IN (:excluded) AND actorRole NOT LIKE 'support%'`,
    {
      replacements: { societyId, since: addDays(now(), -days), excluded: NON_ADMIN_ROLES },
      type: QueryTypes.SELECT,
    },
  );
  return Number(rows[0]?.n ?? 0);
}

const lastFullMonth = (): string => {
  const [y, m] = istDate(now()).split('-').map(Number) as [number, number];
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return `${py}-${String(pm).padStart(2, '0')}`;
};

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Computes and stores the score of one society. CLOSED societies get 0. */
export async function computeHealth(
  societyId: number,
): Promise<{ score: number; breakdown: HealthBreakdown | null }> {
  const s = await Society.findByPk(societyId);
  if (!s) throw societyNotFound();
  if (s.status === 'CLOSED') {
    await Society.update({ healthScore: 0, healthComputedAt: now() }, { where: { id: societyId } });
    return { score: 0, breakdown: null };
  }
  const p = societyPorts();
  const active = await auth.countActiveUsers(societyId, 30);
  const units = (await p.units.count(societyId)) ?? s.approxFlats ?? 0;
  const onboarding = await p.onboarding.progressPercent(societyId);
  const collections = await p.collections.efficiency(societyId, lastFullMonth());
  const adminDays = await adminActiveDays(societyId, 30);
  const overdue = await p.billing.hasOverdueInvoice(societyId);
  const breakdown: HealthBreakdown = {
    adoption: round3(Math.min(1, active / Math.max(1, units))),
    onboarding: onboarding === null ? null : round3(Math.min(1, onboarding / 100)),
    collections: collections === null ? null : round3(Math.min(1, collections)),
    adminActivity: round3(Math.min(1, adminDays / 12)),
    billing: billingStanding(s.status, overdue),
  };
  const score = healthScore(breakdown);
  await Society.update(
    {
      healthScore: score,
      healthBreakdown: breakdown,
      healthComputedAt: now(),
      activeUsers30: active,
      unitsSnapshot: (await p.units.count(societyId)) ?? 0,
    },
    { where: { id: societyId } },
  );
  return { score, breakdown };
}

/** `societies:compute-health` (daily 04:00 IST, batches of 200). CLOSED societies are set to 0 once and skipped later. */
export async function runComputeHealth(): Promise<number> {
  let lastId = 0;
  let n = 0;
  for (;;) {
    const batch = await Society.findAll({
      where: {
        id: { [Op.gt]: lastId },
        [Op.or]: [{ status: { [Op.ne]: 'CLOSED' } }, { healthScore: { [Op.gt]: 0 } }],
      },
      attributes: ['id'],
      order: [['id', 'ASC']],
      limit: 200,
    });
    if (!batch.length) break;
    for (const s of batch) {
      try {
        await computeHealth(s.id!);
        n++;
      } catch (err) {
        logger.warn({ err, societyId: s.id }, 'health score failed');
      }
    }
    lastId = batch[batch.length - 1]!.id!;
  }
  return n;
}

export async function getHealth(societyId: number) {
  const s = await Society.findByPk(societyId, {
    attributes: ['id', 'healthScore', 'healthBreakdown', 'healthComputedAt'],
  });
  if (!s) throw societyNotFound();
  return {
    score: s.healthScore,
    band: healthBand(s.healthScore),
    computedAt: s.healthComputedAt,
    breakdown: s.healthBreakdown as Record<string, number | null> | null,
  };
}

/** Module 07 dashboard "At-risk tenants". */
export async function listAtRiskSocieties(
  opts: { below?: number; limit?: number; statuses?: SocietyStatus[] } = {},
) {
  const below = opts.below ?? 55;
  const limit = Math.min(50, Math.max(1, opts.limit ?? 5));
  const rows = await Society.findAll({
    where: {
      status: { [Op.in]: opts.statuses ?? ['TRIAL', 'ACTIVE', 'PAST_DUE'] },
      healthScore: { [Op.lt]: below },
    },
    order: [
      ['healthScore', 'ASC'],
      ['id', 'ASC'],
    ],
    limit,
  });
  const plans = await subscriptions.summaryForSocieties(rows.map(r => r.id!));
  return rows.map(r => ({
    societyId: r.id!,
    name: r.name,
    status: r.status,
    planKey: plans.get(r.id!)?.planKey ?? 'NONE',
    healthScore: r.healthScore,
    activeUsers30d: r.activeUsers30,
  }));
}

// ------------------------------------------------------------------ nudge (8.15)
export async function nudge(
  ctx: Ctx,
  societyId: number,
  input: { template: 'ONBOARDING_HELP' | 'ADOPTION_TIPS' | 'PAYMENT_SETUP'; note?: string },
) {
  const r = await sequelize.transaction(async t => {
    const s = await lockSociety(societyId, t);
    if (s.status === 'SUSPENDED' || s.status === 'CLOSED')
      throw new ConflictError('INVALID_STATE', 'Nudges go only to trial, active or past-due societies');
    if (s.lastNudgedAt && now().getTime() - s.lastNudgedAt.getTime() < 86_400_000)
      throw new AppError(429, 'NUDGE_TOO_SOON', 'This society was nudged in the last 24 hours');
    const recipients = await groups.chairAndAdmin(societyId);
    s.lastNudgedAt = now();
    await s.save({ transaction: t, fields: ['lastNudgedAt', 'updatedAt'] });
    await audit(
      ctx,
      {
        action: AUDIT.nudged,
        entityType: 'society',
        entityId: societyId,
        entityLabel: s.name,
        societyId,
        after: { template: input.template, sentTo: recipients.length },
      },
      t,
    );
    return { recipients, name: s.name, lastNudgedAt: s.lastNudgedAt };
  });
  await send('societies.success_nudge', r.recipients, {
    societyName: r.name,
    template: input.template,
    note: input.note ?? '',
  });
  return { sentTo: r.recipients.length, lastNudgedAt: r.lastNudgedAt.toISOString() };
}
