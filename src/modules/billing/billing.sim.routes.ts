import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { FEATURES as F, PERMISSIONS as P } from './billing.constants';
import { simulate } from './billing.sim.service';
import { simSchemas } from './billing.sim.validation';

/** `POST /billing/rules/simulate` (section 8.2), 60 per minute per user. Nothing is stored, so no Idempotency-Key. */
export const billingSimRoutes = Router();
billingSimRoutes.post(
  '/billing/rules/simulate',
  societyMiddleware(),
  can(P.rulesView),
  feature(F.calculationMethods),
  validate({ body: simSchemas.simulateBody }),
  rateLimit({ name: 'billing-simulate', limit: 60, windowSeconds: 60, key: req => String(req.ctx.user?.id) }),
  asyncHandler(async (req, res) => {
    ok(res, await simulate(req.ctx, req.valid.body));
  }),
);
