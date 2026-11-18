import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalRequest, ApprovalRule, BillingNote, Invoice, Payment, closeDb } from '../../../src/models';
import { now } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import {
  billingPortCalls,
  billingPorts,
  defaultBillingPorts,
  setBillingPorts,
} from '../../../src/modules/billing/billing.ports';
import { registerNoteApprovalTypes } from '../../../src/modules/billing/billing.notes.approvals-hook';
import {
  defaultPaymentsPorts,
  paymentsPorts,
  setPaymentsPorts,
} from '../../../src/modules/payments/payments.ports';
import { registerOfflineApprovalTypes } from '../../../src/modules/payments/payments.offline.approvals-hook';
import {
  approve,
  reject,
  realApprovals,
  registerApprovals,
} from '../../../src/modules/approvals/approvals.public';
import { resetRegistry } from '../../../src/modules/approvals/approvals.registry';
import { setApprovalsPorts } from '../../../src/modules/approvals/approvals.ports';
import { sequelize } from '../../../src/models';
import type { Ctx } from '../../../src/types/context';
import { resetLogins } from '../../helpers/access';
import {
  ctxFor,
  idemH,
  invoiceWorld,
  makeInvoice,
  resetInvoices,
  type RunSociety,
} from '../../helpers/billing-invoices';
import { mkInvoice, paymentsWorld, resetPayments } from '../../helpers/payments';
import { recordOffline } from '../../helpers/payments-offline';

/**
 * The real module 14 satisfies the placeholder contract of modules 11 and 12: the same port object is swapped in with one
 * line (`setBillingPorts({ approvals: realApprovals })`, `setPaymentsPorts({ approvals: realApprovals })`) and the existing
 * credit-note and offline-payment scenarios, which the dev approvals page drives today, run against the real engine.
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

/** The context a signed-in approver would have (session, membership, role). */
const approver = (w: RunSociety, userId: number, roleKey: string): Ctx => ({
  ...ctxFor(w, userId),
  actorRoleKey: roleKey,
  membership: { id: 1, roleId: 1, roleKey, roleScope: 'society', status: 'ACTIVE', requiresMfa: false },
  session: {
    id: 1,
    authTime: now(),
    clientApp: 'ADMIN',
    activeSocietyId: w.society.id!,
    mfaVerified: true,
    amr: ['pwd'] as never,
    supportGrantId: null,
    idleTimeoutMinutes: 30,
    absoluteExpiresAt: new Date(now().getTime() + 86_400_000),
  },
});
const reqRow = async (id: number) => (await ApprovalRequest.findByPk(id))!;

describe('the real port has the placeholder interface', () => {
  it('same functions as the billing and payments placeholders', () => {
    const names = (o: object) => Object.keys(o).sort();
    expect(names(realApprovals)).toEqual(names(defaultBillingPorts.approvals));
    expect(names(realApprovals)).toEqual(names(defaultPaymentsPorts.approvals));
    for (const k of names(realApprovals)) expect((realApprovals as never)[k]).toBeTypeOf('function');
  });
});

