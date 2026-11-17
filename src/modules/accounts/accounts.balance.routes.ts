import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { ENT, PERM } from './accounts.constants';
import { balanceHistory, getSocietyBalance } from './accounts.balance.service';
import { balanceSchemas as s } from './accounts.balance.validation';

/** 13.1 routes 8.1 and 8.2. Always-on feature `accounting.live_society_balance` (read mode keeps it readable after a downgrade). */
export const accountsBalanceRoutes = Router();
const read = { mode: 'read' } as const;

accountsBalanceRoutes.get(
  '/society-balance',
  societyMiddleware(),
  can(PERM.accountsView),
  feature(ENT.liveBalance, read),
  asyncHandler(async (req, res) => {
    ok(res, await getSocietyBalance(req.ctx.society!.id));
  }),
);

accountsBalanceRoutes.get(
  '/society-balance/history',
  societyMiddleware(),
  can(PERM.accountsView),
  feature(ENT.liveBalance, read),
  validate({ query: s.history }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query as { from: string; to: string };
    ok(res, await balanceHistory(req.ctx.society!.id, q.from, q.to));
  }),
);
