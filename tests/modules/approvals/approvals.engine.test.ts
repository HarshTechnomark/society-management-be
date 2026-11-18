import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryTypes, UniqueConstraintError } from 'sequelize';
import {
  ApprovalAction,
  ApprovalDelegation,
  ApprovalRequest,
  ApprovalRule,
  AuditLog,
  closeDb,
  sequelize,
} from '../../../src/models';
import { advance, nowMs } from '../../../src/lib/clock';
import { UnprocessableError } from '../../../src/utils/errors';
import {
  approve,
  cancel,
  cancelByRequester,
  lockOpenForEntity,
  publicStatus,
  reject,
  request,
  requestChanges,
  resubmit,
} from '../../../src/modules/approvals/approvals.public';
import { sentNotifications } from '../../../src/modules/approvals/approvals.ports';
import {
  approvalsWorld,
  events,
  failNext,
  handlerCalls,
  settle,
  type ApprovalsWorld,
} from '../../helpers/approvals';

afterAll(async () => {
  await settle();
  await closeDb();
});

let w: ApprovalsWorld;
beforeEach(async () => {
  w = await approvalsWorld();
});

const v = (r: ApprovalRequest) => Number(r.version);
const actions = (id: number) => ApprovalAction.findAll({ where: { requestId: id }, order: [['id', 'ASC']] });
const fresh = async (id: number) => (await ApprovalRequest.findByPk(id))!;
const sentTo = (template: string) => sentNotifications.filter(n => n.template === template);
const EXPENSE_BIG = 4_800_000;

