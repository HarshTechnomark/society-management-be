import { ApprovalRequest } from '../../models';
import type { Ctx } from '../../types/context';
import { NotFoundError } from '../../utils/errors';
import { ERR } from './approvals.constants';
import { loadActions, Viewer, type Evaluated } from './approvals.inbox.eval';
import { actionLine, actionNameIds, namesOf } from './approvals.inbox.rows';
import type { ApprovalAction } from '../../models';

const n = (v: unknown): number => Number(v);

export interface Seen {
  req: ApprovalRequest;
  ev: Evaluated;
  viewer: Viewer;
  rows: ApprovalAction[];
}

/** Loads one request of the caller's society and applies BR-14-26: unknown, other society and not visible are all 404. */
export async function seeRequest(ctx: Ctx, id: number): Promise<Seen> {
  const societyId = ctx.society!.id;
  const req = await ApprovalRequest.findOne({ where: { id, societyId } });
  if (!req) throw new NotFoundError(ERR.notFound, 'Approval request not found');
  const viewer = await Viewer.load(societyId, ctx.user!.id);
  const actions = await loadActions([n(req.id)]);
  const ev = (await viewer.evaluate([req], actions)).get(n(req.id))!;
  if (!ev.visible) throw new NotFoundError(ERR.notFound, 'Approval request not found');
  return { req, ev, viewer, rows: actions.get(n(req.id)) ?? [] };
}

/** 8.5: every request of one entity the caller may see (newest first, at most 50), with its actions. */
export async function entityHistory(ctx: Ctx, q: { entityType: string; entityId: number }) {
  const societyId = ctx.society!.id;
  const reqs = await ApprovalRequest.findAll({
    where: { societyId, entityType: q.entityType, entityId: q.entityId },
    order: [['id', 'DESC']],
    limit: 50,
  });
  if (!reqs.length) return [];
  const viewer = await Viewer.load(societyId, ctx.user!.id);
  const actions = await loadActions(reqs.map(r => n(r.id)));
  const ev = await viewer.evaluate(reqs, actions);
  const shown = reqs.filter(r => ev.get(n(r.id))!.visible);
  const allRows = shown.flatMap(r => actions.get(n(r.id)) ?? []);
  const names = await namesOf(actionNameIds(allRows));
  return shown.map(r => ({
    id: n(r.id),
    type: r.type,
    status: r.status,
    round: n(r.round),
    routing: r.routing,
    ruleName: r.ruleSnapshot?.name ?? null,
    amountPaise: n(r.amountPaise),
    actions: (actions.get(n(r.id)) ?? []).map(a => actionLine(a, names)),
  }));
}
