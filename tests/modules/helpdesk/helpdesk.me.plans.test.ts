import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { LocationNode, Ticket, closeDb } from '../../../src/models';
import { helpdeskHttp, idem, resetHelpdesk } from '../../helpers/helpdesk';
import { helpdeskWorld } from '../../helpers/helpdesk';
import { createTicket } from '../../../src/modules/helpdesk/helpdesk.tickets.core';
import { sequelize } from '../../../src/models';

afterAll(async () => {
  await closeDb();
});
beforeEach(resetHelpdesk);

describe('plan gates and visibility by plan', () => {
  it('T15-26, T15-27, T15-23: Starter gates QR, board and transparency; always-on building issues; Tower B FLOOR issue hidden', async () => {
    const w = await helpdeskHttp('STARTER');
    const lift = await w.cat('Lift');
    // plan gates (402) on a Starter society
    const token = (await LocationNode.findByPk(w.buildingA.locationNodeId))!.qrToken;
    const qr = await w.res('get', `/me/building-issues/qr/${token}`);
    expect(qr.status).toBe(402);
    expect(qr.body.code).toBe('FEATURE_NOT_IN_PLAN');
    expect((await w.res('get', '/me/building-issues?scope=ALL')).status).toBe(402);
    expect((await w.res('get', '/me/helpdesk/transparency')).status).toBe(402);
    const withQr = await w.res(
      'post',
      '/me/building-issues',
      { locationNodeId: w.buildingA.locationNodeId, qrToken: token, categoryId: lift.id, urgency: 'NORMAL' },
      { headers: idem() },
    );
    expect(withQr.status).toBe(402);

    // building issues and Me too stay on (always-on keys)
    const issue = await w.resB(
      'post',
      '/me/building-issues',
      {
        locationNodeId: w.buildingB.locationNodeId,
        categoryId: lift.id,
        urgency: 'URGENT',
        affectedLevel: 'BUILDING',
      },
      { headers: idem() },
    );
    expect(issue.status, JSON.stringify(issue.body)).toBe(201);
    // a tower A resident neither sees it nor can agree with it on Starter (no board): 404
    expect((await w.res('get', `/me/tickets/${issue.body.data.id}`)).status).toBe(404);
    expect(
      (await w.res('post', `/me/tickets/${issue.body.data.id}/upvote`, {}, { headers: idem() })).status,
    ).toBe(404);
    // a SOCIETY-wide issue reaches everyone, and Me too works on Starter
    const wide = await w.resB(
      'post',
      '/me/building-issues',
      {
        locationNodeId: w.buildingB.locationNodeId,
        categoryId: lift.id,
        urgency: 'URGENT',
        affectedLevel: 'SOCIETY',
        duplicateReason: 'A different lift problem',
      },
      { headers: idem() },
    );
    expect(wide.status, JSON.stringify(wide.body)).toBe(201);
    const mt = await w.res('post', `/me/tickets/${wide.body.data.id}/upvote`, {}, { headers: idem() });
    expect(mt.status).toBe(201);
    expect(await Ticket.count({ where: { societyId: w.sid } })).toBe(2);
  }, 180_000);

  it('T15-23: the same Tower B issue is readable on Standard (community board); another society stays invisible', async () => {
    const w = await helpdeskHttp('STANDARD');
    const lift = await w.cat('Lift');
    const issue = await w.resB(
      'post',
      '/me/building-issues',
      {
        locationNodeId: w.buildingB.locationNodeId,
        categoryId: lift.id,
        urgency: 'URGENT',
        affectedLevel: 'BUILDING',
      },
      { headers: idem() },
    );
    expect(issue.status).toBe(201);
    const seen = await w.res('get', `/me/tickets/${issue.body.data.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.myRelation).toBe('AFFECTED');
    expect((await w.res('get', '/me/building-issues?scope=ALL')).body.data.items).toHaveLength(1);

    // tenant isolation: a ticket of another society is a 404, in the list and by id
    const other = await helpdeskWorld('STANDARD');
    const cat = await other.cat('Plumbing');
    const foreign = await sequelize.transaction(t =>
      createTicket(
        other.resident,
        {
          kind: 'PERSONAL',
          categoryId: cat.id,
          unitId: other.a101,
          title: 'Foreign leak',
          description: 'A leak in another society',
          channel: 'APP',
          reporterRole: 'RESIDENT',
        },
        t,
      ),
    );
    expect((await w.res('get', `/me/tickets/${foreign.id}`)).status).toBe(404);
    expect((await w.res('get', `/me/tickets/${foreign.id}/comments`)).status).toBe(404);
    expect(
      (await w.res('post', `/me/tickets/${foreign.id}/comments`, { body: 'hello' }, { headers: idem() }))
        .status,
    ).toBe(404);
    expect((await w.res('get', '/me/tickets')).body.data).toHaveLength(0);
  }, 180_000);

  it('QR prefill, report by QR and the transparency figures on Premium', async () => {
    const w = await helpdeskHttp('PREMIUM');
    const other = await w.cat('Other');
    const token = (await LocationNode.findByPk(w.buildingA.locationNodeId))!.qrToken;
    const qr = await w.res('get', `/me/building-issues/qr/${token}`);
    expect(qr.status, JSON.stringify(qr.body)).toBe(200);
    expect(qr.body.data.location.id).toBe(w.buildingA.locationNodeId);
    expect(qr.body.data.suggestedAffectedLevel).toBe('BUILDING');
    expect(qr.body.data.suggestedCategoryIds).toEqual([other.id]);
    expect(qr.body.data.openIssuesHere).toEqual([]);
    expect((await w.res('get', '/me/building-issues/qr/abcdefABCDEF')).body.code).toBe('QR_NOT_FOUND');
    expect((await w.res('get', '/me/building-issues/qr/short')).status).toBe(400);
    const bad = await w.res(
      'post',
      '/me/building-issues',
      { locationNodeId: w.buildingB.locationNodeId, qrToken: token, categoryId: other.id, urgency: 'NORMAL' },
      { headers: idem() },
    );
    expect(bad.status).toBe(400);
    const r = await w.res(
      'post',
      '/me/building-issues',
      { qrToken: token, categoryId: other.id, urgency: 'NORMAL', title: 'Dust in the lobby' },
      { headers: idem() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await Ticket.findByPk(r.body.data.id))!.channel).toBe('QR');
    expect((await w.res('get', `/me/building-issues/qr/${token}`)).body.data.openIssuesHere).toHaveLength(1);

    const tr = await w.res('get', '/me/helpdesk/transparency?months=3');
    expect(tr.status).toBe(200);
    expect(tr.body.data.months.map((m: { month: string }) => m.month)).toEqual([
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
    expect(tr.body.data.months[2]).toMatchObject({
      buildingIssuesRaised: 1,
      resolved: 0,
      medianResolutionHours: null,
      resolutionMetPct: null,
    });
    expect((await w.res('get', '/me/helpdesk/transparency?months=13')).status).toBe(400);
  }, 180_000);
});
