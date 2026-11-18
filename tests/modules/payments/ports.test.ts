import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../../src/models';
import {
  assertPaymentsPortsReady,
  fakePortsInUse,
  paymentsPorts,
  setPaymentsPorts,
} from '../../../src/modules/payments/payments.ports';
import { engineApprovals } from '../../../src/modules/billing/billing.ports';

afterAll(closeDb);
beforeEach(() => setPaymentsPorts());

describe('payments ports', () => {
  it('approvals is the real module 14 (no placeholder)', () => {
    expect(paymentsPorts().approvals).toBe(engineApprovals);
  });

  it('funds, bank accounts and society balance have working placeholders', async () => {
    expect(await paymentsPorts().funds.exists(1, 3)).toBe(true);
    expect((await paymentsPorts().bankAccounts.get(1, 4))!.id).toBe(4);
    expect(await paymentsPorts().societyBalance.get(1)).toEqual({ balancePaise: 0 });
  });

  it('production refuses to start while journal, gateways or notifications are placeholders', () => {
    expect(fakePortsInUse().sort()).toEqual(['gateways', 'journal', 'notifications']);
    expect(() => assertPaymentsPortsReady('production')).toThrow(/journal, gateways, notifications/);
    expect(() => assertPaymentsPortsReady('development')).not.toThrow();
    setPaymentsPorts({ journal: {}, gateways: {}, notifications: {} });
    expect(() => assertPaymentsPortsReady('production')).not.toThrow();
  });
});