describe('module 11 credit notes through the real engine', () => {
  const credit = (w: RunSociety, invoiceId: number, lineId: number, amountPaise: number) =>
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
  const parkingLine = (invoice: any) => invoice.lines.find((l: any) => l.headKey === 'PARKING').id as number;

  async function world(custom: boolean) {
    await resetInvoices();
    const w = await invoiceWorld();
    setBillingPorts({ approvals: realApprovals });
    registerNoteApprovalTypes();
    if (custom)
      // a society that wants every credit note approved (BR-14-6: a rule row exists, so no defaults are seeded)
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

  it('a credit note waits for the real approval, the requester cannot approve, the treasurer can (maker-checker, hooks)', async () => {
    const w = await world(true);
    const invoice = await makeInvoice(w);
    const r = await credit(w, invoice.id, parkingLine(invoice), 50_000);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.status).toBe('PENDING_APPROVAL');
    const id = r.body.data.approvalRequestId as number;
    const row = await reqRow(id);
    expect(row).toMatchObject({
      type: 'CREDIT_NOTE',
      entityType: 'billing_note',
      status: 'PENDING',
      amountPaise: 50_000,
    });
    expect(Number(row.entityId)).toBe(r.body.data.id);
    // the real engine knows the open request of the entity (BR-14-14 lock order step)
    expect(
      await sequelize.transaction(t =>
        billingPorts().approvals.lockOpenForEntity(w.society.id!, 'billing_note', r.body.data.id, t),
      ),
    ).toEqual({
      id,
      type: 'CREDIT_NOTE',
    });

    await expect(approve(approver(w, w.user.id!, 'chairman'), id, { version: 1 })).rejects.toMatchObject({
      status: 409,
      code: 'MAKER_CHECKER_VIOLATION',
    });
    const done = await approve(approver(w, w.treasurer.user.id!, 'treasurer'), id, { version: 1 });
    expect(done.status).toBe('APPROVED');
    const note = (await BillingNote.findByPk(r.body.data.id))!;
    expect(note).toMatchObject({
      status: 'ISSUED',
      noteNo: 'CN/2026-27/000001',
      appliedToInvoicePaise: 50_000,
    });
    expect((await Invoice.findByPk(invoice.id))!.outstandingPaise).toBe(403_000);
  });

  it('a rejection runs onRejected with the reason and releases the reserved amount', async () => {
    const w = await world(true);
    const invoice = await makeInvoice(w);
    const r = await credit(w, invoice.id, parkingLine(invoice), 50_000);
    const id = r.body.data.approvalRequestId as number;
    await reject(approver(w, w.treasurer.user.id!, 'treasurer'), id, {
      version: 1,
      reason: 'Parking is correct',
    });
    expect((await BillingNote.findByPk(r.body.data.id))!.status).toBe('REJECTED');
    expect((await reqRow(id)).status).toBe('REJECTED');
    expect((await Invoice.findByPk(invoice.id))!.outstandingPaise).toBe(453_000);
  });

  it('a small credit note falls in the default auto band: APPROVED at once, issued exactly once (the caller applies it)', async () => {
    const w = await world(false);
    const invoice = await makeInvoice(w);
    const r = await credit(w, invoice.id, parkingLine(invoice), 50_000);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.status).toBe('ISSUED');
    const row = await reqRow(r.body.data.approvalRequestId);
    expect(row).toMatchObject({ status: 'APPROVED', routing: 'AUTO_RULE' });
    expect(await BillingNote.count({ where: { status: 'ISSUED', noteNo: 'CN/2026-27/000001' } })).toBe(1);
    expect(
      billingPortCalls.filter(c => c.fn === 'journal.post' && (c.input as any).voucherType === 'CREDIT_NOTE'),
    ).toHaveLength(1);
  });
});

describe('module 12 offline payments through the real engine', () => {
  async function world() {
    await resetPayments();
    const w = await paymentsWorld();
    setPaymentsPorts({ approvals: realApprovals });
    registerOfflineApprovalTypes();
    await mkInvoice(w, 0, 80_000, '2026-11-20');
    return w;
  }

  it('the treasurer approves a cash payment recorded by the chairman: it is confirmed and allocated', async () => {
    const w = await world();
    const r = await recordOffline(w, 0, { amountPaise: 80_000 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.status).toBe('PENDING_APPROVAL');
    const id = r.body.data.approval.requestId as number;
    expect(await reqRow(id)).toMatchObject({
      type: 'OFFLINE_PAYMENT',
      entityType: 'payment',
      status: 'PENDING',
      requesterRoleKey: 'chairman',
    });
    await expect(approve(approver(w, w.user.id!, 'chairman'), id, { version: 1 })).rejects.toMatchObject({
      code: 'MAKER_CHECKER_VIOLATION',
    });
    await approve(approver(w, w.treasurer.user.id!, 'treasurer'), id, { version: 1 });
    expect((await Payment.findByPk(r.body.data.id))!.status).toBe('CONFIRMED');
    expect((await reqRow(id)).status).toBe('APPROVED');
    // the port still finds no open request for the settled payment
    expect(
      await paymentsPorts().approvals.lockOpenForEntity(
        w.society.id!,
        'payment',
        r.body.data.id,
        undefined as never,
      ),
    ).toBeNull();
  });

  it('a rejection ends the pending payment with the reason', async () => {
    const w = await world();
    const r = await recordOffline(w, 0, { amountPaise: 80_000 });
    const id = r.body.data.approval.requestId as number;
    await reject(approver(w, w.treasurer.user.id!, 'treasurer'), id, {
      version: 1,
      reason: 'No match in the bank statement',
    });
    expect((await Payment.findByPk(r.body.data.id))!.status).toBe('REJECTED');
  });

  it('the owner module cancels through the port without a handler call-back', async () => {
    const w = await world();
    const r = await recordOffline(w, 0, { amountPaise: 80_000 });
    const id = r.body.data.approval.requestId as number;
    await sequelize.transaction(t =>
      paymentsPorts().approvals.cancel(
        approver(w, w.user.id!, 'chairman'),
        id,
        'Withdrawn by the person who recorded it',
        t,
      ),
    );
    expect((await reqRow(id)).status).toBe('CANCELLED');
    expect((await Payment.findByPk(r.body.data.id))!.status).toBe('PENDING_APPROVAL');
  });
});
