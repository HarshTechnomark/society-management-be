import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, RenovationPermit, closeDb } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { systemCtx } from '../../../src/types/context';
import { sequelize } from '../../../src/models';
import {
  approvalStore,
  part3PortCalls,
  placeholderState,
} from '../../../src/modules/residents/residents.part3.ports';
import {
  onRenovationDepositPaid,
  runRenovationDaily,
  listForGate,
  passValidAt,
} from '../../../src/modules/residents/residents.renovations.service';
import { approvePart3Request, rejectPart3Request } from '../../../src/modules/residents/residents.public';
import { makeUnit } from '../../helpers/society-setup';
import {
  addPerson,
  admin,
  fileFor,
  key,
  p3Society,
  resetPart3,
  setSetting,
} from '../../helpers/residents-part3';
import { as, login, memberUser } from '../../helpers/access';
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetPart3);

// the frozen clock is Sunday 2026-11-01 10:00 IST; tomorrow is Monday 2026-11-02
const body = (societyId: number, userId: number, unitId: number, o: Record<string, unknown> = {}) => ({
  unitId,
  workCategory: 'KITCHEN',
  workDescription: 'Modular kitchen replacement',
  contractorName: 'Ramesh Kumar',
  contractorMobile: '9876500011',
  workerCount: 4,
  startDate: '2026-11-02',
  endDate: '2026-11-20',
  dailyStartTime: '10:00',
  dailyEndTime: '18:00',
  fileIds: [{ fileId: fileFor(societyId, userId), docType: 'CONTRACTOR_ID' }],
  ...o,
});

async function setup() {
  const s = await p3Society();
  const unit = await makeUnit(s.c, s.building.id, '101', 1);
  const owner = await addPerson(s.society, unit.id, { name: 'Sandeep Rao', login: true });
  const adm = await admin(s.society);
  return { ...s, unit, owner, adm };
}
const calls = (fn: string) => part3PortCalls.filter(c => c.fn === fn);

