import { randomUUID } from 'node:crypto';
import {
  BillSplitRule,
  BillingRule,
  BillingRuleVersion,
  ChargeHead,
  Resident,
  Society,
  Tenancy,
  Unit,
  UnitResident,
  sequelize,
} from '../../src/models';
import { setNow } from '../../src/lib/clock';
import { drainQueues } from '../../src/lib/queue';
import { setRealtimeSink } from '../../src/lib/realtime';
import { systemCtx } from '../../src/types/context';
import { settings } from '../../src/modules/society-setup/society-setup.public';
import { setBillingPorts } from '../../src/modules/billing/billing.ports';
import { registerBillingRuns } from '../../src/modules/billing/billing.runs.jobs';
import type {
  GstTreatment,
  HeadType,
  MeterType,
  MissingReadingPolicy,
  PayerRouting,
  RateType,
  SplitAmountSource,
  SplitBasis,
} from '../../src/modules/billing/billing.constants';
import { events } from './auth';
import { memberOf } from './society-setup';
import { residentSociety, resetResidents, type Client } from './residents';

export type { Client };
export interface ChargeHeadAttrs {
  name: string;
  headType: HeadType;
  payerRouting: PayerRouting;
  gstTreatment: GstTreatment;
  sacCode: string | null;
  prorate: boolean;
  ledgerAccountCode: string;
  fundId: number | null;
  sortOrder: number;
}

export interface RuleVersionSpec {
  rateType: RateType;
  versionNo?: number;
  amountPaise?: number;
  ratePerSqftPaise?: number;
  unitTypeRates?: Record<string, number>;
  meterType?: MeterType;
  slabs?: { uptoMilli: number | null; ratePaise: number }[];
  minimumChargePaise?: number;
  missingReadingPolicy?: MissingReadingPolicy;
  billSplitRuleId?: number;
  percent?: string;
  baseChargeHeadIds?: number[];
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

export interface SplitRuleSpec {
  name?: string;
  basis: SplitBasis;
  amountSource: SplitAmountSource;
  fixedAmountPaise?: number;
  scopeType?: 'ALL_UNITS' | 'BUILDINGS' | 'UNIT_TYPES' | 'UNITS';
  scopeValues?: (number | string)[] | null;
  weights?: Record<string, number>;
}

export const idemH = (): Record<string, string> => ({ 'Idempotency-Key': randomUUID() });

const BILLING_TABLES = [
  'invoice_lines',
  'billing_notes',
  'invoices',
  'billing_run_items',
  'billing_runs',
  'unit_ledger_entries',
  'opening_balances',
  'billing_rule_versions',
  'billing_rules',
  'bill_split_rules',
  'late_fee_policies',
  'charge_heads',
];

/** Fresh state: billing tables emptied, placeholders restored, frozen clock (4 Nov 2026), runs registered. Call from `beforeEach`. */
export async function resetRuns(): Promise<void> {
  await drainQueues();
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of BILLING_TABLES) await sequelize.query(`DELETE FROM ${t}`);
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
  await resetResidents();
  setBillingPorts();
  registerBillingRuns();
  setNow('2026-11-04T04:30:00Z');
  events.length = 0;
  setRealtimeSink({ emit: e => events.push(e), disconnectSession: () => undefined });
}

export const setSetting = (societyId: number, key: string, value: unknown) =>
  sequelize.transaction(t => settings.setMany(systemCtx('t'), societyId, [{ key, value }], t));

/** The standard heads of the worked examples (ids are returned by key). Ledger codes follow spec 5.14. */
export async function makeHeads(societyId: number): Promise<Record<string, ChargeHead>> {
  const mk = async (key: string, a: Partial<ChargeHeadAttrs> & { headType: ChargeHeadAttrs['headType'] }) =>
    ChargeHead.create({
      societyId,
      key,
      name: a.name ?? key,
      description: null,
      headType: a.headType,
      payerRouting: a.payerRouting ?? 'BILL_TO',
      gstTreatment: a.gstTreatment ?? 'THRESHOLD',
      sacCode: a.sacCode === undefined ? '995411' : a.sacCode,
      prorate: a.prorate ?? true,
      interestBearing: true,
      ledgerAccountCode: a.ledgerAccountCode ?? '4190',
      fundId: a.fundId ?? null,
      isSystem: false,
      status: 'ACTIVE',
      sortOrder: a.sortOrder ?? 100,
      createdBy: null,
      updatedBy: null,
      version: 1,
    } as never);
  return {
    MAINTENANCE: await mk('MAINTENANCE', {
      name: 'Maintenance',
      headType: 'MAINTENANCE',
      ledgerAccountCode: '4100',
      sortOrder: 10,
    }),
    SINKING_FUND: await mk('SINKING_FUND', {
      name: 'Sinking fund',
      headType: 'SINKING_FUND',
      payerRouting: 'OWNER',
      ledgerAccountCode: '2410',
      sortOrder: 20,
      fundId: 1001,
    }),
    REPAIR_FUND: await mk('REPAIR_FUND', {
      name: 'Repair fund',
      headType: 'REPAIR_FUND',
      payerRouting: 'OWNER',
      ledgerAccountCode: '2420',
      sortOrder: 30,
      fundId: 1002,
    }),
    PARKING: await mk('PARKING', {
      name: 'Parking',
      headType: 'PARKING',
      ledgerAccountCode: '4120',
      sortOrder: 40,
    }),
    WATER: await mk('WATER', {
      name: 'Water',
      headType: 'WATER',
      gstTreatment: 'NONE',
      sacCode: null,
      ledgerAccountCode: '4130',
      sortOrder: 50,
    }),
    NOC: await mk('NOC', {
      name: 'Non-occupancy charges',
      headType: 'NON_OCCUPANCY',
      payerRouting: 'OWNER',
      ledgerAccountCode: '4110',
      sortOrder: 60,
    }),
  };
}

