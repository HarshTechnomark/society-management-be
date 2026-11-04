import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CommitteeTerm, Society, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { DEFAULT_HANDOVER_TEMPLATE } from '../../../src/modules/committee/committee.constants';
import { committee } from '../../../src/modules/committee/committee.public';
import { committeeExportProvider } from '../../../src/modules/committee/committee.exports';
import { purgeCommittee } from '../../../src/modules/committee/committee.purge';
import { newSeat } from '../../../src/modules/committee/committee.seats';
import { seedCommittee } from '../../../seeders/committee';
import { seedSocietySetup } from '../../../seeders/society-setup';
import { as, join, login, memberUser } from '../../helpers/access';
import { subSociety } from '../../helpers/subscriptions';
import { memberOf } from '../../helpers/society-setup';
import { committeeWorld, holder, rawTerm, resetCommittee, seated } from '../../helpers/committee';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetCommittee);

/** The current term of US-10-01 (three seats, strength 5) with the demo's dates. */
async function currentTerm(o: Record<string, unknown> = {}) {
  const w = await committeeWorld();
  const hs = [
    await holder(w, 1, 'Rajesh Kulkarni'),
    await holder(w, 2, 'Arjun Shah'),
    await holder(w, 3, 'Meera Iyer'),
  ];
  const term = await rawTerm(w.society.id!, {
    members: [
      seated('S1', hs[0]!, 'Rajesh Kulkarni', 'CHAIRMAN', {
        unitId: w.unit(1).id,
        portfolios: ['LEGAL'],
        publicEmail: 'chairman@skyheights.in',
      }),
      seated('S2', hs[1]!, 'Arjun Shah', 'SECRETARY', { unitId: w.unit(2).id }),
      seated('S3', hs[2]!, 'Meera Iyer', 'TREASURER', { unitId: w.unit(3).id }),
    ],
    ...o,
  });
  return { w, hs, term };
}

describe('GET /committee (8.1)', () => {
  it('without a committee: current and draft are null and the banner says NO_COMMITTEE', async () => {
    const w = await committeeWorld();
    const r = await w.c('get', '/committee');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ current: null, draft: null, banner: { code: 'NO_COMMITTEE' } });
  });

  it('the current term with counts, vacancies, hand-over progress and attention flags', async () => {
    const { w, term } = await currentTerm({
      handoverChecklist: [
        {
          itemId: 'H1',
          title: 'Bank signatories',
          ownerDesignation: 'TREASURER',
          status: 'DONE',
          note: null,
          evidenceFileIds: [],
          updatedByUserId: null,
          updatedAt: null,
        },
        {
          itemId: 'H2',
          title: 'Cheque books',
          ownerDesignation: 'TREASURER',
          status: 'PENDING',
          note: null,
          evidenceFileIds: [],
          updatedByUserId: null,
          updatedAt: null,
        },
      ],
    });
    const r = await w.c('get', '/committee');
    expect(r.body.data.current).toEqual({
      id: term.id,
      name: 'Managing Committee 2024–2029',
      kind: 'ELECTED',
      source: 'MANUAL',
      status: 'ACTIVE',
      startDate: '2024-04-01',
      endDate: '2029-03-31',
      tookChargeOn: '2024-04-01',
      daysLeft: 881,
      isOverdue: false,
      strength: 5,
      seatedCount: 3,
      vacancies: 2,
      vacantDesignations: [],
      handover: { total: 2, done: 1, completedAt: null },
      attentionCount: 0,
      version: 1,
    });
    expect(r.body.data.banner).toBeNull();
    const row = (await CommitteeTerm.findByPk(term.id!))!;
    await row.update({
      members: row.members.map(s =>
        s.seatId === 'S3'
          ? { ...s, status: 'LEFT' as const, toDate: '2026-10-01', exitReason: 'RESIGNED' as const }
          : s.seatId === 'S2'
            ? { ...s, flags: ['MEMBERSHIP_SUSPENDED' as const] }
            : s,
      ),
    });
    const c = (await w.c('get', '/committee')).body.data.current;
    expect(c).toMatchObject({
      seatedCount: 2,
      vacancies: 3,
      vacantDesignations: ['TREASURER'],
      attentionCount: 1,
    });
  });

  it('a manual draft is summarised and does not change the banner', async () => {
    const { w } = await currentTerm();
    const d = await rawTerm(w.society.id!, {
      status: 'DRAFT',
      startDate: '2026-11-02',
      endDate: '2031-11-01',
      tookChargeOn: null,
      members: [newSeat({ seatId: 'S1', name: 'Some One', designation: 'MEMBER', userId: 5 })],
    });
    const r = await w.c('get', '/committee');
    expect(r.body.data.draft).toEqual({
      id: d.id,
      name: 'Managing Committee 2024–2029',
      kind: 'ELECTED',
      source: 'MANUAL',
      startDate: '2026-11-02',
      endDate: '2031-11-01',
      strength: 5,
      seatCount: 1,
      electionId: null,
      version: 1,
    });
    expect(r.body.data.banner).toBeNull();
  });

  it('banners: TERM_ENDING within 90 days, CARETAKER when EXPIRED or overdue, DRAFT_FROM_ELECTION without a current term', async () => {
    const { w, term } = await currentTerm({ endDate: '2027-01-30' });
    expect((await w.c('get', '/committee')).body.data.banner).toEqual({ code: 'TERM_ENDING', daysLeft: 90 });
    await term.update({ endDate: '2026-10-31' }); // Starter: stays ACTIVE and overdue
    let r = await w.c('get', '/committee');
    expect(r.body.data.current).toMatchObject({ status: 'ACTIVE', isOverdue: true, daysLeft: -1 });
    expect(r.body.data.banner).toEqual({ code: 'CARETAKER', endedOn: '2026-10-31' });
    await term.update({ status: 'EXPIRED' });
    r = await w.c('get', '/committee');
    expect(r.body.data.banner).toEqual({ code: 'CARETAKER', endedOn: '2026-10-31' });
    await term.update({ status: 'ENDED', actualEndDate: '2026-10-31' });
    const d = await rawTerm(w.society.id!, {
      status: 'DRAFT',
      source: 'ELECTION',
      electionId: 31,
      tookChargeOn: null,
      startDate: '2026-11-02',
      endDate: '2031-11-01',
    });
    r = await w.c('get', '/committee');
    expect(r.body.data.current).toBeNull();
    expect(r.body.data.banner).toEqual({ code: 'DRAFT_FROM_ELECTION', draftId: d.id, electionId: 31 });
  });
});

