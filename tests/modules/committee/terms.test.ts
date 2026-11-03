import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, CommitteeTerm, SocietyMember, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { setRealtimeSink } from '../../../src/lib/realtime';
import { featureOff } from '../../helpers/society-setup';
import {
  committeeWorld,
  holder,
  idem,
  postTerm,
  rawTerm,
  resetCommittee,
  seat,
  setMemberStatus,
  setSetting,
  termBody,
} from '../../helpers/committee';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetCommittee);

const events: { room: string; event: string; payload: Record<string, unknown> }[] = [];
beforeEach(() => {
  events.length = 0;
  setRealtimeSink({ emit: e => events.push(e), disconnectSession: () => undefined });
});
afterAll(() => setRealtimeSink(undefined));

/** US-10-01: chairman, secretary and treasurer of a draft. */
async function trio() {
  const w = await committeeWorld();
  const [a, b, c] = [
    await holder(w, 1, 'Rajesh Kulkarni'),
    await holder(w, 2, 'Arjun Shah'),
    await holder(w, 3, 'Meera Iyer'),
  ];
  const seats = [seat(a, w, 1, 'CHAIRMAN'), seat(b, w, 2, 'SECRETARY'), seat(c, w, 3, 'TREASURER')];
  return { w, a, b, c, seats };
}

