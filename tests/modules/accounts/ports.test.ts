import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalRequest, closeDb, sequelize } from '../../../src/models';
import {
  PRODUCTION_REQUIRED_PORTS,
  accountsPortCalls,
  accountsPorts,
  assertAccountsPortsReady,
  fakePortsInUse,
  setAccountsPorts,
} from '../../../src/modules/accounts/accounts.ports';
import { engineApprovals } from '../../../src/modules/billing/billing.ports';
import { registerExpenseJobs } from '../../../src/modules/accounts/accounts.expenses.jobs';
import { isRegistered } from '../../../src/modules/approvals/approvals.registry';
import { AccountsWorld, accountsSociety, resetAccounts } from '../../helpers/accounts';

afterAll(async () => {
  await closeDb();
});
let w: AccountsWorld;
beforeEach(async () => {
  await resetAccounts();
  w = await accountsSociety();
});

describe('ports of modules 14 (real), 16, 21 and 24', () => {
  it('approvals is the real module 14 (`engineApprovals`): request writes approval_requests, lockOpenForEntity finds it, cancel closes it', async () => {
    registerExpenseJobs();
    const t = await sequelize.transaction();
    try {
      expect(accountsPorts().approvals).toBe(engineApprovals);
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
      expect(r.status).toBe('PENDING'); // default rule 7.5: above Rs 5,000 one approver decides
      const row = (await ApprovalRequest.findByPk(r.id, { transaction: t }))!;
      expect([row.type, Number(row.entityId), Number(row.societyId), Number(row.requesterUserId)]).toEqual([
        'EXPENSE',
        7,
        w.sid,
        w.userId,
      ]);
      expect(await accountsPorts().approvals.lockOpenForEntity(w.sid, 'expense', 7, t)).toEqual({
        id: r.id,
        type: 'EXPENSE',
      });
      expect(await accountsPorts().approvals.lockOpenForEntity(w.sid + 1, 'expense', 7, t)).toBeNull();
      await accountsPorts().approvals.cancel(w.user, r.id, 'Entered twice', t);
      expect((await ApprovalRequest.findByPk(r.id, { transaction: t }))!.status).toBe('CANCELLED');
      expect(await accountsPorts().approvals.lockOpenForEntity(w.sid, 'expense', 7, t)).toBeNull();
    } finally {
      await t.rollback();
    }
  });

  it('registerType registers the approval type with module 14', () => {
    const def = {
      type: 'FUND_TRANSFER',
      onApproved: async () => undefined,
      onRejected: async () => undefined,
      describe: async () => [],
    };
    accountsPorts().approvals.registerType(def);
    expect(isRegistered('FUND_TRANSFER')).toBe(true);
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
    expect(PRODUCTION_REQUIRED_PORTS).toEqual(['notifications']); // approvals is the real module 14
    expect(fakePortsInUse()).toEqual([...PRODUCTION_REQUIRED_PORTS]);
    setAccountsPorts({ vendors: { exists: async () => true } });
    expect(fakePortsInUse()).toEqual([...PRODUCTION_REQUIRED_PORTS]); // vendors is not required in production
    setAccountsPorts({ notifications: { send: async () => undefined } });
    expect(fakePortsInUse()).toEqual([]);
    setAccountsPorts();
    expect(fakePortsInUse()).toEqual(['notifications']);
  });

  it('production refuses to start with placeholder notifications, development does not', () => {
    expect(() => assertAccountsPortsReady('development')).not.toThrow();
    expect(() => assertAccountsPortsReady('test')).not.toThrow();
    expect(() => assertAccountsPortsReady('production')).toThrow(/notifications/);
    setAccountsPorts({ notifications: { send: async () => undefined } });
    expect(() => assertAccountsPortsReady('production')).not.toThrow();
  });
});
