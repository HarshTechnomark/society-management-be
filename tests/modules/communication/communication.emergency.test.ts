import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuditLog,
  EmergencyBroadcast,
  EmergencyResponse,
  InboxItem,
  Society,
  closeDb,
} from '../../../src/models';
import { listInbox } from '../../../src/lib/inbox';
import { emergency } from '../../../src/modules/communication/communication.public';
import { systemCtx } from '../../../src/types/context';
import { invalidateSociety } from '../../../src/modules/access-control/access-control.public';
import { lifecycleColumns } from '../../helpers/access';
import { setupSociety } from '../../helpers/society-setup';
import { commWorld, idem, type CommWorld } from '../../helpers/communication';

const setStatus = async (id: number, status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED') => {
  await Society.update(lifecycleColumns(status) as never, { where: { id } });
  await invalidateSociety(id);
};

afterAll(async () => {
  await closeDb();
});

let w: CommWorld;
beforeAll(async () => {
  w = await commWorld('STARTER'); // emergency is never plan-gated: the cheapest plan proves it
}, 300_000);

const start = (c: any, body: Record<string, unknown>) =>
  c(
    'post',
    '/emergency-broadcasts',
    { message: 'Smoke seen on the 2nd floor, use the stairs', confirm: true, ...body },
    { headers: idem() },
  );

