import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import {
  ApprovalAction,
  ApprovalDelegation,
  ApprovalRequest,
  ApprovalRule,
  AuditLog,
  Society,
  closeDb,
  sequelize,
} from '../../../src/models';
import { nowMs } from '../../../src/lib/clock';
import {
  approve,
  assertSocietyWritable,
  bulkApprove,
  computeCounts,
  countForUser,
  countsFor,
  reassign,
} from '../../../src/modules/approvals/approvals.public';
import { sentNotifications } from '../../../src/modules/approvals/approvals.ports';
import { approvalsExportProvider } from '../../../src/modules/approvals/approvals.engine.export';
import { purgeApprovals } from '../../../src/modules/approvals/approvals.engine.purge';
import { exportProviders } from '../../../src/modules/societies/societies.exports';
import { purgeHandlerList } from '../../../src/modules/societies/societies.purge';
import { lifecycleColumns, memberUser } from '../../helpers/access';
import { approvalsWorld, events, settle, type ApprovalsWorld } from '../../helpers/approvals';

afterAll(async () => {
  await settle();
  await closeDb();
});

let w: ApprovalsWorld;
beforeEach(async () => {
  w = await approvalsWorld();
});
const sentTo = (template: string) => sentNotifications.filter(n => n.template === template);
const fresh = async (id: number) => (await ApprovalRequest.findByPk(id))!;
const BIG = 3_000_000; // above the 25,000 step-up and two-signatory threshold
const v = (r: ApprovalRequest) => Number(r.version);