describe('request() routing (BR-14-3 to BR-14-6, BR-14-13)', () => {
  it('T14-06 a 48,000 expense by the Accountant is PENDING with one N_OF step, step-up, SUBMITTED action and audit', async () => {
    const r = await w.raise(w.people.accountant!, {
      type: 'EXPENSE',
      entityId: 1,
      amountPaise: EXPENSE_BIG,
      categoryKey: 'LIFT_AMC',
    });
    expect(r).toMatchObject({
      status: 'PENDING',
      routing: 'STEPS',
      totalSteps: 1,
      currentStepNo: 1,
      round: 1,
      stepUpRequired: true,
      hasEligibleApprover: true,
      requesterKind: 'ADMIN',
      requesterRoleKey: 'accountant',
    });
    expect(r.ruleSnapshot).toMatchObject({ name: 'Expenses above ₹25,000' });
    expect(r.ruleSnapshot!.steps[0]).toMatchObject({ mode: 'N_OF', requiredCount: 2 });
    expect(r.dueAt!.getTime() - r.stepStartedAt!.getTime()).toBe(48 * 3_600_000);
    expect((await actions(r.id)).map(a => a.action)).toEqual(['SUBMITTED']);
    expect(
      await AuditLog.count({ where: { action: 'approvals.request.created', entityId: String(r.id) } }),
    ).toBe(1);
    expect(await AuditLog.count({ where: { action: 'approvals.rule.seeded' } })).toBe(1);
  });

  it('T14-07 a 3,000 expense auto-approves inside the caller transaction and calls onApproved once', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 2, amountPaise: 300_000 });
    expect(r).toMatchObject({ status: 'APPROVED', routing: 'AUTO_RULE', currentStepNo: 0, totalSteps: 0 });
    expect(handlerCalls.filter(c => c.fn === 'onApproved')).toMatchObject([{ entityId: 2, inTx: true }]);
    expect((await actions(r.id)).map(a => a.action)).toEqual(['SUBMITTED', 'AUTO_APPROVED']);
    expect(await AuditLog.count({ where: { action: 'approvals.request.auto_approved' } })).toBe(1);
  });

  it('T14-08 with every rule deleted a request is APPROVED with routing AUTO_NO_RULE, and defaults are never re-seeded (BR-14-6)', async () => {
    await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 300_000 });
    expect(await ApprovalRule.count({ where: { societyId: w.society.id!, type: 'EXPENSE' } })).toBe(3);
    await ApprovalRule.destroy({ where: { societyId: w.society.id!, type: 'EXPENSE' } });
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 2, amountPaise: EXPENSE_BIG });
    expect(r).toMatchObject({ status: 'APPROVED', routing: 'AUTO_NO_RULE', ruleId: null });
    expect(
      await ApprovalRule.count({ where: { societyId: w.society.id!, type: 'EXPENSE' }, paranoid: false }),
    ).toBe(3);
  });

  it('seeds default rules lazily per society and type, once', async () => {
    expect(await ApprovalRule.count({ where: { societyId: w.society.id! } })).toBe(0);
    await w.raise(w.people.chairman!, { type: 'NOTICE_PUBLISH', entityId: 1 });
    await w.raise(w.people.chairman!, { type: 'NOTICE_PUBLISH', entityId: 2 });
    const rules = await ApprovalRule.findAll({ where: { societyId: w.society.id! } });
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ type: 'NOTICE_PUBLISH', name: 'Notices', isDefault: true, version: 1 });
  });

  it('step-up threshold: 25,000 exactly asks for step-up, 24,999.99 does not; PERIOD_UNLOCK always does', async () => {
    const at = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 2_500_000 });
    const below = await w.raise(w.people.accountant!, {
      type: 'EXPENSE',
      entityId: 2,
      amountPaise: 2_499_999,
    });
    const unlock = await w.raise(w.people.chairman!, { type: 'PERIOD_UNLOCK', entityId: 3 });
    expect([at.stepUpRequired, below.stepUpRequired, unlock.stepUpRequired]).toEqual([true, false, true]);
    expect(at.ruleSnapshot!.name).toBe('Expenses up to ₹25,000');
  });

  it('validates input: title, entityType, amount, payload size, past expiry, unknown type', async () => {
    const bad = (o: Record<string, unknown>) =>
      w.raise(w.people.chairman!, { type: 'NOTICE_PUBLISH', entityId: 9, ...o } as never);
    await expect(bad({ title: 'ab' })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await expect(bad({ entityType: 'expense' })).rejects.toMatchObject({ status: 400 });
    await expect(bad({ amountPaise: -1 })).rejects.toMatchObject({ status: 400 });
    await expect(bad({ amountPaise: 1.5 })).rejects.toMatchObject({ status: 400 });
    await expect(bad({ payload: { x: 'y'.repeat(17_000) } })).rejects.toMatchObject({ status: 400 });
    await expect(bad({ expiresAt: new Date(nowMs() - 1000) })).rejects.toMatchObject({ status: 400 });
    await expect(bad({ type: 'NOPE' })).rejects.toMatchObject({ status: 400 });
  });

  it('BR-14-2 a catalogued type nobody registered is a 500 developer error', async () => {
    await expect(w.raise(w.people.chairman!, { type: 'MINUTES', entityId: 1 })).rejects.toMatchObject({
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });

  it('T14-35 / BR-14-16: the same payload returns the open request, another payload is APPROVAL_ALREADY_PENDING', async () => {
    const a = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 5, amountPaise: EXPENSE_BIG });
    const b = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 5, amountPaise: EXPENSE_BIG });
    expect(b.id).toBe(a.id);
    expect(await ApprovalRequest.count()).toBe(1);
    await expect(
      w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 5, amountPaise: EXPENSE_BIG + 1 }),
    ).rejects.toMatchObject({ status: 409, code: 'APPROVAL_ALREADY_PENDING' });
  });

  it('a request raised by the system has requesterKind SYSTEM and no maker to exclude', async () => {
    const r = await w.raise(null, { type: 'NOTICE_PUBLISH', entityId: 1 });
    expect(r.requesterKind).toBe('SYSTEM');
    const done = await approve(w.ctx(w.people.chairman!), r.id, { version: v(r) });
    expect(done.status).toBe('APPROVED');
  });

  it('only one open request per entity is allowed by the database (uq_approval_requests_open)', async () => {
    const a = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 5, amountPaise: EXPENSE_BIG });
    await expect(
      ApprovalRequest.create({
        ...(a.toJSON() as Record<string, unknown>),
        id: undefined,
        payloadHash: 'x'.repeat(64),
      } as never),
    ).rejects.toThrow();
  });
});

