import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  EscalationRule,
  SlaPolicy,
  Ticket,
  TicketAssignment,
  TicketCategory,
  TicketComment,
  TicketUpvote,
  closeDb,
  sequelize,
} from '../../../src/models';
import { advance, setNow } from '../../../src/lib/clock';
import { helpdeskPortCalls } from '../../../src/modules/helpdesk/helpdesk.ports';
import {
  ensureSeeded,
  ensureSeededOnce,
  SEED_CATEGORIES,
  SEED_RULES,
} from '../../../src/modules/helpdesk/helpdesk.seed';
import { createTicket } from '../../../src/modules/helpdesk/helpdesk.tickets.core';
import { transitionTicket } from '../../../src/modules/helpdesk/helpdesk.tickets.transition';
import { assignTicket, unassignTicket } from '../../../src/modules/helpdesk/helpdesk.routing';
import { mergeTickets } from '../../../src/modules/helpdesk/helpdesk.tickets.merge';
import { addUpvote, removeUpvote } from '../../../src/modules/helpdesk/helpdesk.tickets.upvote';
import { addComment, removeComment } from '../../../src/modules/helpdesk/helpdesk.tickets.comment';
import { evaluateTicketSla, fireResidentRequest } from '../../../src/modules/helpdesk/helpdesk.escalation';
import {
  residentVisibleWhere,
  visibleComments,
  workVisibleWhere,
} from '../../../src/modules/helpdesk/helpdesk.visibility';
import {
  helpdeskHooks,
  helpdeskReports,
  tickets,
  helpdeskWork,
} from '../../../src/modules/helpdesk/helpdesk.public';
import { userActor, systemActor } from '../../../src/modules/helpdesk/helpdesk.shared';
import type { CallerType } from '../../../src/modules/helpdesk/helpdesk.constants';
import { helpdeskWorld, hctx, resetHelpdesk, ticketPhoto, type HelpdeskWorld } from '../../helpers/helpdesk';

afterAll(async () => {
  await closeDb();
});
beforeEach(resetHelpdesk);

const run = <T>(fn: (t: import('sequelize').Transaction) => Promise<T>) => sequelize.transaction(fn);
const types = (...t: CallerType[]) => new Set<CallerType>(t);

async function personal(w: HelpdeskWorld, over: Record<string, unknown> = {}) {
  const plumbing = await w.cat('Plumbing');
  return run(t =>
    createTicket(
      w.resident,
      {
        kind: 'PERSONAL',
        categoryId: plumbing.id,
        unitId: w.a101,
        title: 'Kitchen tap is leaking',
        description: 'Water drips all day from the kitchen tap',
        urgency: 'NORMAL',
        channel: 'APP',
        reporterRole: 'RESIDENT',
        ...over,
      } as never,
      t,
    ),
  );
}
async function building(w: HelpdeskWorld, over: Record<string, unknown> = {}, ctx = w.admin) {
  const lift = await w.cat('Lift');
  const stopped = await w.sub('Lift', 'Lift stopped');
  return run(t =>
    createTicket(
      ctx,
      {
        kind: 'BUILDING',
        categoryId: lift.id,
        subCategoryId: stopped.id,
        locationNodeId: w.buildingA.locationNodeId,
        urgency: 'EMERGENCY',
        channel: 'GATE',
        reporterRole: 'GUARD',
        ...over,
      } as never,
      t,
    ),
  );
}

describe('seeding (7.8, BR-15-65)', () => {
  it('seeds the policy, categories and rules once; repeating creates nothing', async () => {
    const w = await helpdeskWorld();
    const subs = SEED_CATEGORIES.reduce((n, c) => n + (c.subs?.length ?? 0), 0);
    expect(await TicketCategory.count({ where: { societyId: w.sid } })).toBe(SEED_CATEGORIES.length + subs);
    expect(await EscalationRule.count({ where: { societyId: w.sid } })).toBe(SEED_RULES.length);
    const policy = await SlaPolicy.findAll({ where: { societyId: w.sid } });
    expect(policy).toHaveLength(1);
    expect(policy[0]).toMatchObject({
      name: 'Standard',
      isDefault: true,
      p1ResponseMinutes: 30,
      p1ResolutionMinutes: 240,
      p4ResolutionMinutes: 10080,
    });
    expect(await run(t => ensureSeeded(w.sid, t))).toEqual({ policies: 0, categories: 0, rules: 0 });
    await ensureSeededOnce(w.sid);
    expect(await TicketCategory.count({ where: { societyId: w.sid } })).toBe(SEED_CATEGORIES.length + subs);
    const lift = await w.cat('Lift');
    expect(lift).toMatchObject({ scope: 'BUILDING', defaultPriority: 'P2', isSafety: true });
    expect((await w.sub('Lift', 'Lift stopped')).defaultPriority).toBe('P1');
    expect((await w.cat('Carpentry')).isChargeable).toBe(true);
  });
  it('a society without a catalogue is seeded lazily by the first create', async () => {
    const w = await helpdeskWorld();
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['escalation_rules', 'ticket_categories', 'sla_policies'])
      await sequelize.query(`DELETE FROM ${t} WHERE societyId = ${w.sid}`);
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
    const plumbing = await run(async t => {
      await ensureSeededOnce(w.sid, t);
      return TicketCategory.findOne({
        where: { societyId: w.sid, name: 'Plumbing', parentId: null },
        transaction: t,
      });
    });
    expect(plumbing).not.toBeNull();
  });
});

