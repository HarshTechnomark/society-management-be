import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Ticket, TicketUpvote, closeDb, sequelize } from '../../../src/models';
import { assignTicket } from '../../../src/modules/helpdesk/helpdesk.routing';
import { transitionTicket } from '../../../src/modules/helpdesk/helpdesk.tickets.transition';
import { userActor } from '../../../src/modules/helpdesk/helpdesk.shared';
import { helpdeskHttp, idem, resetHelpdesk, ticketPhoto, type HelpdeskHttp } from '../../helpers/helpdesk';

afterAll(async () => {
  await closeDb();
});
beforeEach(resetHelpdesk);

const run = <T>(fn: (t: import('sequelize').Transaction) => Promise<T>) => sequelize.transaction(fn);

/** Admin side through the core: assign to the facility manager, start, and optionally resolve. */
async function work(w: HelpdeskHttp, id: number, upTo: 'START' | 'RESOLVE') {
  const admin = userActor(w.admin, new Set(['ADMIN']), 'ADMIN');
  await run(t => assignTicket(w.admin, id, admin, { type: 'MEMBER', userId: w.fm.id }, t));
  await run(t => transitionTicket(w.admin, id, admin, { action: 'START' }, t));
  if (upTo === 'RESOLVE')
    await run(t =>
      transitionTicket(
        w.admin,
        id,
        admin,
        { action: 'RESOLVE', note: 'Fixed the problem fully', fileIds: [ticketPhoto(w.sid, w.adminId)] },
        t,
      ),
    );
}

async function raise(w: HelpdeskHttp, category: string, title: string) {
  const cat = await w.cat(category);
  const r = await w.res(
    'post',
    '/me/tickets',
    { unitId: w.a101, categoryId: cat.id, title, description: `${title}, please look into it` },
    { headers: idem() },
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: number; version: number };
}

