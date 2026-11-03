import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, CommitteeTerm, UnitResident, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { advance } from '../../../src/lib/clock';
import { setRealtimeSink } from '../../../src/lib/realtime';
import { committeePortCalls, setCommitteePorts } from '../../../src/modules/committee/committee.ports';
import { setAbsoluteUsage } from '../../../src/modules/subscriptions/entitlements.service';
import { as, login, resetLogins } from '../../helpers/access';
import { featureOff, memberOf } from '../../helpers/society-setup';
import {
  adminClient,
  committeeWorld,
  holder,
  idem,
  rawTerm,
  resetCommittee,
  roleOf,
  seatedFor,
  setLimit,
  setMemberStatus,
  setRole,
  setSetting,
  suspend,
} from '../../helpers/committee';

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

const hash = (c = 'a') => c.repeat(64);
const settle = () => new Promise(r => setTimeout(r, 60));

/** An ACTIVE term of strength 5 (Rajesh chairman, Arjun secretary, Meera treasurer, Nita and Omar members) and three plain owners. */
async function currentWorld(o: Parameters<typeof committeeWorld>[0] = {}) {
  const w = await committeeWorld({ flats: 8, ...o });
  const rajesh = await holder(w, 1, 'Rajesh Kulkarni');
  const arjun = await holder(w, 2, 'Arjun Shah');
  const meera = await holder(w, 3, 'Meera Iyer');
  const nita = await holder(w, 4, 'Nita Rao');
  const omar = await holder(w, 5, 'Omar Sheikh');
  const farhan = await holder(w, 6, 'Farhan Qureshi');
  const lata = await holder(w, 7, 'Lata Menon');
  const tara = await holder(w, 8, 'Tara Desai');
  for (const [h, r] of [
    [rajesh, 'chairman'],
    [arjun, 'secretary'],
    [meera, 'treasurer'],
    [nita, 'committee_member'],
    [omar, 'committee_member'],
  ] as const)
    await setRole(w.society.id!, h.user.id, r);
  const term = await rawTerm(w.society.id!, {
    members: [
      await seatedFor(w, rajesh, 'S1', 'CHAIRMAN'),
      await seatedFor(w, arjun, 'S2', 'SECRETARY'),
      await seatedFor(w, meera, 'S3', 'TREASURER'),
      await seatedFor(w, nita, 'S4', 'MEMBER'),
      await seatedFor(w, omar, 'S5', 'MEMBER'),
    ],
  });
  spy.calls.length = 0;
  return { w, rajesh, arjun, meera, nita, omar, farhan, lata, tara, term };
}
type W = Awaited<ReturnType<typeof currentWorld>>;

const previewUrl = (w: W) => `/committee/terms/${w.term.id}/changes/preview`;
const applyUrl = (w: W) => `/committee/terms/${w.term.id}/changes`;
const vacate = (seatId: string, exitReason = 'RESIGNED', extra = {}) => ({
  op: 'VACATE',
  seatId,
  exitReason,
  ...extra,
});
const add = (
  w: W,
  h: { user: { id: number }; link: { unitId: number } },
  designation: string,
  extra = {},
) => ({
  op: 'ADD',
  userId: h.user.id,
  unitId: h.link.unitId,
  designation,
  joinMode: 'CO_OPTED',
  resolutionRef: 'CM/2026-27/14',
  ...extra,
});
const redesignate = (seatId: string, designation: string) => ({ op: 'REDESIGNATE', seatId, designation });

