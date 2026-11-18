import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import { ApprovalDelegation, sequelize } from '../../models';
import { addHours, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import type { Ctx } from '../../types/context';
import { audit } from '../../utils/audit';
import { AUDIT, ENTITY, NOTIFY } from './approvals.constants';
import { allowedSocieties, jobCtx } from './approvals.engine.guard';
import { emitDelegation } from './approvals.engine.member';
import { sendTo } from './approvals.notify';
import { afterCommit } from './approvals.shared';

const n = (v: unknown): number => Number(v);
const BATCH = 200;

async function lockActive(ctx: Ctx, id: number, t: Transaction) {
  const d = await ApprovalDelegation.findOne({
    where: { id, societyId: ctx.society!.id },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  return d && d.status === 'ACTIVE' ? d : null;
}

async function expireOne(ctx: Ctx, id: number, at: Date, t: Transaction): Promise<boolean> {
  const d = await lockActive(ctx, id, t);
  if (!d || d.endsAt.getTime() > at.getTime()) return false;
  d.status = 'EXPIRED';
  d.version = n(d.version) + 1;
  await d.save({ transaction: t });
  await audit(
    ctx,
    {
      action: AUDIT.delegationExpired,
      entityType: ENTITY.delegation,
      entityId: n(d.id),
      societyId: n(d.societyId),
      before: { status: 'ACTIVE' },
      after: { status: 'EXPIRED' },
    },
    t,
  );
  afterCommit(t, () => emitDelegation(d));
  return true;
}

async function notifyEndingOne(ctx: Ctx, id: number, at: Date, t: Transaction): Promise<boolean> {
  const d = await lockActive(ctx, id, t);
  if (!d || d.endingNotifiedAt !== null || d.endsAt.getTime() <= at.getTime()) return false;
  if (d.endsAt.getTime() > addHours(at, 24).getTime()) return false;
  d.endingNotifiedAt = at;
  await d.save({ transaction: t });
  afterCommit(t, () =>
    sendTo(NOTIFY.delegationEnding, [n(d.delegatorUserId), n(d.delegateUserId)], {
      delegationId: n(d.id),
      endsAt: d.endsAt.toISOString(),
    }),
  );
  return true;
}

async function sweep(
  where: object,
  fn: (ctx: Ctx, id: number, at: Date, t: Transaction) => Promise<boolean>,
  at: Date,
): Promise<number> {
  let done = 0;
  let last = 0;
  for (;;) {
    const rows = await ApprovalDelegation.findAll({
      where: { id: { [Op.gt]: last }, status: 'ACTIVE', ...where },
      attributes: ['id', 'societyId'],
      order: [['id', 'ASC']],
      limit: BATCH,
    });
    if (!rows.length) return done;
    last = n(rows[rows.length - 1]!.id);
    const allowed = await allowedSocieties(rows.map(r => n(r.societyId)));
    for (const r of rows) {
      const status = allowed.get(n(r.societyId));
      if (!status) continue;
      try {
        if (await sequelize.transaction(t => fn(jobCtx(n(r.societyId), status), n(r.id), at, t))) done++;
      } catch (err) {
        logger.error({ err, delegationId: r.id }, 'approvals delegation-sweep item failed');
      }
    }
    if (rows.length < BATCH) return done;
  }
}

/** Job `approvals:delegation-sweep` (9.1): ACTIVE with `endsAt` passed becomes EXPIRED; one notice 24 hours before the end. */
export async function runDelegationSweep(at: Date = now()): Promise<{ expired: number; notified: number }> {
  const expired = await sweep({ endsAt: { [Op.lte]: at } }, expireOne, at);
  const notified = await sweep(
    { endsAt: { [Op.gt]: at, [Op.lte]: addHours(at, 24) }, endingNotifiedAt: null },
    notifyEndingOne,
    at,
  );
  return { expired, notified };
}