describe('decisions: maker-checker, distinct approvers, step-up, completion', () => {
  it('US-14-01 two of three signatories: Treasurer, then Chairman with a fresh authentication', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: EXPENSE_BIG });
    const first = await approve(w.ctx(w.people.treasurer!), r.id, { version: v(r), comment: 'AMC verified' });
    expect(first.status).toBe('PENDING');
    expect(first.version).toBe(2);
    // the Chairman's last authentication was 20 minutes ago
    await expect(approve(w.ctx(w.people.chairman!, 20), r.id, { version: 2 })).rejects.toMatchObject({
      status: 401,
      code: 'REAUTH_REQUIRED',
    });
    expect((await fresh(r.id)).version).toBe(2);
    expect(await ApprovalAction.count({ where: { requestId: r.id, action: 'APPROVED' } })).toBe(1);
    const done = await approve(w.ctx(w.people.chairman!, 2), r.id, { version: 2 });
    expect(done).toMatchObject({ status: 'APPROVED', decidedByUserId: w.people.chairman!.id });
    expect(handlerCalls.filter(c => c.fn === 'onApproved')).toHaveLength(1);
    const acts = await actions(r.id);
    expect(acts.map(a => a.action)).toEqual(['SUBMITTED', 'APPROVED', 'APPROVED']);
    expect(acts[1]).toMatchObject({
      stepNo: 1,
      slotType: 'ROLE',
      slotRef: 'treasurer',
      comment: 'AMC verified',
    });
    expect([acts[1]!.authTime, acts[2]!.authTime]).not.toContain(null); // step-up evidence on every approval
    expect(sentTo('approvals.approved')[0]!.userIds).toEqual([w.people.accountant!.id]);
  });

  it('T14-09 the requester cannot approve, reject or request changes on their own item', async () => {
    const r = await w.raise(w.people.treasurer!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    const me = w.ctx(w.people.treasurer!);
    for (const fn of [approve, reject, requestChanges])
      await expect(fn(me, r.id, { version: 1, reason: 'not mine to decide' })).rejects.toMatchObject({
        status: 409,
        code: 'MAKER_CHECKER_VIOLATION',
      });
    expect(await ApprovalAction.count({ where: { requestId: r.id } })).toBe(1);
  });

  it('T14-33 the Chairman raises 30,000: he cannot approve, Treasurer then Secretary do, and it is never stuck', async () => {
    const r = await w.raise(w.people.chairman!, { type: 'EXPENSE', entityId: 1, amountPaise: 3_000_000 });
    expect(r.hasEligibleApprover).toBe(true);
    await expect(approve(w.ctx(w.people.chairman!), r.id, { version: 1 })).rejects.toMatchObject({
      code: 'MAKER_CHECKER_VIOLATION',
    });
    await approve(w.ctx(w.people.treasurer!), r.id, { version: 1 });
    expect((await fresh(r.id)).hasEligibleApprover).toBe(true);
    const done = await approve(w.ctx(w.people.secretary!), r.id, { version: 2 });
    expect(done.status).toBe('APPROVED');
  });

  it('T14-10 a person who approved cannot give the second approval through a delegation', async () => {
    await ApprovalDelegation.create({
      societyId: w.society.id!,
      delegatorUserId: w.people.chairman!.id,
      delegateUserId: w.people.treasurer!.id,
      source: 'TERM_HANDOVER',
      types: null,
      maxAmountPaise: null,
      startsAt: new Date(nowMs() - 3_600_000),
      endsAt: new Date(nowMs() + 86_400_000 * 5),
      reason: 'Term hand-over',
    });
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: EXPENSE_BIG });
    await approve(w.ctx(w.people.treasurer!), r.id, { version: 1 });
    await expect(
      approve(w.ctx(w.people.treasurer!), r.id, { version: 2, onBehalfOfUserId: w.people.chairman!.id }),
    ).rejects.toMatchObject({ status: 409, code: 'APPROVER_ALREADY_ACTED' });
    await expect(approve(w.ctx(w.people.treasurer!), r.id, { version: 2 })).rejects.toMatchObject({
      code: 'APPROVER_ALREADY_ACTED',
    });
  });

  it('a delegate approves on behalf (history shows both), onBehalf is inferred when exactly one identity fits (BR-14-25)', async () => {
    await ApprovalDelegation.create({
      societyId: w.society.id!,
      delegatorUserId: w.people.chairman!.id,
      delegateUserId: w.people.committee_member!.id,
      source: 'TERM_HANDOVER',
      types: ['EXPENSE'],
      maxAmountPaise: 3_000_000,
      startsAt: new Date(nowMs() - 3_600_000),
      endsAt: new Date(nowMs() + 86_400_000),
      reason: 'Travelling',
    });
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    const done = await approve(w.ctx(w.people.committee_member!, 1), r.id, { version: 1 });
    expect(done.status).toBe('APPROVED');
    const a = (await actions(r.id))[1]!;
    expect(a).toMatchObject({
      actorUserId: w.people.committee_member!.id,
      onBehalfOfUserId: w.people.chairman!.id,
    });
    expect(a.delegationId).not.toBeNull();
    expect(handlerCalls.at(-1)).toMatchObject({
      actor: w.people.committee_member!.id,
      onBehalf: w.people.chairman!.id,
    });
    // the amount cap: a bigger item is not covered by the delegation
    const big = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 2, amountPaise: 9_000_000 });
    await expect(approve(w.ctx(w.people.committee_member!, 1), big.id, { version: 1 })).rejects.toMatchObject(
      {
        status: 403,
        code: 'NOT_ELIGIBLE_APPROVER',
      },
    );
    await expect(
      approve(w.ctx(w.people.committee_member!, 1), big.id, {
        version: 1,
        onBehalfOfUserId: w.people.chairman!.id,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'NO_ACTIVE_DELEGATION' });
  });

  it('a delegation outside its window is not honoured (T14-27)', async () => {
    await ApprovalDelegation.create({
      societyId: w.society.id!,
      delegatorUserId: w.people.chairman!.id,
      delegateUserId: w.people.committee_member!.id,
      source: 'TERM_HANDOVER',
      types: null,
      maxAmountPaise: null,
      startsAt: new Date(nowMs() - 3_600_000),
      endsAt: new Date(nowMs() + 3_600_000),
      reason: 'Travelling',
    });
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    advance(2 * 3_600_000);
    await expect(approve(w.ctx(w.people.committee_member!, 1), r.id, { version: 1 })).rejects.toMatchObject({
      code: 'NOT_ELIGIBLE_APPROVER',
    });
  });

  it('people outside the step are not eligible; an Accountant and a Facility Manager cannot approve an expense', async () => {
    const r = await w.raise(w.people.chairman!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    for (const p of [w.people.accountant!, w.people.facility_manager!, w.people.committee_member!])
      await expect(approve(w.ctx(p), r.id, { version: 1 })).rejects.toMatchObject({
        status: 403,
        code: 'NOT_ELIGIBLE_APPROVER',
      });
  });

  it('T14-12 two parallel approvals with the same version: one wins, the other gets STALE_VERSION, handler ran once', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    const res = await Promise.allSettled([
      approve(w.ctx(w.people.treasurer!), r.id, { version: 1 }),
      approve(w.ctx(w.people.chairman!), r.id, { version: 1 }),
    ]);
    expect(res.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find(x => x.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ status: 409, code: 'STALE_VERSION' });
    expect(handlerCalls.filter(c => c.fn === 'onApproved')).toHaveLength(1);
  });

  it('T14-19 deciding a decided request is APPROVAL_NOT_PENDING; unknown ids and other societies are 404 (T14-36)', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    const done = await approve(w.ctx(w.people.treasurer!), r.id, { version: 1 });
    await expect(approve(w.ctx(w.people.chairman!), r.id, { version: v(done) })).rejects.toMatchObject({
      status: 409,
      code: 'APPROVAL_NOT_PENDING',
    });
    await expect(approve(w.ctx(w.people.chairman!), 99_999, { version: 1 })).rejects.toMatchObject({
      status: 404,
      code: 'APPROVAL_NOT_FOUND',
    });
    const other = {
      ...w.ctx(w.people.chairman!),
      society: { ...w.ctx(w.people.chairman!).society!, id: w.society.id! + 1000 },
    };
    await expect(approve(other, r.id, { version: 1 })).rejects.toMatchObject({ status: 404 });
  });

  it('T14-14 / T14-15 reject needs a reason of 5 to 500 characters; the handler gets it and the requester is told', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    await expect(
      reject(w.ctx(w.people.treasurer!), r.id, { version: 1, reason: 'no' }),
    ).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    await expect(reject(w.ctx(w.people.treasurer!), r.id, { version: 1 })).rejects.toMatchObject({
      status: 400,
    });
    const done = await reject(w.ctx(w.people.treasurer!), r.id, { version: 1, reason: '  Wrong vendor  ' });
    expect(done).toMatchObject({ status: 'REJECTED', decisionReason: 'Wrong vendor' });
    expect(handlerCalls.at(-1)).toMatchObject({
      fn: 'onRejected',
      reason: 'Wrong vendor',
      decision: 'REJECTED',
    });
    expect(sentTo('approvals.rejected')[0]).toMatchObject({
      userIds: [w.people.accountant!.id],
      data: { reason: 'Wrong vendor' },
    });
    expect(await AuditLog.count({ where: { action: 'approvals.request.rejected' } })).toBe(1);
  });

  it('a rejection after one of two approvals ends the request and tells the earlier approver (approvals.closed)', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: EXPENSE_BIG });
    await approve(w.ctx(w.people.treasurer!), r.id, { version: 1 });
    await reject(w.ctx(w.people.secretary!), r.id, { version: 2, reason: 'Needs a second quote' });
    expect(sentTo('approvals.closed')[0]!.userIds).toEqual([w.people.treasurer!.id]);
    expect((await fresh(r.id)).status).toBe('REJECTED');
  });

  it('T14-16 a failing onApproved rolls everything back and its error is returned unchanged', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    failNext.error = new UnprocessableError('INSUFFICIENT_BALANCE', 'Not enough cash');
    await expect(approve(w.ctx(w.people.treasurer!), r.id, { version: 1 })).rejects.toMatchObject({
      status: 422,
      code: 'INSUFFICIENT_BALANCE',
    });
    const row = await fresh(r.id);
    expect(row).toMatchObject({ status: 'PENDING', version: 1, decidedAt: null });
    expect(await ApprovalAction.count({ where: { requestId: r.id } })).toBe(1);
    expect(await AuditLog.count({ where: { action: 'approvals.request.approved' } })).toBe(0);
    // and it can be approved afterwards
    expect((await approve(w.ctx(w.people.treasurer!), r.id, { version: 1 })).status).toBe('APPROVED');
  });

  it('multi-step rules advance the step, restart the SLA and keep the requester out of every step', async () => {
    await w.raise(w.people.chairman!, { type: 'EXPENSE', entityId: 90, amountPaise: 300_000 }); // seeds defaults
    await ApprovalRule.update({ isActive: false }, { where: { societyId: w.society.id!, type: 'EXPENSE' } });
    await ApprovalRule.create({
      societyId: w.society.id!,
      type: 'EXPENSE',
      name: 'Two stages',
      priority: 1,
      steps: [
        {
          stepNo: 1,
          name: 'Treasurer',
          mode: 'ANY_OF',
          roleKeys: ['treasurer'],
          userIds: [],
          requiredCount: null,
        },
        {
          stepNo: 2,
          name: 'Chairman',
          mode: 'ANY_OF',
          roleKeys: ['chairman'],
          userIds: [],
          requiredCount: null,
        },
      ],
      action: 'REQUIRE_APPROVAL',
    } as never);
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    expect(r).toMatchObject({ totalSteps: 2, currentStepNo: 1 });
    await expect(approve(w.ctx(w.people.chairman!), r.id, { version: 1 })).rejects.toMatchObject({
      code: 'NOT_ELIGIBLE_APPROVER',
    });
    advance(3_600_000);
    const s2 = await approve(w.ctx(w.people.treasurer!), r.id, { version: 1 });
    expect(s2).toMatchObject({ status: 'PENDING', currentStepNo: 2 });
    expect(s2.stepStartedAt!.getTime()).toBe(nowMs());
    await expect(approve(w.ctx(w.people.treasurer!), r.id, { version: 2 })).rejects.toMatchObject({
      code: 'APPROVER_ALREADY_ACTED',
    });
    const done = await approve(w.ctx(w.people.chairman!), r.id, { version: 2 });
    expect(done.status).toBe('APPROVED');
    expect(handlerCalls.filter(c => c.fn === 'onApproved')).toHaveLength(2); // the auto-approved seed item and this one
    expect(await AuditLog.count({ where: { action: 'approvals.request.step_approved' } })).toBe(1);
  });

  it('T14-52 ALL_OF [treasurer, secretary] raised by the Treasurer: the Chairman covers the vacant slot as FALLBACK', async () => {
    await w.raise(w.people.chairman!, { type: 'EXPENSE', entityId: 90, amountPaise: 300_000 });
    await ApprovalRule.update({ isActive: false }, { where: { societyId: w.society.id!, type: 'EXPENSE' } });
    await ApprovalRule.create({
      societyId: w.society.id!,
      type: 'EXPENSE',
      name: 'Both',
      priority: 1,
      steps: [
        {
          stepNo: 1,
          name: 'Both',
          mode: 'ALL_OF',
          roleKeys: ['treasurer', 'secretary'],
          userIds: [],
          requiredCount: null,
        },
      ],
      action: 'REQUIRE_APPROVAL',
    } as never);
    const r = await w.raise(w.people.treasurer!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    expect(r.hasEligibleApprover).toBe(true);
    const a = await approve(w.ctx(w.people.chairman!), r.id, { version: 1 });
    expect(a.status).toBe('PENDING');
    expect((await actions(r.id))[1]).toMatchObject({ slotType: 'FALLBACK', slotRef: 'treasurer' });
    const done = await approve(w.ctx(w.people.secretary!), r.id, { version: 2 });
    expect(done.status).toBe('APPROVED');
  });

  it('T14-48 PERIOD_UNLOCK: always step-up; the Chairman cannot approve his own; two of three approve', async () => {
    const r = await w.raise(w.people.chairman!, { type: 'PERIOD_UNLOCK', entityId: 7 });
    await expect(approve(w.ctx(w.people.chairman!), r.id, { version: 1 })).rejects.toMatchObject({
      code: 'MAKER_CHECKER_VIOLATION',
    });
    await expect(approve(w.ctx(w.people.treasurer!, 20), r.id, { version: 1 })).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    });
    expect((await approve(w.ctx(w.people.treasurer!, 1), r.id, { version: 1 })).status).toBe('PENDING');
    expect((await approve(w.ctx(w.people.secretary!, 1), r.id, { version: 2 })).status).toBe('APPROVED');
  });

  it('reject needs no step-up even for a step-up request', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: EXPENSE_BIG });
    const done = await reject(w.ctx(w.people.treasurer!, 600), r.id, {
      version: 1,
      reason: 'Duplicate bill',
    });
    expect(done.status).toBe('REJECTED');
  });

  it('T14-44 the database refuses a second APPROVED by the same principal in a round, and rows are immutable', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: EXPENSE_BIG });
    await approve(w.ctx(w.people.treasurer!), r.id, { version: 1 });
    const ins = () =>
      sequelize.query(
        `INSERT INTO approval_actions (societyId, requestId, round, stepNo, action, actorUserId, createdAt)
         VALUES (:s, :r, 1, 1, 'APPROVED', :u, NOW(3))`,
        { replacements: { s: w.society.id!, r: r.id, u: w.people.treasurer!.id }, type: QueryTypes.INSERT },
      );
    await expect(ins()).rejects.toBeInstanceOf(UniqueConstraintError);
    const a = (await actions(r.id))[0]!;
    await expect(a.update({ comment: 'edited' })).rejects.toThrow(/immutable/);
    await expect(a.destroy()).rejects.toThrow(/never deleted/);
  });
});

