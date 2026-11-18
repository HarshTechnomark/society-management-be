import { Op } from 'sequelize';
import { ApprovalDelegation, ApprovalRequest } from '../../models';
import { now } from '../../lib/clock';
import { kv } from '../../lib/kv';
import { logger } from '../../lib/logger';
import { computeAccess } from '../access-control/access-control.public';
import { LIMITS, PERM } from './approvals.constants';
import { activeDelegationsTo, evaluateIdentity } from './approvals.eligibility';
import { evaluateStep, loadApprovers, roundState } from './approvals.shared';
import type { ApproverMember } from './approvals.types';

const n = (v: unknown): number => Number(v);

export interface ApprovalCounts {
  forMe: number;
  forMeByType: Record<string, number>;
  overdueForMe: number;
  allPending: number;
  submittedOpen: number;
  stuck: number;
}

const epochKey = (societyId: number) => `appr:epoch:${societyId}`;
const cacheKey = (societyId: number, userId: number, epoch: number) =>
  `appr:count:${societyId}:${userId}:${epoch}`;

/** 8.2: `appr:epoch:<societyId>` is incremented after every commit that changes a request of the society. */
export async function bumpEpoch(societyId: number): Promise<void> {
  try {
    await kv().counterIncr(epochKey(societyId));
  } catch (err) {
    logger.error({ err }, 'approvals epoch bump failed');
  }
}
export const getEpoch = (societyId: number): Promise<number> => kv().counterGet(epochKey(societyId));

/** Open PENDING requests the user can act on now, by themselves or through a delegation (BR-14-7 to BR-14-9, BR-14-23). */
async function requestsForUser(
  societyId: number,
  userId: number,
): Promise<{ pending: ApprovalRequest[]; forMe: ApprovalRequest[] }> {
  const pending = await ApprovalRequest.findAll({
    where: { societyId, status: 'PENDING' },
    order: [['id', 'ASC']],
    limit: LIMITS.inboxMax,
  });
  const hasDelegations =
    (await ApprovalDelegation.count({
      where: { societyId, delegateUserId: userId, status: 'ACTIVE', endsAt: { [Op.gt]: now() } },
    })) > 0;
  const membersByType = new Map<string, ApproverMember[]>();
  const forMe: ApprovalRequest[] = [];
  for (const req of pending) {
    if (!membersByType.has(req.type)) membersByType.set(req.type, await loadApprovers(societyId, req.type));
    const members = membersByType.get(req.type)!;
    const round = await roundState(req);
    const ev = evaluateStep(req, members, round);
    if (!ev) continue;
    let ok = evaluateIdentity(req, ev, round, userId, userId).ok;
    if (!ok && hasDelegations)
      for (const d of await activeDelegationsTo(societyId, userId, req)) {
        if (evaluateIdentity(req, ev, round, userId, n(d.delegatorUserId)).ok) {
          ok = true;
          break;
        }
      }
    if (ok) forMe.push(req);
  }
  return { pending, forMe };
}

/** 8.2 without the cache. `stuck` is non-zero only for the Chairman and holders of `settings.approval_rules.edit`. */
export async function computeCounts(societyId: number, userId: number): Promise<ApprovalCounts> {
  const { pending, forMe } = await requestsForUser(societyId, userId);
  const at = now().getTime();
  const forMeByType: Record<string, number> = {};
  for (const r of forMe) forMeByType[r.type] = (forMeByType[r.type] ?? 0) + 1;
  const access = await computeAccess(societyId, userId);
  const isAdmin = access.roleKey === 'chairman' || access.permissions.includes(PERM.rulesEdit);
  return {
    forMe: forMe.length,
    forMeByType,
    overdueForMe: forMe.filter(r => r.dueAt !== null && r.dueAt.getTime() <= at).length,
    allPending: pending.length,
    submittedOpen: await ApprovalRequest.count({
      where: { societyId, requesterUserId: userId, status: { [Op.in]: ['PENDING', 'CHANGES_REQUESTED'] } },
    }),
    stuck: isAdmin ? pending.filter(r => !r.hasEligibleApprover).length : 0,
  };
}

/** 8.2: cached per user for 60 seconds under the society epoch. */
export async function countsFor(societyId: number, userId: number): Promise<ApprovalCounts> {
  const epoch = await getEpoch(societyId);
  const key = cacheKey(societyId, userId, epoch);
  try {
    const hit = await kv().cacheGet(key);
    if (hit) return JSON.parse(hit) as ApprovalCounts;
  } catch (err) {
    logger.warn({ err }, 'approvals counts cache read failed');
  }
  const counts = await computeCounts(societyId, userId);
  try {
    await kv().cacheSet(key, JSON.stringify(counts), 60);
  } catch (err) {
    logger.warn({ err }, 'approvals counts cache write failed');
  }
  return counts;
}

/** 8.20 `countForUser`: the badge number (module 24 dashboards). */
export async function countForUser(societyId: number, userId: number): Promise<number> {
  return (await countsFor(societyId, userId)).forMe;
}
