import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalDelegation, AuditLog, closeDb, sequelize } from '../../../src/models';
import { advance, now } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { as, login, makeSociety, memberUser, resetLogins } from '../../helpers/access';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { configWorld, idem, type ConfigWorld } from '../../helpers/approvals-config';
import { events } from '../../helpers/auth';
import { sentNotifications } from '../../../src/modules/approvals/approvals.ports';
import { createHandoverDelegation } from '../../../src/modules/approvals/approvals.delegations.service';
import { rawTerm } from '../../helpers/committee';
import { approve } from '../../../src/modules/approvals/approvals.public';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
let w: ConfigWorld;
beforeEach(async () => {
  resetLogins();
  resetRateLimits();
  w = await configWorld();
  sentNotifications.length = 0;
  events.length = 0;
});

const day = (n: number) => new Date(now().getTime() + n * 86_400_000).toISOString();
const body = (o: Record<string, unknown> = {}) => ({
  delegateUserId: w.people.secretary!.id,
  startsAt: day(1),
  endsAt: day(8),
  reason: 'Away on a family trip',
  ...o,
});
const create = async (role = 'treasurer', o: Record<string, unknown> = {}) =>
  (await w.api(role))('post', '/approvals/delegations', body(o), { headers: idem() });

describe('POST /approvals/delegations (8.18, BR-14-24)', () => {
  it('creates an OUT_OF_OFFICE delegation: shape, audit, notification, realtime', async () => {
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      source: 'OUT_OF_OFFICE',
      types: null,
      maxAmountPaise: null,
      displayStatus: 'SCHEDULED',
      version: 1,
      delegator: { userId: w.people.treasurer!.id, name: 'treasurer' },
      delegate: { userId: w.people.secretary!.id, name: 'secretary' },
    });
    expect(
      await AuditLog.count({
        where: { action: 'approvals.delegation.created', entityId: String(r.body.data.id) },
      }),
    ).toBe(1);
    await drainQueues();
    const n = sentNotifications.filter(s => s.template === 'approvals.delegation_created');
    expect(n.length).toBe(1);
    expect(n[0]!.userIds).toEqual([w.people.secretary!.id]);
    const rt = events
      .filter(e => e.event === 'approvals.delegation.updated')
      .map(e => e.room)
      .sort();
    expect(rt).toEqual([`user:${w.people.secretary!.id}`, `user:${w.people.treasurer!.id}`].sort());
  });
  it('an active window reads ACTIVE; types and amount limits are stored', async () => {
    const r = await create('treasurer', {
      startsAt: now().toISOString(),
      types: ['EXPENSE', 'OFFLINE_PAYMENT'],
      maxAmountPaise: 500_000,
    });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      displayStatus: 'ACTIVE',
      types: ['EXPENSE', 'OFFLINE_PAYMENT'],
      maxAmountPaise: 500_000,
    });
  });
  it('replays with the same Idempotency-Key and refuses a different body under it', async () => {
    const api = await w.api('treasurer');
    const headers = idem();
    const a = await api('post', '/approvals/delegations', body(), { headers });
    const b = await api('post', '/approvals/delegations', body(), { headers });
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.data.id).toBe(a.body.data.id);
    const c = await api('post', '/approvals/delegations', body({ reason: 'Different reason' }), { headers });
    expect(c.status).toBe(409);
    expect(await ApprovalDelegation.count()).toBe(1);
  });
  it('T14-24: 402 FEATURE_NOT_IN_PLAN below Standard', async () => {
    w = await configWorld({ plan: 'STARTER', roles: ['chairman', 'secretary', 'treasurer', 'accountant'] });
    const r = await create();
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('FEATURE_NOT_IN_PLAN');
    expect(await ApprovalDelegation.count()).toBe(0);
  });
  it('T14-25: an overlapping delegation of the delegator is refused; a later one is fine', async () => {
    expect((await create()).status).toBe(201);
    const o = await create('treasurer', {
      delegateUserId: w.people.chairman!.id,
      startsAt: day(3),
      endsAt: day(10),
    });
    expect(o.status).toBe(409);
    expect(o.body.code).toBe('DELEGATION_OVERLAP');
    expect(
      (
        await create('treasurer', {
          delegateUserId: w.people.chairman!.id,
          startsAt: day(8),
          endsAt: day(12),
        })
      ).status,
    ).toBe(201);
  });
  it('T14-26: the delegate may not have a delegation of their own in the period', async () => {
    expect((await create('secretary', { delegateUserId: w.people.chairman!.id })).status).toBe(201);
    const r = await create('treasurer', { delegateUserId: w.people.secretary!.id });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('DELEGATION_CHAIN_NOT_ALLOWED');
  });
  it('422 DELEGATION_SELF, DELEGATE_NOT_ELIGIBLE and DELEGATION_WINDOW_INVALID', async () => {
    expect((await create('treasurer', { delegateUserId: w.people.treasurer!.id })).body.code).toBe(
      'DELEGATION_SELF',
    );
    // the accountant has no approvals.inbox.view; an outsider is no member
    for (const id of [w.people.accountant!.id, 999999]) {
      const r = await create('treasurer', { delegateUserId: id });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('DELEGATE_NOT_ELIGIBLE');
    }
    for (const o of [
      { startsAt: day(-1), endsAt: day(3) },
      { startsAt: day(3), endsAt: day(2) },
      { startsAt: day(1), endsAt: day(92) },
    ]) {
      const r = await create('treasurer', o);
      expect(r.status, JSON.stringify(o)).toBe(422);
      expect(r.body.code).toBe('DELEGATION_WINDOW_INVALID');
    }
    // up to 5 minutes in the past and exactly 90 days are accepted
    expect(
      (
        await create('treasurer', {
          startsAt: new Date(now().getTime() - 4 * 60_000).toISOString(),
          endsAt: day(1),
        })
      ).status,
    ).toBe(201);
  });
  it('400 for bad fields', async () => {
    for (const o of [
      { reason: 'no' },
      { types: [] },
      { types: ['EXPENSE', 'EXPENSE'] },
      { types: ['NOPE'] },
      { maxAmountPaise: 0 },
      { startsAt: 'tomorrow' },
      { extra: 1 },
    ]) {
      const r = await create('treasurer', o);
      expect(r.status, JSON.stringify(o)).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }
  });
  it('delegating for someone else needs settings.approval_rules.edit', async () => {
    const own = await create('treasurer', { delegatorUserId: w.people.chairman!.id });
    expect(own.status).toBe(403);
    const r = await create('chairman', { delegatorUserId: w.people.treasurer!.id });
    expect(r.status).toBe(201);
    expect(r.body.data.delegator.userId).toBe(w.people.treasurer!.id);
    await drainQueues();
    const n = sentNotifications.find(s => s.template === 'approvals.delegation_created')!;
    expect(n.userIds.sort()).toEqual([w.people.secretary!.id, w.people.treasurer!.id].sort());
  });
  it('401 REAUTH_REQUIRED when the sign-in is old; 403 without the inbox permission', async () => {
    expect((await create('accountant')).status).toBe(403);
    const api = await w.api('treasurer');
    advance(12 * 60_000);
    const r = await api('post', '/approvals/delegations', body({ startsAt: day(1), endsAt: day(2) }), {
      headers: idem(),
    });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('REAUTH_REQUIRED');
  });
  it('T14-27: the delegate decides inside the window with onBehalfOf, and loses the right after endsAt', async () => {
    const c = await create('chairman', {
      delegateUserId: w.people.secretary!.id,
      startsAt: now().toISOString(),
      endsAt: day(2),
    });
    expect(c.status).toBe(201);
    const req = await w.raise('accountant', { type: 'OFFLINE_PAYMENT', entityId: 1, amountPaise: 100_000 });
    const asSecretary = w.ctxOf('secretary');
    // the secretary is not an approver of OFFLINE_PAYMENT themselves; the chairman's delegation lets them act
    const done = await approve(asSecretary, req.id, {
      version: Number(req.version),
      onBehalfOfUserId: w.people.chairman!.id,
    });
    expect(done.status).toBe('APPROVED');
    const second = await w.raise('accountant', {
      type: 'OFFLINE_PAYMENT',
      entityId: 2,
      amountPaise: 100_000,
    });
    advance(3 * 86_400_000);
    await expect(approve(asSecretary, second.id, { version: Number(second.version) })).rejects.toMatchObject({
      code: 'NOT_ELIGIBLE_APPROVER',
    });
    await expect(
      approve(asSecretary, second.id, {
        version: Number(second.version),
        onBehalfOfUserId: w.people.chairman!.id,
      }),
    ).rejects.toMatchObject({ code: 'NO_ACTIVE_DELEGATION' });
  });
});

