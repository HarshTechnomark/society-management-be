import { Router, type Request, type RequestHandler, type Response } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { tag } from '../access-control/access-control.registry';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, okList } from '../../utils/response';
import { ENT, PERM } from './accounts.constants';
import { getJournal, listJournals } from './accounts.journal.read';
import {
  cancelDraft,
  createDraft,
  reverseManual,
  submitDraft,
  updateDraft,
} from './accounts.journal.service';
import { journalSchemas as s } from './accounts.journal.validation';

/**
 * 13.1b routes (section 8.11, rows 18 to 24): voucher list and detail (Premium `accounting.journal_engine`), manual journal
 * drafts, submit, cancel and reverse (Premium `accounting.manual_journals`). Order on a route: society marker, permission,
 * entitlement, validate, step-up, idempotency.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const stepUp = () => tag(requireRecentAuth(), { stepUp: true });
const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request) => req.ctx.society!.id;

export const accountsJournalRoutes = Router();
const r = accountsJournalRoutes;

r.get(
  '/accounts/journals',
  society(),
  can(PERM.accountsView),
  feature(ENT.journalEngine, read),
  validate({ query: s.listQuery }),
  h(async (req, res) => {
    const out = await listJournals(sid(req), v(req).query);
    okList(res, out.data, out.pagination);
  }),
);
r.get(
  '/accounts/journals/:id',
  society(),
  can(PERM.accountsView),
  feature(ENT.journalEngine, read),
  validate({ params: s.idParam }),
  h(async (req, res) => ok(res, await getJournal(sid(req), v(req).params.id))),
);
r.post(
  '/accounts/journals',
  society(),
  can(PERM.accountsCreate),
  feature(ENT.manualJournals),
  validate({ body: s.create }),
  idempotency(),
  h(async (req, res) => created(res, await createDraft(req.ctx, v(req).body), 'Draft saved')),
);
r.patch(
  '/accounts/journals/:id',
  society(),
  can(PERM.accountsCreate),
  feature(ENT.manualJournals),
  validate({ params: s.idParam, body: s.update }),
  h(async (req, res) => ok(res, await updateDraft(req.ctx, v(req).params.id, v(req).body), 'Draft updated')),
);
r.post(
  '/accounts/journals/:id/submit',
  society(),
  can(PERM.accountsCreate),
  feature(ENT.manualJournals),
  validate({ params: s.idParam, body: s.submit }),
  idempotency(),
  h(async (req, res) =>
    ok(res, await submitDraft(req.ctx, v(req).params.id, v(req).body.version), 'Sent for approval'),
  ),
);
r.delete(
  '/accounts/journals/:id',
  society(),
  can(PERM.accountsCreate, PERM.accountsApprove),
  feature(ENT.manualJournals),
  validate({ params: s.idParam }),
  h(async (req, res) => ok(res, await cancelDraft(req.ctx, v(req).params.id), 'Draft cancelled')),
);
r.post(
  '/accounts/journals/:id/reverse',
  society(),
  can(PERM.accountsApprove),
  feature(ENT.manualJournals),
  validate({ params: s.idParam, body: s.reverse }),
  stepUp(),
  idempotency(),
  h(async (req, res) =>
    ok(res, await reverseManual(req.ctx, v(req).params.id, v(req).body), 'Journal reversed'),
  ),
);