describe('resident actions on personal complaints', () => {
  it('confirm with rating, rating rules, reopen window and cancel', async () => {
    const w = await helpdeskHttp();
    const t1 = await raise(w, 'Plumbing', 'Tap leaking badly');

    // too early for everything but cancel and comment
    const early = await w.res('post', `/me/tickets/${t1.id}/confirm`, { version: t1.version });
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('TICKET_INVALID_TRANSITION');
    expect((await w.res('post', `/me/tickets/${t1.id}/rating`, { score: 5 })).body.code).toBe(
      'INVALID_STATE',
    );
    expect(
      (await w.res('post', `/me/tickets/${t1.id}/escalate`, { reason: 'Nobody came to see it' })).body.code,
    ).toBe('ESCALATION_NOT_ALLOWED');
    // a family member is not the requester: no cancel
    const famCancel = await w.fam('post', `/me/tickets/${t1.id}/cancel`, {
      reason: 'No longer needed',
      version: t1.version,
    });
    expect(famCancel.status).toBe(403);
    expect(famCancel.body.code).toBe('PERMISSION_DENIED');
    expect(
      (await w.res('post', `/me/tickets/${t1.id}/cancel`, { reason: 'x', version: t1.version })).status,
    ).toBe(400);

    await work(w, t1.id, 'RESOLVE');
    const d = await w.res('get', `/me/tickets/${t1.id}`);
    expect(d.body.data.status).toBe('RESOLVED');
    expect(d.body.data.allowedActions.sort()).toEqual(['COMMENT', 'CONFIRM', 'RATE', 'REOPEN']);
    expect(d.body.data.assignment.assigneeLabel).toBeTruthy();

    // the family member may confirm but not rate (BR-15-56); the failed confirm leaves the ticket RESOLVED
    const famRate = await w.fam('post', `/me/tickets/${t1.id}/rating`, { score: 4 });
    expect(famRate.status).toBe(422);
    expect(famRate.body.code).toBe('RATING_NOT_ALLOWED');
    const famConfirm = await w.fam('post', `/me/tickets/${t1.id}/confirm`, {
      version: d.body.data.version,
      score: 4,
    });
    expect(famConfirm.body.code).toBe('RATING_NOT_ALLOWED');
    expect((await Ticket.findByPk(t1.id))!.status).toBe('RESOLVED');
    const stale = await w.res('post', `/me/tickets/${t1.id}/confirm`, { version: d.body.data.version - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');

    // BR-15-57: confirm closes and rates in one go
    const c = await w.res('post', `/me/tickets/${t1.id}/confirm`, {
      version: d.body.data.version,
      score: 5,
      comment: 'Great work',
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.data.status).toBe('CLOSED');
    expect(c.body.data.csat).toEqual({ score: 5, avg: 5, count: 1 });
    expect(c.body.data.myRating).toBe(5);
    expect(c.body.data.allowedActions).not.toContain('RATE');
    expect((await Ticket.findByPk(t1.id))!.closeSource).toBe('RESIDENT');
    expect(await AuditLog.count({ where: { societyId: w.sid, action: 'helpdesk.ticket.closed' } })).toBe(1);
    expect(await AuditLog.count({ where: { societyId: w.sid, action: 'helpdesk.ticket.rated' } })).toBe(1);
    // re-rating replaces the first rating
    const re = await w.res('post', `/me/tickets/${t1.id}/rating`, { score: 3 });
    expect(re.body.data).toEqual({ score: 3, csatAvg: 3, csatCount: 1 });

    // reopen from CLOSED inside the window: the facility manager keeps the ticket (ASSIGNED, cycle 2)
    const ro = await w.res('post', `/me/tickets/${t1.id}/reopen`, {
      reason: 'It is leaking again',
      version: (await Ticket.findByPk(t1.id))!.version,
    });
    expect(ro.status, JSON.stringify(ro.body)).toBe(200);
    expect(ro.body.data.status).toBe('ASSIGNED');
    expect(ro.body.data.reopenCount).toBe(1);
    // rating after the window
    const t2 = await raise(w, 'Electrical', 'Switch sparks sometimes');
    await work(w, t2.id, 'RESOLVE');
    await sequelize.query(
      'UPDATE tickets SET resolvedAt = DATE_SUB(resolvedAt, INTERVAL 8 DAY) WHERE id = ?',
      { replacements: [t2.id] },
    );
    const late = await w.res('post', `/me/tickets/${t2.id}/reopen`, {
      reason: 'Broke again today',
      version: (await Ticket.findByPk(t2.id))!.version,
    });
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('REOPEN_WINDOW_EXPIRED');
    expect((await w.res('post', `/me/tickets/${t2.id}/rating`, { score: 2 })).body.code).toBe(
      'RATING_WINDOW_EXPIRED',
    );
    expect((await w.res('get', `/me/tickets/${t2.id}`)).body.data.allowedActions.sort()).toEqual([
      'COMMENT',
      'CONFIRM',
    ]);

    // cancel while OPEN
    const t3 = await raise(w, 'Noise', 'Loud music at night');
    const cn = await w.res('post', `/me/tickets/${t3.id}/cancel`, {
      reason: 'Neighbour agreed to stop',
      version: t3.version,
    });
    expect(cn.status).toBe(200);
    expect(cn.body.data.status).toBe('CANCELLED');
    expect(cn.body.data.allowedActions).toEqual([]);
    expect(
      (await w.res('post', `/me/tickets/${t3.id}/comments`, { body: 'Thanks' }, { headers: idem() })).body
        .code,
    ).toBe('INVALID_STATE');
  }, 240_000);

  it('T15-19: estimate decision by an owner, refused for a family member; escalation after a breach', async () => {
    const w = await helpdeskHttp();
    const t1 = await raise(w, 'Carpentry', 'Wardrobe door hinge broken');
    await work(w, t1.id, 'START');
    await sequelize.query(
      `UPDATE tickets SET status = 'WAITING_ON_RESIDENT', waitingReason = 'ESTIMATE_APPROVAL', slaPausedAt = NOW(3), chargeStatus = 'ESTIMATE_SENT',
        chargeEstimatePaise = 65000, chargeEstimateNote = 'Hinge and labour', isChargeable = 1 WHERE id = ?`,
      { replacements: [t1.id] },
    );
    const d = await w.res('get', `/me/tickets/${t1.id}`);
    expect(d.body.data.charge).toMatchObject({
      status: 'ESTIMATE_SENT',
      estimatePaise: 65000,
      estimateNote: 'Hinge and labour',
    });
    expect(d.body.data.canDecideEstimate).toBe(true);
    expect((await w.fam('get', `/me/tickets/${t1.id}`)).body.data.canDecideEstimate).toBe(false);
    expect(d.body.data.canRate).toBe(false);
    // a comment does not resume an estimate wait (BR-15-43)
    await w.res('post', `/me/tickets/${t1.id}/comments`, { body: 'Please go ahead' }, { headers: idem() });
    expect((await Ticket.findByPk(t1.id))!.status).toBe('WAITING_ON_RESIDENT');

    const fam = await w.fam('post', `/me/tickets/${t1.id}/estimate-decision`, {
      decision: 'APPROVE',
      version: (await Ticket.findByPk(t1.id))!.version,
    });
    expect(fam.status).toBe(403);
    expect(fam.body.code).toBe('ESTIMATE_APPROVER_NOT_ALLOWED');
    const v = (await Ticket.findByPk(t1.id))!.version;
    expect(
      (await w.res('post', `/me/tickets/${t1.id}/estimate-decision`, { decision: 'APPROVE', version: v - 1 }))
        .body.code,
    ).toBe('STALE_VERSION');
    const ok = await w.res('post', `/me/tickets/${t1.id}/estimate-decision`, {
      decision: 'APPROVE',
      comment: 'Fine',
      version: v,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('IN_PROGRESS');
    expect(ok.body.data.charge.status).toBe('APPROVED');
    expect(
      await AuditLog.count({ where: { societyId: w.sid, action: 'helpdesk.ticket.estimate_decided' } }),
    ).toBe(1);
    const again = await w.res('post', `/me/tickets/${t1.id}/estimate-decision`, {
      decision: 'REJECT',
      version: ok.body.data.version,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_STATE');

    // escalation (BR-15-58): refused until a due time passes, then once in 24 hours
    const t2 = await raise(w, 'Plumbing', 'Water heater not working');
    expect(
      (await w.res('post', `/me/tickets/${t2.id}/escalate`, { reason: 'Nobody has come yet' })).body.code,
    ).toBe('ESCALATION_NOT_ALLOWED');
    await sequelize.query(
      'UPDATE tickets SET responseDueAt = DATE_SUB(NOW(3), INTERVAL 1 HOUR), responseBreached = 1 WHERE id = ?',
      { replacements: [t2.id] },
    );
    const esc = await w.res('post', `/me/tickets/${t2.id}/escalate`, { reason: 'Nobody has come yet' });
    expect(esc.status, JSON.stringify(esc.body)).toBe(200);
    expect(esc.body.data.escalationRequestedAt).toBeTruthy();
    expect(
      (await w.res('post', `/me/tickets/${t2.id}/escalate`, { reason: 'Still nobody came' })).body.code,
    ).toBe('ESCALATION_TOO_SOON');
    expect(
      (await w.resB('post', `/me/tickets/${t2.id}/escalate`, { reason: 'Not my flat at all' })).status,
    ).toBe(404);
    expect(
      await AuditLog.count({
        where: { societyId: w.sid, action: 'helpdesk.ticket.escalated', reason: 'Nobody has come yet' },
      }),
    ).toBe(1);
  }, 240_000);
});

describe('resident actions on building issues', () => {
  it('cancel with upvotes, who may confirm and reopen, ratings of requester and upvoter', async () => {
    const w = await helpdeskHttp();
    const lift = await w.cat('Lift');
    const r = await w.res(
      'post',
      '/me/building-issues',
      { locationNodeId: w.buildingA.locationNodeId, categoryId: lift.id, urgency: 'URGENT' },
      { headers: idem() },
    );
    const id = r.body.data.id as number;
    // an upvoter blocks the requester's cancel (BR-15-42) and may not confirm
    await w.resC('post', `/me/tickets/${id}/upvote`, {}, { headers: idem() });
    const cn = await w.res('post', `/me/tickets/${id}/cancel`, {
      reason: 'It works again',
      version: (await Ticket.findByPk(id))!.version,
    });
    expect(cn.status).toBe(422);
    expect(cn.body.code).toBe('TICKET_HAS_UPVOTES');
    expect((await w.res('get', `/me/tickets/${id}`)).body.data.allowedActions).not.toContain('CANCEL');
    expect(
      (await w.resC('post', `/me/tickets/${id}/cancel`, { reason: 'Not mine to cancel', version: 3 })).body
        .code,
    ).toBe('PERMISSION_DENIED');
    // a resident who only lives in the tower (no Me too) cannot act at all
    expect(
      (await w.resB('post', `/me/tickets/${id}/reopen`, { reason: 'Not affected at all', version: 1 }))
        .status,
    ).toBeGreaterThanOrEqual(403);

    await work(w, id, 'RESOLVE');
    const v = (await Ticket.findByPk(id))!.version;
    const up = await w.resC('get', `/me/tickets/${id}`);
    expect(up.body.data.allowedActions.sort()).toEqual(['COMMENT', 'RATE', 'REOPEN']);
    const conf = await w.resC('post', `/me/tickets/${id}/confirm`, { version: v });
    expect(conf.status).toBe(403);
    expect(conf.body.code).toBe('PERMISSION_DENIED');
    expect((await w.resC('post', `/me/tickets/${id}/rating`, { score: 2, comment: 'Slow' })).status).toBe(
      200,
    );
    const mine = await w.res('post', `/me/tickets/${id}/confirm`, {
      version: (await Ticket.findByPk(id))!.version,
      score: 5,
    });
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    // the average covers the requester and the upvoter (5 and 2: 3.5)
    expect(mine.body.data.csat).toEqual({ score: 5, avg: 3.5, count: 2 });
    expect((await TicketUpvote.findOne({ where: { ticketId: id }, raw: true }))!.csatScore).toBe(2);
    // an upvoter may reopen
    const ro = await w.resC('post', `/me/tickets/${id}/reopen`, {
      reason: 'The lift stopped again',
      version: mine.body.data.version,
    });
    expect(ro.status, JSON.stringify(ro.body)).toBe(200);
    expect(ro.body.data.reopenCount).toBe(1);
  }, 240_000);
});
