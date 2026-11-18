import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovalAction,
  ApprovalDelegation,
  ApprovalRequest,
  AuditLog,
  closeDb,
  sequelize,
} from '../../../src/models';
import { AppError } from '../../../src/utils/errors';
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';
import { request } from '../../../src/modules/approvals/approvals.engine';
import { addDays, advance, now } from '../../../src/lib/clock';
import { setKv, MemoryKv } from '../../../src/lib/kv';
import { registerType } from '../../../src/modules/approvals/approvals.registry';
import { as, idem, login, makeSociety, memberUser, resetLogins } from '../../helpers/access';
import {
  approvalsWorld,
  events,
  failNext,
  handlerCalls,
  settle,
  type ApprovalsWorld,
} from '../../helpers/approvals';

afterAll(closeDb);

let w: ApprovalsWorld;
beforeEach(async () => {
  setKv(new MemoryKv());
  resetLogins();
  w = await approvalsWorld();
});

const caller = async (role: string) => as(await login(w.users[role]!));
const row = async (id: number) => (await ApprovalRequest.findByPk(id))!;
/** The Facility Manager holds the inbox but neither the view nor the approve permission of payments (T14-37 outsider). */
const payment = (entityId = 100) =>
  w.raise(w.people.accountant!, { type: 'OFFLINE_PAYMENT', entityId, amountPaise: 500_000 });
/** A ₹48,000 expense by the Accountant: two of Chairman, Treasurer, Secretary, step-up required. */
const bigExpense = (entityId = 1, amountPaise = 4_800_000) =>
  w.raise(w.people.accountant!, { type: 'EXPENSE', entityId, amountPaise, title: 'Lift AMC' });

