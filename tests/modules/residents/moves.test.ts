import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, MoveRequest, Tenancy, UnitResident, closeDb, sequelize } from '../../../src/models';
import { advance, setNow } from '../../../src/lib/clock';
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';
import { drainQueues } from '../../../src/lib/queue';
import { residentPortCalls } from '../../../src/modules/residents/residents.ports';
import {
  approvalStub,
  approveRequest as approve,
  depositStub,
  moveRequests,
  residentsHooks,
  setResidentPorts,
} from '../../../src/modules/residents/residents.public';
import { runDepositRefunds } from '../../../src/modules/residents/residents.moves.service';
import { syncLinksFor } from '../../../src/modules/residents/residents.jobs';
import { systemCtx } from '../../../src/types/context';
import { makeUnit } from '../../helpers/society-setup';
import {
  activeTenancy,
  docItem,
  guardOf,
  idemKey,
  loginTenant,
  ownerOf,
  residentsSociety,
  resetResidentsP2,
  setSetting,
} from '../../helpers/residents-p2';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetResidentsP2);

type S = Awaited<ReturnType<typeof residentsSociety>>;
const MOVE_DATE = '2026-11-04'; // a Wednesday, three days after the frozen "today" (2026-11-01)

const move = (over: Record<string, unknown> = {}) => ({
  type: 'MOVE_IN',
  householdOf: 'OWNER',
  moveDate: MOVE_DATE,
  slotStart: '10:00',
  slotEnd: '14:00',
  ...over,
});
const create = (c: any, s: S, over: Record<string, unknown> = {}) =>
  c('post', '/move-requests', { unitId: s.unit.id, ...move(over) }, { headers: idemKey() });
const calls = (fn: string) => residentPortCalls.filter(c => c.fn === fn);

describe('create and slot rules (BR-09-40, 41)', () => {
  it('an admin creates an owner move-in; the placeholder approves it and issues an 8 character gate pass', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const r = await create(s.c, s);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      type: 'MOVE_IN',
      status: 'APPROVED',
      unitLabel: 'A-1203',
      slotStart: '10:00',
      slotEnd: '14:00',
      version: expect.any(Number),
    });
    expect(r.body.data.gatePassCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(await AuditLog.count({ where: { action: 'residents.move_request.created' } })).toBe(1);
    expect(await AuditLog.count({ where: { action: 'residents.move_request.approved' } })).toBe(1);
    const row = await AuditLog.findOne({ where: { action: 'residents.move_request.approved' } });
    expect(JSON.stringify(row!.after)).not.toContain(r.body.data.gatePassCode);
  });

  it('T09-23 slots outside the hours, over the maximum, on a blackout weekday or in the past are MOVE_SLOT_NOT_ALLOWED', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    for (const over of [
      { slotStart: '18:30', slotEnd: '20:00' },
      { slotStart: '09:00', slotEnd: '17:00' },
      { slotStart: '12:00', slotEnd: '12:00' },
      { moveDate: '2026-10-31' },
      { moveDate: '2027-03-01' },
    ]) {
      const r = await create(s.c, s, over);
      expect([r.status, r.body.code], JSON.stringify(over)).toEqual([422, 'MOVE_SLOT_NOT_ALLOWED']);
    }
    await setSetting(s.society.id!, 'residents.moveBlackoutWeekdays', [3]);
    expect((await create(s.c, s)).body.code).toBe('MOVE_SLOT_NOT_ALLOWED');
    const bad = await create(s.c, s, { slotStart: '10:15' });
    expect(bad.body.code).toBe('VALIDATION_FAILED');
  });

  it('an admin may choose today; a second open request of the type is MOVE_REQUEST_EXISTS', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    expect((await create(s.c, s, { moveDate: '2026-11-01' })).status).toBe(201);
    const dup = await create(s.c, s);
    expect([dup.status, dup.body.code]).toEqual([409, 'MOVE_REQUEST_EXISTS']);
  });

  it('tenant households need the right tenancy state (TENANCY_STATE_INVALID, NO_LIVE_TENANCY)', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const none = await create(s.c, s, { householdOf: 'TENANT' });
    expect([none.status, none.body.code]).toEqual([422, 'NO_LIVE_TENANCY']);
    await activeTenancy(s);
    const out = await create(s.c, s, { householdOf: 'TENANT', type: 'MOVE_OUT' });
    expect([out.status, out.body.code]).toEqual([422, 'TENANCY_STATE_INVALID']);
    expect((await create(s.c, s, { householdOf: 'TENANT' })).status).toBe(201);
  });

  it('T09-55 creating while the society is suspended is 423; reads work', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    await sequelize.query(
      "UPDATE societies SET status = 'SUSPENDED', suspensionCause = 'MANUAL' WHERE id = :id",
      {
        replacements: { id: s.society.id },
      },
    );
    await flushAcl();
    const r = await create(s.c, s);
    expect([r.status, r.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
    expect((await s.c('get', '/move-requests')).status).toBe(200);
  });
});

