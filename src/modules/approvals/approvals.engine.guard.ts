import { Op } from 'sequelize';
import { Society } from '../../models';
import { systemCtx, type Ctx } from '../../types/context';
import { societyStateGuard } from '../societies/societies.guard';
import { isJobAllowed } from '../societies/societies.guard';

const n = (v: unknown): number => Number(v);

/**
 * BR-14-30: every write of this module obeys module 05's guard. The HTTP middleware does it for routes; services that change
 * state call this too (a closed society is blocked, a suspended society allows reads only), so a job or another module cannot bypass it.
 */
export function assertSocietyWritable(ctx: Ctx): void {
  const status = ctx.society?.status;
  if (!status) return;
  const e = societyStateGuard({ status, method: 'POST' });
  if (e) throw e;
}

/** The context jobs use for a society (system actor, the society's own id). */
export const jobCtx = (societyId: number, status = 'ACTIVE'): Ctx => ({
  ...systemCtx('approvals-job'),
  society: { id: societyId, name: '', status, timezone: 'Asia/Kolkata', planKey: '' },
});

/** BR-14-30: society ids (of `ids`) whose status allows jobs tagged `support`; the others are skipped until reactivation. */
export async function allowedSocieties(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!ids.length) return out;
  const rows = await Society.findAll({
    where: { id: { [Op.in]: [...new Set(ids)] } },
    attributes: ['id', 'status'],
  });
  for (const s of rows) if (isJobAllowed(s.status, 'support')) out.set(n(s.id), s.status);
  return out;
}
