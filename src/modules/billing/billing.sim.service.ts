import { Op } from 'sequelize';
import { BillSplitRule, BillingRule, BillingRuleVersion, ChargeHead } from '../../models';
import { rate4, roundHalfUpBig } from '../../lib/money';
import type { Ctx } from '../../types/context';
import { NotFoundError, UnprocessableError, ValidationError } from '../../utils/errors';
import { entitlements } from '../subscriptions/subscriptions.public';
import { units as unitsApi } from '../society-setup/society-setup.public';
import { FEATURES, type ExceptionCode } from './billing.constants';
import { isPeriodStart, monthsOf, periodEndOf } from './billing.calc.period';
import { rateOf, type RateVersion } from './billing.calc.rates';
import { scopeMatches, winningRule, type RuleCandidate } from './billing.calc.rules';
import { requireMeterSource } from './billing.ports';
import { loadBillingSettings } from './billing.runs.shared';
import { splitPaise, splitWeight, type WeightedUnit } from './billing.split';
import type { SimulateInput } from './billing.sim.validation';

/**
 * `POST /billing/rules/simulate` (section 8.2): the calculator on a draft version for up to 20 flats. Nothing is stored. The
 * amount is the full-period amount before proration (the rate is stated per month and multiplied by the months of the cycle).
 */
export interface SimItem {
  unitId: number;
  unitLabel: string;
  amountPaise: number;
  computation: Record<string, unknown> | null;
  exceptionCode: ExceptionCode | 'RUN_SPLIT_INPUT_MISSING' | null;
}

