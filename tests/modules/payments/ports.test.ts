import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, sequelize } from '../../../src/models';
import {
  assertPaymentsPortsReady,
  fakePortsInUse,
  paymentsPortCalls,
  paymentsPorts,
  placeholderPaymentApprovals,
  setPaymentsPorts,
} from '../../../src/modules/payments/payments.ports';
import { APPROVAL_TYPES } from '../../../src/modules/payments/payments.constants';
import { systemCtx } from '../../../src/types/context';

afterAll(closeDb);
beforeEach(() => setPaymentsPorts());

describe('payments placeholder ports', () => {
  it('approvals placeholder records requests the dev page can decide, and finds the open one', async () => {
    const ctx = {
      ...systemCtx('t'),
      society: { id: 5, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
    };
    const r = await sequelize.transaction(t =>
      paymentsPorts().approvals.request(
        ctx,
        { type: APPROVAL_TYPES.offlinePayment, entityType: 'payment', entityId: 9, title: 'Cash' },
        t,
      ),
    );
    expect(r.status).toBe('PENDING');
    expect(placeholderPaymentApprovals.get(r.id)).toMatchObject({
      type: 'OFFLINE_PAYMENT',
      entityId: 9,
      societyId: 5,
      status: 'PENDING',
    });
    expect(await paymentsPorts().approvals.lockOpenForEntity(5, 'payment', 9, undefined as never)).toEqual({
      id: r.id,
      type: 'OFFLINE_PAYMENT',
    });
    expect(paymentsPortCalls.some(c => c.fn === 'approvals.request')).toBe(true);
  });

  it('funds, bank accounts and society balance have working placeholders', async () => {
    expect(await paymentsPorts().funds.exists(1, 3)).toBe(true);
    expect((await paymentsPorts().bankAccounts.get(1, 4))!.id).toBe(4);
    expect(await paymentsPorts().societyBalance.get(1)).toEqual({ balancePaise: 0 });
  });

  it('production refuses to start while approvals, journal, gateways or notifications are placeholders', () => {
    expect(fakePortsInUse().sort()).toEqual(['approvals', 'gateways', 'journal', 'notifications']);
    expect(() => assertPaymentsPortsReady('production')).toThrow(
      /approvals, journal, gateways, notifications/,
    );
    expect(() => assertPaymentsPortsReady('development')).not.toThrow();
    setPaymentsPorts({ approvals: {}, journal: {}, gateways: {}, notifications: {} });
    expect(() => assertPaymentsPortsReady('production')).not.toThrow();
  });
});
