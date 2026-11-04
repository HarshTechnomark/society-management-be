import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditLog,
  CommitteeTerm,
  SocietyMember,
  UnitResident,
  closeDb,
  sequelize,
} from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { advance } from '../../../src/lib/clock';
import { setRealtimeSink } from '../../../src/lib/realtime';
import { changeRole } from '../../../src/modules/access-control/access-control.members.service';
import { committeePortCalls, setCommitteePorts } from '../../../src/modules/committee/committee.ports';
import { newSeat } from '../../../src/modules/committee/committee.seats';
import { setAbsoluteUsage } from '../../../src/modules/subscriptions/entitlements.service';
import { systemCtx } from '../../../src/types/context';
import { AppError } from '../../../src/utils/errors';
import { featureOff, memberOf } from '../../helpers/society-setup';
import {
  activateBody,
  adminClient,
  committeeWorld,
  handoverWorld,
  holder,
  idem,
  memberIdOf,
  postTerm,
  previewOf,
  resetCommittee,
  roleOf,
  seat,
  setLimit,
  setMemberStatus,
  setRole,
  setSetting,
  suspend,
  termBody,
} from '../../helpers/committee';

// module 03 calls of module 10 are recorded; `failOn` makes the n-th call fail (T10-11)
const spy = vi.hoisted(() => ({
  calls: [] as { fn: string; memberId: number; roleKey?: string }[],
  failOn: 0,
}));
vi.mock('../../../src/modules/access-control/access-control.public', async importOriginal => {
  const real =
    await importOriginal<typeof import('../../../src/modules/access-control/access-control.public')>();
  const { AppError: Boom } =
    await vi.importActual<typeof import('../../../src/utils/errors')>('../../../src/utils/errors');
  const note = (fn: string, memberId: number, roleKey?: string) => {
    spy.calls.push({ fn, memberId, roleKey });
    if (spy.failOn && spy.calls.length === spy.failOn) throw new Boom(409, 'MODULE_03_FAILED', 'forced');
  };
  return {
    ...real,
    changeRole: ((ctx, memberId, roleKey, ...rest) => {
      note('changeRole', memberId, roleKey);
      return real.changeRole(ctx, memberId, roleKey, ...rest);
    }) as typeof real.changeRole,
    endMember: ((ctx, memberId, ...rest) => {
      note('endMember', memberId);
      return real.endMember(ctx, memberId, ...rest);
    }) as typeof real.endMember,
  };
});

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
const events: { room: string; event: string; payload: Record<string, unknown> }[] = [];
beforeEach(async () => {
  await resetCommittee();
  spy.calls.length = 0;
  spy.failOn = 0;
  events.length = 0;
  setRealtimeSink({ emit: e => events.push(e), disconnectSession: () => undefined });
});
afterAll(() => setRealtimeSink(undefined));

type X = Awaited<ReturnType<typeof handoverWorld>>;
const activateUrl = (id: number) => `/committee/terms/${id}/activate`;
const settle = () => new Promise(r => setTimeout(r, 60));
const hash = (c = 'a') => c.repeat(64);
async function activateNow(x: X, extra: Record<string, unknown> = {}, c = x.w.c) {
  const p = await previewOf(c, x.draft.id);
  return c('post', activateUrl(x.draft.id), activateBody(p, x.draft.version, extra), { headers: idem() });
}
const roles = async (x: X) =>
  Object.fromEntries(
    await Promise.all(
      (['rajesh', 'arjun', 'meera', 'farhan', 'lata'] as const).map(async k => [
        k,
        await roleOf(x.w.society.id!, x[k].user.id),
      ]),
    ),
  );
/** Draft seats rewritten (the draft is saved straight into the row to set up a case the API would refuse). */
async function editDraft(x: X, fn: (m: any[]) => any[]) {
  const d = (await CommitteeTerm.findByPk(x.draft.id))!;
  d.members = fn(d.members);
  await d.save();
}

