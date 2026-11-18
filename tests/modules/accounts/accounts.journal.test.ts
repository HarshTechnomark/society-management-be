import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalRequest,
  AuditLog,
  JournalEntry,
  JournalLine,
  LedgerAccount,
  closeDb,
  sequelize,
} from '../../../src/models';
import { advance } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { accountsPortCalls } from '../../../src/modules/accounts/accounts.ports';
import { registerJournalJobs } from '../../../src/modules/accounts/accounts.journal.jobs';
import {
  onJournalCancelled,
  onJournalChangesRequested,
} from '../../../src/modules/accounts/accounts.journal.service';
import { autoApproveType, decideOver } from '../../helpers/approvals-decide';
import { setAccountsPorts } from '../../../src/modules/accounts/accounts.ports';
import { idemH } from '../../helpers/billing-runs';
import { balanceOf, ctxOf, post } from '../../helpers/accounts';
import { memberOf } from '../../helpers/society-setup';
import { resetPayments, paymentsWorld } from '../../helpers/payments';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});

type World = Awaited<ReturnType<typeof paymentsWorld>>;
beforeEach(async () => {
  await resetPayments();
  setAccountsPorts();
  registerJournalJobs();
});

const lines = (amount = 50_000) => [
  { ledgerAccountCode: '5600', debitPaise: amount, creditPaise: 0 },
  { ledgerAccountCode: '1120', debitPaise: 0, creditPaise: amount },
];
const body = (o: Record<string, unknown> = {}) => ({
  date: '2026-11-03',
  narration: 'Bank charges adjustment',
  lines: lines(),
  ...o,
});
const draft = async (c: World['c'], o: Record<string, unknown> = {}) => {
  const r = await c('post', '/accounts/journals', body(o), { headers: idemH() });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data;
};
const submit = (c: World['c'], id: number, version: number) =>
  c('post', `/accounts/journals/${id}/submit`, { version }, { headers: idemH() });
const reverse = (c: World['c'], id: number, version: number, o: Record<string, unknown> = {}) =>
  c(
    'post',
    `/accounts/journals/${id}/reverse`,
    { reason: 'Posted by mistake', version, ...o },
    { headers: idemH() },
  );
/** The module 14 request of a journal entry. */
const reqOf = async (entryId: number) => Number((await JournalEntry.findByPk(entryId))!.approvalRequestId);
/** A decision in the module 14 inbox over HTTP (default: the chairman, `w.c`). */
const decideJ = (
  c: World['c'],
  entryId: number,
  d: 'approve' | 'reject' | 'request-changes' = 'approve',
  reason?: string,
) => reqOf(entryId).then(id => decideOver(c as never, id, d, reason));

/** Treasurer drafts and submits, the chairman approves in the module 14 inbox. */
async function posted(w: World) {
  const d = await draft(w.treasurer.c);
  const s = await submit(w.treasurer.c, d.id, d.version);
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  const ok = await decideJ(w.c, d.id);
  expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  return { id: d.id as number, req: { id: await reqOf(d.id) } };
}

