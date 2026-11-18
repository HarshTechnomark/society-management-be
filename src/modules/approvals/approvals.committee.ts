import { ApprovalRequest, Society, User } from '../../models';
import { now } from '../../lib/clock';
import type { Ctx } from '../../types/context';
import { AppError } from '../../utils/errors';
import { computeAccess } from '../access-control/access-control.public';
import { decide, type Verb } from './approvals.decide';
import { ERR } from './approvals.constants';
import { loadApprovers, roundState } from './approvals.shared';

const n = (v: unknown): number => Number(v);

/** The context a signed-in, recently authenticated ACTIVE member of the society has (as the inbox route builds it). */
export async function memberCtx(societyId: number, userId: number): Promise<Ctx> {
  const [access, society, user] = await Promise.all([
    computeAccess(societyId, userId),
    Society.findByPk(societyId),
    User.findByPk(userId),
  ]);
  if (access.status !== 'ACTIVE' || !society || !user)
    throw new AppError(403, ERR.notEligible, 'Not an active member of this society');
  return {
    requestId: 'committee',
    ip: '127.0.0.1',
    userAgent: 'committee',
    user: {
      id: userId,
      name: user.name,
      mobile: user.mobile,
      email: user.email,
      platformRoleId: null,
      status: user.status,
    },
    society: {
      id: societyId,
      name: society.name,
      status: society.status,
      timezone: society.timezone,
      planKey: '',
    },
    membership: {
      id: access.memberId!,
      roleId: access.roleId!,
      roleKey: access.roleKey!,
      roleScope: access.roleScope!,
      status: 'ACTIVE',
      requiresMfa: access.requiresMfa,
    },
    permissions: new Set(access.permissions),
    platformPermissions: new Set(),
    unitIds: access.unitLinks.map(l => l.unitId),
    unitLinks: access.unitLinks,
    actorRoleKey: access.roleKey!,
    session: {
      id: 0,
      authTime: now(),
      clientApp: 'ADMIN',
      activeSocietyId: societyId,
      mfaVerified: true,
      amr: ['pwd', 'otp'] as never,
      supportGrantId: null,
      idleTimeoutMinutes: 30,
      absoluteExpiresAt: new Date(now().getTime() + 86_400_000),
    },
  };
}

const SKIP = new Set<string>([ERR.notEligible, ERR.makerChecker, ERR.alreadyActed]);

/**
 * Decides a request as the society's committee would, through the real decision path (`decide`: eligibility, maker-checker,
 * step completion, handlers). For the demo seed and tests only (no route uses it): `APPROVE` approves step after step with the
 * ACTIVE members who may (the step's roles first, then the rest), until the request leaves `PENDING`; `REJECT` / `CHANGES` is one
 * decision. Members in `exclude` never act. Throws when nobody eligible is left.
 */
export async function decideAsCommittee(
  requestId: number,
  verb: Verb = 'APPROVE',
  o: { reason?: string; exclude?: number[] } = {},
): Promise<ApprovalRequest> {
  for (let guard = 0; guard < 20; guard++) {
    const req = await ApprovalRequest.findByPk(requestId);
    if (!req) throw new AppError(404, ERR.notFound, 'Approval request not found');
    if (req.status !== 'PENDING') return req;
    const societyId = n(req.societyId);
    const round = await roundState(req);
    const skip = new Set<number>([...round.actors, ...round.principals, ...(o.exclude ?? [])]);
    if (req.requesterKind !== 'SYSTEM') skip.add(n(req.requesterUserId));
    const step = req.ruleSnapshot?.steps[n(req.currentStepNo) - 1];
    const roleOrder = [...(step?.roleKeys ?? []), ...(req.ruleSnapshot?.fallbackRoleKeys ?? [])];
    const rank = (roleKey: string) => {
      const i = roleOrder.indexOf(roleKey);
      return i < 0 ? roleOrder.length : i;
    };
    const people = (await loadApprovers(societyId, req.type))
      .filter(m => !skip.has(m.userId))
      .sort((a, b) => rank(a.roleKey) - rank(b.roleKey));
    let acted = false;
    for (const m of people) {
      try {
        const out = await decide(await memberCtx(societyId, m.userId), requestId, verb, {
          version: n(req.version),
          ...(verb === 'APPROVE' ? {} : { reason: o.reason ?? 'Decided by the committee' }),
        });
        if (verb !== 'APPROVE') return out;
        acted = true;
        break;
      } catch (err) {
        if (err instanceof AppError && SKIP.has(err.code)) continue;
        throw err;
      }
    }
    if (!acted)
      throw new AppError(409, ERR.notEligible, `Nobody eligible is left to decide request ${requestId}`);
  }
  throw new AppError(500, ERR.internal, 'The request did not finish');
}
