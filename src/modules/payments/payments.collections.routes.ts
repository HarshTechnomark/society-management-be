import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { routeMeta } from '../societies/societies.guard';
import { ENT, PERM } from './payments.constants';
import { collectionsController as c } from './payments.collections.controller';
import { collectionSchemas as s } from './payments.collections.validation';

/**
 * Sub-module 12.5 routes (sections 8.9 and 8.21 to 8.23). Order on a route: society marker, permission, entitlement, validate,
 * idempotency (create only). Reads use the plan's read grace.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;

export const paymentsCollectionsRoutes = Router();
const r = paymentsCollectionsRoutes;

// resident
r.get(
  '/me/collections',
  society(),
  can(PERM.residentDuesView, PERM.residentFinancesView),
  feature(ENT.collections, read),
  c.meList,
);
r.get(
  '/me/collections/:id',
  society(),
  can(PERM.residentDuesView, PERM.residentFinancesView),
  feature(ENT.collections, read),
  validate({ params: s.idParam }),
  c.meGet,
);

// admin
r.get(
  '/collections',
  society(),
  can(PERM.collectionsView),
  feature(ENT.collections, read),
  validate({ query: s.list }),
  c.list,
);
r.post(
  '/collections',
  society(),
  can(PERM.collectionsCreate),
  feature(ENT.collections),
  validate({ body: s.create }),
  idempotency(),
  c.create,
);
r.get(
  '/collections/:id',
  society(),
  can(PERM.collectionsView),
  feature(ENT.collections, read),
  validate({ params: s.idParam }),
  c.get,
);
r.patch(
  '/collections/:id',
  society(),
  can(PERM.collectionsEdit),
  feature(ENT.collections),
  validate({ params: s.idParam, body: s.patch }),
  c.patch,
);
r.delete(
  '/collections/:id',
  society(),
  can(PERM.collectionsDelete),
  feature(ENT.collections),
  validate({ params: s.idParam, query: s.deleteQuery }),
  c.remove,
);
const action = (path: string, body: (typeof s)['versionBody'], handler: import('express').RequestHandler) =>
  r.post(
    `/collections/:id/${path}`,
    society(),
    can(PERM.collectionsEdit),
    feature(ENT.collections),
    validate({ params: s.idParam, body }),
    handler,
  );
action('submit', s.versionBody, c.submit);
action('publish', s.publish as never, c.publish);
action('remind', s.versionBody, c.remind);
action('close', s.reasonBody as never, c.close);
action('cancel', s.reasonBody as never, c.cancel);

r.get(
  '/collections/:id/requests',
  society(),
  can(PERM.collectionsView),
  feature(ENT.collections, read),
  validate({ params: s.idParam, query: s.requestList }),
  c.requests,
);
r.post(
  '/collections/:id/requests',
  society(),
  can(PERM.collectionsEdit),
  feature(ENT.collections),
  validate({ params: s.idParam, body: s.addRequests }),
  c.addRequests,
);
r.get(
  '/collections/:id/requests/export',
  routeMeta({ noSupportAccess: true }),
  society(),
  can(PERM.collectionsExport),
  feature(ENT.collections, read),
  validate({ params: s.idParam, query: s.requestExport }),
  c.exportRequests,
);
r.post(
  '/collection-requests/:id/waive',
  society(),
  can(PERM.collectionsEdit),
  feature(ENT.collections),
  validate({ params: s.idParam, body: s.waive }),
  c.waive,
);
r.get(
  '/collections/:id/statement',
  society(),
  can(PERM.collectionsView),
  feature(ENT.collections, read),
  validate({ params: s.idParam, query: s.statement }),
  c.statement,
);
