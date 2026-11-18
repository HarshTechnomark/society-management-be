import { Op, type Transaction, type WhereOptions } from 'sequelize';
import { ApprovalDelegation, User, sequelize } from '../../models';
import { addDays, now } from '../../lib/clock';
import { emitToUser } from '../../lib/realtime';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { AUDIT, ENTITY, ERR, LIMITS, NOTIFY, PERM, RT } from './approvals.constants';
import { bumpEpoch } from './approvals.engine.counts';
import { sendTo } from './approvals.notify';
import { afterCommit, memberInfo, requireSociety } from './approvals.shared';

const n = (v: unknown): number => Number(v);
const FIVE_MIN = 5 * 60_000;

export type DisplayStatus = 'SCHEDULED' | 'ACTIVE' | 'REVOKED' | 'EXPIRED';
export function displayStatus(
  d: Pick<ApprovalDelegation, 'status' | 'startsAt' | 'endsAt'>,
  at: Date = now(),
): DisplayStatus {
  if (d.status === 'REVOKED') return 'REVOKED';
  if (d.status === 'EXPIRED' || d.endsAt.getTime() <= at.getTime()) return 'EXPIRED';
  return d.startsAt.getTime() > at.getTime() ? 'SCHEDULED' : 'ACTIVE';
}

async function names(ids: number[]): Promise<Map<number, string>> {
  const rows = await User.findAll({
    where: { id: { [Op.in]: [...new Set(ids)] } },
    attributes: ['id', 'name'],
  });
  return new Map(rows.map(u => [n(u.id), (u.name as string | null) ?? 'Member']));
}

/** The 8.18 shape of a delegation. */
export async function delegationViews(rows: ApprovalDelegation[]) {
  const nm = await names(rows.flatMap(r => [n(r.delegatorUserId), n(r.delegateUserId)]));
  return rows.map(r => ({
    id: n(r.id),
    delegator: { userId: n(r.delegatorUserId), name: nm.get(n(r.delegatorUserId)) ?? null },
    delegate: { userId: n(r.delegateUserId), name: nm.get(n(r.delegateUserId)) ?? null },
    source: r.source,
    types: r.types,
    maxAmountPaise: r.maxAmountPaise === null ? null : n(r.maxAmountPaise),
    startsAt: r.startsAt.toISOString(),
    endsAt: r.endsAt.toISOString(),
    reason: r.reason,
    status: r.status,
    displayStatus: displayStatus(r),
    committeeTermId: r.committeeTermId === null ? null : n(r.committeeTermId),
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    revokeReason: r.revokeReason,
    version: n(r.version),
    createdAt: r.createdAt.toISOString(),
  }));
}