describe('8.7 activation preview (F04)', () => {
  it('lists the role plan in the safe order with staff seats, delegations, no blockers and a hash; changes nothing', async () => {
    const x = await handoverWorld();
    const p = await previewOf(x.w.c, x.draft.id);
    expect(p).toMatchObject({
      termId: x.draft.id,
      termVersion: 1,
      currentTermId: x.current.id,
      currentTermVersion: 1,
      warnings: [],
      blockers: [],
    });
    expect(p.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.staffSeats.delta).toBe(0);
    expect(p.staffSeats.used).toBe(0);
    expect(
      p.actions.map((a: any) => [
        a.kind,
        a.step ?? '-',
        a.name,
        a.reason,
        a.fromRoleKey ?? a.roleKey,
        a.toRoleKey ?? '-',
      ]),
    ).toEqual([
      ['CHANGE_ROLE', 'A', 'Meera Iyer', 'OUTGOING', 'treasurer', 'owner'],
      ['CHANGE_ROLE', 'B', 'Farhan Qureshi', 'INCOMING', 'owner', 'chairman'],
      ['CHANGE_ROLE', 'C', 'Rajesh Kulkarni', 'OUTGOING', 'chairman', 'owner'],
      ['CHANGE_ROLE', 'D', 'Lata Menon', 'INCOMING', 'owner', 'treasurer'],
      ['NONE', '-', 'Arjun Shah', 'CONTINUING', 'secretary', '-'],
    ]);
    expect(p.actions[0]).toMatchObject({
      userId: x.meera.user.id,
      memberId: expect.any(Number),
      seatDelta: 0,
    });
    expect(p.handoverDelegations).toEqual([
      {
        designation: 'CHAIRMAN',
        fromUserId: x.rajesh.user.id,
        fromName: 'Rajesh Kulkarni',
        toUserId: x.farhan.user.id,
        toName: 'Farhan Qureshi',
        days: 30,
      },
      {
        designation: 'TREASURER',
        fromUserId: x.meera.user.id,
        fromName: 'Meera Iyer',
        toUserId: x.lata.user.id,
        toName: 'Lata Menon',
        days: 30,
      },
    ]);
    expect(p.seats.map((s: any) => s.designation)).toEqual(['CHAIRMAN', 'SECRETARY', 'TREASURER']);
    expect(await roles(x)).toMatchObject({
      rajesh: 'chairman',
      meera: 'treasurer',
      farhan: 'owner',
      lata: 'owner',
    });
    expect(spy.calls).toEqual([]);
    expect(committeePortCalls).toEqual([]);
    expect((await CommitteeTerm.findByPk(x.draft.id))!.status).toBe('DRAFT');
    expect((await previewOf(x.w.c, x.draft.id)).previewHash).toBe(p.previewHash);
  });

  it('US-10-01: a first committee whose holders already have the roles shows no role change', async () => {
    const w = await committeeWorld();
    const [a, b, c] = [
      await holder(w, 1, 'Rajesh Kulkarni'),
      await holder(w, 2, 'Arjun Shah'),
      await holder(w, 3, 'Meera Iyer'),
    ];
    await setRole(w.society.id!, a.user.id, 'chairman');
    await setRole(w.society.id!, b.user.id, 'secretary');
    await setRole(w.society.id!, c.user.id, 'treasurer');
    const d = await postTerm(
      w.c,
      termBody([seat(a, w, 1, 'CHAIRMAN'), seat(b, w, 2, 'SECRETARY'), seat(c, w, 3, 'TREASURER')]),
    );
    const p = await previewOf(w.c, d.id);
    expect(p.currentTermId).toBeNull();
    expect(p.actions.map((x: any) => [x.kind, x.reason ?? '-'])).toEqual([
      ['END_MEMBERSHIP', '-'],
      ['NONE', 'INCOMING'],
      ['NONE', 'INCOMING'],
      ['NONE', 'INCOMING'],
    ]);
    // the signed-in chairman holds a committee role and is not in the draft: outgoing (BR-10-12); no flat, so the membership ends
    expect(p.warnings.map((x: any) => x.code)).toEqual(['MEMBERSHIP_WILL_END']);
  });

  it('the draft only: an ACTIVE term is 409 INVALID_STATE, another id 404, a bad id 400', async () => {
    const x = await handoverWorld();
    expect((await x.w.c('get', `/committee/terms/${x.current.id}/activation-preview`)).body.code).toBe(
      'INVALID_STATE',
    );
    expect((await x.w.c('get', '/committee/terms/999999/activation-preview')).body.code).toBe(
      'COMMITTEE_TERM_NOT_FOUND',
    );
    expect((await x.w.c('get', '/committee/terms/abc/activation-preview')).status).toBe(400);
  });
});

