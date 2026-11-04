import { createHash } from 'node:crypto';
import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import {
  BillSplitRule,
  BillingRule,
  BillingRuleVersion,
  BillingRun,
  BillingRunItem,
  Building,
  ChargeHead,
  LateFeePolicy,
  SocietySetting,
  Unit,
  sequelize,
} from '../../models';
import { now } from '../../lib/clock';
import { enqueueAfterCommit } from '../../lib/queue';
import type { Ctx } from '../../types/context';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../../utils/errors';
import { entitlements } from '../subscriptions/subscriptions.public';
import { residents } from '../residents/residents.public';
import {
  APPROVAL_TYPES,
  AUDIT,
  BILLING_QUEUE,
  FEATURES,
  JOBS,
  type BillingCycle,
  type RunType,
} from './billing.constants';
import { billingPorts } from './billing.ports';
import {
  billDateOf,
  isPeriodStart,
  nextPeriodStart,
  periodEndOf,
  periodLabelOf,
  periodStartContaining,
  runLabelOf,
} from './billing.calc.period';
import { itemTotals, variancePctOf } from './billing.runs.compute';
import {
  computeProgress,
  emitRunUpdated,
  loadBillingSettings,
  lockRun,
  societyToday,
} from './billing.runs.shared';
import type { CreateRunInput, ItemListQuery, RunListQuery } from './billing.runs.validation';

/**
 * Billing run service (sections 8.5 to 8.10, BR-11-24, BR-11-25, BR-11-33 to BR-11-36, BR-11-39). Services take a context and
 * never touch `req` or `res`. Every change of a run bumps its `version`; the caller sends the version it read (`STALE_VERSION`).
 */
const staleVersion = () =>
  new ConflictError('STALE_VERSION', 'Someone else changed this run. Reload and try again.');
const invalidState = (message: string) => new ConflictError('INVALID_STATE', message);
const uid = (ctx: Ctx): number | null => ctx.user?.id ?? null;
const societyIdOf = (ctx: Ctx): number => {
  if (!ctx.society) throw new Error('billing run service needs ctx.society');
  return ctx.society.id;
};

// ------------------------------------------------------------------ DTOs
export function runCreatedDto(r: BillingRun) {
  return {
    id: r.id!,
    runLabel: r.runLabel,
    runType: r.runType,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    billDate: r.billDate,
    status: r.status,
    version: r.version,
  };
}

/** `changePct` of section 8.6: (total - previous) x 100 / previous, four decimals. */
const changePctOf = (r: BillingRun, withDiff: boolean): string | null =>
  withDiff && r.previousRunTotalPaise !== null && Number(r.previousRunTotalPaise) > 0
    ? variancePctOf(Number(r.totalPaise), Number(r.previousRunTotalPaise))
    : null;

export function runListDto(r: BillingRun, withDiff: boolean) {
  return {
    id: r.id!,
    runLabel: r.runLabel,
    runType: r.runType,
    status: r.status,
    cycle: r.cycle,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    billDate: r.billDate,
    counts: {
      items: r.itemCount,
      ready: r.readyCount,
      exceptions: r.exceptionCount,
      excluded: r.excludedCount,
      warnings: r.warningCount,
      skipped: r.skippedCount,
      issued: r.issuedCount,
    },
    subtotalPaise: Number(r.subtotalPaise),
    taxPaise: Number(r.taxPaise),
    roundOffPaise: Number(r.roundOffPaise),
    totalPaise: Number(r.totalPaise),
    previousRunTotalPaise: r.previousRunTotalPaise === null ? null : Number(r.previousRunTotalPaise),
    changePct: changePctOf(r, withDiff),
    computedAt: r.computedAt ? r.computedAt.toISOString() : null,
    approvalRequestId: r.approvalRequestId,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
  };
}

/** The tested stale rule of BR-11-35: configuration, settings or resident data changed after `computedAt`. */
export async function isRunStale(run: BillingRun): Promise<boolean> {
  if (!run.computedAt) return false;
  const since = run.computedAt;
  const changed = { [Op.gt]: since };
  const where = { societyId: run.societyId, updatedAt: changed };
  for (const model of [ChargeHead, BillingRule, BillingRuleVersion, BillSplitRule, LateFeePolicy] as const)
    if (await (model as typeof ChargeHead).count({ where })) return true;
  if (
    await SocietySetting.count({
      where: { ...where, settingKey: { [Op.like]: 'billing.%' } },
    })
  )
    return true;
  return residents.changedSince(run.societyId, since);
}