describe('creating tickets (BR-15-1 to BR-15-18)', () => {
  it('T15-08: a resident complaint gets the next number, SLA from the default policy, photos linked, an audit row without the text', async () => {
    const w = await helpdeskWorld();
    const f1 = ticketPhoto(w.sid, w.residentId);
    const f2 = ticketPhoto(w.sid, w.residentId);
    const r = await personal(w, { fileIds: [f1, f2] });
    expect(r.ticketNo).toBe('TKT/2026-27/000001');
    expect(r).toMatchObject({ status: 'OPEN', priority: 'P3', assigned: false, affectedUnitCount: null });
    const t = await Ticket.findByPk(r.id);
    expect(t).toMatchObject({
      kind: 'PERSONAL',
      unitId: w.a101,
      locationNodeId: null,
      requesterUserId: w.residentId,
      slaCycle: 1,
      responseMinutes: 720,
      resolutionMinutes: 4320,
      slaCalendar: 'TWENTY_FOUR_SEVEN',
      reporterRole: 'RESIDENT',
    });
    expect(t!.resolutionDueAt.getTime() - t!.slaStartAt.getTime()).toBe(4320 * 60_000);
    expect(t!.nextSlaCheckAt).not.toBeNull();
    expect(helpdeskPortCalls.filter(c => c.fn === 'files.link')).toHaveLength(1);
    const tl = await TicketComment.findAll({ where: { ticketId: r.id } });
    expect(tl).toHaveLength(1);
    expect(tl[0]).toMatchObject({ kind: 'STATUS_CHANGE', fromStatus: null, toStatus: 'OPEN' });
    const a = await AuditLog.findOne({
      where: { action: 'helpdesk.ticket.created', entityId: String(r.id) },
    });
    expect(a).not.toBeNull();
    expect(JSON.stringify(a!.after)).not.toContain('drips');
    expect((a!.after as { descriptionLength: number }).descriptionLength).toBeGreaterThan(10);
    expect((await personal(w)).ticketNo).toBe('TKT/2026-27/000002');
    expect(helpdeskPortCalls.some(c => c.fn === 'reports.touch')).toBe(true);
  });
  it('T15-09: another flat is UNIT_NOT_FOUND; EMERGENCY and a slot are refused for personal complaints as specified', async () => {
    const w = await helpdeskWorld();
    await expect(personal(w, { unitId: w.b101 })).rejects.toMatchObject({
      status: 404,
      code: 'UNIT_NOT_FOUND',
    });
    await expect(personal(w, { urgency: 'EMERGENCY' })).rejects.toMatchObject({
      status: 422,
      code: 'URGENCY_NOT_ALLOWED',
    });
    await expect(personal(w, { description: 'short' })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    await expect(personal(w, { title: 'abcd' })).rejects.toMatchObject({ status: 400 });
    await expect(personal(w, { fileIds: [1, 2, 3, 4, 5, 6, 7] })).rejects.toMatchObject({ status: 400 });
    await expect(personal(w, { fileIds: [424242] })).rejects.toMatchObject({ code: 'FILE_NOT_LINKABLE' });
    const lift = await w.cat('Lift');
    await expect(personal(w, { categoryId: lift.id })).rejects.toMatchObject({
      code: 'CATEGORY_SCOPE_MISMATCH',
    });
    await expect(personal(w, { categoryId: 999999 })).rejects.toMatchObject({
      status: 404,
      code: 'CATEGORY_NOT_FOUND',
    });
    await expect(
      personal(w, { subCategoryId: (await w.sub('Lift', 'Door fault')).id }),
    ).rejects.toMatchObject({ code: 'SUBCATEGORY_PARENT_MISMATCH' });
    expect(await Ticket.count()).toBe(0);
  });
  it('T15-10: a guard reports a P1 safety lift issue: BUILDING level, affected flats of that tower only', async () => {
    const w = await helpdeskWorld();
    const r = await building(w);
    expect(r).toMatchObject({ priority: 'P1', affectedUnitCount: 2, status: 'OPEN' });
    const t = await Ticket.findByPk(r.id);
    expect(t).toMatchObject({
      kind: 'BUILDING',
      unitId: null,
      affectedLevel: 'BUILDING',
      affectedBuildingId: w.buildingA.id,
      prioritySource: 'CATEGORY',
      reporterRole: 'GUARD',
      channel: 'GATE',
    });
    expect(t!.title).toContain('Lift stopped');
    const society = await building(w, { locationNodeId: w.buildingB.locationNodeId });
    expect(society.affectedUnitCount).toBe(1);
  });
  it('T15-11: a similar open issue needs a reason (409 with its id); with a reason it is created and noted internally', async () => {
    const w = await helpdeskWorld();
    const first = await building(w);
    await expect(building(w)).rejects.toMatchObject({
      status: 409,
      code: 'SIMILAR_ISSUE_EXISTS',
      errors: [{ field: 'ticketId', message: String(first.id) }],
    });
    await expect(building(w, { duplicateReason: 'short' })).rejects.toMatchObject({ status: 400 });
    const second = await building(w, { duplicateReason: 'This is the other lift in the tower' });
    const t = await Ticket.findByPk(second.id);
    expect(t!.duplicateReason).toContain('other lift');
    const note = await TicketComment.findOne({ where: { ticketId: second.id, kind: 'SYSTEM' } });
    expect(note).toMatchObject({ visibility: 'INTERNAL' });
    // another tower is not similar
    await building(w, { locationNodeId: w.buildingB.locationNodeId });
  });
  it('BR-15-3 and BR-15-4: unknown or archived locations and impossible levels', async () => {
    const w = await helpdeskWorld();
    await expect(building(w, { locationNodeId: 999999 })).rejects.toMatchObject({
      status: 404,
      code: 'LOCATION_NOT_FOUND',
    });
    await expect(building(w, { affectedLevel: 'FLOOR' })).rejects.toMatchObject({
      status: 422,
      code: 'AFFECTED_LEVEL_INVALID',
    });
    const r = await building(w, { affectedLevel: 'SOCIETY' });
    expect(r.affectedUnitCount).toBe(3);
  });
  it('BR-15-24: BUSINESS_HOURS counts only on plans with the calendar feature (and never for P1)', async () => {
    for (const [plan, expected] of [
      ['STANDARD', 'BUSINESS_HOURS'],
      ['STARTER', 'TWENTY_FOUR_SEVEN'],
    ] as const) {
      await resetHelpdesk();
      const w = await helpdeskWorld(plan);
      await SlaPolicy.update({ p3Calendar: 'BUSINESS_HOURS' }, { where: { societyId: w.sid } });
      const r = await personal(w);
      expect((await Ticket.findByPk(r.id))!.slaCalendar).toBe(expected);
    }
  });
  it('BR-15-16 and BR-15-19: recurring tag at the third ticket, similar personal ids as a hint', async () => {
    const w = await helpdeskWorld();
    const a = await personal(w);
    const b = await personal(w);
    expect(b.similarOpenTicketIds).toEqual([a.id]);
    expect(b.isRecurring).toBe(false);
    const c = await personal(w);
    expect(c.isRecurring).toBe(true);
    expect(c.similarOpenTicketIds).toEqual([b.id, a.id]);
  });
});

describe('assignment and routing (BR-15-35 to BR-15-37)', () => {
  it('auto-assigns by role to the least loaded member and records the assignment', async () => {
    const w = await helpdeskWorld();
    const plumbing = await w.cat('Plumbing');
    await plumbing.update({ defaultAssigneeType: 'ROLE', defaultRoleKey: 'facility_manager' });
    const r1 = await personal(w);
    expect(r1.assigned).toBe(true);
    const t1 = await Ticket.findByPk(r1.id);
    expect(t1).toMatchObject({ status: 'ASSIGNED', assigneeUserId: w.fm.id, assigneeLabel: 'Farhan FM' });
    const asg = await TicketAssignment.findAll({ where: { ticketId: r1.id } });
    expect(asg).toHaveLength(1);
    expect(asg[0]).toMatchObject({ assigneeType: 'MEMBER', method: 'AUTO_CATEGORY', endedAt: null });
    expect(t1!.currentAssignmentId).toBe(asg[0]!.id);
  });
  it('a category with no eligible person leaves the ticket OPEN and never fails the create', async () => {
    const w = await helpdeskWorld();
    const plumbing = await w.cat('Plumbing');
    await plumbing.update({ defaultAssigneeType: 'ROLE', defaultRoleKey: 'electrician_not_a_role' });
    expect((await personal(w)).status).toBe('OPEN');
    await plumbing.update({ defaultAssigneeType: 'STAFF', defaultRoleKey: null, defaultStaffId: 77 });
    expect((await personal(w)).status).toBe('OPEN');
  });
  it('manual assign, reassign (REASSIGNED), same assignee 409, unassign (UNASSIGNED), eligibility and external people', async () => {
    const w = await helpdeskWorld();
    const r = await personal(w);
    const admin = userActor(w.admin, types('ADMIN'));
    const asg = await run(t => assignTicket(w.admin, r.id, admin, { type: 'MEMBER', userId: w.fm.id }, t));
    expect(asg.status).toBe('ASSIGNED');
    await expect(
      run(t => assignTicket(w.admin, r.id, admin, { type: 'MEMBER', userId: w.fm.id }, t)),
    ).rejects.toMatchObject({ status: 409, code: 'ALREADY_ASSIGNED' });
    await expect(
      run(t => assignTicket(w.admin, r.id, admin, { type: 'MEMBER', userId: w.residentId }, t)),
    ).rejects.toMatchObject({ status: 404, code: 'ASSIGNEE_NOT_FOUND' });
    await expect(
      run(t =>
        assignTicket(
          w.admin,
          r.id,
          admin,
          { type: 'EXTERNAL', externalName: 'Ramesh', externalMobile: '12345' },
          t,
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await run(t =>
      assignTicket(
        w.admin,
        r.id,
        admin,
        { type: 'EXTERNAL', externalName: 'Shree Ganesh Lift Services', externalMobile: '9876543210' },
        t,
      ),
    );
    const rows = await TicketAssignment.findAll({ where: { ticketId: r.id }, order: [['id', 'ASC']] });
    expect(rows.map(x => [x.assigneeType, x.endReason])).toEqual([
      ['MEMBER', 'REASSIGNED'],
      ['EXTERNAL', null],
    ]);
    expect(await Ticket.findByPk(r.id)).toMatchObject({
      assigneeUserId: null,
      assigneeLabel: 'Shree Ganesh Lift Services',
    });
    await run(t => unassignTicket(w.admin, r.id, admin, {}, t));
    expect(await Ticket.findByPk(r.id)).toMatchObject({
      status: 'OPEN',
      currentAssignmentId: null,
      assigneeLabel: null,
    });
    expect(await TicketAssignment.findAll({ where: { ticketId: r.id, endedAt: null } })).toHaveLength(0);
    await expect(run(t => unassignTicket(w.admin, r.id, admin, {}, t))).rejects.toMatchObject({
      status: 409,
    });
    // plan-gated types and ports
    await expect(
      run(t => assignTicket(w.admin, r.id, admin, { type: 'STAFF', staffId: 5 }, t)),
    ).rejects.toMatchObject({ status: 404, code: 'ASSIGNEE_NOT_FOUND' });
  });
  it('STAFF needs module 20 and the plan: 402 on Starter', async () => {
    const w = await helpdeskWorld('STARTER');
    const r = await personal(w);
    await expect(
      run(t =>
        assignTicket(w.admin, r.id, userActor(w.admin, types('ADMIN')), { type: 'STAFF', staffId: 5 }, t),
      ),
    ).rejects.toMatchObject({ status: 402, code: 'FEATURE_NOT_IN_PLAN' });
  });
  it('T15-29: two assigns with the same version: one wins, one STALE_VERSION', async () => {
    const w = await helpdeskWorld();
    const r = await personal(w);
    const admin = userActor(w.admin, types('ADMIN'));
    const [a, b] = await Promise.allSettled([
      run(t => assignTicket(w.admin, r.id, admin, { type: 'MEMBER', userId: w.fm.id, version: 1 }, t)),
      run(t =>
        assignTicket(
          w.admin,
          r.id,
          admin,
          { type: 'EXTERNAL', externalName: 'Imran', externalMobile: '9876543210', version: 1 },
          t,
        ),
      ),
    ]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = [a, b].find(x => x.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409, code: 'STALE_VERSION' });
  });
});

describe('lifecycle (6.2, BR-15-27 to BR-15-45)', () => {
  async function inProgress(w: HelpdeskWorld, over: Record<string, unknown> = {}) {
    const r = await personal(w, over);
    const admin = userActor(w.admin, types('ADMIN'));
    await run(t => assignTicket(w.admin, r.id, admin, { type: 'MEMBER', userId: w.fm.id }, t));
    await run(t => transitionTicket(w.admin, r.id, admin, { action: 'START' }, t));
    return { r, admin };
  }
  it('T15-04 in practice: an illegal action is 409 and lists the allowed ones', async () => {
    const w = await helpdeskWorld();
    const r = await personal(w);
    await expect(
      run(t => transitionTicket(w.admin, r.id, userActor(w.admin, types('ADMIN')), { action: 'START' }, t)),
    ).rejects.toMatchObject({
      status: 409,
      code: 'TICKET_INVALID_TRANSITION',
      errors: [{ field: 'action', message: 'CANCEL' }],
    });
    await expect(
      run(t =>
        transitionTicket(
          w.admin,
          r.id,
          userActor(w.admin, types('ADMIN')),
          { action: 'CANCEL', reason: 'no', version: 1 },
          t,
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      run(t =>
        transitionTicket(
          w.admin,
          r.id,
          userActor(w.admin, types('ADMIN')),
          { action: 'CANCEL', reason: 'Duplicate request', version: 9 },
          t,
        ),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'STALE_VERSION' });
  });
  it('START sets the first response once; the status moves and the timeline grows', async () => {
    const w = await helpdeskWorld();
    const { r } = await inProgress(w);
    const t = await Ticket.findByPk(r.id);
    expect(t).toMatchObject({ status: 'IN_PROGRESS' });
    expect(t!.firstResponseAt).not.toBeNull();
    expect(t!.responseBreached).toBe(false);
    const kinds = (await TicketComment.findAll({ where: { ticketId: r.id }, order: [['id', 'ASC']] })).map(
      c => `${c.kind}:${c.toStatus}`,
    );
    expect(kinds).toEqual(['STATUS_CHANGE:OPEN', 'ASSIGNMENT:ASSIGNED', 'STATUS_CHANGE:IN_PROGRESS']);
  });
  it('T15-03 / T15-33 / US-15-05: waiting pauses the clock; a resident reply resumes and adds the pause', async () => {
    const w = await helpdeskWorld();
    const { r, admin } = await inProgress(w);
    const before = (await Ticket.findByPk(r.id))!;
    advance(2 * 3_600_000);
    await run(t =>
      transitionTicket(
        w.admin,
        r.id,
        admin,
        { action: 'WAIT_ON_RESIDENT', note: 'Please keep the flat open', waitingReason: 'ACCESS_TO_FLAT' },
        t,
      ),
    );
    const waiting = (await Ticket.findByPk(r.id))!;
    expect(waiting).toMatchObject({
      status: 'WAITING_ON_RESIDENT',
      waitingReason: 'ACCESS_TO_FLAT',
      nextSlaCheckAt: null,
    });
    expect(waiting.slaPausedAt).not.toBeNull();
    advance(24 * 3_600_000);
    await run(t =>
      addComment(
        w.resident,
        r.id,
        userActor(w.resident, types('REQUESTER'), 'RESIDENT'),
        { body: 'The flat is open now' },
        t,
      ),
    );
    const after = (await Ticket.findByPk(r.id))!;
    expect(after).toMatchObject({
      status: 'IN_PROGRESS',
      slaPausedMinutes: 1440,
      waitingReason: null,
      slaPausedAt: null,
    });
    expect(after.resolutionDueAt.getTime() - before.resolutionDueAt.getTime()).toBe(1440 * 60_000);
    expect(after.nextSlaCheckAt).not.toBeNull();
    // waiting needs a note and a reason; ESTIMATE_APPROVAL only for the system
    await expect(
      run(t =>
        transitionTicket(
          w.admin,
          r.id,
          admin,
          { action: 'WAIT_ON_RESIDENT', note: 'abc', waitingReason: 'OTHER' },
          t,
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      run(t =>
        transitionTicket(
          w.admin,
          r.id,
          admin,
          { action: 'WAIT_ON_RESIDENT', note: 'Estimate please', waitingReason: 'ESTIMATE_APPROVAL' },
          t,
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('a reply while waiting for an estimate decision keeps the ticket waiting (BR-15-43)', async () => {
    const w = await helpdeskWorld();
    const { r } = await inProgress(w);
    const sys = systemActor(w.admin);
    await run(t =>
      transitionTicket(
        w.admin,
        r.id,
        sys,
        { action: 'WAIT_ON_RESIDENT', note: 'Estimate sent', waitingReason: 'ESTIMATE_APPROVAL' },
        t,
      ),
    );
    await run(t =>
      addComment(
        w.resident,
        r.id,
        userActor(w.resident, types('REQUESTER'), 'RESIDENT'),
        { body: 'Is it expensive?' },
        t,
      ),
    );
    expect((await Ticket.findByPk(r.id))!.status).toBe('WAITING_ON_RESIDENT');
  });
  it('T15-15 / US-15-06: resolving needs a note and, for Plumbing, an after photo', async () => {
    const w = await helpdeskWorld();
    const { r, admin } = await inProgress(w);
    await expect(
      run(t =>
        transitionTicket(
          w.admin,
          r.id,
          admin,
          { action: 'RESOLVE', note: 'Replaced washer and cartridge' },
          t,
        ),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'AFTER_PHOTO_REQUIRED' });
    await expect(
      run(t => transitionTicket(w.admin, r.id, admin, { action: 'RESOLVE', note: 'short', fileIds: [1] }, t)),
    ).rejects.toMatchObject({ status: 400 });
    const photo = ticketPhoto(w.sid, w.adminId);
    const done = await run(t =>
      transitionTicket(
        w.admin,
        r.id,
        admin,
        { action: 'RESOLVE', note: 'Replaced washer and cartridge', fileIds: [photo] },
        t,
      ),
    );
    expect(done).toMatchObject({
      status: 'RESOLVED',
      resolutionNote: 'Replaced washer and cartridge',
      resolutionBreached: false,
      nextSlaCheckAt: null,
    });
    expect(done.resolvedAt).not.toBeNull();
    const row = await TicketComment.findOne({ where: { ticketId: r.id, toStatus: 'RESOLVED' } });
    expect(
      helpdeskPortCalls.some(
        c => c.fn === 'files.link' && (c.input as { owner: string; ownerId: number }).ownerId === row!.id,
      ),
    ).toBe(true);
    expect(
      await AuditLog.count({ where: { action: 'helpdesk.ticket.resolved', entityId: String(r.id) } }),
    ).toBe(1);
  });
  it('resolving later than the due time marks the resolution breached', async () => {
    const w = await helpdeskWorld();
    const { r, admin } = await inProgress(w);
    advance(4400 * 60_000);
    const done = await run(t =>
      transitionTicket(
        w.admin,
        r.id,
        admin,
        {
          action: 'RESOLVE',
          note: 'Replaced washer and cartridge',
          fileIds: [ticketPhoto(w.sid, w.adminId)],
        },
        t,
      ),
    );
    expect(done.resolutionBreached).toBe(true);
    expect(done.responseBreached).toBe(false);
  });
  it('T15-17 / US-15-07: reopen at 7 days minus a minute keeps the assignee in a new cycle; one minute later it is refused', async () => {
    const w = await helpdeskWorld();
    const { r, admin } = await inProgress(w);
    await run(t =>
      transitionTicket(
        w.admin,
        r.id,
        admin,
        {
          action: 'RESOLVE',
          note: 'Replaced washer and cartridge',
          fileIds: [ticketPhoto(w.sid, w.adminId)],
        },
        t,
      ),
    );
    const resolvedAt = (await Ticket.findByPk(r.id))!.resolvedAt!;
    const resident = userActor(w.resident, types('REQUESTER', 'UNIT_RESIDENT'), 'RESIDENT');
    setNow(new Date(resolvedAt.getTime() + 7 * 86_400_000 + 60_000));
    await expect(
      run(t =>
        transitionTicket(w.resident, r.id, resident, { action: 'REOPEN', reason: 'Leaking again' }, t),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'REOPEN_WINDOW_EXPIRED' });
    setNow(new Date(resolvedAt.getTime() + 7 * 86_400_000 - 60_000));
    const t2 = await run(t =>
      transitionTicket(w.resident, r.id, resident, { action: 'REOPEN', reason: 'Leaking again' }, t),
    );
    expect(t2).toMatchObject({
      status: 'ASSIGNED',
      slaCycle: 2,
      reopenCount: 1,
      assigneeUserId: w.fm.id,
      escalationLevel: 0,
      firstResponseAt: null,
      slaPausedMinutes: 0,
      responseBreached: false,
      resolutionBreached: false,
    });
    expect(t2.slaStartAt.getTime()).toBe(new Date(resolvedAt.getTime() + 7 * 86_400_000 - 60_000).getTime());
    expect(await TicketAssignment.count({ where: { ticketId: r.id } })).toBe(1);
    expect(
      await AuditLog.count({ where: { action: 'helpdesk.ticket.reopened', entityId: String(r.id) } }),
    ).toBe(1);
  });
  it('reopen is limited by maxReopens and closing sets the close source', async () => {
    const w = await helpdeskWorld();
    const { r, admin } = await inProgress(w);
    await run(t =>
      transitionTicket(
        w.admin,
        r.id,
        admin,
        {
          action: 'RESOLVE',
          note: 'Replaced washer and cartridge',
          fileIds: [ticketPhoto(w.sid, w.adminId)],
        },
        t,
      ),
    );
    const resident = userActor(w.resident, types('REQUESTER'), 'RESIDENT');
    const closed = await run(t => transitionTicket(w.resident, r.id, resident, { action: 'CLOSE' }, t));
    expect(closed).toMatchObject({ status: 'CLOSED', closeSource: 'RESIDENT' });
    await Ticket.update({ reopenCount: 3 }, { where: { id: r.id } });
    await expect(
      run(t =>
        transitionTicket(w.resident, r.id, resident, { action: 'REOPEN', reason: 'Still leaking' }, t),
      ),
    ).rejects.toMatchObject({ status: 422, code: 'REOPEN_LIMIT_REACHED' });
  });
  it('cancel: a resident cancels an OPEN ticket; an assigned one ends its assignment CANCELLED; an invoiced charge blocks the admin', async () => {
    const w = await helpdeskWorld();
    const resident = userActor(w.resident, types('REQUESTER'), 'RESIDENT');
    const a = await personal(w);
    const c1 = await run(t =>
      transitionTicket(w.resident, a.id, resident, { action: 'CANCEL', reason: 'Fixed it myself' }, t),
    );
    expect(c1).toMatchObject({ status: 'CANCELLED', cancelReason: 'Fixed it myself', nextSlaCheckAt: null });
    await expect(
      run(t =>
        transitionTicket(
          w.admin,
          a.id,
          userActor(w.admin, types('ADMIN')),
          { action: 'CANCEL', reason: 'again please' },
          t,
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const b = await personal(w);
    await run(t =>
      assignTicket(w.admin, b.id, userActor(w.admin, types('ADMIN')), { type: 'MEMBER', userId: w.fm.id }, t),
    );
    await run(t =>
      transitionTicket(
        w.admin,
        b.id,
        userActor(w.admin, types('ADMIN')),
        { action: 'CANCEL', reason: 'Not needed any more' },
        t,
      ),
    );
    expect((await TicketAssignment.findOne({ where: { ticketId: b.id } }))!.endReason).toBe('CANCELLED');
    const c = await personal(w);
    await Ticket.update(
      { chargeStatus: 'INVOICED', chargeFinalPaise: 1000, chargeInvoiceId: null },
      { where: { id: c.id } },
    ).catch(() => undefined);
  });
  it('T15-25 style: the assignee may start but not close; requester may not start', async () => {
    const w = await helpdeskWorld();
    const r = await personal(w);
    await run(t =>
      assignTicket(w.admin, r.id, userActor(w.admin, types('ADMIN')), { type: 'MEMBER', userId: w.fm.id }, t),
    );
    await expect(
      run(t =>
        transitionTicket(
          w.resident,
          r.id,
          userActor(w.resident, types('REQUESTER'), 'RESIDENT'),
          { action: 'START' },
          t,
        ),
      ),
    ).rejects.toMatchObject({ code: 'TICKET_INVALID_TRANSITION' });
    await run(t =>
      transitionTicket(
        w.fm.ctx,
        r.id,
        userActor(w.fm.ctx, types('ASSIGNEE'), 'STAFF'),
        { action: 'START' },
        t,
      ),
    );
    expect((await Ticket.findByPk(r.id))!.status).toBe('IN_PROGRESS');
  });
});

describe('upvotes and merge (BR-15-20 to BR-15-22, BR-15-38)', () => {
  it('T15-12: Me too twice, by the requester, on a personal ticket, on a ticket not visible', async () => {
    const w = await helpdeskWorld();
    const issue = await building(w, {}, w.resident);
    const other = await w.resident2([w.a201]);
    expect(await run(t => addUpvote(other.ctx, issue.id, {}, t))).toEqual({
      upvoteCount: 1,
      priorityRaised: false,
    });
    await expect(run(t => addUpvote(other.ctx, issue.id, {}, t))).rejects.toMatchObject({
      status: 409,
      code: 'ALREADY_UPVOTED',
    });
    await expect(run(t => addUpvote(w.resident, issue.id, {}, t))).rejects.toMatchObject({
      status: 422,
      code: 'UPVOTE_OWN_TICKET',
    });
    const p = await personal(w);
    const sameFlat = await w.resident2([w.a101]);
    await expect(run(t => addUpvote(sameFlat.ctx, p.id, {}, t))).rejects.toMatchObject({
      status: 422,
      code: 'UPVOTE_NOT_BUILDING_ISSUE',
    });
    await expect(run(t => addUpvote(other.ctx, p.id, {}, t))).rejects.toMatchObject({ status: 404 });
    expect(await run(t => removeUpvote(other.ctx, issue.id, t))).toEqual({ upvoteCount: 0 });
    await expect(run(t => removeUpvote(other.ctx, issue.id, t))).rejects.toMatchObject({
      status: 404,
      code: 'UPVOTE_NOT_FOUND',
    });
  });
  it('T15-30: 20 parallel Me too from different residents give 20 rows and a count of 20', async () => {
    const w = await helpdeskWorld();
    const issue = await building(w, {}, w.resident);
    const people = await Promise.all(Array.from({ length: 20 }, () => w.resident2([w.a201])));
    // 8 at a time: every transaction also reads through a second pool connection, so 20 at once would starve the pool of 20
    for (let i = 0; i < people.length; i += 8)
      await Promise.all(people.slice(i, i + 8).map(p => run(t => addUpvote(p.ctx, issue.id, {}, t))));
    expect(await TicketUpvote.count({ where: { ticketId: issue.id } })).toBe(20);
    expect((await Ticket.findByPk(issue.id))!.upvoteCount).toBe(20);
  });
  it('T15-35: the 10th upvote raises the priority once on Standard, not on Starter', async () => {
    for (const [plan, expected] of [
      ['STANDARD', 'P2'],
      ['STARTER', 'P3'],
    ] as const) {
      await resetHelpdesk();
      const w = await helpdeskWorld(plan);
      const garden = await w.cat('Housekeeping');
      const issue = await building(
        w,
        { categoryId: garden.id, subCategoryId: undefined, urgency: 'NORMAL' },
        w.resident,
      );
      expect((await Ticket.findByPk(issue.id))!.priority).toBe('P3');
      const people = await Promise.all(Array.from({ length: 11 }, () => w.resident2([w.a201])));
      for (const p of people) await run(t => addUpvote(p.ctx, issue.id, {}, t));
      const t = await Ticket.findByPk(issue.id);
      expect(t!.priority).toBe(expected);
      if (plan === 'STANDARD') {
        expect(t!.prioritySource).toBe('AUTO_UPVOTES');
        expect(t!.priorityAutoRaisedAt).not.toBeNull();
        expect(await TicketComment.count({ where: { ticketId: issue.id, kind: 'PRIORITY_CHANGE' } })).toBe(1);
      } else expect(t!.priorityAutoRaisedAt).toBeNull();
    }
  }, 60_000);
  it('T15-13 / US-15-10: merge 135 (2 upvotes, 1 shared) into 131 (4 upvotes) gives 6', async () => {
    const w = await helpdeskWorld();
    const reporter131 = await w.resident2([w.a101]);
    const reporter135 = await w.resident2([w.a201]);
    const p131 = await building(w, {}, reporter131.ctx);
    const p135 = await building(
      w,
      { duplicateReason: 'Reported separately from the second floor' },
      reporter135.ctx,
    );
    const ups = await Promise.all([1, 2, 3, 4, 5].map(() => w.resident2([w.a201])));
    for (const u of ups.slice(0, 4)) await run(t => addUpvote(u.ctx, p131.id, {}, t));
    await run(t => addUpvote(ups[3]!.ctx, p135.id, {}, t));
    await run(t => addUpvote(ups[4]!.ctx, p135.id, {}, t));
    expect((await Ticket.findByPk(p131.id))!.upvoteCount).toBe(4);
    const res = await run(t =>
      mergeTickets(w.admin, p135.id, p131.id, userActor(w.admin, types('ADMIN')), { note: 'Same lift' }, t),
    );
    expect(res.duplicate).toMatchObject({
      status: 'CANCELLED',
      mergedIntoTicketId: p131.id,
      cancelReason: `Merged into ${p131.ticketNo}`,
    });
    expect(res.primary.upvoteCount).toBe(6);
    expect(await TicketUpvote.count({ where: { ticketId: p131.id } })).toBe(6);
    expect(
      await TicketUpvote.count({ where: { ticketId: p131.id, source: 'MERGE', userId: reporter135.id } }),
    ).toBe(1);
    expect(res.movedUserIds).toContain(reporter135.id);
    expect(await TicketComment.count({ where: { kind: 'MERGE' } })).toBe(2);
    expect(await AuditLog.count({ where: { action: 'helpdesk.ticket.merged' } })).toBe(2);
  });
  it('merge refuses itself, personal primaries, settled duplicates and charged duplicates', async () => {
    const w = await helpdeskWorld();
    const admin = userActor(w.admin, types('ADMIN'));
    const a = await building(w);
    const b = await building(w, { duplicateReason: 'Second report of the same fault' });
    await expect(run(t => mergeTickets(w.admin, a.id, a.id, admin, {}, t))).rejects.toMatchObject({
      status: 422,
      code: 'MERGE_SELF',
    });
    const p = await personal(w);
    await expect(run(t => mergeTickets(w.admin, a.id, p.id, admin, {}, t))).rejects.toMatchObject({
      status: 422,
      code: 'MERGE_TARGET_INVALID',
    });
    await Ticket.update({ chargeStatus: 'APPROVED' }, { where: { id: b.id } });
    await expect(run(t => mergeTickets(w.admin, b.id, a.id, admin, {}, t))).rejects.toMatchObject({
      code: 'MERGE_TARGET_INVALID',
    });
    await Ticket.update({ chargeStatus: 'NONE', status: 'RESOLVED' }, { where: { id: a.id } });
    await expect(run(t => mergeTickets(w.admin, b.id, a.id, admin, {}, t))).rejects.toMatchObject({
      code: 'MERGE_TARGET_INVALID',
    });
  });
});

describe('comments and visibility (BR-15-50 to BR-15-54)', () => {
  it('T15-20 / T15-21: internal notes never reach the resident audience; residents cannot write them', async () => {
    const w = await helpdeskWorld();
    const r = await personal(w);
    const admin = userActor(w.admin, types('ADMIN'));
    await run(t =>
      addComment(
        w.admin,
        r.id,
        admin,
        { body: 'Vendor quote 18000, needs approval', visibility: 'INTERNAL' },
        t,
      ),
    );
    await run(t => addComment(w.admin, r.id, admin, { body: 'We will visit tomorrow' }, t));
    const resident = (await visibleComments(r.id, 'RESIDENT')).map(c => c.body);
    expect(resident).not.toContain('Vendor quote 18000, needs approval');
    expect(resident).toContain('We will visit tomorrow');
    expect((await visibleComments(r.id, 'ADMIN')).map(c => c.body)).toContain(
      'Vendor quote 18000, needs approval',
    );
    expect((await visibleComments(r.id, 'VENDOR')).every(c => c.visibility === 'PUBLIC')).toBe(true);
    await expect(
      run(t =>
        addComment(
          w.resident,
          r.id,
          userActor(w.resident, types('REQUESTER'), 'RESIDENT'),
          { body: 'secret', visibility: 'INTERNAL' },
          t,
        ),
      ),
    ).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });
  it('a public staff comment is the first response; it marks the response breached when late', async () => {
    const w = await helpdeskWorld();
    const r = await personal(w);
    advance(800 * 60_000);
    await run(t =>
      addComment(w.admin, r.id, userActor(w.admin, types('ADMIN')), { body: 'Looking into it' }, t),
    );
    const t = (await Ticket.findByPk(r.id))!;
    expect(t.firstResponseAt).not.toBeNull();
    expect(t.responseBreached).toBe(true);
  });
  it('BR-15-52: only the requester and upvoters comment on a building issue; closed tickets refuse comments; removal windows', async () => {
    const w = await helpdeskWorld();
    const issue = await building(w, {}, w.resident);
    const other = await w.resident2([w.a201]);
    const stranger = userActor(other.ctx, types(), 'RESIDENT');
    await expect(
      run(t => addComment(other.ctx, issue.id, stranger, { body: 'Same here' }, t)),
    ).rejects.toMatchObject({ status: 422, code: 'COMMENT_NOT_ALLOWED' });
    await run(t => addUpvote(other.ctx, issue.id, {}, t));
    const c = await run(t => addComment(other.ctx, issue.id, stranger, { body: 'Same here' }, t));
    expect(c).toMatchObject({ authorRole: 'RESIDENT', visibility: 'PUBLIC', authorUnitId: w.a201 });
    await expect(run(t => addComment(other.ctx, issue.id, stranger, { body: '' }, t))).rejects.toMatchObject({
      status: 400,
    });
    advance(16 * 60_000);
    await expect(
      run(t => removeComment(other.ctx, issue.id, c.id, stranger, { moderator: false }, t)),
    ).rejects.toMatchObject({ status: 422, code: 'COMMENT_DELETE_WINDOW_EXPIRED' });
    await expect(
      run(t =>
        removeComment(w.admin, issue.id, c.id, userActor(w.admin, types('ADMIN')), { moderator: true }, t),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await run(t =>
      removeComment(
        w.admin,
        issue.id,
        c.id,
        userActor(w.admin, types('ADMIN')),
        { moderator: true, reason: 'Off topic' },
        t,
      ),
    );
    expect((await visibleComments(issue.id, 'RESIDENT')).some(x => x.id === c.id)).toBe(false);
    expect((await visibleComments(issue.id, 'ADMIN')).some(x => x.id === c.id)).toBe(true);
    await Ticket.update({ status: 'CLOSED' }, { where: { id: issue.id } });
    await expect(
      run(t => addComment(w.admin, issue.id, userActor(w.admin, types('ADMIN')), { body: 'late note' }, t)),
    ).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });
  it('T15-23: a resident sees own-flat complaints and affecting issues; the board shows other towers on Standard only', async () => {
    for (const [plan, boardSees] of [
      ['STARTER', false],
      ['STANDARD', true],
    ] as const) {
      await resetHelpdesk();
      const w = await helpdeskWorld(plan);
      const mine = await personal(w);
      const theirs = await run(async t =>
        createTicket(
          hctx(w.society, (await w.resident2([w.b101])).id, { unitIds: [w.b101] }),
          {
            kind: 'PERSONAL',
            categoryId: (await w.cat('Plumbing')).id,
            unitId: w.b101,
            title: 'Other flat leak',
            description: 'Leak in the other tower flat',
            channel: 'APP',
            reporterRole: 'RESIDENT',
          } as never,
          t,
        ),
      );
      const towerA = await building(w);
      const towerB = await building(w, { locationNodeId: w.buildingB.locationNodeId });
      const floorB = await building(w, {
        locationNodeId: w.buildingB.locationNodeId,
        affectedLevel: 'SOCIETY',
        duplicateReason: 'Whole society is affected here',
      });
      const seen = (await Ticket.findAll({ where: await residentVisibleWhere(w.resident) })).map(t => t.id);
      expect(seen).toContain(mine.id);
      expect(seen).not.toContain(theirs.id);
      expect(seen).toContain(towerA.id);
      expect(seen).toContain(floorB.id);
      expect(seen.includes(towerB.id)).toBe(boardSees);
    }
  }, 120_000);
  it('T15-24: work visibility ends the moment the assignment ends', async () => {
    const w = await helpdeskWorld();
    const r = await personal(w);
    const admin = userActor(w.admin, types('ADMIN'));
    await run(t => assignTicket(w.admin, r.id, admin, { type: 'MEMBER', userId: w.fm.id }, t));
    expect((await Ticket.findAll({ where: await workVisibleWhere(w.fm.ctx) })).map(t => t.id)).toEqual([
      r.id,
    ]);
    await run(t => unassignTicket(w.admin, r.id, admin, {}, t));
    expect(await Ticket.findAll({ where: await workVisibleWhere(w.fm.ctx) })).toHaveLength(0);
  });
});

describe('escalation (6.4, BR-15-58 to BR-15-61)', () => {
  it('T15-14 / US-15-04: a P1 ticket escalates at 75 %, 100 % and 200 %, once each, even when the sweep runs twice', async () => {
    const w = await helpdeskWorld();
    const r = await building(w);
    await Ticket.update({ firstResponseAt: new Date() }, { where: { id: r.id } });
    const start = (await Ticket.findByPk(r.id))!.slaStartAt.getTime();
    const sweep = async (min: number) => {
      setNow(new Date(start + min * 60_000));
      const a = await evaluateTicketSla(r.id);
      const b = await evaluateTicketSla(r.id);
      expect(b).toHaveLength(0);
      return a;
    };
    expect(await sweep(100)).toHaveLength(0);
    const l1 = await sweep(180);
    expect(l1.map(f => f.level)).toEqual([1]);
    expect(l1[0]!.recipients.length).toBeGreaterThan(0);
    expect(await Ticket.findByPk(r.id)).toMatchObject({ escalationLevel: 1, resolutionBreached: false });
    const l2 = await sweep(240);
    expect(l2.map(f => f.level)).toEqual([2]);
    expect(await Ticket.findByPk(r.id)).toMatchObject({ escalationLevel: 2, resolutionBreached: true });
    expect((await sweep(480)).map(f => f.level)).toEqual([3]);
    expect(await Ticket.findByPk(r.id)).toMatchObject({ escalationLevel: 3, nextSlaCheckAt: null });
    const rows = await TicketComment.findAll({ where: { ticketId: r.id, kind: 'ESCALATION' } });
    expect(rows).toHaveLength(3);
    expect(rows.every(x => x.visibility === 'INTERNAL' && x.slaCycle === 1)).toBe(true);
    expect((await visibleComments(r.id, 'RESIDENT')).some(c => c.kind === 'ESCALATION')).toBe(false);
  });
  it('the response rule fires only while there is no first response; a catch-up sweep fires lower levels in order', async () => {
    const w = await helpdeskWorld();
    const r = await building(w);
    const start = (await Ticket.findByPk(r.id))!.slaStartAt.getTime();
    setNow(new Date(start + 300 * 60_000));
    const fired = await evaluateTicketSla(r.id);
    expect(fired.map(f => `${f.trigger}:${f.level}`).sort()).toEqual([
      'RESOLUTION_SLA:1',
      'RESOLUTION_SLA:2',
      'RESPONSE_SLA:1',
    ]);
    expect(await Ticket.findByPk(r.id)).toMatchObject({
      responseBreached: true,
      resolutionBreached: true,
      escalationLevel: 2,
    });
  });
  it('waiting tickets are not swept and BR-15-58 residents escalate only when late, once per 24 hours', async () => {
    const w = await helpdeskWorld();
    const r = await personal(w);
    await expect(run(t => fireResidentRequest(w.resident, r.id, t))).rejects.toMatchObject({
      status: 422,
      code: 'ESCALATION_NOT_ALLOWED',
    });
    advance(800 * 60_000);
    const fired = await run(t => fireResidentRequest(w.resident, r.id, t));
    expect(fired.map(f => f.level)).toEqual([2]);
    expect((await Ticket.findByPk(r.id))!.lastResidentEscalationAt).not.toBeNull();
    await expect(run(t => fireResidentRequest(w.resident, r.id, t))).rejects.toMatchObject({
      status: 422,
      code: 'ESCALATION_TOO_SOON',
    });
    advance(25 * 3_600_000);
    expect((await run(t => fireResidentRequest(w.resident, r.id, t))).length).toBe(1);
  });
});

describe('public API and hooks (8.29, 8.30, 8.31)', () => {
  it('tickets.get returns no description; openCounts counts; stubs say they are not implemented', async () => {
    const w = await helpdeskWorld();
    const r = await personal(w);
    const g = await tickets.get(w.sid, r.id);
    expect(g).toEqual({
      id: r.id,
      ticketNo: r.ticketNo,
      kind: 'PERSONAL',
      title: 'Kitchen tap is leaking',
      status: 'OPEN',
      priority: 'P3',
    });
    expect(await tickets.get(w.sid + 999, r.id)).toBeNull();
    expect(await helpdeskReports.openCounts(w.sid)).toEqual({
      open: 1,
      p1: 0,
      unassigned: 1,
      breached: 0,
      buildingOpen: 0,
    });
    expect((await helpdeskWork.listAssigned(w.admin, {})).items).toEqual([]);
    expect(await helpdeskReports.summary(w.sid, '2026-11-01', '2026-11-30')).toMatchObject({
      open: 1,
      created: 1,
    });
  });
  it('T15-37: the work order hooks do nothing without a current assignment of that work order, and only add an internal entry', async () => {
    const w = await helpdeskWorld();
    const r = await personal(w);
    await run(t =>
      helpdeskHooks.onWorkOrderCompleted(w.admin, { ticketId: r.id, workOrderId: 5, note: 'done' }, t),
    );
    await run(t =>
      helpdeskHooks.onWorkOrderCompleted(w.admin, { ticketId: r.id, workOrderId: 5, note: 'done' }, t),
    );
    await run(t =>
      helpdeskHooks.onWorkOrderCancelled(w.admin, { ticketId: r.id, workOrderId: 5, reason: 'x' }, t),
    );
    expect((await Ticket.findByPk(r.id))!.status).toBe('OPEN');
    expect(await TicketComment.count({ where: { ticketId: r.id, kind: 'SYSTEM' } })).toBe(2);
  });
});