// ------------------------------------------------------------------ list
export async function listDelegations(
  ctx: Ctx,
  q: {
    scope: 'MINE' | 'ALL';
    status?: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
    page: number;
    limit: number;
    sortBy: 'startsAt' | 'createdAt';
    sortOrder: 'asc' | 'desc';
  },
) {
  const societyId = requireSociety(ctx);
  const me = ctx.user!.id;
  if (q.scope === 'ALL' && !ctx.permissions?.has(PERM.rulesView))
    throw new ForbiddenError('PERMISSION_DENIED', 'You do not have permission to do this');
  const and: WhereOptions[] = [{ societyId }];
  if (q.scope === 'MINE') and.push({ [Op.or]: [{ delegatorUserId: me }, { delegateUserId: me }] });
  const at = now();
  if (q.status === 'REVOKED') and.push({ status: 'REVOKED' });
  else if (q.status === 'ACTIVE') and.push({ status: 'ACTIVE', endsAt: { [Op.gt]: at } });
  else if (q.status === 'EXPIRED')
    and.push({ [Op.or]: [{ status: 'EXPIRED' }, { status: 'ACTIVE', endsAt: { [Op.lte]: at } }] });
  const where = { [Op.and]: and };
  const { rows, count } = await ApprovalDelegation.findAndCountAll({
    where,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: await delegationViews(rows), pagination: pageMeta(q.page, q.limit, count) };
}

// ------------------------------------------------------------------ create (BR-14-24)
export interface CreateDelegationInput {
  delegatorUserId: number;
  delegateUserId: number;
  startsAt: Date;
  endsAt: Date;
  types: string[] | null;
  maxAmountPaise: number | null;
  reason: string;
  source: 'OUT_OF_OFFICE' | 'TERM_HANDOVER';
  committeeTermId?: number | null;
}

const overlapWhere = (
  userCol: 'delegatorUserId' | 'delegateUserId',
  userId: number,
  i: { startsAt: Date; endsAt: Date },
) => ({
  [userCol]: userId,
  status: 'ACTIVE',
  startsAt: { [Op.lt]: i.endsAt },
  endsAt: { [Op.gt]: i.startsAt },
});

/** BR-14-24 and the insert, inside the caller's transaction. Checks in the order of the error table of 8.18. */
async function createIn(ctx: Ctx, societyId: number, i: CreateDelegationInput, t: Transaction) {
  if (i.delegateUserId === i.delegatorUserId)
    throw new UnprocessableError(ERR.delegationSelf, 'You cannot delegate to yourself');
  const maxDays = i.source === 'OUT_OF_OFFICE' ? LIMITS.outOfOfficeMaxDays : LIMITS.handoverMaxDays;
  if (
    i.startsAt.getTime() < now().getTime() - FIVE_MIN ||
    i.endsAt.getTime() <= i.startsAt.getTime() ||
    i.endsAt.getTime() > addDays(i.startsAt, maxDays).getTime()
  )
    throw new UnprocessableError(
      ERR.delegationWindow,
      `The window must start now or later and last at most ${maxDays} days`,
      [{ field: 'endsAt', message: `At most ${maxDays} days after startsAt` }],
    );
  const delegate = await memberInfo(societyId, i.delegateUserId);
  if (!delegate.active || !delegate.permissions.includes(PERM.inboxView))
    throw new UnprocessableError(
      ERR.delegateNotEligible,
      'The delegate must be an active member who can use the approvals inbox',
      [{ field: 'delegateUserId', message: 'Not eligible' }],
    );
  if (i.source === 'OUT_OF_OFFICE' && !(await memberInfo(societyId, i.delegatorUserId)).active)
    throw new ValidationError([{ field: 'delegatorUserId', message: 'Not an active member' }]);

  // delegator rows locked first, so two parallel creates cannot both pass the overlap check
  const mine = await ApprovalDelegation.findAll({
    where: overlapWhere('delegatorUserId', i.delegatorUserId, i),
    lock: t.LOCK.UPDATE,
    transaction: t,
  });
  if (mine.length)
    throw new ConflictError(ERR.delegationOverlap, 'This person already has a delegation in that period');
  const theirs = await ApprovalDelegation.count({
    where: overlapWhere('delegatorUserId', i.delegateUserId, i),
    transaction: t,
  });
  if (theirs)
    throw new UnprocessableError(
      ERR.delegationChain,
      'The delegate has a delegation of their own in that period',
    );

  const row = await ApprovalDelegation.create(
    {
      societyId,
      delegatorUserId: i.delegatorUserId,
      delegateUserId: i.delegateUserId,
      source: i.source,
      types: i.types,
      maxAmountPaise: i.maxAmountPaise,
      startsAt: i.startsAt,
      endsAt: i.endsAt,
      reason: i.reason,
      committeeTermId: i.committeeTermId ?? null,
      endingNotifiedAt: null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      createdBy: ctx.user?.id ?? null,
      updatedBy: ctx.user?.id ?? null,
    },
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: AUDIT.delegationCreated,
      entityType: ENTITY.delegation,
      entityId: n(row.id),
      societyId,
      after: {
        delegatorUserId: i.delegatorUserId,
        delegateUserId: i.delegateUserId,
        source: i.source,
        types: i.types,
        maxAmountPaise: i.maxAmountPaise,
        startsAt: i.startsAt.toISOString(),
        endsAt: i.endsAt.toISOString(),
      },
      reason: i.reason,
    },
    t,
  );
  const [view] = await delegationViews([row]);
  afterCommit(t, async () => {
    await bumpEpoch(societyId);
    const actor = ctx.user?.id ?? null;
    const to =
      actor !== null && actor === i.delegatorUserId
        ? [i.delegateUserId]
        : [i.delegateUserId, i.delegatorUserId];
    await sendTo(NOTIFY.delegationCreated, to, notificationData(view!));
    for (const u of new Set([i.delegatorUserId, i.delegateUserId]))
      emitToUser(u, RT.delegationUpdated, { delegationId: n(row.id), displayStatus: view!.displayStatus });
  });
  return { row, view: view! };
}