export async function simulate(ctx: Ctx, input: SimulateInput): Promise<{ items: SimItem[] }> {
  const societyId = ctx.society!.id;
  const head = await ChargeHead.findOne({ where: { id: input.chargeHeadId, societyId } });
  if (!head) throw new NotFoundError('CHARGE_HEAD_NOT_FOUND', 'Charge head not found');
  const v = input.version;
  if (v.rateType === 'METERED') await entitlements.assertFeature(ctx, FEATURES.meteredWater);
  const settings = await loadBillingSettings(societyId);
  if (!isPeriodStart(settings.cycle, input.periodStart))
    throw new UnprocessableError(
      'RUN_PERIOD_INVALID',
      'The period must start on a period start of the billing cycle',
    );
  const months = monthsOf(settings.cycle);
  const periodEnd = periodEndOf(settings.cycle, input.periodStart);

  const wanted = [...new Set(input.unitIds)];
  const units = await unitsApi.listActive(societyId, { unitIds: wanted });
  if (units.length !== wanted.length)
    throw new ValidationError([
      { field: 'unitIds', message: 'Every flat must be an active flat of the society' },
    ]);
  const byId = new Map(units.map(u => [u.id, u]));

  const version: RateVersion = {
    id: 0,
    versionNo: 0,
    rateType: v.rateType,
    amountPaise: v.amountPaise ?? null,
    ratePerSqftPaise: v.ratePerSqftPaise ?? null,
    unitTypeRates: v.unitTypeRates ?? null,
    meterType: v.meterType ?? null,
    slabs: v.slabs ?? null,
    minimumChargePaise: v.minimumChargePaise ?? null,
    missingReadingPolicy: v.missingReadingPolicy ?? null,
    billSplitRuleId: v.billSplitRuleId ?? null,
    percent: v.percent ?? null,
    baseChargeHeadIds: v.baseChargeHeadIds ?? null,
  };

  let meters: Map<number, { quantityMilli: bigint; readingIds: number[]; isEstimated: boolean }> | undefined;
  if (v.rateType === 'METERED' && v.meterType)
    meters = await requireMeterSource(v.meterType).consumptionForPeriod(
      societyId,
      input.periodStart,
      periodEnd,
    );

  // SPLIT_TOTAL: shares among every active billable flat of the split rule's scope (fixed totals only)
  const shares = new Map<number, number>();
  const splitErr = new Map<number, ExceptionCode>();
  let splitInputMissing = false;
  if (v.rateType === 'SPLIT_TOTAL') {
    const rule = await BillSplitRule.findOne({ where: { id: v.billSplitRuleId, societyId } });
    if (!rule) throw new NotFoundError('SPLIT_RULE_NOT_FOUND', 'Split rule not found');
    if (rule.amountSource === 'RUN_INPUT') splitInputMissing = true;
    else {
      const all = (await unitsApi.listActive(societyId, { isBillable: true })).filter(u =>
        scopeMatches(rule.scopeType, rule.scopeValues, u),
      );
      const weights: WeightedUnit[] = [];
      for (const u of all) {
        const w = splitWeight(rule.basis, u, rule.weights);
        if ('exception' in w) splitErr.set(u.id, w.exception);
        else weights.push({ unitId: u.id, weight: w.weight });
      }
      try {
        for (const s of splitPaise(Number(rule.fixedAmountPaise ?? 0) * months, weights))
          shares.set(s.unitId, s.sharePaise);
      } catch {
        // no weight at all: every flat gets no share
      }
    }
  }

  // PERCENT_OF_HEADS: the base heads' effective rules on the period start
  let baseCandidates: RuleCandidate[] = [];
  if (v.rateType === 'PERCENT_OF_HEADS') {
    const rules = await BillingRule.findAll({
      where: { societyId, status: 'ACTIVE', chargeHeadId: { [Op.in]: v.baseChargeHeadIds ?? [] } },
    });
    const versions = await BillingRuleVersion.findAll({
      where: {
        societyId,
        status: 'APPROVED',
        billingRuleId: { [Op.in]: rules.map(r => r.id!) },
        effectiveFrom: { [Op.lte]: input.periodStart },
        [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: input.periodStart } }],
      },
      order: [['effectiveFrom', 'DESC']],
    });
    baseCandidates = rules.flatMap(r => {
      const bv = versions.find(x => x.billingRuleId === r.id);
      return bv
        ? [
            {
              ruleId: r.id!,
              chargeHeadId: r.chargeHeadId,
              scopeType: r.scopeType,
              scopeValues: r.scopeValues,
              version: {
                id: bv.id!,
                versionNo: bv.versionNo,
                rateType: bv.rateType,
                amountPaise: bv.amountPaise === null ? null : Number(bv.amountPaise),
                ratePerSqftPaise: bv.ratePerSqftPaise === null ? null : Number(bv.ratePerSqftPaise),
                unitTypeRates: bv.unitTypeRates,
                meterType: bv.meterType,
                slabs: bv.slabs,
                minimumChargePaise: bv.minimumChargePaise === null ? null : Number(bv.minimumChargePaise),
                missingReadingPolicy: bv.missingReadingPolicy,
                billSplitRuleId: bv.billSplitRuleId,
                percent: bv.percent,
                baseChargeHeadIds: bv.baseChargeHeadIds,
              },
            } satisfies RuleCandidate,
          ]
        : [];
    });
  }

  const items: SimItem[] = [];
  for (const id of input.unitIds) {
    const u = byId.get(id)!;
    const base = { unitId: u.id, unitLabel: u.label };
    if (v.rateType === 'SPLIT_TOTAL' && splitInputMissing) {
      items.push({ ...base, amountPaise: 0, computation: null, exceptionCode: 'RUN_SPLIT_INPUT_MISSING' });
      continue;
    }
    if (v.rateType === 'PERCENT_OF_HEADS') {
      let basePaise = 0n;
      for (const headId of new Set(v.baseChargeHeadIds ?? [])) {
        const win = winningRule(
          baseCandidates.filter(c => c.chargeHeadId === headId),
          u,
        );
        if (!win) continue;
        const r = rateOf(win.version, { unit: u, months });
        if (r.kind === 'amount') basePaise += roundHalfUpBig(r.num, r.den);
      }
      const amount = Number(roundHalfUpBig(basePaise * rate4(v.percent!), 1_000_000n));
      items.push({
        ...base,
        amountPaise: amount,
        exceptionCode: null,
        computation: {
          method: 'PERCENT_OF_HEADS',
          formula: 'roundHalfUp(base × rate4(percent), 1000000)',
          inputs: { basePaise: Number(basePaise), percent: v.percent },
        },
      });
      continue;
    }
    const r = rateOf(version, {
      unit: u,
      months,
      splitShare: shares.get(u.id) ?? 0,
      splitException: splitErr.get(u.id),
      meter: meters?.get(u.id),
    });
    if (r.kind === 'exception')
      items.push({ ...base, amountPaise: 0, computation: null, exceptionCode: r.code });
    else if (r.kind === 'none')
      items.push({ ...base, amountPaise: 0, computation: null, exceptionCode: null });
    else
      items.push({
        ...base,
        amountPaise: Number(roundHalfUpBig(r.num, r.den)),
        computation: { ...r.computation },
        exceptionCode: null,
      });
  }
  return { items };
}
