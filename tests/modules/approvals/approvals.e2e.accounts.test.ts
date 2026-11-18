import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalRequest, Expense, JournalEntry, closeDb } from '../../../src/models';
import { resetLogins } from '../../helpers/access';
import { memberOf } from '../../helpers/society-setup';
import { freshStepName } from '../../../src/modules/approvals/approvals.catalogue';
import { humanFacts } from '../../../src/modules/approvals/approvals.facts';
import { balanceOf } from '../../helpers/accounts';
import { decideOver } from '../../helpers/approvals-decide';
import { bill, expBody, expWorld, idemH, resetExpenses } from '../../helpers/accounts-expenses';

/** Module 13 expenses on the real module 14 engine with the 7.5 default rules (auto up to Rs 5,000), all decided over HTTP. */
afterAll(closeDb);
beforeEach(async () => {
  resetLogins();
  await resetExpenses();
});

const fresh = async (id: number) => (await Expense.findByPk(id))!;

describe('expenses through the default EXPENSE rules (HTTP)', () => {
  it('Rs 1,000 auto-approves and posts at once, Rs 6,000 is pending until a second member approves', async () => {
    const w = await expWorld({ defaultRules: true });
    const small = await w.c('post', '/expenses', expBody(w, { grossAmountPaise: 100_000 }), {
      headers: idemH(),
    });
    expect(small.status, JSON.stringify(small.body)).toBe(201);
    expect(small.body.data.status).toBe('POSTED');
    expect(small.body.data.approvalRequired).toBe(false);
    expect(small.body.data.approvalThresholdPaise).toBe(500_000);

    const big = await w.c(
      'post',
      '/expenses',
      expBody(w, { grossAmountPaise: 600_000, fileIds: [bill(w, w.user.id)] }),
      {
        headers: idemH(),
      },
    );
    expect(big.status, JSON.stringify(big.body)).toBe(201);
    expect(big.body.data.status).toBe('PENDING_APPROVAL');
    expect(big.body.data.approvalRequired).toBe(true);
    const id = big.body.data.id as number;
    const e0 = await fresh(id);
    expect(e0.journalEntryId).toBeNull();
    const requestId = Number(e0.approvalRequestId);
    expect((await ApprovalRequest.findByPk(requestId))!.status).toBe('PENDING');

    const d = await decideOver(w.treasurer.c as never, requestId, 'approve');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const e = await fresh(id);
    expect(e.status).toBe('POSTED');
    expect(e.approvedBy).toBe(w.treasurer.user.id);
    expect(e.journalEntryId).not.toBeNull();
    expect(await JournalEntry.findByPk(Number(e.journalEntryId))).not.toBeNull();
    expect((await ApprovalRequest.findByPk(requestId))!.status).toBe('APPROVED');
    expect(await balanceOf(w.sid, '5350')).toBe(100_000 + 600_000);
  });

  it('a rejected expense comes back editable and can be submitted again', async () => {
    const w = await expWorld({ defaultRules: true });
    const p = (
      await w.c(
        'post',
        '/expenses',
        expBody(w, { grossAmountPaise: 600_000, fileIds: [bill(w, w.user.id)] }),
        { headers: idemH() },
      )
    ).body.data;
    const requestId = Number((await fresh(p.id)).approvalRequestId);
    const rj = await decideOver(w.treasurer.c as never, requestId, 'reject', 'Wrong head');
    expect(rj.status, JSON.stringify(rj.body)).toBe(200);
    const e = await fresh(p.id);
    expect([e.status, e.rejectionReason, e.journalEntryId]).toEqual(['REJECTED', 'Wrong head', null]);
    const ed = await w.c('patch', `/expenses/${p.id}`, { description: 'Fixed', version: Number(e.version) });
    expect(ed.body.data).toMatchObject({ status: 'DRAFT', rejectionReason: null });
    const sub = await w.c(
      'post',
      `/expenses/${p.id}/submit`,
      { version: ed.body.data.version },
      { headers: idemH() },
    );
    expect(sub.body.data.status).toBe('PENDING_APPROVAL');
  });
});

describe('request detail', () => {
  it('is 404 for a member who is neither requester, approver nor rule manager; rejected steps say NOT_NEEDED', async () => {
    const w = await expWorld({ defaultRules: true });
    const p = (
      await w.c(
        'post',
        '/expenses',
        expBody(w, { grossAmountPaise: 3_000_000, fileIds: [bill(w, w.user.id)] }),
        {
          headers: idemH(),
        },
      )
    ).body.data;
    const requestId = Number((await fresh(p.id)).approvalRequestId);
    const fm = await memberOf(w.society, 'facility_manager');
    expect((await fm.c('get', `/approvals/${requestId}`)).status).toBe(404);
    const own = await w.treasurer.c('get', `/approvals/${requestId}`);
    expect(own.status).toBe(200);
    expect(own.body.data.steps[0].name).toBe('Two of Chairman, Treasurer, Secretary');
    await decideOver(w.treasurer.c as never, requestId, 'reject', 'Not needed now');
    const after = await w.treasurer.c('get', `/approvals/${requestId}`);
    expect(after.body.data.steps.every((x: any) => x.state !== 'UPCOMING')).toBe(true);
    const all = await w.treasurer.c('get', '/approvals?scope=all_pending');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const done = await w.treasurer.c('get', '/approvals?scope=decided');
    expect(done.body.data[0]).toMatchObject({
      status: 'REJECTED',
      decidedBy: { userId: w.treasurer.user.id },
      decisionComment: 'Not needed now',
    });
    expect(done.body.data[0].decidedAt).toBeTruthy();
  });
});

describe('summary wording', () => {
  it('humanFacts: rupees in Indian format, dates as dd Mon yyyy, readable codes', () => {
    const out = humanFacts([
      { label: 'Fees', value: '25600 rupees', kind: 'text' },
      { label: 'Deposit', value: '27300000 paise', kind: 'text' },
      { label: 'Dues', value: 'Rs 0.00', kind: 'text' },
      { label: 'Total', value: '1234500', kind: 'money' },
      { label: 'Policy', value: 'MUST_CLEAR', kind: 'text' },
      { label: 'Dates', value: '2026-11-05 to 2026-11-09', kind: 'text' },
    ] as never).map(f => f.value);
    expect(out).toEqual([
      '₹25,600',
      '₹2,73,000',
      '₹0',
      '₹12,345',
      'Must clear',
      '05 Nov 2026 to 09 Nov 2026',
    ]);
  });
  it('freshStepName follows the current roles but keeps a typed name', () => {
    const base = { mode: 'ANY_OF' as const, userIds: [], requiredCount: null };
    expect(
      freshStepName({ ...base, name: 'Treasurer or Chairman', roleKeys: ['treasurer', 'secretary'] }),
    ).toBe('Treasurer or Secretary');
    expect(freshStepName({ ...base, name: 'Final sign off', roleKeys: ['treasurer'] })).toBe(
      'Final sign off',
    );
  });
});