/** Hash of what publish would issue: the items, their state and totals. The wizard sends it back to publish. */
export async function previewHashOf(runId: number, t?: Transaction): Promise<string> {
  const rows = await BillingRunItem.findAll({
    where: { billingRunId: runId },
    attributes: ['itemKey', 'status', 'totalPaise', 'version'],
    order: [['itemKey', 'ASC']],
    transaction: t,
    raw: true,
  });
  const h = createHash('sha256');
  for (const r of rows) h.update(`${r.itemKey}|${r.status}|${r.totalPaise}|${r.version};`);
  return h.digest('hex');
}

/** Section 8.6 detail: counts, totals per head (charge lines of READY and ISSUED items), staleness, progress while computing. */
export async function runDetail(run: BillingRun) {
  const diff = await entitlements.isFeatureOn(run.societyId, FEATURES.billChangeDiff);
  const items = await BillingRunItem.findAll({
    where: { billingRunId: run.id!, status: { [Op.in]: ['READY', 'ISSUED'] } },
    attributes: ['linesSnapshot'],
    raw: true,
  });
  const byKey = new Map<string, number>();
  for (const it of items) {
    const lines = (
      typeof it.linesSnapshot === 'string' ? JSON.parse(it.linesSnapshot) : it.linesSnapshot
    ) as {
      lineKind: string;
      headKey: string | null;
      amountPaise: number;
    }[];
    for (const l of lines)
      if (l.lineKind === 'CHARGE' && l.headKey)
        byKey.set(l.headKey, (byKey.get(l.headKey) ?? 0) + l.amountPaise);
  }
  const heads = byKey.size
    ? await ChargeHead.findAll({
        where: { societyId: run.societyId, key: { [Op.in]: [...byKey.keys()] } },
        order: [
          ['sortOrder', 'ASC'],
          ['id', 'ASC'],
        ],
      })
    : [];
  const progress = run.status === 'COMPUTING' ? (computeProgress.get(run.id!) ?? null) : null;
  return {
    ...runListDto(run, diff),
    byHead: heads.map(h => ({ headKey: h.key, name: h.name, amountPaise: byKey.get(h.key)! })),
    isStale: run.status === 'PREVIEW' ? await isRunStale(run) : false,
    previewHash: run.status === 'PREVIEW' ? await previewHashOf(run.id!) : null,
    scopeType: run.scopeType,
    scopeValues: run.scopeValues,
    splitInputs: run.splitInputs,
    notes: run.notes,
    computeError: run.computeError,
    lastError: run.lastError,
    cancelReason: run.cancelReason,
    publishedAt: run.publishedAt ? run.publishedAt.toISOString() : null,
    approvedAt: run.approvedAt ? run.approvedAt.toISOString() : null,
    issuedAt: run.issuedAt ? run.issuedAt.toISOString() : null,
    progress,
  };
}

interface ItemLine {
  computation?: unknown;
  sacCode?: string | null;
  [k: string]: unknown;
}
export function itemDto(i: BillingRunItem, explain: boolean) {
  const lines = ((typeof i.linesSnapshot === 'string' ? JSON.parse(i.linesSnapshot) : i.linesSnapshot) ??
    []) as ItemLine[];
  return {
    id: i.id!,
    unitId: i.unitId,
    unitLabel: i.unitLabel,
    itemKey: i.itemKey,
    billToResidentId: i.billToResidentId,
    billToRelation: i.billToRelation,
    billToName: i.billToName,
    status: i.status,
    exceptionCode: i.exceptionCode,
    exceptionMessage: i.exceptionMessage,
    warningCodes: i.warningCodes,
    thresholdBasePaise: Number(i.thresholdBasePaise),
    gstApplied: i.gstApplied,
    subtotalPaise: Number(i.subtotalPaise),
    taxPaise: Number(i.taxPaise),
    roundOffPaise: Number(i.roundOffPaise),
    totalPaise: Number(i.totalPaise),
    previousTotalPaise: i.previousTotalPaise === null ? null : Number(i.previousTotalPaise),
    variancePct: i.variancePct,
    excludedReason: i.excludedReason,
    invoiceId: i.invoiceId,
    version: i.version,
    lines: lines.map(({ computation, sacCode: _sac, ...l }) => (explain ? { ...l, computation } : l)),
  };
}