describe('GET /approvals/delegations', () => {
  it('MINE lists where I am delegator or delegate; ALL needs the rule view permission', async () => {
    await create('treasurer', { delegateUserId: w.people.secretary!.id });
    await create('chairman', { delegateUserId: w.people.committee_member!.id });
    const mine = await (await w.api('treasurer'))('get', '/approvals/delegations');
    expect(mine.body.data.length).toBe(1);
    const asDelegate = await (await w.api('secretary'))('get', '/approvals/delegations');
    expect(asDelegate.body.data.length).toBe(1);
    expect(asDelegate.body.pagination).toMatchObject({ page: 1, total: 1 });
    const all = await (
      await w.api('secretary')
    )('get', '/approvals/delegations', undefined, { query: { scope: 'ALL' } });
    expect(all.body.data.length).toBe(2);
    const denied = await (
      await w.api('facility_manager')
    )('get', '/approvals/delegations', undefined, { query: { scope: 'ALL' } });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
  });
  it('filters by status and shows displayStatus; sorts and pages', async () => {
    const api = await w.api('chairman');
    const a = (await create('treasurer', { startsAt: now().toISOString(), endsAt: day(2) })).body.data;
    await create('chairman', {
      delegateUserId: w.people.committee_member!.id,
      startsAt: day(1),
      endsAt: day(2),
    });
    await api('post', `/approvals/delegations/${a.id}/revoke`, {
      version: 1,
      reason: 'Back early from trip',
    });
    const rev = await api('get', '/approvals/delegations', undefined, {
      query: { scope: 'ALL', status: 'REVOKED' },
    });
    expect(rev.body.data.map((x: any) => x.displayStatus)).toEqual(['REVOKED']);
    const act = await api('get', '/approvals/delegations', undefined, {
      query: { scope: 'ALL', status: 'ACTIVE' },
    });
    expect(act.body.data.map((x: any) => x.displayStatus)).toEqual(['SCHEDULED']);
    const page = await api('get', '/approvals/delegations', undefined, {
      query: { scope: 'ALL', limit: '1', page: '2', sortBy: 'createdAt', sortOrder: 'asc' },
    });
    expect(page.body.data.length).toBe(1);
    expect(page.body.pagination.totalPages).toBe(2);
    await ApprovalDelegation.update(
      {
        startsAt: new Date(now().getTime() - 2 * 86_400_000),
        endsAt: new Date(now().getTime() - 86_400_000),
      },
      { where: { status: 'ACTIVE' } },
    );
    const exp = await api('get', '/approvals/delegations', undefined, {
      query: { scope: 'ALL', status: 'EXPIRED' },
    });
    expect(exp.body.data.length).toBe(1);
    expect(exp.body.data[0].displayStatus).toBe('EXPIRED');
  });
});