/** A rule with one approved version effective from `effectiveFrom` (default 2026-04-01). */
export async function makeRule(
  societyId: number,
  head: ChargeHead,
  v: RuleVersionSpec,
  scope: {
    scopeType?: 'ALL_UNITS' | 'BUILDINGS' | 'UNIT_TYPES' | 'UNITS';
    scopeValues?: (number | string)[] | null;
    name?: string;
  } = {},
) {
  const rule = await BillingRule.create({
    societyId,
    chargeHeadId: head.id!,
    name: scope.name ?? `${head.key} rule ${randomUUID().slice(0, 6)}`,
    scopeType: scope.scopeType ?? 'ALL_UNITS',
    scopeValues: scope.scopeValues ?? null,
    status: 'ACTIVE',
    sortOrder: 100,
    createdBy: null,
    updatedBy: null,
    version: 1,
  } as never);
  const version = await BillingRuleVersion.create({
    societyId,
    billingRuleId: rule.id!,
    versionNo: v.versionNo ?? 1,
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
    effectiveFrom: v.effectiveFrom ?? '2026-04-01',
    effectiveTo: v.effectiveTo ?? null,
    status: 'APPROVED',
    reason: 'Test fixture',
    resolutionRef: null,
    approvalRequestId: null,
    approvedBy: null,
    approvedAt: null,
    rejectedReason: null,
    createdBy: null,
    updatedBy: null,
  } as never);
  return { rule, version };
}

export async function makeSplitRule(societyId: number, s: SplitRuleSpec) {
  return BillSplitRule.create({
    societyId,
    name: s.name ?? `Split ${randomUUID().slice(0, 6)}`,
    description: null,
    basis: s.basis,
    amountSource: s.amountSource,
    fixedAmountPaise: s.fixedAmountPaise ?? null,
    scopeType: s.scopeType ?? 'ALL_UNITS',
    scopeValues: s.scopeValues ?? null,
    weights: s.weights ?? null,
    status: 'ACTIVE',
    createdBy: null,
    updatedBy: null,
    version: 1,
  } as never);
}

/** Maintenance 3.20/sq ft, sinking 600, repair 250, parking 500 for the listed units, water 350: the rates of example A. */
export async function standardRules(
  societyId: number,
  heads: Record<string, ChargeHead>,
  parkingUnitIds: number[] = [],
) {
  await makeRule(societyId, heads.MAINTENANCE!, { rateType: 'PER_SQFT', ratePerSqftPaise: 320 });
  await makeRule(societyId, heads.SINKING_FUND!, { rateType: 'FLAT_PER_UNIT', amountPaise: 60_000 });
  await makeRule(societyId, heads.REPAIR_FUND!, { rateType: 'FLAT_PER_UNIT', amountPaise: 25_000 });
  if (parkingUnitIds.length)
    await makeRule(
      societyId,
      heads.PARKING!,
      { rateType: 'FLAT_PER_UNIT', amountPaise: 50_000 },
      { scopeType: 'UNITS', scopeValues: parkingUnitIds },
    );
  await makeRule(societyId, heads.WATER!, { rateType: 'FLAT_PER_UNIT', amountPaise: 35_000 });
}

let seq = 0;
/** A resident row (no login) of the society. */
export async function makeResident(societyId: number, name: string): Promise<Resident> {
  const mobile = `96${String(20_000_000 + ++seq).padStart(8, '0')}`;
  return Resident.create({
    societyId,
    userId: null,
    memberId: null,
    name,
    mobile,
    alternateMobile: null,
    email: null,
    dateOfBirth: null,
    gender: null,
    photoFileId: null,
    preferredLanguage: 'en-IN',
    isNri: false,
    overseasPhone: null,
    localRepresentativeResidentId: null,
    status: 'ACTIVE',
    source: 'ADMIN',
    directoryVisible: true,
    showMobileInDirectory: false,
    showEmailInDirectory: false,
    showPhotoInDirectory: false,
    adminNote: null,
    anonymisedAt: null,
    version: 1,
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
  } as never);
}

