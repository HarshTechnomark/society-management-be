import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalRequest,
  ApprovalRule,
  BillingNote,
  JoinRequest,
  Payment,
  Refund,
  closeDb,
} from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { setBillingPorts } from '../../../src/modules/billing/billing.public';
import { registerNoteApprovalTypes } from '../../../src/modules/billing/billing.notes.approvals-hook';
import { setPaymentsPorts } from '../../../src/modules/payments/payments.public';
import { registerRefundApprovalType } from '../../../src/modules/payments/payments.refunds.service';
import { registerOfflineApprovalTypes } from '../../../src/modules/payments/payments.offline.approvals-hook';
import { registerApprovals } from '../../../src/modules/approvals/approvals.public';
import { wireApprovalsPorts } from '../../../src/modules/approvals/approvals.wire';
import { resetRegistry } from '../../../src/modules/approvals/approvals.registry';
import { setApprovalsPorts } from '../../../src/modules/approvals/approvals.ports';
import { realApprovals } from '../../../src/modules/approvals/approvals.port';
import { registerResidents } from '../../../src/modules/residents/residents.public';
import { advanceBalance } from '../../../src/modules/payments/payments.advances';
import { settleInput } from '../../../src/modules/payments/payments.settle';
import { moneyTx } from '../../../src/modules/payments/payments.shared';
import { resetLogins } from '../../helpers/access';
import { idemH, invoiceWorld, makeInvoice, resetInvoices } from '../../helpers/billing-invoices';
import { mkInvoice, offline, paymentsWorld, resetPayments, sysCtx } from '../../helpers/payments';
import { recordOffline } from '../../helpers/payments-offline';
import { makeUser } from '../../helpers/auth';
import { as, login } from '../../helpers/access';
import { docItem, idemKey, ownerOf, residentsSociety, resetResidentsP2 } from '../../helpers/residents-p2';

/**
 * 14.3 prep: the production wiring (`wireApprovalsPorts()`) runs the existing modules on the real engine. Every decision is
 * taken over HTTP as a different member, from `POST /approvals/:id/approve`.
 */
afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(() => {
  resetLogins();
  resetRateLimits();
  resetRegistry();
  setApprovalsPorts();
  registerApprovals();
});

const row = async (id: number) => (await ApprovalRequest.findByPk(id))!;
const approveOver = (c: ReturnType<typeof as>, id: number, version = 1) =>
  c('post', `/approvals/${id}/approve`, { version }, { headers: idemH() });

describe('billing credit note through the real engine (HTTP)', () => {
  const parkingLine = (invoice: any) => invoice.lines.find((l: any) => l.headKey === 'PARKING').id as number;
  const credit = (w: any, invoiceId: number, lineId: number, amountPaise: number) =>
    w.c(
      'post',
      `/invoices/${invoiceId}/credit-notes`,
      {
        reasonCode: 'BILLING_ERROR',
        remarks: 'Parking was charged by mistake',
        lines: [{ invoiceLineId: lineId, amountPaise }],
      },
      { headers: idemH() },
    );
  async function world(alwaysPending: boolean) {
    await resetInvoices();
    const w = await invoiceWorld();
    setBillingPorts({ approvals: realApprovals });
    registerNoteApprovalTypes();
    if (alwaysPending)
      await ApprovalRule.create({
        societyId: w.society.id!,
        type: 'CREDIT_NOTE',
        name: 'Every credit note',
        priority: 1,
        steps: [
          {
            stepNo: 1,
            name: 'Treasurer or Chairman',
            mode: 'ANY_OF',
            roleKeys: ['treasurer', 'chairman'],
            userIds: [],
            requiredCount: null,
          },
        ],
        action: 'REQUIRE_APPROVAL',
      } as never);
    return w;
  }

  it('a small credit note auto-approves by the default rule and is issued at once', async () => {
    const w = await world(false);
    const invoice = await makeInvoice(w);
    const r = await credit(w, invoice.id, parkingLine(invoice), 50_000);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.status).toBe('ISSUED');
    expect(await row(r.body.data.approvalRequestId)).toMatchObject({
      status: 'APPROVED',
      routing: 'AUTO_RULE',
    });
  });

  it('with a custom rule the note waits; the chairman cannot approve own request, the treasurer approves over HTTP', async () => {
    const w = await world(true);
    const invoice = await makeInvoice(w);
    const r = await credit(w, invoice.id, parkingLine(invoice), 50_000);
    expect(r.body.data.status).toBe('PENDING_APPROVAL');
    const id = r.body.data.approvalRequestId as number;
    const self = await approveOver(w.c, id);
    expect(self.status).toBe(409);
    expect(self.body.code).toBe('MAKER_CHECKER_VIOLATION');
    const ok = await approveOver(w.treasurer.c, id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await row(id)).status).toBe('APPROVED');
    expect((await BillingNote.findByPk(r.body.data.id))!.status).toBe('ISSUED');
  });
});

