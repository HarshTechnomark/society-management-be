import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  JoinRequest,
  Resident,
  SocietyMember,
  Tenancy,
  UnitResident,
  closeDb,
  sequelize,
} from '../../../src/models';
import { advance, setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { residentPortCalls } from '../../../src/modules/residents/residents.ports';
import { approvalStub, approveRequest, rejectRequest } from '../../../src/modules/residents/residents.public';
import { runJoinRequestJob } from '../../../src/modules/residents/residents.joins.service';
import { systemCtx } from '../../../src/types/context';
import { as, login } from '../../helpers/access';
import { makeUnit } from '../../helpers/society-setup';
import { makeUser } from '../../helpers/auth';
import { docItem, idemKey, ownerOf, residentsSociety, resetResidentsP2 } from '../../helpers/residents-p2';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetResidentsP2);

type S = Awaited<ReturnType<typeof residentsSociety>>;

async function requester(name = 'Pallavi Naik', mobile = '9820000011') {
  const user = await makeUser({ name, mobile });
  return { user, c: as(await login(user, { app: 'RESIDENT' }), 'RESIDENT') };
}

async function joinBody(s: S, userId: number, over: Record<string, unknown> = {}, docs?: string[]) {
  const relation = (over.relation as string) ?? 'TENANT';
  const types = docs ?? [
    'AADHAAR',
    ...(relation === 'TENANT' ? ['RENT_AGREEMENT'] : relation.includes('OWNER') ? ['SALE_DEED'] : []),
  ];
  return {
    societyCode: s.society.slug,
    unitId: s.unit.id,
    relation: 'TENANT',
    agreementStart: '2026-11-01',
    agreementEnd: '2027-09-30',
    fileIds: await Promise.all(types.map(t => docItem(s.society.id!, userId, t))),
    ...over,
  };
}

const submit = (r: Awaited<ReturnType<typeof requester>>, body: unknown) =>
  r.c('post', '/me/join-requests', body, { headers: idemKey() });

describe('society lookup (8.14)', () => {
  it('finds a society by code and searches flats by label prefix; unknown and closed societies are refused', async () => {
    const s = await residentsSociety();
    const r = await requester();
    const found = await r.c('get', `/me/join/societies/${s.society.slug}`);
    expect(found.body.data).toMatchObject({
      societyId: s.society.id,
      name: 'Sky Heights CHS',
      joinable: true,
    });
    const units = await r.c('get', `/me/join/societies/${s.society.slug}/units`, undefined, {
      query: { q: 'A-12' },
    });
    expect(units.body.data).toEqual([{ unitId: s.unit.id, label: 'A-1203' }]);
    expect((await r.c('get', '/me/join/societies/no-such-society')).body.code).toBe('SOCIETY_CODE_NOT_FOUND');
    await sequelize.query(
      "UPDATE societies SET status = 'SUSPENDED', suspensionCause = 'MANUAL' WHERE id = :id",
      {
        replacements: { id: s.society.id },
      },
    );
    const r2 = await r.c('get', `/me/join/societies/${s.society.slug}`);
    expect([r2.status, r2.body.code]).toEqual([422, 'SOCIETY_NOT_JOINABLE']);
  });
});