describe('dues (BR-09-42, 43, T09-19, T09-20)', () => {
  it('T09-19 a move-out with a balance is BLOCKED_DUES with the balance; T09-20 the creator cannot override', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    setResidentPorts({ unitLedger: { balance: async () => 482500 } });
    const r = await create(s.c, s, { type: 'MOVE_OUT' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'BLOCKED_DUES',
      duesBalancePaise: 482500,
      next: { action: 'PAY_DUES', payUrl: `/pay?unitId=${s.unit.id}` },
    });
    const id = r.body.data.id;
    const self = await s.c('post', `/move-requests/${id}/override-dues`, {
      reason: 'Owner will pay later',
      version: r.body.data.version,
    });
    expect([self.status, self.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    const ok = await s.secretary.c('post', `/move-requests/${id}/override-dues`, {
      reason: 'Owner will pay later',
      version: r.body.data.version,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('APPROVED');
    expect(ok.body.data.duesOverridden).toBe(true);
    expect(await AuditLog.count({ where: { action: 'residents.move_request.dues_overridden' } })).toBe(1);
  });

  it('recheck is limited to once a minute and continues the pipeline once the balance is paid', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    let balance = 100;
    setResidentPorts({ unitLedger: { balance: async () => balance } });
    const r = await create(s.c, s, { type: 'MOVE_OUT' });
    const id = r.body.data.id;
    const v = r.body.data.version;
    const early = await s.c('post', `/move-requests/${id}/recheck-dues`, { version: v });
    expect([early.status, early.body.code]).toEqual([429, 'RATE_LIMITED']);
    advance(61_000);
    const still = await s.c('post', `/move-requests/${id}/recheck-dues`, { version: v });
    expect(still.body.data.status).toBe('BLOCKED_DUES');
    advance(61_000);
    balance = 0;
    const done = await s.c('post', `/move-requests/${id}/recheck-dues`, { version: still.body.data.version });
    expect(done.body.data.status).toBe('APPROVED');
    const wrong = await s.c('post', `/move-requests/${id}/recheck-dues`, { version: done.body.data.version });
    expect(wrong.body.code).toBe('INVALID_STATE');
  });
});

describe('deposit (BR-09-42, T09-21)', () => {
  it('T09-21 PENDING_DEPOSIT, onDepositPaid then module 14 auto-approves with a gate pass', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    await setSetting(s.society.id!, 'residents.moveDepositPaise', 500000);
    depositStub.mode = 'pending';
    const r = await create(s.c, s);
    expect(r.body.data).toMatchObject({
      status: 'PENDING_DEPOSIT',
      depositPaise: 500000,
      next: { action: 'PAY_DEPOSIT' },
    });
    const depositId = (await MoveRequest.findByPk(r.body.data.id))!.depositId!;
    expect(depositId).toBeGreaterThan(0);
    await sequelize.transaction(t =>
      residentsHooks.onDepositPaid(
        systemCtx('t'),
        { refType: 'move_request', refId: r.body.data.id, depositId },
        t,
      ),
    );
    const row = (await MoveRequest.findByPk(r.body.data.id))!;
    expect(row.status).toBe('APPROVED');
    expect(row.gatePassCode).toHaveLength(8);
    expect(row.depositPaidAt).not.toBeNull();
    // idempotent: a second callback changes nothing
    await sequelize.transaction(t =>
      residentsHooks.onDepositPaid(systemCtx('t'), { refType: 'move_request', refId: row.id!, depositId }, t),
    );
    expect(calls('approvals.request')).toHaveLength(1);
  });

  it('cancelling refunds a paid deposit in full once; reject through module 14 refunds too', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    await setSetting(s.society.id!, 'residents.moveDepositPaise', 500000);
    const r = await create(s.c, s);
    expect(r.body.data.status).toBe('APPROVED');
    const c = await s.c('post', `/move-requests/${r.body.data.id}/cancel`, {
      reason: 'Plans changed',
      version: r.body.data.version,
    });
    expect(c.body.data.status).toBe('CANCELLED');
    expect(calls('deposits.requestRefund')).toHaveLength(1);
    expect(calls('deposits.requestRefund')[0]!.input).toMatchObject({ deductionPaise: 0 });
    const bad = await s.c('post', `/move-requests/${r.body.data.id}/cancel`, {
      reason: 'Plans changed',
      version: c.body.data.version,
    });
    expect(bad.body.code).toBe('INVALID_STATE');
  });
});