describe('manual journal drafts (6.1, 8.11)', { timeout: 180_000 }, () => {
  it('creates a DRAFT with difference, no voucher number and a uuid ref; unbalanced drafts are allowed', async () => {
    const w = await paymentsWorld();
    const d = await draft(w.treasurer.c, { lines: [lines()[0], { ...lines()[1], creditPaise: 20_000 }] });
    expect(d).toMatchObject({
      status: 'DRAFT',
      voucherNo: null,
      source: 'MANUAL',
      refType: 'manual_journal',
      difference: 30_000,
      voucherType: 'JOURNAL',
      version: 1,
    });
    expect(d.refId).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.lines).toHaveLength(2);
    expect(d.lines[0]).toMatchObject({ ledgerAccountCode: '5600', ledgerAccountName: 'Bank charges' });
    expect(await balanceOf(w.society.id!, '1120')).toBe(0);
    expect(await AuditLog.count({ where: { action: 'accounts.journal.drafted' } })).toBe(1);
  });

  it('line rules: 422 for one line, both sides, group account, unknown code, system key, fund; 400 for a future date', async () => {
    const w = await paymentsWorld();
    const c = w.treasurer.c;
    const t = (o: Record<string, unknown>) => c('post', '/accounts/journals', body(o), { headers: idemH() });
    expect((await t({ lines: [lines()[0]] })).body.code).toBe('JOURNAL_LINE_INVALID');
    expect((await t({ lines: [{ ...lines()[0], creditPaise: 5 }, lines()[1]] })).body.code).toBe(
      'JOURNAL_LINE_INVALID',
    );
    expect((await t({ lines: [{ ...lines()[0], debitPaise: 0 }, lines()[1]] })).body.code).toBe(
      'JOURNAL_LINE_INVALID',
    );
    expect((await t({ lines: [{ ...lines()[0], ledgerAccountCode: '1110' }, lines()[1]] })).body.code).toBe(
      'ACCOUNT_NOT_POSTABLE',
    );
    expect((await t({ lines: [{ ...lines()[0], ledgerAccountCode: '9999' }, lines()[1]] })).body.code).toBe(
      'UNKNOWN_LEDGER_CODE',
    );
    expect((await t({ lines: [{ ...lines()[0], ledgerAccountCode: 'BANK' }, lines()[1]] })).body.code).toBe(
      'UNKNOWN_LEDGER_CODE',
    );
    expect((await t({ lines: [{ ...lines()[0], fundId: 999999 }, lines()[1]] })).body.code).toBe(
      'JOURNAL_LINE_INVALID',
    );
    const future = await t({ date: '2026-12-25' });
    expect([future.status, future.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await t({ voucherType: 'INVOICE' })).status).toBe(400);
  });

  it('a locked date is 409 PERIOD_LOCKED on create and on update', async () => {
    const w = await paymentsWorld();
    const d = await draft(w.treasurer.c);
    await sequelize.query(
      'UPDATE society_balances SET booksLockedThrough = "2026-09-30" WHERE societyId = ?',
      {
        replacements: [w.society.id],
      },
    );
    const r = await w.treasurer.c('post', '/accounts/journals', body({ date: '2026-09-15' }), {
      headers: idemH(),
    });
    expect([r.status, r.body.code]).toEqual([409, 'PERIOD_LOCKED']);
    const u = await w.treasurer.c('patch', `/accounts/journals/${d.id}`, { date: '2026-09-15', version: 1 });
    expect([u.status, u.body.code]).toEqual([409, 'PERIOD_LOCKED']);
  });

  it('PATCH replaces the lines, bumps the version, is maker only and checks the version', async () => {
    const w = await paymentsWorld();
    const d = await draft(w.treasurer.c);
    const ok = await w.treasurer.c('patch', `/accounts/journals/${d.id}`, {
      version: 1,
      narration: 'Corrected narration',
      date: '2026-11-02',
      lines: lines(70_000),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      version: 2,
      narration: 'Corrected narration',
      totalPaise: 70_000,
      entryDate: '2026-11-02',
    });
    expect(ok.body.data.lines.map((l: any) => l.debitPaise + l.creditPaise)).toEqual([70_000, 70_000]);
    const date = await w.treasurer.c('patch', `/accounts/journals/${d.id}`, {
      version: 2,
      date: '2026-11-01',
    });
    expect(date.body.data.lines.every((l: any) => l.lineNo > 0)).toBe(true);
    expect(
      (await JournalLine.findAll({ where: { journalEntryId: d.id } })).every(
        l => l.entryDate === '2026-11-01',
      ),
    ).toBe(true);
    const old = await w.treasurer.c('patch', `/accounts/journals/${d.id}`, {
      version: 1,
      narration: 'Another one',
    });
    expect([old.status, old.body.code]).toEqual([409, 'STALE_VERSION']);
    const other = await w.c('patch', `/accounts/journals/${d.id}`, {
      version: 3,
      narration: 'Not the maker',
    });
    expect(other.status).toBe(403);
  });

  it('cancel: maker or approver; committee member 403; posted 409 JOURNAL_IMMUTABLE; cancelled again 409 INVALID_STATE', async () => {
    const w = await paymentsWorld();
    const a = await draft(w.treasurer.c);
    const member = await memberOf(w.society, 'committee_member');
    expect((await member.c('delete', `/accounts/journals/${a.id}`)).body.code).toBe('PERMISSION_DENIED');
    const c1 = await w.treasurer.c('delete', `/accounts/journals/${a.id}`);
    expect([c1.status, c1.body.data.status]).toEqual([200, 'CANCELLED']);
    expect((await w.treasurer.c('delete', `/accounts/journals/${a.id}`)).body.code).toBe('INVALID_STATE');
    const b = await draft(w.treasurer.c);
    const c2 = await w.secretary.c('delete', `/accounts/journals/${b.id}`); // an approver, not the maker
    expect(c2.body.data.status).toBe('CANCELLED');
    expect(await AuditLog.count({ where: { action: 'accounts.journal.cancelled' } })).toBe(2);
    const { id } = await posted(w);
    const del = await w.treasurer.c('delete', `/accounts/journals/${id}`);
    expect([del.status, del.body.code]).toEqual([409, 'JOURNAL_IMMUTABLE']);
    const pat = await w.treasurer.c('patch', `/accounts/journals/${id}`, {
      version: 2,
      narration: 'Edit posted',
    });
    expect([pat.status, pat.body.code]).toEqual([409, 'JOURNAL_IMMUTABLE']);
  });

  it('Idempotency-Key replays the create', async () => {
    const w = await paymentsWorld();
    const headers = idemH();
    const a = await w.treasurer.c('post', '/accounts/journals', body(), { headers });
    const b = await w.treasurer.c('post', '/accounts/journals', body(), { headers });
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await JournalEntry.count({ where: { societyId: w.society.id, source: 'MANUAL' } })).toBe(1);
  });
});

