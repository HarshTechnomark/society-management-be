import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import { Society, Ticket, TicketUpvote, closeDb, sequelize } from '../../../src/models';
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';
import { lifecycleColumns } from '../../helpers/access';
import { helpdeskHttp, idem, resetHelpdesk } from '../../helpers/helpdesk';

afterAll(async () => {
  await closeDb();
});
beforeEach(resetHelpdesk);

describe('building issues for the four audiences', () => {
  it('T15-10, T15-11, T15-12: report, similar 409, duplicate reason, similar list, Me too rules, comments, locations', async () => {
    const w = await helpdeskHttp();
    const lift = await w.cat('Lift');
    const noise = await w.cat('Noise');
    const plumbing = await w.cat('Plumbing');
    const body = {
      locationNodeId: w.buildingA.locationNodeId,
      categoryId: lift.id,
      urgency: 'EMERGENCY',
      description: 'Lift stopped at ground floor',
    };

    // guard report: the minimal shape, channel GATE
    const g = await w.guard('post', '/gate/building-issues', body, { headers: idem() });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect(Object.keys(g.body.data).sort()).toEqual([
      'affectedUnitCount',
      'id',
      'priority',
      'status',
      'ticketNo',
    ]);
    expect(g.body.data.affectedUnitCount).toBe(2);
    expect(g.body.data.priority).toBe('P1');
    const row = await Ticket.findByPk(g.body.data.id);
    expect(row).toMatchObject({ channel: 'GATE', reporterRole: 'GUARD', kind: 'BUILDING' });

    // the second report at the same node and category is refused with the first id (T15-11), from the resident app and from staff
    const dup = await w.res('post', '/me/building-issues', body, { headers: idem() });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('SIMILAR_ISSUE_EXISTS');
    expect(dup.body.errors).toEqual([{ field: 'ticketId', message: String(g.body.data.id) }]);
    expect((await w.staff('post', '/work/building-issues', body, { headers: idem() })).status).toBe(409);

    // the check before submit (8.11), for each audience; a tower B resident sees the match too because it affects only tower A? (no: not visible, not the same node)
    const q = `locationNodeId=${w.buildingA.locationNodeId}&categoryId=${lift.id}`;
    const s1 = await w.res('get', `/me/building-issues/similar?${q}`);
    expect(s1.status).toBe(200);
    expect(s1.body.data.items).toHaveLength(1);
    expect(s1.body.data.items[0]).toMatchObject({
      id: g.body.data.id,
      iUpvoted: false,
      isRequester: false,
      locationLabel: expect.any(String),
    });
    expect((await w.guard('get', `/gate/building-issues/similar?${q}`)).body.data.items).toHaveLength(1);
    expect((await w.staff('get', `/work/building-issues/similar?${q}`)).body.data.items).toHaveLength(1);
    expect(
      (await w.res('get', `/me/building-issues/similar?locationNodeId=999999&categoryId=${lift.id}`)).status,
    ).toBe(404);
    expect(
      (
        await w.res(
          'get',
          `/me/building-issues/similar?locationNodeId=${w.buildingA.locationNodeId}&categoryId=999999`,
        )
      ).body.code,
    ).toBe('CATEGORY_NOT_FOUND');
    expect((await w.res('get', `/me/building-issues/similar?${q}&q=a`)).status).toBe(400);

    // with a reason the report goes through; the resident gets the redacted DTO and the flat count message
    const ok = await w.resC(
      'post',
      '/me/building-issues',
      { ...body, duplicateReason: 'This is a different lift in the tower' },
      { headers: idem() },
    );
    expect(ok.status).toBe(201);
    expect(ok.body.message).toMatch(/2 flats will get updates/);
    expect(ok.body.data.myRelation).toBe('REQUESTER');
    expect(ok.body.data).not.toHaveProperty('requester');
    const issueId = ok.body.data.id as number;

    // BR-15-49: another resident sees a role label, not names
    const asOther = await w.res('get', `/me/tickets/${g.body.data.id}`);
    expect(asOther.status).toBe(200);
    expect(asOther.body.data.reporterLabel).toBe('Security');
    expect(asOther.body.data.myRelation).toBe('AFFECTED');
    const asOther2 = await w.res('get', `/me/tickets/${issueId}`);
    expect(asOther2.body.data.reporterLabel).toBe('A resident');
    expect(JSON.stringify(asOther2.body.data)).not.toContain('Chetan');

    // permissions across apps
    expect((await w.guard('post', '/me/building-issues', body, { headers: idem() })).status).toBe(403);
    expect((await w.res('post', '/gate/building-issues', body, { headers: idem() })).status).toBe(403);
    expect((await w.guard('post', '/work/building-issues', body, { headers: idem() })).status).toBe(403);
    expect(
      (
        await w.res(
          'post',
          '/me/building-issues',
          { ...body, categoryId: noise.id, urgency: 'URGENT' },
          { headers: idem() },
        )
      ).status,
    ).toBe(422); // Noise is for flats only

    // Me too (T15-12): twice, by the requester, on a personal complaint
    const t1 = await w.res(
      'post',
      `/me/tickets/${issueId}/upvote`,
      { note: 'Same here, door stuck' },
      { headers: idem() },
    );
    expect(t1.status).toBe(201);
    expect(t1.body.data).toEqual({ ticketId: issueId, upvoteCount: 1, iUpvoted: true });
    const t2 = await w.res('post', `/me/tickets/${issueId}/upvote`, {}, { headers: idem() });
    expect(t2.status).toBe(409);
    expect(t2.body.code).toBe('ALREADY_UPVOTED');
    const own = await w.resC('post', `/me/tickets/${issueId}/upvote`, {}, { headers: idem() });
    expect(own.status).toBe(422);
    expect(own.body.code).toBe('UPVOTE_OWN_TICKET');
    const personal = await w.res(
      'post',
      '/me/tickets',
      {
        unitId: w.a101,
        categoryId: plumbing.id,
        title: 'Sink blocked',
        description: 'The kitchen sink is blocked',
      },
      { headers: idem() },
    );
    const pu = await w.res('post', `/me/tickets/${personal.body.data.id}/upvote`, {}, { headers: idem() });
    expect(pu.body.code).toBe('UPVOTE_NOT_BUILDING_ISSUE');
    // the note became a public comment; a non-upvoter of tower B cannot comment (not visible at all on Starter-like scope? it is a BUILDING-level issue of tower A)
    const comments = await w.resC('get', `/me/tickets/${issueId}/comments`);
    expect(comments.body.data.some((c: { body: string }) => c.body === 'Same here, door stuck')).toBe(true);
    const asB = await w.resB('get', `/me/tickets/${issueId}`);
    expect(asB.status).toBe(200); // PREMIUM has the community board (BR-15-50)
    const cb = await w.resB(
      'post',
      `/me/tickets/${issueId}/comments`,
      { body: 'Is it fixed?' },
      { headers: idem() },
    );
    expect(cb.status).toBe(422);
    expect(cb.body.code).toBe('COMMENT_NOT_ALLOWED');
    // removal of the Me too
    const del = await w.res('delete', `/me/tickets/${issueId}/upvote`);
    expect(del.status).toBe(200);
    expect(del.body.data).toEqual({ ticketId: issueId, upvoteCount: 0, iUpvoted: false });
    expect((await w.res('delete', `/me/tickets/${issueId}/upvote`)).body.code).toBe('UPVOTE_NOT_FOUND');
    expect(await TicketUpvote.count({ where: { ticketId: issueId } })).toBe(0);

    // the lists: near me, board, resolved
    const near = await w.res('get', '/me/building-issues');
    expect(near.status).toBe(200);
    expect(near.body.data.items.map((i: { id: number }) => i.id).sort()).toEqual(
      [g.body.data.id, issueId].sort(),
    );
    expect(near.body.pagination.total).toBe(2);
    const nearB = await w.resB('get', '/me/building-issues');
    expect(nearB.body.data.items).toHaveLength(0);
    const board = await w.resB('get', '/me/building-issues?scope=ALL');
    expect(board.body.data.items).toHaveLength(2);
    expect((await w.res('get', '/me/building-issues?status=RESOLVED')).body.data.items).toHaveLength(0);

    // locations are readable by resident, guard and staff without QR tokens; the admin still gets them
    for (const c of [w.res, w.guard, w.staff]) {
      const l = await c('get', '/locations');
      expect(l.status).toBe(200);
      expect(JSON.stringify(l.body.data)).not.toContain('qrToken');
      expect(l.body.data.items.length).toBeGreaterThan(0);
    }
    const [{ n }] = await sequelize.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM tickets WHERE societyId = ? AND channel = ?',
      { replacements: [w.sid, 'GATE'], type: QueryTypes.SELECT },
    );
    expect(Number(n)).toBe(1);
  }, 180_000);

  it('T15-36: a suspended society keeps the safety channel and refuses personal complaints', async () => {
    const w = await helpdeskHttp();
    const lift = await w.cat('Lift');
    const plumbing = await w.cat('Plumbing');
    const issue = await w.resC(
      'post',
      '/me/building-issues',
      { locationNodeId: w.buildingA.locationNodeId, categoryId: lift.id, urgency: 'URGENT' },
      { headers: idem() },
    );
    expect(issue.status).toBe(201);
    const personal = await w.res(
      'post',
      '/me/tickets',
      { unitId: w.a101, categoryId: plumbing.id, title: 'Tap leaking', description: 'The tap leaks all day' },
      { headers: idem() },
    );
    expect(personal.status).toBe(201);
    await Society.update(lifecycleColumns('SUSPENDED') as never, { where: { id: w.sid } });
    await flushAcl();

    // building issue: report (guard and resident), Me too, comment, remove Me too
    const g = await w.guard(
      'post',
      '/gate/building-issues',
      { locationNodeId: w.buildingB.locationNodeId, categoryId: lift.id, urgency: 'URGENT' },
      { headers: idem() },
    );
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    const r1 = await w.res(
      'post',
      '/me/building-issues',
      {
        locationNodeId: w.buildingA.locationNodeId,
        categoryId: lift.id,
        urgency: 'URGENT',
        duplicateReason: 'Another lift of the tower',
      },
      { headers: idem() },
    );
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const mt = await w.res('post', `/me/tickets/${issue.body.data.id}/upvote`, {}, { headers: idem() });
    expect(mt.status).toBe(201);
    expect(
      (
        await w.res(
          'post',
          `/me/tickets/${issue.body.data.id}/comments`,
          { body: 'Still stuck' },
          { headers: idem() },
        )
      ).status,
    ).toBe(201);
    expect((await w.res('delete', `/me/tickets/${issue.body.data.id}/upvote`)).status).toBe(200);

    // personal complaints: raise, comment (423 SOCIETY_SUSPENDED); reads stay open
    const p = await w.res(
      'post',
      '/me/tickets',
      {
        unitId: w.a101,
        categoryId: plumbing.id,
        title: 'Another leak',
        description: 'A new leak in the hall',
      },
      { headers: idem() },
    );
    expect(p.status).toBe(423);
    expect(p.body.code).toBe('SOCIETY_SUSPENDED');
    const pc = await w.res(
      'post',
      `/me/tickets/${personal.body.data.id}/comments`,
      { body: 'Please hurry' },
      { headers: idem() },
    );
    expect(pc.status).toBe(423);
    expect(pc.body.code).toBe('SOCIETY_SUSPENDED');
    expect(
      (
        await w.res('post', `/me/tickets/${personal.body.data.id}/cancel`, {
          reason: 'Not needed now',
          version: 1,
        })
      ).status,
    ).toBe(423);
    expect((await w.res('get', `/me/tickets/${personal.body.data.id}`)).status).toBe(200);
  }, 180_000);
});