describe('8.1 inbox list', () => {
  it('FOR_ME shows what the caller can decide; ALL_PENDING adds what they may see; the maker and an outsider differ', async () => {
    const r = await bigExpense();
    const t = await caller('treasurer');
    const forMe = await t('get', '/approvals');
    expect(forMe.status).toBe(200);
    expect(forMe.body.pagination.total).toBe(1);
    expect(forMe.body.meta.truncated).toBe(false);
    expect(forMe.body.data[0]).toMatchObject({
      id: r.id,
      type: 'EXPENSE',
      typeLabel: 'Expense',
      status: 'PENDING',
      approvalsNeeded: 2,
      approvalsGiven: 0,
      stepUpRequired: true,
      bulkEligible: false,
      isOverdue: false,
      version: 1,
      myAction: { canAct: true, onBehalfOf: null, reason: null },
    });
    expect(forMe.body.data[0].requester.name).toBe('accountant');
    // the Accountant raised it: not "for me", but visible in ALL_PENDING and in submitted
    const a = await caller('accountant');
    expect((await a('get', '/approvals/submitted')).body.data).toHaveLength(1);
    // the Accountant has no inbox permission (T14-38)
    expect((await a('get', '/approvals')).status).toBe(403);
    // the Facility Manager has no view permission of payments (T14-37)
    const pay = await payment();
    const fm = await caller('facility_manager');
    const fmAll = await fm('get', '/approvals', undefined, { query: { view: 'ALL_PENDING' } });
    expect(fmAll.body.data.map((x: any) => x.id)).not.toContain(pay.id);
    expect((await fm('get', '/approvals')).body.data).toEqual([]);
    const c = await caller('chairman');
    expect(
      (await c('get', '/approvals', undefined, { query: { view: 'ALL_PENDING' } })).body.data,
    ).toHaveLength(2);
  });

  it('a maker who also holds inbox.view sees the reason MAKER_CHECKER and no entry in FOR_ME', async () => {
    const r = await w.raise(w.people.chairman!, { type: 'EXPENSE', entityId: 2, amountPaise: 3_000_000 });
    const c = await caller('chairman');
    expect((await c('get', '/approvals')).body.data).toEqual([]);
    const all = await c('get', '/approvals', undefined, { query: { view: 'ALL_PENDING' } });
    expect(all.body.data[0].id).toBe(r.id);
    expect(all.body.data[0].myAction).toMatchObject({ canAct: false, reason: 'MAKER_CHECKER' });
  });

  it('filters: type, text, overdue, dates, sort; bad values are 400', async () => {
    await bigExpense(1, 4_800_000);
    await w.raise(w.people.accountant!, {
      type: 'EXPENSE',
      entityId: 2,
      amountPaise: 1_000_000,
      title: 'Garden tools',
    });
    await w.raise(null, { type: 'BOOKING', entityId: 3, title: 'Clubhouse' });
    const t = await caller('chairman');
    const q = (query: Record<string, string>) => t('get', '/approvals', undefined, { query });
    expect((await q({ view: 'ALL_PENDING', type: 'BOOKING' })).body.data).toHaveLength(1);
    expect((await q({ view: 'ALL_PENDING', q: 'garden' })).body.data.map((x: any) => x.title)).toEqual([
      'Garden tools',
    ]);
    const sorted = await q({ view: 'ALL_PENDING', type: 'EXPENSE', sortBy: 'amountPaise', sortOrder: 'asc' });
    expect(sorted.body.data.map((x: any) => x.amountPaise)).toEqual([1_000_000, 4_800_000]);
    expect((await q({ view: 'ALL_PENDING', overdue: 'true' })).body.data).toEqual([]);
    await ApprovalRequest.update({ dueAt: new Date('2026-11-09T00:00:00Z') }, { where: { type: 'EXPENSE' } });
    expect((await q({ view: 'ALL_PENDING', overdue: 'true', type: 'EXPENSE' })).body.data).toHaveLength(2);
    expect(
      (await q({ view: 'ALL_PENDING', from: '2026-11-10', to: '2026-11-10' })).body.data.length,
    ).toBeGreaterThan(0);
    expect((await q({ view: 'ALL_PENDING', from: '2027-01-01' })).body.data).toEqual([]);
    expect((await q({ view: 'ALL_PENDING', limit: '1' })).body.pagination).toMatchObject({
      limit: 1,
      total: 3,
      totalPages: 3,
    });
    const badQueries: Record<string, string>[] = [
      { view: 'NOPE' },
      { type: 'NOPE' },
      { q: 'a' },
      { from: '2026-12-01', to: '2026-11-01' },
      { sortBy: 'x' },
      { status: 'APPROVED' },
      { from: '2025-01-01', to: '2026-11-01' },
    ];
    for (const bad of badQueries) {
      const r = await q(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('DECIDED lists closed requests the caller may see, filtered by status', async () => {
    const r = await bigExpense();
    const c = await caller('chairman');
    await c(
      'post',
      `/approvals/${r.id}/reject`,
      { version: 1, reason: 'Not now, thanks' },
      { headers: idem() },
    );
    const s = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 5, amountPaise: 700_000 });
    await c('post', `/approvals/${s.id}/approve`, { version: 1 }, { headers: idem() });
    const all = await c('get', '/approvals', undefined, { query: { view: 'DECIDED' } });
    const pay = await payment(101);
    await c('post', `/approvals/${pay.id}/approve`, { version: 1 }, { headers: idem() });
    const all2 = await c('get', '/approvals', undefined, { query: { view: 'DECIDED' } });
    expect(all2.body.data.map((x: any) => x.status).sort()).toEqual(['APPROVED', 'APPROVED', 'REJECTED']);
    expect(all.body.data.map((x: any) => x.status).sort()).toEqual(['APPROVED', 'REJECTED']);
    const rej = await c('get', '/approvals', undefined, { query: { view: 'DECIDED', status: 'REJECTED' } });
    expect(rej.body.data.map((x: any) => x.id)).toEqual([r.id]);
    // the Facility Manager neither holds the view permission nor acted
    const fm = await caller('facility_manager');
    const fmIds = (await fm('get', '/approvals', undefined, { query: { view: 'DECIDED' } })).body.data.map(
      (x: any) => x.id,
    );
    expect(fmIds).not.toContain(pay.id);
    expect(fmIds).toContain(s.id);
  });
});

describe('8.2 counts, 8.3 submitted, 8.4 types', () => {
  it('counts follow the epoch: a new request bumps it and the eligible user sees +1 (T14-41)', async () => {
    const t = await caller('treasurer');
    expect((await t('get', '/approvals/counts')).body.data).toMatchObject({
      forMe: 0,
      allPending: 0,
      stuck: 0,
    });
    events.length = 0;
    await bigExpense(1);
    await settle();
    const after = await t('get', '/approvals/counts');
    expect(after.body.data).toMatchObject({
      forMe: 1,
      forMeByType: { EXPENSE: 1 },
      allPending: 1,
      overdueForMe: 0,
    });
    expect(
      events.some(e => e.event === 'approvals.changed' && e.room === `society:${w.society.id}:admin`),
    ).toBe(true);
    await bigExpense(2);
    await settle();
    expect((await t('get', '/approvals/counts')).body.data.forMe).toBe(2);
    const a = await caller('accountant');
    expect((await a('get', '/approvals/counts')).status).toBe(403);
  });

  it("submitted lists the caller's own requests with any status filter", async () => {
    const r = await bigExpense();
    const a = await caller('accountant');
    const mine = await a('get', '/approvals/submitted');
    expect(mine.body.data.map((x: any) => x.id)).toEqual([r.id]);
    expect(
      (await a('get', '/approvals/submitted', undefined, { query: { status: 'REJECTED' } })).body.data,
    ).toEqual([]);
    const t = await caller('treasurer');
    expect((await t('get', '/approvals/submitted')).body.data).toEqual([]);
  });

  it('types carries the catalogue with cancellable and alwaysStepUp', async () => {
    const c = await caller('chairman');
    const r = await c('get', '/approvals/types');
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.data.map((x: any) => [x.type, x]));
    expect(by.EXPENSE).toMatchObject({
      label: 'Expense',
      isMoney: true,
      allowBulk: true,
      cancellable: true,
      alwaysStepUp: false,
    });
    expect(by.PERIOD_UNLOCK.alwaysStepUp).toBe(true);
    expect(by.NOTICE_PUBLISH.cancellable).toBe(false);
    expect(r.body.data.length).toBe(31);
  });
});

describe('8.5 history and 8.6 detail', () => {
  it('detail has steps, the owner description (phones masked), actions and what I can do', async () => {
    registerType(
      'EXPENSE',
      {
        onApproved: async () => {},
        onRejected: async () => {},
        onCancelled: async () => {},
        describe: () => ({
          facts: [
            { label: 'Payee', value: 'Shree Ganesh', kind: 'text' },
            { label: 'Phone', value: '9820012345', kind: 'text' },
          ],
          link: '/money/expenses/1',
        }),
      },
      { replace: true },
    );
    const r = await bigExpense();
    const t = await caller('treasurer');
    await t('post', `/approvals/${r.id}/approve`, { version: 1 }, { headers: idem() });
    const d = (await t('get', `/approvals/${r.id}`)).body.data;
    const masked = (await (await caller('accountant'))('get', `/approvals/${r.id}`)).body.data;
    expect(d.description.facts[1].value).toBe('9820012345'); // the Treasurer holds residents.contacts.view
    expect(masked.description.facts[1].value).toBe('98XXXXX345');
    expect(d.typeLabel).toBe('Expense');
    expect(d).toMatchObject({
      id: r.id,
      type: 'EXPENSE',
      status: 'PENDING',
      routing: 'STEPS',
      ruleName: 'Expenses above ₹25,000',
      stepUpRequired: true,
      stepUpAbovePaise: 2_500_000,
      version: 2,
    });
    expect(d.steps).toHaveLength(1);
    expect(d.steps[0]).toMatchObject({
      stepNo: 1,
      mode: 'N_OF',
      requiredCount: 2,
      approvalsGiven: 1,
      state: 'CURRENT',
      approvedBy: ['treasurer'],
    });
    expect(d.steps[0].slots.map((s: any) => s.label)).toEqual(['Chairman', 'Treasurer', 'Secretary']);
    expect(d.description.link).toBe('/money/expenses/1');
    expect(d.actions.map((a: any) => a.action)).toEqual(['SUBMITTED', 'APPROVED']);
    // already acted: cannot act again
    expect(d.myAction).toMatchObject({ canApprove: false, canCancel: false, reason: 'ALREADY_ACTED' });
    const c = (await (await caller('chairman'))('get', `/approvals/${r.id}`)).body.data;
    expect(c.myAction).toMatchObject({ canApprove: true, canReject: true, canRequestChanges: true });
    const a = (await (await caller('accountant'))('get', `/approvals/${r.id}`)).body.data;
    expect(a.myAction.canCancel).toBe(true);
  });

  it('a describe that throws falls back to the payload facts', async () => {
    registerType(
      'NOTICE_PUBLISH',
      {
        onApproved: async () => {},
        onRejected: async () => {},
        describe: () => {
          throw new Error('boom');
        },
      },
      { replace: true },
    );
    const r = await w.raise(w.people.accountant!, {
      type: 'NOTICE_PUBLISH',
      entityId: 9,
      payload: { subject: 'Water cut' },
    });
    const c = await caller('chairman');
    const d = (await c('get', `/approvals/${r.id}`)).body.data;
    expect(d.description.facts).toEqual([{ label: 'subject', value: 'Water cut', kind: 'text' }]);
  });

  it('history lists the requests of an entity the caller may see; nothing else leaks', async () => {
    const r = await bigExpense(77);
    const c = await caller('chairman');
    await c(
      'post',
      `/approvals/${r.id}/reject`,
      { version: 1, reason: 'Too expensive' },
      { headers: idem() },
    );
    const h = await c('get', '/approvals/history', undefined, {
      query: { entityType: 'expense', entityId: '77' },
    });
    expect(h.status).toBe(200);
    expect(h.body.data).toHaveLength(1);
    expect(h.body.data[0]).toMatchObject({
      id: r.id,
      status: 'REJECTED',
      routing: 'STEPS',
      ruleName: 'Expenses above ₹25,000',
    });
    expect(h.body.data[0].actions.map((a: any) => a.action)).toEqual(['SUBMITTED', 'REJECTED']);
    expect(h.body.data[0].actions[1]).toMatchObject({
      actorName: 'chairman',
      actorRoleKey: 'chairman',
      comment: 'Too expensive',
    });
    const pay = await payment(78);
    const fm = await caller('facility_manager');
    const hidden = await fm('get', '/approvals/history', undefined, {
      query: { entityType: 'payment', entityId: '78' },
    });
    expect(pay.id).toBeGreaterThan(0);
    expect(hidden.status).toBe(200);
    expect(hidden.body.data).toEqual([]);
    expect(
      (await c('get', '/approvals/history', undefined, { query: { entityType: 'nope', entityId: '1' } }))
        .status,
    ).toBe(400);
  });

  it('an invisible request id and an unknown id are both 404 APPROVAL_NOT_FOUND (T14-37)', async () => {
    const r = await payment();
    const fm = await caller('facility_manager');
    for (const [m, p, b] of [
      ['get', `/approvals/${r.id}`, undefined],
      ['post', `/approvals/${r.id}/approve`, { version: 1 }],
      ['post', `/approvals/${r.id}/reject`, { version: 1, reason: 'No thanks' }],
      ['get', '/approvals/999999', undefined],
    ] as const) {
      const res = await fm(m, p, b, { headers: idem() });
      expect(res.status, `${m} ${p}`).toBe(404);
      expect(res.body.code).toBe('APPROVAL_NOT_FOUND');
    }
    const t = await caller('treasurer');
    const gone = await t('get', '/approvals/999999');
    expect(gone.status).toBe(404);
    expect(gone.body.code).toBe('APPROVAL_NOT_FOUND');
    expect((await row(r.id)).status).toBe('PENDING');
  });
});

describe('8.7 to 8.9 decisions', () => {
  it('two approvals complete the step; the second needs a fresh sign-in (step-up); the Idempotency-Key replays (T14-11, T14-13)', async () => {
    const r = await bigExpense();
    const t = await caller('treasurer');
    const c = await caller('chairman');
    const key = idem();
    const first = await t(
      'post',
      `/approvals/${r.id}/approve`,
      { version: 1, comment: 'Matches contract' },
      { headers: key },
    );
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      status: 'PENDING',
      stepCompleted: false,
      version: 2,
      totalSteps: 1,
    });
    const replay = await t(
      'post',
      `/approvals/${r.id}/approve`,
      { version: 1, comment: 'Matches contract' },
      { headers: key },
    );
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(await ApprovalAction.count({ where: { requestId: r.id, action: 'APPROVED' } })).toBe(1);
    // missing key
    expect((await c('post', `/approvals/${r.id}/approve`, { version: 2 })).status).toBe(400);
    // 20 minutes later the sign-in is too old for a step-up approval
    advance(6 * 60_000);
    const stale = await c('post', `/approvals/${r.id}/approve`, { version: 2 }, { headers: idem() });
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
    expect((await row(r.id)).status).toBe('PENDING');
    expect(handlerCalls.filter(h => h.fn === 'onApproved')).toHaveLength(0);
  });

  it('final approval runs the handler; approving again is APPROVAL_NOT_PENDING; a wrong version is STALE_VERSION', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 3, amountPaise: 2_000_000 });
    const c = await caller('chairman');
    const stale = await c('post', `/approvals/${r.id}/approve`, { version: 9 }, { headers: idem() });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    const done = await c('post', `/approvals/${r.id}/approve`, { version: 1 }, { headers: idem() });
    expect(done.body).toMatchObject({
      message: 'Approved',
      data: { status: 'APPROVED', stepCompleted: true, version: 2 },
    });
    expect(handlerCalls.filter(h => h.fn === 'onApproved')).toHaveLength(1);
    const again = await c('post', `/approvals/${r.id}/approve`, { version: 2 }, { headers: idem() });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('APPROVAL_NOT_PENDING');
  });

  it('the requester cannot approve their own request (T14-09) and an ineligible role is refused', async () => {
    const r = await w.raise(w.people.chairman!, { type: 'EXPENSE', entityId: 4, amountPaise: 3_000_000 });
    const c = await caller('chairman');
    const own = await c('post', `/approvals/${r.id}/approve`, { version: 1 }, { headers: idem() });
    expect(own.status).toBe(409);
    expect(own.body.code).toBe('MAKER_CHECKER_VIOLATION');
    expect(await ApprovalAction.count({ where: { requestId: r.id, action: 'APPROVED' } })).toBe(0);
    const n = await w.raise(w.people.accountant!, { type: 'NOTICE_PUBLISH', entityId: 8 });
    const fm = await caller('committee_member');
    const res = await fm('post', `/approvals/${n.id}/approve`, { version: 1 }, { headers: idem() });
    expect([403, 404]).toContain(res.status);
  });

  it('reject needs a reason of 5 to 500 characters and calls onRejected (T14-14, T14-15)', async () => {
    const r = await bigExpense();
    const t = await caller('treasurer');
    const short = await t(
      'post',
      `/approvals/${r.id}/reject`,
      { version: 1, reason: 'no' },
      { headers: idem() },
    );
    expect(short.status).toBe(400);
    const ok = await t(
      'post',
      `/approvals/${r.id}/reject`,
      { version: 1, reason: 'Over budget for this year' },
      { headers: idem() },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ id: r.id, status: 'REJECTED', version: 2 });
    const calls = handlerCalls.filter(h => h.fn === 'onRejected');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ reason: 'Over budget for this year', actor: w.people.treasurer!.id });
    expect((await row(r.id)).decisionReason).toBe('Over budget for this year');
  });

  it('request changes: not for BOOKING (T14-17); for an expense it sends it back', async () => {
    const b = await w.raise(null, { type: 'BOOKING', entityId: 5 });
    const c = await caller('chairman');
    const no = await c(
      'post',
      `/approvals/${b.id}/request-changes`,
      { version: 1, reason: 'Pick another day' },
      { headers: idem() },
    );
    expect(no.status).toBe(422);
    expect(no.body.code).toBe('CHANGES_NOT_SUPPORTED');
    const e = await bigExpense(6);
    const yes = await c(
      'post',
      `/approvals/${e.id}/request-changes`,
      { version: 1, reason: 'Attach the quotation' },
      { headers: idem() },
    );
    expect(yes.body.data).toMatchObject({ status: 'CHANGES_REQUESTED', version: 2 });
    expect((await row(e.id)).changesDueAt).not.toBeNull();
  });

  it('a handler that refuses rolls everything back with its own code (T14-16)', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 10, amountPaise: 2_000_000 });
    failNext.error = new AppError(422, 'INSUFFICIENT_BALANCE', 'Not enough balance');
    const c = await caller('chairman');
    const res = await c('post', `/approvals/${r.id}/approve`, { version: 1 }, { headers: idem() });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
    const after = await row(r.id);
    expect(after.status).toBe('PENDING');
    expect(after.version).toBe(1);
    expect(await ApprovalAction.count({ where: { requestId: r.id, action: 'APPROVED' } })).toBe(0);
  });

  it('cancel: only the requester (T14-34), only for types with onCancelled, with a reason', async () => {
    const r = await bigExpense();
    const t = await caller('treasurer');
    const other = await t(
      'post',
      `/approvals/${r.id}/cancel`,
      { version: 1, reason: 'Not needed any more' },
      { headers: idem() },
    );
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('NOT_THE_REQUESTER');
    const a = await caller('accountant');
    expect(
      (await a('post', `/approvals/${r.id}/cancel`, { version: 1, reason: 'x' }, { headers: idem() })).status,
    ).toBe(400);
    const ok = await a(
      'post',
      `/approvals/${r.id}/cancel`,
      { version: 1, reason: 'Vendor withdrew the quote' },
      { headers: idem() },
    );
    expect(ok.body.data).toEqual({ id: r.id, status: 'CANCELLED', version: 2 });
    const n = await w.raise(w.people.accountant!, { type: 'NOTICE_PUBLISH', entityId: 12 });
    const no = await a(
      'post',
      `/approvals/${n.id}/cancel`,
      { version: 1, reason: 'Changed my mind' },
      { headers: idem() },
    );
    expect(no.status).toBe(422);
    expect(no.body.code).toBe('CANCEL_NOT_SUPPORTED');
  });

  it('a suspended society refuses decisions (T14-40)', async () => {
    const r = await bigExpense();
    const t = await caller('treasurer');
    await sequelize.query(
      'UPDATE societies SET status = "SUSPENDED", suspensionCause = "MANUAL" WHERE id = :id',
      { replacements: { id: w.society.id } },
    );
    await flushAcl();
    const res = await t('post', `/approvals/${r.id}/approve`, { version: 1 }, { headers: idem() });
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('SOCIETY_SUSPENDED');
    expect((await t('get', '/approvals')).status).toBe(200);
  });
});

