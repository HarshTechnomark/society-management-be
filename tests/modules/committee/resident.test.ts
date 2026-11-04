import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CommitteeTerm, Invitation, Role, User, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { newSeat } from '../../../src/modules/committee/committee.seats';
import { myCommittee } from '../../../src/modules/committee/committee.resident';
import { systemCtx } from '../../../src/types/context';
import { call } from '../../helpers/auth';
import { memberOf } from '../../helpers/society-setup';
import {
  committeeWorld,
  holder,
  rawTerm,
  resetCommittee,
  seatedFor,
  setLimit,
  setSetting,
  suspend,
} from '../../helpers/committee';
import { featureOff } from '../../helpers/society-setup';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetCommittee);

async function page(o: Record<string, unknown> = {}) {
  const w = await committeeWorld();
  const rajesh = await holder(w, 1, 'Rajesh Kulkarni');
  const arjun = await holder(w, 2, 'Arjun Shah');
  const zoya = await holder(w, 3, 'Zoya Khan');
  const bela = await holder(w, 4, 'Bela Shah');
  const hidden = await holder(w, 5, 'Hidden Member');
  const plain = await holder(w, 6, 'Plain Owner');
  await User.update({ photoFileId: 7001 }, { where: { id: rajesh.user.id } });
  const term = await rawTerm(w.society.id!, {
    strength: 7,
    members: [
      await seatedFor(w, zoya, 'S1', 'MEMBER', { joinMode: 'CO_OPTED', fromDate: '2025-01-10' }),
      await seatedFor(w, arjun, 'S2', 'SECRETARY'),
      await seatedFor(w, bela, 'S3', 'MEMBER'),
      await seatedFor(w, hidden, 'S4', 'MEMBER', { showOnResidentPage: false }),
      await seatedFor(w, rajesh, 'S5', 'CHAIRMAN', {
        portfolios: ['LEGAL'],
        publicEmail: 'chairman@skyheights.in',
      }),
    ],
    ...o,
  });
  return { w, term, rajesh, arjun, zoya, bela, hidden, plain };
}

describe('GET /me/committee (8.12, BR-10-28, T10-32)', () => {
  it('lists the seated members in designation order with masked mobiles and no ids; the hidden MEMBER seat is absent', async () => {
    const x = await page();
    const r = await x.plain.c('get', '/me/committee');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.visible).toBe(true);
    expect(d.term).toEqual({
      name: 'Managing Committee 2024–2029',
      startDate: '2024-04-01',
      endDate: '2029-03-31',
      status: 'ACTIVE',
      isOverdue: false,
    });
    expect(d.members.map((m: { name: string }) => m.name)).toEqual([
      'Rajesh Kulkarni',
      'Arjun Shah',
      'Bela Shah',
      'Zoya Khan',
    ]);
    expect(d.vacancies).toBe(2); // strength 7, five seated (the hidden one still holds a seat)
    const chair = d.members[0];
    expect(chair).toEqual({
      name: 'Rajesh Kulkarni',
      designation: 'CHAIRMAN',
      designationLabel: 'Chairman',
      joinMode: 'ELECTED',
      unitLabel: x.w.unit(1).label,
      photoFileId: 7001,
      mobile: expect.stringMatching(/^\d{2}XXXXX\d{3}$/),
      publicEmail: 'chairman@skyheights.in',
      portfolios: ['LEGAL'],
      since: '2024-04-01',
    });
    expect(d.members[3]).toMatchObject({
      designationLabel: 'Member',
      joinMode: 'CO_OPTED',
      since: '2025-01-10',
      photoFileId: null,
    });
    const text = JSON.stringify(d);
    for (const u of [x.rajesh, x.arjun, x.zoya]) {
      expect(text).not.toContain(u.user.mobile);
      expect(Object.keys(d.members[0])).not.toContain('userId');
    }
    expect(text).not.toContain('memberId');
  });

  it('the holder sees their own number; a viewer with residents.contacts.view sees the numbers', async () => {
    const x = await page();
    const own = await x.arjun.c('get', '/me/committee');
    const arjunRow = own.body.data.members.find((m: { name: string }) => m.name === 'Arjun Shah');
    expect(arjunRow.mobile).toBe(x.arjun.user.mobile);
    expect(own.body.data.members.find((m: { name: string }) => m.name === 'Rajesh Kulkarni').mobile).toMatch(
      /XXXXX/,
    );
    // no resident-app role holds residents.contacts.view, so the unmasked branch is checked on the service
    const full = (await myCommittee(
      { ...systemCtx('test'), permissions: new Set(['residents.contacts.view']) },
      x.w.society.id!,
    )) as {
      members: { name: string; mobile: string }[];
    };
    expect(full.members.find(m => m.name === 'Rajesh Kulkarni')!.mobile).toBe(x.rajesh.user.mobile);
  });

  it('shows the caretaker state and a LEFT seat is not listed', async () => {
    const x = await page({ status: 'EXPIRED', endDate: '2026-10-31' });
    await CommitteeTerm.update(
      {
        members: (await CommitteeTerm.findByPk(x.term.id!))!.members.map(s =>
          s.seatId === 'S1'
            ? { ...s, status: 'LEFT' as const, toDate: '2026-10-01', exitReason: 'RESIGNED' as const }
            : s,
        ),
      },
      { where: { id: x.term.id! } },
    );
    const r = await x.plain.c('get', '/me/committee');
    expect(r.body.data.term).toMatchObject({ status: 'EXPIRED', isOverdue: true });
    expect(r.body.data.members.map((m: { name: string }) => m.name)).not.toContain('Zoya Khan');
  });

  it('without a current term: visible, no term, no members', async () => {
    const w = await committeeWorld();
    const o = await holder(w, 1, 'Owner');
    const r = await o.c('get', '/me/committee');
    expect(r.body.data).toEqual({ visible: true, term: null, members: [], vacancies: 0 });
  });

  it('committee.showOnResidentApp = false returns { visible: false } and no seats', async () => {
    const x = await page();
    await setSetting(x.w.society.id!, 'committee.showOnResidentApp', false);
    const r = await x.plain.c('get', '/me/committee');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ visible: false });
    const h = await x.plain.c('get', '/me/committee/history');
    expect(h.body.data).toEqual([]);
  });

  it('only the caller’s society is shown, a signed-out caller is 401 and a suspended society can still be read', async () => {
    const x = await page();
    const other = await committeeWorld();
    const o = await holder(other, 1, 'Other Owner');
    expect((await o.c('get', '/me/committee')).body.data.term).toBeNull();
    expect((await call('get', '/api/v1/me/committee', undefined)).status).toBe(401);
    await suspend(x.w.society.id!);
    expect((await x.plain.c('get', '/me/committee')).status).toBe(200);
  });

  it('governance.committee_terms is a read grace feature: switched off, the page is 402 FEATURE_NOT_IN_PLAN', async () => {
    const x = await page();
    await featureOff(x.w.society.id!, 'governance.committee_terms');
    const r = await x.plain.c('get', '/me/committee');
    expect([r.status, r.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
  });
});