describe('renovation permit create (BR-09-50 to 54)', () => {
  it('an owner applies; no deposit goes straight to approval (T09-21 style)', async () => {
    const { society, unit, owner } = await setup();
    const r = await owner.c!('post', '/me/renovation-permits', body(society.id!, owner.userId!, unit.id), {
      headers: key(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'PENDING_APPROVAL',
      unitLabel: 'A-101',
      dailyStartTime: '10:00',
      depositPaise: 0,
      depositPayment: null,
      version: 1,
    });
    expect(calls('approvals.request')).toHaveLength(1);
    const row = (await RenovationPermit.findByPk(r.body.data.id))!;
    expect(row.requestedByResidentId).toBe(owner.residentId);
    expect(row.approvalRequestId).not.toBeNull();
    expect(await AuditLog.count({ where: { action: 'residents.renovation_permit.created' } })).toBe(1);
  });

  it('T09-27 a tenant cannot apply; a neighbour flat is 404', async () => {
    const { society, unit, building, c } = await setup();
    const other = await makeUnit(c, building.id, '102', 1);
    const tenant = await addPerson(society, unit.id, {
      name: 'Faisal Khan',
      relation: 'FAMILY',
      login: true,
    });
    const r = await tenant.c!('post', '/me/renovation-permits', body(society.id!, tenant.userId!, unit.id), {
      headers: key(),
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('OWNER_ACTION_ONLY');
    const n = await tenant.c!('post', '/me/renovation-permits', body(society.id!, tenant.userId!, other.id), {
      headers: key(),
    });
    expect(n.status).toBe(404);
    expect(n.body.code).toBe('UNIT_NOT_FOUND');
  });

  it('T09-28 hours outside the window are refused', async () => {
    const { society, unit, adm } = await setup();
    const r = await adm(
      'post',
      '/renovation-permits',
      body(society.id!, adm.userId, unit.id, { dailyStartTime: '08:00', dailyEndTime: '20:00' }),
      { headers: key() },
    );
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('PERMIT_HOURS_NOT_ALLOWED');
    const inv = await adm(
      'post',
      '/renovation-permits',
      body(society.id!, adm.userId, unit.id, { dailyStartTime: '15:00', dailyEndTime: '12:00' }),
      { headers: key() },
    );
    expect(inv.body.code).toBe('PERMIT_HOURS_NOT_ALLOWED');
  });

  it('dates: a resident starts from tomorrow, an admin from today, at most 60 days ahead and 90 days long', async () => {
    const { society, unit, owner, adm } = await setup();
    const post = (c: ReturnType<typeof as>, o: Record<string, unknown>) =>
      c(
        'post',
        c === adm ? '/renovation-permits' : '/me/renovation-permits',
        body(society.id!, c === adm ? adm.userId : owner.userId!, unit.id, o),
        { headers: key() },
      );
    expect((await post(owner.c!, { startDate: '2026-11-01', endDate: '2026-11-05' })).body.code).toBe(
      'PERMIT_DATES_INVALID',
    );
    expect((await post(adm, { startDate: '2027-01-05', endDate: '2027-01-10' })).body.code).toBe(
      'PERMIT_DATES_INVALID',
    );
    expect((await post(adm, { startDate: '2026-11-05', endDate: '2026-11-01' })).body.code).toBe(
      'PERMIT_DATES_INVALID',
    );
    expect((await post(adm, { startDate: '2026-11-02', endDate: '2027-02-10' })).body.code).toBe(
      'PERMIT_DATES_INVALID',
    );
    const okAdmin = await post(adm, { startDate: '2026-11-01', endDate: '2027-01-29' });
    expect(okAdmin.status, JSON.stringify(okAdmin.body)).toBe(201);
    expect((await RenovationPermit.findByPk(okAdmin.body.data.id))!.requestedByResidentId).toBeNull();
  });

  it('BR-09-52 and 53 documents: contractor ID always, structural certificate for structural work', async () => {
    const { society, unit, adm } = await setup();
    const none = await adm(
      'post',
      '/renovation-permits',
      body(society.id!, adm.userId, unit.id, {
        fileIds: [{ fileId: fileFor(society.id!, adm.userId), docType: 'WORK_PLAN' }],
      }),
      { headers: key() },
    );
    expect(none.status).toBe(422);
    expect(none.body.code).toBe('DOCUMENTS_REQUIRED');
    const st = await adm(
      'post',
      '/renovation-permits',
      body(society.id!, adm.userId, unit.id, { involvesStructuralChange: true }),
      { headers: key() },
    );
    expect(st.body.code).toBe('DOCUMENTS_REQUIRED');
    expect(st.body.errors[0].missing).toEqual(['STRUCTURAL_CERTIFICATE']);
  });

  it('BR-09-52 one open permit per unit', async () => {
    const { society, unit, adm } = await setup();
    const b = () => body(society.id!, adm.userId, unit.id);
    expect((await adm('post', '/renovation-permits', b(), { headers: key() })).status).toBe(201);
    const again = await adm('post', '/renovation-permits', b(), { headers: key() });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('PERMIT_EXISTS');
  });

  it('BR-09-54 a deposit goes through module 13 first; paid moves it to approval', async () => {
    const { society, unit, adm } = await setup();
    await setSetting(society.id!, 'residents.renovationDepositPaise', 1_000_000);
    await setSetting(society.id!, 'residents.renovationFeePaise', 200_000);
    const r = await adm('post', '/renovation-permits', body(society.id!, adm.userId, unit.id), {
      headers: key(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'PENDING_DEPOSIT',
      depositPaise: 1_000_000,
      feePaise: 200_000,
    });
    expect(r.body.data.depositPayment.depositId).toBeGreaterThan(0);
    expect(calls('approvals.request')).toHaveLength(0);
    const id = r.body.data.id;
    await sequelize.transaction(t =>
      onRenovationDepositPaid(
        { ...systemCtx('t'), society: { id: society.id! } as never },
        society.id!,
        { refId: id, depositId: r.body.data.depositPayment.depositId },
        t,
      ),
    );
    const row = (await RenovationPermit.findByPk(id))!;
    expect(row.status).toBe('PENDING_APPROVAL');
    expect(row.depositPaidAt).not.toBeNull();
    expect(calls('approvals.request')).toHaveLength(1);
    // approved through the placeholder inbox: the fee invoice is raised (RENOVATION_FEE, due on startDate)
    const aid = (await RenovationPermit.findByPk(id))!.approvalRequestId!;
    await approvePart3Request(aid, { ...systemCtx('inbox'), society: { id: society.id! } as never });
    const done = (await RenovationPermit.findByPk(id))!;
    expect(done.status).toBe('APPROVED');
    expect(done.feeInvoiceId).not.toBeNull();
    expect(calls('invoices.createAdHoc')[0]!.input).toMatchObject({
      chargeHeadKey: 'RENOVATION_FEE',
      amountPaise: 200_000,
      dueDate: '2026-11-02',
    });
  });
});

const sys = (societyId: number) => ({ ...systemCtx('inbox'), society: { id: societyId } as never });

describe('module 14 placeholder approve and reject', () => {
  it('approve runs onApproved once; a second call changes nothing', async () => {
    const { society, unit, adm } = await setup();
    const r = await adm('post', '/renovation-permits', body(society.id!, adm.userId, unit.id), {
      headers: key(),
    });
    const aid = (await RenovationPermit.findByPk(r.body.data.id))!.approvalRequestId!;
    expect(approvalStore.get(aid)!.status).toBe('PENDING');
    expect(await approvePart3Request(aid, sys(society.id!))).toMatchObject({ status: 'APPROVED' });
    expect((await RenovationPermit.findByPk(r.body.data.id))!.status).toBe('APPROVED');
    await approvePart3Request(aid, sys(society.id!));
    expect(await AuditLog.count({ where: { action: 'residents.renovation_permit.approved' } })).toBe(1);
  });

  it('reject sets REJECTED with the reason and refunds a paid deposit in full', async () => {
    const { society, unit, adm } = await setup();
    await setSetting(society.id!, 'residents.renovationDepositPaise', 500_000);
    const r = await adm('post', '/renovation-permits', body(society.id!, adm.userId, unit.id), {
      headers: key(),
    });
    const id = r.body.data.id;
    await sequelize.transaction(t =>
      onRenovationDepositPaid(
        { ...systemCtx('t'), society: { id: society.id! } as never },
        society.id!,
        { refId: id, depositId: r.body.data.depositPayment.depositId },
        t,
      ),
    );
    const aid = (await RenovationPermit.findByPk(id))!.approvalRequestId!;
    await rejectPart3Request(aid, 'Structural plan missing', sys(society.id!));
    const row = (await RenovationPermit.findByPk(id))!;
    expect(row.status).toBe('REJECTED');
    expect(row.decisionReason).toBe('Structural plan missing');
    expect(calls('deposits.requestRefund')[0]!.input).toMatchObject({ deductionPaise: 0 });
    expect(row.depositRefundRequestedAt).not.toBeNull();
    // a rejected permit frees the unit for a new one
    const again = await adm('post', '/renovation-permits', body(society.id!, adm.userId, unit.id), {
      headers: key(),
    });
    expect(again.status).toBe(201);
  });
});

async function approved(o: Record<string, unknown> = {}) {
  const ctx = await setup();
  const r = await ctx.adm(
    'post',
    '/renovation-permits',
    body(ctx.society.id!, ctx.adm.userId, ctx.unit.id, { startDate: '2026-11-01', ...o }),
    { headers: key() },
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.data.id as number;
  await approvePart3Request((await RenovationPermit.findByPk(id))!.approvalRequestId!, sys(ctx.society.id!));
  const ver = async () => (await RenovationPermit.findByPk(id))!.version;
  return { ...ctx, id, ver };
}

describe('start, violations, extension, inspection', () => {
  it('start needs today >= startDate; the daily job starts approved permits on their date', async () => {
    const { adm, id, ver, society } = await approved({ startDate: '2026-11-02' });
    const early = await adm('post', `/renovation-permits/${id}/start`, { version: await ver() });
    expect(early.status).toBe(422);
    expect(early.body.code).toBe('PERMIT_DATES_INVALID');
    expect(await runRenovationDaily(society.id!)).toEqual({ started: 0, inspection: 0 });
    setNow('2026-11-02T04:30:00Z');
    expect(await runRenovationDaily(society.id!)).toEqual({ started: 1, inspection: 0 });
    expect(await runRenovationDaily(society.id!)).toEqual({ started: 0, inspection: 0 });
    expect((await RenovationPermit.findByPk(id))!.status).toBe('IN_PROGRESS');
  });

  it('an admin starts it on the start date; a stale version is 409', async () => {
    const { adm, id, ver } = await approved();
    const stale = await adm('post', `/renovation-permits/${id}/start`, { version: 99 });
    expect(stale.body.code).toBe('STALE_VERSION');
    const ok = await adm('post', `/renovation-permits/${id}/start`, { version: await ver() });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('IN_PROGRESS');
    const twice = await adm('post', `/renovation-permits/${id}/start`, { version: await ver() });
    expect(twice.body.code).toBe('INVALID_STATE');
  });

  it('T09-29 violation with stop-work and a fine; resume goes back to in progress', async () => {
    const { adm, id, ver } = await approved();
    await adm('post', `/renovation-permits/${id}/start`, { version: await ver() });
    const v = await adm(
      'post',
      `/renovation-permits/${id}/violations`,
      {
        category: 'NOISE',
        note: 'Drilling at night',
        stopWork: true,
        finePaise: 500_000,
        version: await ver(),
      },
      { headers: key() },
    );
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.data).toMatchObject({ status: 'SUSPENDED', violationCount: 1 });
    expect(calls('ruleViolations.create')[0]!.input).toMatchObject({
      ruleKey: 'RENOVATION',
      finePaise: 500_000,
      refType: 'renovation_permit',
    });
    expect(
      await AuditLog.count({ where: { action: 'residents.renovation_permit.violation_recorded' } }),
    ).toBe(1);
    const gate = await listForGate((await RenovationPermit.findByPk(id))!.societyId, '2026-11-02');
    expect(gate[0]).toMatchObject({ status: 'SUSPENDED', contractorMobile: '98XXXXX011' });
    const res = await adm('post', `/renovation-permits/${id}/resume`, { version: await ver() });
    expect(res.body.data.status).toBe('IN_PROGRESS');
    const soft = await adm(
      'post',
      `/renovation-permits/${id}/violations`,
      { category: 'DEBRIS', note: 'Debris in stairs', version: await ver() },
      { headers: key() },
    );
    expect(soft.body.data).toMatchObject({ status: 'IN_PROGRESS', violationCount: 2 });
    expect(calls('ruleViolations.create')).toHaveLength(1);
  });

  it('suspend needs a reason; resume after the end date is PERMIT_EXPIRED', async () => {
    const { adm, id, ver, society } = await approved({ endDate: '2026-11-04' });
    await adm('post', `/renovation-permits/${id}/start`, { version: await ver() });
    expect(
      (await adm('post', `/renovation-permits/${id}/suspend`, { reason: 'x', version: await ver() })).status,
    ).toBe(400);
    expect(
      (
        await adm('post', `/renovation-permits/${id}/suspend`, {
          reason: 'Safety check pending',
          version: await ver(),
        })
      ).body.data.status,
    ).toBe('SUSPENDED');
    setNow('2026-11-06T04:30:00Z');
    const adm2 = await admin(society); // a new sign-in: the old session idled out with the clock
    const r = await adm2('post', `/renovation-permits/${id}/resume`, { version: await ver() });
    expect(r.body.code).toBe('PERMIT_EXPIRED');
  });

  it('T09-30 extension: later date, total within the maximum, at most 3', async () => {
    const { adm, id, ver } = await approved({ endDate: '2026-11-10' });
    const ext = async (endDate: string) =>
      adm('post', `/renovation-permits/${id}/extend`, {
        endDate,
        reason: 'Delay in tiles',
        version: await ver(),
      });
    expect((await ext('2026-11-09')).body.code).toBe('PERMIT_DATES_INVALID');
    expect((await ext('2027-03-01')).body.code).toBe('PERMIT_DATES_INVALID');
    for (const d of ['2026-11-12', '2026-11-14', '2026-11-16']) expect((await ext(d)).status).toBe(200);
    const row = (await RenovationPermit.findByPk(id))!;
    expect(row.extensionCount).toBe(3);
    expect(row.originalEndDate).toBe('2026-11-10');
    const fourth = await ext('2026-11-18');
    expect(fourth.status).toBe(422);
    expect(fourth.body.code).toBe('EXTENSION_LIMIT_REACHED');
  });

  it('work done by the owner, then inspection FAILED needs a live permit and PASSED completes with a refund', async () => {
    const { society, adm, owner, id, ver } = await approved({ endDate: '2026-11-05' });
    await setSetting(society.id!, 'residents.renovationDepositPaise', 0);
    await adm('post', `/renovation-permits/${id}/start`, { version: await ver() });
    const wd = await owner.c!('post', `/me/renovation-permits/${id}/work-done`, { version: await ver() });
    expect(wd.status, JSON.stringify(wd.body)).toBe(200);
    expect(wd.body.data.status).toBe('INSPECTION_PENDING');
    const fail = await adm(
      'post',
      `/renovation-permits/${id}/inspect`,
      { result: 'FAILED', note: 'Cracks in wall', version: await ver() },
      { headers: key() },
    );
    expect(fail.body.data.status).toBe('IN_PROGRESS');
    await owner.c!('post', `/me/renovation-permits/${id}/work-done`, { version: await ver() });
    setNow('2026-11-09T04:30:00Z');
    const adm2 = await admin(society);
    const expired = await adm2(
      'post',
      `/renovation-permits/${id}/inspect`,
      { result: 'FAILED', note: 'Still cracked', version: await ver() },
      { headers: key() },
    );
    expect(expired.body.code).toBe('PERMIT_EXPIRED');
    const pass = await adm2(
      'post',
      `/renovation-permits/${id}/inspect`,
      { result: 'PASSED', note: 'All good', version: await ver() },
      { headers: key() },
    );
    expect(pass.body.data.status).toBe('COMPLETED');
    expect(await AuditLog.count({ where: { action: 'residents.renovation_permit.completed' } })).toBe(1);
  });

  it('PASSED with a deposit requests the refund with the deduction; the deduction cannot exceed the deposit', async () => {
    const ctx = await setup();
    await setSetting(ctx.society.id!, 'residents.renovationDepositPaise', 1_000_000);
    const r = await ctx.adm(
      'post',
      '/renovation-permits',
      body(ctx.society.id!, ctx.adm.userId, ctx.unit.id, { startDate: '2026-11-01' }),
      { headers: key() },
    );
    const id = r.body.data.id;
    await sequelize.transaction(t =>
      onRenovationDepositPaid(
        { ...systemCtx('t'), society: { id: ctx.society.id! } as never },
        ctx.society.id!,
        { refId: id, depositId: r.body.data.depositPayment.depositId },
        t,
      ),
    );
    await approvePart3Request(
      (await RenovationPermit.findByPk(id))!.approvalRequestId!,
      sys(ctx.society.id!),
    );
    const ver = async () => (await RenovationPermit.findByPk(id))!.version;
    await ctx.adm('post', `/renovation-permits/${id}/start`, { version: await ver() });
    await ctx.adm('post', `/renovation-permits/${id}/work-done`, { version: await ver() });
    const high = await ctx.adm(
      'post',
      `/renovation-permits/${id}/inspect`,
      { result: 'PASSED', note: 'Damage to lift', damageDeductionPaise: 2_000_000, version: await ver() },
      { headers: key() },
    );
    expect(high.body.code).toBe('DEDUCTION_TOO_HIGH');
    const ok = await ctx.adm(
      'post',
      `/renovation-permits/${id}/inspect`,
      { result: 'PASSED', note: 'Damage to lift', damageDeductionPaise: 300_000, version: await ver() },
      { headers: key() },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(calls('deposits.requestRefund')).toHaveLength(1);
    expect(calls('deposits.requestRefund')[0]!.input).toMatchObject({ deductionPaise: 300_000 });
    expect((await RenovationPermit.findByPk(id))!.depositRefundRequestedAt).not.toBeNull();
  });

  it('the daily job sends IN_PROGRESS and SUSPENDED permits past their end date to inspection', async () => {
    const { adm, id, ver, society } = await approved({ endDate: '2026-11-03' });
    await adm('post', `/renovation-permits/${id}/start`, { version: await ver() });
    setNow('2026-11-03T04:30:00Z');
    expect((await runRenovationDaily(society.id!)).inspection).toBe(0);
    setNow('2026-11-04T04:30:00Z');
    expect(await runRenovationDaily(society.id!)).toEqual({ started: 0, inspection: 1 });
    expect((await RenovationPermit.findByPk(id))!.status).toBe('INSPECTION_PENDING');
  });
});

describe('cancel, patch, gate', () => {
  it('cancel in PENDING_APPROVAL asks module 14 to cancel; later states are INVALID_STATE; the owner may cancel from the app', async () => {
    const { adm, owner, society, unit } = await setup();
    const r = await owner.c!('post', '/me/renovation-permits', body(society.id!, owner.userId!, unit.id), {
      headers: key(),
    });
    const id = r.body.data.id;
    const c = await owner.c!('post', `/me/renovation-permits/${id}/cancel`, {
      reason: 'Plans changed',
      version: 1,
    });
    expect(c.body.data.status).toBe('CANCELLED');
    expect(calls('approvals.cancel')).toHaveLength(1);
    const again = await adm('post', `/renovation-permits/${id}/cancel`, {
      reason: 'Plans changed',
      version: 2,
    });
    expect(again.body.code).toBe('INVALID_STATE');
  });

  it('patch edits conditions before the start only; closed permits cannot change', async () => {
    const { adm, id, ver } = await approved();
    const p = await adm('patch', `/renovation-permits/${id}`, {
      conditions: 'No work after 5 pm',
      workerCount: 6,
      version: await ver(),
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data.workerCount).toBe(6);
    await adm('post', `/renovation-permits/${id}/cancel`, { reason: 'Plans changed', version: await ver() });
    const closed = await adm('patch', `/renovation-permits/${id}`, { workerCount: 3, version: await ver() });
    expect(closed.body.code).toBe('INVALID_STATE');
  });

  it('BR-09-59 the gate list leaves out blackout days and holidays; passValidAt checks the daily hours', async () => {
    const { adm, id, ver, society } = await approved({ endDate: '2026-11-10' });
    await adm('post', `/renovation-permits/${id}/start`, { version: await ver() });
    expect(await listForGate(society.id!, '2026-11-03')).toHaveLength(1);
    expect(await listForGate(society.id!, '2026-11-08')).toHaveLength(0); // Sunday
    expect(await listForGate(society.id!, '2026-11-11')).toHaveLength(0); // after endDate
    expect(await passValidAt(society.id!, id, '2026-11-03', '11:00')).toBe(true);
    expect(await passValidAt(society.id!, id, '2026-11-03', '19:00')).toBe(false);
    expect(await passValidAt(society.id!, id, '2026-11-08', '11:00')).toBe(false);
    const res = await adm('get', '/gate/renovation-permits', undefined, { query: { date: '2026-11-03' } });
    expect(res.status).toBe(403); // a secretary has no gate permission: the route is gated by gate.visitors.view
  });

  it('list filters, the detail adds documents, and another society cannot read the permit', async () => {
    const { adm, id, society } = await approved();
    const list = await adm('get', '/renovation-permits', undefined, {
      query: { status: 'APPROVED', activeOn: '2026-11-05' },
    });
    expect(list.body.data).toHaveLength(1);
    expect(list.body.pagination.total).toBe(1);
    const d = await adm('get', `/renovation-permits/${id}`);
    expect(d.body.data.documents).toHaveLength(1);
    expect(d.body.data.approvalRequestId).not.toBeNull();
    const other = await p3Society();
    const o = await as(await login(await memberUser(other.society, 'secretary')))(
      'get',
      `/renovation-permits/${id}`,
    );
    expect(o.status).toBe(404);
    expect(o.body.code).toBe('PERMIT_NOT_FOUND');
    void society;
    void flushAcl;
  });

  it('changes requested: the owner edits and resubmits; outside CHANGES_REQUESTED it is INVALID_STATE', async () => {
    const { owner, society, unit } = await setup();
    const r = await owner.c!('post', '/me/renovation-permits', body(society.id!, owner.userId!, unit.id), {
      headers: key(),
    });
    const id = r.body.data.id;
    const { unitId, fileIds, ...fields } = body(society.id!, owner.userId!, unit.id, { workerCount: 8 });
    void unitId;
    void fileIds;
    const no = await owner.c!('patch', `/me/renovation-permits/${id}`, { ...fields, version: 1 });
    expect(no.body.code).toBe('INVALID_STATE');
    placeholderState.publicStatus = 'CHANGES_REQUESTED';
    const yes = await owner.c!('patch', `/me/renovation-permits/${id}`, { ...fields, version: 1 });
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
    expect(yes.body.data.workerCount).toBe(8);
    expect(calls('approvals.resubmit')).toHaveLength(1);
    expect(await AuditLog.count({ where: { action: 'residents.renovation_permit.resubmitted' } })).toBe(1);
  });
});