describe('delegation on the inbox (T14-27)', () => {
  it("a delegate sees the delegator's items and approves on their behalf; after the window it is refused", async () => {
    const delegate = w.people.society_admin!;
    await ApprovalDelegation.create({
      societyId: w.society.id!,
      delegatorUserId: w.people.chairman!.id,
      delegateUserId: delegate.id,
      source: 'TERM_HANDOVER',
      types: null,
      maxAmountPaise: null,
      startsAt: new Date(now().getTime() - 3_600_000),
      endsAt: addDays(now(), 3),
      status: 'ACTIVE',
      reason: 'Term hand-over',
    } as never);
    const r = await w.raise(w.people.accountant!, { type: 'NOTICE_PUBLISH', entityId: 20 });
    const d = await caller('society_admin');
    const list = await d('get', '/approvals');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].myAction).toMatchObject({
      canAct: true,
      onBehalfOf: { userId: w.people.chairman!.id },
    });
    const done = await d('post', `/approvals/${r.id}/approve`, { version: 1 }, { headers: idem() });
    expect(done.status).toBe(200);
    const act = await ApprovalAction.findOne({ where: { requestId: r.id, action: 'APPROVED' } });
    expect(Number(act!.onBehalfOfUserId)).toBe(w.people.chairman!.id);
    // the window ends
    await sequelize.query('UPDATE approval_delegations SET startsAt = :s, endsAt = :e', {
      replacements: { s: new Date('2026-11-08T00:00:00Z'), e: new Date('2026-11-09T00:00:00Z') },
    });
    const r2 = await w.raise(w.people.accountant!, { type: 'NOTICE_PUBLISH', entityId: 21 });
    expect((await d('get', '/approvals')).body.data).toEqual([]);
    const late = await d('post', `/approvals/${r2.id}/approve`, { version: 1 }, { headers: idem() });
    expect(late.status).toBe(403);
    expect(late.body.code).toBe('NOT_ELIGIBLE_APPROVER');
  });
});