describe('submit (BR-09-22 to 24)', () => {
  it('T09-17 a request without an ID document is DOCUMENTS_REQUIRED; a tenant also needs the agreement', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const r = await requester();
    const a = await submit(r, await joinBody(s, r.user.id, {}, ['RENT_AGREEMENT']));
    expect([a.status, a.body.code]).toEqual([422, 'DOCUMENTS_REQUIRED']);
    const b = await submit(r, await joinBody(s, r.user.id, {}, ['AADHAAR']));
    expect(b.body.code).toBe('DOCUMENTS_REQUIRED');
  });

  it('T09-16 TENANT with an owner who has a login: PENDING_OWNER, confirm, module 14 approves, tenancy ACTIVE', async () => {
    approvalStub.mode = 'manual';
    const s = await residentsSociety();
    const owner = await ownerOf(s);
    const r = await requester();
    const res = await submit(r, await joinBody(s, r.user.id));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ unitLabel: 'A-1203', relation: 'TENANT', status: 'PENDING_OWNER' });
    expect(res.body.message).toBe('Request sent to the owner of A-1203');
    const id = res.body.data.id;

    const mine = await owner.c('get', '/me/household/join-requests');
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).toMatchObject({
      id,
      name: 'Pallavi Naik',
      relation: 'TENANT',
      documentsReceived: 2,
    });
    expect(mine.body.data[0].mobile).not.toBe('9820000011');

    const ok = await owner.c('post', `/me/household/join-requests/${id}/confirm`, { version: 1 });
    expect(ok.body.data.status).toBe('PENDING_ADMIN');
    const detail = await s.c('get', `/join-requests/${id}`);
    expect(detail.body.data.approvalRequestId).toBeGreaterThan(0);
    expect(detail.body.data.documents).toHaveLength(2);

    await approveRequest(detail.body.data.approvalRequestId, {
      ...systemCtx('t'),
      user: s.secretary.user as never,
    });
    const jr = (await JoinRequest.findByPk(id))!;
    expect(jr.status).toBe('APPROVED');
    const resident = (await Resident.findByPk(jr.residentId!))!;
    expect(resident.userId).toBe(r.user.id);
    const tn = (await Tenancy.findOne({ where: { tenantResidentId: resident.id } }))!;
    expect(tn).toMatchObject({ status: 'ACTIVE', source: 'JOIN_REQUEST', maintenancePayer: 'OWNER' });
    expect(
      await UnitResident.count({ where: { residentId: resident.id, relation: 'TENANT', tenancyId: tn.id } }),
    ).toBe(1);
    expect(
      await SocietyMember.count({ where: { userId: r.user.id, societyId: s.society.id!, status: 'ACTIVE' } }),
    ).toBe(1);
    expect(await AuditLog.count({ where: { action: 'residents.join_request.approved' } })).toBe(1);
  });

  it('without a confirmer with a login the request goes straight to PENDING_ADMIN and auto-approves through the placeholder', async () => {
    const s = await residentsSociety();
    await s.c(
      'post',
      '/residents',
      {
        name: 'Ravi Shah',
        mobile: '9820000001',
        link: { unitId: s.unit.id, relation: 'OWNER', fromDate: '2026-11-01' },
      },
      { headers: idemKey() },
    );
    const r = await requester();
    const res = await submit(r, await joinBody(s, r.user.id));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.status).toBe('APPROVED');
    expect(residentPortCalls.some(c => c.fn === 'approvals.request')).toBe(true);
  });

  it('OWNER on a flat with an owner is OWNER_ALREADY_EXISTS; CO_OWNER is accepted into the queue', async () => {
    approvalStub.mode = 'manual';
    const s = await residentsSociety();
    await ownerOf(s);
    const r = await requester();
    const a = await submit(
      r,
      await joinBody(s, r.user.id, { relation: 'OWNER', agreementStart: undefined, agreementEnd: undefined }),
    );
    expect([a.status, a.body.code]).toEqual([409, 'OWNER_ALREADY_EXISTS']);
    const b = await submit(
      r,
      await joinBody(s, r.user.id, {
        relation: 'CO_OWNER',
        agreementStart: undefined,
        agreementEnd: undefined,
      }),
    );
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body.data.status).toBe('PENDING_ADMIN');
  });

  it('one pending request per society; ALREADY_LINKED for a linked user; invalid dates; minors; parking units', async () => {
    approvalStub.mode = 'manual';
    const s = await residentsSociety();
    await ownerOf(s);
    const r = await requester();
    expect(
      (
        await submit(
          r,
          await joinBody(s, r.user.id, {
            relation: 'CO_OWNER',
            agreementStart: undefined,
            agreementEnd: undefined,
          }),
        )
      ).status,
    ).toBe(201);
    const dup = await submit(r, await joinBody(s, r.user.id));
    expect([dup.status, dup.body.code]).toEqual([409, 'JOIN_REQUEST_EXISTS']);

    const r2 = await requester('Faisal Khan', '9820000012');
    const bad = await submit(r2, await joinBody(s, r2.user.id, { agreementEnd: '2026-10-01' }));
    expect(bad.body.code).toBe('TENANCY_DATES_INVALID');
    const minor = await submit(r2, await joinBody(s, r2.user.id, { dateOfBirth: '2015-01-01' }));
    expect(minor.body.code).toBe('MINOR_NOT_ALLOWED');
    const parking = await makeUnit(s.c, s.building.id, 'P1', 1, { unitType: 'PARKING_ONLY' });
    const pk = await submit(r2, await joinBody(s, r2.user.id, { unitId: parking.id }));
    expect([pk.status, pk.body.code]).toEqual([422, 'UNIT_NOT_RESIDENTIAL']);
  });

  it('a user already linked to the flat gets ALREADY_LINKED', async () => {
    const s = await residentsSociety();
    const owner = await ownerOf(s);
    const res = await owner.c(
      'post',
      '/me/join-requests',
      await joinBody(s, owner.user.id, {
        relation: 'CO_OWNER',
        agreementStart: undefined,
        agreementEnd: undefined,
      }),
      { headers: idemKey() },
    );
    expect([res.status, res.body.code]).toEqual([409, 'ALREADY_LINKED']);
  });

  it('5 requests a day: the sixth is RATE_LIMITED', async () => {
    approvalStub.mode = 'manual';
    const s = await residentsSociety();
    await ownerOf(s);
    const r = await requester();
    for (let i = 0; i < 5; i++) {
      const a = await submit(
        r,
        await joinBody(s, r.user.id, {
          relation: 'CO_OWNER',
          agreementStart: undefined,
          agreementEnd: undefined,
        }),
      );
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      const w = await r.c('post', `/me/join-requests/${a.body.data.id}/withdraw`, { version: 2 });
      expect(w.status, JSON.stringify(w.body)).toBe(200);
    }
    const six = await submit(
      r,
      await joinBody(s, r.user.id, {
        relation: 'CO_OWNER',
        agreementStart: undefined,
        agreementEnd: undefined,
      }),
    );
    expect([six.status, six.body.code]).toEqual([429, 'RATE_LIMITED']);
  });
});