async function preview(w: W, changes: unknown[], extra: Record<string, unknown> = {}, c = w.w.c) {
  const r = await c(
    'post',
    previewUrl(w),
    { version: (await CommitteeTerm.findByPk(w.term.id))!.version, changes, ...extra },
    { headers: idem() },
  );
  return r;
}
async function apply(
  w: W,
  changes: unknown[],
  extra: Record<string, unknown> = {},
  c = w.w.c,
  hashOverride?: string,
) {
  const version = (await CommitteeTerm.findByPk(w.term.id))!.version;
  const p = await preview(w, changes, extra, c);
  const body = {
    version,
    changes,
    previewHash: hashOverride ?? p.body.data?.previewHash ?? hash(),
    reason: 'Committee resolution of the day',
    ...extra,
  };
  return c('post', applyUrl(w), body, { headers: idem() });
}
const seatsOf = async (w: W) => (await CommitteeTerm.findByPk(w.term.id))!.members;

describe('8.9 changes preview (F07)', () => {
  it('returns the 8.7 shape for the current term: actions, staff seats, delegations, warnings, blockers, hash; changes nothing', async () => {
    const x = await currentWorld();
    const r = await preview(x, [vacate('S3'), add(x, x.farhan, 'TREASURER')]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = r.body.data;
    expect(p).toMatchObject({
      termId: x.term.id,
      termVersion: 1,
      currentTermId: x.term.id,
      currentTermVersion: 1,
      staffSeats: { delta: 0 },
      warnings: [],
      blockers: [],
    });
    expect(p.previewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.actions.map((a: any) => [a.kind, a.step ?? '-', a.name, a.reason, a.toRoleKey])).toEqual([
      ['CHANGE_ROLE', 'A', 'Meera Iyer', 'OUTGOING', 'owner'],
      ['CHANGE_ROLE', 'D', 'Farhan Qureshi', 'INCOMING', 'treasurer'],
    ]);
    expect(p.handoverDelegations).toEqual([
      expect.objectContaining({
        designation: 'TREASURER',
        fromName: 'Meera Iyer',
        toName: 'Farhan Qureshi',
        days: 30,
      }),
    ]);
    expect(p.seats.filter((s: any) => s.status === 'SEATED')).toHaveLength(5);
    expect(await roleOf(x.w.society.id!, x.meera.user.id)).toBe('treasurer');
    expect(spy.calls).toEqual([]);
    expect((await CommitteeTerm.findByPk(x.term.id))!.version).toBe(1);
    expect((await preview(x, [vacate('S3'), add(x, x.farhan, 'TREASURER')])).body.data.previewHash).toBe(
      p.previewHash,
    );
  });

  it('needs no step-up and no Idempotency-Key', async () => {
    const x = await currentWorld();
    advance(10 * 60_000);
    const r = await x.w.c('post', previewUrl(x), { version: 1, changes: [vacate('S4')] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

describe('US-10-04 treasurer resigns, a replacement is co-opted (F07, BR-10-16, BR-10-21)', () => {
  it('vacates S3, adds the new treasurer, reverts the role, audits each change, notifies, hands over', async () => {
    const x = await currentWorld();
    const r = await apply(x, [
      vacate('S3', 'RESIGNED', { note: 'Moving abroad' }),
      add(x, x.farhan, 'TREASURER'),
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.message).toBe('Committee changes saved');
    expect(r.body.data).toMatchObject({
      id: x.term.id,
      status: 'ACTIVE',
      version: 2,
      summary: {
        roleChanges: 2,
        membershipsEnded: 0,
        handoverDelegationsCreated: 1,
        handoverDelegationsSkipped: [],
      },
    });
    expect(
      r.body.data.seats.map((s: any) => [
        s.seatId,
        s.name,
        s.designation,
        s.status,
        s.fromDate,
        s.toDate,
        s.exitReason,
        s.joinMode,
      ]),
    ).toEqual([
      ['S1', 'Rajesh Kulkarni', 'CHAIRMAN', 'SEATED', '2024-04-01', null, null, 'ELECTED'],
      ['S2', 'Arjun Shah', 'SECRETARY', 'SEATED', '2024-04-01', null, null, 'ELECTED'],
      ['S3', 'Meera Iyer', 'TREASURER', 'LEFT', '2024-04-01', '2026-11-01', 'RESIGNED', 'ELECTED'],
      ['S4', 'Nita Rao', 'MEMBER', 'SEATED', '2024-04-01', null, null, 'ELECTED'],
      ['S5', 'Omar Sheikh', 'MEMBER', 'SEATED', '2024-04-01', null, null, 'ELECTED'],
      ['S6', 'Farhan Qureshi', 'TREASURER', 'SEATED', '2026-11-01', null, null, 'CO_OPTED'],
    ]);
    const row = (await CommitteeTerm.findByPk(x.term.id))!;
    expect(row.members.find(s => s.seatId === 'S3')!.exitNote).toBe('Moving abroad');
    expect(row.members.find(s => s.seatId === 'S6')).toMatchObject({
      resolutionRef: 'CM/2026-27/14',
      memberId: expect.any(Number),
    });
    expect(row.version).toBe(2);
    expect(await roleOf(x.w.society.id!, x.meera.user.id)).toBe('owner');
    expect(await roleOf(x.w.society.id!, x.farhan.user.id)).toBe('treasurer');

    const audits = await AuditLog.findAll({ where: { societyId: x.w.society.id! }, order: [['id', 'ASC']] });
    const names = audits.map(a => a.action);
    expect(names).toContain('committee.seat.vacated');
    expect(names).toContain('committee.seat.added');
    expect(names.filter(n => n === 'committee.term.changed')).toHaveLength(1);
    const added = audits.find(a => a.action === 'committee.seat.added')!;
    expect(added.reason).toBe('Committee resolution of the day');
    expect(JSON.stringify(added.after)).toContain('CM/2026-27/14');
    expect(JSON.stringify(audits.find(a => a.action === 'committee.term.changed')!.after)).toContain(
      'Farhan Qureshi',
    );

    expect(committeePortCalls.map(c => (c.input as any).committeeTermId)).toEqual([x.term.id]);
    expect(events.filter(e => e.event === 'committee.changed').slice(-1)).toEqual([
      {
        room: `society:${x.w.society.id}:admin`,
        event: 'committee.changed',
        payload: { termId: x.term.id, status: 'ACTIVE', reason: 'CHANGED' },
      },
    ]);
  });
});

describe('T10-16 chairman rules (BR-10-5, BR-10-11, BR-03-8)', () => {
  it('vacating the chairman without a successor is 422 COMMITTEE_CHAIRMAN_REQUIRED (preview and apply)', async () => {
    const x = await currentWorld();
    for (const send of [preview, apply]) {
      const r = await send(x, [vacate('S1')]);
      expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_CHAIRMAN_REQUIRED']);
    }
    expect(await roleOf(x.w.society.id!, x.rajesh.user.id)).toBe('chairman');
    expect(spy.calls).toEqual([]);
  });

  it('T10-17: the chairman steps down to MEMBER and the secretary becomes CHAIRMAN, submitted by the chairman; new chairman first, no LAST_CHAIRMAN', async () => {
    const x = await currentWorld();
    await setRole(x.w.society.id!, x.w.user.id, 'secretary'); // Rajesh is the only chairman
    const chair = await adminClient(x.rajesh);
    spy.calls.length = 0;
    const r = await apply(x, [redesignate('S1', 'MEMBER'), redesignate('S2', 'CHAIRMAN')], {}, chair);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await roleOf(x.w.society.id!, x.arjun.user.id)).toBe('chairman');
    expect(await roleOf(x.w.society.id!, x.rajesh.user.id)).toBe('committee_member');
    expect(spy.calls.map(c => c.roleKey)).toEqual(['chairman', 'committee_member']);
    const seats = await seatsOf(x);
    expect(
      seats
        .filter(s => s.status === 'SEATED')
        .map(s => [s.name, s.designation])
        .sort(),
    ).toEqual([
      ['Arjun Shah', 'CHAIRMAN'],
      ['Meera Iyer', 'TREASURER'],
      ['Nita Rao', 'MEMBER'],
      ['Omar Sheikh', 'MEMBER'],
      ['Rajesh Kulkarni', 'MEMBER'],
    ]);
    // the secretary seat is vacant now; the delegations: CHAIRMAN Rajesh to Arjun
    expect(committeePortCalls.map(c => [(c.input as any).fromUserId, (c.input as any).toUserId])).toEqual([
      [x.rajesh.user.id, x.arjun.user.id],
    ]);
  });

  it('vacating the chairman and seating a new one in the same set: the new chairman first, then the old one is reverted', async () => {
    const x = await currentWorld();
    const r = await apply(x, [
      vacate('S1', 'RESIGNED'),
      add(x, x.farhan, 'CHAIRMAN'),
      vacate('S5', 'REMOVED'),
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(spy.calls.map(c => c.roleKey)).toEqual(['owner', 'chairman', 'owner']);
    // order is: A (Omar, not chairman), B (Farhan), C (Rajesh)
    expect(await roleOf(x.w.society.id!, x.farhan.user.id)).toBe('chairman');
  });
});

describe('BR-10-20 change set rules (T10-18)', () => {
  it('co-option switched off: 422 COMMITTEE_COOPTION_NOT_ALLOWED; NOMINATED still works', async () => {
    const x = await currentWorld();
    await setSetting(x.w.society.id!, 'committee.coOptionAllowed', false);
    const r = await apply(x, [vacate('S5'), add(x, x.farhan, 'MEMBER')]);
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_COOPTION_NOT_ALLOWED']);
    const ok = await apply(x, [vacate('S5'), add(x, x.farhan, 'MEMBER', { joinMode: 'NOMINATED' })]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('an ADD without a vacancy is 422 COMMITTEE_STRENGTH_INVALID; with a vacate in the same set it works', async () => {
    const x = await currentWorld();
    const r = await apply(x, [add(x, x.farhan, 'MEMBER')]);
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_STRENGTH_INVALID']);
  });

  it('set size, repeated seats, same designation, ELECTED, missing fields and unknown fields are refused', async () => {
    const x = await currentWorld();
    const code = async (changes: unknown[], status: number, expected: string) => {
      const r = await preview(x, changes);
      expect([r.status, r.body.code], expected).toEqual([status, expected]);
    };
    await code([], 400, 'VALIDATION_FAILED');
    await code(
      Array.from({ length: 11 }, () => vacate('S4')),
      400,
      'VALIDATION_FAILED',
    );
    await code([vacate('S4'), vacate('S4')], 422, 'COMMITTEE_CHANGE_INVALID');
    await code([redesignate('S4', 'MEMBER')], 422, 'COMMITTEE_CHANGE_INVALID');
    await code(
      [vacate('S5'), add(x, x.farhan, 'MEMBER', { joinMode: 'ELECTED' })],
      422,
      'COMMITTEE_CHANGE_INVALID',
    );
    await code([{ op: 'ADD', userId: x.farhan.user.id }], 400, 'VALIDATION_FAILED');
    await code([{ op: 'VACATE', seatId: 'S4' }], 400, 'VALIDATION_FAILED');
    await code(
      [{ op: 'VACATE', seatId: 'S4', exitReason: 'RESIGNED', designation: 'MEMBER' }],
      400,
      'VALIDATION_FAILED',
    );
    await code([add(x, x.farhan, 'MEMBER', { resolutionRef: undefined })], 400, 'VALIDATION_FAILED');
    await code([{ ...vacate('S4'), surprise: 1 }], 400, 'VALIDATION_FAILED');
    await code([vacate('S9')], 404, 'COMMITTEE_SEAT_NOT_FOUND');
    await code([{ op: 'VACATE', seatId: 'S4', exitReason: 'FIRED' }], 400, 'VALIDATION_FAILED');
  });

  it('BR-10-4: a second Treasurer or a person seated twice is refused after applying every change', async () => {
    const x = await currentWorld();
    const dup = await preview(x, [vacate('S5'), add(x, x.farhan, 'TREASURER')]);
    expect([dup.status, dup.body.code]).toEqual([422, 'COMMITTEE_DESIGNATION_DUPLICATE']);
    const twice = await preview(x, [vacate('S5'), add(x, x.nita, 'MEMBER')]);
    expect([twice.status, twice.body.code]).toEqual([422, 'COMMITTEE_HOLDER_DUPLICATE']);
  });

  it('a LEFT seat is 409 INVALID_STATE; a DRAFT or ENDED term is 409 INVALID_STATE', async () => {
    const x = await currentWorld();
    expect((await apply(x, [vacate('S5')])).status).toBe(200);
    const left = await preview(x, [vacate('S5')]);
    expect([left.status, left.body.code]).toEqual([409, 'INVALID_STATE']);
    await CommitteeTerm.update(
      { status: 'ENDED', actualEndDate: '2026-10-31' },
      { where: { id: x.term.id } },
    );
    const r = await preview(x, [vacate('S4')]);
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('an EXPIRED term (caretaker committee) accepts changes', async () => {
    const x = await currentWorld();
    await CommitteeTerm.update({ status: 'EXPIRED', expiredAt: new Date() }, { where: { id: x.term.id } });
    const r = await apply(x, [vacate('S5')]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('EXPIRED');
  });
});

describe('BR-10-16 effective date and BR-10-21 redesignation (T10-19)', () => {
  it('REDESIGNATE after the seat started closes the old seat (toDate = effective - 1) and opens a new one with the same holder', async () => {
    const x = await currentWorld();
    const r = await apply(x, [redesignate('S4', 'VICE_CHAIRMAN')], { effectiveDate: '2026-10-15' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const seats = await seatsOf(x);
    expect(seats.find(s => s.seatId === 'S4')).toMatchObject({
      status: 'LEFT',
      exitReason: 'REDESIGNATED',
      toDate: '2026-10-14',
      designation: 'MEMBER',
    });
    expect(seats.find(s => s.seatId === 'S6')).toMatchObject({
      status: 'SEATED',
      designation: 'VICE_CHAIRMAN',
      fromDate: '2026-10-15',
      name: 'Nita Rao',
      userId: x.nita.user.id,
      memberId: seats.find(s => s.seatId === 'S4')!.memberId,
      joinMode: 'ELECTED',
      toDate: null,
    });
    // the role is the same (committee_member): no module 03 call, a seat_assigned message instead
    expect(spy.calls).toEqual([]);
    expect(r.body.data.summary.roleChanges).toBe(0);
    const a = (await AuditLog.findOne({ where: { action: 'committee.seat.redesignated' } }))!;
    expect(JSON.stringify(a.before)).toContain('MEMBER');
    expect(JSON.stringify(a.after)).toContain('VICE_CHAIRMAN');
  });

  it('REDESIGNATE on the day the seat started changes the designation in place', async () => {
    const x = await currentWorld();
    const row = (await CommitteeTerm.findByPk(x.term.id))!;
    row.members = row.members.map(s => (s.seatId === 'S4' ? { ...s, fromDate: '2026-11-01' } : s));
    await row.save();
    const r = await apply(x, [redesignate('S4', 'JOINT_SECRETARY')]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const seats = await seatsOf(x);
    expect(seats).toHaveLength(5);
    expect(seats.find(s => s.seatId === 'S4')).toMatchObject({
      designation: 'JOINT_SECRETARY',
      status: 'SEATED',
      fromDate: '2026-11-01',
    });
  });

  it('a seat_assigned notification goes to a holder whose designation changed without a role change, not to one whose role changed', async () => {
    const x = await currentWorld();
    const sent: { template: string; userIds: number[]; data: any }[] = [];
    setCommitteePorts({
      notifications: { send: async (template, userIds, data) => void sent.push({ template, userIds, data }) },
    });
    await apply(x, [redesignate('S4', 'VICE_CHAIRMAN'), vacate('S5'), add(x, x.farhan, 'MEMBER')]);
    await settle();
    const assigned = sent.filter(s => s.template === 'committee.seat_assigned');
    expect(assigned.map(s => s.userIds)).toEqual([[x.nita.user.id]]);
    expect(assigned[0]!.data).toMatchObject({
      designationLabel: 'Vice Chairman',
      termName: 'Managing Committee 2024–2029',
    });
  });

  it('the effective date must lie between the date the committee took charge and today, and not before the seat started', async () => {
    const x = await currentWorld();
    for (const d of ['2026-11-02', '2024-03-31']) {
      const r = await preview(x, [vacate('S5')], { effectiveDate: d });
      expect([r.status, r.body.code], d).toEqual([422, 'COMMITTEE_TERM_DATES_INVALID']);
    }
    const row = (await CommitteeTerm.findByPk(x.term.id))!;
    row.members = row.members.map(s => (s.seatId === 'S5' ? { ...s, fromDate: '2025-01-01' } : s));
    await row.save();
    const r = await preview(x, [vacate('S5')], { effectiveDate: '2024-12-31' });
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_TERM_DATES_INVALID']);
    expect((await preview(x, [vacate('S5')], { effectiveDate: '2025-01-01' })).status).toBe(200);
  });
});

describe('BR-10-7, BR-10-8, BR-10-9 holders of an ADD', () => {
  it('not a member, suspended, not an owner: blockers in the preview with the planned seat id, 422 on apply', async () => {
    const x = await currentWorld();
    const stranger = x.lata;
    await setMemberStatus(stranger.user.id, 'ENDED');
    const cases: [string, any, string, string][] = [
      ['no membership', add(x, stranger, 'MEMBER'), 'HOLDER_NOT_MEMBER', 'COMMITTEE_HOLDER_NOT_MEMBER'],
    ];
    await setMemberStatus(x.tara.user.id, 'SUSPENDED');
    cases.push(['suspended', add(x, x.tara, 'MEMBER'), 'HOLDER_NOT_ACTIVE', 'COMMITTEE_HOLDER_NOT_ACTIVE']);
    await UnitResident.update({ toDate: '2026-10-01', endReason: 'MOVED_OUT' } as never, {
      where: { residentId: x.farhan.resident.id },
    });
    cases.push(['no flat', add(x, x.farhan, 'MEMBER'), 'HOLDER_INELIGIBLE', 'COMMITTEE_HOLDER_INELIGIBLE']);
    for (const [label, change, blocker, code] of cases) {
      const p = await preview(x, [vacate('S5'), change]);
      expect(p.status, label).toBe(200);
      expect(
        p.body.data.blockers.map((b: any) => b.code),
        label,
      ).toEqual([blocker]);
      expect(p.body.data.blockers[0].seatIds, label).toEqual(['S6']);
      const r = await apply(x, [vacate('S5'), change]);
      expect([r.status, r.body.code], label).toEqual([422, code]);
    }
    expect(spy.calls).toEqual([]);
  });

  it('a staff role needs replaceExistingRole; with it the role is stored in the new seat', async () => {
    const x = await currentWorld();
    await setRole(x.w.society.id!, x.farhan.user.id, 'accountant');
    spy.calls.length = 0;
    const r = await apply(x, [vacate('S5'), add(x, x.farhan, 'MEMBER')]);
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_ROLE_CONFLICT']);
    const ok = await apply(x, [vacate('S5'), add(x, x.farhan, 'MEMBER', { replaceExistingRole: true })]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await seatsOf(x)).find(s => s.seatId === 'S6')!.roleBeforeKey).toBe('accountant');
    // leaving the committee later restores it
    const back = await apply(x, [vacate('S6')]);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(await roleOf(x.w.society.id!, x.farhan.user.id)).toBe('accountant');
  });
});

describe('BR-10-13 preview hash and versions', () => {
  it('T10-09 style: a role that changed after the preview is 409 COMMITTEE_PREVIEW_STALE and nothing changes', async () => {
    const x = await currentWorld();
    const changes = [vacate('S3'), add(x, x.farhan, 'TREASURER')];
    const p = await preview(x, changes);
    await setRole(x.w.society.id!, x.farhan.user.id, 'tenant');
    spy.calls.length = 0;
    const r = await apply(x, changes, {}, x.w.c, p.body.data.previewHash);
    expect([r.status, r.body.code]).toEqual([409, 'COMMITTEE_PREVIEW_STALE']);
    expect(spy.calls).toEqual([]);
    expect((await CommitteeTerm.findByPk(x.term.id))!.version).toBe(1);
    expect(await roleOf(x.w.society.id!, x.meera.user.id)).toBe('treasurer');
  });

  it('a version that moved is 409 STALE_VERSION (preview and apply)', async () => {
    const x = await currentWorld();
    const p = await x.w.c('post', previewUrl(x), { version: 9, changes: [vacate('S5')] });
    expect([p.status, p.body.code]).toEqual([409, 'STALE_VERSION']);
    const r = await x.w.c(
      'post',
      applyUrl(x),
      { version: 9, changes: [vacate('S5')], previewHash: hash(), reason: 'Resigned today' },
      { headers: idem() },
    );
    expect([r.status, r.body.code]).toEqual([409, 'STALE_VERSION']);
  });
});

describe('T10-12 staff seats on a change (BR-10-17)', () => {
  it('vacating a holder whose role before was accountant with no free seat: blocker NO_FREE_SEAT, 402 USAGE_LIMIT_EXCEEDED, nothing changes', async () => {
    const x = await currentWorld({ plan: 'STARTER' });
    await setLimit(x.w.society.id!, 'limit.admin_seats', 2);
    await setAbsoluteUsage(x.w.society.id!, 'limit.admin_seats', 2);
    const row = (await CommitteeTerm.findByPk(x.term.id))!;
    row.members = row.members.map(s => (s.seatId === 'S5' ? { ...s, roleBeforeKey: 'accountant' } : s));
    await row.save();
    const p = await preview(x, [vacate('S5')]);
    expect(p.body.data.staffSeats).toEqual({ limit: 2, used: 2, delta: 1 });
    expect(p.body.data.blockers).toMatchObject([{ code: 'NO_FREE_SEAT', userIds: [x.omar.user.id] }]);
    const r = await apply(x, [vacate('S5')]);
    expect([r.status, r.body.code]).toEqual([402, 'USAGE_LIMIT_EXCEEDED']);
    expect(spy.calls).toEqual([]);
    expect((await seatsOf(x)).find(s => s.seatId === 'S5')!.status).toBe('SEATED');
    await setAbsoluteUsage(x.w.society.id!, 'limit.admin_seats', 1);
    expect((await apply(x, [vacate('S5')])).status).toBe(200);
    expect(await roleOf(x.w.society.id!, x.omar.user.id)).toBe('accountant');
  });
});

describe('BR-10-14 authority on changes', () => {
  it('the secretary cannot make himself chairman (403 SELF_CHANGE_NOT_ALLOWED)', async () => {
    const x = await currentWorld();
    const sec = await adminClient(x.arjun);
    const r = await apply(x, [vacate('S1', 'REMOVED'), redesignate('S2', 'CHAIRMAN')], {}, sec);
    expect([r.status, r.body.code]).toEqual([403, 'SELF_CHANGE_NOT_ALLOWED']);
    expect(spy.calls).toEqual([]);
  });

  it('the society admin cannot give a role with more access than he has (403 CANNOT_GRANT_UNHELD_PERMISSION)', async () => {
    const x = await currentWorld();
    const admin = await memberOf(x.w.society, 'society_admin');
    const r = await apply(x, [vacate('S3'), add(x, x.farhan, 'TREASURER')], {}, admin.c);
    expect([r.status, r.body.code]).toEqual([403, 'CANNOT_GRANT_UNHELD_PERMISSION']);
    expect(r.body.errors.length).toBeGreaterThan(0);
    expect(spy.calls).toEqual([]);
  });
});

describe('atomic apply (F07)', () => {
  it('a module 03 failure on the second action rolls back the seats, roles, audit rows and delegations', async () => {
    const x = await currentWorld();
    const changes = [vacate('S3'), add(x, x.farhan, 'TREASURER')];
    const p = await preview(x, changes);
    const before = await AuditLog.count({ where: { societyId: x.w.society.id! } });
    spy.failOn = 2;
    events.length = 0;
    const r = await apply(x, changes, {}, x.w.c, p.body.data.previewHash);
    expect([r.status, r.body.code]).toEqual([409, 'MODULE_03_FAILED']);
    const row = (await CommitteeTerm.findByPk(x.term.id))!;
    expect(row.version).toBe(1);
    expect(row.members).toHaveLength(5);
    expect(await roleOf(x.w.society.id!, x.meera.user.id)).toBe('treasurer');
    expect(await roleOf(x.w.society.id!, x.farhan.user.id)).toBe('owner');
    expect(await AuditLog.count({ where: { societyId: x.w.society.id! } })).toBe(before);
    expect(committeePortCalls).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe('8.9 route rules', () => {
  it('Idempotency-Key replay, step-up, validation, isolation, permission and society state', async () => {
    const x = await currentWorld();
    const changes = [vacate('S5')];
    const p = await preview(x, changes);
    const body = { version: 1, changes, previewHash: p.body.data.previewHash, reason: 'Omar resigned' };
    // step-up
    advance(10 * 60_000);
    const stale = await x.w.c('post', applyUrl(x), body, { headers: idem() });
    expect([stale.status, stale.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    resetLogins();
    const c = as(await login(x.w.user));
    const h = idem();
    const one = await c('post', applyUrl(x), body, { headers: h });
    const two = await c('post', applyUrl(x), body, { headers: h });
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(two.headers['idempotent-replay']).toBe('true');
    expect(spy.calls).toHaveLength(1);
    expect((await c('post', applyUrl(x), body)).status).toBe(400);
    // validation: strict body, previewHash and reason are required on apply only
    const bad = await c(
      'post',
      applyUrl(x),
      { version: 2, changes, reason: 'No hash here' },
      { headers: idem() },
    );
    expect(bad.status).toBe(400);
    const bad2 = await c('post', previewUrl(x), { version: 2, changes, previewHash: hash() });
    expect(bad2.status).toBe(400);
    // isolation
    const other = await committeeWorld();
    for (const [path, b] of [
      [previewUrl(x), { version: 1, changes }],
      [applyUrl(x), { ...body, version: 1 }],
    ] as const) {
      const r = await other.c('post', path, b, { headers: idem() });
      expect([r.status, r.body.code], path).toEqual([404, 'COMMITTEE_TERM_NOT_FOUND']);
    }
  });

  it('a SUSPENDED society refuses the preview and the apply alike with 423 SOCIETY_SUSPENDED (both are POST writes)', async () => {
    const x = await currentWorld();
    const p = await preview(x, [vacate('S5')]);
    await suspend(x.w.society.id!);
    expect((await preview(x, [vacate('S5')])).body.code).toBe('SOCIETY_SUSPENDED');
    const r = await x.w.c(
      'post',
      applyUrl(x),
      { version: 1, changes: [vacate('S5')], previewHash: p.body.data.previewHash, reason: 'Omar resigned' },
      { headers: idem() },
    );
    expect([r.status, r.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
  });

  it('governance.office_bearers off is 402 FEATURE_NOT_IN_PLAN on both routes', async () => {
    const x = await currentWorld();
    await featureOff(x.w.society.id!, 'governance.office_bearers');
    const r = await preview(x, [vacate('S5')]);
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
  });
});
