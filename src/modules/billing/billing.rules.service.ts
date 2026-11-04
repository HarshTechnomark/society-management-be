import { Op, type Transaction } from 'sequelize';
import {
  BillSplitRule,
  BillingRule,
  BillingRuleVersion,
  ChargeHead,
  LateFeePolicy,
  sequelize,
} from '../../models';
import { now } from '../../lib/clock';
import { formatRupees, rateUnits } from '../../lib/money';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { settings } from '../society-setup/society-setup.public';
import { APPROVAL_TYPES, AUDIT, FEATURES, NOC_MAX_PERCENT, SETUP_MODE_REASON } from './billing.constants';
import { billingPorts, requireMeterSource, type ApprovalTypeHooks } from './billing.ports';
import { getHead, ensureSeeded } from './billing.heads.service';
import { effectiveOn, ruleDto, versionDto, type RuleDto, type RuleVersionDto } from './billing.rules.dto';
import type {
  RuleCreateInput,
  RuleListQuery,
  RulePatchInput,
  VersionInput,
} from './billing.rules.validation';
import { assertScopeValues, scopesOverlap, type ScopeShape } from './billing.setup.scope';
import { isSetupMode, lastIssuedPeriodEnd } from './billing.setup.mode';
import {
  actorId,
  addDaysYmd,
  assertFeatureFor,
  conflict,
  firstOfMonth,
  invalidState,
  isCycle,
  isPeriodStart,
  isUniqueViolation,
  ruleNotFound,
  societyToday,
  staleVersion,
  unprocessable,
} from './billing.setup.shared';
import { insertPolicy } from './billing.latefee-policy.service';

/** Billing rules and their immutable versions (sections 5.3, 8.2): create, edit, archive, add a version, approve, reject. */
const ENTITY_RULE = 'billing_rule';
const ENTITY_VERSION = 'billing_rule_version';
const nameTaken = () =>
  new AppError(409, 'RULE_NAME_TAKEN', 'A billing rule with this name already exists for this head', [
    { field: 'name', message: 'Choose another name' },
  ]);

/** Columns of a version that hold the rate (the rest is dates and approval). */
const RATE_COLUMNS = [
  'amountPaise',
  'ratePerSqftPaise',
  'unitTypeRates',
  'meterType',
  'slabs',
  'minimumChargePaise',
  'missingReadingPolicy',
  'billSplitRuleId',
  'percent',
  'baseChargeHeadIds',
] as const;
/** `4.0000` style normal form of a DECIMAL(9,4) value. */
function fmtPercent(v: string): string {
  const u = rateUnits(v);
  return `${u / 10_000n}.${String(u % 10_000n).padStart(4, '0')}`;
}

/** The rate columns of a version (the other rate types' columns NULL), ready for `create` (BR section 7.3 CHECKs). */
function rateColumns(v: VersionInput): Record<(typeof RATE_COLUMNS)[number], unknown> {
  const out = Object.fromEntries(RATE_COLUMNS.map(c => [c, null])) as Record<
    (typeof RATE_COLUMNS)[number],
    unknown
  >;
  switch (v.rateType) {
    case 'FLAT_PER_UNIT':
      out.amountPaise = v.amountPaise;
      break;
    case 'PER_SQFT':
      out.ratePerSqftPaise = v.ratePerSqftPaise;
      break;
    case 'PER_UNIT_TYPE':
      out.unitTypeRates = v.unitTypeRates;
      break;
    case 'METERED':
      out.meterType = v.meterType;
      out.slabs = v.slabs;
      out.minimumChargePaise = v.minimumChargePaise;
      out.missingReadingPolicy = v.missingReadingPolicy;
      break;
    case 'SPLIT_TOTAL':
      out.billSplitRuleId = v.billSplitRuleId;
      break;
    case 'PERCENT_OF_HEADS':
      out.percent = fmtPercent(v.percent);
      out.baseChargeHeadIds = v.baseChargeHeadIds;
      break;
    case 'NONE':
      break;
  }
  return out;
}
const rateSnapshot = (v: BillingRuleVersion | null) =>
  v
    ? {
        rateType: v.rateType,
        ...Object.fromEntries(
          RATE_COLUMNS.filter(c => v[c] !== null && v[c] !== undefined).map(c => [c, v[c]]),
        ),
      }
    : null;