// ------------------------------------------------------------------ reads
async function findRun(societyId: number, id: number): Promise<BillingRun> {
  const run = await BillingRun.findOne({ where: { id, societyId } });
  if (!run) throw new NotFoundError('RUN_NOT_FOUND', 'Billing run not found');
  return run;
}

export async function listRuns(societyId: number, q: RunListQuery) {
  const where: Record<string, unknown> = { societyId };
  if (q.status) where.status = q.status;
  if (q.runType) where.runType = q.runType;
  if (q.periodFrom || q.periodTo)
    where.periodStart = {
      ...(q.periodFrom ? { [Op.gte]: q.periodFrom } : {}),
      ...(q.periodTo ? { [Op.lte]: q.periodTo } : {}),
    };
  const { rows, count } = await BillingRun.findAndCountAll({
    where,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const diff = await entitlements.isFeatureOn(societyId, FEATURES.billChangeDiff);
  return { data: rows.map(r => runListDto(r, diff)), pagination: pageMeta(q.page, q.limit, count) };
}

export async function getRun(societyId: number, id: number) {
  return runDetail(await findRun(societyId, id));
}

export async function listItems(societyId: number, runId: number, q: ItemListQuery) {
  await findRun(societyId, runId);
  const where: Record<string, unknown> = { societyId, billingRunId: runId };
  if (q.status) where.status = q.status;
  if (q.exceptionCode) where.exceptionCode = q.exceptionCode;
  const and: unknown[] = [];
  if (q.warningCode) and.push({ warningCodes: { [Op.like]: `%${q.warningCode}%` } });
  if (q.q)
    and.push({
      [Op.or]: [
        { unitLabel: { [Op.like]: `${q.q.replace(/[%_\\]/g, '\\$&')}%` } },
        { billToName: { [Op.like]: `%${q.q.replace(/[%_\\]/g, '\\$&')}%` } },
      ],
    });
  if (and.length) where[Op.and as unknown as string] = and;
  const { rows, count } = await BillingRunItem.findAndCountAll({
    where,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'ASC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const explain = await entitlements.isFeatureOn(societyId, FEATURES.explainMyBill);
  return { data: rows.map(r => itemDto(r, explain)), pagination: pageMeta(q.page, q.limit, count) };
}

// ------------------------------------------------------------------ create (8.5)
/** BR-11-23: the RUN_INPUT split rules used by versions effective on the period start. */
async function requiredSplitInputs(societyId: number, periodStart: string): Promise<number[]> {
  const versions = await BillingRuleVersion.findAll({
    where: {
      societyId,
      status: 'APPROVED',
      rateType: 'SPLIT_TOTAL',
      effectiveFrom: { [Op.lte]: periodStart },
      [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: periodStart } }],
    },
  });
  if (!versions.length) return [];
  const ruleIds = [...new Set(versions.map(v => v.billingRuleId))];
  const rules = await BillingRule.findAll({
    where: { societyId, id: { [Op.in]: ruleIds }, status: 'ACTIVE' },
  });
  const live = new Set(rules.map(r => r.id));
  const splitIds = [...new Set(versions.filter(v => live.has(v.billingRuleId)).map(v => v.billSplitRuleId!))];
  if (!splitIds.length) return [];
  const splits = await BillSplitRule.findAll({
    where: { societyId, id: { [Op.in]: splitIds }, amountSource: 'RUN_INPUT', status: 'ACTIVE' },
    order: [['id', 'ASC']],
  });
  return splits.map(s => s.id!);
}

async function checkSplitInputs(
  societyId: number,
  periodStart: string,
  given: { billSplitRuleId: number; amountPaise: number }[] | undefined,
): Promise<void> {
  const need = await requiredSplitInputs(societyId, periodStart);
  const have = (given ?? []).map(g => g.billSplitRuleId);
  const extra = have.filter(id => !need.includes(id));
  if (extra.length)
    throw new ValidationError(
      extra.map(id => ({
        field: 'splitInputs',
        message: `Split rule ${id} does not take an amount for this period`,
      })),
    );
  const missing = need.filter(id => !have.includes(id));
  if (missing.length)
    throw new UnprocessableError(
      'RUN_SPLIT_INPUT_MISSING',
      'Enter the amount of every shared bill that is entered per run',
      missing.map(id => ({
        field: 'splitInputs',
        message: `Amount missing for split rule ${id}`,
        billSplitRuleId: id,
      })),
    );
}

async function assertScope(
  societyId: number,
  scopeType: 'BUILDINGS' | 'UNITS',
  values: number[],
): Promise<void> {
  const unique = [...new Set(values)];
  const found =
    scopeType === 'UNITS'
      ? await Unit.count({ where: { societyId, id: { [Op.in]: unique }, status: 'ACTIVE' } })
      : await Building.count({ where: { societyId, id: { [Op.in]: unique } } });
  if (found !== unique.length)
    throw new ValidationError([
      {
        field: 'scopeValues',
        message:
          scopeType === 'UNITS'
            ? 'Every flat must be an active flat of the society'
            : 'Every building must belong to the society',
      },
    ]);
}

export async function createRun(ctx: Ctx, input: CreateRunInput) {
  const societyId = societyIdOf(ctx);
  const s = await loadBillingSettings(societyId);
  const cycle: BillingCycle = s.cycle;
  if (input.runType === 'SUPPLEMENTARY') await entitlements.assertFeature(ctx, FEATURES.adHocInvoices);
  if (cycle !== 'MONTHLY') await entitlements.assertFeature(ctx, FEATURES.billingCycles);
  if (input.runType === 'REGULAR' && input.scopeType && input.scopeType !== 'ALL_UNITS')
    throw new ValidationError([{ field: 'scopeType', message: 'A regular run bills every flat' }]);
  if (
    input.runType === 'SUPPLEMENTARY' &&
    (!input.scopeType || input.scopeType === 'ALL_UNITS' || !input.scopeValues?.length)
  )
    throw new ValidationError([
      { field: 'scopeType', message: 'A supplementary run needs BUILDINGS or UNITS and their ids' },
    ]);

  const ps = input.periodStart;
  const today = await societyToday(societyId);
  if (!isPeriodStart(cycle, ps))
    throw new UnprocessableError(
      'RUN_PERIOD_INVALID',
      `The period must start on a ${cycle.toLowerCase().replace('_', '-')} period start`,
    );
  const oldest = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  if (ps < oldest)
    throw new UnprocessableError('RUN_PERIOD_INVALID', 'The period is more than 12 months old');
  if (input.runType === 'REGULAR') {
    const first = await BillingRun.min('periodStart', {
      where: { societyId, runType: 'REGULAR', status: { [Op.ne]: 'CANCELLED' } },
    });
    if (first && ps < String(first))
      throw new UnprocessableError(
        'RUN_PERIOD_INVALID',
        'The period is before the billing start of the society',
      );
  }
  const limit = nextPeriodStart(cycle, periodStartContaining(cycle, today));
  if (ps > limit)
    throw new UnprocessableError('RUN_PERIOD_TOO_FAR', 'Only the next period can be billed ahead');
  const periodEnd = periodEndOf(cycle, ps);
  const issuedOverlap = await BillingRun.count({
    where: {
      societyId,
      runType: 'REGULAR',
      status: 'ISSUED',
      periodStart: { [Op.lte]: periodEnd },
      periodEnd: { [Op.gte]: ps },
    },
  });
  if (issuedOverlap) throw new ConflictError('RUN_PERIOD_EXISTS', 'This period is already billed');
  if (input.scopeType && input.scopeType !== 'ALL_UNITS')
    await assertScope(societyId, input.scopeType as 'BUILDINGS' | 'UNITS', input.scopeValues ?? []);
  await checkSplitInputs(societyId, ps, input.splitInputs);

  const runType = input.runType as RunType;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await sequelize.transaction(async t => {
        let label = runLabelOf(ps);
        if (
          runType === 'REGULAR' &&
          (await BillingRun.count({ where: { societyId, activeKey: `REG:${ps}` }, transaction: t }))
        )
          throw new ConflictError('RUN_PERIOD_EXISTS', 'A regular run already exists for this period');
        if (runType === 'REGULAR') {
          // a cancelled run keeps its label (unique per society): the next run of the period is BR-2026-11-R2
          const n = await BillingRun.count({
            where: { societyId, runType: 'REGULAR', periodStart: ps },
            transaction: t,
          });
          if (n > 0) label = `${label}-R${n + 1}`;
        }
        if (runType === 'SUPPLEMENTARY') {
          const n = await BillingRun.count({
            where: { societyId, runType: 'SUPPLEMENTARY', periodStart: ps },
            transaction: t,
          });
          label = runLabelOf(ps, n + 1 + attempt);
        }
        const run = await BillingRun.create(
          {
            societyId,
            runLabel: label,
            runType,
            cycle,
            periodStart: ps,
            periodEnd,
            billDate: billDateOf(ps, s.billingDay),
            scopeType: runType === 'REGULAR' ? 'ALL_UNITS' : (input.scopeType as 'BUILDINGS' | 'UNITS'),
            scopeValues: runType === 'REGULAR' ? null : (input.scopeValues ?? null),
            splitInputs: input.splitInputs?.length ? input.splitInputs : null,
            status: 'DRAFT',
            activeKey: runType === 'REGULAR' ? `REG:${ps}` : null,
            notes: input.notes ?? null,
            createdBy: uid(ctx),
            updatedBy: uid(ctx),
          } as never,
          { transaction: t },
        );
        await audit(
          ctx,
          {
            action: AUDIT.runCreated,
            entityType: 'billing_run',
            entityId: run.id!,
            entityLabel: run.runLabel,
            societyId,
            after: { runType, periodStart: ps, scopeType: run.scopeType },
          },
          t,
        );
        enqueueAfterCommit(
          t,
          BILLING_QUEUE,
          JOBS.computeRun,
          { runId: run.id, version: run.version, societyId },
          { jobId: `compute:${run.id}:${run.version}` },
        );
        emitRunUpdated(run, t);
        return runCreatedDto(run);
      });
    } catch (err) {
      // two creates at once can end as a deadlock of the unique-key inserts: retry, the pre-check then sees the winner
      if ((err as { parent?: { errno?: number } }).parent?.errno === 1213) continue;
      if (err instanceof UniqueConstraintError) {
        if (runType === 'REGULAR')
          throw new ConflictError('RUN_PERIOD_EXISTS', 'A regular run already exists for this period');
        continue;
      }
      throw err;
    }
  }
  throw new ConflictError('CONFLICT', 'Could not number the supplementary run; try again');
}