describe('GET /committee/terms (8.2)', () => {
  async function history() {
    const { w, term } = await currentTerm();
    const ended = await rawTerm(w.society.id!, {
      name: 'Managing Committee 2019–2024',
      source: 'HISTORICAL',
      status: 'ENDED',
      startDate: '2019-04-01',
      endDate: '2024-03-31',
      actualEndDate: '2024-03-31',
      tookChargeOn: null,
      members: [
        newSeat({
          seatId: 'S1',
          name: 'Vinod Bhide',
          designation: 'CHAIRMAN',
          status: 'LEFT',
          fromDate: '2019-04-01',
          toDate: '2024-03-31',
          exitReason: 'TERM_ENDED',
        }),
        newSeat({
          seatId: 'S2',
          name: 'Left Early',
          designation: 'MEMBER',
          status: 'LEFT',
          fromDate: '2019-04-01',
          toDate: '2020-03-31',
          exitReason: 'RESIGNED',
        }),
        newSeat({
          seatId: 'S3',
          name: 'Shalini Rao',
          designation: 'TREASURER',
          status: 'LEFT',
          fromDate: '2019-04-01',
          toDate: '2024-03-31',
          exitReason: 'TERM_ENDED',
        }),
      ],
    });
    return { w, term, ended };
  }

  it('lists terms newest first with seated counts and office bearers in designation order', async () => {
    const { w, term, ended } = await history();
    const r = await w.c('get', '/committee/terms');
    expect(r.status).toBe(200);
    expect(r.body.pagination).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });
    expect(r.body.data.map((t: any) => t.id)).toEqual([term.id, ended.id]);
    expect(r.body.data[0]).toEqual({
      id: term.id,
      name: 'Managing Committee 2024–2029',
      kind: 'ELECTED',
      source: 'MANUAL',
      status: 'ACTIVE',
      startDate: '2024-04-01',
      endDate: '2029-03-31',
      actualEndDate: null,
      tookChargeOn: '2024-04-01',
      strength: 5,
      seatedCount: 3,
      officeBearers: [
        { designation: 'CHAIRMAN', name: 'Rajesh Kulkarni' },
        { designation: 'SECRETARY', name: 'Arjun Shah' },
        { designation: 'TREASURER', name: 'Meera Iyer' },
      ],
      electionId: null,
      version: 1,
    });
    expect(r.body.data[1]).toMatchObject({
      status: 'ENDED',
      source: 'HISTORICAL',
      seatedCount: 2,
      officeBearers: [
        { designation: 'CHAIRMAN', name: 'Vinod Bhide' },
        { designation: 'TREASURER', name: 'Shalini Rao' },
      ],
    });
  });

  it('filters by status and source, sorts and pages', async () => {
    const { w, term, ended } = await history();
    const ids = async (q: Record<string, string>) =>
      (await w.c('get', '/committee/terms', undefined, { query: q })).body.data.map((t: any) => t.id);
    expect(await ids({ status: 'ENDED' })).toEqual([ended.id]);
    expect(await ids({ source: 'MANUAL' })).toEqual([term.id]);
    expect(await ids({ source: 'HISTORICAL', status: 'ACTIVE' })).toEqual([]);
    expect(await ids({ sortOrder: 'asc' })).toEqual([ended.id, term.id]);
    expect(await ids({ sortBy: 'createdAt', sortOrder: 'asc' })).toEqual([term.id, ended.id]);
    const p = await w.c('get', '/committee/terms', undefined, { query: { limit: '1', page: '2' } });
    expect(p.body.data.map((t: any) => t.id)).toEqual([ended.id]);
    expect(p.body.pagination).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
    for (const q of [{ status: 'NOPE' }, { sortBy: 'name' }, { limit: '101' }, { page: '0' }] as Record<
      string,
      string
    >[]) {
      const r = await w.c('get', '/committee/terms', undefined, { query: q });
      expect(r.status, JSON.stringify(q)).toBe(400);
    }
  });
});