describe('T10-08 activation (US-10-02, F05, BR-10-11, BR-10-16)', () => {
  it('moves the roles, ends the old term, links the terms, seats get their dates, audits and announces', async () => {
    const x = await handoverWorld();
    const sent: { template: string; userIds: number[]; data: Record<string, unknown> }[] = [];
    setCommitteePorts({
      notifications: { send: async (template, userIds, data) => void sent.push({ template, userIds, data }) },
    });
    const baseline = (await AuditLog.max<number, AuditLog>('id')) ?? 0;
    events.length = 0;
    const r = await activateNow(x);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.message).toBe('Managing Committee 2026–2031 has taken charge');
    expect(r.body.data).toEqual({
      term: { id: x.draft.id, status: 'ACTIVE', tookChargeOn: '2026-11-01', version: 2 },
      endedTerm: { id: x.current.id, status: 'ENDED', actualEndDate: '2026-10-31' },
      summary: {
        roleChanges: 4,
        membershipsEnded: 0,
        handoverDelegationsCreated: 2,
        handoverDelegationsSkipped: [],
      },
    });
    expect(await roles(x)).toEqual({
      rajesh: 'owner',
      arjun: 'secretary',
      meera: 'owner',
      farhan: 'chairman',
      lata: 'treasurer',
    });

    const draft = (await CommitteeTerm.findByPk(x.draft.id))!;
    const old = (await CommitteeTerm.findByPk(x.current.id))!;
    expect(draft).toMatchObject({
      status: 'ACTIVE',
      tookChargeOn: '2026-11-01',
      resolutionRef: 'CM/2026-27/01',
      predecessorTermId: old.id,
      activatedBy: x.w.user.id,
      version: 2,
    });
    expect(draft.activatedAt).not.toBeNull();
    expect(draft.handoverChecklist).toHaveLength(10);
    expect(draft.handoverChecklist.every(i => i.status === 'PENDING')).toBe(true);
    expect(draft.members.map(s => [s.name, s.status, s.fromDate, s.memberId !== null, s.flags])).toEqual([
      ['Farhan Qureshi', 'SEATED', '2026-11-01', true, []],
      ['Arjun Shah', 'SEATED', '2026-11-01', true, []],
      ['Lata Menon', 'SEATED', '2026-11-01', true, []],
    ]);
    expect(old).toMatchObject({
      status: 'ENDED',
      actualEndDate: '2026-10-31',
      endedBy: x.w.user.id,
      version: 2,
    });
    expect(old.endedAt).not.toBeNull();
    expect(old.members.map(s => [s.status, s.exitReason, s.toDate])).toEqual([
      ['LEFT', 'TERM_ENDED', '2026-10-31'],
      ['LEFT', 'TERM_ENDED', '2026-10-31'],
      ['LEFT', 'TERM_ENDED', '2026-10-31'],
    ]);

    const d = (await x.w.c('get', `/committee/terms/${x.draft.id}`)).body.data;
    expect(d.predecessorTermId).toBe(old.id);
    expect((await x.w.c('get', `/committee/terms/${old.id}`)).body.data.successorTermId).toBe(x.draft.id);
    expect((await x.w.c('get', '/committee')).body.data.current.id).toBe(x.draft.id);

    const audits = (
      await AuditLog.findAll({ where: { societyId: x.w.society.id! }, order: [['id', 'ASC']] })
    ).filter(a => a.id! > baseline);
    const act = audits.find(a => a.action === 'committee.term.activated')!;
    expect(act.entityId).toBe(String(x.draft.id));
    expect(act.reason).toBe('The new committee takes charge');
    expect(JSON.stringify(act.after)).toContain('Farhan Qureshi');
    expect(JSON.stringify(act.after)).toContain('CM/2026-27/01');
    expect(audits.filter(a => a.action === 'committee.term.ended').map(a => a.entityId)).toEqual([
      String(old.id),
    ]);
    expect(audits.filter(a => a.action === 'access.member.role_changed')).toHaveLength(4);

    // hand-over delegations through the module 14 placeholder (BR-10-18)
    expect(committeePortCalls.map(c => c.fn)).toEqual([
      'approvals.createHandoverDelegation',
      'approvals.createHandoverDelegation',
    ]);
    const inputs = committeePortCalls.map(c => c.input as any);
    expect(inputs.map(i => [i.fromUserId, i.toUserId]).sort()).toEqual(
      [
        [x.rajesh.user.id, x.farhan.user.id],
        [x.meera.user.id, x.lata.user.id],
      ].sort(),
    );
    expect(inputs[0]).toMatchObject({
      committeeTermId: x.draft.id,
      reason: 'Committee hand-over: Managing Committee 2026–2031',
    });
    expect(inputs[0].endsAt.getTime() - inputs[0].startsAt.getTime()).toBe(30 * 86_400_000);

    expect(events.filter(e => e.event === 'committee.changed')).toEqual([
      {
        room: `society:${x.w.society.id}:admin`,
        event: 'committee.changed',
        payload: { termId: x.draft.id, status: 'ACTIVE', reason: 'ACTIVATED' },
      },
    ]);
    await settle();
    const activated = sent.find(s => s.template === 'committee.term_activated')!;
    expect(activated.userIds.sort()).toEqual(
      [x.rajesh, x.arjun, x.meera, x.farhan, x.lata].map(h => h.user.id).sort(),
    );
    expect(activated.data).toMatchObject({ termName: 'Managing Committee 2026–2031', endDate: '2031-10-31' });
    const announced = sent.find(s => s.template === 'committee.new_committee_announced')!;
    expect(announced.userIds).toEqual(expect.arrayContaining([x.rajesh.user.id, x.farhan.user.id]));
  });

  it('announceToResidents false sends no announcement; the term_activated message still goes', async () => {
    const x = await handoverWorld();
    const sent: string[] = [];
    setCommitteePorts({ notifications: { send: async template => void sent.push(template) } });
    expect((await activateNow(x, { announceToResidents: false })).status).toBe(200);
    await settle();
    expect(sent).toEqual(['committee.term_activated']);
  });

  it('BR-10-16: tookChargeOn sets the dates (outgoing toDate = date - 1, incoming fromDate = date)', async () => {
    const x = await handoverWorld();
    await CommitteeTerm.update({ startDate: '2026-10-01' }, { where: { id: x.draft.id } });
    const r = await activateNow(x, { tookChargeOn: '2026-10-20' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.endedTerm.actualEndDate).toBe('2026-10-19');
    expect((await CommitteeTerm.findByPk(x.current.id))!.members.map(s => s.toDate)).toEqual([
      '2026-10-19',
      '2026-10-19',
      '2026-10-19',
    ]);
    expect((await CommitteeTerm.findByPk(x.draft.id))!.members.map(s => s.fromDate)).toEqual([
      '2026-10-20',
      '2026-10-20',
      '2026-10-20',
    ]);
  });

  it('BR-10-16: a date before the start, in the future, or before the current committee took charge is 422 COMMITTEE_TERM_DATES_INVALID', async () => {
    const x = await handoverWorld();
    const p = await previewOf(x.w.c, x.draft.id);
    for (const d of ['2026-10-31', '2026-11-02']) {
      const r = await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1, { tookChargeOn: d }), {
        headers: idem(),
      });
      expect([r.status, r.body.code], d).toEqual([422, 'COMMITTEE_TERM_DATES_INVALID']);
    }
    await CommitteeTerm.update({ startDate: '2024-04-02' }, { where: { id: x.draft.id } });
    await CommitteeTerm.update({ tookChargeOn: '2026-10-10' }, { where: { id: x.current.id } });
    const r = await x.w.c(
      'post',
      activateUrl(x.draft.id),
      activateBody(p, 1, { tookChargeOn: '2026-10-09' }),
      { headers: idem() },
    );
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_TERM_DATES_INVALID']);
    expect((await CommitteeTerm.findByPk(x.draft.id))!.status).toBe('DRAFT');
  });

  it('BR-10-16: a draft whose start date is in the future is 422 COMMITTEE_TERM_NOT_STARTED (preview blocker TERM_NOT_STARTED)', async () => {
    const x = await handoverWorld();
    await CommitteeTerm.update({ startDate: '2026-12-01' }, { where: { id: x.draft.id } });
    const p = await previewOf(x.w.c, x.draft.id);
    expect(p.blockers.map((b: any) => b.code)).toEqual(['TERM_NOT_STARTED']);
    const r = await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_TERM_NOT_STARTED']);
    expect(spy.calls).toEqual([]);
  });

  it('a continuing holder keeps the role-before of the seat they leave; an outgoing holder gets the role back (BR-10-9, BR-10-10)', async () => {
    const x = await handoverWorld();
    const members = (await CommitteeTerm.findByPk(x.current.id))!.members.map(s =>
      s.designation === 'SECRETARY' || s.designation === 'TREASURER'
        ? { ...s, roleBeforeKey: 'accountant' }
        : s,
    );
    await CommitteeTerm.update({ members: members as never }, { where: { id: x.current.id } });
    const r = await activateNow(x);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await roleOf(x.w.society.id!, x.meera.user.id)).toBe('accountant');
    const draft = (await CommitteeTerm.findByPk(x.draft.id))!;
    expect(draft.members.find(s => s.name === 'Arjun Shah')!.roleBeforeKey).toBe('accountant');
    expect(draft.members.find(s => s.name === 'Lata Menon')!.roleBeforeKey).toBeNull();
  });

  it('an outgoing holder with no flat link has the membership ended through module 03 (warning MEMBERSHIP_WILL_END)', async () => {
    const x = await handoverWorld();
    await UnitResident.update({ toDate: '2026-10-01', endReason: 'MOVED_OUT' } as never, {
      where: { residentId: x.meera.resident.id },
    });
    const p = await previewOf(x.w.c, x.draft.id);
    expect(p.warnings).toMatchObject([{ code: 'MEMBERSHIP_WILL_END', userIds: [x.meera.user.id] }]);
    expect(p.actions[0]).toMatchObject({
      kind: 'END_MEMBERSHIP',
      step: 'A',
      fromRoleKey: 'treasurer',
      seatDelta: 0,
    });
    const r = await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.summary).toMatchObject({ roleChanges: 3, membershipsEnded: 1 });
    expect(await roleOf(x.w.society.id!, x.meera.user.id)).toBe('ENDED');
    expect((await SocietyMember.findOne({ where: { userId: x.meera.user.id } }))!.status).toBe('ENDED');
  });
});