// ------------------------------------------------------------------ patch and recompute (8.7)
async function requeue(
  ctx: Ctx,
  id: number,
  version: number,
  action: string,
  patch: (run: BillingRun) => Partial<BillingRun> | Promise<Partial<BillingRun>>,
) {
  const societyId = societyIdOf(ctx);
  return sequelize.transaction(async t => {
    const run = await lockRun(societyId, id, t);
    if (!['DRAFT', 'PREVIEW', 'FAILED'].includes(run.status))
      throw invalidState(`A ${run.status.toLowerCase().replace('_', ' ')} run cannot be recomputed`);
    if (run.version !== version) throw staleVersion();
    const changes = await patch(run);
    const before = { status: run.status };
    await run.update(
      {
        ...changes,
        status: 'DRAFT',
        computeError: null,
        version: run.version + 1,
        updatedBy: uid(ctx),
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action,
        entityType: 'billing_run',
        entityId: run.id!,
        entityLabel: run.runLabel,
        societyId,
        before,
        after: { status: 'DRAFT', ...(changes.notes !== undefined ? { notes: changes.notes } : {}) },
      },
      t,
    );
    enqueueAfterCommit(
      t,
      BILLING_QUEUE,
      JOBS.computeRun,
      { runId: run.id, version: run.version, societyId },
      { jobId: `compute:${run.id}:${run.version}` },
    );
    emitRunUpdated(run, t);
    return runCreatedDto(run);
  });
}