describe('bulk approve (BR-14-27, 8.11)', () => {
  it('T14-28 two small notices are approved, an expense needing step-up is BULK_NOT_ALLOWED and not touched', async () => {
    const n1 = await w.raise(w.people.secretary!, { type: 'NOTICE_PUBLISH', entityId: 1 });
    const n2 = await w.raise(w.people.secretary!, { type: 'NOTICE_PUBLISH', entityId: 2 });
    const big = await w.raise(w.people.treasurer!, { type: 'EXPENSE', entityId: 3, amountPaise: BIG });
    const out = await bulkApprove(w.ctx(w.people.chairman!), [
      { id: n1.id, version: v(n1) },
      { id: n2.id, version: v(n2) },
      { id: big.id, version: v(big) },
    ]);
    expect(out).toMatchObject({ approved: 2, skipped: 1 });
    expect(out.results[0]).toMatchObject({ id: n1.id, ok: true, status: 'APPROVED', version: 2 });
    expect(out.results[2]).toMatchObject({ id: big.id, ok: false, code: 'BULK_NOT_ALLOWED' });
    expect((await fresh(big.id)).status).toBe('PENDING');
    expect(await ApprovalAction.count({ where: { requestId: big.id, action: 'APPROVED' } })).toBe(0);
    expect(await AuditLog.count({ where: { action: 'approvals.request.bulk_approved' } })).toBe(1);
    expect(await AuditLog.count({ where: { action: 'approvals.request.approved' } })).toBe(2);
  });

  it('T14-29 51 items, or duplicate ids, is 400 VALIDATION_FAILED', async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ id: i + 1, version: 1 }));
    await expect(bulkApprove(w.ctx(w.people.chairman!), items)).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    await expect(
      bulkApprove(w.ctx(w.people.chairman!), [
        { id: 1, version: 1 },
        { id: 1, version: 1 },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(bulkApprove(w.ctx(w.people.chairman!), [])).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('per-item errors never stop the others: not found, stale, maker-checker, already approved', async () => {
    const a = await w.raise(w.people.secretary!, { type: 'NOTICE_PUBLISH', entityId: 1 });
    const mine = await w.raise(w.people.chairman!, { type: 'NOTICE_PUBLISH', entityId: 2 });
    const done = await w.raise(w.people.secretary!, { type: 'NOTICE_PUBLISH', entityId: 3 });
    await approve(w.ctx(w.people.chairman!), done.id, { version: 1 });
    const stale = await w.raise(w.people.secretary!, { type: 'NOTICE_PUBLISH', entityId: 4 });
    const ok = await w.raise(w.people.secretary!, { type: 'NOTICE_PUBLISH', entityId: 5 });
    const out = await bulkApprove(w.ctx(w.people.chairman!), [
      { id: 999_999, version: 1 },
      { id: stale.id, version: 9 },
      { id: mine.id, version: 1 },
      { id: done.id, version: 2 },
      { id: a.id, version: 1 },
      { id: ok.id, version: 1 },
    ]);
    expect(out.results.map(r => r.code ?? 'OK')).toEqual([
      'APPROVAL_NOT_FOUND',
      'STALE_VERSION',
      'MAKER_CHECKER_VIOLATION',
      'APPROVAL_NOT_PENDING',
      'OK',
      'OK',
    ]);
    expect(out).toMatchObject({ approved: 2, skipped: 4 });
  });

  it('an item above approvals.bulkApproveBelowPaise is not bulk-eligible; a person who is not an approver gets NOT_ELIGIBLE_APPROVER', async () => {
    const small = await w.raise(w.people.accountant!, {
      type: 'EXPENSE',
      entityId: 1,
      amountPaise: 1_000_000,
    });
    const near = await w.raise(w.people.accountant!, {
      type: 'EXPENSE',
      entityId: 2,
      amountPaise: 2_499_999,
    });
    await ApprovalRequest.update({ allowBulk: true }, { where: { id: [small.id, near.id] } });
    const out = await bulkApprove(w.ctx(w.people.facility_manager!), [{ id: small.id, version: v(small) }]);
    expect(out.results[0]).toMatchObject({ ok: false, code: 'NOT_ELIGIBLE_APPROVER' });
    const ok = await bulkApprove(w.ctx(w.people.treasurer!), [{ id: small.id, version: v(small) }]);
    expect(ok.results[0]).toMatchObject({ ok: true, status: 'APPROVED' });
    await ApprovalRequest.update({ amountPaise: 2_500_000 }, { where: { id: near.id } });
    const no = await bulkApprove(w.ctx(w.people.treasurer!), [{ id: near.id, version: v(near) }]);
    expect(no.results[0]).toMatchObject({ ok: false, code: 'BULK_NOT_ALLOWED' });
  });

  it('T14-40 a closed society is blocked (423) before any item runs', async () => {
    const a = await w.raise(w.people.secretary!, { type: 'NOTICE_PUBLISH', entityId: 1 });
    const c = w.ctx(w.people.chairman!);
    c.society!.status = 'CLOSED';
    await expect(bulkApprove(c, [{ id: a.id, version: 1 }])).rejects.toMatchObject({
      status: 423,
      code: 'SOCIETY_CLOSED',
    });
    c.society!.status = 'SUSPENDED';
    await expect(approve(c, a.id, { version: 1 })).rejects.toMatchObject({
      status: 423,
      code: 'SOCIETY_SUSPENDED',
    });
    expect((await fresh(a.id)).status).toBe('PENDING');
  });
});

describe('society state guard (BR-14-30)', () => {
  it('writes are blocked when suspended or closed; an active society and a ctx without a society pass', () => {
    const c = w.ctx(w.people.chairman!);
    expect(() => assertSocietyWritable(c)).not.toThrow();
    c.society!.status = 'SUSPENDED';
    expect(() => assertSocietyWritable(c)).toThrowError(/suspended/i);
    c.society!.status = 'CLOSED';
    expect(() => assertSocietyWritable(c)).toThrowError(/closed/i);
    delete c.society;
    expect(() => assertSocietyWritable(c)).not.toThrow();
  });
});

describe('reassign (BR-14-21, 8.10)', () => {
  it('adds the member to the pool of the current step as a USER slot, notifies them and writes the action and audit', async () => {
    await w.raise(w.people.secretary!, { type: 'NOTICE_PUBLISH', entityId: 90 }); // seeds defaults
    await ApprovalRule.update(
      { isActive: false },
      { where: { societyId: w.society.id!, type: 'NOTICE_PUBLISH' } },
    );
    await ApprovalRule.create({
      societyId: w.society.id!,
      type: 'NOTICE_PUBLISH',
      name: 'Chairman only',
      priority: 1,
      steps: [
        {
          stepNo: 1,
          name: 'Chairman',
          mode: 'ANY_OF',
          roleKeys: ['chairman'],
          userIds: [],
          requiredCount: null,
        },
      ],
      action: 'REQUIRE_APPROVAL',
    } as never);
    const r = await w.raise(w.people.treasurer!, { type: 'NOTICE_PUBLISH', entityId: 1 });
    const sec = w.people.secretary!;
    await expect(approve(w.ctx(sec, 1), r.id, { version: 1 })).rejects.toMatchObject({
      code: 'NOT_ELIGIBLE_APPROVER',
    });
    await settle();
    sentNotifications.length = 0;
    const row = await reassign(w.ctx(w.people.chairman!), r.id, {
      version: 1,
      userId: sec.id,
      reason: 'Chairman is travelling',
    });
    expect(Number(row.version)).toBe(2);
    expect(row.stepOverrides).toMatchObject([{ stepNo: 1, round: 1, slotIndex: null, userId: sec.id }]);
    const act = (await ApprovalAction.findAll({ where: { requestId: r.id, action: 'REASSIGNED' } }))[0]!;
    expect(act).toMatchObject({ comment: 'Chairman is travelling', slotType: 'USER', stepNo: 1 });
    expect(await AuditLog.count({ where: { action: 'approvals.request.reassigned' } })).toBe(1);
    await settle();
    expect(sentTo('approvals.pending')).toHaveLength(1);
    expect(sentTo('approvals.pending')[0]!.userIds).toEqual([sec.id]);
    const done = await approve(w.ctx(sec, 1), r.id, { version: 2 });
    expect(done.status).toBe('APPROVED');
    expect((await ApprovalAction.findOne({ where: { requestId: r.id, action: 'APPROVED' } }))!).toMatchObject(
      {
        slotType: 'USER',
        slotRef: String(sec.id),
      },
    );
  });

  it('frees a STUCK request (stuckAt cleared, hasEligibleApprover set)', async () => {
    w = await approvalsWorld({ roles: ['chairman', 'treasurer', 'accountant'] });
    const r = await w.raise(w.people.chairman!, { type: 'EXPENSE', entityId: 1, amountPaise: BIG });
    expect(r.stuckAt).not.toBeNull();
    const extra = await memberUser(w.society, 'secretary', { name: 'sec' });
    const row = await reassign(w.ctx(w.people.chairman!), r.id, {
      version: v(r),
      userId: extra.id,
      reason: 'Covering the Secretary',
    });
    expect(row.stuckAt).toBeNull();
    expect(row.hasEligibleApprover).toBe(true);
    expect(await AuditLog.count({ where: { action: 'approvals.request.unstuck' } })).toBe(1);
  });

  it('rejects an ineligible target: the requester, a person without the permission, someone who already approved', async () => {
    const r = await w.raise(w.people.treasurer!, { type: 'EXPENSE', entityId: 1, amountPaise: BIG });
    const ctx = w.ctx(w.people.chairman!);
    const bad = (userId: number, version = v(r)) =>
      reassign(ctx, r.id, { version, userId, reason: 'Because needed' });
    await expect(bad(w.people.treasurer!.id)).rejects.toMatchObject({
      status: 422,
      code: 'REASSIGN_TARGET_NOT_ELIGIBLE',
    });
    await expect(bad(w.people.accountant!.id)).rejects.toMatchObject({
      code: 'REASSIGN_TARGET_NOT_ELIGIBLE',
    });
    await expect(bad(987_654)).rejects.toMatchObject({ code: 'REASSIGN_TARGET_NOT_ELIGIBLE' });
    await approve(w.ctx(w.people.chairman!, 1), r.id, { version: 1 });
    await expect(bad(w.people.chairman!.id, 2)).rejects.toMatchObject({
      code: 'REASSIGN_TARGET_NOT_ELIGIBLE',
    });
  });

  it('checks version, status and reason', async () => {
    const r = await w.raise(w.people.secretary!, { type: 'NOTICE_PUBLISH', entityId: 1 });
    const ctx = w.ctx(w.people.chairman!);
    const to = w.people.secretary!.id;
    await expect(
      reassign(ctx, r.id, { version: 5, userId: to, reason: 'Needs cover' }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'STALE_VERSION',
    });
    await expect(reassign(ctx, r.id, { version: 1, userId: to, reason: 'no' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      reassign(ctx, 123_456, { version: 1, userId: to, reason: 'Needs cover' }),
    ).rejects.toMatchObject({ status: 404, code: 'APPROVAL_NOT_FOUND' });
    await approve(ctx, r.id, { version: 1 });
    await expect(
      reassign(ctx, r.id, { version: 2, userId: to, reason: 'Needs cover' }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'APPROVAL_NOT_PENDING',
    });
  });

  it('ALL_OF: the target replaces one named vacant slot (slotIndex needed); a covered or missing slot is SLOT_NOT_VACANT', async () => {
    w = await approvalsWorld({ roles: ['chairman', 'treasurer', 'accountant'] });
    await w.raise(w.people.chairman!, { type: 'EXPENSE', entityId: 90, amountPaise: 300_000 }); // seed defaults
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
    const r = await w.raise(w.people.accountant!, { type: 'EXPENSE', entityId: 1, amountPaise: 1_000_000 });
    const sec = await memberUser(w.society, 'secretary', { name: 'sec' });
    const ctx = w.ctx(w.people.chairman!);
    const go = (o: { slotIndex?: number }) =>
      reassign(ctx, r.id, { version: 1, userId: sec.id, reason: 'Cover the slot', ...o });
    await expect(go({})).rejects.toMatchObject({ status: 422, code: 'SLOT_NOT_VACANT' });
    await expect(go({ slotIndex: 7 })).rejects.toMatchObject({ code: 'SLOT_NOT_VACANT' });
    expect(r.hasEligibleApprover).toBe(true);
    // the Secretary slot has a person now (the new member): it is not vacant any more
    await expect(go({ slotIndex: 1 })).rejects.toMatchObject({ code: 'SLOT_NOT_VACANT' });
  });
});

describe('counts and countForUser (8.2, 8.20)', () => {
  it('T14-41 forMe by eligible user, overdue, allPending, submittedOpen and stuck; the cache follows the epoch', async () => {
    await settle();
    const chair = w.people.chairman!.id;
    const treas = w.people.treasurer!.id;
    const acc = w.people.accountant!.id;
    expect(await countForUser(w.society.id!, chair)).toBe(0);
    const r = await w.raise(w.people.treasurer!, { type: 'EXPENSE', entityId: 1, amountPaise: BIG });
    await w.raise(w.people.secretary!, { type: 'NOTICE_PUBLISH', entityId: 2 });
    await settle();
    // the epoch moved, so the cached 0 is not served
    expect(await countsFor(w.society.id!, chair)).toMatchObject({
      forMe: 2,
      forMeByType: { EXPENSE: 1, NOTICE_PUBLISH: 1 },
      overdueForMe: 0,
      allPending: 2,
      submittedOpen: 0,
      stuck: 0,
    });
    expect(await countForUser(w.society.id!, chair)).toBe(2);
    expect(await countsFor(w.society.id!, treas)).toMatchObject({ forMe: 0, submittedOpen: 1 });
    expect(await countsFor(w.society.id!, acc)).toMatchObject({ forMe: 0, stuck: 0 });
    expect(
      events.some(e => e.event === 'approvals.changed' && e.room === `society:${w.society.id}:admin`),
    ).toBe(true);
    // the second read is the cached object and equal
    expect(await countsFor(w.society.id!, chair)).toEqual(await computeCounts(w.society.id!, chair));
    // after an approval (epoch bump) the count drops
    await approve(w.ctx(w.people.secretary!, 1), r.id, { version: 1 });
    await settle();
    expect((await countsFor(w.society.id!, chair)).forMe).toBe(2); // the expense still needs one more
    await approve(w.ctx(w.people.chairman!, 1), r.id, { version: 2 });
    await settle();
    expect((await countsFor(w.society.id!, chair)).forMe).toBe(1);
  });

  it('overdueForMe counts requests past dueAt; a delegate sees what the delegator can act on', async () => {
    const r = await w.raise(w.people.treasurer!, { type: 'EXPENSE', entityId: 1, amountPaise: BIG });
    await ApprovalRequest.update({ dueAt: new Date(nowMs() - 1000) }, { where: { id: r.id } });
    await ApprovalDelegation.create({
      societyId: w.society.id!,
      delegatorUserId: w.people.chairman!.id,
      delegateUserId: w.people.committee_member!.id,
      source: 'TERM_HANDOVER',
      types: null,
      maxAmountPaise: null,
      startsAt: new Date(nowMs() - 3_600_000),
      endsAt: new Date(nowMs() + 86_400_000),
      reason: 'Away',
    } as never);
    expect(await computeCounts(w.society.id!, w.people.chairman!.id)).toMatchObject({
      forMe: 1,
      overdueForMe: 1,
    });
    expect(await computeCounts(w.society.id!, w.people.committee_member!.id)).toMatchObject({ forMe: 1 });
  });

  it('stuck is counted for the Chairman only', async () => {
    w = await approvalsWorld({ roles: ['chairman', 'treasurer', 'accountant'] });
    await w.raise(w.people.chairman!, { type: 'EXPENSE', entityId: 1, amountPaise: BIG });
    expect((await computeCounts(w.society.id!, w.people.chairman!.id)).stuck).toBe(1);
    expect((await computeCounts(w.society.id!, w.people.accountant!.id)).stuck).toBe(0);
  });
});

describe('module 05 contract: export provider and purge handler', () => {
  it('registerApprovals registers both; the export streams all four tables of the society only', async () => {
    expect(exportProviders().find(p => p.module === 'approvals')).toBeDefined();
    expect(purgeHandlerList().find(h => h.module === 'approvals')?.tables).toEqual([
      'approval_rules',
      'approval_requests',
      'approval_actions',
      'approval_delegations',
    ]);
    await w.raise(w.people.treasurer!, { type: 'EXPENSE', entityId: 1, amountPaise: BIG });
    const names = approvalsExportProvider.tables.map(t => t.name);
    expect(names).toEqual([
      'approval_rules',
      'approval_requests',
      'approval_actions',
      'approval_delegations',
    ]);
    const counts: Record<string, number> = {};
    for (const t of approvalsExportProvider.tables) {
      let c = 0;
      for await (const row of t.stream(w.society.id!)) {
        expect(Number(row.societyId)).toBe(w.society.id);
        c++;
      }
      counts[t.name] = c;
    }
    expect(counts['approval_requests']).toBe(1);
    expect(counts['approval_actions']).toBe(1);
    expect(counts['approval_rules']).toBeGreaterThan(0);
    for (const t of approvalsExportProvider.tables) {
      const rows: Record<string, unknown>[] = [];
      for await (const row of t.stream(w.society.id! + 1000)) rows.push(row);
      expect(rows).toEqual([]);
    }
  });

  it('purge deletes the four tables of one society and leaves another society untouched', async () => {
    await w.raise(w.people.treasurer!, { type: 'EXPENSE', entityId: 1, amountPaise: BIG });
    await ApprovalDelegation.create({
      societyId: w.society.id!,
      delegatorUserId: w.people.chairman!.id,
      delegateUserId: w.people.secretary!.id,
      source: 'TERM_HANDOVER',
      types: null,
      maxAmountPaise: null,
      startsAt: new Date(nowMs()),
      endsAt: new Date(nowMs() + 86_400_000),
      reason: 'Away',
    } as never);
    const w2 = await (async () => {
      const s2 = await Society.create({
        slug: `other-${Date.now() % 100000}`,
        name: 'Other CHS',
        city: 'Pune',
        state: 'Maharashtra',
        pincode: '411045',
        addressLine1: 'x',
        ...lifecycleColumns('ACTIVE'),
      } as never);
      await ApprovalRule.create({
        societyId: s2.id!,
        type: 'NOTICE_PUBLISH',
        name: 'Other',
        priority: 1,
        steps: [],
        action: 'AUTO_APPROVE',
      } as never);
      return s2;
    })();
    const count = async (table: string, societyId: number) =>
      Number(
        (
          await sequelize.query<{ c: number }>(
            `SELECT COUNT(*) c FROM ${table} WHERE societyId = :societyId`,
            {
              replacements: { societyId },
              type: QueryTypes.SELECT,
            },
          )
        )[0]!.c,
      );
    const res = await purgeApprovals(w.society.id!);
    expect(res.deleted).toBeGreaterThanOrEqual(4);
    for (const t of approvalsExportProvider.tables) expect(await count(t.name, w.society.id!)).toBe(0);
    expect(await count('approval_rules', w2.id!)).toBe(1);
    expect(await purgeApprovals(w.society.id!)).toEqual({ deleted: 0, anonymised: 0 });
  });
});