describe('BR-10-11 safe order and the last-chairman guard (BR-03-8)', () => {
  it('module 03 is called new chairman first, old chairman after; the guard holds at every step even with a single chairman', async () => {
    const x = await handoverWorld();
    await setRole(x.w.society.id!, x.w.user.id, 'secretary'); // Rajesh is the only chairman now
    await CommitteeTerm.update({ source: 'ELECTION', electionId: 7 }, { where: { id: x.draft.id } });
    const r = await activateNow(x);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const names = new Map<number, string>();
    for (const k of ['rajesh', 'arjun', 'meera', 'farhan', 'lata'] as const)
      names.set(await memberIdOf(x.w.society.id!, x[k].user.id), k);
    expect(spy.calls.map(c => `${c.fn}:${names.get(c.memberId)}:${c.roleKey}`)).toEqual([
      'changeRole:meera:owner',
      'changeRole:farhan:chairman',
      'changeRole:rajesh:owner',
      'changeRole:lata:treasurer',
    ]);
    expect(await roleOf(x.w.society.id!, x.farhan.user.id)).toBe('chairman');
  });

  it('the reverse order is refused by module 03 with 409 LAST_CHAIRMAN (why the order matters)', async () => {
    const x = await handoverWorld();
    await setRole(x.w.society.id!, x.w.user.id, 'secretary');
    const memberId = await memberIdOf(x.w.society.id!, x.rajesh.user.id);
    await expect(
      sequelize.transaction(t =>
        changeRole(systemCtx('test'), memberId, 'owner', 'wrong order', t, { via: 'committee' }),
      ),
    ).rejects.toMatchObject({ code: 'LAST_CHAIRMAN' });
    expect(await roleOf(x.w.society.id!, x.rajesh.user.id)).toBe('chairman');
  });

  it('a chairman who continues as secretary moves after the new chairman', async () => {
    const x = await handoverWorld();
    await setRole(x.w.society.id!, x.w.user.id, 'secretary');
    await CommitteeTerm.update({ source: 'ELECTION', electionId: 7 }, { where: { id: x.draft.id } });
    await editDraft(x, m =>
      m.map(s =>
        s.designation === 'SECRETARY'
          ? { ...s, userId: x.rajesh.user.id, name: 'Rajesh Kulkarni', unitId: x.rajesh.link.unitId }
          : s,
      ),
    );
    const r = await activateNow(x);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await roleOf(x.w.society.id!, x.rajesh.user.id)).toBe('secretary');
    const order = spy.calls.map(c => c.roleKey);
    expect(order.indexOf('chairman')).toBeLessThan(order.indexOf('secretary'));
  });
});

describe('T10-09 stale preview hash (BR-10-13)', () => {
  it('a role that changed in module 03 after the preview gives 409 COMMITTEE_PREVIEW_STALE and nothing changes', async () => {
    const x = await handoverWorld();
    const p = await previewOf(x.w.c, x.draft.id);
    await setRole(x.w.society.id!, x.lata.user.id, 'tenant');
    const r = await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([409, 'COMMITTEE_PREVIEW_STALE']);
    spy.calls.length = 0;
    expect(await roles(x)).toMatchObject({ rajesh: 'chairman', meera: 'treasurer', farhan: 'owner' });
    expect((await CommitteeTerm.findByPk(x.draft.id))!.status).toBe('DRAFT');
    expect((await CommitteeTerm.findByPk(x.current.id))!.status).toBe('ACTIVE');
    expect(committeePortCalls).toEqual([]);
    expect(
      (
        await x.w.c('post', activateUrl(x.draft.id), activateBody({ previewHash: 'abc' }, 1), {
          headers: idem(),
        })
      ).status,
    ).toBe(400);
    const wrong = await x.w.c('post', activateUrl(x.draft.id), activateBody({ previewHash: hash() }, 1), {
      headers: idem(),
    });
    expect(wrong.body.code).toBe('COMMITTEE_PREVIEW_STALE');
    expect(spy.calls).toEqual([]);
  });

  it('a changed draft version is 409 STALE_VERSION', async () => {
    const x = await handoverWorld();
    const p = await previewOf(x.w.c, x.draft.id);
    const r = await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 7), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([409, 'STALE_VERSION']);
  });
});

