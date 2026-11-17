import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { created } from '../../utils/response';
import { ENT, PERM } from './accounts.constants';
import { postOpeningBalances } from './accounts.opening.service';
import { openingSchemas as s, type OpeningInput } from './accounts.opening.validation';

/** 13.1 route 8.12 (row 25). The simple mode is on every plan; other accounts are gated in the service (`accounting.opening_balance_import`). */
export const accountsOpeningRoutes = Router();

accountsOpeningRoutes.post(
  '/accounts/opening-balances',
  societyMiddleware(),
  can(PERM.accountsCreate),
  feature(ENT.cashBook),
  validate({ body: s.post }),
  idempotency(),
  asyncHandler(async (req, res) => {
    const key = String(req.header('Idempotency-Key'));
    created(
      res,
      await postOpeningBalances(req.ctx, req.valid.body as OpeningInput, key),
      'Opening balances posted',
    );
  }),
);