describe('GET /me/committee/history (8.13)', () => {
  it('lists ENDED terms newest first with office bearers only and no contacts, photos or flats; paginated', async () => {
    const x = await page();
    const s = (
      id: string,
      name: string,
      designation: 'CHAIRMAN' | 'SECRETARY' | 'MEMBER' | 'TREASURER',
      from: string,
      to: string,
    ) =>
      newSeat({
        seatId: id,
        name,
        designation,
        status: 'LEFT',
        fromDate: from,
        toDate: to,
        exitReason: 'TERM_ENDED',
        userId: 99,
        unitId: 5,
        publicEmail: 'x@y.in',
      });
    await rawTerm(x.w.society.id!, {
      name: 'Managing Committee 2019–2024',
      source: 'HISTORICAL',
      status: 'ENDED',
      startDate: '2019-04-01',
      endDate: '2024-03-31',
      actualEndDate: '2024-03-31',
      members: [
        s('S1', 'Shalini Rao', 'TREASURER', '2019-04-01', '2024-03-31'),
        s('S2', 'Vinod Bhide', 'CHAIRMAN', '2019-04-01', '2024-03-31'),
        s('S3', 'A Member', 'MEMBER', '2019-04-01', '2024-03-31'),
      ],
    });
    await rawTerm(x.w.society.id!, {
      name: 'Managing Committee 2014–2019',
      source: 'HISTORICAL',
      status: 'ENDED',
      startDate: '2014-04-01',
      endDate: '2019-03-31',
      actualEndDate: '2019-03-31',
      members: [s('S1', 'Old Chair', 'CHAIRMAN', '2014-04-01', '2019-03-31')],
    });
    const r = await x.plain.c('get', '/me/committee/history');
    expect(r.status).toBe(200);
    expect(r.body.data.map((t: { name: string }) => t.name)).toEqual([
      'Managing Committee 2019–2024',
      'Managing Committee 2014–2019',
    ]);
    expect(r.body.data[0]).toEqual({
      name: 'Managing Committee 2019–2024',
      startDate: '2019-04-01',
      endDate: '2024-03-31',
      actualEndDate: '2024-03-31',
      source: 'HISTORICAL',
      officeBearers: [
        {
          designation: 'CHAIRMAN',
          designationLabel: 'Chairman',
          name: 'Vinod Bhide',
          fromDate: '2019-04-01',
          toDate: '2024-03-31',
        },
        {
          designation: 'TREASURER',
          designationLabel: 'Treasurer',
          name: 'Shalini Rao',
          fromDate: '2019-04-01',
          toDate: '2024-03-31',
        },
      ],
    });
    expect(JSON.stringify(r.body.data)).not.toMatch(/x@y\.in|userId|unitId|photo|mobile/);
    const p = await x.plain.c('get', '/me/committee/history?limit=1&page=2');
    expect(p.body.data).toHaveLength(1);
    expect(p.body.pagination).toMatchObject({ page: 2, limit: 1, total: 2 });
    expect((await x.plain.c('get', '/me/committee/history?limit=0')).status).toBe(400);
    // the current term is not history
    expect(JSON.stringify(r.body.data)).not.toContain('2024–2029');
  });
});