describe('8.11 bulk approve', () => {
  it('approves small eligible items and skips the step-up one (T14-28); more than 50 or duplicates is 400 (T14-29)', async () => {
    const n1 = await w.raise(w.people.accountant!, { type: 'NOTICE_PUBLISH', entityId: 31 });
    const n2 = await w.raise(w.people.accountant!, { type: 'NOTICE_PUBLISH', entityId: 32 });
    const big = await bigExpense(33);
    const c = await caller('chairman');
    const res = await c(
      'post',
      '/approvals/bulk-approve',
      {
        items: [
          { id: n1.id, version: 1 },
          { id: n2.id, version: 1 },
          { id: big.id, version: 1 },
          { id: 987654, version: 1 },
        ],
      },
      { headers: idem() },
    );
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('2 approved, 2 skipped');
    expect(res.body.data.approved).toBe(2);
    expect(res.body.data.results.map((x: any) => x.code ?? x.status)).toEqual([
      'APPROVED',
      'APPROVED',
      'BULK_NOT_ALLOWED',
      'APPROVAL_NOT_FOUND',
    ]);
    expect((await row(big.id)).status).toBe('PENDING');
    expect(await AuditLog.count({ where: { action: 'approvals.request.bulk_approved' } })).toBe(1);
    const again = await c(
      'post',
      '/approvals/bulk-approve',
      { items: [{ id: n1.id, version: 1 }] },
      { headers: idem() },
    );
    expect(again.body.data.results[0]).toMatchObject({ ok: false, code: 'STALE_VERSION' });
    const many = Array.from({ length: 51 }, (_, i) => ({ id: i + 1, version: 1 }));
    expect((await c('post', '/approvals/bulk-approve', { items: many }, { headers: idem() })).status).toBe(
      400,
    );
    expect(
      (
        await c(
          'post',
          '/approvals/bulk-approve',
          {
            items: [
              { id: 1, version: 1 },
              { id: 1, version: 1 },
            ],
          },
          { headers: idem() },
        )
      ).status,
    ).toBe(400);
  });
});

