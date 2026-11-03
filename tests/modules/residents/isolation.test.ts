import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { JoinRequest, MoveRequest, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { approvalStub, rejectRequest } from '../../../src/modules/residents/residents.public';
import { systemCtx } from '../../../src/types/context';
import { as, login, memberUser } from '../../helpers/access';
import { makeUser } from '../../helpers/auth';
import {
  activeTenancy,
  docItem,
  idemKey,
  ownerOf,
  residentsSociety,
  resetResidentsP2,
} from '../../helpers/residents-p2';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetResidentsP2);

describe('T09-46 tenant isolation for tenancies, join requests and moves', () => {
  it("society A's admin gets 404 with the entity code for every id of society B", async () => {
    const a = await residentsSociety();
    const b = await residentsSociety();
    await ownerOf(b);
    const t = await activeTenancy(b);
    const mv = await b.c(
      'post',
      '/move-requests',
      {
        unitId: b.unit.id,
        type: 'MOVE_IN',
        householdOf: 'OWNER',
        moveDate: '2026-11-04',
        slotStart: '10:00',
        slotEnd: '14:00',
      },
      { headers: idemKey() },
    );
    expect(mv.status, JSON.stringify(mv.body)).toBe(201);
    approvalStub.mode = 'manual';
    const asker = await makeUser({ name: 'Faisal Khan', mobile: '9820000031' });
    const rc = as(await login(asker, { app: 'RESIDENT' }), 'RESIDENT');
    const jr = await rc(
      'post',
      '/me/join-requests',
      {
        societyCode: b.society.slug,
        unitId: b.unit.id,
        relation: 'CO_OWNER',
        fileIds: [
          await docItem(b.society.id!, asker.id, 'AADHAAR'),
          await docItem(b.society.id!, asker.id, 'SALE_DEED'),
        ],
      },
      { headers: idemKey() },
    );
    expect(jr.status, JSON.stringify(jr.body)).toBe(201);
    const tid = t.id;
    const mid = mv.body.data.id;
    const jid = jr.body.data.id;
    const body = { version: 1, reason: 'Reasons given here' };
    const cases: [string, string, unknown, string][] = [
      ['get', `/tenancies/${tid}`, undefined, 'TENANCY_NOT_FOUND'],
      ['patch', `/tenancies/${tid}`, { version: 1, occupantCount: 2 }, 'TENANCY_NOT_FOUND'],
      ['post', `/tenancies/${tid}/submit`, { version: 1 }, 'TENANCY_NOT_FOUND'],
      ['post', `/tenancies/${tid}/approve`, { version: 1 }, 'TENANCY_NOT_FOUND'],
      ['post', `/tenancies/${tid}/reject`, body, 'TENANCY_NOT_FOUND'],
      ['post', `/tenancies/${tid}/activate`, { version: 1, moveInDate: '2026-11-01' }, 'TENANCY_NOT_FOUND'],
      ['post', `/tenancies/${tid}/renew`, { version: 1, agreementEnd: '2028-01-01' }, 'TENANCY_NOT_FOUND'],
      [
        'post',
        `/tenancies/${tid}/end`,
        { version: 1, endedOn: '2026-11-01', endReason: 'OTHER' },
        'TENANCY_NOT_FOUND',
      ],
      ['post', `/tenancies/${tid}/cancel`, body, 'TENANCY_NOT_FOUND'],
      [
        'patch',
        `/tenancies/${tid}/police-verification`,
        { version: 1, status: 'SUBMITTED' },
        'TENANCY_NOT_FOUND',
      ],
      ['get', `/join-requests/${jid}`, undefined, 'JOIN_REQUEST_NOT_FOUND'],
      ['get', `/move-requests/${mid}`, undefined, 'MOVE_REQUEST_NOT_FOUND'],
      ['patch', `/move-requests/${mid}`, { version: 1, helperCount: 2 }, 'MOVE_REQUEST_NOT_FOUND'],
      ['post', `/move-requests/${mid}/recheck-dues`, { version: 1 }, 'MOVE_REQUEST_NOT_FOUND'],
      ['post', `/move-requests/${mid}/override-dues`, body, 'MOVE_REQUEST_NOT_FOUND'],
      ['post', `/move-requests/${mid}/start`, { version: 1 }, 'MOVE_REQUEST_NOT_FOUND'],
      ['post', `/move-requests/${mid}/complete`, { version: 1 }, 'MOVE_REQUEST_NOT_FOUND'],
      [
        'post',
        `/move-requests/${mid}/inspection`,
        { version: 1, result: 'PASSED', damageDeductionPaise: 0, note: 'All fine here' },
        'MOVE_REQUEST_NOT_FOUND',
      ],
      ['post', `/move-requests/${mid}/cancel`, body, 'MOVE_REQUEST_NOT_FOUND'],
    ];
    for (const [m, path, payload, code] of cases) {
      const r = await a.c(m as 'get', path, payload, { headers: idemKey() });
      expect(r.status, `${m} ${path} ${JSON.stringify(r.body)}`).toBe(404);
      expect(r.body.code, `${m} ${path}`).toBe(code);
    }
    // the guard of society A cannot start society B's move either
    expect((await a.c('get', '/join-requests')).body.data).toEqual([]);
    expect((await a.c('get', '/tenancies')).body.data).toEqual([]);
    expect((await a.c('get', '/move-requests')).body.data).toEqual([]);
    // resident routes: the owner of A sees nothing of B
    const ownerA = await ownerOf(a, '9820000041');
    for (const [m, path, payload, code] of [
      ['get', `/me/tenancies/${tid}`, undefined, 'TENANCY_NOT_FOUND'],
      ['post', `/me/tenancies/${tid}/submit`, { version: 1 }, 'TENANCY_NOT_FOUND'],
      ['post', `/me/tenancies/${tid}/cancel`, body, 'TENANCY_NOT_FOUND'],
      ['post', `/me/household/join-requests/${jid}/confirm`, { version: 1 }, 'JOIN_REQUEST_NOT_FOUND'],
      ['post', `/me/household/join-requests/${jid}/decline`, body, 'JOIN_REQUEST_NOT_FOUND'],
      ['get', `/me/move-requests/${mid}`, undefined, 'MOVE_REQUEST_NOT_FOUND'],
      ['patch', `/me/move-requests/${mid}`, { version: 1, helperCount: 2 }, 'MOVE_REQUEST_NOT_FOUND'],
      ['post', `/me/move-requests/${mid}/recheck-dues`, { version: 1 }, 'MOVE_REQUEST_NOT_FOUND'],
      ['post', `/me/move-requests/${mid}/owner-confirm`, { version: 1 }, 'MOVE_REQUEST_NOT_FOUND'],
      ['post', `/me/move-requests/${mid}/owner-decline`, body, 'MOVE_REQUEST_NOT_FOUND'],
      ['post', `/me/move-requests/${mid}/cancel`, body, 'MOVE_REQUEST_NOT_FOUND'],
    ] as [string, string, unknown, string][]) {
      const r = await ownerA.c(m as 'get', path, payload, { headers: idemKey() });
      expect(r.body.code, `${m} ${path}`).toBe(code);
    }
    const guard = await memberUser(a.society, 'guard', { name: 'Guard A' });
    const gc = as(await login(guard, { app: 'GATE' }), 'GATE');
    for (const act of ['start', 'complete']) {
      const r = await gc(
        'post',
        `/gate/move-requests/${mid}/${act}`,
        act === 'start' ? { version: 1, gatePassCode: 'AAAAAAAA' } : { version: 1 },
      );
      expect([r.status, r.body.code], act).toEqual([404, 'MOVE_REQUEST_NOT_FOUND']);
    }
    // a join request of B is untouched by all of it
    expect((await JoinRequest.findByPk(jid))!.status).toBe('PENDING_ADMIN');
    expect((await MoveRequest.findByPk(mid))!.status).toBe('APPROVED');
  });

  it('a move rejected through the module 14 hook is REJECTED with the reason (hook: rejectRequest)', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    approvalStub.mode = 'manual';
    const r = await s.c(
      'post',
      '/move-requests',
      {
        unitId: s.unit.id,
        type: 'MOVE_IN',
        householdOf: 'OWNER',
        moveDate: '2026-11-04',
        slotStart: '10:00',
        slotEnd: '14:00',
      },
      { headers: idemKey() },
    );
    const row = (await MoveRequest.findByPk(r.body.data.id))!;
    await rejectRequest(row.approvalRequestId!, 'Lift is under repair', systemCtx('t'));
    expect(await MoveRequest.findByPk(row.id!)).toMatchObject({
      status: 'REJECTED',
      decisionReason: 'Lift is under repair',
    });
  });
});
