import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalRequest, BillingRun, LateFeePolicy, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { decideOver } from '../../helpers/approvals-decide';
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

/** The module 14 inbox (`POST /approvals/:id/approve`) decides billing requests as the signed-in member. */
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

describe('billing approvals in the module 14 inbox (maker-checker and approver)', () => {
  it('the publisher gets 409 MAKER_CHECKER_VIOLATION and the run keeps waiting', async () => {
    const { w, runId, requestId } = await pendingRun();
    const r = await decideOver(w.c as never, requestId);
    expect([r.status, r.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    expect((await BillingRun.findByPk(runId))!.status).toBe('PENDING_APPROVAL');
    expect((await ApprovalRequest.findByPk(requestId))!.status).toBe('PENDING');
  });

  it('a second member approves and is stored as approvedBy', async () => {
    const { w, runId, requestId } = await pendingRun();
    const r = await decideOver(w.treasurer.c as never, requestId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = (await BillingRun.findByPk(runId))!;
    expect(row.approvedBy).toBe(w.treasurer.user.id);
    expect(['APPROVED', 'ISSUING', 'ISSUED']).toContain(row.status);
  });

  it('the development stand-in is gone: /dev/approvals answers 404', async () => {
    const { requestId } = await pendingRun();
    expect((await request(app).get('/api/v1/dev/approvals')).status).toBe(404);
    expect(
      (await request(app).post(`/api/v1/dev/approvals/${requestId}/approve?source=billing`)).status,
    ).toBe(404);
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
    const self = await decideOver(w.c as never, id);
    expect([self.status, self.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    const ok = await decideOver(w.treasurer.c as never, id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const row = (await LateFeePolicy.findByPk(r.body.data.id))!;
    expect(row.status).toBe('ACTIVE');
    expect(row.approvedBy).toBe(w.treasurer.user.id);
  });
});