export function patchRun(
  ctx: Ctx,
  id: number,
  input: {
    splitInputs?: { billSplitRuleId: number; amountPaise: number }[];
    notes?: string | null;
    version: number;
  },
) {
  return requeue(ctx, id, input.version, AUDIT.runUpdated, async run => {
    const changes: Partial<BillingRun> = {};
    if (input.splitInputs !== undefined) {
      await checkSplitInputs(run.societyId, run.periodStart, input.splitInputs);
      changes.splitInputs = input.splitInputs.length ? input.splitInputs : null;
    }
    if (input.notes !== undefined) changes.notes = input.notes;
    return changes;
  });
}

export const recomputeRun = (ctx: Ctx, id: number, version: number) =>
  requeue(ctx, id, version, AUDIT.runRecomputed, async run => {
    await checkSplitInputs(run.societyId, run.periodStart, run.splitInputs ?? []);
    return {};
  });

// ------------------------------------------------------------------ exclude and include (8.8)
async function toggleItem(
  ctx: Ctx,
  runId: number,
  itemId: number,
  input: { reason?: string; version: number },
  include: boolean,
) {
  const societyId = societyIdOf(ctx);
  return sequelize.transaction(async t => {
    const run = await lockRun(societyId, runId, t);
    const item = await BillingRunItem.findOne({
      where: { id: itemId, billingRunId: runId, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!item) throw new NotFoundError('RUN_ITEM_NOT_FOUND', 'Run item not found');
    if (run.status !== 'PREVIEW')
      throw invalidState('Flats can only be excluded or included while the run is in preview');
    if (item.version !== input.version) throw staleVersion();
    if (include) {
      if (item.status !== 'EXCLUDED') throw invalidState('Only an excluded flat can be included');
      if (item.exceptionCode || item.excludedReason === 'ZERO_TOTAL')
        throw invalidState('This flat cannot be included: fix the cause and recompute');
      await item.update(
        {
          status: 'READY',
          excludedReason: null,
          excludedBy: null,
          updatedBy: uid(ctx),
          version: item.version + 1,
        },
        { transaction: t },
      );
    } else {
      if (!['READY', 'EXCEPTION'].includes(item.status))
        throw invalidState('Only a ready or exception flat can be excluded');
      await item.update(
        {
          status: 'EXCLUDED',
          excludedReason: input.reason!,
          excludedBy: uid(ctx),
          updatedBy: uid(ctx),
          version: item.version + 1,
        },
        { transaction: t },
      );
    }
    const totals = await itemTotals(runId, t);
    await run.update({ ...totals, version: run.version + 1, updatedBy: uid(ctx) }, { transaction: t });
    await audit(
      ctx,
      {
        action: include ? AUDIT.runItemIncluded : AUDIT.runItemExcluded,
        entityType: 'billing_run_item',
        entityId: item.id!,
        entityLabel: item.unitLabel,
        societyId,
        reason: include ? null : input.reason,
        after: { runId, unitId: item.unitId },
      },
      t,
    );
    emitRunUpdated(run, t);
    const explain = await entitlements.isFeatureOn(societyId, FEATURES.explainMyBill);
    return { item: itemDto(item, explain), run: runListDto(run, false) };
  });
}
export const excludeItem = (
  ctx: Ctx,
  runId: number,
  itemId: number,
  input: { reason: string; version: number },
) => toggleItem(ctx, runId, itemId, input, false);
export const includeItem = (ctx: Ctx, runId: number, itemId: number, input: { version: number }) =>
  toggleItem(ctx, runId, itemId, input, true);

// ------------------------------------------------------------------ publish (8.9)
/** BR-11-36 `onApproved` body, shared with the publish transaction when module 14 auto-approves. */
export async function markApproved(ctx: Ctx, run: BillingRun, t: Transaction): Promise<void> {
  const today = await societyToday(run.societyId);
  const issueNow = today >= run.billDate;
  await run.update(
    {
      status: issueNow ? 'ISSUING' : 'APPROVED',
      approvedBy: uid(ctx),
      approvedAt: now(),
      issueStartedAt: issueNow ? now() : null,
      lastError: null,
      version: run.version + 1,
    },
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: AUDIT.runApproved,
      entityType: 'billing_run',
      entityId: run.id!,
      entityLabel: run.runLabel,
      societyId: run.societyId,
      after: { status: run.status },
    },
    t,
  );
  if (issueNow) enqueueIssue(run, t);
  emitRunUpdated(run, t);
}

/** Enqueues the issue job after commit (`jobId = issue:<runId>:<version>`, so a resume gets a new job). */
export function enqueueIssue(run: BillingRun, t: Transaction): void {
  enqueueAfterCommit(
    t,
    BILLING_QUEUE,
    JOBS.issueRun,
    { runId: run.id, societyId: run.societyId },
    { jobId: `issue:${run.id}:${run.version}` },
  );
}

export async function publishRun(
  ctx: Ctx,
  id: number,
  input: { confirmLabel: string; version: number; previewHash?: string },
) {
  const societyId = societyIdOf(ctx);
  const dto = await sequelize.transaction(async t => {
    const approvals = billingPorts().approvals;
    const open = await approvals.lockOpenForEntity(societyId, 'billing_run', id, t);
    const run = await lockRun(societyId, id, t);
    if (run.status !== 'PREVIEW') throw invalidState('Only a run in preview can be published');
    if (run.version !== input.version) throw staleVersion();
    if (input.confirmLabel !== run.runLabel)
      throw new UnprocessableError('RUN_CONFIRM_MISMATCH', 'Type the run label exactly to confirm');
    if (open && open.id !== run.approvalRequestId)
      throw new ConflictError('APPROVAL_ALREADY_PENDING', 'An approval request is already open for this run');
    const totals = await itemTotals(id, t);
    if (totals.exceptionCount > 0)
      throw new UnprocessableError('RUN_HAS_EXCEPTIONS', 'Exclude or fix the flats with exceptions first');
    if (totals.readyCount === 0) throw new UnprocessableError('RUN_EMPTY', 'There is nothing to issue');
    if ((await isRunStale(run)) || (input.previewHash && input.previewHash !== (await previewHashOf(id, t))))
      throw new ConflictError('RUN_STALE', 'Something changed after this run was computed. Recompute it.');
    if (totals.taxPaise > 0) await assertTaxedLinesHaveSac(id, t);

    const label = periodLabelOf(run.cycle, run.periodStart);
    const title = `Billing run ${label} · ${totals.readyCount} flats`;
    const payload = {
      periodStart: run.periodStart,
      readyCount: totals.readyCount,
      exceptionCount: 0,
      totalPaise: totals.totalPaise,
    };
    let requestId: number;
    let status: 'PENDING' | 'APPROVED';
    if (run.approvalRequestId && run.publishedBy === uid(ctx)) {
      await approvals.resubmit(
        ctx,
        run.approvalRequestId,
        { title, amountPaise: totals.totalPaise, payload },
        t,
      );
      requestId = run.approvalRequestId;
      status = 'PENDING';
    } else {
      if (run.approvalRequestId)
        await approvals.cancel(ctx, run.approvalRequestId, 'Republished by another user', t);
      const r = await approvals.request(
        ctx,
        {
          type: APPROVAL_TYPES.runPublish,
          entityType: 'billing_run',
          entityId: run.id!,
          title,
          amountPaise: totals.totalPaise,
          summary: `${run.runLabel}: ${totals.readyCount} flats, ${totals.totalPaise} paise`,
          payload,
        },
        t,
      );
      requestId = r.id;
      status = r.status;
    }
    await run.update(
      {
        ...totals,
        status: 'PENDING_APPROVAL',
        approvalRequestId: requestId,
        publishedBy: uid(ctx),
        publishedAt: now(),
        version: run.version + 1,
        updatedBy: uid(ctx),
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.runPublishRequested,
        entityType: 'billing_run',
        entityId: run.id!,
        entityLabel: run.runLabel,
        societyId,
        after: { requestId, readyCount: totals.readyCount, totalPaise: totals.totalPaise },
      },
      t,
    );
    if (status === 'APPROVED') await markApproved(ctx, run, t);
    else emitRunUpdated(run, t);
    return run;
  });
  return runDetail(dto);
}

/** BR-11-32: a taxed line on a head without a SAC code is refused at publish. */
async function assertTaxedLinesHaveSac(runId: number, t: Transaction): Promise<void> {
  const rows = await BillingRunItem.findAll({
    where: { billingRunId: runId, status: 'READY' },
    attributes: ['unitLabel', 'linesSnapshot'],
    transaction: t,
    raw: true,
  });
  const bad = new Set<string>();
  for (const r of rows) {
    const lines = (typeof r.linesSnapshot === 'string' ? JSON.parse(r.linesSnapshot) : r.linesSnapshot) as {
      isTaxable: boolean;
      sacCode: string | null;
      headKey: string | null;
    }[];
    for (const l of lines) if (l.isTaxable && !l.sacCode && l.headKey) bad.add(l.headKey);
  }
  if (bad.size)
    throw new UnprocessableError(
      'GST_SETTINGS_INVALID',
      'A charge head that is taxed needs a SAC code',
      [...bad].map(k => ({ field: 'chargeHead', message: `${k} has no SAC code` })),
    );
}

// ------------------------------------------------------------------ approval callbacks (module 14, BR-11-36)
export async function onRunApproved(ctx: Ctx, runId: number, t: Transaction): Promise<void> {
  const societyId = ctx.society?.id ?? (await BillingRun.findByPk(runId, { transaction: t }))?.societyId;
  if (!societyId) throw new NotFoundError('RUN_NOT_FOUND', 'Billing run not found');
  const run = await lockRun(societyId, runId, t);
  if (run.status !== 'PENDING_APPROVAL') throw invalidState('The run is not waiting for approval');
  await markApproved(ctx, run, t);
}

export async function onRunRejected(ctx: Ctx, runId: number, reason: string, t: Transaction): Promise<void> {
  const societyId = ctx.society?.id ?? (await BillingRun.findByPk(runId, { transaction: t }))?.societyId;
  if (!societyId) throw new NotFoundError('RUN_NOT_FOUND', 'Billing run not found');
  const run = await lockRun(societyId, runId, t);
  if (run.status !== 'PENDING_APPROVAL') throw invalidState('The run is not waiting for approval');
  await run.update(
    { status: 'PREVIEW', approvalRequestId: null, version: run.version + 1 },
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: AUDIT.runRejected,
      entityType: 'billing_run',
      entityId: run.id!,
      entityLabel: run.runLabel,
      societyId,
      reason,
    },
    t,
  );
  emitRunUpdated(run, t);
}