describe('slot and lift conflicts (BR-09-44, T09-22)', () => {
  it('T09-22 overlapping slots on the same lift conflict (Premium); other lift or time is fine', async () => {
    const s = await residentsSociety({ plan: 'PREMIUM' });
    await ownerOf(s);
    const other = await makeUnit(s.c, s.building.id, '1204', 2);
    const a = await create(s.c, s, { liftLabel: 'Lift 1' });
    expect(a.body.data.status, JSON.stringify(a.body)).toBe('APPROVED');
    const b = await s.c(
      'post',
      '/move-requests',
      { unitId: other.id, ...move({ liftLabel: 'lift 1', slotStart: '13:00', slotEnd: '15:00' }) },
      { headers: idemKey() },
    );
    expect([b.status, b.body.code]).toEqual([409, 'MOVE_SLOT_CONFLICT']);
    expect(b.body.errors[0].conflicts).toEqual([{ slotStart: '10:00', slotEnd: '14:00' }]);
    const c = await s.c(
      'post',
      '/move-requests',
      { unitId: other.id, ...move({ liftLabel: 'Lift 2' }) },
      { headers: idemKey() },
    );
    expect(c.status).toBe(201);
  });

  it('a lift label needs the Premium feature', async () => {
    const s = await residentsSociety({ plan: 'STANDARD' });
    await ownerOf(s);
    const r = await create(s.c, s, { liftLabel: 'Lift 1' });
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
  });

  it('the conflict is checked again when module 14 approves', async () => {
    const s = await residentsSociety({ plan: 'PREMIUM' });
    await ownerOf(s);
    const other = await makeUnit(s.c, s.building.id, '1204', 2);
    approvalStub.mode = 'manual';
    const a = await create(s.c, s, { liftLabel: 'Lift 1' });
    const b = await s.c(
      'post',
      '/move-requests',
      { unitId: other.id, ...move({ liftLabel: 'Lift 1' }) },
      { headers: idemKey() },
    );
    expect([a.body.data.status, b.body.data.status]).toEqual(['PENDING_APPROVAL', 'PENDING_APPROVAL']);
    await approve((await MoveRequest.findByPk(a.body.data.id))!.approvalRequestId!, systemCtx('t'));
    await expect(
      approve((await MoveRequest.findByPk(b.body.data.id))!.approvalRequestId!, systemCtx('t')),
    ).rejects.toMatchObject({ code: 'MOVE_SLOT_CONFLICT' });
  });
});