describe('start, permissions, validation (8.25)', () => {
  it('starts a fire alert on a Starter plan, notifies residents and staff, counts units and recipients', async () => {
    const r = await start(w.chair, { type: 'FIRE' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const d = r.body.data;
    expect(d).toMatchObject({
      type: 'FIRE',
      title: 'Fire',
      status: 'ACTIVE',
      isDrill: false,
      collectResponses: true,
      version: 1,
    });
    expect(d.unitCount).toBe(4); // four occupied flats
    expect(d.recipientCount).toBeGreaterThanOrEqual(5);
    const inbox = await listInbox();
    const forOwner = inbox.filter(m => m.to.includes(String(w.ownId)) || m.body.includes('Smoke'));
    expect(forOwner.length).toBeGreaterThan(0);
    expect(inbox.some(m => m.channel === 'SMS' && m.body.includes('ALERT: Fire'))).toBe(true);
    expect(
      await AuditLog.count({ where: { societyId: w.sid, action: 'communication.emergency.started' } }),
    ).toBe(1);
  }, 60_000);

  it('refuses a second active alert of the same type with the active id, allows a drill beside it', async () => {
    const dup = await start(w.chair, { type: 'FIRE' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('EMERGENCY_ALREADY_ACTIVE');
    expect(Number(dup.body.errors[0].message)).toBeGreaterThan(0);
    const drill = await start(w.chair, { type: 'FIRE', isDrill: true });
    expect(drill.status, JSON.stringify(drill.body)).toBe(201);
    const inbox = await listInbox();
    expect(inbox.some(m => m.channel === 'SMS' && m.body.includes('DRILL'))).toBe(false); // drills never use SMS
    expect(
      (await InboxItem.findAll({ where: { userId: w.ownId } })).some(i => i.title.startsWith('DRILL:')),
    ).toBe(true);
  }, 60_000);

  it('checks permission, strict body, confirm and the audience', async () => {
    expect((await start(w.acc, { type: 'GAS_LEAK' })).status).toBe(403);
    expect((await start(w.tre, { type: 'GAS_LEAK' })).status).toBe(403);
    expect((await start(w.own, { type: 'GAS_LEAK' })).status).toBe(403);
    const noConfirm = await start(w.chair, { type: 'GAS_LEAK', confirm: false });
    expect(noConfirm.status).toBe(400);
    expect((await start(w.chair, { type: 'GAS_LEAK', extra: 1 })).status).toBe(400);
    expect((await start(w.chair, { type: 'NOPE' })).status).toBe(400);
    expect((await start(w.chair, { type: 'GAS_LEAK', message: 'short' })).status).toBe(400);
    const bad = await start(w.chair, { type: 'GAS_LEAK', audience: { type: 'BUILDINGS', ids: [999999] } });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('EMERGENCY_AUDIENCE_INVALID');
    const noKey = await w.chair('post', '/emergency-broadcasts', {
      type: 'GAS_LEAK',
      message: 'Gas smell in the lobby',
      confirm: true,
    });
    expect(noKey.status).toBe(400);
  }, 60_000);

  it('targets one building: units and recipients cover Tower B only; idempotent replay returns the same alert', async () => {
    const key = idem();
    const body = {
      type: 'WATER',
      message: 'Water tank overflow in Tower B basement',
      confirm: true,
      audience: { type: 'BUILDINGS', ids: [w.b.id] },
    };
    const r1 = await w.sec('post', '/emergency-broadcasts', body, { headers: key });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.data.unitCount).toBe(1);
    const r2 = await w.sec('post', '/emergency-broadcasts', body, { headers: key });
    expect(r2.status).toBe(201);
    expect(r2.body.data.id).toBe(r1.body.data.id);
    expect(await EmergencyBroadcast.count({ where: { societyId: w.sid, type: 'WATER' } })).toBe(1);
  }, 60_000);

  it('society state: SUSPENDED blocks drills only, CLOSED blocks everything', async () => {
    await setStatus(w.sid, 'SUSPENDED');
    try {
      const drill = await start(w.chair, { type: 'POWER', isDrill: true });
      expect(drill.status).toBe(423);
      expect(drill.body.code).toBe('SOCIETY_SUSPENDED');
      const real = await start(w.chair, { type: 'POWER' });
      expect(real.status, JSON.stringify(real.body)).toBe(201);
      await setStatus(w.sid, 'CLOSED');
      const closed = await start(w.chair, { type: 'MEDICAL' });
      expect(closed.status).toBe(423);
      expect(closed.body.code).toBe('SOCIETY_CLOSED');
    } finally {
      await setStatus(w.sid, 'ACTIVE');
    }
  }, 60_000);
});

describe('responses, roll-call, updates, end states (8.26 to 8.30)', () => {
  let id: number;
  let version: number;
  const open = async (c: any, path: string, body: any) =>
    c('post', `/emergency-broadcasts/${id}/${path}`, body);

  beforeAll(async () => {
    const act = await EmergencyBroadcast.findOne({
      where: { societyId: w.sid, type: 'FIRE', isDrill: false },
    });
    id = act!.id;
    version = act!.version;
  });

  it('a resident answers for the flat, changes the answer (latest wins), counts follow', async () => {
    const r1 = await w.own(
      'post',
      `/emergency-broadcasts/${id}/responses`,
      { status: 'NEED_HELP', peopleCount: 3, note: 'Grandmother cannot walk' },
      { headers: idem() },
    );
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.data.counts).toEqual({ safe: 0, needHelp: 1 });
    const r2 = await w.own(
      'post',
      `/emergency-broadcasts/${id}/responses`,
      { status: 'SAFE', peopleCount: 3 },
      { headers: idem() },
    );
    expect(r2.body.data.counts).toEqual({ safe: 1, needHelp: 0 });
    const rows = await EmergencyResponse.findAll({ where: { broadcastId: id } });
    expect(rows).toHaveLength(2);
    expect(rows.filter(r => r.isLatest)).toHaveLength(1);
    // the family member of the same flat replaces the same subject
    const r3 = await w.fam(
      'post',
      `/emergency-broadcasts/${id}/responses`,
      { status: 'NEED_HELP', note: 'Need a stretcher' },
      { headers: idem() },
    );
    expect(r3.status).toBe(201);
    expect(r3.body.data.counts).toEqual({ safe: 0, needHelp: 1 });
    // Tower B resident, another flat
    const r4 = await w.ownB(
      'post',
      `/emergency-broadcasts/${id}/responses`,
      { status: 'SAFE' },
      { headers: idem() },
    );
    expect(r4.status).toBe(201);
    expect(r4.body.data.counts).toEqual({ safe: 1, needHelp: 1 });
    const bad = await w.own(
      'post',
      `/emergency-broadcasts/${id}/responses`,
      { status: 'MAYBE' },
      { headers: idem() },
    );
    expect(bad.status).toBe(400);
    const foreignUnit = await w.own(
      'post',
      `/emergency-broadcasts/${id}/responses`,
      { status: 'SAFE', unitId: w.b101 },
      { headers: idem() },
    );
    expect(foreignUnit.status).toBe(422);
    expect(foreignUnit.body.code).toBe('EMERGENCY_UNIT_REQUIRED');
  }, 60_000);

  it('detail and list: counts, need-help list, viewers by permission', async () => {
    const d = await w.chair('get', `/emergency-broadcasts/${id}`);
    expect(d.status).toBe(200);
    expect(d.body.data.counts).toMatchObject({
      units: 4,
      safe: 1,
      needHelp: 1,
      noResponse: 2,
      peopleSafe: 1,
    });
    expect(d.body.data.needHelp[0]).toMatchObject({
      unitLabel: 'A-101',
      note: 'Need a stretcher',
      attendedBy: null,
    });
    expect(d.body.data.startedByName).toBe('Chair');
    expect(d.body.data.updates).toEqual([]);
    const list = await w.chair('get', '/emergency-broadcasts?status=ACTIVE&isDrill=false');
    expect(list.body.data.length).toBeGreaterThan(0);
    expect(list.body.pagination.total).toBeGreaterThan(0);
    expect((await w.acc('get', '/emergency-broadcasts')).status).toBe(403);
    expect((await w.tre('get', '/emergency-broadcasts')).status).toBe(200); // security.incidents.view
    expect((await w.own('get', `/emergency-broadcasts/${id}`)).status).toBe(403);
    expect((await w.chair('get', '/emergency-broadcasts/99999999')).body.code).toBe('EMERGENCY_NOT_FOUND');
  }, 60_000);

  it('roll-call by flat with byFloor, masked mobiles for the guard, filter by status', async () => {
    const rc = await w.chair('get', `/emergency-broadcasts/${id}/roll-call`);
    expect(rc.status).toBe(200);
    expect(rc.body.data).toHaveLength(4);
    expect(Array.isArray(rc.body.byFloor)).toBe(true);
    expect(rc.body.pagination.total).toBe(4);
    const a101 = rc.body.data.find((x: any) => x.unitLabel === 'A-101');
    expect(a101).toMatchObject({ status: 'NEED_HELP', peopleCount: 1, channel: 'APP' });
    const gate = await w.guard('get', `/gate/emergency-broadcasts/${id}/roll-call?status=NO_RESPONSE`);
    expect(gate.status).toBe(200);
    expect(gate.body.data).toHaveLength(2);
    for (const item of gate.body.data)
      for (const ct of item.contacts) expect(ct.mobile).toMatch(/^\d{2}XXXXX\d{3}$/);
    expect((await w.own('get', `/gate/emergency-broadcasts/${id}/roll-call`)).status).toBe(403);
    expect((await w.guard('get', `/emergency-broadcasts/${id}/roll-call`)).status).toBe(403);
  }, 60_000);

  it('admin and guard record answers for a flat; a guard needs a note for NEED_HELP', async () => {
    const adm = await w.sec(
      'post',
      `/emergency-broadcasts/${id}/responses`,
      { status: 'SAFE', unitId: w.a102 },
      { headers: idem() },
    );
    expect(adm.status, JSON.stringify(adm.body)).toBe(201);
    expect(
      (await EmergencyResponse.findOne({ where: { broadcastId: id, unitId: w.a102, isLatest: true } }))!
        .channel,
    ).toBe('ADMIN');
    const noNote = await w.guard(
      'post',
      `/gate/emergency-broadcasts/${id}/responses`,
      { status: 'NEED_HELP', unitId: w.a201 },
      { headers: idem() },
    );
    expect(noNote.status).toBe(400);
    const noUnit = await w.guard(
      'post',
      `/gate/emergency-broadcasts/${id}/responses`,
      { status: 'SAFE' },
      { headers: idem() },
    );
    expect(noUnit.status).toBe(422);
    const ok = await w.guard(
      'post',
      `/gate/emergency-broadcasts/${id}/responses`,
      { status: 'NEED_HELP', unitId: w.a201, note: 'Elderly alone' },
      { headers: idem() },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(
      (await EmergencyResponse.findOne({ where: { broadcastId: id, unitId: w.a201, isLatest: true } }))!
        .channel,
    ).toBe('GATE');
  }, 60_000);

  it('mark help attended: once, only for a latest NEED_HELP; the responder is told', async () => {
    const row = (await EmergencyResponse.findOne({
      where: { broadcastId: id, unitId: w.a201, isLatest: true },
    }))!;
    const ok = await w.chair('post', `/emergency-broadcasts/${id}/responses/${row.id}/attend`, {
      note: 'Guard sent',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const again = await w.chair('post', `/emergency-broadcasts/${id}/responses/${row.id}/attend`, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_STATE');
    const safeRow = (await EmergencyResponse.findOne({
      where: { broadcastId: id, unitId: w.a102, isLatest: true },
    }))!;
    expect(
      (await w.chair('post', `/emergency-broadcasts/${id}/responses/${safeRow.id}/attend`, {})).status,
    ).toBe(409);
    expect((await w.own('post', `/emergency-broadcasts/${id}/responses/${row.id}/attend`, {})).status).toBe(
      403,
    );
    const d = await w.chair('get', `/emergency-broadcasts/${id}`);
    expect(d.body.data.needHelp.find((n: any) => n.unitLabel === 'A-201').attendedBy).toBe('Chair');
    version = d.body.data.version;
  }, 60_000);

  it('active alerts for me and for the gate', async () => {
    const mine = await w.own('get', '/me/emergency-broadcasts/active');
    expect(mine.status).toBe(200);
    const fire = mine.body.data.find((a: any) => a.id === id);
    expect(fire.myUnits).toEqual([{ unitId: w.a101, label: 'A-101', response: 'NEED_HELP' }]);
    const gate = await w.guard('get', '/gate/emergency-broadcasts/active');
    expect(gate.body.data.some((a: any) => a.id === id)).toBe(true);
    expect((await w.own('get', '/gate/emergency-broadcasts/active')).status).toBe(403);
    // the Tower B-only water alert is not shown to a Tower A resident
    const water = await EmergencyBroadcast.findOne({ where: { societyId: w.sid, type: 'WATER' } });
    expect(mine.body.data.some((a: any) => a.id === water!.id)).toBe(false);
    expect(
      (await w.ownB('get', '/me/emergency-broadcasts/active')).body.data.some((a: any) => a.id === water!.id),
    ).toBe(true);
    expect((await emergency.getActive(w.sid)).length).toBeGreaterThan(2);
  }, 60_000);

  it('update: version lock, audit keeps the text for the history, recipients notified', async () => {
    const stale = await open(w.chair, 'updates', {
      version: version + 5,
      message: 'Fire brigade has arrived',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    expect((await open(w.chair, 'updates', { version, message: 'short' })).status).toBe(400);
    const ok = await open(w.chair, 'updates', { version, message: 'Fire brigade has arrived' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.updates[0]).toMatchObject({ message: 'Fire brigade has arrived', byName: 'Chair' });
    expect(ok.body.data.lastUpdateMessage).toBe('Fire brigade has arrived');
    version = ok.body.data.version;
    expect((await open(w.own, 'updates', { version, message: 'I am not allowed' })).status).toBe(403);
  }, 60_000);

  it('re-alert: only once every 3 minutes, goes to flats with no answer', async () => {
    const r1 = await open(w.chair, 'realert', { version });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    version = r1.body.data.version;
    const r2 = await open(w.chair, 'realert', { version });
    expect(r2.status).toBe(422);
    expect(r2.body.code).toBe('EMERGENCY_REALERT_TOO_SOON');
    await EmergencyBroadcast.update({ lastRealertAt: new Date('2026-11-01T04:26:00Z') }, { where: { id } });
    const r3 = await open(w.chair, 'realert', { version });
    expect(r3.status, JSON.stringify(r3.body)).toBe(200);
    version = r3.body.data.version;
    expect(r3.body.data.realertCount).toBe(2);
  }, 90_000);

  it('cancel after 15 minutes is refused; resolve ends it; every action then returns EMERGENCY_NOT_ACTIVE', async () => {
    await EmergencyBroadcast.update({ startedAt: new Date('2026-11-01T04:10:00Z') }, { where: { id } }); // 20 minutes before 'now'
    const late = await open(w.chair, 'cancel', { version, reason: 'It was a false alarm really' });
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('EMERGENCY_CANCEL_WINDOW_PASSED');
    const res = await open(w.chair, 'resolve', {
      version,
      allClearMessage: 'Fire is out. All clear to return.',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'RESOLVED',
      allClearMessage: 'Fire is out. All clear to return.',
    });
    const after = await w.own(
      'post',
      `/emergency-broadcasts/${id}/responses`,
      { status: 'SAFE' },
      { headers: idem() },
    );
    expect(after.status).toBe(409);
    expect(after.body.code).toBe('EMERGENCY_NOT_ACTIVE');
    expect(
      (await open(w.chair, 'updates', { version: res.body.data.version, message: 'Anything more to say' }))
        .body.code,
    ).toBe('EMERGENCY_NOT_ACTIVE');
    expect((await open(w.chair, 'cancel', { version: 1, reason: 'Too late to cancel now' })).body.code).toBe(
      'EMERGENCY_NOT_ACTIVE',
    );
    expect(
      (await w.own('get', '/me/emergency-broadcasts/active')).body.data.some((a: any) => a.id === id),
    ).toBe(false);
  }, 90_000);

  it('cancel within 15 minutes marks a false alarm; the same type can start again', async () => {
    const s = await start(w.sec, { type: 'LIFT_STUCK', message: 'Lift stuck between floors in Tower A' });
    expect(s.status).toBe(201);
    const c = await w.sec('post', `/emergency-broadcasts/${s.body.data.id}/cancel`, {
      version: 1,
      reason: 'Lift was only slow',
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.data.status).toBe('CANCELLED');
    expect(c.body.data.cancelReason).toBe('Lift was only slow');
    const again = await start(w.sec, { type: 'LIFT_STUCK', message: 'Lift stuck again in Tower A' });
    expect(again.status).toBe(201);
  }, 60_000);

  it('responses can be switched off per alert; a non-recipient gets 404; another society cannot read the alert', async () => {
    const s = await start(w.sec, {
      type: 'SECURITY_THREAT',
      collectResponses: false,
      message: 'Suspicious person near the gate',
    });
    expect(s.status).toBe(201);
    const r = await w.own(
      'post',
      `/emergency-broadcasts/${s.body.data.id}/responses`,
      { status: 'SAFE' },
      { headers: idem() },
    );
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('EMERGENCY_RESPONSES_DISABLED');
    const miss = await w.own(
      'post',
      `/emergency-broadcasts/99999999/responses`,
      { status: 'SAFE' },
      { headers: idem() },
    );
    expect(miss.status).toBe(404);
    expect(miss.body.code).toBe('EMERGENCY_NOT_FOUND');
    // tenant isolation: the chairman of another society sees 404 for this alert and cannot answer it
    const other = await setupSociety({ plan: 'STARTER', name: 'Other Chair' });
    const foreign = await other.c('get', `/emergency-broadcasts/${s.body.data.id}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('EMERGENCY_NOT_FOUND');
    expect(
      (
        await other.c('post', `/emergency-broadcasts/${s.body.data.id}/updates`, {
          version: 1,
          message: 'Hijack attempt',
        })
      ).status,
    ).toBe(404);
    expect((await other.c('get', '/emergency-broadcasts')).body.data).toEqual([]);
  }, 60_000);

  it('startFromSos is idempotent on the SOS id and reuses an active alert of the same type', async () => {
    const ctx = {
      ...systemCtx('sos'),
      user: {
        id: w.chairId,
        name: 'Chair',
        mobile: null,
        email: null,
        platformRoleId: null,
        status: 'ACTIVE',
      },
      society: {
        id: w.sid,
        name: 'Comm CHS',
        status: 'ACTIVE',
        timezone: 'Asia/Kolkata',
        planKey: 'STARTER',
      },
      permissions: new Set<string>(),
      unitIds: [],
    };
    const first = await emergency.startFromSos(ctx, {
      sosAlertId: 777,
      type: 'MEDICAL',
      message: 'Resident in A-101 pressed SOS',
    });
    expect(first.created).toBe(true);
    const again = await emergency.startFromSos(ctx, {
      sosAlertId: 777,
      type: 'MEDICAL',
      message: 'Resident in A-101 pressed SOS',
    });
    expect(again).toEqual({ broadcastId: first.broadcastId, created: false });
    const other = await emergency.startFromSos(ctx, {
      sosAlertId: 778,
      type: 'MEDICAL',
      message: 'Second SOS in the same minute',
    });
    expect(other).toEqual({ broadcastId: first.broadcastId, created: false });
    expect((await EmergencyBroadcast.findByPk(first.broadcastId))!.sosAlertId).toBe(777);
  }, 60_000);
});