/** Back to PREVIEW, editable; `approvalRequestId` stays so that publish can resubmit it. */
export async function onRunChangesRequested(ctx: Ctx, runId: number, t: Transaction): Promise<void> {
  const societyId = ctx.society?.id ?? (await BillingRun.findByPk(runId, { transaction: t }))?.societyId;
  if (!societyId) throw new NotFoundError('RUN_NOT_FOUND', 'Billing run not found');
  const run = await lockRun(societyId, runId, t);
  if (run.status !== 'PENDING_APPROVAL') throw invalidState('The run is not waiting for approval');
  await run.update({ status: 'PREVIEW', version: run.version + 1 }, { transaction: t });
  await audit(
    ctx,
    {
      action: AUDIT.runChangesRequested,
      entityType: 'billing_run',
      entityId: run.id!,
      entityLabel: run.runLabel,
      societyId,
    },
    t,
  );
  emitRunUpdated(run, t);
}

// ------------------------------------------------------------------ cancel and resume (8.10)
export async function cancelRun(ctx: Ctx, id: number, input: { reason: string; version: number }) {
  const societyId = societyIdOf(ctx);
  return sequelize.transaction(async t => {
    const run = await lockRun(societyId, id, t);
    if (!['DRAFT', 'PREVIEW', 'FAILED'].includes(run.status))
      throw invalidState('Only a draft, preview or failed run can be cancelled');
    if (run.version !== input.version) throw staleVersion();
    await run.update(
      {
        status: 'CANCELLED',
        activeKey: null,
        cancelReason: input.reason,
        version: run.version + 1,
        updatedBy: uid(ctx),
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.runCancelled,
        entityType: 'billing_run',
        entityId: run.id!,
        entityLabel: run.runLabel,
        societyId,
        reason: input.reason,
      },
      t,
    );
    emitRunUpdated(run, t);
    return runCreatedDto(run);
  });
}

/** Issue jobs running in this process (a resume needs "no active issue job"). */
export const activeIssues = new Set<number>();

export async function resumeIssue(ctx: Ctx, id: number, version: number) {
  const societyId = societyIdOf(ctx);
  return sequelize.transaction(async t => {
    const run = await lockRun(societyId, id, t);
    if (run.status !== 'ISSUING' || !run.lastError || activeIssues.has(run.id!))
      throw invalidState('Only a stuck issuing run can be resumed');
    if (run.version !== version) throw staleVersion();
    await run.update({ lastError: null, version: run.version + 1, updatedBy: uid(ctx) }, { transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.runIssueResumed,
        entityType: 'billing_run',
        entityId: run.id!,
        entityLabel: run.runLabel,
        societyId,
      },
      t,
    );
    enqueueIssue(run, t);
    emitRunUpdated(run, t);
    return runCreatedDto(run);
  });
}