describe('T10-10 blockers (BR-10-5, BR-10-7, BR-10-8, BR-10-9)', () => {
  it('a draft without a CHAIRMAN seat: preview blocker OFFICE_BEARERS_REQUIRED, activation 422 COMMITTEE_OFFICE_BEARERS_REQUIRED', async () => {
    const w = await committeeWorld();
    const [a, b] = [await holder(w, 1, 'Arjun Shah'), await holder(w, 2, 'Meera Iyer')];
    const d = await postTerm(w.c, termBody([seat(a, w, 1, 'SECRETARY'), seat(b, w, 2, 'TREASURER')]));
    const p = await previewOf(w.c, d.id);
    expect(p.blockers).toMatchObject([
      { code: 'OFFICE_BEARERS_REQUIRED', message: expect.stringContaining('chairman') },
    ]);
    const r = await w.c('post', activateUrl(d.id), activateBody({ previewHash: hash('b') }, 1), {
      headers: idem(),
    });
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_OFFICE_BEARERS_REQUIRED']);
    expect(spy.calls).toEqual([]);
  });

  it('holders who left, were suspended or lost their flat after the draft was saved block the activation with their seat ids', async () => {
    const cases: [string, (x: X) => Promise<unknown>, string, string][] = [
      [
        'ended',
        x => setMemberStatus(x.lata.user.id, 'ENDED'),
        'HOLDER_NOT_MEMBER',
        'COMMITTEE_HOLDER_NOT_MEMBER',
      ],
      [
        'suspended',
        x => setMemberStatus(x.lata.user.id, 'SUSPENDED'),
        'HOLDER_NOT_ACTIVE',
        'COMMITTEE_HOLDER_NOT_ACTIVE',
      ],
      [
        'no flat',
        x =>
          UnitResident.update({ toDate: '2026-10-01', endReason: 'MOVED_OUT' } as never, {
            where: { residentId: x.lata.resident.id },
          }),
        'HOLDER_INELIGIBLE',
        'COMMITTEE_HOLDER_INELIGIBLE',
      ],
    ];
    for (const [label, mutate, blocker, code] of cases) {
      await resetCommittee();
      const x = await handoverWorld();
      await mutate(x);
      const p = await previewOf(x.w.c, x.draft.id);
      expect(
        p.blockers.map((b: any) => b.code),
        label,
      ).toEqual([blocker]);
      expect(p.blockers[0].seatIds).toEqual(['S3']);
      const r = await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() });
      expect([r.status, r.body.code], label).toEqual([422, code]);
      expect(r.body.errors[0].seatIds).toEqual(['S3']);
      expect(spy.calls, label).toEqual([]);
    }
  });

  it('BR-10-9: a holder with a staff role needs replaceExistingRole; with it the role is stored as roleBeforeKey', async () => {
    const x = await handoverWorld();
    await setRole(x.w.society.id!, x.lata.user.id, 'accountant');
    spy.calls.length = 0;
    const p = await previewOf(x.w.c, x.draft.id);
    expect(p.blockers).toMatchObject([{ code: 'ROLE_CONFLICT', seatIds: ['S3'], userIds: [x.lata.user.id] }]);
    const r = await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_ROLE_CONFLICT']);
    await editDraft(x, m =>
      m.map(s => (s.designation === 'TREASURER' ? { ...s, replaceExistingRole: true } : s)),
    );
    const p2 = await previewOf(x.w.c, x.draft.id);
    expect(p2.blockers).toEqual([]);
    expect(p2.actions.find((a: any) => a.userId === x.lata.user.id)).toMatchObject({
      fromRoleKey: 'accountant',
      toRoleKey: 'treasurer',
      seatDelta: -1,
    });
    expect(p2.staffSeats.delta).toBe(-1);
    const ok = await x.w.c('post', activateUrl(x.draft.id), activateBody(p2, 1), { headers: idem() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(
      (await CommitteeTerm.findByPk(x.draft.id))!.members.find(s => s.name === 'Lata Menon')!.roleBeforeKey,
    ).toBe('accountant');
  });
});

describe('T10-11 atomic rollback (US-10-02)', () => {
  it('a module 03 failure on the 4th action rolls back everything: draft still DRAFT, roles, audit rows and delegations untouched', async () => {
    const x = await handoverWorld();
    const p = await previewOf(x.w.c, x.draft.id);
    const before = await AuditLog.count({ where: { societyId: x.w.society.id! } });
    spy.calls.length = 0;
    events.length = 0;
    spy.failOn = 4;
    const r = await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([409, 'MODULE_03_FAILED']);
    expect(spy.calls).toHaveLength(4);
    expect(await roles(x)).toEqual({
      rajesh: 'chairman',
      arjun: 'secretary',
      meera: 'treasurer',
      farhan: 'owner',
      lata: 'owner',
    });
    const draft = (await CommitteeTerm.findByPk(x.draft.id))!;
    expect(draft.status).toBe('DRAFT');
    expect(draft.version).toBe(1);
    expect(draft.members.every(s => s.status === 'PLANNED')).toBe(true);
    const old = (await CommitteeTerm.findByPk(x.current.id))!;
    expect([old.status, old.version, old.endedAt]).toEqual(['ACTIVE', 1, null]);
    expect(await AuditLog.count({ where: { societyId: x.w.society.id! } })).toBe(before);
    expect(committeePortCalls).toEqual([]);
    expect(events.filter(e => e.event === 'committee.changed')).toEqual([]);
    spy.failOn = 0;
    expect(
      (await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() })).status,
    ).toBe(200);
  });

  it('a hand-over delegation refused with an unexpected error aborts the activation', async () => {
    const x = await handoverWorld();
    setCommitteePorts({
      approvals: {
        createHandoverDelegation: async () => {
          throw new Error('module 14 is down');
        },
      },
    });
    const r = await activateNow(x);
    expect(r.status).toBe(500);
    expect(await roles(x)).toMatchObject({ rajesh: 'chairman', farhan: 'owner' });
    expect((await CommitteeTerm.findByPk(x.draft.id))!.status).toBe('DRAFT');
  });
});