describe('owner NOC (BR-09-42)', () => {
  it('a tenant request waits for the owner, who confirms; a non-owner cannot; decline rejects', async () => {
    const s = await residentsSociety();
    const owner = await ownerOf(s);
    await activeTenancy(s);
    const tenant = await loginTenant(s);
    const r = await tenant.c(
      'post',
      '/me/move-requests',
      { unitId: s.unit.id, ...move({ householdOf: 'TENANT' }) },
      { headers: idemKey() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.status).toBe('PENDING_OWNER');
    const id = r.body.data.id;
    const no = await tenant.c('post', `/me/move-requests/${id}/owner-confirm`, {
      version: r.body.data.version,
    });
    expect([no.status, no.body.code]).toEqual([403, 'OWNER_ACTION_ONLY']);
    const ok = await owner.c('post', `/me/move-requests/${id}/owner-confirm`, {
      version: r.body.data.version,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('APPROVED');
    expect(await AuditLog.count({ where: { action: 'residents.move_request.owner_confirmed' } })).toBe(1);

    const c = await tenant.c('post', `/me/move-requests/${id}/cancel`, {
      reason: 'Changed the date',
      version: ok.body.data.version,
    });
    expect(c.body.data.status).toBe('CANCELLED');
    const again = await tenant.c(
      'post',
      '/me/move-requests',
      { unitId: s.unit.id, ...move({ householdOf: 'TENANT' }) },
      { headers: idemKey() },
    );
    const dec = await owner.c('post', `/me/move-requests/${again.body.data.id}/owner-decline`, {
      reason: 'Not this week',
      version: again.body.data.version,
    });
    expect(dec.body.data.status).toBe('REJECTED');
    expect(dec.body.data.decisionReason).toBe('Not this week');
  });

  it('a tenant who attaches a NOC skips the owner confirmation', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    await activeTenancy(s);
    const tenant = await loginTenant(s);
    const noc = await docItem(s.society.id!, tenant.user.id, 'NOC');
    const r = await tenant.c(
      'post',
      '/me/move-requests',
      { unitId: s.unit.id, ...move({ householdOf: 'TENANT', fileIds: [noc] }) },
      { headers: idemKey() },
    );
    expect(r.body.data.status, JSON.stringify(r.body)).toBe('APPROVED');
  });

  it('T09-47 a resident cannot read or change a move of another flat', async () => {
    const s = await residentsSociety({ plan: 'PREMIUM' });
    const owner = await ownerOf(s);
    const other = await makeUnit(s.c, s.building.id, '1204', 2);
    const r = await s.c('post', '/move-requests', { unitId: other.id, ...move() }, { headers: idemKey() });
    const g = await owner.c('get', `/me/move-requests/${r.body.data.id}`);
    expect([g.status, g.body.code]).toEqual([404, 'MOVE_REQUEST_NOT_FOUND']);
    const c = await owner.c('post', `/me/move-requests/${r.body.data.id}/cancel`, {
      reason: 'Not my move',
      version: 1,
    });
    expect(c.body.code).toBe('MOVE_REQUEST_NOT_FOUND');
    expect((await owner.c('get', '/me/move-requests')).body.data).toEqual([]);
  });
});

describe('start and complete (BR-09-46, 47, T09-24, T09-25)', () => {
  it('T09-24 wrong code and a right code on another date are GATE_PASS_INVALID; the right code on the date starts it', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const guard = await guardOf(s);
    const later = await create(s.c, s, { moveDate: '2026-11-02' });
    const wrong = await guard.c('post', `/gate/move-requests/${later.body.data.id}/start`, {
      gatePassCode: 'AAAAAAAA',
      version: later.body.data.version,
    });
    expect([wrong.status, wrong.body.code]).toEqual([422, 'GATE_PASS_INVALID']);
    const date = await guard.c('post', `/gate/move-requests/${later.body.data.id}/start`, {
      gatePassCode: later.body.data.gatePassCode,
      version: later.body.data.version,
    });
    expect([date.status, date.body.code]).toEqual([422, 'GATE_PASS_INVALID']);
    await s.c('post', `/move-requests/${later.body.data.id}/cancel`, {
      reason: 'Moving to today',
      version: later.body.data.version,
    });
    const r = await create(s.c, s, { moveDate: '2026-11-01' });
    const code = r.body.data.gatePassCode as string;
    const list = await guard.c('get', '/gate/move-requests');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).not.toHaveProperty('gatePassCode');
    expect((await moveRequests.listForGate(s.society.id!, '2026-11-01'))[0]).toMatchObject({
      unitLabel: 'A-1203',
      status: 'APPROVED',
    });
    const ok = await guard.c('post', `/gate/move-requests/${r.body.data.id}/start`, {
      gatePassCode: code.toLowerCase(),
      version: r.body.data.version,
    });
    expect(ok.body.data.status, JSON.stringify(ok.body)).toBe('IN_PROGRESS');
    const done = await guard.c('post', `/gate/move-requests/${r.body.data.id}/complete`, {
      version: ok.body.data.version,
      note: 'All done',
    });
    expect(done.body.data.status).toBe('COMPLETED');
    const again = await s.c('post', `/move-requests/${r.body.data.id}/start`, {
      version: done.body.data.version,
    });
    expect(again.body.code).toBe('INVALID_STATE');
    expect(
      (await guard.c('get', '/gate/move-requests', undefined, { query: { date: '2026-12-25' } })).body.code,
    ).toBe('VALIDATION_FAILED');
  });

  it('an admin starts a move on its date without a code; before the date it is refused', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const r = await create(s.c, s);
    const early = await s.c('post', `/move-requests/${r.body.data.id}/start`, {
      version: r.body.data.version,
    });
    expect(early.body.code).toBe('GATE_PASS_INVALID');
    await s.c('post', `/move-requests/${r.body.data.id}/cancel`, {
      reason: 'Moving to today',
      version: r.body.data.version,
    });
    const today = await create(s.c, s, { moveDate: '2026-11-01' });
    const ok = await s.c('post', `/move-requests/${today.body.data.id}/start`, {
      version: today.body.data.version,
    });
    expect(ok.body.data.status).toBe('IN_PROGRESS');
  });

  it('MOVE_IN of a tenant household activates the tenancy and sets the links residing', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const t = await activeTenancy(s);
    const r = await create(s.c, s, { householdOf: 'TENANT', moveDate: '2026-11-01' });
    const st = await s.c('post', `/move-requests/${r.body.data.id}/start`, { version: r.body.data.version });
    const done = await s.c('post', `/move-requests/${r.body.data.id}/complete`, {
      version: st.body.data.version,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const tn = (await Tenancy.findByPk(t.id))!;
    expect(tn).toMatchObject({ status: 'ACTIVE', moveInDate: '2026-11-01' });
    expect((await UnitResident.findAll({ where: { tenancyId: t.id } })).every(l => l.isResiding)).toBe(true);
  });

  it('MOVE_IN of the owner household sets the owner links residing; MOVE_OUT clears them and ends family links', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    await s.c(
      'post',
      '/residents',
      {
        name: 'Anita Shah',
        mobile: '9820000020',
        link: {
          unitId: s.unit.id,
          relation: 'FAMILY',
          familyRelation: 'SPOUSE',
          householdOf: 'OWNER',
          fromDate: '2026-11-01',
        },
      },
      { headers: idemKey() },
    );
    const out = await create(s.c, s, { type: 'MOVE_OUT', moveDate: '2026-11-01' });
    const st = await s.c('post', `/move-requests/${out.body.data.id}/start`, {
      version: out.body.data.version,
    });
    await s.c('post', `/move-requests/${out.body.data.id}/complete`, { version: st.body.data.version });
    const links = await UnitResident.findAll({ where: { unitId: s.unit.id } });
    const owner = links.find(l => l.relation === 'OWNER')!;
    const family = links.find(l => l.relation === 'FAMILY')!;
    expect(owner.toDate).toBeNull();
    expect(Boolean(owner.isResiding)).toBe(false);
    expect([family.toDate, family.endReason]).toEqual(['2026-11-01', 'MOVED_OUT']);
  });

  it('T09-25 MOVE_OUT of a tenant household ends the tenancy (MOVED_OUT), its links, and sets the inspection and refund date', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    await setSetting(s.society.id!, 'residents.moveDepositPaise', 500000);
    const t = await activeTenancy(s, {
      household: [{ name: 'Tina', familyRelation: 'CHILD', mobile: '9820000005' }],
    });
    await s.c('post', `/tenancies/${t.id}/activate`, { version: t.version, moveInDate: '2026-11-01' });
    const r = await create(s.c, s, { householdOf: 'TENANT', type: 'MOVE_OUT', moveDate: '2026-11-01' });
    expect(r.body.data.status, JSON.stringify(r.body)).toBe('APPROVED');
    const st = await s.c('post', `/move-requests/${r.body.data.id}/start`, { version: r.body.data.version });
    const done = await s.c('post', `/move-requests/${r.body.data.id}/complete`, {
      version: st.body.data.version,
    });
    expect(done.body.data).toMatchObject({
      status: 'COMPLETED',
      inspectionStatus: 'PENDING',
      depositRefundDueOn: '2026-11-08',
    });
    const tn = (await Tenancy.findByPk(t.id))!;
    expect(tn).toMatchObject({ status: 'ENDED', endReason: 'MOVED_OUT', endedOn: '2026-11-01' });
    const links = await UnitResident.findAll({ where: { tenancyId: t.id } });
    expect(links.every(l => l.toDate === '2026-11-01')).toBe(true);
    expect(links.find(l => l.relation === 'TENANT')!.endReason).toBe('MOVED_OUT');
  });
});

