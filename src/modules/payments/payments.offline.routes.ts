import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, okList } from '../../utils/response';
import { ENT, PERM } from './payments.constants';
import {
  bounceCheque,
  clearCheque,
  depositCheques,
  listCheques,
  returnCheque,
} from './payments.cheques.service';
import { declareTransfer, recordOffline } from './payments.offline.service';
import { offlineSchemas as s } from './payments.offline.validation';

/**
 * 12.2 routes: `POST /payments/offline` (8.11), the cheque routes (8.12) and `POST /me/payments/declared` (8.6). Order on a
 * route: society marker, permission, entitlement, validate, idempotency. Written for the active society only; the society
 * state guard of `societyMiddleware` answers `423 SOCIETY_SUSPENDED` for these writes.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;

export const paymentsOfflineRoutes = Router();
const r = paymentsOfflineRoutes;

r.post(
  '/payments/offline',
  society(),
  can(PERM.paymentsCreate),
  feature(ENT.cashBankEntry),
  validate({ body: s.offline }),
  idempotency(),
  h(async (req, res) => {
    const p = await recordOffline(req.ctx, v(req).body);
    created(
      res,
      p,
      p.status === 'PENDING_APPROVAL' ? 'Payment recorded and sent for approval' : 'Payment recorded',
    );
  }),
);

r.post(
  '/me/payments/declared',
  society(),
  can(PERM.residentPaymentsCreate),
  feature(ENT.declaredTransfers),
  validate({ body: s.declared }),
  idempotency(),
  h(async (req, res) => {
    created(res, await declareTransfer(req.ctx, v(req).body), 'Transfer sent for approval');
  }),
);

r.get(
  '/payments/cheques/list',
  society(),
  can(PERM.paymentsView),
  feature(ENT.chequeLifecycle, read),
  validate({ query: s.list }),
  h(async (req, res) => {
    const out = await listCheques(req.ctx.society!.id, v(req).query);
    okList(res, out.data, out.pagination);
  }),
);

r.post(
  '/payments/cheques/deposit',
  society(),
  can(PERM.paymentsEdit),
  feature(ENT.chequeLifecycle),
  validate({ body: s.deposit }),
  h(async (req, res) => ok(res, await depositCheques(req.ctx, v(req).body), 'Cheques marked deposited')),
);

r.post(
  '/payments/:id/cheque/clear',
  society(),
  can(PERM.paymentsEdit),
  feature(ENT.chequeLifecycle),
  validate({ params: s.idParam, body: s.clear }),
  h(async (req, res) => ok(res, await clearCheque(req.ctx, v(req).params.id, v(req).body), 'Cheque cleared')),
);

r.post(
  '/payments/:id/cheque/bounce',
  society(),
  can(PERM.paymentsEdit),
  feature(ENT.chequeLifecycle),
  validate({ params: s.idParam, body: s.bounce }),
  idempotency(),
  h(async (req, res) =>
    ok(res, await bounceCheque(req.ctx, v(req).params.id, v(req).body), 'Cheque marked bounced'),
  ),
);

r.post(
  '/payments/:id/cheque/return',
  society(),
  can(PERM.paymentsEdit),
  feature(ENT.chequeLifecycle),
  validate({ params: s.idParam, body: s.ret }),
  h(async (req, res) =>
    ok(res, await returnCheque(req.ctx, v(req).params.id, v(req).body), 'Cheque returned to payer'),
  ),
);