describe('T10-12 staff seats (BR-10-17)', () => {
  it('committee roles hold no staff seat: a 7-member committee of plain owners activates with staff seats 2 of 2', async () => {
    const w = await committeeWorld({ plan: 'STARTER', flats: 8 });
    await setLimit(w.society.id!, 'limit.admin_seats', 2);
    await setAbsoluteUsage(w.society.id!, 'limit.admin_seats', 2);
    const hs = [];
    for (let i = 1; i <= 7; i++) hs.push(await holder(w, i, `Owner ${i}`));
    const designations = ['CHAIRMAN', 'SECRETARY', 'TREASURER', 'MEMBER', 'MEMBER', 'MEMBER', 'MEMBER'];
    const d = await postTerm(
      w.c,
      termBody(
        hs.map((h, i) => seat(h, w, i + 1, designations[i]!)),
        { strength: 7 },
      ),
    );
    const p = await previewOf(w.c, d.id);
    expect(p.staffSeats).toEqual({ limit: 2, used: 2, delta: 0 });
    expect(p.blockers.filter((b: any) => b.code === 'NO_FREE_SEAT')).toEqual([]);
    const r = await w.c('post', activateUrl(d.id), activateBody(p, 1), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await roleOf(w.society.id!, hs[0]!.user.id)).toBe('chairman');
    expect(await roleOf(w.society.id!, hs[6]!.user.id)).toBe('committee_member');
  });

  it("restoring an outgoing holder's accountant role with no free seat: preview blocker NO_FREE_SEAT, activation 402 USAGE_LIMIT_EXCEEDED before any module 03 call", async () => {
    const x = await handoverWorld();
    await setLimit(x.w.society.id!, 'limit.admin_seats', 2);
    await setAbsoluteUsage(x.w.society.id!, 'limit.admin_seats', 2);
    const members = (await CommitteeTerm.findByPk(x.current.id))!.members.map(s =>
      s.designation === 'TREASURER' ? { ...s, roleBeforeKey: 'accountant' } : s,
    );
    await CommitteeTerm.update({ members: members as never }, { where: { id: x.current.id } });
    spy.calls.length = 0;
    const p = await previewOf(x.w.c, x.draft.id);
    expect(p.staffSeats).toEqual({ limit: 2, used: 2, delta: 1 });
    expect(p.blockers).toMatchObject([{ code: 'NO_FREE_SEAT', userIds: [x.meera.user.id] }]);
    const r = await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([402, 'USAGE_LIMIT_EXCEEDED']);
    expect(spy.calls).toEqual([]);
    expect((await CommitteeTerm.findByPk(x.draft.id))!.status).toBe('DRAFT');
    await setAbsoluteUsage(x.w.society.id!, 'limit.admin_seats', 1);
    const p2 = await previewOf(x.w.c, x.draft.id);
    expect(p2.blockers).toEqual([]);
    expect(
      (await x.w.c('post', activateUrl(x.draft.id), activateBody(p2, 1), { headers: idem() })).status,
    ).toBe(200);
    expect(await roleOf(x.w.society.id!, x.meera.user.id)).toBe('accountant');
  });
});

