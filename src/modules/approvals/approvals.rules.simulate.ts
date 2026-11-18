import { User, sequelize } from '../../models';
import { Op } from 'sequelize';
import type { Ctx } from '../../types/context';
import { UnprocessableError } from '../../utils/errors';
import { typeMeta } from './approvals.catalogue';
import { ERR } from './approvals.constants';
import { slotsOf, stepCapacity } from './approvals.match';
import { approversOf, loadMemberAccess } from './approvals.rules.assess';
import { routeRequest } from './approvals.route';
import { requireSociety } from './approvals.shared';

/** 8.16: which rule would match a sample request and who could approve each step now. No writes except default seeding. */
export async function simulateRule(
  ctx: Ctx,
  body: { type: string; amountPaise: number; categoryKey?: string; requesterUserId?: number },
) {
  const societyId = requireSociety(ctx);
  const meta = typeMeta(body.type)!;
  const requesterId = body.requesterUserId ?? ctx.user!.id;
  const access = await loadMemberAccess(societyId);
  const requester = access.find(a => a.userId === requesterId);
  if (!requester)
    throw new UnprocessableError(ERR.stepUserNotEligible, 'The requester is not an active member', [
      { field: 'requesterUserId', message: 'Not an active member' },
    ]);
  const approvers = approversOf(access, body.type);
  const routed = await sequelize.transaction(t =>
    routeRequest(
      ctx,
      societyId,
      meta,
      {
        amountPaise: body.amountPaise,
        categoryKey: body.categoryKey ?? null,
        requesterRoleKey: requester.roleKey,
        requesterUserId: requesterId,
      },
      t,
      approvers,
    ),
  );
  const snap = routed.snapshot;
  const steps = snap?.action === 'REQUIRE_APPROVAL' ? snap.steps : [];
  const ids = new Set<number>();
  const per = steps.map(step => {
    const slots = slotsOf(step);
    const excluded = new Set<number>([requesterId]);
    const avail = approvers.filter(m => !excluded.has(m.userId));
    const eligible: { userId: number; roleKey: string; via: 'ROLE' | 'USER' | 'FALLBACK' }[] = [];
    const vacantSlots: { slotType: 'ROLE' | 'USER'; slotRef: string }[] = [];
    for (const s of slots) {
      const hit = avail.filter(m => (s.type === 'USER' ? String(m.userId) === s.ref : m.roleKey === s.ref));
      if (!hit.length) vacantSlots.push({ slotType: s.type, slotRef: s.ref });
      for (const m of hit)
        if (!eligible.some(e => e.userId === m.userId))
          eligible.push({ userId: m.userId, roleKey: m.roleKey, via: s.type });
    }
    const cap = stepCapacity(step, slots, approvers, excluded, snap!.fallbackRoleKeys);
    if (cap.widened)
      for (const m of avail)
        if (snap!.fallbackRoleKeys.includes(m.roleKey) && !eligible.some(e => e.userId === m.userId))
          eligible.push({ userId: m.userId, roleKey: m.roleKey, via: 'FALLBACK' });
    eligible.forEach(e => ids.add(e.userId));
    return { step, eligible, vacantSlots };
  });
  const names = new Map(
    (ids.size
      ? await User.findAll({ where: { id: { [Op.in]: [...ids] } }, attributes: ['id', 'name'] })
      : []
    ).map(u => [Number(u.id), u.name as string]),
  );
  return {
    matchedRuleId: routed.ruleId,
    ruleName: snap?.name ?? null,
    routing: routed.routing,
    stepUpRequired: routed.stepUpRequired,
    steps: per.map(p => ({
      stepNo: p.step.stepNo,
      name: p.step.name,
      mode: p.step.mode,
      eligibleNow: p.eligible.map(e => ({ ...e, name: names.get(e.userId) ?? null })),
      vacantSlots: p.vacantSlots,
    })),
  };
}