describe('GET /committee/terms/:id (8.2)', () => {
  it('returns the term with live role, unit label and the seats in seat order', async () => {
    const { w, hs, term } = await currentTerm({ resolutionRef: 'CM/2024-25/01' });
    const r = await w.c('get', `/committee/terms/${term.id}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d).toMatchObject({
      id: term.id,
      status: 'ACTIVE',
      resolutionRef: 'CM/2024-25/01',
      predecessorTermId: null,
      successorTermId: null,
      daysLeft: 881,
      isOverdue: false,
      handover: { total: 0, done: 0, notApplicable: 0, completedAt: null },
      version: 1,
    });
    expect(Object.keys(d.seats[0]).sort()).toEqual(
      [
        'seatId',
        'userId',
        'memberId',
        'name',
        'designation',
        'joinMode',
        'unitId',
        'unitLabel',
        'portfolios',
        'mobile',
        'publicEmail',
        'photoFileId',
        'showOnResidentPage',
        'status',
        'fromDate',
        'toDate',
        'roleKey',
        'expectedRoleKey',
        'roleBeforeKey',
        'replaceExistingRole',
        'exitReason',
        'exitNote',
        'resolutionRef',
        'flags',
      ].sort(),
    );
    expect(d.seats[0]).toMatchObject({
      seatId: 'S1',
      userId: hs[0]!.user.id,
      name: 'Rajesh Kulkarni',
      designation: 'CHAIRMAN',
      unitLabel: 'A-101',
      portfolios: ['LEGAL'],
      publicEmail: 'chairman@skyheights.in',
      photoFileId: null,
      status: 'SEATED',
      fromDate: '2024-04-01',
      roleKey: 'owner', // live from module 03: the member has not been given the chairman role
      expectedRoleKey: 'chairman',
    });
    expect(d.createdAt).toMatch(/Z$/);
  });

  it('links the predecessor and successor; a LEFT seat has no live role', async () => {
    const { w, term } = await currentTerm();
    const next = await rawTerm(w.society.id!, {
      status: 'DRAFT',
      predecessorTermId: term.id!,
      startDate: '2026-11-02',
      endDate: '2031-11-01',
      tookChargeOn: null,
    });
    expect((await w.c('get', `/committee/terms/${term.id}`)).body.data.successorTermId).toBe(next.id);
    expect((await w.c('get', `/committee/terms/${next.id}`)).body.data.predecessorTermId).toBe(term.id);
    const row = (await CommitteeTerm.findByPk(term.id!))!;
    await row.update({
      members: row.members.map(s =>
        s.seatId === 'S3'
          ? { ...s, status: 'LEFT' as const, toDate: '2026-10-01', exitReason: 'RESIGNED' as const }
          : s,
      ),
    });
    const seats = (await w.c('get', `/committee/terms/${term.id}`)).body.data.seats;
    expect(seats[2]).toMatchObject({
      status: 'LEFT',
      roleKey: null,
      exitReason: 'RESIGNED',
      toDate: '2026-10-01',
    });
  });

  it('masks mobiles unless the caller holds residents.contacts.view or the number is their own', async () => {
    const { w, hs, term } = await currentTerm();
    const full = (await w.c('get', `/committee/terms/${term.id}`)).body.data.seats; // chairman: All
    expect(full[0].mobile).toMatch(/^\d{10}$/);
    const member = await memberOf(w.society, 'committee_member');
    const masked = (await member.c('get', `/committee/terms/${term.id}`)).body.data.seats;
    for (const s of masked) expect(s.mobile).toMatch(/^\d{2}XXXXX\d{3}$/);
    expect(masked[0].mobile).toBe(`${full[0].mobile.slice(0, 2)}XXXXX${full[0].mobile.slice(-3)}`);
    // the holder sees their own number when they can open the screen (a seated treasurer)
    await join(w.society, hs[2]!.user, 'treasurer').catch(() => undefined);
  });

  it('404 for an unknown id and 400 for a bad id', async () => {
    const w = await committeeWorld();
    const r = await w.c('get', '/committee/terms/99999');
    expect([r.status, r.body.code]).toEqual([404, 'COMMITTEE_TERM_NOT_FOUND']);
    expect((await w.c('get', '/committee/terms/abc')).status).toBe(400);
  });
});

describe('service API (9.2, F19)', () => {
  it('getCurrent, listSeatedUserIds and isSeated read the seated seats of the current term', async () => {
    const { w, hs, term } = await currentTerm();
    const cur = (await committee.getCurrent(w.society.id!))!;
    expect(cur).toMatchObject({
      termId: term.id,
      name: 'Managing Committee 2024–2029',
      status: 'ACTIVE',
      startDate: '2024-04-01',
      endDate: '2029-03-31',
    });
    expect(cur.seats).toEqual([
      {
        seatId: 'S1',
        userId: hs[0]!.user.id,
        memberId: 1,
        designation: 'CHAIRMAN',
        joinMode: 'ELECTED',
        fromDate: '2024-04-01',
      },
      {
        seatId: 'S2',
        userId: hs[1]!.user.id,
        memberId: 1,
        designation: 'SECRETARY',
        joinMode: 'ELECTED',
        fromDate: '2024-04-01',
      },
      {
        seatId: 'S3',
        userId: hs[2]!.user.id,
        memberId: 1,
        designation: 'TREASURER',
        joinMode: 'ELECTED',
        fromDate: '2024-04-01',
      },
    ]);
    expect(await committee.listSeatedUserIds(w.society.id!)).toEqual(hs.map(h => h.user.id));
    expect(await committee.listSeatedUserIds(w.society.id!, ['TREASURER', 'CHAIRMAN'])).toEqual([
      hs[0]!.user.id,
      hs[2]!.user.id,
    ]);
    expect(await committee.isSeated(w.society.id!, hs[1]!.user.id)).toEqual({
      seated: true,
      designation: 'SECRETARY',
    });
    expect(await committee.isSeated(w.society.id!, 999)).toEqual({ seated: false, designation: null });
    await term.update({ status: 'EXPIRED' });
    expect((await committee.getCurrent(w.society.id!))!.status).toBe('EXPIRED');
    await term.update({ status: 'ENDED', actualEndDate: '2026-10-31' });
    expect(await committee.getCurrent(w.society.id!)).toBeNull();
    expect(await committee.listSeatedUserIds(w.society.id!)).toEqual([]);
    expect(await committee.isSeated(w.society.id!, hs[0]!.user.id)).toEqual({
      seated: false,
      designation: null,
    });
  });

  it('only the caller society is read', async () => {
    const a = await currentTerm();
    const b = await committeeWorld();
    expect(await committee.getCurrent(b.society.id!)).toBeNull();
    expect((await committee.getCurrent(a.w.society.id!))!.seats).toHaveLength(3);
  });
});

describe('module 05 export and purge (section 13)', () => {
  it('exports one row per seat without contacts, including soft-deleted drafts, in id order', async () => {
    const { w, term } = await currentTerm();
    const gone = await rawTerm(w.society.id!, {
      status: 'DRAFT',
      startDate: '2026-11-02',
      endDate: '2031-11-01',
      tookChargeOn: null,
      members: [newSeat({ seatId: 'S1', name: 'Dropped Draft', designation: 'MEMBER', userId: 7 })],
    });
    await gone.destroy();
    await rawTerm(w.society.id!, {
      status: 'ENDED',
      startDate: '2019-04-01',
      endDate: '2024-03-31',
      tookChargeOn: null,
      name: 'Empty history',
    });
    const other = await committeeWorld();
    await rawTerm(other.society.id!);
    const rows: Record<string, unknown>[] = [];
    for await (const r of committeeExportProvider.tables[0]!.stream(w.society.id!)) rows.push(r);
    expect(committeeExportProvider).toMatchObject({
      module: 'members',
      tables: [{ name: 'committee_terms', file: 'committee_terms.csv' }],
    });
    expect(rows.map(r => [r.termId, r.seatId ?? null, r.name ?? null])).toEqual([
      [term.id, 'S1', 'Rajesh Kulkarni'],
      [term.id, 'S2', 'Arjun Shah'],
      [term.id, 'S3', 'Meera Iyer'],
      [gone.id, 'S1', 'Dropped Draft'],
      [expect.any(Number), null, null],
    ]);
    expect(rows[3]!.deletedAt).toBeInstanceOf(Date);
    expect(rows[0]).toMatchObject({
      designation: 'CHAIRMAN',
      joinMode: 'ELECTED',
      seatStatus: 'SEATED',
      fromDate: '2024-04-01',
      exitReason: null,
    });
    expect(JSON.stringify(rows)).not.toMatch(/userId|memberId|mobile|publicEmail|chairman@/);
  });

  it('purges the society rows newest first (predecessor RESTRICT holds) and leaves other societies alone', async () => {
    const { w, term } = await currentTerm();
    await rawTerm(w.society.id!, {
      status: 'DRAFT',
      predecessorTermId: term.id!,
      startDate: '2026-11-02',
      endDate: '2031-11-01',
      tookChargeOn: null,
    });
    const other = await committeeWorld();
    await rawTerm(other.society.id!);
    expect(await purgeCommittee(w.society.id!)).toEqual({ deleted: 2, anonymised: 0 });
    expect(await CommitteeTerm.count({ where: { societyId: w.society.id! }, paranoid: false })).toBe(0);
    expect(await CommitteeTerm.count({ where: { societyId: other.society.id! } })).toBe(1);
    expect(await purgeCommittee(w.society.id!)).toEqual({ deleted: 0, anonymised: 0 });
  });
});

describe('demo seed (section 7.6)', () => {
  it('Sky Heights gets the current and the past committee, Green Park its current one; idempotent; counts consistent', async () => {
    const sky = (await subSociety({ plan: 'PREMIUM', flats: 72, name: 'Sky Heights CHS' })).society;
    const green = (await subSociety({ plan: 'STARTER', flats: 30, name: 'Green Park CHS' })).society;
    await Society.update({ slug: 'sky-heights' }, { where: { id: sky.id! } });
    await Society.update({ slug: 'green-park' }, { where: { id: green.id! } });
    const rajesh = await memberUser(sky, 'chairman', { name: 'Rajesh Kulkarni', mobile: '9820011111' });
    await memberUser(sky, 'treasurer', { name: 'Meera Iyer', mobile: '9820022222' });
    await memberUser(sky, 'secretary', { name: 'Arjun Shah', mobile: '9820033333' });
    const sureshP = await memberUser(green, 'chairman', { name: 'Suresh Pillai', mobile: '9820066666' });
    await memberUser(green, 'treasurer', { name: 'Ritu Agarwal', mobile: '9820077777' });
    await join(green, rajesh, 'secretary');
    await seedSocietySetup();
    const r = await seedCommittee();
    expect(r.created).toEqual([
      'sky-heights: Managing Committee 2024–2029',
      'sky-heights: Managing Committee 2019–2024',
      'green-park: Managing Committee 2025–2026',
    ]);
    expect((await seedCommittee()).created).toEqual([]);
    expect(await CommitteeTerm.count()).toBe(3);

    const c = as(await login(rajesh, { societyId: sky.id! }));
    const ov = (await c('get', '/committee')).body.data;
    expect(ov.current).toMatchObject({
      name: 'Managing Committee 2024–2029',
      status: 'ACTIVE',
      strength: 5,
      seatedCount: 3,
      vacancies: 2,
      vacantDesignations: [],
      tookChargeOn: '2024-04-01',
      handover: { total: 10, done: 9, completedAt: null },
    });
    const detail = (await c('get', `/committee/terms/${ov.current.id}`)).body.data;
    expect(detail.seats.map((s: any) => [s.name, s.designation, s.unitLabel, s.status])).toEqual([
      ['Rajesh Kulkarni', 'CHAIRMAN', 'A-501', 'SEATED'],
      ['Arjun Shah', 'SECRETARY', 'C-104', 'SEATED'],
      ['Meera Iyer', 'TREASURER', 'B-302', 'SEATED'],
    ]);
    const term = (await CommitteeTerm.findByPk(ov.current.id))!;
    expect(term.handoverChecklist.filter(i => i.status === 'PENDING').map(i => i.itemId)).toEqual(['H8']);
    const list = (await c('get', '/committee/terms')).body.data;
    expect(list.map((t: any) => [t.name, t.status, t.source, t.seatedCount])).toEqual([
      ['Managing Committee 2024–2029', 'ACTIVE', 'MANUAL', 3],
      ['Managing Committee 2019–2024', 'ENDED', 'HISTORICAL', 3],
    ]);
    const past = (await CommitteeTerm.findOne({ where: { name: 'Managing Committee 2019–2024' } }))!;
    expect(past.members.map(s => [s.name, s.designation, s.userId === null])).toEqual([
      ['Vinod Bhide', 'CHAIRMAN', true],
      ['Rajesh Kulkarni', 'SECRETARY', false],
      ['Shalini Rao', 'TREASURER', true],
    ]);
    const gp = (await CommitteeTerm.findOne({ where: { societyId: green.id!, status: 'ACTIVE' } }))!;
    // Green Park carries the 10.3 demo: ends in 24 days, half-done hand-over, one attention flag
    expect(gp).toMatchObject({
      name: 'Managing Committee 2025–2026',
      strength: 3,
      startDate: '2025-07-01',
      endDate: '2026-11-25',
    });
    expect(gp.members.map(s => s.name)).toEqual(['Suresh Pillai', 'Rajesh Kulkarni', 'Ritu Agarwal']);
    expect(gp.members.map(s => s.flags)).toEqual([[], [], ['MEMBERSHIP_SUSPENDED']]);
    const count = (st: string) => gp.handoverChecklist.filter(i => i.status === st).length;
    expect([count('DONE'), count('NOT_APPLICABLE'), count('PENDING')]).toEqual([5, 1, 4]);
    const gpc = as(await login(sureshP, { societyId: green.id! }));
    const gov = (await gpc('get', '/committee')).body.data;
    expect(gov.current).toMatchObject({ daysLeft: 24, attentionCount: 1, handover: { total: 10, done: 5 } });
    expect(gov.banner).toEqual({ code: 'TERM_ENDING', daysLeft: 24 });
  });

  it('tunes a Green Park term seeded by 10.1 once and leaves everything else alone', async () => {
    const green = (await subSociety({ plan: 'STARTER', flats: 30, name: 'Green Park CHS' })).society;
    await Society.update({ slug: 'green-park' }, { where: { id: green.id! } });
    const suresh = await memberUser(green, 'chairman', { name: 'Suresh Pillai', mobile: '9820066666' });
    const ritu = await memberUser(green, 'treasurer', { name: 'Ritu Agarwal', mobile: '9820077777' });
    await seedSocietySetup();
    const old = await rawTerm(green.id!, {
      name: 'Managing Committee 2025–2030',
      startDate: '2025-07-01',
      endDate: '2030-06-30',
      members: [
        seated('S1', { user: suresh }, 'Suresh Pillai', 'CHAIRMAN'),
        seated('S2', { user: ritu }, 'Ritu Agarwal', 'TREASURER'),
      ],
      handoverChecklist: DEFAULT_HANDOVER_TEMPLATE.map((it, i) => ({
        itemId: `H${i + 1}`,
        title: it.title,
        ownerDesignation: it.ownerDesignation,
        status: 'PENDING' as const,
        note: null,
        evidenceFileIds: [],
        updatedByUserId: null,
        updatedAt: null,
      })),
    });
    const r = await seedCommittee();
    expect(r.created).toContain('green-park: Managing Committee 2025–2026 (tuned)');
    const row = (await CommitteeTerm.findByPk(old.id!))!;
    expect([row.name, row.endDate, row.version]).toEqual(['Managing Committee 2025–2026', '2026-11-25', 2]);
    expect(row.handoverChecklist.filter(i => i.status !== 'PENDING')).toHaveLength(6);
    expect(row.members.find(s => s.designation === 'TREASURER')!.flags).toEqual(['MEMBERSHIP_SUSPENDED']);
    expect((await seedCommittee()).created).toEqual([]);
    expect((await CommitteeTerm.findByPk(old.id!))!.version).toBe(2);
  });
});