describe('BR-10-14 authority (T10-13, T10-14, T10-15)', () => {
  it('T10-13: the secretary activating a draft that makes the secretary chairman is 403 SELF_CHANGE_NOT_ALLOWED', async () => {
    const x = await handoverWorld();
    const sec = await adminClient(x.arjun);
    await editDraft(x, m =>
      m.map(s =>
        s.designation === 'CHAIRMAN'
          ? { ...s, userId: x.arjun.user.id, name: 'Arjun Shah', unitId: x.arjun.link.unitId }
          : s.designation === 'SECRETARY'
            ? { ...s, userId: x.farhan.user.id, name: 'Farhan Qureshi', unitId: x.farhan.link.unitId }
            : s,
      ),
    );
    spy.calls.length = 0;
    const p = await previewOf(sec, x.draft.id);
    expect(p.blockers.map((b: any) => b.code)).toEqual(['SELF_CHANGE', 'UNHELD_PERMISSION']);
    const r = await sec('post', activateUrl(x.draft.id), activateBody(p, 1, {}), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([403, 'SELF_CHANGE_NOT_ALLOWED']);
    expect(spy.calls).toEqual([]);
  });

  it('T10-14: the society admin seating a chairman is 403 CANNOT_GRANT_UNHELD_PERMISSION listing the keys the admin lacks', async () => {
    const x = await handoverWorld();
    const admin = await memberOf(x.w.society, 'society_admin');
    const p = await previewOf(admin.c, x.draft.id);
    expect(p.blockers.map((b: any) => b.code)).toEqual(['UNHELD_PERMISSION']);
    expect(p.blockers[0].permissionKeys.length).toBeGreaterThan(0);
    const r = await admin.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([403, 'CANNOT_GRANT_UNHELD_PERMISSION']);
    expect(r.body.errors.every((e: any) => e.field === 'permissionKey')).toBe(true);
    expect(r.body.errors.map((e: any) => e.message)).toEqual(p.blockers[0].permissionKeys);
    expect(spy.calls).toEqual([]);
  });

  it('an ELECTION draft needs only settings.members.edit: the secretary activates it (no no-escalation rule)', async () => {
    const x = await handoverWorld();
    const sec = await adminClient(x.arjun);
    await CommitteeTerm.update({ source: 'ELECTION', electionId: 9 }, { where: { id: x.draft.id } });
    const p = await previewOf(sec, x.draft.id);
    expect(p.blockers).toEqual([]);
    expect((await sec('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() })).status).toBe(
      200,
    );
  });

  it('stepping down is allowed: the chairman who becomes a plain member of the new committee, no escalation', async () => {
    const x = await handoverWorld();
    const chair = await adminClient(x.rajesh);
    await editDraft(x, m => [
      ...m,
      newSeat({
        seatId: 'S4',
        userId: x.rajesh.user.id,
        name: 'Rajesh Kulkarni',
        unitId: x.rajesh.link.unitId,
        designation: 'MEMBER',
        status: 'PLANNED',
      }),
    ]);
    const p = await previewOf(chair, x.draft.id);
    expect(p.blockers).toEqual([]);
    const r = await chair('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await roleOf(x.w.society.id!, x.rajesh.user.id)).toBe('committee_member');
  });

  it('T10-15: the first committee (no current term) by an admin with settings.roles.edit: the admin may be seated as MEMBER only with replaceExistingRole', async () => {
    const w = await committeeWorld();
    const chair = await holder(w, 1, 'First Chairman');
    const sec = await holder(w, 2, 'First Secretary');
    const tre = await holder(w, 3, 'First Treasurer');
    const adminHolder = await holder(w, 4, 'Admin Owner');
    await setRole(w.society.id!, adminHolder.user.id, 'society_admin');
    const adm = await adminClient(adminHolder);
    const d = await postTerm(
      adm,
      termBody([
        seat(chair, w, 1, 'CHAIRMAN'),
        seat(sec, w, 2, 'SECRETARY'),
        seat(tre, w, 3, 'TREASURER'),
        seat(adminHolder, w, 4, 'MEMBER'),
      ]),
    );
    const p = await previewOf(adm, d.id);
    expect(p.currentTermId).toBeNull();
    expect(p.blockers.map((b: any) => b.code)).toEqual(['ROLE_CONFLICT']);
    const r = await adm('post', activateUrl(d.id), activateBody(p, 1), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_ROLE_CONFLICT']);
    const row = (await CommitteeTerm.findByPk(d.id))!;
    row.members = row.members.map(s =>
      s.designation === 'MEMBER' ? { ...s, replaceExistingRole: true } : s,
    );
    await row.save();
    const p2 = await previewOf(adm, d.id);
    expect(p2.blockers).toEqual([]);
    const ok = await adm('post', activateUrl(d.id), activateBody(p2, 1), { headers: idem() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await roleOf(w.society.id!, adminHolder.user.id)).toBe('committee_member');
    const after = (await CommitteeTerm.findByPk(d.id))!;
    expect(after.members.find(s => s.designation === 'MEMBER')!.roleBeforeKey).toBe('society_admin');
    expect(ok.body.data.endedTerm).toBeNull();
    expect(after.predecessorTermId).toBeNull();
  });

  it('the first committee needs settings.roles.edit: the secretary (edit only) gets 403 PERMISSION_DENIED', async () => {
    const w = await committeeWorld();
    const [a, b, c] = [
      await holder(w, 1, 'A Chairman'),
      await holder(w, 2, 'A Secretary'),
      await holder(w, 3, 'A Treasurer'),
    ];
    const d = await postTerm(
      w.c,
      termBody([seat(a, w, 1, 'CHAIRMAN'), seat(b, w, 2, 'SECRETARY'), seat(c, w, 3, 'TREASURER')]),
    );
    const sec = await memberOf(w.society, 'secretary');
    const r = await sec.c('get', `/committee/terms/${d.id}/activation-preview`);
    expect([r.status, r.body.code]).toEqual([403, 'PERMISSION_DENIED']);
  });
});

describe('T10-20 hand-over delegations (BR-10-18, F08)', () => {
  it('module 14 refusing one pair skips it (listed in the summary and the audit row); the other is created; activation succeeds', async () => {
    const x = await handoverWorld();
    const seen: any[] = [];
    setCommitteePorts({
      approvals: {
        createHandoverDelegation: async (_ctx, input) => {
          seen.push(input);
          if (input.fromUserId === x.rajesh.user.id) throw new AppError(409, 'DELEGATION_OVERLAP', 'overlap');
          return { id: 77 };
        },
      },
    });
    const r = await activateNow(x);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen.every(i => i.committeeTermId === x.draft.id)).toBe(true);
    expect(r.body.data.summary.handoverDelegationsCreated).toBe(1);
    expect(r.body.data.summary.handoverDelegationsSkipped).toEqual([
      {
        designation: 'CHAIRMAN',
        fromUserId: x.rajesh.user.id,
        toUserId: x.farhan.user.id,
        skippedBecause: 'DELEGATION_OVERLAP',
      },
    ]);
    const a = (await AuditLog.findOne({ where: { action: 'committee.term.activated' } }))!;
    expect(JSON.stringify(a.after)).toContain('DELEGATION_OVERLAP');
    expect((a.after as any).handoverDelegationsCreated).toBe(1);
  });

  it('committee.handoverDelegationDays sets the window; MEMBER seats and an unchanged holder get none', async () => {
    const x = await handoverWorld();
    await setSetting(x.w.society.id!, 'committee.handoverDelegationDays', 10);
    const p = await previewOf(x.w.c, x.draft.id);
    expect(p.handoverDelegations.map((d: any) => d.days)).toEqual([10, 10]);
    expect(p.handoverDelegations.map((d: any) => d.designation)).not.toContain('SECRETARY');
  });
});

describe('8.8 route rules (T10-27, T10-28, T10-33, T10-30, T10-29)', () => {
  it('T10-28: the same Idempotency-Key and body replays the first answer', async () => {
    const x = await handoverWorld();
    const p = await previewOf(x.w.c, x.draft.id);
    const h = idem();
    spy.calls.length = 0;
    const one = await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: h });
    const two = await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: h });
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(two.headers['idempotent-replay']).toBe('true');
    expect(two.body).toEqual(one.body);
    expect(spy.calls).toHaveLength(4);
    expect((await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1))).status).toBe(400);
  });

  it('T10-33: without a recent sign-in it is 401 REAUTH_REQUIRED and nothing changes; the preview needs no step-up', async () => {
    const x = await handoverWorld();
    const p = await previewOf(x.w.c, x.draft.id);
    advance(10 * 60_000);
    const r = await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    expect((await CommitteeTerm.findByPk(x.draft.id))!.status).toBe('DRAFT');
    expect((await x.w.c('get', `/committee/terms/${x.draft.id}/activation-preview`)).status).toBe(200);
  });

  it('T10-27: two parallel activations of the same draft with different keys: one 200, one 409 INVALID_STATE', async () => {
    const x = await handoverWorld();
    const p = await previewOf(x.w.c, x.draft.id);
    spy.calls.length = 0;
    const [a, b] = await Promise.all([
      x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() }),
      x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([a, b].find(r => r.status === 409)!.body.code).toBe('INVALID_STATE');
    expect(spy.calls).toHaveLength(4);
    expect(await CommitteeTerm.count({ where: { status: 'ACTIVE' } })).toBe(1);
  });

  it('body rules: strict, resolutionRef 3-100, reason 5-500, hash shape, date shape', async () => {
    const x = await handoverWorld();
    const p = await previewOf(x.w.c, x.draft.id);
    const bad = async (extra: Record<string, unknown>, field: string) => {
      const r = await x.w.c(
        'post',
        activateUrl(x.draft.id),
        { ...activateBody(p, 1), ...extra },
        { headers: idem() },
      );
      expect([r.status, r.body.code], field).toEqual([400, 'VALIDATION_FAILED']);
      expect(JSON.stringify(r.body.errors)).toContain(field);
    };
    await bad({ extra: 1 }, 'extra');
    await bad({ resolutionRef: 'ab' }, 'resolutionRef');
    await bad({ reason: 'no' }, 'reason');
    await bad({ tookChargeOn: '01-11-2026' }, 'tookChargeOn');
    await bad({ announceToResidents: 'yes' }, 'announceToResidents');
    expect((await x.w.c('post', activateUrl(x.draft.id), { version: 1 }, { headers: idem() })).status).toBe(
      400,
    );
  });

  it('an ACTIVE term cannot be activated (409 INVALID_STATE); an unknown id is 404', async () => {
    const x = await handoverWorld();
    const p = await previewOf(x.w.c, x.draft.id);
    const r = await x.w.c('post', activateUrl(x.current.id), activateBody(p, 1), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
    const nf = await x.w.c('post', activateUrl(987654), activateBody(p, 1), { headers: idem() });
    expect([nf.status, nf.body.code]).toEqual([404, 'COMMITTEE_TERM_NOT_FOUND']);
  });

  it('T10-30: a committee member (view only) is 403 PERMISSION_DENIED on every 10.2 route', async () => {
    const x = await handoverWorld();
    const m = await memberOf(x.w.society, 'committee_member');
    const vacate = [{ op: 'VACATE', seatId: 'S2', exitReason: 'RESIGNED' }];
    const calls: [string, string, Record<string, unknown> | undefined][] = [
      ['get', `/committee/terms/${x.draft.id}/activation-preview`, undefined],
      ['post', activateUrl(x.draft.id), activateBody({ previewHash: hash() }, 1)],
      ['post', `/committee/terms/${x.current.id}/changes/preview`, { version: 1, changes: vacate }],
      [
        'post',
        `/committee/terms/${x.current.id}/changes`,
        { version: 1, changes: vacate, previewHash: hash(), reason: 'Resigned' },
      ],
    ];
    for (const [method, path, body] of calls) {
      const r = await m.c(method as 'get', path, body, { headers: idem() });
      expect([r.status, r.body.code], path).toEqual([403, 'PERMISSION_DENIED']);
    }
  });

  it("T10-29: society A cannot preview or activate society B's draft (404 COMMITTEE_TERM_NOT_FOUND)", async () => {
    const a = await committeeWorld();
    const x = await handoverWorld();
    const p = await previewOf(x.w.c, x.draft.id);
    const pv = await a.c('get', `/committee/terms/${x.draft.id}/activation-preview`);
    expect([pv.status, pv.body.code]).toEqual([404, 'COMMITTEE_TERM_NOT_FOUND']);
    const r = await a.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([404, 'COMMITTEE_TERM_NOT_FOUND']);
    expect((await CommitteeTerm.findByPk(x.draft.id))!.status).toBe('DRAFT');
  });

  it('a SUSPENDED society: the preview reads, the activation is 423 SOCIETY_SUSPENDED', async () => {
    const x = await handoverWorld();
    const p = await previewOf(x.w.c, x.draft.id);
    await suspend(x.w.society.id!);
    expect((await x.w.c('get', `/committee/terms/${x.draft.id}/activation-preview`)).status).toBe(200);
    const r = await x.w.c('post', activateUrl(x.draft.id), activateBody(p, 1), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
  });
});

describe('plan (section 2.2)', () => {
  it('governance.office_bearers off: preview and activation are 402 FEATURE_NOT_IN_PLAN', async () => {
    const x = await handoverWorld();
    await featureOff(x.w.society.id!, 'governance.office_bearers');
    const pv = await x.w.c('get', `/committee/terms/${x.draft.id}/activation-preview`);
    expect([pv.status, pv.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    const r = await x.w.c('post', activateUrl(x.draft.id), activateBody({ previewHash: hash() }, 1), {
      headers: idem(),
    });
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
  });
});