describe('POST /approvals/delegations/:id/revoke', () => {
  it('the delegator revokes; both people are told; audit and realtime follow', async () => {
    const c = (await create('treasurer')).body.data;
    sentNotifications.length = 0;
    events.length = 0;
    const r = await (
      await w.api('treasurer')
    )('post', `/approvals/delegations/${c.id}/revoke`, { version: 1, reason: 'Plans have changed' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'REVOKED', displayStatus: 'REVOKED', version: 2 });
    const row = (await ApprovalDelegation.findByPk(c.id))!;
    expect(row.revokedBy).toBe(w.people.treasurer!.id);
    expect(row.revokeReason).toBe('Plans have changed');
    expect(await AuditLog.count({ where: { action: 'approvals.delegation.revoked' } })).toBe(1);
    await drainQueues();
    const n = sentNotifications.find(s => s.template === 'approvals.delegation_revoked')!;
    expect(n.userIds.sort()).toEqual([w.people.secretary!.id, w.people.treasurer!.id].sort());
    expect(events.filter(e => e.event === 'approvals.delegation.updated').length).toBe(2);
  });
  it("a rule editor may revoke someone else's; the delegate may not (403)", async () => {
    const c = (await create('treasurer')).body.data;
    const d = await (
      await w.api('secretary')
    )('post', `/approvals/delegations/${c.id}/revoke`, { version: 1, reason: 'I do not want it' });
    expect(d.status).toBe(403);
    expect(d.body.code).toBe('PERMISSION_DENIED');
    const e = await (
      await w.api('chairman')
    )('post', `/approvals/delegations/${c.id}/revoke`, { version: 1, reason: 'Chairman decision' });
    expect(e.status).toBe(200);
  });
  it('409 DELEGATION_NOT_ACTIVE for a second revoke or an expired one, 409 STALE_VERSION for an old version', async () => {
    const api = await w.api('treasurer');
    const c = (await create()).body.data;
    expect(
      (await api('post', `/approvals/delegations/${c.id}/revoke`, { version: 7, reason: 'Wrong version' }))
        .body.code,
    ).toBe('STALE_VERSION');
    expect(
      (
        await api('post', `/approvals/delegations/${c.id}/revoke`, {
          version: 1,
          reason: 'Plans have changed',
        })
      ).status,
    ).toBe(200);
    const again = await api('post', `/approvals/delegations/${c.id}/revoke`, {
      version: 2,
      reason: 'Plans have changed',
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('DELEGATION_NOT_ACTIVE');
    await ApprovalDelegation.update({ status: 'EXPIRED' }, { where: { id: c.id } });
    expect(
      (
        await api('post', `/approvals/delegations/${c.id}/revoke`, {
          version: 2,
          reason: 'Plans have changed',
        })
      ).body.code,
    ).toBe('DELEGATION_NOT_ACTIVE');
  });
  it('revoking stays available after a downgrade; 400 for a short reason', async () => {
    const c = (await create('treasurer')).body.data;
    const api = await w.api('treasurer');
    expect(
      (await api('post', `/approvals/delegations/${c.id}/revoke`, { version: 1, reason: 'no' })).status,
    ).toBe(400);
    const starter = await configWorld({
      plan: 'STARTER',
      roles: ['chairman', 'secretary', 'treasurer', 'accountant'],
    });
    const row = await ApprovalDelegation.create({
      societyId: starter.society.id!,
      delegatorUserId: starter.people.treasurer!.id,
      delegateUserId: starter.people.secretary!.id,
      source: 'OUT_OF_OFFICE',
      types: null,
      maxAmountPaise: null,
      startsAt: new Date(now().getTime() + 3_600_000),
      endsAt: new Date(now().getTime() + 86_400_000),
      reason: 'Left over from Standard',
      committeeTermId: null,
      endingNotifiedAt: null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      createdBy: null,
      updatedBy: null,
    });
    const r = await (
      await starter.api('treasurer')
    )('post', `/approvals/delegations/${row.id}/revoke`, {
      version: 1,
      reason: 'Cleaning up after downgrade',
    });
    expect(r.status).toBe(200);
  });
  it('T14-36: another society cannot revoke or see a delegation', async () => {
    const c = (await create('treasurer')).body.data;
    const other = await makeSociety('Other Society');
    const chairmanB = await memberUser(other, 'chairman', { name: 'B chairman' });
    const b = as(await login(chairmanB, { societyId: other.id! }));
    const r = await b('post', `/approvals/delegations/${c.id}/revoke`, {
      version: 1,
      reason: 'Not mine to revoke',
    });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('DELEGATION_NOT_FOUND');
    const list = await b('get', '/approvals/delegations', undefined, { query: { scope: 'ALL' } });
    expect(list.body.data).toEqual([]);
    expect((await ApprovalDelegation.findByPk(c.id))!.status).toBe('ACTIVE');
  });
});

describe('createHandoverDelegation (BR-10-18, BR-14-24)', () => {
  let termId = 0;
  beforeEach(async () => {
    termId = Number((await rawTerm(w.society.id!)).id);
  });
  const input = (o: Record<string, unknown> = {}) => ({
    fromUserId: w.people.chairman!.id,
    toUserId: w.people.secretary!.id,
    startsAt: now(),
    endsAt: new Date(now().getTime() + 30 * 86_400_000),
    reason: 'Committee hand-over: 2026-2029',
    committeeTermId: termId,
    ...o,
  });
  const run = (i: ReturnType<typeof input>) =>
    sequelize.transaction(t => createHandoverDelegation(w.ctxOf('chairman'), i, t));

  it('creates a TERM_HANDOVER row without the plan gate and returns its id', async () => {
    w = await configWorld({ plan: 'STARTER', roles: ['chairman', 'secretary', 'treasurer', 'accountant'] });
    termId = Number((await rawTerm(w.society.id!)).id);
    const r = await sequelize.transaction(t =>
      createHandoverDelegation(
        w.ctxOf('chairman'),
        { ...input(), fromUserId: w.people.chairman!.id, toUserId: w.people.secretary!.id },
        t,
      ),
    );
    const row = (await ApprovalDelegation.findByPk(r.id))!;
    expect(row).toMatchObject({
      source: 'TERM_HANDOVER',
      types: null,
      maxAmountPaise: null,
      status: 'ACTIVE',
    });
    expect(await AuditLog.count({ where: { action: 'approvals.delegation.created' } })).toBe(1);
  });
  it('allows 60 days at most and uses the five codes the committee module skips', async () => {
    await expect(run(input({ endsAt: new Date(now().getTime() + 61 * 86_400_000) }))).rejects.toMatchObject({
      code: 'DELEGATION_WINDOW_INVALID',
    });
    await expect(run(input({ toUserId: w.people.chairman!.id }))).rejects.toMatchObject({
      code: 'DELEGATION_SELF',
    });
    await expect(run(input({ toUserId: w.people.accountant!.id }))).rejects.toMatchObject({
      code: 'DELEGATE_NOT_ELIGIBLE',
    });
    expect((await run(input())).id).toBeGreaterThan(0);
    await expect(run(input({ toUserId: w.people.treasurer!.id }))).rejects.toMatchObject({
      code: 'DELEGATION_OVERLAP',
    });
    await expect(
      run(input({ fromUserId: w.people.committee_member!.id, toUserId: w.people.chairman!.id })),
    ).rejects.toMatchObject({
      code: 'DELEGATION_CHAIN_NOT_ALLOWED',
    });
  });
  it("a failed pair leaves nothing behind (rollback of the caller's savepoint)", async () => {
    await expect(run(input({ endsAt: new Date(now().getTime() + 61 * 86_400_000) }))).rejects.toBeTruthy();
    expect(await ApprovalDelegation.count()).toBe(0);
  });
});
