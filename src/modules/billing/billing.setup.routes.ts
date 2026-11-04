import { Router } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { requireFeature as feature } from '../../middlewares/entitlement.middleware';
import { societyMiddleware } from '../../middlewares/society.middleware';
import { requirePermission as can } from '../../middlewares/permission.middleware';
import { billingSetupController as c } from './billing.setup.controller';
import { FEATURES as F, PERMISSIONS as P } from './billing.constants';
import { headSchemas } from './billing.heads.validation';
import { policySchemas } from './billing.latefee-policy.validation';
import { ruleSchemas } from './billing.rules.validation';
import { splitSchemas } from './billing.split.validation';

/**
 * Module 11 routes of sub-module 11.1 (sections 8.1 to 8.4): charge heads, billing rules and versions, bill split rules and
 * late fee policies. Order on a route: society marker, permission, entitlement, validate, idempotency (creates). Reads use the
 * plan's read grace. `POST /billing/rules/simulate` belongs to the calculator of 11.3.
 */
const society = () => societyMiddleware();
const read = { mode: 'read' } as const;

export const billingSetupRoutes = Router();
const r = billingSetupRoutes;

// 8.1 charge heads
r.get(
  '/billing/charge-heads',
  society(),
  can(P.rulesView),
  feature(F.chargeHeadMaster, read),
  validate({ query: headSchemas.listQuery }),
  c.listHeads,
);
r.post(
  '/billing/charge-heads',
  society(),
  can(P.rulesEdit),
  feature(F.chargeHeadMaster),
  validate({ body: headSchemas.create }),
  idempotency(),
  c.createHead,
);
r.patch(
  '/billing/charge-heads/:id',
  society(),
  can(P.rulesEdit),
  feature(F.chargeHeadMaster),
  validate({ params: headSchemas.idParam, body: headSchemas.patch }),
  c.updateHead,
);
r.delete(
  '/billing/charge-heads/:id',
  society(),
  can(P.rulesEdit),
  feature(F.chargeHeadMaster),
  validate({ params: headSchemas.idParam, body: headSchemas.archive }),
  c.archiveHead,
);

// 8.2 billing rules and versions
r.get(
  '/billing/rules',
  society(),
  can(P.rulesView),
  feature(F.versionedRules, read),
  validate({ query: ruleSchemas.listQuery }),
  c.listRules,
);
r.get(
  '/billing/rules/:id',
  society(),
  can(P.rulesView),
  feature(F.versionedRules, read),
  validate({ params: ruleSchemas.idParam }),
  c.getRule,
);
r.post(
  '/billing/rules',
  society(),
  can(P.rulesEdit),
  feature(F.versionedRules),
  feature(F.calculationMethods),
  validate({ body: ruleSchemas.createRule }),
  idempotency(),
  c.createRule,
);
r.patch(
  '/billing/rules/:id',
  society(),
  can(P.rulesEdit),
  feature(F.versionedRules),
  feature(F.calculationMethods),
  validate({ params: ruleSchemas.idParam, body: ruleSchemas.patchRule }),
  c.updateRule,
);
r.delete(
  '/billing/rules/:id',
  society(),
  can(P.rulesEdit),
  feature(F.versionedRules),
  feature(F.calculationMethods),
  validate({ params: ruleSchemas.idParam, body: ruleSchemas.archive }),
  c.archiveRule,
);
r.post(
  '/billing/rules/:id/versions',
  society(),
  can(P.rulesEdit),
  feature(F.versionedRules),
  feature(F.calculationMethods),
  validate({ params: ruleSchemas.idParam, body: ruleSchemas.addVersion }),
  idempotency(),
  c.addVersion,
);

// 8.3 bill split rules
r.get(
  '/billing/split-rules',
  society(),
  can(P.rulesView),
  feature(F.calculationMethods, read),
  validate({ query: splitSchemas.listQuery }),
  c.listSplit,
);
r.post(
  '/billing/split-rules',
  society(),
  can(P.rulesEdit),
  feature(F.calculationMethods),
  validate({ body: splitSchemas.create }),
  idempotency(),
  c.createSplit,
);
r.patch(
  '/billing/split-rules/:id',
  society(),
  can(P.rulesEdit),
  feature(F.calculationMethods),
  validate({ params: splitSchemas.idParam, body: splitSchemas.patch }),
  c.updateSplit,
);
r.delete(
  '/billing/split-rules/:id',
  society(),
  can(P.rulesEdit),
  feature(F.calculationMethods),
  validate({ params: splitSchemas.idParam, body: splitSchemas.archive }),
  c.archiveSplit,
);

// 8.4 late fee policies
r.get(
  '/billing/late-fee-policies',
  society(),
  can(P.rulesView),
  feature(F.lateFeeAndInterest, read),
  validate({ query: policySchemas.listQuery }),
  c.listPolicies,
);
r.post(
  '/billing/late-fee-policies',
  society(),
  can(P.rulesEdit),
  feature(F.lateFeeAndInterest),
  validate({ body: policySchemas.create }),
  idempotency(),
  c.createPolicy,
);
