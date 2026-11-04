import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, LateFeePolicy, closeDb } from '../../../src/models';
import {
  billingPortCalls,
  setBillingPorts,
  placeholderApprovalTypes,
} from '../../../src/modules/billing/billing.ports';
import { billingSetup } from '../../../src/modules/billing/billing.public';
import { approve, reject } from '../../../src/modules/billing/billing.rules.approvals-hook';
import { systemCtx } from '../../../src/types/context';
import { adminOf } from '../../helpers/residents';
import { featureOff } from '../../helpers/society-setup';
import { billingWorld, idem, issuedRun, resetBillingSetup } from '../../helpers/billing-setup';

afterAll(closeDb);
beforeEach(resetBillingSetup);

const interest = (over: Record<string, unknown> = {}) => ({
  policyType: 'SIMPLE_INTEREST',
  interestRatePct: '18.0000',
  interestFrom: 'DUE_DATE',
  graceDays: 5,
  effectiveFrom: '2026-11-01',
  reason: 'AGM resolution 6 of 2026',
  ...over,
});
const post = (c: any, body: Record<string, unknown>) =>
  c('post', '/billing/late-fee-policies', body, { headers: idem() });

describe('late fee policies: configuration (8.4, BR-11-51)', () => {
  it('in setup mode a policy is ACTIVE at once (audit SETUP_MODE) and no approval is requested', async () => {
    const w = await billingWorld();
    const r = await post(w.c, interest());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.message).toBe('Late fee policy saved');
    expect(r.body.data).toMatchObject({
      policyType: 'SIMPLE_INTEREST',
      interestRatePct: '18.0000',
      interestFrom: 'DUE_DATE',
      flatFeePaise: null,
      graceDays: 5,
      minChargePaise: 100,
      effectiveFrom: '2026-11-01',
      status: 'ACTIVE',
      reason: 'AGM resolution 6 of 2026',
      resolutionRef: null,
      approvalRequestId: null,
      approvedBy: w.user.id,
      rejectedReason: null,
      version: 1,
    });
    expect(billingPortCalls.filter(c => c.fn === 'approvals.request')).toHaveLength(0);
    const a = await AuditLog.findOne({
      where: { societyId: w.society.id!, action: 'billing.late_fee_policy.approved' },
    });
    expect(a!.reason).toBe('SETUP_MODE');
    expect(
      await AuditLog.count({
        where: { societyId: w.society.id!, action: 'billing.late_fee_policy.created' },
      }),
    ).toBe(1);
  });

  it('a flat fee and a NONE policy store only their own fields', async () => {
    const w = await billingWorld();
    const flat = await post(w.c, {
      policyType: 'FLAT',
      flatFeePaise: 25_000,
      graceDays: 0,
      minChargePaise: 0,
      effectiveFrom: '2026-12-01',
      reason: 'Flat fee decided',
      resolutionRef: 'AGM/2026/6',
    });
    expect(flat.status, JSON.stringify(flat.body)).toBe(201);
    expect(flat.body.data).toMatchObject({
      policyType: 'FLAT',
      flatFeePaise: 25_000,
      interestRatePct: null,
      interestFrom: null,
      minChargePaise: 0,
      resolutionRef: 'AGM/2026/6',
    });
    const none = await post(w.c, {
      policyType: 'NONE',
      graceDays: 3,
      effectiveFrom: '2027-01-01',
      reason: 'No late fee now',
    });
    expect(none.status, JSON.stringify(none.body)).toBe(201);
    expect(none.body.data).toMatchObject({ policyType: 'NONE', flatFeePaise: null, interestRatePct: null });
  });

  it('T11-45: 21.0001 per cent and 31 grace days are 400; the maximum 21.0000 and 30 days are accepted', async () => {
    const w = await billingWorld();
    expect((await post(w.c, interest({ interestRatePct: '21.0001' }))).status).toBe(400);
    expect((await post(w.c, interest({ graceDays: 31 }))).status).toBe(400);
    expect((await post(w.c, interest({ interestRatePct: '0.0000' }))).status).toBe(400);
    expect((await post(w.c, interest({ interestRatePct: '18' }))).status).toBe(400);
    expect((await post(w.c, interest({ interestRatePct: '100.0000' }))).status).toBe(400);
    expect((await post(w.c, interest({ interestRatePct: '21.0000', graceDays: 30 }))).status).toBe(201);
    expect(
      (await post(w.c, interest({ effectiveFrom: '2026-12-01', interestRatePct: '0.0001' }))).status,
    ).toBe(201);
  });

  it('cross-field rules: each type needs its own fields and refuses the others; flat fee 100 to 1,000,000; minimum charge 0 to 100,000', async () => {
    const w = await billingWorld();
    const code = async (b: Record<string, unknown>) => (await post(w.c, b)).status;
    expect(await code(interest({ interestRatePct: undefined }))).toBe(400);
    expect(await code(interest({ interestFrom: undefined }))).toBe(400);
    expect(await code(interest({ flatFeePaise: 500 }))).toBe(400);
    expect(await code(interest({ interestFrom: 'SOMETIME' }))).toBe(400);
    const flat = {
      policyType: 'FLAT',
      graceDays: 1,
      effectiveFrom: '2026-11-01',
      reason: 'Flat fee decided',
    };
    expect(await code(flat)).toBe(400);
    expect(await code({ ...flat, flatFeePaise: 99 })).toBe(400);
    expect(await code({ ...flat, flatFeePaise: 1_000_001 })).toBe(400);
    expect(await code({ ...flat, flatFeePaise: 500, interestRatePct: '5.0000' })).toBe(400);
    expect(await code({ ...flat, flatFeePaise: 500, minChargePaise: 100_001 })).toBe(400);
    expect(
      await code({
        policyType: 'NONE',
        graceDays: 0,
        interestFrom: 'DUE_DATE',
        effectiveFrom: '2026-11-01',
        reason: 'No late fee',
      }),
    ).toBe(400);
    expect(await code(interest({ reason: 'abc' }))).toBe(400);
    expect(await code(interest({ graceDays: undefined }))).toBe(400);
    expect(await code(interest({ extra: true }))).toBe(400);
  });

  it('the date is the first of a month and not before the current month (400 on effectiveFrom)', async () => {
    const w = await billingWorld();
    for (const effectiveFrom of ['2026-11-15', '2026-10-01', '2026-12-31']) {
      const r = await post(w.c, interest({ effectiveFrom }));
      expect(r.status, effectiveFrom).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
      expect(r.body.errors[0].field).toBe('effectiveFrom');
    }
    expect((await post(w.c, interest({ effectiveFrom: '2026-11-01' }))).status).toBe(201);
  });

  it('LATE_FEE_DATE_TAKEN for a second ACTIVE policy on the same date', async () => {
    const w = await billingWorld();
    await post(w.c, interest());
    const r = await post(w.c, interest({ interestRatePct: '12.0000' }));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('LATE_FEE_DATE_TAKEN');
  });
});

