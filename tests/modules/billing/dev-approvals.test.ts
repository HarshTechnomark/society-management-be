import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BillingRun, LateFeePolicy, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { placeholderApprovalRequests } from '../../../src/modules/billing/billing.ports';
import { registerBilling } from '../../../src/modules/billing/billing.public';
import { app } from '../../helpers/auth';
import { issuedRun } from '../../helpers/billing-setup';
import {
  addOwner,
  createAndCompute,
  idemH,
  resetRuns,
  runSociety,
  standardRules,
  type RunSociety,
} from '../../helpers/billing-runs';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetRuns();
  registerBilling();
});

/** The development approvals page (module 14 stand-in) decides billing requests as the signed-in person when there is one. */
async function pendingRun(): Promise<{ w: RunSociety; runId: number; requestId: number }> {
  const w = await runSociety();
  for (const u of w.units) await addOwner(w.society.id!, u.id, `Owner of ${u.label}`);
  await standardRules(w.society.id!, w.heads, [w.units[0]!.id]);
  const run = await createAndCompute(w.c);
  const d = (await w.c('get', `/billing/runs/${run.id}`)).body.data;
  const p = await w.c(
    'post',
    `/billing/runs/${run.id}/publish`,
    { confirmLabel: 'BR-2026-11', version: d.version },
    { headers: idemH() },
  );
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return { w, runId: run.id, requestId: p.body.data.approvalRequestId };
}

const approvePath = (id: number) => `/dev/approvals/${id}/approve`;

describe('development approvals for billing (maker-checker and approver)', () => {
  it('the publisher signed in on the page gets 409 MAKER_CHECKER_VIOLATION and the run keeps waiting', async () => {
    const { w, runId, requestId } = await pendingRun();
    const r = await w.c('post', approvePath(requestId), {}, { query: { source: 'billing' } });
    expect([r.status, r.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    expect((await BillingRun.findByPk(runId))!.status).toBe('PENDING_APPROVAL');
    expect(placeholderApprovalRequests.get(requestId)!.status).toBe('PENDING');
  });

  it('a second signed-in member approves and is stored as approvedBy', async () => {
    const { w, runId, requestId } = await pendingRun();
    const r = await w.treasurer.c('post', approvePath(requestId), {}, { query: { source: 'billing' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = (await BillingRun.findByPk(runId))!;
    expect(row.approvedBy).toBe(w.treasurer.user.id);
    expect(['APPROVED', 'ISSUING', 'ISSUED']).toContain(row.status);
  });

  it('without a session the system still decides (scripts and tests), with no approver', async () => {
    const { runId, requestId } = await pendingRun();
    const r = await request(app).post(`/api/v1${approvePath(requestId)}?source=billing`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = (await BillingRun.findByPk(runId))!;
    expect(row.approvedBy).toBeNull();
    expect(['APPROVED', 'ISSUING', 'ISSUED']).toContain(row.status);
  });

  it('a late fee policy change: the requester gets 409, another member approves and is stored as approvedBy', async () => {
    const w = await runSociety();
    const body = (effectiveFrom: string) => ({
      policyType: 'SIMPLE_INTEREST',
      interestRatePct: '18.0000',
      interestFrom: 'DUE_DATE',
      graceDays: 5,
      effectiveFrom,
      reason: 'AGM resolution',
    });
    expect(
      (await w.c('post', '/billing/late-fee-policies', body('2026-11-01'), { headers: idemH() })).status,
    ).toBe(201);
    await issuedRun(w.society.id!);
    const r = await w.c('post', '/billing/late-fee-policies', body('2027-01-01'), { headers: idemH() });
    expect(r.body.data.status, JSON.stringify(r.body)).toBe('PENDING_APPROVAL');
    const id = r.body.data.approvalRequestId as number;
    const self = await w.c('post', approvePath(id), {}, { query: { source: 'billing' } });
    expect([self.status, self.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    const ok = await w.treasurer.c('post', approvePath(id), {}, { query: { source: 'billing' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const row = (await LateFeePolicy.findByPk(r.body.data.id))!;
    expect(row.status).toBe('ACTIVE');
    expect(row.approvedBy).toBe(w.treasurer.user.id);
  });

  it('refuses an approval type that has no development hook with 422', async () => {
    placeholderApprovalRequests.set(4242, {
      id: 4242,
      type: 'SOMETHING_ELSE',
      entityType: 'x',
      entityId: 1,
      societyId: 1,
      requestedBy: null,
      status: 'PENDING',
    });
    const r = await request(app).post(`/api/v1${approvePath(4242)}?source=billing`);
    expect([r.status, r.body.code]).toEqual([422, 'UNKNOWN_APPROVAL_TYPE']);
  });
});
