import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, okList } from '../../utils/response';
import { createDelegation, listDelegations, revokeDelegation } from './approvals.delegations.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;

export const delegationsController = {
  list: h(async (req, res) => {
    const r = await listDelegations(req.ctx, v(req).query);
    okList(res, r.data, r.pagination);
  }),
  create: h(async (req, res) =>
    created(res, await createDelegation(req.ctx, v(req).body), 'Delegation created'),
  ),
  revoke: h(async (req, res) =>
    ok(res, await revokeDelegation(req.ctx, v(req).params.id, v(req).body), 'Delegation revoked'),
  ),
};