/** A short rate phrase for approval titles and the audit label: "₹3.20 per sq ft". */
export function describeRate(
  v: Pick<BillingRuleVersion, 'rateType' | 'amountPaise' | 'ratePerSqftPaise' | 'percent'> | null,
): string {
  if (!v) return 'no rate';
  switch (v.rateType) {
    case 'FLAT_PER_UNIT':
      return `${formatRupees(Number(v.amountPaise))} per flat`;
    case 'PER_SQFT':
      return `${formatRupees(Number(v.ratePerSqftPaise))} per sq ft`;
    case 'PER_UNIT_TYPE':
      return 'rates by unit type';
    case 'METERED':
      return 'metered slabs';
    case 'SPLIT_TOTAL':
      return 'split of a total';
    case 'PERCENT_OF_HEADS':
      return `${v.percent}% of other heads`;
    case 'NONE':
      return 'stopped';
  }
}

// ------------------------------------------------------------------ reads
async function loadVersions(ruleIds: number[], t?: Transaction): Promise<Map<number, BillingRuleVersion[]>> {
  const out = new Map<number, BillingRuleVersion[]>();
  if (!ruleIds.length) return out;
  const rows = await BillingRuleVersion.findAll({
    where: { billingRuleId: { [Op.in]: ruleIds } },
    order: [['versionNo', 'ASC']],
    transaction: t,
  });
  for (const v of rows) {
    const k = Number(v.billingRuleId);
    out.set(k, [...(out.get(k) ?? []), v]);
  }
  return out;
}

async function toDtos(
  societyId: number,
  rules: BillingRule[],
  withVersions: boolean,
  t?: Transaction,
): Promise<RuleDto[]> {
  const today = await societyToday(societyId);
  const [versions, heads] = await Promise.all([
    loadVersions(
      rules.map(r => Number(r.id)),
      t,
    ),
    ChargeHead.findAll({
      where: { societyId, id: { [Op.in]: [...new Set(rules.map(r => Number(r.chargeHeadId)))] } },
      transaction: t,
    }),
  ]);
  const byHead = new Map(heads.map(h => [Number(h.id), h]));
  return rules.map(r =>
    ruleDto(r, byHead.get(Number(r.chargeHeadId)), versions.get(Number(r.id)) ?? [], today, withVersions),
  );
}

export async function getRuleRow(
  societyId: number,
  id: number,
  t?: Transaction,
  lock = false,
): Promise<BillingRule> {
  const r = await BillingRule.findOne({
    where: { id, societyId },
    transaction: t,
    ...(lock && t ? { lock: t.LOCK.UPDATE } : {}),
  });
  if (!r) throw ruleNotFound();
  return r;
}