export async function linkResident(
  societyId: number,
  unitId: number,
  residentId: number,
  o: {
    relation?: 'OWNER' | 'CO_OWNER' | 'TENANT';
    from?: string;
    to?: string | null;
    primary?: boolean;
    tenancyId?: number | null;
  } = {},
) {
  const relation = o.relation ?? 'OWNER';
  return UnitResident.create({
    societyId,
    unitId,
    residentId,
    relation,
    familyRelation: null,
    sharePercent: null,
    isPrimary: o.primary ?? relation === 'OWNER',
    isResiding: relation !== 'OWNER',
    canLogin: false,
    tenancyId: o.tenancyId ?? null,
    ownershipTransferId: null,
    fromDate: o.from ?? '2019-04-01',
    toDate: o.to ?? null,
    endReason: o.to ? 'OTHER' : null,
    endNote: null,
    source: 'ADMIN',
    version: 1,
    createdBy: null,
    updatedBy: null,
  } as never);
}

/** An owner (new resident) linked to the unit. */
export async function addOwner(
  societyId: number,
  unitId: number,
  name = 'Owner',
  o: { from?: string; to?: string | null; relation?: 'OWNER' | 'CO_OWNER'; primary?: boolean } = {},
) {
  const resident = await makeResident(societyId, name);
  const link = await linkResident(societyId, unitId, resident.id!, o);
  return { resident, link };
}

/** An ACTIVE tenancy (payer as given) with its TENANT link from `from`. */
export async function addTenant(
  societyId: number,
  unitId: number,
  landlordResidentId: number,
  o: {
    name?: string;
    from?: string;
    to?: string | null;
    payer?: 'OWNER' | 'TENANT';
    status?: 'ACTIVE' | 'ENDED';
    endedOn?: string | null;
  } = {},
) {
  const tenant = await makeResident(societyId, o.name ?? 'Tenant');
  const tenancy = await Tenancy.create({
    societyId,
    unitId,
    tenantResidentId: tenant.id!,
    landlordResidentId,
    status: o.status ?? 'ACTIVE',
    agreementType: 'LEAVE_AND_LICENCE',
    agreementStart: o.from ?? '2026-11-01',
    agreementEnd: '2027-09-30',
    agreementRegistrationNo: null,
    monthlyRentPaise: 2_500_000,
    securityDepositPaise: 5_000_000,
    maintenancePayer: o.payer ?? 'TENANT',
    occupantCount: 2,
    householdJson: null,
    inviteTenant: false,
    policeVerificationStatus: 'NOT_REQUIRED',
    source: 'ADMIN',
    moveInDate: o.from ?? '2026-11-01',
    endedOn: o.endedOn ?? null,
    renewalCount: 0,
    version: 1,
  } as never);
  const link = await linkResident(societyId, unitId, tenant.id!, {
    relation: 'TENANT',
    from: o.from ?? '2026-11-01',
    to: o.to ?? null,
    primary: false,
    tenancyId: tenancy.id!,
  });
  return { tenant, tenancy, link };
}

export interface RunSociety {
  society: Society;
  c: Client;
  user: Awaited<ReturnType<typeof residentSociety>>['user'];
  buildingId: number;
  heads: Record<string, ChargeHead>;
  /** A flat of the society by number: `flat('A-101')`. */
  units: { id: number; label: string }[];
  treasurer: Awaited<ReturnType<typeof memberOf>>;
  secretary: Awaited<ReturnType<typeof memberOf>>;
}

/**
 * A PREMIUM society with its chairman (all finance.billing keys), a treasurer and a secretary (views and approves only), the
 * standard heads, and `flats` flats A-101... of 1,150 sq ft each, billable, with the area set.
 */
export async function runSociety(
  o: { flats?: number; area?: string | null; plan?: string } = {},
): Promise<RunSociety> {
  const s = await residentSociety({ flats: o.flats ?? 2, ...(o.plan ? { plan: o.plan as never } : {}) });
  await Unit.update(
    {
      areaSqft: o.area === undefined ? '1150.000' : o.area,
      carpetAreaSqft: o.area === undefined ? '1150.000' : o.area,
    } as never,
    { where: { societyId: s.society.id! } },
  );
  const heads = await makeHeads(s.society.id!);
  return {
    society: s.society,
    c: s.c,
    user: s.user,
    buildingId: s.buildingId,
    heads,
    units: s.units,
    treasurer: await memberOf(s.society, 'treasurer'),
    secretary: await memberOf(s.society, 'secretary'),
  };
}

/** Creates a regular run through the API and waits for the compute job. Returns the run id. */
export async function createAndCompute(
  c: Client,
  body: Record<string, unknown> = {},
): Promise<{ id: number; version: number; status: number; body: any }> {
  const r = await c(
    'post',
    '/billing/runs',
    { runType: 'REGULAR', periodStart: '2026-11-01', ...body },
    { headers: idemH() },
  );
  await drainQueues();
  return { id: r.body.data?.id, version: r.body.data?.version, status: r.status, body: r.body };
}