describe('request changes, resubmit, cancel (BR-14-17, BR-14-18)', () => {
  it('T14-17 request changes is refused for types that do not allow it', async () => {
    const r = await w.raise(null, { type: 'BOOKING', entityId: 1 });
    await expect(
      requestChanges(w.ctx(w.people.secretary!), r.id, { version: 1, reason: 'move it a day' }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'CHANGES_NOT_SUPPORTED',
    });
  });

  it('T14-18 changes requested then resubmitted with a new amount: round 2, routed again, round-1 history kept', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    const ch = await requestChanges(w.ctx(w.people.treasurer!), r.id, {
      version: 1,
      reason: 'Add the invoice copy',
    });
    expect(ch).toMatchObject({ status: 'CHANGES_REQUESTED' });
    expect(ch.changesDueAt!.getTime()).toBe(nowMs() + 30 * 86_400_000);
    expect(handlerCalls.at(-1)).toMatchObject({ fn: 'onChangesRequested' });
    expect(sentTo('approvals.changes_requested')).toHaveLength(1);
    await expect(
      sequelize.transaction(t => resubmit(w.ctx(w.people.treasurer!), r.id, { amountPaise: 1 }, t)),
    ).rejects.toMatchObject({ status: 403, code: 'NOT_THE_REQUESTER' });
    const again = await sequelize.transaction(t =>
      resubmit(w.ctx(w.people.accountant!), r.id, { amountPaise: 3_000_000, payload: { v: 2 } }, t),
    );
    expect(again).toMatchObject({
      status: 'PENDING',
      round: 2,
      currentStepNo: 1,
      amountPaise: 3_000_000,
      changesDueAt: null,
    });
    expect(again.ruleSnapshot!.steps[0]!.mode).toBe('N_OF'); // 30,000 now needs two signatories
    expect((await actions(r.id)).map(a => a.action)).toEqual([
      'SUBMITTED',
      'CHANGES_REQUESTED',
      'RESUBMITTED',
    ]);
    // the round-1 decision does not count as an approval in round 2
    expect((await approve(w.ctx(w.people.treasurer!), r.id, { version: v(again) })).status).toBe('PENDING');
  });

  it('a resubmission that now falls in an auto band becomes APPROVED and runs onApproved', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    await requestChanges(w.ctx(w.people.treasurer!), r.id, { version: 1, reason: 'Amount looks too high' });
    const again = await sequelize.transaction(t =>
      resubmit(w.ctx(w.people.accountant!), r.id, { amountPaise: 400_000 }, t),
    );
    expect(again).toMatchObject({ status: 'APPROVED', routing: 'AUTO_RULE', round: 2 });
    expect(handlerCalls.filter(c => c.fn === 'onApproved')).toHaveLength(1);
  });

  it('resubmit of a request that is not CHANGES_REQUESTED is APPROVAL_NOT_PENDING', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    await expect(
      sequelize.transaction(t => resubmit(w.ctx(w.people.accountant!), r.id, {}, t)),
    ).rejects.toMatchObject({
      code: 'APPROVAL_NOT_PENDING',
    });
  });

  it('T14-34 cancel by someone else is NOT_THE_REQUESTER; by the requester it calls onCancelled; types without it are CANCEL_NOT_SUPPORTED', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    await expect(
      sequelize.transaction(t =>
        cancelByRequester(w.ctx(w.people.treasurer!), r.id, { reason: 'Changed my mind' }, t),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'NOT_THE_REQUESTER' });
    await expect(
      sequelize.transaction(t => cancelByRequester(w.ctx(w.people.accountant!), r.id, { reason: 'x' }, t)),
    ).rejects.toMatchObject({ status: 400 });
    const c = await sequelize.transaction(t =>
      cancelByRequester(w.ctx(w.people.accountant!), r.id, { reason: 'Changed my mind' }, t),
    );
    expect(c).toMatchObject({ status: 'CANCELLED', decisionReason: 'Changed my mind' });
    expect(handlerCalls.at(-1)).toMatchObject({ fn: 'onCancelled', decision: 'CANCELLED' });
    expect(await AuditLog.count({ where: { action: 'approvals.request.cancelled' } })).toBe(1);

    const b = await w.raise(w.people.chairman!, { type: 'BOOKING', entityId: 2 });
    await expect(
      sequelize.transaction(t =>
        cancelByRequester(w.ctx(w.people.chairman!), b.id, { reason: 'Changed my mind' }, t),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'CANCEL_NOT_SUPPORTED' });
  });

  it('owner-initiated cancel closes the request without calling any handler; decided requests cannot be cancelled', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    const before = handlerCalls.length;
    await sequelize.transaction(t =>
      cancel(w.ctx(w.people.accountant!), r.id, 'Republished by another user', t),
    );
    expect((await fresh(r.id)).status).toBe('CANCELLED');
    expect(handlerCalls).toHaveLength(before);
    await expect(
      sequelize.transaction(t => cancel(w.ctx(w.people.accountant!), r.id, 'again', t)),
    ).rejects.toMatchObject({
      code: 'APPROVAL_NOT_PENDING',
    });
    // the entity can be requested again once the open request is gone
    const again = await w.raise(w.people.accountant!, {
      type: 'EXPENSE',
      entityId: 1,
      amountPaise: 1_000_000,
    });
    expect(again.id).not.toBe(r.id);
  });
});

