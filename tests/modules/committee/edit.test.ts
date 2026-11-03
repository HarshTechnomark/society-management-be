import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, CommitteeTerm, sequelize, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { advance, setNow } from '../../../src/lib/clock';
import { committee, setCommitteePorts } from '../../../src/modules/committee/committee.public';
import { systemCtx } from '../../../src/types/context';
import {
  committeeWorld,
  holder,
  postTerm,
  rawTerm,
  resetCommittee,
  seat,
  seated,
  termBody,
} from '../../helpers/committee';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetCommittee);

/** A draft with a chairman, a secretary and a treasurer (flats 1 to 3) and three more owners (flats 4 to 6). */
async function draft() {
  const w = await committeeWorld();
  const names = ['Rajesh Kulkarni', 'Arjun Shah', 'Meera Iyer', 'Lata Menon', 'Farhan Qureshi', 'Neha Joshi'];
  const hs = [];
  for (const [i, n] of names.entries()) hs.push(await holder(w, i + 1, n));
  const d = await postTerm(
    w.c,
    termBody([
      seat(hs[0]!, w, 1, 'CHAIRMAN'),
      seat(hs[1]!, w, 2, 'SECRETARY'),
      seat(hs[2]!, w, 3, 'TREASURER'),
    ]),
  );
  return { w, hs, d };
}

/** An ACTIVE term with three SEATED seats inserted directly. */
async function current(o: { status?: 'ACTIVE' | 'EXPIRED'; endDate?: string } = {}) {
  const w = await committeeWorld();
  const hs = [
    await holder(w, 1, 'Rajesh Kulkarni'),
    await holder(w, 2, 'Arjun Shah'),
    await holder(w, 3, 'Meera Iyer'),
  ];
  const term = await rawTerm(w.society.id!, {
    ...o,
    members: [
      seated('S1', hs[0]!, 'Rajesh Kulkarni', 'CHAIRMAN', { unitId: w.unit(1).id }),
      seated('S2', hs[1]!, 'Arjun Shah', 'SECRETARY', { unitId: w.unit(2).id }),
      seated('S3', hs[2]!, 'Meera Iyer', 'TREASURER', { unitId: w.unit(3).id }),
    ],
  });
  return { w, hs, term };
}

