import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/response';
import { ENT, PERM } from './accounts.constants';
import { createLedgerAccount, listLedgerAccounts, updateLedgerAccount } from './accounts.ledger.service';
import {
  ledgerSchemas as s,
  type LedgerCreateInput,
  type LedgerListQuery,
  type LedgerPatchInput,
} from './accounts.ledger.validation';

/** 13.1 routes 8.10 (rows 15 to 17). The tree `GET` is always on (expense pickers); create and edit need `accounting.chart_of_accounts`. */
export const accountsLedgerRoutes = Router();
const r = accountsLedgerRoutes;

r.get(
  '/accounts/ledger-accounts',
  societyMiddleware(),
  can(PERM.accountsView, PERM.expensesCreate),
  validate({ query: s.list }),
  asyncHandler(async (req, res) => {
    ok(res, await listLedgerAccounts(req.ctx, req.valid.query as LedgerListQuery));
  }),
);

r.post(
  '/accounts/ledger-accounts',
  societyMiddleware(),
  can(PERM.accountsEdit),
  feature(ENT.chartOfAccounts),
  validate({ body: s.create }),
  idempotency(),
  asyncHandler(async (req, res) => {
    created(res, await createLedgerAccount(req.ctx, req.valid.body as LedgerCreateInput), 'Account created');
  }),
);

r.patch(
  '/accounts/ledger-accounts/:id',
  societyMiddleware(),
  can(PERM.accountsEdit),
  feature(ENT.chartOfAccounts),
  validate({ params: s.idParam, body: s.patch }),
  asyncHandler(async (req, res) => {
    const id = (req.valid.params as { id: number }).id;
    ok(res, await updateLedgerAccount(req.ctx, id, req.valid.body as LedgerPatchInput), 'Account updated');
  }),
);
