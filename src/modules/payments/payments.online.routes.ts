import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can, publicRoute } from '../../middlewares/permission.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { routeMeta } from '../societies/societies.public';
import { ENT, PERM } from './payments.constants';
import { onlineController as c } from './payments.online.controller';
import { onlineSchemas as s } from './payments.online.validation';

/**
 * Part 12.1 routes (section 8): resident pay list and checkout orders, admin order list, payment links, the public pay routes and
 * the gateway webhook. Order on a route: state policy, society marker, permission, entitlement, validate, idempotency.
 * Exactly four society routes of the module run while `SUSPENDED` (section 13); three of them are here.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;
const susp = () => routeMeta({ suspended: 'allow' });
const ip = (name: string, limit: number): RequestHandler =>
  rateLimit({ name, limit, windowSeconds: 60, key: req => req.ip });
const perCode = rateLimit({
  name: 'payments-public-code',
  limit: 10,
  windowSeconds: 60,
  key: req => req.params.code,
});
const perAccount = rateLimit({
  name: 'payments-webhook',
  limit: 600,
  windowSeconds: 60,
  key: req => req.params.gatewayAccountId,
});

export const paymentsOnlineRoutes = Router();
const r = paymentsOnlineRoutes;

// ---- resident
r.get(
  '/me/payables',
  society(),
  can(PERM.residentDuesView),
  feature(ENT.payablesList, read),
  validate({ query: s.payablesQuery }),
  c.payables,
);
r.post(
  '/me/payables/payment-orders',
  susp(),
  society(),
  can(PERM.residentPaymentsCreate),
  feature(ENT.orders),
  validate({ body: s.createOrderBody }),
  idempotency(),
  c.createOrder,
);
r.post(
  '/me/payables/payment-orders/:id/verify',
  susp(),
  society(),
  can(PERM.residentPaymentsCreate),
  feature(ENT.orders),
  validate({ params: s.idParam, body: s.verifyBody }),
  c.verify,
);
r.get(
  '/me/payment-orders/:id',
  society(),
  can(PERM.residentPaymentsView),
  feature(ENT.orders, read),
  validate({ params: s.idParam }),
  c.status,
);
r.post(
  '/me/payment-orders/:id/cancel',
  susp(),
  society(),
  can(PERM.residentPaymentsCreate),
  feature(ENT.orders),
  validate({ params: s.idParam }),
  c.cancelOwn,
);

// ---- admin
r.get(
  '/payment-orders',
  society(),
  can(PERM.paymentsView),
  feature(ENT.orders, read),
  validate({ query: s.listQuery }),
  c.adminList,
);
r.get(
  '/payment-orders/:id',
  society(),
  can(PERM.paymentsView),
  feature(ENT.orders, read),
  validate({ params: s.idParam }),
  c.adminDetail,
);
r.post(
  '/payment-orders/:id/cancel',
  society(),
  can(PERM.paymentsEdit),
  feature(ENT.orders),
  validate({ params: s.idParam, body: s.cancelBody }),
  c.adminCancel,
);
r.post(
  '/payment-orders/:id/check',
  society(),
  can(PERM.paymentsEdit),
  feature(ENT.orders),
  validate({ params: s.idParam }),
  c.adminCheck,
);
r.post(
  '/payment-links',
  society(),
  can(PERM.paymentsCreate),
  feature(ENT.paymentLinks),
  validate({ body: s.linkBody }),
  idempotency(),
  c.createLink,
);

// ---- public pay link (token in X-Pay-Token or the body); the society state rule is applied in the service (BR-12-50)
const pub = [publicRoute(), ip('payments-public-ip', 30), perCode];
r.get('/public/pay/:code', ...pub, validate({ params: s.codeParam }), c.linkInfo);
r.post(
  '/public/pay/:code/checkout',
  ...pub,
  validate({ params: s.codeParam, body: s.publicBody }),
  c.linkCheckout,
);
r.post(
  '/public/pay/:code/verify',
  ...pub,
  validate({ params: s.codeParam, body: s.publicVerifyBody }),
  c.linkVerify,
);

// ---- gateway webhook: signature, not session
r.post(
  '/webhooks/payments/:gatewayAccountId',
  publicRoute(),
  validate({ params: s.webhookParam }),
  perAccount,
  c.webhook,
);