const notificationData = (v: Awaited<ReturnType<typeof delegationViews>>[number]) => ({
  delegationId: v.id,
  title: `${v.delegator.name ?? 'A member'} to ${v.delegate.name ?? 'a member'}`,
  typeLabel: 'Delegation',
  delegatorName: v.delegator.name,
  delegateName: v.delegate.name,
  startsAt: v.startsAt,
  endsAt: v.endsAt,
  reason: v.reason,
});

/** `POST /approvals/delegations` (OUT_OF_OFFICE). The plan gate (`iam.approval_delegation`) is on the route. */
export async function createDelegation(
  ctx: Ctx,
  body: {
    delegatorUserId?: number;
    delegateUserId: number;
    startsAt: Date;
    endsAt: Date;
    types?: string[] | null;
    maxAmountPaise?: number | null;
    reason: string;
  },
) {
  const societyId = requireSociety(ctx);
  const delegatorUserId = body.delegatorUserId ?? ctx.user!.id;
  if (delegatorUserId !== ctx.user!.id && !ctx.permissions?.has(PERM.rulesEdit))
    throw new ForbiddenError('PERMISSION_DENIED', 'You can only delegate your own approvals');
  const { view } = await sequelize.transaction(t =>
    createIn(
      ctx,
      societyId,
      {
        delegatorUserId,
        delegateUserId: body.delegateUserId,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        types: body.types ?? null,
        maxAmountPaise: body.maxAmountPaise ?? null,
        reason: body.reason,
        source: 'OUT_OF_OFFICE',
      },
      t,
    ),
  );
  return view;
}

/**
 * Module 10 (BR-10-18): a `TERM_HANDOVER` delegation from the outgoing to the incoming office-holder, inside the caller's
 * transaction (one savepoint per pair). Always honoured, no plan gate. Refusals use the five codes the committee module skips.
 */
export async function createHandoverDelegation(
  ctx: Ctx,
  input: {
    fromUserId: number;
    toUserId: number;
    startsAt: Date;
    endsAt: Date;
    reason: string;
    committeeTermId: number;
  },
  t: Transaction,
): Promise<{ id: number }> {
  const societyId = requireSociety(ctx);
  const { row } = await createIn(
    ctx,
    societyId,
    {
      delegatorUserId: input.fromUserId,
      delegateUserId: input.toUserId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      types: null,
      maxAmountPaise: null,
      reason: input.reason,
      source: 'TERM_HANDOVER',
      committeeTermId: input.committeeTermId,
    },
    t,
  );
  return { id: n(row.id) };
}

// ------------------------------------------------------------------ revoke
export async function revokeDelegation(ctx: Ctx, id: number, body: { version: number; reason: string }) {
  const societyId = requireSociety(ctx);
  const me = ctx.user!.id;
  return sequelize.transaction(async t => {
    const row = await ApprovalDelegation.findOne({
      where: { id, societyId },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!row) throw new NotFoundError(ERR.delegationNotFound, 'Delegation not found');
    if (n(row.delegatorUserId) !== me && !ctx.permissions?.has(PERM.rulesEdit))
      throw new ForbiddenError('PERMISSION_DENIED', 'Only the delegator or a rule editor can revoke this');
    if (row.status !== 'ACTIVE')
      throw new ConflictError(ERR.delegationNotActive, 'This delegation is already revoked or expired');
    if (n(row.version) !== body.version)
      throw new ConflictError(ERR.stale, 'This delegation changed. Reload and try again.');
    await row.update(
      {
        status: 'REVOKED',
        revokedAt: now(),
        revokedBy: me,
        revokeReason: body.reason,
        version: n(row.version) + 1,
        updatedBy: me,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.delegationRevoked,
        entityType: ENTITY.delegation,
        entityId: id,
        societyId,
        before: { status: 'ACTIVE' },
        after: { status: 'REVOKED' },
        reason: body.reason,
      },
      t,
    );
    const [view] = await delegationViews([row]);
    afterCommit(t, async () => {
      await bumpEpoch(societyId);
      await sendTo(
        NOTIFY.delegationRevoked,
        [n(row.delegatorUserId), n(row.delegateUserId)],
        notificationData(view!),
      );
      for (const u of new Set([n(row.delegatorUserId), n(row.delegateUserId)]))
        emitToUser(u, RT.delegationUpdated, { delegationId: id, displayStatus: 'REVOKED' });
    });
    return view!;
  });
}