describe('inspection and refund (BR-09-48, T09-26)', () => {
  async function completedWithDeposit(s: S) {
    await ownerOf(s);
    await setSetting(s.society.id!, 'residents.moveDepositPaise', 500000);
    const r = await create(s.c, s, { moveDate: '2026-11-01' });
    const st = await s.c('post', `/move-requests/${r.body.data.id}/start`, { version: r.body.data.version });
    const done = await s.c('post', `/move-requests/${r.body.data.id}/complete`, {
      version: st.body.data.version,
    });
    return done.body.data;
  }

  it('records the inspection and requests the refund with the deduction; too high is DEDUCTION_TOO_HIGH', async () => {
    const s = await residentsSociety();
    const m = await completedWithDeposit(s);
    const path = `/move-requests/${m.id}/inspection`;
    const high = await s.c(
      'post',
      path,
      { result: 'DAMAGE_FOUND', damageDeductionPaise: 600000, note: 'Broken tiles', version: m.version },
      { headers: idemKey() },
    );
    expect([high.status, high.body.code]).toEqual([422, 'DEDUCTION_TOO_HIGH']);
    const passedWithCost = await s.c(
      'post',
      path,
      { result: 'PASSED', damageDeductionPaise: 100, note: 'All fine here', version: m.version },
      { headers: idemKey() },
    );
    expect(passedWithCost.status).toBe(400);
    const ok = await s.c(
      'post',
      path,
      { result: 'DAMAGE_FOUND', damageDeductionPaise: 120000, note: 'Broken tiles', version: m.version },
      { headers: idemKey() },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ inspectionStatus: 'DAMAGE_FOUND', damageDeductionPaise: 120000 });
    expect(calls('deposits.requestRefund')[0]!.input).toMatchObject({
      deductionPaise: 120000,
      reason: 'Broken tiles',
    });
    const twice = await s.c(
      'post',
      path,
      { result: 'PASSED', damageDeductionPaise: 0, note: 'All fine here', version: ok.body.data.version },
      { headers: idemKey() },
    );
    expect(twice.body.code).toBe('INVALID_STATE');
  });

  it('T09-26 the refund job on the due date requests one full refund; a rerun does nothing', async () => {
    const s = await residentsSociety();
    const m = await completedWithDeposit(s);
    expect(await runDepositRefunds(s.society.id!)).toBe(0);
    setNow('2026-11-08T04:30:00Z');
    expect(await runDepositRefunds(s.society.id!)).toBe(1);
    expect(await runDepositRefunds(s.society.id!)).toBe(0);
    expect(calls('deposits.requestRefund')).toHaveLength(1);
    const row = (await MoveRequest.findByPk(m.id))!;
    expect(row).toMatchObject({ inspectionStatus: 'PASSED', inspectionNote: 'No damage reported' });
    expect(row.depositRefundRequestedAt).not.toBeNull();
  });
});

