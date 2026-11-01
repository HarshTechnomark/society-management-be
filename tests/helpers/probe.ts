import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { requestId } from '../../src/middlewares/requestId.middleware';
import { appContext } from '../../src/middlewares/appContext.middleware';
import { csrfMiddleware } from '../../src/middlewares/csrf.middleware';
import { authMiddleware } from '../../src/middlewares/auth.middleware';
import { errorHandler, notFoundHandler } from '../../src/middlewares/error.middleware';
import { societyMiddleware } from '../../src/middlewares/society.middleware';
import { anyActiveMember, requirePermission } from '../../src/middlewares/permission.middleware';
import { routeMeta } from '../../src/modules/societies/societies.guard';
import { asyncHandler } from '../../src/utils/asyncHandler';
import { audit } from '../../src/utils/audit';
import { created, ok } from '../../src/utils/response';
import { ORIGINS, UA, cookieHeader, type App, type Cookies } from './auth';

/**
 * Stand-ins for routes later modules own (SOS, notices, resident payment orders, KYC download, ticket edit), mounted
 * behind the real pipeline (auth, society middleware with the module 05 state guard, permissions), so the allow-list,
 * default policy and support grant rules are tested end to end before those modules exist.
 */
const probe = express();
probe.use(requestId);
probe.use(cookieParser());
probe.use(express.json());
const api = express.Router();
api.use(appContext);
api.use(csrfMiddleware);
api.use(authMiddleware);
const done = (status = 201) =>
  asyncHandler(async (req, res) => {
    await audit(req.ctx, {
      action: 'probe.write',
      entityType: 'probe',
      entityId: req.path,
      societyId: req.ctx.society?.id ?? null,
    });
    if (status === 201) created(res, { path: req.path });
    else ok(res, { path: req.path });
  });
// module 16 notice publish: default policy (blocked while SUSPENDED)
api.post('/notices/1/publish', societyMiddleware(), anyActiveMember(), done(200));
// module 12 resident payment order: allow-listed while SUSPENDED (BR-05-12)
api.post(
  '/me/payables/payment-orders',
  routeMeta({ suspended: 'allow' }),
  societyMiddleware(),
  anyActiveMember(),
  done(),
);
// module 17 SOS: allowed while SUSPENDED, blocked when CLOSED (BR-05-13)
api.post('/me/sos', routeMeta({ suspended: 'allow' }), societyMiddleware(), anyActiveMember(), done());
// module 11 invoices list: a read, blocked when CLOSED (T05-16)
api.get('/invoices', societyMiddleware(), anyActiveMember(), done(200));
// module 15 ticket edit (a society write a READ_WRITE grant may do)
api.patch('/tickets/1', societyMiddleware(), requirePermission('helpdesk.tickets.edit'), done(200));
// module 09 KYC download: `noSupportAccess`
api.get(
  '/residents/1/kyc/1/download',
  routeMeta({ noSupportAccess: true }),
  societyMiddleware(),
  requirePermission('residents.people.view'),
  done(200),
);
probe.use('/api/v1', api);
probe.use(notFoundHandler);
probe.use(errorHandler);

type M = 'get' | 'post' | 'patch' | 'put' | 'delete';
export const probeAs =
  (cookies: Cookies, appName: App = 'ADMIN') =>
  (method: M, path: string, body?: unknown) => {
    const agent = request(probe);
    let r = agent[method](`/api/v1${path}`)
      .set('User-Agent', UA)
      .set('Origin', ORIGINS[appName])
      .set('Cookie', cookieHeader(cookies));
    if (cookies.sa_csrf) r = r.set('X-CSRF-Token', cookies.sa_csrf);
    if (body !== undefined && method !== 'get') r = r.send(body as object);
    return r;
  };