describe('8.10 reassign', () => {
  it('needs rule-edit permission and step-up; adds a named approver; refuses the requester and members without the approve permission', async () => {
    await w.raise(w.people.chairman!, { type: 'EXPENSE', entityId: 40, amountPaise: 3_000_000 });
    const r = (await ApprovalRequest.findOne({ where: { entityId: 40 } }))!;
    const c = await caller('chairman');
    const body = { version: 1, userId: w.people.treasurer!.id, reason: 'Treasurer to cover this one' };
    const sec = await caller('secretary');
    expect((await sec('post', `/approvals/${r.id}/reassign`, body, { headers: idem() })).status).toBe(403);
    for (const userId of [w.people.chairman!.id, w.people.society_admin!.id, 999999]) {
      const bad = await c('post', `/approvals/${r.id}/reassign`, { ...body, userId }, { headers: idem() });
      expect(bad.status, String(userId)).toBe(422);
      expect(bad.body.code).toBe('REASSIGN_TARGET_NOT_ELIGIBLE');
    }
    const res = await c('post', `/approvals/${r.id}/reassign`, body, { headers: idem() });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: r.id, version: 2, status: 'PENDING' });
    expect(res.body.data.steps[0].slots.map((x: any) => x.type)).toEqual(['ROLE', 'ROLE', 'ROLE', 'USER']);
    expect(await ApprovalAction.count({ where: { requestId: r.id, action: 'REASSIGNED' } })).toBe(1);
    expect((await row(r.id)).stepOverrides).toHaveLength(1);
    const stale = await c('post', `/approvals/${r.id}/reassign`, body, { headers: idem() });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    advance(6 * 60_000);
    const old = await c('post', `/approvals/${r.id}/reassign`, { ...body, version: 2 }, { headers: idem() });
    expect(old.status).toBe(401);
    expect(old.body.code).toBe('REAUTH_REQUIRED');
  });
});