describe('GET /committee/seat-usage (8.11, F15, F16, T-US-10-08)', () => {
  it('meters the staff seats: used of limit, free, byRole, pending staff invitations; committee roles are not counted', async () => {
    const w = await committeeWorld();
    await setLimit(w.society.id!, 'limit.admin_seats', 8);
    const base = (await w.c('get', '/committee/seat-usage')).body.data.used as number;
    const fm = await memberOf(w.society, 'facility_manager');
    await memberOf(w.society, 'accountant');
    await memberOf(w.society, 'treasurer'); // a committee role holds no seat
    const role = (await Role.findOne({ where: { societyId: w.society.id!, key: 'accountant' } }))!;
    await Invitation.create({
      societyId: w.society.id!,
      roleId: role.id!,
      name: 'Pending Accountant',
      mobile: '9820099999',
      email: null,
      locationLabel: null,
      unitId: null,
      residentId: null,
      message: null,
      tokenHash: 'h'.repeat(64),
      status: 'PENDING',
      expiresAt: new Date('2026-12-01T00:00:00Z'),
      resendCount: 0,
      lastSentAt: new Date(),
      invitedUserId: fm.user.id,
      invitedBy: null,
      acceptedUserId: null,
      acceptedMemberId: null,
      respondedAt: null,
      revokedBy: null,
      revokeReason: null,
      version: 1,
      createdBy: null,
      updatedBy: null,
    } as never);
    const r = await w.c('get', '/committee/seat-usage');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d).toMatchObject({ limit: 8, used: base + 2, free: 8 - base - 2, pendingStaffInvitations: 1 });
    expect(d.byRole.find((b: { roleKey: string }) => b.roleKey === 'facility_manager')).toEqual({
      roleKey: 'facility_manager',
      roleName: 'Facility Manager',
      count: 1,
    });
    expect(d.byRole.find((b: { roleKey: string }) => b.roleKey === 'accountant').count).toBe(1);
    expect(d.byRole.some((b: { roleKey: string }) => ['treasurer', 'chairman'].includes(b.roleKey))).toBe(
      false,
    );
    expect(d.byRole.reduce((n: number, b: { count: number }) => n + b.count, 0)).toBe(d.used);
    // the invite presets (staff roles only) and the staff table
    const keys = d.staffRoles.map((s: { roleKey: string }) => s.roleKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        'society_admin',
        'accountant',
        'facility_manager',
        'security_supervisor',
        'auditor',
      ]),
    );
    expect(
      keys.some((k: string) => ['chairman', 'secretary', 'treasurer', 'committee_member'].includes(k)),
    ).toBe(false);
    expect(d.staffRoles.find((s: { roleKey: string }) => s.roleKey === 'accountant')).toMatchObject({
      consumesSeat: true,
      isSystem: true,
    });
    expect(d.staff.map((s: { roleKey: string }) => s.roleKey)).toEqual(
      expect.arrayContaining(['facility_manager', 'accountant']),
    );
    expect(d.staff.every((s: { roleKey: string }) => keys.includes(s.roleKey))).toBe(true);
  });

  it('a full meter shows free 0', async () => {
    const w = await committeeWorld();
    const used = (await w.c('get', '/committee/seat-usage')).body.data.used as number;
    await memberOf(w.society, 'accountant');
    await setLimit(w.society.id!, 'limit.admin_seats', used + 1);
    expect((await w.c('get', '/committee/seat-usage')).body.data).toMatchObject({
      limit: used + 1,
      used: used + 1,
      free: 0,
    });
  });

  it('needs settings.members.view and has no entitlement gate', async () => {
    const w = await committeeWorld({ plan: 'STARTER' });
    expect((await w.c('get', '/committee/seat-usage')).status).toBe(200);
    const owner = await holder(w, 1, 'Plain Owner');
    expect([(await owner.c('get', '/committee/seat-usage')).status]).toEqual([403]);
    const aud = await memberOf(w.society, 'auditor');
    expect((await aud.c('get', '/committee/seat-usage')).status).toBe(200);
  });

  it("society A never sees society B's staff", async () => {
    const a = await committeeWorld();
    const b = await committeeWorld();
    await memberOf(b.society, 'accountant');
    const before = (await a.c('get', '/committee/seat-usage')).body.data;
    expect(before.staff.every((s: { roleKey: string }) => s.roleKey !== 'accountant')).toBe(true);
  });
});