describe('submit and the approval flow (6.1, T13 journal cases)', { timeout: 180_000 }, () => {
  it('unbalanced submit is 422 JOURNAL_NOT_BALANCED with the totals and nothing is requested', async () => {
    const w = await paymentsWorld();
    const d = await draft(w.treasurer.c, {
      lines: [lines(1_180_000)[0], { ...lines()[1], creditPaise: 1_080_000 }],
    });
    const r = await submit(w.treasurer.c, d.id, d.version);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('JOURNAL_NOT_BALANCED');
    expect(r.body.errors[0]).toMatchObject({ field: 'lines', debitPaise: 1_180_000, creditPaise: 1_080_000 });
    expect(await ApprovalRequest.count({ where: { type: 'MANUAL_JOURNAL' } })).toBe(0);
    expect((await JournalEntry.findByPk(d.id))!.status).toBe('DRAFT');
  });

  it('submit sends MANUAL_JOURNAL for approval; lines are frozen; approval posts in place with balances, number and audit', async () => {
    const w = await paymentsWorld();
    const d = await draft(w.treasurer.c);
    const s = await submit(w.treasurer.c, d.id, d.version);
    expect(s.body.data).toMatchObject({ status: 'PENDING_APPROVAL', version: 2 });
    const call = (await ApprovalRequest.findByPk(await reqOf(d.id)))!;
    expect({
      type: call.type,
      entityType: call.entityType,
      entityId: Number(call.entityId),
      amountPaise: Number(call.amountPaise),
      payload: call.payload,
      title: call.title,
      status: call.status,
    }).toEqual({
      type: 'MANUAL_JOURNAL',
      entityType: 'journal_entry',
      entityId: d.id,
      amountPaise: 50_000,
      payload: { date: '2026-11-03' },
      title: 'Bank charges adjustment',
      status: 'PENDING',
    });
    // pending: no edit, no second submit, no cancel via DELETE, lines frozen by the trigger or model hook
    expect(
      (await w.treasurer.c('patch', `/accounts/journals/${d.id}`, { version: 2, narration: 'Changed again' }))
        .body.code,
    ).toBe('INVALID_STATE');
    expect((await submit(w.treasurer.c, d.id, 2)).status).toBe(409);
    expect((await w.treasurer.c('delete', `/accounts/journals/${d.id}`)).body.code).toBe('INVALID_STATE');
    await expect(
      JournalLine.destroy({ where: { journalEntryId: d.id }, individualHooks: true }),
    ).rejects.toThrow();
    expect(await balanceOf(w.society.id!, '1120')).toBe(0);

    expect((await decideJ(w.c, d.id)).status).toBe(200);
    const got = await w.c('get', `/accounts/journals/${d.id}`);
    expect(got.body.data).toMatchObject({ status: 'POSTED', source: 'MANUAL', difference: 0 });
    expect(got.body.data.voucherNo).toMatch(/^JV\/2026-27\/\d{6}$/);
    expect(await balanceOf(w.society.id!, '1120')).toBe(-50_000);
    expect(await balanceOf(w.society.id!, '5600')).toBe(50_000);
    expect(got.body.data.timeline.map((x: any) => x.action)).toEqual([
      'accounts.journal.drafted',
      'accounts.journal.submitted',
      'accounts.journal.posted',
    ]);
  });

  it('maker-checker: the maker cannot approve their own journal (409 MAKER_CHECKER_VIOLATION), the entry stays pending', async () => {
    const w = await paymentsWorld();
    const d = await draft(w.treasurer.c);
    await submit(w.treasurer.c, d.id, d.version);
    const self = await decideJ(w.treasurer.c, d.id);
    expect([self.status, self.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    expect((await JournalEntry.findByPk(d.id))!.status).toBe('PENDING_APPROVAL');
  });

  it('approval into a period locked meanwhile fails with PERIOD_LOCKED and rolls back', async () => {
    const w = await paymentsWorld();
    const e = await draft(w.treasurer.c, { date: '2026-11-03' });
    await submit(w.treasurer.c, e.id, e.version);
    await sequelize.query(
      'UPDATE society_balances SET booksLockedThrough = "2026-11-05" WHERE societyId = ?',
      { replacements: [w.society.id] },
    );
    expect((await decideJ(w.c, e.id)).body.code).toBe('PERIOD_LOCKED');
    expect((await JournalEntry.findByPk(e.id))!.status).toBe('PENDING_APPROVAL');
  });

  it('rejection: REJECTED with the reason, audited, the maker is notified after commit; rejected cannot be edited or resubmitted', async () => {
    const w = await paymentsWorld();
    const d = await draft(w.treasurer.c);
    await submit(w.treasurer.c, d.id, d.version);
    accountsPortCalls.length = 0;
    expect((await decideJ(w.c, d.id, 'reject', 'Wrong head of account')).status).toBe(200);
    const e = (await JournalEntry.findByPk(d.id))!;
    expect([e.status, e.rejectionReason]).toEqual(['REJECTED', 'Wrong head of account']);
    const sent = accountsPortCalls.find(c => c.fn === 'notifications.send')!.input as any;
    expect(sent.template).toBe('accounts.journal_rejected');
    expect(sent.userIds).toEqual([w.treasurer.user.id]);
    expect(
      await AuditLog.count({ where: { action: 'accounts.journal.rejected', entityId: String(d.id) } }),
    ).toBe(1);
    expect((await submit(w.treasurer.c, d.id, e.version)).body.code).toBe('INVALID_STATE');
    expect(
      (await w.treasurer.c('patch', `/accounts/journals/${d.id}`, { version: e.version, narration: 'Edit' }))
        .body.code,
    ).toBe('INVALID_STATE');
  });

  it('request changes is not offered for MANUAL_JOURNAL (module 14 catalogue); onChangesRequested returns the draft to DRAFT and resubmit reuses the same approval request; withdraw cancels', async () => {
    const w = await paymentsWorld();
    const d = await draft(w.treasurer.c);
    await submit(w.treasurer.c, d.id, d.version);
    const no = await decideJ(w.c, d.id, 'request-changes', 'Split the lines');
    expect([no.status, no.body.code]).toEqual([422, 'CHANGES_NOT_SUPPORTED']);
    // the type still registers the callback (spec 9.3): run it as module 14 would, request state included
    await ApprovalRequest.update({ status: 'CHANGES_REQUESTED' } as never, {
      where: { id: await reqOf(d.id) },
    });
    const tx = await sequelize.transaction();
    await onJournalChangesRequested(ctxOf(w.society, w.user.id), d.id, tx);
    await tx.commit();
    const back = (await JournalEntry.findByPk(d.id))!;
    expect(back.status).toBe('DRAFT');
    const fix = await w.treasurer.c('patch', `/accounts/journals/${d.id}`, {
      version: back.version,
      lines: lines(60_000),
    });
    expect(fix.status, JSON.stringify(fix.body)).toBe(200);
    accountsPortCalls.length = 0;
    const again = await submit(w.treasurer.c, d.id, fix.body.data.version);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.status).toBe('PENDING_APPROVAL');
    expect((await ApprovalRequest.findByPk(await reqOf(d.id)))!.round).toBe(2); // same request, next round
    // maker withdraws the request: module 14 calls onCancelled
    const t = await sequelize.transaction();
    await onJournalCancelled(ctxOf(w.society, w.treasurer.user.id), d.id, t);
    await t.commit();
    expect((await JournalEntry.findByPk(d.id))!.status).toBe('CANCELLED');
  });

  it('auto-approve by module 14 posts the draft at once', async () => {
    const w = await paymentsWorld();
    await autoApproveType('MANUAL_JOURNAL', w.society.id!);
    const d = await draft(w.treasurer.c);
    const r = await submit(w.treasurer.c, d.id, d.version);
    expect(r.body.data.status).toBe('POSTED');
    expect(r.body.data.voucherNo).toMatch(/^JV\//);
    expect(await balanceOf(w.society.id!, '1120')).toBe(-50_000);
  });

  it('only the maker can submit', async () => {
    const w = await paymentsWorld();
    const d = await draft(w.treasurer.c);
    expect((await submit(w.c, d.id, d.version)).status).toBe(403);
  });
});

describe('reverse (BR-13-5, T13-07)', { timeout: 180_000 }, () => {
  it('reverses a posted manual journal once with swapped lines; the reversal cannot be reversed; maker cannot reverse', async () => {
    const w = await paymentsWorld();
    const { id } = await posted(w);
    expect((await reverse(w.treasurer.c, id, 2)).body.code).toBe('MAKER_CHECKER_VIOLATION');
    const r = await reverse(w.c, id, 2);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.reversedBy).toMatchObject({ id: r.body.data.reversalEntryId });
    expect(await balanceOf(w.society.id!, '1120')).toBe(0);
    expect(await balanceOf(w.society.id!, '5600')).toBe(0);
    const rev = await w.c('get', `/accounts/journals/${r.body.data.reversalEntryId}`);
    expect(rev.body.data).toMatchObject({
      status: 'POSTED',
      reversalOfId: id,
      source: 'MANUAL',
      difference: 0,
    });
    expect(rev.body.data.reversalOf.id).toBe(id);
    expect(rev.body.data.lines.map((l: any) => [l.ledgerAccountCode, l.debitPaise, l.creditPaise])).toEqual([
      ['5600', 0, 50_000],
      ['1120', 50_000, 0],
    ]);
    expect((await reverse(w.c, id, 2)).body.code).toBe('JOURNAL_ALREADY_REVERSED');
    const again = await reverse(w.c, r.body.data.reversalEntryId, 1);
    expect([again.status, again.body.code]).toEqual([422, 'REVERSAL_NOT_ALLOWED']);
  });

  it('system entries, drafts and stale versions are refused; reason is required; permission and step-up apply', async () => {
    const w = await paymentsWorld();
    const sys = await post(ctxOf(w.society, null), {
      date: '2026-11-02',
      voucherType: 'JOURNAL',
      refType: 'test_source',
      refId: 1,
      narration: 'System posting',
      lines: lines(),
    });
    const s = await reverse(w.c, sys.id, 1);
    expect([s.status, s.body.code]).toEqual([422, 'REVERSAL_NOT_ALLOWED']);
    const d = await draft(w.treasurer.c);
    expect((await reverse(w.c, d.id, 1)).body.code).toBe('INVALID_STATE');
    const { id } = await posted(w);
    expect((await reverse(w.c, id, 1)).body.code).toBe('STALE_VERSION');
    expect(
      (
        await w.c(
          'post',
          `/accounts/journals/${id}/reverse`,
          { reason: 'x', version: 2 },
          { headers: idemH() },
        )
      ).status,
    ).toBe(400);
    expect((await reverse(w.secretary.c, id, 2)).status).toBe(200); // a holder of finance.accounts.approve
    const id2 = (await posted(w)).id;
    advance(10 * 60_000);
    const stale = await reverse(w.c, id2, 2);
    expect([stale.status, stale.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    // requests that can never succeed fail before the step-up asks for a code
    expect((await reverse(w.treasurer.c, id2, 2)).body.code).toBe('MAKER_CHECKER_VIOLATION');
    expect((await reverse(w.c, id, 2)).body.code).toBe('JOURNAL_ALREADY_REVERSED');
    expect((await reverse(w.c, sys.id, 1)).body.code).toBe('REVERSAL_NOT_ALLOWED');
    const acct = await memberOf(w.society, 'accountant'); // creates, cannot approve
    expect((await reverse(acct.c, id2, 2)).body.code).toBe('PERMISSION_DENIED');
  });

  it('reversal into a locked date is 409 PERIOD_LOCKED; a past reversal date in the open period is accepted', async () => {
    const w = await paymentsWorld();
    const { id } = await posted(w);
    await sequelize.query(
      'UPDATE society_balances SET booksLockedThrough = "2026-11-02" WHERE societyId = ?',
      { replacements: [w.society.id] },
    );
    const l = await reverse(w.c, id, 2, { reversalDate: '2026-11-01' });
    expect([l.status, l.body.code]).toEqual([409, 'PERIOD_LOCKED']);
    const f = await reverse(w.c, id, 2, { reversalDate: '2027-01-01' });
    expect(f.status).toBe(400);
    const ok = await reverse(w.c, id, 2, { reversalDate: '2026-11-04' });
    expect(ok.status).toBe(200);
  });
});

describe('list and detail (8.11)', { timeout: 180_000 }, () => {
  it('lists system and manual vouchers with filters, sorting and pagination; detail has source link and lines', async () => {
    const w = await paymentsWorld();
    const sys = ctxOf(w.society, null);
    for (const [i, amt] of [10_000, 20_000, 30_000].entries())
      await post(sys, {
        date: `2026-11-0${i + 1}`,
        voucherType: i === 0 ? 'PAYMENT' : 'JOURNAL',
        refType: 'expense',
        refId: i + 1,
        narration: `Expense number ${i + 1}`,
        lines: lines(amt),
      });
    const { id } = await posted(w);
    const all = await w.c('get', '/accounts/journals');
    expect(all.status).toBe(200);
    expect(all.body.pagination).toMatchObject({ page: 1, limit: 20, total: 4 });
    expect(all.body.data.map((e: any) => e.source).sort()).toEqual(['MANUAL', 'SYSTEM', 'SYSTEM', 'SYSTEM']);
    const q = (query: Record<string, unknown>) =>
      w.c('get', '/accounts/journals', undefined, { query: query as any });
    expect((await q({ source: 'MANUAL' })).body.data.map((e: any) => e.id)).toEqual([id]);
    expect(
      (await q({ refType: 'expense', sortBy: 'totalPaise', sortOrder: 'asc' })).body.data.map(
        (e: any) => e.totalPaise,
      ),
    ).toEqual([10_000, 20_000, 30_000]);
    expect((await q({ voucherType: 'PAYMENT' })).body.pagination.total).toBe(1);
    expect((await q({ from: '2026-11-02', to: '2026-11-02' })).body.data).toHaveLength(1);
    expect(
      (await q({ minAmountPaise: 20_000, maxAmountPaise: 30_000, refType: 'expense' })).body.pagination.total,
    ).toBe(2);
    expect((await q({ q: 'number 3' })).body.pagination.total).toBe(1);
    expect((await q({ status: 'DRAFT,POSTED' })).body.pagination.total).toBe(4);
    expect((await q({ limit: 2, page: 2 })).body.data).toHaveLength(2);
    const cashId = Number(
      (await LedgerAccount.findOne({ where: { societyId: w.society.id, code: '1120' } }))!.id,
    );
    expect((await q({ ledgerAccountId: cashId })).body.pagination.total).toBe(4);
    expect((await q({ fundId: 99999 })).body.pagination.total).toBe(0);
    expect((await q({ limit: 500 })).status).toBe(400);
    const d = await w.c(
      'get',
      `/accounts/journals/${all.body.data.find((e: any) => e.refType === 'expense').id}`,
    );
    expect(d.body.data.sourceLink).toMatchObject({
      refType: 'expense',
      label: expect.stringContaining('Expense'),
    });
    expect(d.body.data.lines).toHaveLength(2);
    expect(d.body.data.timeline.map((x: any) => x.action)).toContain('accounts.journal.posted');
  });

  it('plan gating: a lower plan gets 402 FEATURE_NOT_IN_PLAN on reads and writes (T13-37)', async () => {
    const w = await paymentsWorld({ plan: 'STARTER' });
    for (const [m, p, b] of [
      ['get', '/accounts/journals', undefined],
      ['post', '/accounts/journals', body()],
    ] as const) {
      const r = await w.c(m, p, b, { headers: m === 'post' ? idemH() : undefined });
      expect([r.status, r.body.code], p).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    }
  });

  it('an auditor can read but not write (403 PERMISSION_DENIED); another society sees 404 JOURNAL_NOT_FOUND (T13-35, T13-36)', async () => {
    const w = await paymentsWorld();
    const other = await paymentsWorld();
    const auditor = await memberOf(w.society, 'auditor');
    expect((await auditor.c('post', '/accounts/journals', body(), { headers: idemH() })).body.code).toBe(
      'PERMISSION_DENIED',
    );
    expect((await auditor.c('get', '/accounts/journals')).status).toBe(200);
    const d = await draft(w.treasurer.c);
    for (const [m, p, b] of [
      ['get', `/accounts/journals/${d.id}`, undefined],
      ['patch', `/accounts/journals/${d.id}`, { version: 1, narration: 'Hijack' }],
      ['post', `/accounts/journals/${d.id}/submit`, { version: 1 }],
      ['delete', `/accounts/journals/${d.id}`, undefined],
      ['post', `/accounts/journals/${d.id}/reverse`, { reason: 'Not yours', version: 1 }],
    ] as const) {
      const r = await other.c(m, p, b, { headers: idemH() });
      expect([r.status, r.body.code], `${m} ${p}`).toEqual([404, 'JOURNAL_NOT_FOUND']);
    }
    // the other society's list never shows these rows
    expect((await other.c('get', '/accounts/journals')).body.pagination.total).toBe(0);
  });

  it('posted entries are immutable at the database level (T13-06)', async () => {
    const w = await paymentsWorld();
    const { id } = await posted(w);
    const e = (await JournalEntry.findByPk(id))!;
    await expect(e.update({ narration: 'Tampered' })).rejects.toThrow();
    await expect(
      JournalLine.update({ debitPaise: 1 }, { where: { journalEntryId: id }, individualHooks: true }),
    ).rejects.toThrow();
    expect((await JournalEntry.findByPk(id))!.narration).toBe('Bank charges adjustment');
  });
});