describe('stuck requests, notifications, realtime, lookups', () => {
  it('T14-49 without a Secretary the Chairman cannot get a 30,000 expense approved: created PENDING, STUCK, alerts sent', async () => {
    w = await approvalsWorld({ roles: ['chairman', 'treasurer', 'accountant'] });
    const r = await w.raise(w.people.chairman!, { type: 'EXPENSE', entityId: 1, amountPaise: 3_000_000 });
    expect(r).toMatchObject({ status: 'PENDING', hasEligibleApprover: false });
    expect(r.stuckAt).not.toBeNull();
    await settle();
    expect(sentTo('approvals.unroutable')[0]!.userIds).toContain(w.people.chairman!.id);
    expect(
      events.some(e => e.event === 'approvals.stuck' && e.room === `society:${w.society.id}:admin`),
    ).toBe(true);
    expect(await AuditLog.count({ where: { action: 'approvals.request.stuck' } })).toBe(1);
    expect(sentTo('approvals.pending')).toHaveLength(0);
  });

  it('approvals.pending goes to the eligible approvers only (never the requester or the Accountant)', async () => {
    const r = await w.raise(w.people.treasurer!, { type: 'EXPENSE', entityId: 1, amountPaise: 3_000_000 });
    await settle();
    const p = sentTo('approvals.pending');
    expect(p).toHaveLength(1);
    expect(p[0]!.userIds.sort()).toEqual([w.people.chairman!.id, w.people.secretary!.id].sort());
    expect(p[0]!.data).toMatchObject({ requestId: r.id, typeLabel: 'Expense', amountPaise: 3_000_000 });
  });

  it('T14-41 approvals.changed goes to the admin room without title or amount; the requester gets approvals.request.updated', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: EXPENSE_BIG });
    await approve(w.ctx(w.people.treasurer!), r.id, { version: 1 });
    await settle();
    const changed = events.filter(e => e.event === 'approvals.changed');
    expect(changed.length).toBeGreaterThanOrEqual(2);
    expect(changed[0]).toMatchObject({
      room: `society:${w.society.id}:admin`,
      payload: { requestId: r.id, type: 'EXPENSE', status: 'PENDING' },
    });
    expect(Object.keys(changed[0]!.payload).sort()).toEqual(['currentStepNo', 'requestId', 'status', 'type']);
    expect(
      events.some(
        e => e.event === 'approvals.request.updated' && e.room === `user:${w.people.accountant!.id}`,
      ),
    ).toBe(true);
  });

  it('lockOpenForEntity, getOpenForEntity and publicStatus (8.20)', async () => {
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: EXPENSE_BIG });
    const locked = await sequelize.transaction(t => lockOpenForEntity(w.society.id!, 'EXPENSE', 1, t));
    expect(Number(locked!.id)).toBe(r.id);
    expect(await sequelize.transaction(t => lockOpenForEntity(w.society.id!, 'EXPENSE', 2, t))).toBeNull();
    expect(await publicStatus(w.society.id!, 'EXPENSE', 1)).toEqual({
      status: 'PENDING',
      statusLabel: 'Waiting for Two of Chairman, Treasurer, Secretary',
      reason: null,
    });
    await reject(w.ctx(w.people.treasurer!), r.id, { version: 1, reason: 'Wrong date' });
    expect(await publicStatus(w.society.id!, 'EXPENSE', 1)).toEqual({
      status: 'REJECTED',
      statusLabel: 'Rejected',
      reason: 'Wrong date',
    });
    expect(await publicStatus(w.society.id!, 'EXPENSE', 404)).toBeNull();
  });

  it('every write is audited inside the transaction: a rolled-back request leaves no row, action or audit', async () => {
    await expect(
      sequelize.transaction(async t => {
        await request(
          w.ctx(w.people.accountant!),
          {
            type: 'EXPENSE',
            entityType: 'expense',
            entityId: 1,
            title: 'Rolled back',
            amountPaise: EXPENSE_BIG,
            payload: {},
          },
          t,
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await ApprovalRequest.count()).toBe(0);
    expect(await ApprovalAction.count()).toBe(0);
    expect(await AuditLog.count({ where: { action: 'approvals.request.created' } })).toBe(0);
    await settle();
    expect(sentTo('approvals.pending')).toHaveLength(0);
  });
});
