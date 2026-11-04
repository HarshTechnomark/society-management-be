import type { Transaction } from 'sequelize';
import { BillingRun, Society } from '../../models';
import { now } from '../../lib/clock';
import { emitToRoom } from '../../lib/realtime';
import { NotFoundError } from '../../utils/errors';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { settings } from '../society-setup/society-setup.public';
import { FEATURES, REALTIME, type BillingCycle } from './billing.constants';
import type { CalcSettings } from './billing.calc.unit';
import { monthsOf, periodDaysOf } from './billing.calc.period';

/** Shared helpers of the run service, the compute engine and the issue service (sub-module 11.3). */

/** Society-local calendar date. */
export async function societyToday(societyId: number): Promise<string> {
  const s = await Society.findByPk(societyId, { attributes: ['timezone'] });
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: s?.timezone ?? 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now());
  } catch {
    return now().toISOString().slice(0, 10);
  }
}

/** The `billing.*` keys module 11 reads (section 5.13). */
const KEYS = [
  'billing.cycle',
  'billing.billingDay',
  'billing.dueDays',
  'billing.shiftDueDateOnHoliday',
  'billing.areaBasis',
  'billing.invoicePrefix',
  'billing.roundToRupee',
  'billing.applyGst',
  'billing.gstExemptLimitPerUnitPaise',
];

export interface BillingSettings {
  cycle: BillingCycle;
  billingDay: number;
  dueDays: number;
  shiftDueDateOnHoliday: boolean;
  areaBasis: string;
  invoicePrefix: string;
  roundToRupee: boolean;
  applyGst: boolean;
  gstExemptLimitPaise: number;
}

export async function loadBillingSettings(societyId: number): Promise<BillingSettings> {
  const v = await settings.getMany(societyId, KEYS);
  return {
    cycle: v['billing.cycle'] as BillingCycle,
    billingDay: Number(v['billing.billingDay']),
    dueDays: Number(v['billing.dueDays']),
    shiftDueDateOnHoliday: Boolean(v['billing.shiftDueDateOnHoliday']),
    areaBasis: String(v['billing.areaBasis']),
    invoicePrefix: String(v['billing.invoicePrefix']),
    roundToRupee: Boolean(v['billing.roundToRupee']),
    applyGst: Boolean(v['billing.applyGst']),
    gstExemptLimitPaise: Number(v['billing.gstExemptLimitPerUnitPaise']),
  };
}

export interface BillingFeatures {
  prorated: boolean;
  ownerTenantSplit: boolean;
  explain: boolean;
  billChangeDiff: boolean;
}

/** Section 2 "feature effects inside the service". */
export async function loadBillingFeatures(societyId: number): Promise<BillingFeatures> {
  const [prorated, ownerTenantSplit, explain, billChangeDiff] = await Promise.all([
    isFeatureOn(societyId, FEATURES.prorated),
    isFeatureOn(societyId, FEATURES.ownerTenantSplit),
    isFeatureOn(societyId, FEATURES.explainMyBill),
    isFeatureOn(societyId, FEATURES.billChangeDiff),
  ]);
  return { prorated, ownerTenantSplit, explain, billChangeDiff };
}

export function calcSettingsFor(
  s: BillingSettings,
  f: BillingFeatures,
  cycle: BillingCycle,
  periodStart: string,
  periodEnd: string,
): CalcSettings {
  return {
    cycle,
    months: monthsOf(cycle),
    periodStart,
    periodEnd,
    periodDays: periodDaysOf(cycle, periodStart),
    applyGst: s.applyGst,
    gstExemptLimitPaise: s.gstExemptLimitPaise,
    roundToRupee: s.roundToRupee,
    prorated: f.prorated,
    ownerTenantSplit: f.ownerTenantSplit,
    areaBasis: s.areaBasis,
  };
}

/** `FOR UPDATE` read of a run of the society; `404 RUN_NOT_FOUND` otherwise (another society's id included). */
export async function lockRun(societyId: number, id: number, t: Transaction): Promise<BillingRun> {
  const run = await BillingRun.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!run) throw new NotFoundError('RUN_NOT_FOUND', 'Billing run not found');
  return run;
}

/** `billing.run.updated` to `society:<id>:finance` after commit (section 9.4). */
export function emitRunUpdated(
  run: Pick<BillingRun, 'id' | 'societyId' | 'status' | 'itemCount' | 'issuedCount'>,
  t?: Transaction,
): void {
  const send = () =>
    emitToRoom(`society:${run.societyId}:finance`, REALTIME.runUpdated, {
      runId: run.id,
      status: run.status,
      itemCount: run.itemCount,
      issuedCount: run.issuedCount,
    });
  if (t) t.afterCommit(send);
  else send();
}

/** Progress of a compute that is running in this process (`processed` of `total` flats). */
export const computeProgress = new Map<number, { processed: number; total: number }>();

export const MAX_COMPUTE_ATTEMPTS = 5;

export class RunComputeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
