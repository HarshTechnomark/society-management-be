import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { getApprovalSettings, updateApprovalSettings } from './approvals.settings.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);

export const settingsController = {
  get: h(async (req, res) => ok(res, await getApprovalSettings(req.ctx.society!.id))),
  patch: h(async (req, res) =>
    ok(res, await updateApprovalSettings(req.ctx, req.valid.body), 'Approval settings updated'),
  ),
};
