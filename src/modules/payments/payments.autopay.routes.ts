import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { tag } from '../access-control/access-control.registry';
import { routeMeta } from '../societies/societies.guard';
import { ENT, PERM } from './payments.constants';
import { autopayController as c } from './payments.autopay.controller';
import { assertAutopayAvailable } from './payments.autopay.service';
import { autopaySchemas as s } from './payments.autopay.validation';

/**
 * Sections 8.8 and 8.20. Every mandate route checks the plan (either mandate key, `402 FEATURE_NOT_IN_PLAN`) and the flag
 * `payments.upi_autopay` (`422 AUTOPAY_NOT_AVAILABLE`); create re-checks the key of the chosen type. Cancel (resident and admin)
 * is not gated, so debits can always be stopped; the resident cancel is also allowed while the society is suspended (BR-12-50).
 */
const society = () => societyMiddleware();
const autopayGate = (mode: 'read' | 'write'): RequestHandler =>
  tag(
    async (req, _res, next) => {
      try {
        await assertAutopayAvailable(req.ctx.society!.id, undefined, mode);
        next();
      } catch (err) {
        next(err);
      }
    },
    { features: [ENT.upiAutopay, ENT.enach] },
  );

export const paymentsAutopayRoutes = Router();
const r = paymentsAutopayRoutes;

r.get(
  '/me/autopay-mandates',
  society(),
  can(PERM.residentPaymentsView),
  autopayGate('read'),
  validate({ query: s.myList }),
  c.listMine,
);
r.post(
  '/me/autopay-mandates',
  society(),
  can(PERM.residentPaymentsCreate),
  autopayGate('write'),
  validate({ body: s.create }),
  idempotency(),
  c.create,
);
r.post(
  '/me/autopay-mandates/:id/pause',
  society(),
  can(PERM.residentPaymentsCreate),
  autopayGate('write'),
  validate({ params: s.idParam, body: s.versionBody }),
  c.pause,
);
r.post(
  '/me/autopay-mandates/:id/resume',
  society(),
  can(PERM.residentPaymentsCreate),
  autopayGate('write'),
  validate({ params: s.idParam, body: s.versionBody }),
  c.resume,
);
r.post(
  '/me/autopay-mandates/:id/cancel',
  routeMeta({ suspended: 'allow' }),
  society(),
  can(PERM.residentPaymentsCreate),
  validate({ params: s.idParam, body: s.cancelBody }),
  c.cancel,
);
r.get(
  '/autopay-mandates',
  society(),
  can(PERM.paymentsView),
  autopayGate('read'),
  validate({ query: s.adminList }),
  c.listAdmin,
);
r.post(
  '/autopay-mandates/:id/cancel',
  society(),
  can(PERM.paymentsEdit),
  validate({ params: s.idParam, body: s.adminCancel }),
  c.cancelAdmin,
);
