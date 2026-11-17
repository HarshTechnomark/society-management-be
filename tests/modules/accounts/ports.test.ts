import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, sequelize } from '../../../src/models';
import {
  PRODUCTION_REQUIRED_PORTS,
  accountsPortCalls,
  accountsPorts,
  assertAccountsPortsReady,
  fakePortsInUse,
  placeholderAccountsApprovals,
  setAccountsPorts,
} from '../../../src/modules/accounts/accounts.ports';
import { AccountsWorld, accountsSociety, resetAccounts } from '../../helpers/accounts';

afterAll(async () => {
  await closeDb();
});
let w: AccountsWorld;
beforeEach(async () => {
  await resetAccounts();
  w = await accountsSociety();
});

describe('placeholder ports of modules 14, 16, 21 and 24', () => {
  it('approvals: request records, lockOpenForEntity finds it, cancel and resubmit change it', async () => {
    const t = await sequelize.transaction();
    try {
      const r = await accountsPorts().approvals.request(
        w.user,
        {
          type: 'EXPENSE',
          entityType: 'expense',
          entityId: 7,
          title: 'Lift AMC · Lift AMC',
          amountPaise: 1_200_000,
          payload: { expenseType: 'DIRECT' },
        },
        t,
      );
      expect(r.status).toBe('PENDING');
      expect(placeholderAccountsApprovals.get(r.id)).toMatchObject({
        type: 'EXPENSE',
        entityId: 7,
        societyId: w.sid,
        requestedBy: w.userId,
        status: 'PENDING',
      });
      expect(await accountsPorts().approvals.lockOpenForEntity(w.sid, 'expense', 7, t)).toEqual({
        id: r.id,
        type: 'EXPENSE',
      });
      expect(await accountsPorts().approvals.lockOpenForEntity(w.sid + 1, 'expense', 7, t)).toBeNull();
      await accountsPorts().approvals.cancel(w.user, r.id, 'withdrawn', t);
      expect(placeholderAccountsApprovals.get(r.id)!.status).toBe('CANCELLED');
      expect(await accountsPorts().approvals.lockOpenForEntity(w.sid, 'expense', 7, t)).toBeNull();
      await accountsPorts().approvals.resubmit(w.user, r.id, { title: 'again', amountPaise: 5 }, t);
      expect(placeholderAccountsApprovals.get(r.id)!.status).toBe('PENDING');
      expect(accountsPortCalls.map(c => c.fn)).toEqual([
        'approvals.request',
        'approvals.cancel',
        'approvals.resubmit',
      ]);
      expect(accountsPortCalls[0]!.t).toBe(t);
    } finally {
      await t.rollback();
    }
  });

  it('registerType keeps the hooks of each approval type', () => {
    const def = {
      type: 'FUND_TRANSFER',
      onApproved: async () => undefined,
      onRejected: async () => undefined,
      describe: async () => [],
    };
    accountsPorts().approvals.registerType(def);
    expect(placeholderAccountsApprovalTypesHas('FUND_TRANSFER')).toBe(true);
  });

  it('vendors, notifications and the reports cache are recorded; the vendor placeholder knows no vendor', async () => {
    const t = await sequelize.transaction();
    try {
      expect(await accountsPorts().vendors.exists(w.sid, 5)).toBe(false);
      expect(await accountsPorts().vendors.getBill(w.sid, 5)).toBeNull();
      await accountsPorts().vendors.recordPayment(w.user, 9, { expenseId: 3, amountPaise: 1000 }, t);
      await accountsPorts().vendors.reversePayment(w.user, 9, 3, t);
    } finally {
      await t.rollback();
    }
    await accountsPorts().notifications.send('accounts.expense_reversed', [w.userId], { expenseId: 3 });
    accountsPorts().reportsCache.touch(w.sid, 'finance');
    expect(accountsPortCalls.map(c => c.fn)).toEqual([
      'vendors.recordPayment',
      'vendors.reversePayment',
      'notifications.send',
      'reports.touch',
    ]);
    expect(accountsPortCalls[0]!.input).toEqual({ vendorBillId: 9, expenseId: 3, amountPaise: 1000 });
  });

  it('a real port replaces the placeholder and is no longer reported as fake; setAccountsPorts() restores', () => {
    expect(fakePortsInUse()).toEqual([...PRODUCTION_REQUIRED_PORTS]);
    setAccountsPorts({ vendors: { exists: async () => true } });
    expect(fakePortsInUse()).toEqual([...PRODUCTION_REQUIRED_PORTS]); // vendors is not required in production
    setAccountsPorts({ approvals: { request: async () => ({ id: 1, status: 'APPROVED' as const }) } });
    expect(fakePortsInUse()).toEqual(['notifications']);
    setAccountsPorts({ notifications: { send: async () => undefined } });
    expect(fakePortsInUse()).toEqual([]);
    setAccountsPorts();
    expect(fakePortsInUse()).toEqual(['approvals', 'notifications']);
  });

  it('production refuses to start with placeholder approvals or notifications, development does not', () => {
    expect(() => assertAccountsPortsReady('development')).not.toThrow();
    expect(() => assertAccountsPortsReady('test')).not.toThrow();
    expect(() => assertAccountsPortsReady('production')).toThrow(/approvals, notifications/);
    setAccountsPorts({
      approvals: { request: async () => ({ id: 1, status: 'PENDING' as const }) },
      notifications: { send: async () => undefined },
    });
    expect(() => assertAccountsPortsReady('production')).not.toThrow();
  });
});

import { placeholderAccountsApprovalTypes } from '../../../src/modules/accounts/accounts.ports';
const placeholderAccountsApprovalTypesHas = (k: string) => placeholderAccountsApprovalTypes.has(k);