describe('payments through the real engine (HTTP)', () => {
  async function world() {
    await resetPayments();
    const w = await paymentsWorld({ flats: 2 });
    setPaymentsPorts({ approvals: realApprovals });
    registerRefundApprovalType();
    registerOfflineApprovalTypes();
    return w;
  }

  it('a refund waits for the treasurer, who approves it over HTTP; the refund moves to PROCESSING', async () => {
    const w = await world();
    await mkInvoice(w, 0, 120_000, '2026-11-10');
    const { payment } = await moneyTx(t => settleInput(sysCtx(w), offline(w, 0, 500_000), t));
    expect(await advanceBalance(w.society.id!, w.units[0]!.id)).toBe(380_000);
    const r = await w.c(
      'post',
      '/refunds',
      {
        paymentId: Number(payment.id),
        amountPaise: 300_000,
        reason: 'Paid twice by mistake',
        mode: 'BANK_TRANSFER',
        payeeName: 'Rohan Sharma',
        payeeAccountMasked: 'HDFC xxxx4521',
      },
      { headers: idemH() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.data.approvalRequestId as number;
    expect(await row(id)).toMatchObject({ type: 'PAYMENT_REFUND', status: 'PENDING' });
    expect((await approveOver(w.c, id)).body.code).toBe('MAKER_CHECKER_VIOLATION');
    const ok = await approveOver(w.treasurer.c, id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await Refund.findByPk(r.body.data.id))!.status).toBe('PROCESSING');
  });

  it('an offline payment waits for the treasurer and is confirmed when approved over HTTP', async () => {
    const w = await world();
    await mkInvoice(w, 0, 80_000, '2026-11-20');
    const r = await recordOffline(w, 0, { amountPaise: 80_000 });
    expect(r.body.data.status).toBe('PENDING_APPROVAL');
    const id = r.body.data.approval.requestId as number;
    expect((await approveOver(w.treasurer.c, id)).status).toBe(200);
    expect((await Payment.findByPk(r.body.data.id))!.status).toBe('CONFIRMED');
  });

  it('an offline payment that a rule auto-approves is confirmed at once (APPROVED handled by the caller)', async () => {
    const w = await world();
    await mkInvoice(w, 0, 80_000, '2026-11-20');
    await ApprovalRule.create({
      societyId: w.society.id!,
      type: 'OFFLINE_PAYMENT',
      name: 'Auto',
      priority: 1,
      steps: [],
      action: 'AUTO_APPROVE',
    } as never);
    const r = await recordOffline(w, 0, { amountPaise: 80_000 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await Payment.findByPk(r.body.data.id))!.status).toBe('CONFIRMED');
  });
});

describe('residents join request through the real engine (HTTP)', () => {
  it('the secretary approves a tenant join request over HTTP and the tenancy becomes active', async () => {
    await resetResidentsP2();
    // the join request is raised by the system user (requester of requests nobody signed in for)
    await makeUser({ status: 'SYSTEM', email: 'system@societyapp.in', password: null, name: 'System' });
    resetRegistry();
    wireApprovalsPorts();
    registerResidents();
    const s = await residentsSociety();
    const owner = await ownerOf(s);
    const user = await makeUser({ name: 'Pallavi Naik', mobile: '9820000011' });
    const c = as(await login(user, { app: 'RESIDENT' }), 'RESIDENT');
    const body = {
      societyCode: s.society.slug,
      unitId: s.unit.id,
      relation: 'TENANT',
      agreementStart: '2026-11-01',
      agreementEnd: '2027-09-30',
      fileIds: [
        await docItem(s.society.id!, user.id, 'AADHAAR'),
        await docItem(s.society.id!, user.id, 'RENT_AGREEMENT'),
      ],
    };
    const res = await c('post', '/me/join-requests', body, { headers: idemKey() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.data.id as number;
    const conf = await owner.c('post', `/me/household/join-requests/${id}/confirm`, { version: 1 });
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    const detail = await s.c('get', `/join-requests/${id}`);
    const reqId = detail.body.data.approvalRequestId as number;
    expect(reqId, JSON.stringify(detail.body)).toBeGreaterThan(0);
    expect(await row(reqId)).toMatchObject({ type: 'JOIN_REQUEST', status: 'PENDING' });
    const ok = await approveOver(s.secretary.c, reqId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await JoinRequest.findByPk(id))!.status).toBe('APPROVED');
  });
});