describe('owner decision, withdraw, reject, escalation, expiry', () => {
  it('the owner declines with a reason; only the confirmer sees the request', async () => {
    const s = await residentsSociety();
    const owner = await ownerOf(s);
    const r = await requester();
    const res = await submit(r, await joinBody(s, r.user.id));
    const id = res.body.data.id;
    const bad = await owner.c('post', `/me/household/join-requests/${id}/decline`, {
      version: 1,
      reason: 'no',
    });
    expect(bad.status).toBe(400);
    const ok = await owner.c('post', `/me/household/join-requests/${id}/decline`, {
      version: 1,
      reason: 'I do not know this person',
    });
    expect(ok.body.data.status).toBe('REJECTED');
    const again = await owner.c('post', `/me/household/join-requests/${id}/confirm`, { version: 2 });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
    expect((await r.c('get', '/me/join-requests')).body.data[0]).toMatchObject({
      status: 'REJECTED',
      societyName: 'Sky Heights CHS',
    });
  });

  it('withdraw cancels the module 14 request; another user cannot withdraw', async () => {
    approvalStub.mode = 'manual';
    const s = await residentsSociety();
    await ownerOf(s);
    const r = await requester();
    const res = await submit(
      r,
      await joinBody(s, r.user.id, {
        relation: 'CO_OWNER',
        agreementStart: undefined,
        agreementEnd: undefined,
      }),
    );
    const other = await requester('Other Person', '9820000013');
    const no = await other.c('post', `/me/join-requests/${res.body.data.id}/withdraw`, { version: 2 });
    expect([no.status, no.body.code]).toEqual([404, 'JOIN_REQUEST_NOT_FOUND']);
    const ok = await r.c('post', `/me/join-requests/${res.body.data.id}/withdraw`, { version: 2 });
    expect(ok.body.data.status).toBe('WITHDRAWN');
    expect(residentPortCalls.filter(c => c.fn === 'approvals.cancel')).toHaveLength(1);
  });

  it('rejecting through the module 14 hook marks it REJECTED with the reason', async () => {
    approvalStub.mode = 'manual';
    const s = await residentsSociety();
    await ownerOf(s);
    const r = await requester();
    const res = await submit(
      r,
      await joinBody(s, r.user.id, {
        relation: 'CO_OWNER',
        agreementStart: undefined,
        agreementEnd: undefined,
      }),
    );
    const jr = (await JoinRequest.findByPk(res.body.data.id))!;
    await rejectRequest(jr.approvalRequestId!, 'Papers do not match', systemCtx('t'));
    const after = (await JoinRequest.findByPk(jr.id!))!;
    expect(after).toMatchObject({ status: 'REJECTED', decisionReason: 'Papers do not match' });
    expect(await Resident.count({ where: { userId: r.user.id } })).toBe(0);
  });

  it('T09-18 after 3 days without an answer the job escalates; after 14 days it expires and cancels the approval', async () => {
    approvalStub.mode = 'manual';
    const s = await residentsSociety();
    await ownerOf(s);
    const r = await requester();
    const res = await submit(r, await joinBody(s, r.user.id));
    const id = res.body.data.id;
    expect(await runJoinRequestJob()).toEqual({ escalated: 0, expired: 0 });
    advance(3 * 86_400_000 + 60_000);
    expect(await runJoinRequestJob()).toEqual({ escalated: 1, expired: 0 });
    let jr = (await JoinRequest.findByPk(id))!;
    expect(jr).toMatchObject({ status: 'PENDING_ADMIN', ownerDecisionNote: 'No response in 3 days' });
    expect(jr.approvalRequestId).toBeGreaterThan(0);
    expect(await runJoinRequestJob()).toEqual({ escalated: 0, expired: 0 });
    advance(12 * 86_400_000);
    expect(await runJoinRequestJob()).toEqual({ escalated: 0, expired: 1 });
    jr = (await JoinRequest.findByPk(id))!;
    expect(jr.status).toBe('EXPIRED');
    expect(residentPortCalls.filter(c => c.fn === 'approvals.cancel')).toHaveLength(1);
    expect(await runJoinRequestJob()).toEqual({ escalated: 0, expired: 0 });
  });

  it('a suspended society is skipped by the job', async () => {
    approvalStub.mode = 'manual';
    const s = await residentsSociety();
    await ownerOf(s);
    const r = await requester();
    await submit(r, await joinBody(s, r.user.id));
    await sequelize.query(
      "UPDATE societies SET status = 'SUSPENDED', suspensionCause = 'MANUAL' WHERE id = :id",
      {
        replacements: { id: s.society.id },
      },
    );
    advance(20 * 86_400_000);
    expect(await runJoinRequestJob()).toEqual({ escalated: 0, expired: 0 });
    setNow('2026-11-01T04:30:00Z');
  });
});

describe('admin list (8.14)', () => {
  it('lists pending requests with masked mobile, documents and approvalRequestId', async () => {
    approvalStub.mode = 'manual';
    const s = await residentsSociety();
    await ownerOf(s);
    const r = await requester();
    await submit(
      r,
      await joinBody(s, r.user.id, {
        relation: 'CO_OWNER',
        agreementStart: undefined,
        agreementEnd: undefined,
      }),
    );
    const list = await s.c('get', '/join-requests');
    expect(list.body.pagination.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({
      requesterName: 'Pallavi Naik',
      name: 'Pallavi Naik',
      relation: 'CO_OWNER',
      unitLabel: 'A-1203',
      status: 'PENDING_ADMIN',
      documentsReceived: 2,
      version: 2,
    });
    expect(list.body.data[0].documents).toHaveLength(2);
    expect(list.body.data[0].approvalRequestId).toBeGreaterThan(0);
    expect(
      (await s.c('get', '/join-requests', undefined, { query: { status: 'APPROVED' } })).body.data,
    ).toEqual([]);
  });
});
