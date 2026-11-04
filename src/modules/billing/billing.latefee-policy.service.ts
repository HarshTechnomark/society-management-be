import { Op, type Transaction } from 'sequelize';
import { LateFeePolicy, Society, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { formatRupees } from '../../lib/money';
import type { Ctx } from '../../types/context';
import { APPROVAL_TYPES, AUDIT, SETUP_MODE_REASON } from './billing.constants';
import { billingPorts, type ApprovalTypeHooks } from './billing.ports';
import { isSetupMode } from './billing.setup.mode';
import { actorId, conflict, firstOfMonth, invalidState, societyToday } from './billing.setup.shared';
import type { PolicyCreateInput, PolicyListQuery } from './billing.latefee-policy.validation';

/** Late fee policies (section 5.10, 8.4): configuration and approval. The monthly job that charges interest is 11.5. */
const ENTITY = 'late_fee_policy';

export interface LateFeePolicyDto {
  id: number;
  societyId: number;
  policyType: string;
  interestRatePct: string | null;
  interestFrom: string | null;
  flatFeePaise: number | null;
  graceDays: number;
  minChargePaise: number;
  effectiveFrom: string;
  status: string;
  reason: string;
  resolutionRef: string | null;
  approvalRequestId: number | null;
  approvedBy: number | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  createdBy: number | null;
  updatedBy: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const policyDto = (p: LateFeePolicy): LateFeePolicyDto => ({
  id: Number(p.id),
  societyId: Number(p.societyId),
  policyType: p.policyType,
  interestRatePct: p.interestRatePct,
  interestFrom: p.interestFrom,
  flatFeePaise: num(p.flatFeePaise),
  graceDays: Number(p.graceDays),
  minChargePaise: Number(p.minChargePaise),
  effectiveFrom: p.effectiveFrom,
  status: p.status,
  reason: p.reason,
  resolutionRef: p.resolutionRef,
  approvalRequestId: num(p.approvalRequestId),
  approvedBy: num(p.approvedBy),
  approvedAt: p.approvedAt ? p.approvedAt.toISOString() : null,
  rejectedReason: p.rejectedReason,
  createdBy: num(p.createdBy),
  updatedBy: num(p.updatedBy),
  version: Number(p.version),
  createdAt: p.createdAt!.toISOString(),
  updatedAt: p.updatedAt!.toISOString(),
});
const auditView = (p: LateFeePolicy) => ({
  policyType: p.policyType,
  interestRatePct: p.interestRatePct,
  interestFrom: p.interestFrom,
  flatFeePaise: num(p.flatFeePaise),
  graceDays: Number(p.graceDays),
  minChargePaise: Number(p.minChargePaise),
  effectiveFrom: p.effectiveFrom,
  status: p.status,
});

export const describePolicy = (
  p: Pick<LateFeePolicy, 'policyType' | 'interestRatePct' | 'flatFeePaise' | 'graceDays'>,
): string =>
  p.policyType === 'NONE'
    ? 'No late fee'
    : p.policyType === 'FLAT'
      ? `Flat fee ${formatRupees(Number(p.flatFeePaise))}, ${p.graceDays} grace days`
      : `${p.interestRatePct}% p.a. simple interest, ${p.graceDays} grace days`;

/** `GET /billing/late-fee-policies`: newest first. */
export async function listPolicies(societyId: number, q: PolicyListQuery) {
  const where: Record<string, unknown> = { societyId };
  if (q.status) where.status = q.status;
  const total = await LateFeePolicy.count({ where });
  const rows = await LateFeePolicy.findAll({
    where,
    order: [
      ['effectiveFrom', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: rows.map(policyDto), pagination: pageMeta(q.page, q.limit, total) };
}

/** BR-11-51: the policy used for a window is the ACTIVE one effective on the window's last day (greatest `effectiveFrom` up to it). */
export async function policyFor(
  societyId: number,
  date: string,
  t?: Transaction,
): Promise<LateFeePolicy | null> {
  return LateFeePolicy.findOne({
    where: { societyId, status: 'ACTIVE', effectiveFrom: { [Op.lte]: date } },
    order: [
      ['effectiveFrom', 'DESC'],
      ['id', 'DESC'],
    ],
    transaction: t,
  });
}

/** Inside the caller's transaction: serialise on the society row, then check the pending and date-taken rules (7.10). */
async function lockAndCheck(
  societyId: number,
  effectiveFrom: string,
  t: Transaction,
  ignoreId?: number,
): Promise<void> {
  await Society.findByPk(societyId, { attributes: ['id'], transaction: t, lock: t.LOCK.UPDATE });
  const idNot = ignoreId ? { id: { [Op.ne]: ignoreId } } : {};
  if (
    await LateFeePolicy.findOne({
      where: { societyId, status: 'PENDING_APPROVAL', ...idNot },
      attributes: ['id'],
      transaction: t,
    })
  )
    throw conflict('LATE_FEE_POLICY_PENDING', 'Another late fee policy is waiting for approval');
  if (
    await LateFeePolicy.findOne({
      where: { societyId, status: 'ACTIVE', effectiveFrom, ...idNot },
      attributes: ['id'],
      transaction: t,
    })
  )
    throw conflict('LATE_FEE_DATE_TAKEN', 'A late fee policy already starts on this date', 'effectiveFrom');
}

/** `POST /billing/late-fee-policies`. */
export async function createPolicy(
  ctx: Ctx,
  societyId: number,
  input: PolicyCreateInput,
): Promise<LateFeePolicyDto> {
  const today = await societyToday(societyId);
  if (!input.effectiveFrom.endsWith('-01'))
    throw new ValidationError([{ field: 'effectiveFrom', message: 'Use the first day of a month' }]);
  if (input.effectiveFrom < firstOfMonth(today))
    throw new ValidationError([
      { field: 'effectiveFrom', message: 'Not before the first day of the current month' },
    ]);
  return sequelize.transaction(async t => {
    await lockAndCheck(societyId, input.effectiveFrom, t);
    const setup = await isSetupMode(societyId, t);
    const row = await insertPolicy(ctx, societyId, input, setup, t);
    return policyDto(row);
  });
}

/** Insert (and, in setup mode, activate) a policy; shared with the first-rule default of setup mode. */
export async function insertPolicy(
  ctx: Ctx,
  societyId: number,
  input: PolicyCreateInput,
  setup: boolean,
  t: Transaction,
): Promise<LateFeePolicy> {
  const row = await LateFeePolicy.create(
    {
      societyId,
      policyType: input.policyType,
      interestRatePct: input.interestRatePct ?? null,
      interestFrom: input.interestFrom ?? null,
      flatFeePaise: input.flatFeePaise ?? null,
      graceDays: input.graceDays,
      minChargePaise: input.minChargePaise ?? 100,
      effectiveFrom: input.effectiveFrom,
      status: setup ? 'ACTIVE' : 'PENDING_APPROVAL',
      reason: input.reason,
      resolutionRef: input.resolutionRef ?? null,
      approvalRequestId: null,
      approvedBy: setup ? actorId(ctx) : null,
      approvedAt: setup ? now() : null,
      rejectedReason: null,
      createdBy: actorId(ctx),
      updatedBy: actorId(ctx),
      version: 1,
    },
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: AUDIT.lateFeePolicyCreated,
      entityType: ENTITY,
      entityId: row.id!,
      entityLabel: describePolicy(row),
      societyId,
      after: auditView(row),
      reason: input.reason,
    },
    t,
  );
  if (setup) {
    await audit(
      ctx,
      {
        action: AUDIT.lateFeePolicyApproved,
        entityType: ENTITY,
        entityId: row.id!,
        entityLabel: describePolicy(row),
        societyId,
        after: auditView(row),
        reason: SETUP_MODE_REASON,
      },
      t,
    );
    return row;
  }
  const req = await billingPorts().approvals.request(
    ctx,
    {
      type: APPROVAL_TYPES.lateFeePolicyChange,
      entityType: ENTITY,
      entityId: Number(row.id),
      title: `Late fee policy: ${describePolicy(row)} from ${row.effectiveFrom}`,
      payload: {
        policyType: row.policyType,
        interestRatePct: row.interestRatePct,
        flatFeePaise: num(row.flatFeePaise),
        graceDays: Number(row.graceDays),
        effectiveFrom: row.effectiveFrom,
      },
    },
    t,
  );
  row.approvalRequestId = req.id;
  await row.save({ transaction: t });
  if (req.status === 'APPROVED') {
    await approvePolicy(ctx, societyId, Number(row.id), t);
    await row.reload({ transaction: t });
  }
  return row;
}

/** Module 14 `onApproved` of `LATE_FEE_POLICY_CHANGE`: the policy becomes ACTIVE (the earlier ACTIVE one works until its date). */
export async function approvePolicy(
  ctx: Ctx,
  societyId: number,
  id: number,
  t: Transaction,
): Promise<LateFeePolicy> {
  const p = await LateFeePolicy.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!p) throw new NotFoundError('LATE_FEE_POLICY_NOT_FOUND', 'Late fee policy not found');
  if (p.status !== 'PENDING_APPROVAL') throw invalidState('This late fee policy is not waiting for approval');
  if (
    await LateFeePolicy.findOne({
      where: { societyId, status: 'ACTIVE', effectiveFrom: p.effectiveFrom },
      attributes: ['id'],
      transaction: t,
    })
  )
    throw conflict('LATE_FEE_DATE_TAKEN', 'A late fee policy already starts on this date', 'effectiveFrom');
  p.status = 'ACTIVE';
  p.approvedBy = actorId(ctx);
  p.approvedAt = now();
  p.updatedBy = actorId(ctx);
  p.version = Number(p.version) + 1;
  await p.save({ transaction: t });
  await audit(
    ctx,
    {
      action: AUDIT.lateFeePolicyApproved,
      entityType: ENTITY,
      entityId: p.id!,
      entityLabel: describePolicy(p),
      societyId,
      after: auditView(p),
    },
    t,
  );
  return p;
}

/** Module 14 `onRejected`. */
export async function rejectPolicy(
  ctx: Ctx,
  societyId: number,
  id: number,
  reason: string,
  t: Transaction,
): Promise<LateFeePolicy> {
  const p = await LateFeePolicy.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!p) throw new NotFoundError('LATE_FEE_POLICY_NOT_FOUND', 'Late fee policy not found');
  if (p.status !== 'PENDING_APPROVAL') throw invalidState('This late fee policy is not waiting for approval');
  p.status = 'REJECTED';
  p.rejectedReason = reason.slice(0, 500);
  p.updatedBy = actorId(ctx);
  p.version = Number(p.version) + 1;
  await p.save({ transaction: t });
  await audit(
    ctx,
    {
      action: AUDIT.lateFeePolicyRejected,
      entityType: ENTITY,
      entityId: p.id!,
      entityLabel: describePolicy(p),
      societyId,
      after: auditView(p),
      reason,
    },
    t,
  );
  return p;
}

/** The approval type of module 14 (section 2): register it with `billingPorts().approvals.registerType`. */
export const policyApprovalType: ApprovalTypeHooks = {
  type: APPROVAL_TYPES.lateFeePolicyChange,
  async onApproved(ctx, entityId, t) {
    const p = await LateFeePolicy.findByPk(entityId, { attributes: ['societyId'], transaction: t });
    if (!p) throw new NotFoundError('LATE_FEE_POLICY_NOT_FOUND', 'Late fee policy not found');
    await approvePolicy(ctx, Number(p.societyId), entityId, t);
  },
  async onRejected(ctx, entityId, reason, t) {
    const p = await LateFeePolicy.findByPk(entityId, { attributes: ['societyId'], transaction: t });
    if (!p) throw new NotFoundError('LATE_FEE_POLICY_NOT_FOUND', 'Late fee policy not found');
    await rejectPolicy(ctx, Number(p.societyId), entityId, reason, t);
  },
  async describe(entityId) {
    const p = await LateFeePolicy.findByPk(entityId);
    if (!p) return [];
    return [
      { label: 'Policy', value: describePolicy(p) },
      { label: 'From', value: p.effectiveFrom, kind: 'date' },
      { label: 'Reason', value: p.reason },
    ];
  },
};