describe('late fee policies: approval after setup mode (BR-11-21, 6.5)', () => {
  it('a new policy is PENDING_APPROVAL with a LATE_FEE_POLICY_CHANGE request; approval makes it ACTIVE; another pending one is 409', async () => {
    const w = await billingWorld();
    await post(w.c, interest());
    await issuedRun(w.society.id!);
    const r = await post(w.c, interest({ effectiveFrom: '2027-01-01', interestRatePct: '15.0000' }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.message).toBe('Late fee policy sent for approval');
    expect(r.body.data).toMatchObject({ status: 'PENDING_APPROVAL', approvedBy: null, approvedAt: null });
    expect(typeof r.body.data.approvalRequestId).toBe('number');
    const call = billingPortCalls.find(c => c.fn === 'approvals.request')!;
    expect(call.input).toMatchObject({
      type: 'LATE_FEE_POLICY_CHANGE',
      entityType: 'late_fee_policy',
      entityId: r.body.data.id,
    });
    expect(placeholderApprovalTypes.has('LATE_FEE_POLICY_CHANGE')).toBe(true);

    const second = await post(w.c, interest({ effectiveFrom: '2027-02-01' }));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('LATE_FEE_POLICY_PENDING');

    // until approval the old policy applies
    expect((await billingSetup.policyFor(w.society.id!, '2027-01-31'))!.interestRatePct).toBe('18.0000');
    const done = await approve(r.body.data.approvalRequestId, systemCtx('approver'));
    expect(done).toMatchObject({
      type: 'LATE_FEE_POLICY_CHANGE',
      entityId: r.body.data.id,
      status: 'ACTIVE',
    });
    const row = (await LateFeePolicy.findByPk(r.body.data.id))!;
    expect(row.status).toBe('ACTIVE');
    expect(row.approvedAt).not.toBeNull();
    // BR-11-51: the policy of a window is the one effective on its last day
    expect((await billingSetup.policyFor(w.society.id!, '2026-12-31'))!.interestRatePct).toBe('18.0000');
    expect((await billingSetup.policyFor(w.society.id!, '2027-01-01'))!.interestRatePct).toBe('15.0000');
    expect(await billingSetup.policyFor(w.society.id!, '2026-10-31')).toBeNull();
    expect(
      await AuditLog.count({
        where: { societyId: w.society.id!, action: 'billing.late_fee_policy.approved' },
      }),
    ).toBe(2);
  });

  it('rejection marks the policy REJECTED with the reason and allows a new one', async () => {
    const w = await billingWorld();
    await issuedRun(w.society.id!);
    const r = await post(w.c, interest());
    expect(
      await reject(r.body.data.approvalRequestId, 'Not agreed at the AGM', systemCtx('approver')),
    ).toMatchObject({ status: 'REJECTED' });
    const row = (await LateFeePolicy.findByPk(r.body.data.id))!;
    expect(row).toMatchObject({ status: 'REJECTED', rejectedReason: 'Not agreed at the AGM' });
    expect((await post(w.c, interest())).status).toBe(201);
    expect(
      await AuditLog.count({
        where: { societyId: w.society.id!, action: 'billing.late_fee_policy.rejected' },
      }),
    ).toBe(1);
  });

  it('approval re-checks the date: an ACTIVE policy that took the date meanwhile makes onApproved fail with 409', async () => {
    const w = await billingWorld();
    await issuedRun(w.society.id!);
    const r = await post(w.c, interest());
    await LateFeePolicy.create({
      societyId: w.society.id!,
      policyType: 'NONE',
      interestRatePct: null,
      interestFrom: null,
      flatFeePaise: null,
      graceDays: 0,
      minChargePaise: 100,
      effectiveFrom: '2026-11-01',
      status: 'ACTIVE',
      reason: 'Inserted directly',
      resolutionRef: null,
      approvalRequestId: null,
      approvedBy: null,
      approvedAt: null,
      rejectedReason: null,
      createdBy: null,
      updatedBy: null,
      version: 1,
    });
    await expect(approve(r.body.data.approvalRequestId, systemCtx('approver'))).rejects.toMatchObject({
      code: 'LATE_FEE_DATE_TAKEN',
    });
    expect((await LateFeePolicy.findByPk(r.body.data.id))!.status).toBe('PENDING_APPROVAL');
  });

  it('a module 14 that approves inside the request transaction activates the policy at once', async () => {
    const w = await billingWorld();
    await issuedRun(w.society.id!);
    setBillingPorts({ approvals: { request: async () => ({ id: 91, status: 'APPROVED' }) } });
    const r = await post(w.c, interest());
    expect(r.body.data).toMatchObject({ status: 'ACTIVE', approvalRequestId: 91 });
  });
});

describe('late fee policies: list and access', () => {
  it('lists newest first with pagination and a status filter; view-only roles read but cannot create', async () => {
    const w = await billingWorld();
    await post(w.c, interest({ effectiveFrom: '2026-11-01' }));
    await post(w.c, interest({ effectiveFrom: '2027-01-01', interestRatePct: '12.0000' }));
    await post(w.c, interest({ effectiveFrom: '2026-12-01', interestRatePct: '15.0000' }));
    const list = await w.c('get', '/billing/late-fee-policies');
    expect(list.status).toBe(200);
    expect(list.body.data.map((p: any) => p.effectiveFrom)).toEqual([
      '2027-01-01',
      '2026-12-01',
      '2026-11-01',
    ]);
    expect(list.body.pagination).toMatchObject({ page: 1, limit: 20, total: 3 });
    const paged = await w.c('get', '/billing/late-fee-policies', undefined, {
      query: { limit: '2', page: '2' },
    });
    expect(paged.body.data).toHaveLength(1);
    expect(
      (await w.c('get', '/billing/late-fee-policies', undefined, { query: { status: 'REJECTED' } })).body
        .data,
    ).toEqual([]);
    const sec = await adminOf(w.society, 'secretary');
    expect((await sec.c('get', '/billing/late-fee-policies')).status).toBe(200);
    expect((await post(sec.c, interest({ effectiveFrom: '2027-04-01' }))).status).toBe(403);
    await featureOff(w.society.id!, 'billing.late_fee_and_interest');
    expect((await post(w.c, interest({ effectiveFrom: '2027-04-01' }))).body.code).toBe(
      'FEATURE_NOT_IN_PLAN',
    );
  });

  it('another society sees none of the policies', async () => {
    const a = await billingWorld();
    await post(a.c, interest());
    const b = await billingWorld({ name: 'Green Park CHS' });
    expect((await b.c('get', '/billing/late-fee-policies')).body.data).toEqual([]);
    expect(await billingSetup.policyFor(b.society.id!, '2027-01-01')).toBeNull();
  });
});