/** `GET /billing/rules`. */
export async function listRules(societyId: number, q: RuleListQuery) {
  await ensureSeeded(societyId);
  const where: Record<string, unknown> = { societyId };
  if (q.status !== 'ALL') where.status = q.status;
  if (q.chargeHeadId) where.chargeHeadId = q.chargeHeadId;
  if (q.scopeType) where.scopeType = q.scopeType;
  const total = await BillingRule.count({ where });
  const rows = await BillingRule.findAll({
    where,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'ASC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: await toDtos(societyId, rows, false), pagination: pageMeta(q.page, q.limit, total) };
}

/** `GET /billing/rules/:id`: the rule with all versions (history). */
export async function getRule(societyId: number, id: number): Promise<RuleDto> {
  const r = await getRuleRow(societyId, id);
  return (await toDtos(societyId, [r], true))[0]!;
}

/** The version of rule `ruleId` effective on `date` (for the calculator of 11.3). */
export async function versionEffectiveOn(
  societyId: number,
  ruleId: number,
  date: string,
  t?: Transaction,
): Promise<RuleVersionDto | null> {
  const versions = await BillingRuleVersion.findAll({
    where: { societyId, billingRuleId: ruleId, status: 'APPROVED' },
    transaction: t,
  });
  const v = effectiveOn(versions, date);
  return v ? versionDto(v) : null;
}

// ------------------------------------------------------------------ checks
/** BR-11-14: two ACTIVE rules of one head and one scope type may not share a value. */
async function assertNoOverlap(
  societyId: number,
  headId: number,
  scope: ScopeShape,
  ignoreRuleId: number | null,
  t: Transaction,
) {
  const others = await BillingRule.findAll({
    where: {
      societyId,
      chargeHeadId: headId,
      status: 'ACTIVE',
      scopeType: scope.scopeType,
      ...(ignoreRuleId ? { id: { [Op.ne]: ignoreRuleId } } : {}),
    },
    transaction: t,
  });
  if (others.some(o => scopesOverlap(scope, { scopeType: o.scopeType, scopeValues: o.scopeValues })))
    throw conflict(
      'RULE_SCOPE_OVERLAP',
      'Another active rule of this head already covers some of these flats',
      'scopeValues',
    );
}

function assertHeadUsable(head: ChargeHead): void {
  if (head.status === 'ARCHIVED')
    throw unprocessable('CHARGE_HEAD_ARCHIVED', 'This charge head is archived', 'chargeHeadId');
  if (head.isSystem)
    throw unprocessable('RATE_TYPE_NOT_ALLOWED', 'System heads cannot have billing rules', 'chargeHeadId');
}

/** BR-11-18, BR-11-19, the plan and the references of a version payload (the Zod schema already checked its shape). */
async function assertVersionContent(
  societyId: number,
  head: ChargeHead,
  v: VersionInput,
  t: Transaction,
): Promise<void> {
  const cycle = await settings.get(societyId, 'billing.cycle');
  if (cycle !== 'MONTHLY') await assertFeatureFor(societyId, FEATURES.billingCycles);
  if (v.rateType === 'METERED') {
    await assertFeatureFor(societyId, FEATURES.meteredWater);
    requireMeterSource(v.meterType);
  }
  if (head.headType === 'NON_OCCUPANCY' && v.rateType !== 'PERCENT_OF_HEADS' && v.rateType !== 'NONE')
    throw unprocessable(
      'RATE_TYPE_NOT_ALLOWED',
      'Non-occupancy charges are a percent of the maintenance heads, or none',
      'rateType',
    );
  if (v.rateType === 'SPLIT_TOTAL') {
    const s = await BillSplitRule.findOne({ where: { id: v.billSplitRuleId, societyId }, transaction: t });
    if (!s) throw new NotFoundError('SPLIT_RULE_NOT_FOUND', 'Bill split rule not found');
    if (s.status !== 'ACTIVE') throw invalidState('This split rule is archived');
  }
  if (v.rateType === 'PERCENT_OF_HEADS') {
    if (head.headType === 'NON_OCCUPANCY' && rateUnits(v.percent) > rateUnits(NOC_MAX_PERCENT))
      throw unprocessable('NOC_CAP_EXCEEDED', 'Non-occupancy charges are capped at 10 percent', 'percent');
    if (v.baseChargeHeadIds.includes(Number(head.id)))
      throw unprocessable('RATE_TYPE_NOT_ALLOWED', 'A head cannot be its own base', 'baseChargeHeadIds');
    const bases = await ChargeHead.findAll({
      where: { societyId, id: { [Op.in]: v.baseChargeHeadIds } },
      transaction: t,
    });
    if (bases.length !== v.baseChargeHeadIds.length)
      throw new NotFoundError('CHARGE_HEAD_NOT_FOUND', 'A base charge head was not found');
    if (bases.some(b => b.status !== 'ACTIVE'))
      throw unprocessable('CHARGE_HEAD_ARCHIVED', 'A base charge head is archived', 'baseChargeHeadIds');
    if (head.headType === 'NON_OCCUPANCY' && bases.some(b => b.headType !== 'MAINTENANCE'))
      throw unprocessable(
        'RATE_TYPE_NOT_ALLOWED',
        'Non-occupancy charges use only maintenance heads as the base',
        'baseChargeHeadIds',
      );
    const baseRules = await BillingRule.findAll({
      where: { societyId, status: 'ACTIVE', chargeHeadId: { [Op.in]: bases.map(b => Number(b.id)) } },
      attributes: ['id'],
      transaction: t,
    });
    if (baseRules.length) {
      const chained = await BillingRuleVersion.count({
        where: {
          societyId,
          billingRuleId: { [Op.in]: baseRules.map(r => Number(r.id)) },
          status: { [Op.ne]: 'REJECTED' },
          rateType: { [Op.in]: ['PERCENT_OF_HEADS', 'SPLIT_TOTAL'] },
        },
        transaction: t,
      });
      if (chained)
        throw unprocessable(
          'RATE_TYPE_NOT_ALLOWED',
          'A base head cannot itself be a percent or split-total head',
          'baseChargeHeadIds',
        );
    }
  }
}

/** BR-11-20 (dates): the first day of a period of the society's cycle, after every issued regular period. */
async function assertEffectiveDate(societyId: number, effectiveFrom: string, t: Transaction): Promise<void> {
  const cycle = await settings.get(societyId, 'billing.cycle');
  if (!isCycle(cycle) || !isPeriodStart(cycle, effectiveFrom))
    throw unprocessable(
      'RULE_EFFECTIVE_DATE_INVALID',
      'The date must be the first day of a billing period',
      'effectiveFrom',
    );
  const billedTo = await lastIssuedPeriodEnd(societyId, t);
  if (billedTo !== null && effectiveFrom <= billedTo)
    throw unprocessable(
      'RULE_EFFECTIVE_IN_BILLED_PERIOD',
      'That period has already been billed',
      'effectiveFrom',
      { billedUntil: billedTo },
    );
}

async function assertDateFree(
  ruleId: number,
  effectiveFrom: string,
  t: Transaction,
  ignoreId?: number,
): Promise<void> {
  const taken = await BillingRuleVersion.findOne({
    where: {
      billingRuleId: ruleId,
      status: 'APPROVED',
      effectiveFrom,
      ...(ignoreId ? { id: { [Op.ne]: ignoreId } } : {}),
    },
    attributes: ['id'],
    transaction: t,
  });
  if (taken)
    throw conflict(
      'RULE_VERSION_DATE_TAKEN',
      'An approved version already starts on this date',
      'effectiveFrom',
    );
}

// ------------------------------------------------------------------ create
/** Inserts version `versionNo` of a locked rule and routes it to setup mode or to approval. */
async function insertVersion(
  ctx: Ctx,
  societyId: number,
  rule: BillingRule,
  head: ChargeHead,
  v: VersionInput,
  t: Transaction,
): Promise<BillingRuleVersion> {
  await assertVersionContent(societyId, head, v, t);
  await assertEffectiveDate(societyId, v.effectiveFrom, t);
  const existing = await BillingRuleVersion.findAll({
    where: { billingRuleId: Number(rule.id) },
    transaction: t,
  });
  if (existing.some(e => e.status === 'PENDING_APPROVAL'))
    throw conflict('RULE_VERSION_PENDING', 'Another version of this rule is waiting for approval');
  await assertDateFree(Number(rule.id), v.effectiveFrom, t);
  const versionNo = existing.reduce((m, e) => Math.max(m, Number(e.versionNo)), 0) + 1;
  const setup = await isSetupMode(societyId, t);
  const before = effectiveOn(existing, v.effectiveFrom);
  const { rateType, effectiveFrom, reason, resolutionRef } = v;
  const row = await BillingRuleVersion.create(
    {
      societyId,
      billingRuleId: Number(rule.id),
      versionNo,
      rateType,
      ...(rateColumns(v) as object),
      effectiveFrom,
      effectiveTo: null,
      status: 'PENDING_APPROVAL',
      reason,
      resolutionRef: resolutionRef ?? null,
      approvalRequestId: null,
      approvedBy: null,
      approvedAt: null,
      rejectedReason: null,
      createdBy: actorId(ctx),
      updatedBy: actorId(ctx),
    } as never,
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: AUDIT.ruleVersionCreated,
      entityType: ENTITY_VERSION,
      entityId: row.id!,
      entityLabel: `${head.key} v${versionNo}`,
      societyId,
      after: { ruleId: Number(rule.id), versionNo, effectiveFrom, ...rateSnapshot(row) },
      reason,
    },
    t,
  );
  if (setup) {
    await activateVersion(ctx, societyId, row, t, SETUP_MODE_REASON);
    return row;
  }
  const req = await billingPorts().approvals.request(
    ctx,
    {
      type: APPROVAL_TYPES.ruleChange,
      entityType: ENTITY_VERSION,
      entityId: Number(row.id),
      title: `${head.name}: ${describeRate(before)} → ${describeRate(row)} from ${effectiveFrom}`,
      payload: {
        ruleId: Number(rule.id),
        rateType,
        before: rateSnapshot(before),
        after: rateSnapshot(row),
        effectiveFrom,
      },
    },
    t,
  );
  row.approvalRequestId = req.id;
  await row.save({ transaction: t });
  if (req.status === 'APPROVED') await activateVersion(ctx, societyId, row, t);
  return row;
}

/** `POST /billing/rules`: the rule and its version 1. */
export async function createRule(ctx: Ctx, societyId: number, input: RuleCreateInput): Promise<RuleDto> {
  await ensureSeeded(societyId);
  const head = await getHead(societyId, input.chargeHeadId);
  assertHeadUsable(head);
  if (input.scopeType === 'UNITS') await assertFeatureFor(societyId, FEATURES.unitOverrides);
  await assertScopeValues(societyId, input);
  const scope: ScopeShape = {
    scopeType: input.scopeType,
    scopeValues: input.scopeType === 'ALL_UNITS' ? null : (input.scopeValues ?? null),
  };
  try {
    const id = await sequelize.transaction(async t => {
      const lockedHead = await getHead(societyId, input.chargeHeadId, t, true);
      assertHeadUsable(lockedHead);
      if (
        await BillingRule.findOne({
          where: { societyId, chargeHeadId: input.chargeHeadId, name: input.name },
          attributes: ['id'],
          transaction: t,
        })
      )
        throw nameTaken();
      await assertNoOverlap(societyId, input.chargeHeadId, scope, null, t);
      const rule = await BillingRule.create(
        {
          societyId,
          chargeHeadId: input.chargeHeadId,
          name: input.name,
          scopeType: scope.scopeType,
          scopeValues: scope.scopeValues ?? null,
          status: 'ACTIVE',
          sortOrder: 100,
          createdBy: actorId(ctx),
          updatedBy: actorId(ctx),
          version: 1,
        },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.ruleCreated,
          entityType: ENTITY_RULE,
          entityId: rule.id!,
          entityLabel: rule.name,
          societyId,
          after: {
            chargeHead: lockedHead.key,
            name: rule.name,
            scopeType: rule.scopeType,
            scopeValues: rule.scopeValues,
          },
        },
        t,
      );
      await insertVersion(ctx, societyId, rule, lockedHead, input.firstVersion, t);
      return Number(rule.id);
    });
    return getRule(societyId, id);
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
}

/** `POST /billing/rules/:id/versions`. */
export async function addVersion(
  ctx: Ctx,
  societyId: number,
  ruleId: number,
  input: VersionInput,
): Promise<{ version: RuleVersionDto; setupMode: boolean }> {
  return sequelize.transaction(async t => {
    const rule = await getRuleRow(societyId, ruleId, t, true);
    if (rule.status === 'ARCHIVED') throw invalidState('An archived rule cannot get a new version');
    const head = await getHead(societyId, Number(rule.chargeHeadId), t);
    assertHeadUsable(head);
    const row = await insertVersion(ctx, societyId, rule, head, input, t);
    return { version: versionDto(row), setupMode: row.status === 'APPROVED' };
  });
}

// ------------------------------------------------------------------ edit and archive
/** `PATCH /billing/rules/:id`: name, order, and the scope while no version is approved (BR-11-15). */
export async function updateRule(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: RulePatchInput,
): Promise<RuleDto> {
  try {
    await sequelize.transaction(async t => {
      const rule = await getRuleRow(societyId, id, t, true);
      if (rule.status === 'ARCHIVED') throw invalidState('An archived rule cannot be edited');
      if (Number(rule.version) !== input.version) throw staleVersion('billing rule');
      const before = {
        name: rule.name,
        sortOrder: Number(rule.sortOrder),
        scopeType: rule.scopeType,
        scopeValues: rule.scopeValues,
      };
      if (input.name !== undefined && input.name !== rule.name) {
        if (
          await BillingRule.findOne({
            where: { societyId, chargeHeadId: Number(rule.chargeHeadId), name: input.name },
            attributes: ['id'],
            transaction: t,
          })
        )
          throw nameTaken();
        rule.name = input.name;
      }
      if (input.sortOrder !== undefined) rule.sortOrder = input.sortOrder;
      if (input.scopeType !== undefined) {
        const scope: ScopeShape = {
          scopeType: input.scopeType,
          scopeValues: input.scopeType === 'ALL_UNITS' ? null : (input.scopeValues ?? null),
        };
        const changes =
          scope.scopeType !== rule.scopeType ||
          JSON.stringify(scope.scopeValues) !== JSON.stringify(rule.scopeValues);
        if (changes) {
          const approved = await BillingRuleVersion.count({
            where: { billingRuleId: id, status: 'APPROVED' },
            transaction: t,
          });
          if (approved)
            throw conflict(
              'RULE_IN_USE',
              'The scope cannot change once a version is approved; create a new rule and stop this one with a NONE version',
            );
          if (scope.scopeType !== 'ALL_UNITS' && !scope.scopeValues)
            throw new ValidationError([
              { field: 'scopeValues', message: 'Required unless the scope is ALL_UNITS' },
            ]);
          if (scope.scopeType === 'UNITS') await assertFeatureFor(societyId, FEATURES.unitOverrides);
          await assertScopeValues(societyId, scope);
          await assertNoOverlap(societyId, Number(rule.chargeHeadId), scope, id, t);
          rule.scopeType = scope.scopeType;
          rule.scopeValues = scope.scopeValues ?? null;
        }
      }
      rule.version = Number(rule.version) + 1;
      rule.updatedBy = actorId(ctx);
      await rule.save({ transaction: t });
      await audit(
        ctx,
        {
          action: AUDIT.ruleUpdated,
          entityType: ENTITY_RULE,
          entityId: rule.id!,
          entityLabel: rule.name,
          societyId,
          before,
          after: {
            name: rule.name,
            sortOrder: Number(rule.sortOrder),
            scopeType: rule.scopeType,
            scopeValues: rule.scopeValues,
          },
        },
        t,
      );
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw nameTaken();
    throw err;
  }
  return getRule(societyId, id);
}

/** `DELETE /billing/rules/:id`: only a rule that never had an approved version (BR 8.2). A waiting approval is cancelled. */
export async function archiveRule(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { reason: string; version: number },
): Promise<RuleDto> {
  await sequelize.transaction(async t => {
    const rule = await getRuleRow(societyId, id, t, true);
    if (Number(rule.version) !== input.version) throw staleVersion('billing rule');
    if (rule.status === 'ARCHIVED') throw invalidState('This rule is already archived');
    const versions = await BillingRuleVersion.findAll({ where: { billingRuleId: id }, transaction: t });
    if (versions.some(v => v.status === 'APPROVED'))
      throw conflict(
        'RULE_IN_USE',
        'A rule with an approved version cannot be archived; add a NONE version to stop it',
      );
    for (const v of versions.filter(x => x.status === 'PENDING_APPROVAL')) {
      if (v.approvalRequestId)
        await billingPorts().approvals.cancel(ctx, Number(v.approvalRequestId), input.reason, t);
      v.status = 'REJECTED';
      v.rejectedReason = 'The rule was archived';
      v.updatedBy = actorId(ctx);
      await v.save({ transaction: t });
    }
    const before = { status: rule.status };
    rule.status = 'ARCHIVED';
    rule.version = Number(rule.version) + 1;
    rule.updatedBy = actorId(ctx);
    await rule.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.ruleArchived,
        entityType: ENTITY_RULE,
        entityId: rule.id!,
        entityLabel: rule.name,
        societyId,
        before,
        after: { status: rule.status },
        reason: input.reason,
      },
      t,
    );
  });
  return getRule(societyId, id);
}

// ------------------------------------------------------------------ approval
/**
 * BR-11-21: makes a version APPROVED and closes its neighbours. The caller holds the rule row `FOR UPDATE`. In setup mode this
 * runs inside the creating request; otherwise from module 14's `onApproved` (the checks of BR-11-20 are repeated first).
 */
export async function activateVersion(
  ctx: Ctx,
  societyId: number,
  v: BillingRuleVersion,
  t: Transaction,
  reason: string | null = null,
): Promise<void> {
  if (v.status !== 'PENDING_APPROVAL') throw invalidState('This version is not waiting for approval');
  await assertEffectiveDate(societyId, v.effectiveFrom, t);
  await assertDateFree(Number(v.billingRuleId), v.effectiveFrom, t, Number(v.id));
  const approved = await BillingRuleVersion.findAll({
    where: { billingRuleId: Number(v.billingRuleId), status: 'APPROVED' },
    order: [['effectiveFrom', 'ASC']],
    transaction: t,
  });
  const F = v.effectiveFrom;
  const prev = [...approved]
    .reverse()
    .find(a => a.effectiveFrom < F && (a.effectiveTo === null || a.effectiveTo >= F));
  const next = approved.find(a => a.effectiveFrom > F);
  if (prev) {
    prev.effectiveTo = addDaysYmd(F, -1);
    prev.updatedBy = actorId(ctx);
    await prev.save({ transaction: t });
  }
  v.effectiveTo = next ? addDaysYmd(next.effectiveFrom, -1) : null;
  v.status = 'APPROVED';
  v.approvedBy = actorId(ctx);
  v.approvedAt = now();
  v.updatedBy = actorId(ctx);
  await v.save({ transaction: t });
  const rule = await BillingRule.findByPk(Number(v.billingRuleId), { transaction: t });
  const head = rule ? await ChargeHead.findByPk(Number(rule.chargeHeadId), { transaction: t }) : null;
  await audit(
    ctx,
    {
      action: AUDIT.ruleVersionApproved,
      entityType: ENTITY_VERSION,
      entityId: v.id!,
      entityLabel: `${head?.key ?? 'rule'} v${v.versionNo}`,
      societyId,
      after: {
        ruleId: Number(v.billingRuleId),
        versionNo: Number(v.versionNo),
        effectiveFrom: v.effectiveFrom,
        effectiveTo: v.effectiveTo,
        ...rateSnapshot(v),
      },
      reason,
    },
    t,
  );
  if (reason === SETUP_MODE_REASON) await createDefaultPolicy(ctx, societyId, F, t);
}

/** BR-11-51: in setup mode the first policy comes from the module 08 defaults when the first rule is approved. */
async function createDefaultPolicy(ctx: Ctx, societyId: number, from: string, t: Transaction): Promise<void> {
  if (await LateFeePolicy.count({ where: { societyId }, transaction: t })) return;
  const d = await settings.getMany(societyId, [
    'billing.lateFeeDefaultMode',
    'billing.lateFeeDefaultRatePct',
    'billing.lateFeeDefaultFlatPaise',
    'billing.lateFeeGraceDays',
  ]);
  const mode = d['billing.lateFeeDefaultMode'] as string;
  const rate = String(d['billing.lateFeeDefaultRatePct']);
  const flat = Number(d['billing.lateFeeDefaultFlatPaise']);
  const base = {
    graceDays: Number(d['billing.lateFeeGraceDays']),
    effectiveFrom: firstOfMonth(from),
    reason: 'Defaults from the billing settings',
  };
  if (mode === 'SIMPLE_INTEREST' && rateUnits(rate) >= 1n)
    await insertPolicy(
      ctx,
      societyId,
      { ...base, policyType: 'SIMPLE_INTEREST', interestRatePct: fmtPercent(rate), interestFrom: 'DUE_DATE' },
      true,
      t,
    );
  else if (mode === 'FLAT' && flat >= 100)
    await insertPolicy(ctx, societyId, { ...base, policyType: 'FLAT', flatFeePaise: flat }, true, t);
  else if (mode === 'NONE') await insertPolicy(ctx, societyId, { ...base, policyType: 'NONE' }, true, t);
}

/** Module 14 `onRejected`. */
export async function rejectVersion(
  ctx: Ctx,
  societyId: number,
  v: BillingRuleVersion,
  reason: string,
  t: Transaction,
): Promise<void> {
  if (v.status !== 'PENDING_APPROVAL') throw invalidState('This version is not waiting for approval');
  v.status = 'REJECTED';
  v.rejectedReason = reason.slice(0, 500);
  v.updatedBy = actorId(ctx);
  await v.save({ transaction: t });
  const rule = await BillingRule.findByPk(Number(v.billingRuleId), { transaction: t });
  const head = rule ? await ChargeHead.findByPk(Number(rule.chargeHeadId), { transaction: t }) : null;
  await audit(
    ctx,
    {
      action: AUDIT.ruleVersionRejected,
      entityType: ENTITY_VERSION,
      entityId: v.id!,
      entityLabel: `${head?.key ?? 'rule'} v${v.versionNo}`,
      societyId,
      after: { ruleId: Number(v.billingRuleId), versionNo: Number(v.versionNo), status: v.status },
      reason,
    },
    t,
  );
}

async function lockedVersion(entityId: number, t: Transaction): Promise<BillingRuleVersion> {
  const peek = await BillingRuleVersion.findByPk(entityId, {
    attributes: ['id', 'billingRuleId', 'societyId'],
    transaction: t,
  });
  if (!peek) throw new NotFoundError('RULE_NOT_FOUND', 'Billing rule version not found');
  await BillingRule.findByPk(Number(peek.billingRuleId), { transaction: t, lock: t.LOCK.UPDATE });
  return (await BillingRuleVersion.findByPk(entityId, { transaction: t, lock: t.LOCK.UPDATE }))!;
}

/** The approval type of module 14 (section 2): register it with `billingPorts().approvals.registerType`. */
export const ruleApprovalType: ApprovalTypeHooks = {
  type: APPROVAL_TYPES.ruleChange,
  async onApproved(ctx, entityId, t) {
    const v = await lockedVersion(entityId, t);
    await activateVersion(ctx, Number(v.societyId), v, t);
  },
  async onRejected(ctx, entityId, reason, t) {
    const v = await lockedVersion(entityId, t);
    await rejectVersion(ctx, Number(v.societyId), v, reason, t);
  },
  async describe(entityId) {
    const v = await BillingRuleVersion.findByPk(entityId);
    if (!v) return [];
    const rule = await BillingRule.findByPk(Number(v.billingRuleId));
    const head = rule ? await ChargeHead.findByPk(Number(rule.chargeHeadId)) : null;
    return [
      { label: 'Charge head', value: head?.name ?? '' },
      { label: 'New rate', value: describeRate(v) },
      { label: 'From', value: v.effectiveFrom, kind: 'date' },
      { label: 'Reason', value: v.reason },
    ];
  },
};