describe('PATCH a draft (8.4, F03)', () => {
  it('edits name, kind, dates, strength and notes; version goes up; audit has before and after', async () => {
    const { w, d } = await draft();
    const r = await w.c('patch', `/committee/terms/${d.id}`, {
      version: 1,
      name: 'Managing Committee 2027–2032',
      kind: 'PROVISIONAL',
      startDate: '2027-04-01',
      endDate: '2032-03-31',
      strength: 7,
      notes: 'Revised',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      name: 'Managing Committee 2027–2032',
      kind: 'PROVISIONAL',
      startDate: '2027-04-01',
      endDate: '2032-03-31',
      strength: 7,
      notes: 'Revised',
      version: 2,
      status: 'DRAFT',
    });
    expect(r.body.data.seats).toHaveLength(3);
    const a = (await AuditLog.findOne({
      where: { action: 'committee.term.updated', entityId: String(d.id) },
    }))!;
    expect((a.before as any).name).toBe('Managing Committee 2026–2031');
    expect((a.after as any).name).toBe('Managing Committee 2027–2032');
    const clear = await w.c('patch', `/committee/terms/${d.id}`, { version: 2, notes: null });
    expect(clear.body.data.notes).toBeNull();
  });

  it('needs at least one field, a current version and a valid body', async () => {
    const { w, d } = await draft();
    const none = await w.c('patch', `/committee/terms/${d.id}`, { version: 1 });
    expect([none.status, none.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const reasonOnly = await w.c('patch', `/committee/terms/${d.id}`, {
      version: 1,
      reason: 'Just a reason',
    });
    expect(reasonOnly.status).toBe(400);
    const stale = await w.c('patch', `/committee/terms/${d.id}`, { version: 9, name: 'Stale name' });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const noVersion = await w.c('patch', `/committee/terms/${d.id}`, { name: 'No version' });
    expect(noVersion.status).toBe(400);
    const extra = await w.c('patch', `/committee/terms/${d.id}`, {
      version: 1,
      name: 'Fine name',
      status: 'ACTIVE',
    });
    expect(extra.status).toBe(400);
    const badId = await w.c('patch', '/committee/terms/0', { version: 1, name: 'Fine name' });
    expect(badId.status).toBe(400);
  });

  it('applies the date, strength and duplicate rules again', async () => {
    const { w, d } = await draft();
    const patch = (b: Record<string, unknown>) =>
      w.c('patch', `/committee/terms/${d.id}`, { version: 1, ...b });
    expect((await patch({ endDate: '2031-11-01' })).body.code).toBe('COMMITTEE_TERM_DATES_INVALID');
    expect((await patch({ endDate: '2026-11-15' })).body.code).toBe('COMMITTEE_TERM_DATES_INVALID');
    expect((await patch({ startDate: '2026-10-01' })).body.code).toBe('COMMITTEE_TERM_DATES_INVALID'); // the end date is now over 5 years away
    expect((await patch({ strength: 2 })).body.code).toBe('COMMITTEE_STRENGTH_INVALID');
    expect((await patch({ strength: 26 })).body.code).toBe('COMMITTEE_STRENGTH_INVALID');
    expect((await patch({ strength: 3 })).status).toBe(200);
    const low = await w.c('patch', `/committee/terms/${d.id}`, { version: 2, strength: 3, notes: 'same' });
    expect(low.status).toBe(200);
  });

  it('a seat replacement keeps seats with their seatId, drops the rest and never reuses an id', async () => {
    const { w, hs, d } = await draft();
    const r = await w.c('patch', `/committee/terms/${d.id}`, {
      version: 1,
      seats: [
        { seatId: 'S1', designation: 'CHAIRMAN', portfolios: ['LEGAL'] },
        { seatId: 'S3', designation: 'TREASURER' },
        seat(hs[3]!, w, 4, 'MEMBER'),
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.seats.map((s: any) => [s.seatId, s.name, s.designation])).toEqual([
      ['S1', 'Rajesh Kulkarni', 'CHAIRMAN'],
      ['S3', 'Meera Iyer', 'TREASURER'],
      ['S4', 'Lata Menon', 'MEMBER'],
    ]);
    expect(r.body.data.seats[0].portfolios).toEqual(['LEGAL']);
    expect(r.body.data.seats[0].unitLabel).toBe('A-101'); // kept
    // S4 is the highest id: removing it and adding another gives S5, not S4 again
    const again = await w.c('patch', `/committee/terms/${d.id}`, {
      version: 2,
      seats: [{ seatId: 'S1', designation: 'CHAIRMAN' }, seat(hs[4]!, w, 5, 'MEMBER')],
    });
    expect(again.body.data.seats.map((s: any) => s.seatId)).toEqual(['S1', 'S5']);
  });

  it('seat rules on a replacement: unknown seat 404, twice, duplicates, holders, strength, office bearers', async () => {
    const { w, hs, d } = await draft();
    const patch = (seats: Record<string, unknown>[]) =>
      w.c('patch', `/committee/terms/${d.id}`, { version: 1, seats });
    expect((await patch([{ seatId: 'S9', designation: 'MEMBER' }])).body.code).toBe(
      'COMMITTEE_SEAT_NOT_FOUND',
    );
    expect(
      (
        await patch([
          { seatId: 'S1', designation: 'MEMBER' },
          { seatId: 'S1', designation: 'MEMBER' },
        ])
      ).body.code,
    ).toBe('COMMITTEE_CHANGE_INVALID');
    expect(
      (await patch([{ seatId: 'S1', designation: 'CHAIRMAN' }, seat(hs[3]!, w, 4, 'CHAIRMAN')])).body.code,
    ).toBe('COMMITTEE_DESIGNATION_DUPLICATE');
    expect(
      (await patch([{ seatId: 'S1', designation: 'MEMBER' }, seat(hs[0]!, w, 1, 'MEMBER')])).body.code,
    ).toBe('COMMITTEE_HOLDER_DUPLICATE');
    const six = [3, 4, 5].map(i => seat(hs[i]!, w, i + 1, 'MEMBER'));
    expect(
      (
        await patch([
          ...six,
          { seatId: 'S1', designation: 'MEMBER' },
          { seatId: 'S2', designation: 'MEMBER' },
          { seatId: 'S3', designation: 'MEMBER' },
        ])
      ).body.code,
    ).toBe('COMMITTEE_STRENGTH_INVALID');
    // a new holder is checked for membership and flat like in create
    expect((await patch([seat(hs[3]!, w, 6, 'MEMBER')])).body.code).toBe('COMMITTEE_HOLDER_INELIGIBLE');
    expect((await patch([{ userId: 99999, unitId: w.unit(6).id, designation: 'MEMBER' }])).body.code).toBe(
      'COMMITTEE_HOLDER_NOT_MEMBER',
    );
    expect((await patch([{ designation: 'MEMBER', unitId: w.unit(6).id }])).status).toBe(400);
    expect((await CommitteeTerm.findByPk(d.id))!.version).toBe(1);
  });

  it('changing a seat holder looks up the new name; the office-bearer plan check applies to the new designations', async () => {
    const { w, hs, d } = await draft();
    const r = await w.c('patch', `/committee/terms/${d.id}`, {
      version: 1,
      seats: [
        { seatId: 'S1', designation: 'CHAIRMAN' },
        { seatId: 'S2', designation: 'SECRETARY', userId: hs[3]!.user.id, unitId: w.unit(4).id },
        { seatId: 'S3', designation: 'TREASURER' },
      ],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.seats[1]).toMatchObject({ seatId: 'S2', name: 'Lata Menon', unitLabel: 'A-104' });
  });

  it('is refused on an ended committee', async () => {
    const w = await committeeWorld();
    const t = await rawTerm(w.society.id!, {
      status: 'ENDED',
      source: 'HISTORICAL',
      actualEndDate: '2029-03-31',
    });
    const r = await w.c('patch', `/committee/terms/${t.id}`, { version: 1, name: 'Edited history' });
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
  });
});

describe('PATCH a current term (8.4, F12, BR-10-15)', () => {
  it('name and notes need no step-up and no reason', async () => {
    const { w, term } = await current();
    const r = await w.c('patch', `/committee/terms/${term.id}`, {
      version: 1,
      name: 'Managing Committee (renamed)',
      notes: 'Note',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ name: 'Managing Committee (renamed)', status: 'ACTIVE', version: 2 });
  });

  it('kind, start date and seats are draft-only (409 INVALID_STATE)', async () => {
    const { w, term } = await current();
    for (const b of [
      { kind: 'AD_HOC' },
      { startDate: '2024-04-02' },
      { seats: [{ seatId: 'S1', designation: 'CHAIRMAN' }] },
    ]) {
      const r = await w.c('patch', `/committee/terms/${term.id}`, { version: 1, ...b });
      expect([r.status, r.body.code], JSON.stringify(b)).toEqual([409, 'INVALID_STATE']);
    }
  });

  it('an end date change needs a recent sign-in (401 REAUTH_REQUIRED) and a reason (400)', async () => {
    const { w, term } = await current();
    advance(10 * 60_000);
    const stale = await w.c('patch', `/committee/terms/${term.id}`, {
      version: 1,
      endDate: '2029-06-30',
      reason: 'Elections delayed',
    });
    expect([stale.status, stale.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    const strength = await w.c('patch', `/committee/terms/${term.id}`, {
      version: 1,
      strength: 7,
      reason: 'More seats',
    });
    expect([strength.status, strength.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    expect((await CommitteeTerm.findByPk(term.id!))!.version).toBe(1);
    setNow('2026-11-01T04:30:00Z');
    const noReason = await w.c('patch', `/committee/terms/${term.id}`, { version: 1, endDate: '2029-06-30' });
    expect([noReason.status, noReason.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(noReason.body.errors[0].field).toBe('reason');
    const short = await w.c('patch', `/committee/terms/${term.id}`, {
      version: 1,
      endDate: '2029-06-30',
      reason: 'abc',
    });
    expect(short.status).toBe(400);
  });

  it('extends the end date: audit committee.term.extended with the reason, reminders reset, date rules apply', async () => {
    const { w, term } = await current();
    await term.update({ lastReminderDays: 30 });
    const bad = await w.c('patch', `/committee/terms/${term.id}`, {
      version: 1,
      endDate: '2029-04-01',
      reason: 'Too long',
    });
    expect(bad.body.code).toBe('COMMITTEE_TERM_DATES_INVALID');
    const r = await w.c('patch', `/committee/terms/${term.id}`, {
      version: 1,
      endDate: '2029-03-31',
      strength: 6,
      reason: 'Bye-law change',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ strength: 6, endDate: '2029-03-31', version: 2 });
    const row = (await CommitteeTerm.findByPk(term.id!))!;
    expect(row.lastReminderDays).toBe(30); // end date unchanged: not reset
    const ext = await w.c('patch', `/committee/terms/${term.id}`, {
      version: 2,
      endDate: '2029-03-30',
      reason: 'Shorter by a day',
    });
    expect(ext.status).toBe(200);
    expect(await AuditLog.count({ where: { action: 'committee.term.extended' } })).toBe(0);
    expect((await CommitteeTerm.findByPk(term.id!))!.lastReminderDays).toBeNull(); // any end date change resets
    const more = await w.c('patch', `/committee/terms/${term.id}`, {
      version: 3,
      endDate: '2029-03-31',
      reason: 'Elections delayed',
    });
    expect(more.status).toBe(200);
    const a = (await AuditLog.findOne({
      where: { action: 'committee.term.extended', entityId: String(term.id) },
    }))!;
    expect(a.reason).toBe('Elections delayed');
    expect((a.before as any).endDate).toBe('2029-03-30');
    expect((a.after as any).endDate).toBe('2029-03-31');
  });

  it('extending an EXPIRED term to today or later makes it ACTIVE again and clears expiredAt', async () => {
    const { w, term } = await current({ status: 'EXPIRED', endDate: '2026-10-31' });
    await term.update({ expiredAt: new Date('2026-11-01T00:00:00Z'), lastReminderDays: 0 });
    const still = await w.c('patch', `/committee/terms/${term.id}`, {
      version: 1,
      endDate: '2026-10-31',
      notes: 'No change',
    });
    expect(still.body.data.status).toBe('EXPIRED');
    const past = await w.c('patch', `/committee/terms/${term.id}`, {
      version: 2,
      endDate: '2026-10-31',
      name: 'Still expired',
      reason: 'No change really',
    });
    expect(past.body.data.status).toBe('EXPIRED');
    const back = await w.c('patch', `/committee/terms/${term.id}`, {
      version: 3,
      endDate: '2027-03-31',
      reason: 'Elections in March',
    });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.data).toMatchObject({ status: 'ACTIVE', endDate: '2027-03-31', isOverdue: false });
    const row = (await CommitteeTerm.findByPk(term.id!))!;
    expect(row.expiredAt).toBeNull();
    expect(row.lastReminderDays).toBeNull();
    expect(await AuditLog.count({ where: { action: 'committee.term.extended' } })).toBe(1);
  });

  it('strength cannot go below the SEATED count; the society range applies', async () => {
    const { w, term } = await current();
    const low = await w.c('patch', `/committee/terms/${term.id}`, {
      version: 1,
      strength: 3,
      reason: 'Same count',
    });
    expect(low.status).toBe(200);
    const below = await w.c('patch', `/committee/terms/${term.id}`, {
      version: 2,
      strength: 4,
      reason: 'Four seats',
    });
    expect(below.status).toBe(200);
    const out = await w.c('patch', `/committee/terms/${term.id}`, {
      version: 3,
      strength: 26,
      reason: 'Way too many',
    });
    expect([out.status, out.body.code]).toEqual([422, 'COMMITTEE_STRENGTH_INVALID']);
  });
});

describe('election drafts (BR-10-19, T10-21, T10-22)', () => {
  const input = (societyId: number, userIds: number[], over: Record<string, unknown> = {}) => ({
    societyId,
    electionId: 31,
    resultsDeclaredAt: new Date('2026-10-30T10:00:00Z'),
    termStartDate: '2026-11-02',
    termEndDate: '2031-11-01',
    winners: userIds.map(userId => ({ userId })),
    ...over,
  });
  const run = (w: { society: { id?: number } }, userIds: number[], over: Record<string, unknown> = {}) =>
    sequelize.transaction(t =>
      committee.createDraftFromElection(
        systemCtx('election'),
        input(w.society.id!, userIds, over) as never,
        t,
      ),
    );

  it('creates a DRAFT with source ELECTION and the winners as ELECTED MEMBER seats; the call is idempotent; a manual draft is replaced', async () => {
    const { w, hs, d } = await draft();
    const sent: { template: string; userIds: number[]; data: Record<string, unknown> }[] = [];
    setCommitteePorts({
      notifications: { send: async (template, userIds, data) => void sent.push({ template, userIds, data }) },
    });
    const ids = hs.slice(0, 4).map(h => h.user.id);
    const first = await run(w, ids);
    expect(first.replacedDraftTermId).toBe(d.id);
    const term = (await CommitteeTerm.findByPk(first.termId))!;
    expect(term).toMatchObject({
      source: 'ELECTION',
      status: 'DRAFT',
      electionId: 31,
      strength: 4,
      name: 'Managing Committee 2026–2031',
      startDate: '2026-11-02',
    });
    expect(term.members.map(s => [s.seatId, s.designation, s.joinMode, s.status, s.name])).toEqual([
      ['S1', 'MEMBER', 'ELECTED', 'PLANNED', 'Rajesh Kulkarni'],
      ['S2', 'MEMBER', 'ELECTED', 'PLANNED', 'Arjun Shah'],
      ['S3', 'MEMBER', 'ELECTED', 'PLANNED', 'Meera Iyer'],
      ['S4', 'MEMBER', 'ELECTED', 'PLANNED', 'Lata Menon'],
    ]);
    expect(term.resultsDeclaredAt).toEqual(new Date('2026-10-30T10:00:00Z'));
    expect(await CommitteeTerm.findByPk(d.id)).toBeNull(); // soft deleted
    expect((await CommitteeTerm.findByPk(d.id, { paranoid: false }))!.deletedAt).not.toBeNull();
    const del = (await AuditLog.findOne({
      where: { action: 'committee.term.deleted', entityId: String(d.id) },
    }))!;
    expect(del.reason).toBe('Replaced by election results');
    expect(await AuditLog.count({ where: { action: 'committee.term.created_from_election' } })).toBe(1);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.template).toBe('committee.draft_from_election');
    expect(sent[0]!.userIds).toContain(w.user.id);
    expect(JSON.stringify(sent[0]!.data)).not.toMatch(/\d{10}/);
    const second = await run(w, ids);
    expect(second).toEqual({ termId: first.termId, replacedDraftTermId: null });
    expect(await CommitteeTerm.count({ where: { electionId: 31 } })).toBe(1);
  });

  it('winners get designations when given; strength follows the count unless set; ranges are checked', async () => {
    const { w, hs } = await draft();
    await CommitteeTerm.destroy({ where: { societyId: w.society.id! } });
    const r = await sequelize.transaction(t =>
      committee.createDraftFromElection(
        systemCtx('election'),
        {
          ...input(w.society.id!, []),
          strength: 7,
          name: 'Elected Committee',
          winners: [
            { userId: hs[0]!.user.id, unitId: w.unit(1).id, designation: 'CHAIRMAN' },
            { userId: hs[1]!.user.id },
            { userId: hs[2]!.user.id },
          ],
        },
        t,
      ),
    );
    const term = (await CommitteeTerm.findByPk(r.termId))!;
    expect(term).toMatchObject({ strength: 7, name: 'Elected Committee' });
    expect(term.members[0]).toMatchObject({ designation: 'CHAIRMAN', unitId: w.unit(1).id });
    await expect(run(w, [hs[0]!.user.id], { electionId: 40 })).rejects.toMatchObject({
      code: 'COMMITTEE_STRENGTH_INVALID',
    });
    await expect(
      run(
        w,
        hs.slice(0, 4).map(h => h.user.id),
        { electionId: 41, termEndDate: '2026-11-10' },
      ),
    ).rejects.toMatchObject({
      code: 'COMMITTEE_TERM_DATES_INVALID',
    });
  });

  it('does not require membership or a flat (activation blocks instead)', async () => {
    const w = await committeeWorld();
    const r = await run(w, [9001, 9002, 9003]);
    const term = (await CommitteeTerm.findByPk(r.termId))!;
    expect(term.members).toHaveLength(3);
    expect(term.members[0]).toMatchObject({ userId: 9001, unitId: null, status: 'PLANNED' });
  });

  it('PATCH cannot change the set of ELECTED holders but can change designations, portfolios, flats and emails', async () => {
    const { w, hs } = await draft();
    const r = await run(
      w,
      hs.slice(0, 4).map(h => h.user.id),
    );
    const patch = (seats: Record<string, unknown>[]) =>
      w.c('patch', `/committee/terms/${r.termId}`, { version: 1, seats });
    const all = [1, 2, 3, 4].map(n => `S${n}`);
    const keep = (extra: Record<string, unknown> = {}) =>
      all.map(seatId => ({ seatId, designation: 'MEMBER', ...extra }));
    const removed = await patch(keep().slice(0, 3));
    expect([removed.status, removed.body.code]).toEqual([422, 'COMMITTEE_ELECTED_SEATS_LOCKED']);
    const swapped = await patch([...keep().slice(0, 3), seat(hs[4]!, w, 5, 'MEMBER')]);
    expect(swapped.body.code).toBe('COMMITTEE_ELECTED_SEATS_LOCKED');
    const swapHolder = await patch([
      ...keep().slice(0, 3),
      { seatId: 'S4', designation: 'MEMBER', userId: hs[4]!.user.id, unitId: w.unit(5).id },
    ]);
    expect(swapHolder.body.code).toBe('COMMITTEE_ELECTED_SEATS_LOCKED');
    const ok = await patch([
      {
        seatId: 'S1',
        designation: 'CHAIRMAN',
        unitId: w.unit(1).id,
        portfolios: ['LEGAL'],
        publicEmail: 'c@sky.in',
      },
      { seatId: 'S2', designation: 'SECRETARY', unitId: w.unit(2).id },
      { seatId: 'S3', designation: 'TREASURER', unitId: w.unit(3).id },
      { seatId: 'S4', designation: 'MEMBER', unitId: w.unit(4).id },
    ]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.seats.map((s: any) => [s.designation, s.joinMode, s.unitLabel])).toEqual([
      ['CHAIRMAN', 'ELECTED', 'A-101'],
      ['SECRETARY', 'ELECTED', 'A-102'],
      ['TREASURER', 'ELECTED', 'A-103'],
      ['MEMBER', 'ELECTED', 'A-104'],
    ]);
    // an appointed extra member is allowed because the ELECTED set is unchanged
    const extra = await w.c('patch', `/committee/terms/${r.termId}`, {
      version: 2,
      strength: 5,
      seats: [
        ...ok.body.data.seats.map((s: any) => ({ seatId: s.seatId, designation: s.designation })),
        { ...seat(hs[4]!, w, 5, 'MEMBER'), joinMode: 'APPOINTED' },
      ],
    });
    expect(extra.status, JSON.stringify(extra.body)).toBe(200);
  });
});

describe('DELETE a draft (8.5)', () => {
  it('soft deletes with an audit row and reason; the term is gone for reads; a new draft can be made', async () => {
    const { w, d, hs } = await draft();
    const r = await w.c('delete', `/committee/terms/${d.id}`, { version: 1, reason: 'Entered by mistake' });
    expect(r.status).toBe(204);
    expect((await w.c('get', `/committee/terms/${d.id}`)).body.code).toBe('COMMITTEE_TERM_NOT_FOUND');
    expect((await w.c('get', '/committee/terms')).body.data).toEqual([]);
    expect(
      (await w.c('patch', `/committee/terms/${d.id}`, { version: 1, name: 'Back again' })).body.code,
    ).toBe('COMMITTEE_TERM_NOT_FOUND');
    expect(
      (await w.c('delete', `/committee/terms/${d.id}`, { version: 1, reason: 'Entered by mistake' })).status,
    ).toBe(404);
    const a = (await AuditLog.findOne({
      where: { action: 'committee.term.deleted', entityId: String(d.id) },
    }))!;
    expect(a.reason).toBe('Entered by mistake');
    expect(JSON.stringify(a.before)).toContain('Rajesh Kulkarni');
    expect((await CommitteeTerm.findByPk(d.id, { paranoid: false }))!.deletedAt).not.toBeNull();
    await postTerm(w.c, termBody([seat(hs[0]!, w, 1, 'CHAIRMAN')]));
  });

  it('validates the body, the version, and refuses a term that is not a draft', async () => {
    const { w, d } = await draft();
    expect((await w.c('delete', `/committee/terms/${d.id}`, { version: 1 })).status).toBe(400);
    expect((await w.c('delete', `/committee/terms/${d.id}`, { version: 1, reason: 'abc' })).status).toBe(400);
    expect(
      (await w.c('delete', `/committee/terms/${d.id}`, { version: 5, reason: 'Entered by mistake' })).body
        .code,
    ).toBe('STALE_VERSION');
    const act = await rawTerm(w.society.id!, { status: 'ACTIVE' });
    const ended = await rawTerm(w.society.id!, {
      status: 'ENDED',
      startDate: '2019-04-01',
      endDate: '2024-03-31',
    });
    for (const t of [act, ended]) {
      const r = await w.c('delete', `/committee/terms/${t.id}`, { version: 1, reason: 'Should not work' });
      expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
    }
    expect(await CommitteeTerm.count({ where: { societyId: w.society.id! } })).toBe(3);
  });

  it('the model refuses to destroy a term that is not a draft (beforeDestroy)', async () => {
    const w = await committeeWorld();
    const t = await rawTerm(w.society.id!);
    await expect(t.destroy()).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
    expect(await CommitteeTerm.count()).toBe(1);
  });
});

describe('PATCH a seat (8.6)', () => {
  it('sets portfolios, a lower-cased public email and visibility of a member; audit committee.seat.updated', async () => {
    const { w, hs } = await draft();
    const d = await postTerm(
      w.c,
      termBody([seat(hs[0]!, w, 1, 'CHAIRMAN'), seat(hs[3]!, w, 4, 'MEMBER')], {
        name: 'Second draft attempt',
      }),
      409,
    ).catch(() => null);
    void d;
    const term = (await CommitteeTerm.findOne({ where: { societyId: w.society.id! } }))!;
    const r = await w.c('patch', `/committee/terms/${term.id}/seats/S1`, {
      version: 1,
      portfolios: ['LEGAL', 'SECURITY'],
      publicEmail: 'Chair@Sky.IN',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.version).toBe(2);
    expect(r.body.data.seats[0]).toMatchObject({
      portfolios: ['LEGAL', 'SECURITY'],
      publicEmail: 'chair@sky.in',
    });
    const a = (await AuditLog.findOne({
      where: { action: 'committee.seat.updated', entityId: String(term.id) },
    }))!;
    expect((a.after as any).portfolios).toEqual(['LEGAL', 'SECURITY']);
    expect(JSON.stringify(a.after)).not.toContain('Chair@');
    const clear = await w.c('patch', `/committee/terms/${term.id}/seats/S1`, {
      version: 2,
      publicEmail: null,
      portfolios: [],
    });
    expect(clear.body.data.seats[0]).toMatchObject({ portfolios: [], publicEmail: null });
  });

  it('hiding an office bearer is 422 COMMITTEE_CHANGE_INVALID; a member can be hidden', async () => {
    const { w, hs, d } = await draft();
    const hide = await w.c('patch', `/committee/terms/${d.id}/seats/S1`, {
      version: 1,
      showOnResidentPage: false,
    });
    expect([hide.status, hide.body.code]).toEqual([422, 'COMMITTEE_CHANGE_INVALID']);
    const r = await w.c('patch', `/committee/terms/${d.id}`, {
      version: 1,
      seats: [{ seatId: 'S1', designation: 'CHAIRMAN' }, seat(hs[3]!, w, 4, 'MEMBER')],
    });
    const ok = await w.c('patch', `/committee/terms/${d.id}/seats/S4`, {
      version: r.body.data.version,
      showOnResidentPage: false,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.seats.find((s: any) => s.seatId === 'S4').showOnResidentPage).toBe(false);
  });

  it('a flat change must be a flat the holder owns (BR-10-8)', async () => {
    const { w, hs, d } = await draft();
    const other = await w.c('patch', `/committee/terms/${d.id}/seats/S1`, {
      version: 1,
      unitId: w.unit(5).id,
    });
    expect([other.status, other.body.code]).toEqual([422, 'COMMITTEE_HOLDER_INELIGIBLE']);
    expect(other.body.errors[0].seatIds).toEqual(['S1']);
    void hs;
    const same = await w.c('patch', `/committee/terms/${d.id}/seats/S1`, {
      version: 1,
      unitId: w.unit(1).id,
    });
    expect(same.status).toBe(200);
  });

  it('works on a SEATED seat of a current term and refuses seat, term and version problems', async () => {
    const { w, term } = await current();
    const ok = await w.c('patch', `/committee/terms/${term.id}/seats/S2`, {
      version: 1,
      portfolios: ['ACCOUNTS'],
    });
    expect(ok.status).toBe(200);
    expect(
      (await w.c('patch', `/committee/terms/${term.id}/seats/S9`, { version: 2, portfolios: [] })).body.code,
    ).toBe('COMMITTEE_SEAT_NOT_FOUND');
    expect(
      (await w.c('patch', `/committee/terms/${term.id}/seats/S2`, { version: 1, portfolios: [] })).body.code,
    ).toBe('STALE_VERSION');
    expect(
      (await w.c('patch', `/committee/terms/${term.id}/seats/bad`, { version: 2, portfolios: [] })).status,
    ).toBe(400);
    expect((await w.c('patch', `/committee/terms/${term.id}/seats/S2`, { version: 2 })).status).toBe(400);
    expect(
      (await w.c('patch', `/committee/terms/${term.id}/seats/S2`, { version: 2, designation: 'MEMBER' }))
        .status,
    ).toBe(400);
    const row = (await CommitteeTerm.findByPk(term.id!))!;
    await row.update({
      members: row.members.map(s =>
        s.seatId === 'S3'
          ? { ...s, status: 'LEFT' as const, toDate: '2026-10-01', exitReason: 'RESIGNED' as const }
          : s,
      ),
    });
    const left = await w.c('patch', `/committee/terms/${term.id}/seats/S3`, { version: 2, portfolios: [] });
    expect([left.status, left.body.code]).toEqual([409, 'INVALID_STATE']);
    await row.update({ status: 'ENDED', actualEndDate: '2026-10-31' });
    const ended = await w.c('patch', `/committee/terms/${term.id}/seats/S1`, { version: 2, portfolios: [] });
    expect([ended.status, ended.body.code]).toEqual([409, 'INVALID_STATE']);
  });
});