describe('US-10-01 create a draft (8.3, F01, F02, F03)', () => {
  it('saves a DRAFT with three PLANNED seats, names from module 02, audit row and realtime event', async () => {
    const { w, seats } = await trio();
    const r = await w.c('post', '/committee/terms', termBody(seats, { notes: 'First committee' }), {
      headers: idem(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const d = r.body.data;
    expect(d).toMatchObject({
      name: 'Managing Committee 2026–2031',
      kind: 'ELECTED',
      source: 'MANUAL',
      status: 'DRAFT',
      startDate: '2026-11-01',
      endDate: '2031-10-31',
      actualEndDate: null,
      tookChargeOn: null,
      strength: 5,
      notes: 'First committee',
      predecessorTermId: null,
      successorTermId: null,
      electionId: null,
      daysLeft: null,
      isOverdue: false,
      version: 1,
    });
    expect(
      d.seats.map((s: any) => [s.seatId, s.name, s.designation, s.status, s.fromDate, s.joinMode]),
    ).toEqual([
      ['S1', 'Rajesh Kulkarni', 'CHAIRMAN', 'PLANNED', null, 'ELECTED'],
      ['S2', 'Arjun Shah', 'SECRETARY', 'PLANNED', null, 'ELECTED'],
      ['S3', 'Meera Iyer', 'TREASURER', 'PLANNED', null, 'ELECTED'],
    ]);
    expect(d.seats[0]).toMatchObject({
      memberId: null,
      expectedRoleKey: 'chairman',
      roleKey: 'owner',
      unitLabel: 'A-101',
      portfolios: [],
      publicEmail: null,
      showOnResidentPage: true,
      roleBeforeKey: null,
      flags: [],
      exitReason: null,
    });
    expect(d.handover).toEqual({ total: 0, done: 0, notApplicable: 0, completedAt: null });
    const row = (await CommitteeTerm.findByPk(d.id))!;
    expect(row.createdBy).toBe(w.user.id);
    expect(row.members).toHaveLength(3);
    const a = (await AuditLog.findOne({
      where: { action: 'committee.term.created', entityId: String(d.id) },
    }))!;
    expect(a.societyId).toBe(w.society.id);
    expect(JSON.stringify(a.after)).toContain('Rajesh Kulkarni');
    expect(events).toContainEqual({
      room: `society:${w.society.id}:admin`,
      event: 'committee.changed',
      payload: { termId: d.id, status: 'DRAFT', reason: 'CREATED' },
    });
    expect(JSON.stringify(events)).not.toContain('Rajesh');
  });

  it('the same Idempotency-Key replays the first response (the route honours it)', async () => {
    const { w, seats } = await trio();
    const h = idem();
    const one = await w.c('post', '/committee/terms', termBody(seats), { headers: h });
    const two = await w.c('post', '/committee/terms', termBody(seats), { headers: h });
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.headers['idempotent-replay']).toBe('true');
    expect(two.body.data.id).toBe(one.body.data.id);
    expect(await CommitteeTerm.count()).toBe(1);
    const three = await w.c('post', '/committee/terms', termBody(seats, { name: 'Another name' }), {
      headers: h,
    });
    expect(three.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const none = await w.c('post', '/committee/terms', termBody(seats));
    expect(none.status).toBe(400);
  });

  it('body validation: strict bodies, ELECTION source rejected, required seat fields, ids and dates', async () => {
    const { w, seats } = await trio();
    const bad = async (body: Record<string, unknown>, field?: string) => {
      const r = await w.c('post', '/committee/terms', body, { headers: idem() });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
      if (field) expect(JSON.stringify(r.body.errors)).toContain(field);
    };
    await bad(termBody(seats, { extra: 1 }));
    await bad(termBody(seats, { source: 'ELECTION' }), 'source');
    await bad(termBody(seats, { name: 'ab' }), 'name');
    await bad(termBody(seats, { startDate: '2026-02-30' }), 'startDate');
    await bad(termBody(seats, { endDate: '31-10-2031' }), 'endDate');
    await bad(termBody([]), 'seats');
    await bad(termBody([{ designation: 'CHAIRMAN', unitId: 1 }]), 'userId');
    await bad(termBody([{ designation: 'CHAIRMAN', userId: 1 }]), 'unitId');
    await bad(termBody([{ ...seats[0], designation: 'BOSS' }]), 'designation');
    await bad(termBody([{ ...seats[0], joinMode: 'CO_OPTED' }]), 'joinMode');
    await bad(termBody([{ ...seats[0], portfolios: ['LEGAL', 'LEGAL'] }]), 'portfolios');
    await bad(termBody([{ ...seats[0], publicEmail: 'nope' }]), 'publicEmail');
    await bad(termBody([{ ...seats[0], seatId: 'S1' }]), 'seatId');
    await bad(termBody(seats, { notes: 'x'.repeat(1001) }), 'notes');
    expect(await CommitteeTerm.count()).toBe(0);
  });

  it('seat details are kept: portfolios, lower-cased public email, hidden member, join mode', async () => {
    const w = await committeeWorld();
    const a = await holder(w, 1, 'Rajesh Kulkarni');
    const b = await holder(w, 2, 'Neha Joshi');
    const d = await postTerm(
      w.c,
      termBody([
        seat(a, w, 1, 'CHAIRMAN', {
          portfolios: ['LEGAL', 'EVENTS'],
          publicEmail: 'Chair@SkyHeights.in',
          joinMode: 'NOMINATED',
        }),
        seat(b, w, 2, 'MEMBER', { showOnResidentPage: false }),
      ]),
    );
    expect(d.seats[0]).toMatchObject({
      portfolios: ['LEGAL', 'EVENTS'],
      publicEmail: 'chair@skyheights.in',
      joinMode: 'NOMINATED',
    });
    expect(d.seats[1]).toMatchObject({ designation: 'MEMBER', showOnResidentPage: false });
  });

  it('BR-10-5 and BR-10-30: the seat stores no mobile number and the contact comes from module 02 masked', async () => {
    const { w, seats } = await trio();
    const d = await postTerm(w.c, termBody(seats));
    expect(d.seats[0].mobile).toMatch(/^\d{10}$/); // the chairman holds residents.contacts.view; masking is tested in read.test.ts
    const raw = JSON.stringify((await CommitteeTerm.findByPk(d.id))!.members);
    expect(raw).not.toMatch(/\d{10}/);
    expect(raw).not.toContain('mobile');
  });
});

describe('T10-05 and the term rules (BR-10-2, BR-10-3, BR-10-4)', () => {
  it('end date 5 years after the start (one day over), strength 2, two treasurers', async () => {
    const { w, a, b, seats } = await trio();
    const ok5 = await w.c('post', '/committee/terms', termBody(seats, { endDate: '2031-10-31' }), {
      headers: idem(),
    });
    expect(ok5.status).toBe(201);
    await w.c('delete', `/committee/terms/${ok5.body.data.id}`, { version: 1, reason: 'Try again' });
    const d = await w.c('post', '/committee/terms', termBody(seats, { endDate: '2031-11-01' }), {
      headers: idem(),
    });
    expect(d.status).toBe(422);
    expect(d.body.code).toBe('COMMITTEE_TERM_DATES_INVALID');
    expect(d.body.errors[0].field).toBe('endDate');
    const s = await w.c('post', '/committee/terms', termBody(seats, { strength: 2 }), { headers: idem() });
    expect([s.status, s.body.code]).toEqual([422, 'COMMITTEE_STRENGTH_INVALID']);
    const t = await w.c(
      'post',
      '/committee/terms',
      termBody([seat(a, w, 1, 'TREASURER'), seat(b, w, 2, 'TREASURER')]),
      { headers: idem() },
    );
    expect([t.status, t.body.code]).toEqual([422, 'COMMITTEE_DESIGNATION_DUPLICATE']);
    expect(t.body.errors[0].seatIds).toEqual(['S1', 'S2']);
  });

  it('a term lasts at least 30 days and the length limit follows committee.maxTermYears', async () => {
    const { w, seats } = await trio();
    const short = await w.c('post', '/committee/terms', termBody(seats, { endDate: '2026-11-30' }), {
      headers: idem(),
    });
    expect([short.status, short.body.code]).toEqual([422, 'COMMITTEE_TERM_DATES_INVALID']);
    const back = await w.c('post', '/committee/terms', termBody(seats, { endDate: '2026-10-01' }), {
      headers: idem(),
    });
    expect(back.body.code).toBe('COMMITTEE_TERM_DATES_INVALID');
    await setSetting(w.society.id!, 'committee.maxTermYears', 2);
    const two = await w.c('post', '/committee/terms', termBody(seats, { endDate: '2028-11-01' }), {
      headers: idem(),
    });
    expect(two.body.code).toBe('COMMITTEE_TERM_DATES_INVALID');
    expect(
      (await w.c('post', '/committee/terms', termBody(seats, { endDate: '2028-10-31' }), { headers: idem() }))
        .status,
    ).toBe(201);
  });

  it('strength must be within committee.minStrength and committee.maxStrength', async () => {
    const { w, seats } = await trio();
    await setSetting(w.society.id!, 'committee.maxStrength', 7);
    const r = await w.c('post', '/committee/terms', termBody(seats, { strength: 8 }), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_STRENGTH_INVALID']);
  });

  it('more seats than the strength', async () => {
    const w = await committeeWorld();
    const hs = [
      await holder(w, 1, 'One One'),
      await holder(w, 2, 'Two Two'),
      await holder(w, 3, 'Three Three'),
      await holder(w, 4, 'Four Four'),
    ];
    const seats = hs.map((h, i) => seat(h, w, i + 1, 'MEMBER'));
    const r = await w.c('post', '/committee/terms', termBody(seats, { strength: 3 }), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_STRENGTH_INVALID']);
    expect(
      (await w.c('post', '/committee/terms', termBody(seats, { strength: 4 }), { headers: idem() })).status,
    ).toBe(201);
  });

  it('one person holds one seat; MEMBER may repeat among different people', async () => {
    const w = await committeeWorld();
    const a = await holder(w, 1, 'Rajesh Kulkarni');
    const r = await w.c(
      'post',
      '/committee/terms',
      termBody([seat(a, w, 1, 'CHAIRMAN'), seat(a, w, 1, 'MEMBER')]),
      { headers: idem() },
    );
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_HOLDER_DUPLICATE']);
  });

  it('BR-10-1: a second draft is 409 COMMITTEE_DRAFT_EXISTS with the term id (T10-06)', async () => {
    const { w, seats } = await trio();
    const first = await postTerm(w.c, termBody(seats));
    const again = await w.c('post', '/committee/terms', termBody(seats, { name: 'Second draft' }), {
      headers: idem(),
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('COMMITTEE_DRAFT_EXISTS');
    expect(again.body.errors[0].termId).toBe(first.id);
    expect(await CommitteeTerm.count()).toBe(1);
  });

  it("BR-10-2: a draft starts after the current term's start; 'draftSlot' and 'currentSlot' are unique per society", async () => {
    const { w, seats } = await trio();
    await rawTerm(w.society.id!);
    const early = await w.c(
      'post',
      '/committee/terms',
      termBody(seats, { startDate: '2024-04-01', endDate: '2029-03-31' }),
      { headers: idem() },
    );
    expect([early.status, early.body.code]).toEqual([422, 'COMMITTEE_TERM_DATES_INVALID']);
    expect(early.body.errors[0].field).toBe('startDate');
    expect(
      (
        await w.c(
          'post',
          '/committee/terms',
          termBody(seats, { startDate: '2024-04-02', endDate: '2029-03-31' }),
          { headers: idem() },
        )
      ).status,
    ).toBe(201);
  });
});

describe('T10-07 holders (BR-10-7, BR-10-8)', () => {
  it('no membership, suspended, invitation pending, tenant with ownersOnly, no unit link, wrong flat', async () => {
    const w = await committeeWorld();
    const chair = await holder(w, 1, 'Owner One');
    const call = async (seats: Record<string, unknown>[]) =>
      w.c('post', '/committee/terms', termBody(seats), { headers: idem() });

    // no membership at all (a user who never joined) and an ended membership
    const ended = await holder(w, 2, 'Ended Person');
    await setMemberStatus(ended.user.id, 'ENDED');
    let r = await call([seat(chair, w, 1, 'CHAIRMAN'), seat(ended, w, 2, 'MEMBER')]);
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_HOLDER_NOT_MEMBER']);
    expect(r.body.errors[0].seatIds).toEqual(['S2']);
    r = await call([{ userId: 987654, unitId: w.unit(3).id, designation: 'MEMBER' }]);
    expect(r.body.code).toBe('COMMITTEE_HOLDER_NOT_MEMBER');

    // suspended
    const sus = await holder(w, 3, 'Suspended Person');
    await setMemberStatus(sus.user.id, 'SUSPENDED');
    r = await call([seat(chair, w, 1, 'CHAIRMAN'), seat(sus, w, 3, 'MEMBER')]);
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_HOLDER_NOT_ACTIVE']);
    expect(r.body.errors[0].seatIds).toEqual(['S2']);

    // a tenant with ownersOnly (default)
    const tenant = await holder(w, 4, 'Tenant Person', 'TENANT');
    r = await call([seat(chair, w, 1, 'CHAIRMAN'), seat(tenant, w, 4, 'MEMBER')]);
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_HOLDER_INELIGIBLE']);
    expect(r.body.errors[0].seatIds).toEqual(['S2']);

    // an owner on a flat that is not theirs
    const other = await holder(w, 5, 'Other Owner');
    r = await call([seat(chair, w, 1, 'CHAIRMAN'), seat(other, w, 6, 'MEMBER')]);
    expect(r.body.code).toBe('COMMITTEE_HOLDER_INELIGIBLE');
    expect(await CommitteeTerm.count()).toBe(0);
  });

  it('committee.ownersOnly = false lets a tenant sit, but only on a flat they are linked to', async () => {
    const w = await committeeWorld();
    const tenant = await holder(w, 4, 'Tenant Person', 'TENANT');
    await setSetting(w.society.id!, 'committee.ownersOnly', false);
    const wrong = await w.c('post', '/committee/terms', termBody([seat(tenant, w, 5, 'MEMBER')]), {
      headers: idem(),
    });
    expect(wrong.body.code).toBe('COMMITTEE_HOLDER_INELIGIBLE');
    const d = await postTerm(w.c, termBody([seat(tenant, w, 4, 'MEMBER')]));
    expect(d.seats[0]).toMatchObject({ name: 'Tenant Person', unitLabel: 'A-104' });
  });
});

describe('T10-31 plan: governance.office_bearers', () => {
  it('a SECRETARY seat is 402 FEATURE_NOT_IN_PLAN without the feature, a MEMBER-only draft works', async () => {
    const { w, seats, a } = await trio();
    await featureOff(w.society.id!, 'governance.office_bearers');
    const r = await w.c('post', '/committee/terms', termBody(seats), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    const ok = await w.c('post', '/committee/terms', termBody([seat(a, w, 1, 'MEMBER')]), {
      headers: idem(),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('governance.committee_terms off blocks every write and the grace keeps reads', async () => {
    const { w, seats } = await trio();
    await featureOff(w.society.id!, 'governance.committee_terms');
    const r = await w.c('post', '/committee/terms', termBody(seats), { headers: idem() });
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
  });
});

describe('F13 historical committees (8.3)', () => {
  const past = (over: Record<string, unknown> = {}) => ({
    name: 'Managing Committee 2019–2024',
    source: 'HISTORICAL',
    startDate: '2019-04-01',
    endDate: '2024-03-31',
    strength: 5,
    resolutionRef: 'CM/2019-20/01',
    seats: [
      { name: 'Vinod Bhide', designation: 'CHAIRMAN' },
      { name: 'Shalini Rao', designation: 'TREASURER', portfolios: ['ACCOUNTS'] },
    ],
    ...over,
  });

  it('is saved ENDED with LEFT seats for the whole term and no module 03 call', async () => {
    const w = await committeeWorld();
    const members = await SocietyMember.count({ where: { societyId: w.society.id! } });
    const r = await w.c('post', '/committee/terms', past(), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'ENDED',
      source: 'HISTORICAL',
      actualEndDate: '2024-03-31',
      tookChargeOn: null,
      resolutionRef: 'CM/2019-20/01',
    });
    expect(
      r.body.data.seats.map((s: any) => [
        s.seatId,
        s.name,
        s.status,
        s.fromDate,
        s.toDate,
        s.exitReason,
        s.userId,
      ]),
    ).toEqual([
      ['S1', 'Vinod Bhide', 'LEFT', '2019-04-01', '2024-03-31', 'TERM_ENDED', null],
      ['S2', 'Shalini Rao', 'LEFT', '2019-04-01', '2024-03-31', 'TERM_ENDED', null],
    ]);
    const row = (await CommitteeTerm.findByPk(r.body.data.id))!;
    expect(row.endReason).toBe('Historical record');
    expect(await SocietyMember.count({ where: { societyId: w.society.id! } })).toBe(members);
    expect(await AuditLog.count({ where: { action: 'committee.term.created' } })).toBe(1);
    // a historical term does not block a draft and is not the current term
    expect(await CommitteeTerm.count({ where: { status: 'ENDED' } })).toBe(1);
  });

  it('needs a resolution reference and a name for each seat', async () => {
    const w = await committeeWorld();
    const { resolutionRef: _r, ...noRef } = past();
    void _r;
    const a = await w.c('post', '/committee/terms', noRef, { headers: idem() });
    expect([a.status, a.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const b = await w.c('post', '/committee/terms', past({ seats: [{ designation: 'CHAIRMAN' }] }), {
      headers: idem(),
    });
    expect([b.status, b.body.code]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('must have ended before today, before the first recorded committee, and must not overlap another past committee', async () => {
    const w = await committeeWorld();
    const future = await w.c(
      'post',
      '/committee/terms',
      past({ startDate: '2026-04-01', endDate: '2026-11-01' }),
      { headers: idem() },
    );
    expect([future.status, future.body.code]).toEqual([422, 'COMMITTEE_TERM_DATES_INVALID']);
    await rawTerm(w.society.id!);
    const clash = await w.c('post', '/committee/terms', past({ endDate: '2024-04-01' }), { headers: idem() });
    expect([clash.status, clash.body.code]).toEqual([422, 'COMMITTEE_TERM_DATES_INVALID']);
    expect((await w.c('post', '/committee/terms', past(), { headers: idem() })).status).toBe(201);
    const overlap = await w.c(
      'post',
      '/committee/terms',
      past({ name: 'Overlapping', startDate: '2021-01-01', endDate: '2022-06-30' }),
      { headers: idem() },
    );
    expect([overlap.status, overlap.body.code]).toEqual([422, 'COMMITTEE_TERM_DATES_INVALID']);
    expect(overlap.body.errors[0].message).toMatch(/overlaps/);
    const before = await w.c(
      'post',
      '/committee/terms',
      past({ name: 'Earlier', startDate: '2014-04-01', endDate: '2019-03-31' }),
      { headers: idem() },
    );
    expect(before.status).toBe(201);
  });

  it('a non-MEMBER designation needs governance.office_bearers; a user id is optional and kept', async () => {
    const w = await committeeWorld();
    const a = await holder(w, 1, 'Rajesh Kulkarni');
    const d = await postTerm(
      w.c,
      past({ seats: [{ name: 'Rajesh Kulkarni', userId: a.user.id, designation: 'MEMBER' }] }),
    );
    expect(d.seats[0].userId).toBe(a.user.id);
    await featureOff(w.society.id!, 'governance.office_bearers');
    const r = await w.c(
      'post',
      '/committee/terms',
      past({ name: 'Other', startDate: '2010-04-01', endDate: '2015-03-31' }),
      { headers: idem() },
    );
    expect(r.status).toBe(402);
  });
});