describe('stale approved moves (sync-links step)', () => {
  it('an APPROVED move whose date passed unstarted is cancelled with a reason and its deposit refunded', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    await setSetting(s.society.id!, 'residents.moveDepositPaise', 500000);
    const r = await create(s.c, s);
    setNow('2026-11-05T04:30:00Z');
    await syncLinksFor(s.society.id!);
    const row = (await MoveRequest.findByPk(r.body.data.id))!;
    expect(row).toMatchObject({ status: 'CANCELLED', cancelReason: 'Not started on the booked date' });
    expect(calls('deposits.requestRefund')).toHaveLength(1);
  });

  it('APPROVED tenancies start on agreementStart when no move-in request is required', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const t = await activeTenancy(s, { start: '2026-11-03', end: '2027-09-30' });
    await setSetting(s.society.id!, 'residents.requireMoveInRequest', false);
    await syncLinksFor(s.society.id!);
    expect((await Tenancy.findByPk(t.id))!.status).toBe('APPROVED');
    setNow('2026-11-03T04:30:00Z');
    await syncLinksFor(s.society.id!);
    expect((await Tenancy.findByPk(t.id))!.status).toBe('ACTIVE');
  });
});

describe('changes requested (8.23)', () => {
  it('while module 14 asks for changes the requester edits and the request is resubmitted; otherwise INVALID_STATE', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    approvalStub.mode = 'manual';
    const r = await create(s.c, s);
    const id = r.body.data.id;
    const early = await s.c('patch', `/move-requests/${id}`, {
      version: r.body.data.version,
      slotStart: '11:00',
    });
    expect([early.status, early.body.code]).toEqual([409, 'INVALID_STATE']);
    const row = (await MoveRequest.findByPk(id))!;
    await sequelize.transaction(t => approvalStub.requestChanges(systemCtx('t'), row.approvalRequestId!, t));
    expect(await AuditLog.count({ where: { action: 'residents.move_request.changes_requested' } })).toBe(1);
    const bad = await s.c('patch', `/move-requests/${id}`, {
      version: r.body.data.version,
      slotStart: '19:00',
      slotEnd: '20:00',
    });
    expect(bad.body.code).toBe('MOVE_SLOT_NOT_ALLOWED');
    const ok = await s.c('patch', `/move-requests/${id}`, {
      version: r.body.data.version,
      slotStart: '11:00',
      helperCount: 4,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ slotStart: '11:00', helperCount: 4, status: 'PENDING_APPROVAL' });
    expect(calls('approvals.resubmit')).toHaveLength(1);
    expect(await AuditLog.count({ where: { action: 'residents.move_request.resubmitted' } })).toBe(1);
  });

  it('a cancel from the module 14 inbox cancels the move; reject refunds', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    approvalStub.mode = 'manual';
    const r = await create(s.c, s);
    const row = (await MoveRequest.findByPk(r.body.data.id))!;
    await sequelize.transaction(t => approvalStub.cancelFromInbox(systemCtx('t'), row.approvalRequestId!, t));
    expect((await MoveRequest.findByPk(row.id!))!.status).toBe('CANCELLED');
  });
});

describe('list filters and detail', () => {
  it('filters by type, status and date range; the range is limited to 92 days', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const r = await create(s.c, s);
    const list = await s.c('get', '/move-requests', undefined, {
      query: { type: 'MOVE_IN', status: 'APPROVED', dateFrom: MOVE_DATE, dateTo: MOVE_DATE },
    });
    expect(list.body.data.map((m: any) => m.id)).toEqual([r.body.data.id]);
    expect(
      (await s.c('get', '/move-requests', undefined, { query: { status: 'COMPLETED' } })).body.data,
    ).toEqual([]);
    const wide = await s.c('get', '/move-requests', undefined, {
      query: { dateFrom: '2026-01-01', dateTo: '2026-12-31' },
    });
    expect(wide.status).toBe(400);
    const one = await s.c('get', `/move-requests/${r.body.data.id}`);
    expect(one.body.data.documents).toEqual([]);
  });
});