describe('8.19 resident endpoints', () => {
  it("a resident sees own requests with role names only, cannot see another unit's, and can cancel their own (T14-42, T14-43)", async () => {
    registerType(
      'MOVE_IN',
      {
        onApproved: async () => {},
        onRejected: async () => {},
        onCancelled: async () => {},
        describe: () => ({ facts: [], link: null }),
      },
      { replace: true },
    );
    const me = await memberUser(w.society, 'owner', { name: 'Asha Resident' });
    const other = await memberUser(w.society, 'owner', { name: 'Other Resident' });
    const raise = (u: typeof me, entityId: number) =>
      sequelize.transaction(t =>
        request(
          { ...w.ctx({ id: u.id, name: 'Resident', roleKey: 'owner' }), unitIds: [] },
          { type: 'MOVE_IN', entityType: 'move_request', entityId, title: 'Move-in to A-1203', payload: {} },
          t,
        ),
      );
    const mine = await raise(me, 50);
    const theirs = await raise(other, 51);
    const c = as(await login(me, { app: 'RESIDENT' }), 'RESIDENT');
    const list = await c('get', '/me/approval-requests');
    expect(list.status).toBe(200);
    expect(list.body.data.map((x: any) => x.id)).toEqual([mine.id]);
    expect(list.body.data[0]).toMatchObject({
      type: 'MOVE_IN',
      typeLabel: 'Move-in',
      status: 'PENDING',
      statusLabel: 'Waiting for Secretary or Chairman',
      canCancel: true,
      entityType: 'move_request',
    });
    expect(JSON.stringify(list.body)).not.toMatch(/accountant|chairman@|"actorName"/);
    expect(list.body.data[0].timeline[0].label).toBe('Submitted');
    expect((await c('get', `/me/approval-requests/${mine.id}`)).body.data.id).toBe(mine.id);
    const nf = await c('get', `/me/approval-requests/${theirs.id}`);
    expect(nf.status).toBe(404);
    expect(nf.body.code).toBe('APPROVAL_NOT_FOUND');
    const bad = await c(
      'post',
      `/me/approval-requests/${theirs.id}/cancel`,
      { version: 1, reason: 'Not my request' },
      { headers: idem() },
    );
    expect(bad.status).toBe(404);
    const ok = await c(
      'post',
      `/me/approval-requests/${mine.id}/cancel`,
      { version: 1, reason: 'Plans have changed' },
      { headers: idem() },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('CANCELLED');
    expect(
      (await c('get', '/me/approval-requests', undefined, { query: { status: 'CANCELLED' } })).body.data,
    ).toHaveLength(1);
  });
});

describe('tenant isolation (T14-36)', () => {
  it("another society's request id is 404 APPROVAL_NOT_FOUND on every route and never listed", async () => {
    const b = await makeSociety('Green Park CHS');
    const maker = await memberUser(b, 'accountant', { name: 'B Accountant' });
    const base = w.ctx({ id: maker.id, name: 'B Accountant', roleKey: 'accountant' });
    const foreign = await sequelize.transaction(t =>
      request(
        { ...base, society: { ...base.society!, id: b.id!, name: b.name } },
        {
          type: 'EXPENSE',
          entityType: 'expense',
          entityId: 1,
          title: 'Other society',
          amountPaise: 4_800_000,
          payload: {},
        },
        t,
      ),
    );
    const c = await caller('chairman');
    const paths: [string, string, unknown][] = [
      ['get', `/approvals/${foreign.id}`, undefined],
      ['post', `/approvals/${foreign.id}/approve`, { version: 1 }],
      ['post', `/approvals/${foreign.id}/reject`, { version: 1, reason: 'Not yours to see' }],
      ['post', `/approvals/${foreign.id}/request-changes`, { version: 1, reason: 'Not yours to see' }],
      ['post', `/approvals/${foreign.id}/cancel`, { version: 1, reason: 'Not yours to see' }],
      [
        'post',
        `/approvals/${foreign.id}/reassign`,
        { version: 1, userId: w.people.treasurer!.id, reason: 'Not yours to see' },
      ],
    ];
    for (const [m, p, body] of paths) {
      const r = await c(m as 'get', p, body, { headers: idem() });
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.body.code, `${m} ${p}`).toBe('APPROVAL_NOT_FOUND');
    }
    expect((await c('get', '/approvals', undefined, { query: { view: 'ALL_PENDING' } })).body.data).toEqual(
      [],
    );
    expect(
      (await c('get', '/approvals/history', undefined, { query: { entityType: 'expense', entityId: '1' } }))
        .body.data,
    ).toEqual([]);
    expect((await row(foreign.id)).status).toBe('PENDING');
  });
});
