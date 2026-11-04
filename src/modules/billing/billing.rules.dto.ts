import type { BillingRule, BillingRuleVersion, ChargeHead } from '../../models';

/** Response shapes of section 8.2 (a superset of the spec's example: every column of 7.3 is returned). */
export interface RuleVersionDto {
  id: number;
  billingRuleId: number;
  versionNo: number;
  rateType: string;
  amountPaise: number | null;
  ratePerSqftPaise: number | null;
  unitTypeRates: Record<string, number> | null;
  meterType: string | null;
  slabs: { uptoMilli: number | null; ratePaise: number }[] | null;
  minimumChargePaise: number | null;
  missingReadingPolicy: string | null;
  billSplitRuleId: number | null;
  percent: string | null;
  baseChargeHeadIds: number[] | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: string;
  reason: string;
  resolutionRef: string | null;
  approvalRequestId: number | null;
  approvedBy: number | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  createdBy: number | null;
  createdAt: string;
}
export interface RuleDto {
  id: number;
  societyId: number;
  chargeHeadId: number;
  chargeHead: { id: number; key: string; name: string; headType: string; status: string } | null;
  name: string;
  scopeType: string;
  scopeValues: (number | string)[] | null;
  status: string;
  sortOrder: number;
  createdBy: number | null;
  updatedBy: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  currentVersion: RuleVersionDto | null;
  nextVersion: RuleVersionDto | null;
  pendingVersion: RuleVersionDto | null;
  /** Only on `GET /billing/rules/:id` and the create and patch responses: all versions, newest first. */
  versions?: RuleVersionDto[];
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const versionDto = (v: BillingRuleVersion): RuleVersionDto => ({
  id: Number(v.id),
  billingRuleId: Number(v.billingRuleId),
  versionNo: Number(v.versionNo),
  rateType: v.rateType,
  amountPaise: num(v.amountPaise),
  ratePerSqftPaise: num(v.ratePerSqftPaise),
  unitTypeRates: v.unitTypeRates,
  meterType: v.meterType,
  slabs: v.slabs,
  minimumChargePaise: num(v.minimumChargePaise),
  missingReadingPolicy: v.missingReadingPolicy,
  billSplitRuleId: num(v.billSplitRuleId),
  percent: v.percent,
  baseChargeHeadIds: v.baseChargeHeadIds,
  effectiveFrom: v.effectiveFrom,
  effectiveTo: v.effectiveTo,
  status: v.status,
  reason: v.reason,
  resolutionRef: v.resolutionRef,
  approvalRequestId: num(v.approvalRequestId),
  approvedBy: num(v.approvedBy),
  approvedAt: v.approvedAt ? v.approvedAt.toISOString() : null,
  rejectedReason: v.rejectedReason,
  createdBy: num(v.createdBy),
  createdAt: v.createdAt!.toISOString(),
});

/** The version of a rule that is effective on `date` (approved, `effectiveFrom <= date`, `effectiveTo` NULL or `>= date`). */
export const effectiveOn = (
  versions: readonly BillingRuleVersion[],
  date: string,
): BillingRuleVersion | null =>
  versions
    .filter(
      v =>
        v.status === 'APPROVED' &&
        v.effectiveFrom <= date &&
        (v.effectiveTo === null || v.effectiveTo >= date),
    )
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null;

export function ruleDto(
  r: BillingRule,
  head: ChargeHead | null | undefined,
  versions: readonly BillingRuleVersion[],
  today: string,
  withVersions: boolean,
): RuleDto {
  const next = versions
    .filter(v => v.status === 'APPROVED' && v.effectiveFrom > today)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))[0];
  const pending = versions.find(v => v.status === 'PENDING_APPROVAL');
  const cur = effectiveOn(versions, today);
  const dto: RuleDto = {
    id: Number(r.id),
    societyId: Number(r.societyId),
    chargeHeadId: Number(r.chargeHeadId),
    chargeHead: head
      ? { id: Number(head.id), key: head.key, name: head.name, headType: head.headType, status: head.status }
      : null,
    name: r.name,
    scopeType: r.scopeType,
    scopeValues: r.scopeValues,
    status: r.status,
    sortOrder: Number(r.sortOrder),
    createdBy: num(r.createdBy),
    updatedBy: num(r.updatedBy),
    version: Number(r.version),
    createdAt: r.createdAt!.toISOString(),
    updatedAt: r.updatedAt!.toISOString(),
    currentVersion: cur ? versionDto(cur) : null,
    nextVersion: next ? versionDto(next) : null,
    pendingVersion: pending ? versionDto(pending) : null,
  };
  if (withVersions)
    dto.versions = [...versions].sort((a, b) => Number(b.versionNo) - Number(a.versionNo)).map(versionDto);
  return dto;
}
