import { Op, QueryTypes, type InferCreationAttributes } from 'sequelize';
import {
  BillSplitRule,
  BillingRule,
  BillingRuleVersion,
  BillingRun,
  BillingRunItem,
  ChargeHead,
  Invoice,
  Unit,
  sequelize,
} from '../../models';
import { now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { roundHalfUpBig } from '../../lib/money';
import { systemCtx } from '../../types/context';
import { audit } from '../../utils/audit';
import { AppError } from '../../utils/errors';
import { residents } from '../residents/residents.public';
import { units as unitsApi } from '../society-setup/society-setup.public';
import {
  AUDIT,
  VARIANCE_WARN_PCT,
  COMPUTE_BATCH_UNITS,
  type ExceptionCode,
  type WarningCode,
} from './billing.constants';
import { billingPorts, requireMeterSource } from './billing.ports';
import { splitPaise, splitWeight, type WeightedUnit } from './billing.split';
import { scopeMatches, winningRule, type RuleCandidate } from './billing.calc.rules';
import type { MeterReading, RateVersion } from './billing.calc.rates';
import { liableSegments, type LinkRow, type Party, type Segment } from './billing.calc.segments';
import { calcUnit, type CalcHead, type CalcUnit, type UnitCalc } from './billing.calc.unit';
import {
  RunComputeError,
  calcSettingsFor,
  computeProgress,
  emitRunUpdated,
  loadBillingFeatures,
  loadBillingSettings,
} from './billing.runs.shared';

/**
 * The compute engine of section 6.3 (`billing:compute-run`). Phase 1 reads the society's flats, their links and the module 09
 * bill-to party for every liable segment; split shares are then worked out across all flats (they need every flat's weight);
 * phase 2 runs the pure calculator per flat and writes the items in transactions of 200 flats (delete the flats' items, insert
 * the new ones). The run changes status in its own transactions: DRAFT to COMPUTING first, COMPUTING to PREVIEW last.
 */
interface UnitData {
  unit: CalcUnit & { possessionDate: string | null };
  segments: Segment[];
}

const toParty = (b: { residentId: number; relation: Party['relation']; name: string }): Party => ({
  residentId: b.residentId,
  relation: b.relation,
  name: b.name,
});

/** Percent change with four decimals, half-up, as a `DECIMAL(9,4)` string (BR-11-29). */
export function variancePctOf(totalPaise: number, previousPaise: number): string {
  const units = roundHalfUpBig(BigInt(totalPaise - previousPaise) * 100n * 10_000n, BigInt(previousPaise));
  const neg = units < 0n;
  const abs = (neg ? -units : units).toString().padStart(5, '0');
  return `${neg ? '-' : ''}${abs.slice(0, -4)}.${abs.slice(-4)}`;
}

/** Marks a run FAILED with the reason (compute error or exhausted retries). */
export async function failRun(runId: number, message: string): Promise<void> {
  const run = await sequelize.transaction(async t => {
    const r = await BillingRun.findByPk(runId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!r || !['DRAFT', 'COMPUTING'].includes(r.status)) return null;
    await r.update(
      { status: 'FAILED', computeError: message.slice(0, 500), version: r.version + 1 },
      { transaction: t },
    );
    await audit(
      systemCtx('compute-run'),
      {
        action: AUDIT.runFailed,
        entityType: 'billing_run',
        entityId: r.id!,
        entityLabel: r.runLabel,
        societyId: r.societyId,
        after: { error: message.slice(0, 200) },
      },
      t,
    );
    emitRunUpdated(r, t);
    return r;
  });
  computeProgress.delete(runId);
  if (run?.createdBy)
    await billingPorts().notifications.send('billing.run_failed', [run.createdBy], {
      runLabel: run.runLabel,
      reason: message.slice(0, 200),
    });
}

export async function computeRun(runId: number, jobVersion: number): Promise<void> {
  // 1. DRAFT to COMPUTING (a retry of the same version continues from COMPUTING)
  const start = await sequelize.transaction(async t => {
    const r = await BillingRun.findByPk(runId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!r || r.version !== jobVersion) return null;
    if (r.status === 'DRAFT') await r.update({ status: 'COMPUTING', computeError: null }, { transaction: t });
    else if (r.status !== 'COMPUTING') return null;
    emitRunUpdated(r, t);
    return r;
  });
  if (!start) return;
  const run = start;
  const societyId = run.societyId;
  const startedAt = now();

  const s = await loadBillingSettings(societyId);
  const features = await loadBillingFeatures(societyId);
  const calcSettings = calcSettingsFor(s, features, run.cycle, run.periodStart, run.periodEnd);
  const ps = run.periodStart;

  // 2. configuration: heads, rules with the version effective on periodStart, split rules
  const heads = await ChargeHead.findAll({ where: { societyId, status: 'ACTIVE', isSystem: false } });
  const calcHeads: CalcHead[] = heads.map(h => ({
    id: h.id!,
    key: h.key,
    name: h.name,
    headType: h.headType,
    payerRouting: h.payerRouting,
    gstTreatment: h.gstTreatment,
    sacCode: h.sacCode,
    prorate: h.prorate,
    ledgerAccountCode: h.ledgerAccountCode,
    sortOrder: h.sortOrder,
  }));
  const headIds = new Set(calcHeads.map(h => h.id));
  const rules = await BillingRule.findAll({ where: { societyId, status: 'ACTIVE' } });
  const versions = await BillingRuleVersion.findAll({
    where: {
      societyId,
      status: 'APPROVED',
      effectiveFrom: { [Op.lte]: ps },
      [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: ps } }],
    },
    order: [
      ['effectiveFrom', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const candidates: RuleCandidate[] = [];
  for (const rule of rules) {
    if (!headIds.has(rule.chargeHeadId)) continue;
    const v = versions.find(x => x.billingRuleId === rule.id);
    if (!v) continue;
    candidates.push({
      ruleId: rule.id!,
      chargeHeadId: rule.chargeHeadId,
      scopeType: rule.scopeType,
      scopeValues: rule.scopeValues,
      version: {
        id: v.id!,
        versionNo: v.versionNo,
        rateType: v.rateType,
        amountPaise: v.amountPaise === null ? null : Number(v.amountPaise),
        ratePerSqftPaise: v.ratePerSqftPaise === null ? null : Number(v.ratePerSqftPaise),
        unitTypeRates: v.unitTypeRates,
        meterType: v.meterType,
        slabs: v.slabs,
        minimumChargePaise: v.minimumChargePaise === null ? null : Number(v.minimumChargePaise),
        missingReadingPolicy: v.missingReadingPolicy,
        billSplitRuleId: v.billSplitRuleId,
        percent: v.percent,
        baseChargeHeadIds: v.baseChargeHeadIds,
      } satisfies RateVersion,
    });
  }
  const usesSplit = candidates.some(c => c.version.rateType === 'SPLIT_TOTAL');

  // meter consumption: one call per meter type used (BR-11-17)
  const meters = new Map<string, Map<number, MeterReading>>();
  for (const type of new Set(candidates.map(c => c.version.meterType).filter(Boolean) as string[])) {
    const src = requireMeterSource(type as 'WATER' | 'ELECTRICITY' | 'GAS');
    meters.set(type, await src.consumptionForPeriod(societyId, ps, run.periodEnd));
  }

  // 3. flats in the society (all billable ones: splits weigh every flat), then the run's scope
  const allUnits = await unitsApi.listActive(societyId, { isBillable: true });
  const possession = new Map(
    (
      await Unit.findAll({
        where: { societyId, status: 'ACTIVE', isBillable: true },
        attributes: ['id', 'possessionDate'],
      })
    ).map(u => [u.id!, u.possessionDate]),
  );
  const inScope = (u: { id: number; buildingId: number }): boolean =>
    run.scopeType === 'ALL_UNITS' ||
    (run.scopeType === 'BUILDINGS' && (run.scopeValues ?? []).map(Number).includes(u.buildingId)) ||
    (run.scopeType === 'UNITS' && (run.scopeValues ?? []).map(Number).includes(u.id));
  const wanted = allUnits.filter(u => usesSplit || inScope(u));
  computeProgress.set(runId, { processed: 0, total: wanted.length });

  const data = new Map<number, UnitData>();
  for (const u of wanted) {
    const links = (
      await residents.listForUnit(societyId, u.id, {
        relation: ['OWNER', 'CO_OWNER', 'TENANT'],
        from: ps,
        to: run.periodEnd,
      })
    ).map<LinkRow>(l => ({
      linkId: l.linkId,
      residentId: l.residentId,
      name: l.name,
      relation: l.relation,
      isPrimary: l.isPrimary,
      fromDate: l.fromDate,
      toDate: l.toDate,
    }));
    const segments = liableSegments(links, ps, run.periodEnd, possession.get(u.id) ?? null);
    for (const seg of segments) {
      const b = await residents.billToFor(u.id, seg.from);
      if (b) seg.billTo = toParty(b);
    }
    data.set(u.id, {
      unit: {
        id: u.id,
        label: u.label,
        buildingId: u.buildingId,
        unitType: u.unitType,
        bhk: u.bhk,
        areaSqft: u.areaSqft,
        possessionDate: possession.get(u.id) ?? null,
      },
      segments,
    });
  }

  // 4. split shares (BR-11-22, BR-11-23)
  const shares = await splitSharesFor({ run, candidates, data, months: calcSettings.months });

  // 5. previous bills for the variance and for ALREADY_BILLED
  const previous = new Map<string, number>();
  if (features.billChangeDiff) {
    const rows = await sequelize.query<{ unitId: number; billToResidentId: number; totalPaise: number }>(
      `SELECT i.unitId, i.billToResidentId, i.totalPaise FROM invoices i
       WHERE i.societyId = ? AND i.invoiceType = 'REGULAR' AND i.status <> 'CANCELLED' AND i.periodStart < ?
         AND i.periodStart = (SELECT MAX(j.periodStart) FROM invoices j WHERE j.societyId = i.societyId
           AND j.unitId = i.unitId AND j.billToResidentId = i.billToResidentId AND j.invoiceType = 'REGULAR'
           AND j.status <> 'CANCELLED' AND j.periodStart < ?)`,
      { replacements: [societyId, ps, ps], type: QueryTypes.SELECT },
    );
    for (const r of rows) previous.set(`${r.unitId}:${r.billToResidentId}`, Number(r.totalPaise));
  }
  const billed = new Set(
    (
      await Invoice.findAll({
        where: { societyId, periodStart: ps, invoiceType: { [Op.in]: ['REGULAR', 'SUPPLEMENTARY'] } },
        attributes: ['unitId', 'billToResidentId'],
      })
    ).map(i => `${i.unitId}:${i.billToResidentId}`),
  );

  // 6. items: delete everything once, then write in batches of 200 flats
  await BillingRunItem.destroy({ where: { billingRunId: runId } });
  const runUnits = [...data.values()].filter(d => inScope(d.unit));
  let skipped = 0;
  for (let i = 0; i < runUnits.length; i += COMPUTE_BATCH_UNITS) {
    const batch = runUnits.slice(i, i + COMPUTE_BATCH_UNITS);
    const rows: ItemRow[] = [];
    for (const d of batch) {
      const result: UnitCalc = calcUnit({
        unit: d.unit,
        segments: d.segments,
        heads: calcHeads,
        candidates,
        settings: calcSettings,
        splitFor: id => shares.get(id)?.get(d.unit.id),
        meterFor: type => meters.get(type)?.get(d.unit.id),
      });
      if (result.status === 'SKIPPED') {
        skipped += 1;
        continue;
      }
      const base = {
        societyId,
        billingRunId: runId,
        unitId: d.unit.id,
        unitLabel: d.unit.label,
        createdBy: run.createdBy,
        updatedBy: run.createdBy,
      };
      if (result.status === 'EXCEPTION') {
        const owner = d.segments[0]?.owner;
        rows.push(
          itemRow(base, {
            itemKey: `${d.unit.id}:0`,
            party: owner ?? null,
            status: 'EXCEPTION',
            exceptionCode: result.code,
            exceptionMessage: result.message,
          }),
        );
        continue;
      }
      if (!result.items.length) {
        const owner = d.segments[0]!.owner;
        rows.push(
          itemRow(base, {
            itemKey: `${d.unit.id}:${owner.residentId}`,
            party: owner,
            status: 'EXCLUDED',
            excludedReason: 'ZERO_TOTAL',
            thresholdBasePaise: result.thresholdBasePaise,
          }),
        );
        continue;
      }
      for (const it of result.items) {
        const key = `${d.unit.id}:${it.party.residentId}`;
        const warnings: WarningCode[] = [...it.warnings];
        const prev = previous.get(key);
        let variance: string | null = null;
        if (prev !== undefined && prev > 0) {
          variance = variancePctOf(it.totalPaise, prev);
          if (Math.abs(Number(variance.replace('.', ''))) > VARIANCE_WARN_PCT * 10_000)
            warnings.push('LARGE_VARIANCE');
        }
        const already = billed.has(key);
        rows.push(
          itemRow(base, {
            itemKey: key,
            party: it.party,
            status: already ? 'EXCEPTION' : it.totalPaise <= 0 ? 'EXCLUDED' : 'READY',
            exceptionCode: already ? 'ALREADY_BILLED' : null,
            exceptionMessage: already
              ? 'This flat and bill-to party already have a bill for this period.'
              : null,
            excludedReason: !already && it.totalPaise <= 0 ? 'ZERO_TOTAL' : null,
            warningCodes: warnings.length ? warnings.join(',') : null,
            lines: it.lines,
            thresholdBasePaise: result.thresholdBasePaise,
            gstApplied: result.gstApplied,
            subtotalPaise: it.subtotalPaise,
            taxPaise: it.taxPaise,
            roundOffPaise: it.roundOffPaise,
            totalPaise: it.totalPaise,
            previousTotalPaise: prev ?? null,
            variancePct: variance,
          }),
        );
      }
    }
    const written = await sequelize.transaction(async t => {
      await BillingRunItem.destroy({
        where: { billingRunId: runId, unitId: { [Op.in]: batch.map(b => b.unit.id) } },
        transaction: t,
      });
      await BillingRunItem.bulkCreate(rows, { transaction: t });
      const count = await BillingRunItem.count({ where: { billingRunId: runId }, transaction: t });
      await BillingRun.update({ itemCount: count }, { where: { id: runId }, transaction: t });
      return count;
    });
    computeProgress.set(runId, {
      processed: Math.min(i + batch.length, runUnits.length),
      total: runUnits.length,
    });
    emitRunUpdated({ id: runId, societyId, status: 'COMPUTING', itemCount: written, issuedCount: 0 });
  }

  // 7. totals, previous run, PREVIEW (own transaction)
  const previousRun = await BillingRun.findOne({
    where: {
      societyId,
      runType: 'REGULAR',
      status: 'ISSUED',
      periodStart: { [Op.lt]: ps },
    },
    order: [['periodStart', 'DESC']],
  });
  await sequelize.transaction(async t => {
    const r = await BillingRun.findByPk(runId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!r || r.status !== 'COMPUTING') return;
    const totals = await itemTotals(runId, t);
    await r.update(
      {
        status: 'PREVIEW',
        ...totals,
        skippedCount: skipped,
        previousRunTotalPaise: previousRun ? Number(previousRun.totalPaise) : null,
        computedAt: startedAt,
        computeError: null,
        version: r.version + 1,
      },
      { transaction: t },
    );
    await audit(
      systemCtx('compute-run'),
      {
        action: AUDIT.runComputed,
        entityType: 'billing_run',
        entityId: r.id!,
        entityLabel: r.runLabel,
        societyId,
        after: { items: totals.itemCount, ready: totals.readyCount, exceptions: totals.exceptionCount },
      },
      t,
    );
    emitRunUpdated(r, t);
  });
  computeProgress.delete(runId);
}

type ItemRow = InferCreationAttributes<BillingRunItem, { omit: 'id' | 'createdAt' | 'updatedAt' }>;

interface ItemSpec {
  itemKey: string;
  party: Party | null;
  status: 'READY' | 'EXCEPTION' | 'EXCLUDED';
  exceptionCode?: ExceptionCode | null;
  exceptionMessage?: string | null;
  excludedReason?: string | null;
  warningCodes?: string | null;
  lines?: unknown[];
  thresholdBasePaise?: number;
  gstApplied?: boolean;
  subtotalPaise?: number;
  taxPaise?: number;
  roundOffPaise?: number;
  totalPaise?: number;
  previousTotalPaise?: number | null;
  variancePct?: string | null;
}

function itemRow(
  base: {
    societyId: number;
    billingRunId: number;
    unitId: number;
    unitLabel: string;
    createdBy: number | null;
    updatedBy: number | null;
  },
  s: ItemSpec,
): ItemRow {
  return {
    ...base,
    itemKey: s.itemKey,
    billToResidentId: s.party?.residentId ?? null,
    billToRelation: s.party?.relation ?? null,
    billToName: s.party?.name.slice(0, 150) ?? null,
    status: s.status,
    exceptionCode: s.exceptionCode ?? null,
    exceptionMessage: s.exceptionMessage ?? null,
    warningCodes: s.warningCodes ?? null,
    linesSnapshot: s.lines ?? [],
    thresholdBasePaise: s.thresholdBasePaise ?? 0,
    gstApplied: s.gstApplied ?? false,
    subtotalPaise: s.subtotalPaise ?? 0,
    taxPaise: s.taxPaise ?? 0,
    roundOffPaise: s.roundOffPaise ?? 0,
    totalPaise: s.totalPaise ?? 0,
    previousTotalPaise: s.previousTotalPaise ?? null,
    variancePct: s.variancePct ?? null,
    excludedReason: s.excludedReason ?? null,
    excludedBy: null,
    invoiceId: null,
    version: 1,
  };
}

/** Counts and totals of a run from its items (Σ of READY items for the money, section 7.5). */
export async function itemTotals(runId: number, t?: import('sequelize').Transaction) {
  const [row] = await sequelize.query<Record<string, string | number | null>>(
    `SELECT COUNT(*) AS itemCount,
       SUM(status = 'READY') AS readyCount, SUM(status = 'EXCEPTION') AS exceptionCount,
       SUM(status = 'EXCLUDED') AS excludedCount,
       SUM(status = 'READY' AND warningCodes IS NOT NULL AND warningCodes <> '') AS warningCount,
       COALESCE(SUM(CASE WHEN status IN ('READY','ISSUED') THEN subtotalPaise END), 0) AS subtotalPaise,
       COALESCE(SUM(CASE WHEN status IN ('READY','ISSUED') THEN taxPaise END), 0) AS taxPaise,
       COALESCE(SUM(CASE WHEN status IN ('READY','ISSUED') THEN roundOffPaise END), 0) AS roundOffPaise,
       COALESCE(SUM(CASE WHEN status IN ('READY','ISSUED') THEN totalPaise END), 0) AS totalPaise
     FROM billing_run_items WHERE billingRunId = ?`,
    { replacements: [runId], type: QueryTypes.SELECT, transaction: t },
  );
  const n = (k: string): number => Number(row?.[k] ?? 0);
  return {
    itemCount: n('itemCount'),
    readyCount: n('readyCount'),
    exceptionCount: n('exceptionCount'),
    excludedCount: n('excludedCount'),
    warningCount: n('warningCount'),
    subtotalPaise: n('subtotalPaise'),
    taxPaise: n('taxPaise'),
    roundOffPaise: n('roundOffPaise'),
    totalPaise: n('totalPaise'),
  };
}

type ShareMap = Map<number, Map<number, { share?: number; exception?: ExceptionCode }>>;

/** BR-11-22 and BR-11-23: the share of every eligible flat in each split rule used by an effective version. */
async function splitSharesFor(a: {
  run: BillingRun;
  candidates: RuleCandidate[];
  data: Map<number, UnitData>;
  months: number;
}): Promise<ShareMap> {
  const out: ShareMap = new Map();
  const ids = [
    ...new Set(
      a.candidates
        .filter(c => c.version.rateType === 'SPLIT_TOTAL' && c.version.billSplitRuleId)
        .map(c => c.version.billSplitRuleId!),
    ),
  ];
  if (!ids.length) return out;
  const rules = await BillSplitRule.findAll({ where: { societyId: a.run.societyId, id: { [Op.in]: ids } } });
  const byHead = new Map<number, RuleCandidate[]>();
  for (const c of a.candidates) byHead.set(c.chargeHeadId, [...(byHead.get(c.chargeHeadId) ?? []), c]);
  for (const rule of rules) {
    const eligible = [...a.data.values()].filter(d => {
      const liableOnStart = d.segments[0]?.from === a.run.periodStart;
      if (!liableOnStart || !scopeMatches(rule.scopeType, rule.scopeValues, d.unit)) return false;
      return [...byHead.values()].some(cs => {
        const w = winningRule(cs, d.unit);
        return w?.version.rateType === 'SPLIT_TOTAL' && w.version.billSplitRuleId === rule.id;
      });
    });
    let total: number;
    if (rule.amountSource === 'FIXED') total = Number(rule.fixedAmountPaise ?? 0) * a.months;
    else {
      const given = a.run.splitInputs?.find(x => x.billSplitRuleId === rule.id);
      if (!given)
        throw new RunComputeError('RUN_SPLIT_INPUT_MISSING', `No amount was entered for "${rule.name}".`);
      total = Number(given.amountPaise);
    }
    const weights: WeightedUnit[] = [];
    const map = new Map<number, { share?: number; exception?: ExceptionCode }>();
    for (const d of eligible) {
      const w = splitWeight(rule.basis, d.unit, rule.weights);
      if ('exception' in w) map.set(d.unit.id, { exception: w.exception });
      else weights.push({ unitId: d.unit.id, weight: w.weight });
    }
    let split: { unitId: number; sharePaise: number }[];
    try {
      split = splitPaise(total, weights);
    } catch {
      throw new RunComputeError(
        'SPLIT_NO_ELIGIBLE_UNITS',
        `No flat is eligible for the split "${rule.name}".`,
      );
    }
    for (const { unitId, sharePaise } of split) map.set(unitId, { share: sharePaise });
    out.set(rule.id!, map);
  }
  return out;
}

/** Job processor body: failures that cannot succeed on retry fail the run at once; others retry up to five attempts. */
const attempts = new Map<string, number>();
export async function runComputeJob(runId: number, version: number, maxAttempts: number): Promise<void> {
  const key = `${runId}:${version}`;
  try {
    await computeRun(runId, version);
    attempts.delete(key);
  } catch (err) {
    if (err instanceof RunComputeError || err instanceof AppError) {
      attempts.delete(key);
      await failRun(runId, err.message);
      return;
    }
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n);
    logger.error({ err, runId, attempt: n }, 'billing compute failed');
    if (n >= maxAttempts) {
      attempts.delete(key);
      await failRun(runId, `Compute failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      return;
    }
    throw err;
  }
}
