import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import { Ticket, closeDb, sequelize } from '../../../src/models';
import { queueRegistry } from '../../../src/lib/queue';
import { exportProviders } from '../../../src/modules/societies/societies.exports';
import { purgeHandlerList } from '../../../src/modules/societies/societies.purge';
import { clearUnitGuards } from '../../../src/modules/society-setup/society-setup.units.service';
import { registerHelpdesk, unitHasOpenTickets } from '../../../src/modules/helpdesk/helpdesk.public';
import { HELPDESK_TABLES, helpdeskExportProvider } from '../../../src/modules/helpdesk/helpdesk.exports';
import { PURGE_TABLES, purgeHelpdesk } from '../../../src/modules/helpdesk/helpdesk.purge';
import {
  assertHelpdeskPortsReady,
  fakePortsInUse,
  helpdeskPortCalls,
  helpdeskPorts,
  setHelpdeskPorts,
} from '../../../src/modules/helpdesk/helpdesk.ports';
import { createTicket } from '../../../src/modules/helpdesk/helpdesk.tickets.core';
import { assignTicket } from '../../../src/modules/helpdesk/helpdesk.routing';
import { mergeTickets } from '../../../src/modules/helpdesk/helpdesk.tickets.merge';
import { addUpvote } from '../../../src/modules/helpdesk/helpdesk.tickets.upvote';
import { addComment } from '../../../src/modules/helpdesk/helpdesk.tickets.comment';
import { onTicketEvent, userActor, type TicketEvent } from '../../../src/modules/helpdesk/helpdesk.shared';
import { seedHelpdesk } from '../../../seeders/helpdesk';
import { helpdeskWorld, resetHelpdesk, count, ticketPhoto } from '../../helpers/helpdesk';
import { events } from '../../helpers/auth';
import { HELPDESK_QUEUE, PERM, ENT, ERR, ACTIONS } from '../../../src/modules/helpdesk/helpdesk.constants';
import { isKnownKey } from '../../../src/modules/access-control/access-control.permissions';
import { FEATURE_ROWS } from '../../../src/modules/subscriptions/subscriptions.catalogue-data';

afterAll(async () => {
  await closeDb();
});
beforeEach(resetHelpdesk);

const run = <T>(fn: (t: import('sequelize').Transaction) => Promise<T>) => sequelize.transaction(fn);
const admin = (ctx: never) => userActor(ctx, new Set(['ADMIN']));

describe('constants match the platform catalogues', () => {
  it('every permission and entitlement key exists in modules 03 and 04', () => {
    for (const k of Object.values(PERM)) expect(isKnownKey(k), k).toBe(true);
    const features = new Set(FEATURE_ROWS.map(r => r[0]));
    for (const k of Object.values(ENT)) expect(features.has(k), k).toBe(true);
    expect(ACTIONS).toHaveLength(7);
    expect(ERR.invalidTransition).toBe('TICKET_INVALID_TRANSITION');
  });
});

describe('registerHelpdesk (module 05 contract)', () => {
  it('registers the export provider, the purge handler (order 150), the queue and the unit guard; repeating is harmless', () => {
    clearUnitGuards();
    registerHelpdesk();
    registerHelpdesk();
    const p = exportProviders().filter(x => x.module === 'helpdesk');
    expect(p).toHaveLength(1);
    expect(p[0]!.tables.map(t => t.name)).toEqual([...HELPDESK_TABLES]);
    const h = purgeHandlerList().filter(x => x.module === 'helpdesk');
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ order: 150, tables: PURGE_TABLES });
    expect(queueRegistry.get(HELPDESK_QUEUE)).toMatchObject({ queue: 'helpdesk' });
  });
  it('the unit guard refuses archiving a flat with open personal tickets', async () => {
    const w = await helpdeskWorld();
    expect(await unitHasOpenTickets(w.sid, w.a101)).toBeNull();
    await run(async t =>
      createTicket(
        w.resident,
        {
          kind: 'PERSONAL',
          categoryId: (await w.cat('Plumbing')).id,
          unitId: w.a101,
          title: 'Tap leak in kitchen',
          description: 'Leaking all day long',
          channel: 'APP',
          reporterRole: 'RESIDENT',
        } as never,
        t,
      ),
    );
    expect(await unitHasOpenTickets(w.sid, w.a101)).toBe('HELPDESK_OPEN_TICKETS');
  });
});

describe('ports (recorded placeholders)', () => {
  it('placeholders record, can be replaced per port, and restore', async () => {
    const w = await helpdeskWorld();
    expect(await helpdeskPorts().staffDirectory.getSummary(w.sid, 1)).toBeNull();
    expect(await helpdeskPorts().vendors.vendorIdsForUser(w.sid, 1)).toEqual([]);
    const wo = await run(t =>
      helpdeskPorts().workOrders.createFromTicket(
        w.admin,
        { ticketId: 1, vendorId: 2, title: 'x', priority: 'P2' },
        t,
      ),
    );
    expect(wo.workOrderId).toBeGreaterThan(0);
    await run(t => helpdeskPorts().workOrders.cancel(w.admin, wo.workOrderId, 'x', t));
    expect(helpdeskPortCalls.map(c => c.fn)).toEqual(['workOrders.createFromTicket', 'workOrders.cancel']);
    setHelpdeskPorts({
      staffDirectory: {
        getSummary: async (_s, id) => ({ id, name: 'Imran', status: 'ACTIVE', userId: null }),
      },
    });
    expect((await helpdeskPorts().staffDirectory.getSummary(w.sid, 9))!.name).toBe('Imran');
    expect(fakePortsInUse()).toEqual(['notifications', 'files']);
    expect(() => assertHelpdeskPortsReady('production')).toThrowError(/placeholder in production/);
    setHelpdeskPorts({
      notifications: { send: async () => undefined },
      files: { link: async () => undefined, list: () => [] },
    });
    expect(() => assertHelpdeskPortsReady('production')).not.toThrow();
    setHelpdeskPorts();
    expect(helpdeskPortCalls).toHaveLength(0);
  });
  it('a STAFF assignment works through the replaced port (module 20 injected)', async () => {
    const w = await helpdeskWorld();
    setHelpdeskPorts({
      staffDirectory: {
        getSummary: async (_s, id) =>
          id === 5 ? { id, name: 'Imran Plumber', status: 'ACTIVE', userId: w.fm.id } : null,
      },
    });
    const r = await run(async t =>
      createTicket(
        w.resident,
        {
          kind: 'PERSONAL',
          categoryId: (await w.cat('Plumbing')).id,
          unitId: w.a101,
          title: 'Tap leak in kitchen',
          description: 'Leaking all day long',
          channel: 'APP',
          reporterRole: 'RESIDENT',
        } as never,
        t,
      ),
    );
    const t = await run(tx =>
      assignTicket(w.admin, r.id, admin(w.admin as never), { type: 'STAFF', staffId: 5 }, tx),
    );
    expect(t).toMatchObject({ status: 'ASSIGNED', assigneeUserId: w.fm.id, assigneeLabel: 'Imran Plumber' });
  });
  it('after-commit events reach registered listeners and the realtime sink with ids and states only', async () => {
    const w = await helpdeskWorld();
    const seen: TicketEvent[] = [];
    onTicketEvent(e => void seen.push(e));
    events.length = 0;
    const r = await run(async t =>
      createTicket(
        w.resident,
        {
          kind: 'PERSONAL',
          categoryId: (await w.cat('Plumbing')).id,
          unitId: w.a101,
          title: 'Tap leak in kitchen',
          description: 'Leaking all day long',
          channel: 'APP',
          reporterRole: 'RESIDENT',
        } as never,
        t,
      ),
    );
    expect(seen.map(e => [e.event, e.ticketId, e.status])).toEqual([['CREATED', r.id, 'OPEN']]);
    const admin1 = events.find(
      e => e.room === `society:${w.sid}:admin` && e.event === 'helpdesk.ticket.changed',
    );
    expect(admin1!.payload).toMatchObject({ ticketId: r.id, status: 'OPEN', kind: 'PERSONAL' });
    expect(JSON.stringify(admin1!.payload)).not.toContain('Tap leak');
    expect(events.some(e => e.room === `unit:${w.a101}` && e.event === 'helpdesk.ticket.changed')).toBe(true);
    // a rolled-back transaction sends nothing
    events.length = 0;
    await expect(
      run(async t => {
        await createTicket(
          w.resident,
          {
            kind: 'PERSONAL',
            categoryId: (await w.cat('Plumbing')).id,
            unitId: w.a101,
            title: 'Tap leak in kitchen',
            description: 'Leaking all day long',
            channel: 'APP',
            reporterRole: 'RESIDENT',
          } as never,
          t,
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(events).toHaveLength(0);
    expect(await Ticket.count()).toBe(1);
  });
});

describe('migrations and constraints (7.1 to 7.7)', () => {
  it('the CHECKs and unique keys of the spec hold in the database', async () => {
    const w = await helpdeskWorld();
    const q = (sql: string) => sequelize.query(sql);
    const now = '2026-11-01 10:00:00.000';
    // a BUILDING ticket without a location, a PERSONAL ticket without a unit
    const base = (cols: string, vals: string) =>
      `INSERT INTO tickets (societyId, ticketNo, ${cols}, categoryId, title, priority, reporterRole, raisedByUserId, requesterName, slaPolicyId, slaCalendar, responseMinutes, resolutionMinutes, slaStartAt, responseDueAt, resolutionDueAt, lastActivityAt, createdAt, updatedAt)
       SELECT ${w.sid}, 'X/1', ${vals}, c.id, 'Title here', 'P3', 'OFFICE', ${w.adminId}, 'A', p.id, 'TWENTY_FOUR_SEVEN', 30, 60, '${now}', '${now}', '${now}', '${now}', '${now}', '${now}'
       FROM ticket_categories c JOIN sla_policies p ON p.societyId = c.societyId WHERE c.societyId = ${w.sid} AND c.name = 'Plumbing' AND c.parentId IS NULL LIMIT 1`;
    await expect(q(base('kind', "'BUILDING'"))).rejects.toThrow(/ck_tickets_kind/);
    await expect(q(base('kind', "'PERSONAL'"))).rejects.toThrow(/ck_tickets_kind/);
    await expect(q(base('kind, unitId, status', `'PERSONAL', ${w.a101}, 'NOPE'`))).rejects.toThrow(
      /ck_tickets_status/,
    );
    await expect(
      q(base('kind, unitId, status', `'PERSONAL', ${w.a101}, 'WAITING_ON_RESIDENT'`)),
    ).rejects.toThrow(/ck_tickets_paused/);
    await q(base('kind, unitId', `'PERSONAL', ${w.a101}`));
    await expect(q(base('kind, unitId', `'PERSONAL', ${w.a101}`))).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: { message: expect.stringContaining('uq_tickets_no') },
    });
    // exactly one ACTIVE default policy and unique active names
    await expect(
      q(
        `INSERT INTO sla_policies (societyId, name, isDefault, createdAt, updatedAt) VALUES (${w.sid}, 'Second', 1, '${now}', '${now}')`,
      ),
    ).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: { message: expect.stringContaining('uq_sla_policies_default') },
    });
    await expect(
      q(
        `INSERT INTO sla_policies (societyId, name, p1ResponseMinutes, createdAt, updatedAt) VALUES (${w.sid}, 'Bad', 0, '${now}', '${now}')`,
      ),
    ).rejects.toThrow(/ck_sla_p1_order/);
    await expect(
      q(
        `INSERT INTO sla_policies (societyId, name, createdAt, updatedAt) VALUES (${w.sid}, 'Standard', '${now}', '${now}')`,
      ),
    ).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: { message: expect.stringContaining('uq_sla_policies_name') },
    });
    // categories: sibling names, top-level priority
    await expect(
      q(
        `INSERT INTO ticket_categories (societyId, name, scope, defaultPriority, createdAt, updatedAt) VALUES (${w.sid}, 'Plumbing', 'BOTH', 'P3', '${now}', '${now}')`,
      ),
    ).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: { message: expect.stringContaining('uq_ticket_categories_sibling_name') },
    });
    await expect(
      q(
        `INSERT INTO ticket_categories (societyId, name, scope, createdAt, updatedAt) VALUES (${w.sid}, 'No priority', 'BOTH', '${now}', '${now}')`,
      ),
    ).rejects.toThrow(/ck_ticket_categories_top_priority/);
    await expect(
      q(
        `INSERT INTO ticket_categories (societyId, name, scope, defaultPriority, isChargeable, createdAt, updatedAt) VALUES (${w.sid}, 'Chargeable lift', 'BUILDING', 'P3', 1, '${now}', '${now}')`,
      ),
    ).rejects.toThrow(/ck_ticket_categories_charge/);
    // escalation rules: threshold and target
    await expect(
      q(
        `INSERT INTO escalation_rules (societyId, name, triggerType, thresholdPercent, level, targetType, targetRoleKey, createdAt, updatedAt) VALUES (${w.sid}, 'Bad rule', 'RESOLUTION_SLA', 10, 1, 'ROLE', 'x', '${now}', '${now}')`,
      ),
    ).rejects.toThrow(/ck_escalation_rules_threshold/);
    await expect(
      q(
        `INSERT INTO escalation_rules (societyId, name, triggerType, level, targetType, createdAt, updatedAt) VALUES (${w.sid}, 'Bad rule', 'LOW_CSAT', 1, 'ROLE', '${now}', '${now}')`,
      ),
    ).rejects.toThrow(/ck_escalation_rules_target/);
  });
  it('one current assignment per ticket, an escalation entry per rule and cycle, one upvote per user', async () => {
    const w = await helpdeskWorld();
    const r = await run(async t =>
      createTicket(
        w.resident,
        {
          kind: 'PERSONAL',
          categoryId: (await w.cat('Plumbing')).id,
          unitId: w.a101,
          title: 'Tap leak in kitchen',
          description: 'Leaking all day long',
          channel: 'APP',
          reporterRole: 'RESIDENT',
        } as never,
        t,
      ),
    );
    const now = '2026-11-01 10:00:00.000';
    const asg = `INSERT INTO ticket_assignments (societyId, ticketId, assigneeType, assigneeUserId, assigneeLabel, method, assignedAt, createdAt, updatedAt) VALUES (${w.sid}, ${r.id}, 'MEMBER', ${w.fm.id}, 'x', 'MANUAL', '${now}', '${now}', '${now}')`;
    await sequelize.query(asg);
    await expect(sequelize.query(asg)).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: { message: expect.stringContaining('uq_ticket_assignments_current') },
    });
    await expect(
      sequelize.query(
        `INSERT INTO ticket_assignments (societyId, ticketId, assigneeType, assigneeLabel, method, assignedAt, createdAt, updatedAt) VALUES (${w.sid}, ${r.id}, 'MEMBER', 'x', 'MANUAL', '${now}', '${now}', '${now}')`,
      ),
    ).rejects.toThrow(/ck_ticket_assignments_type/);
    const rule = (
      await sequelize.query<{ id: number }>(
        `SELECT id FROM escalation_rules WHERE societyId = ${w.sid} LIMIT 1`,
        { type: QueryTypes.SELECT },
      )
    )[0]!.id;
    const esc = `INSERT INTO ticket_comments (societyId, ticketId, kind, visibility, authorRole, authorName, escalationRuleId, slaCycle, createdAt, updatedAt) VALUES (${w.sid}, ${r.id}, 'ESCALATION', 'INTERNAL', 'SYSTEM', 'System', ${rule}, 1, '${now}', '${now}')`;
    await sequelize.query(esc);
    await expect(sequelize.query(esc)).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: { message: expect.stringContaining('uq_ticket_comments_escalation') },
    });
    await expect(
      sequelize.query(esc.replace("'INTERNAL'", "'PUBLIC'").replace(', 1,', ', 2,')),
    ).rejects.toThrow(/ck_ticket_comments_escalation/);
    await expect(
      sequelize.query(
        `INSERT INTO ticket_comments (societyId, ticketId, kind, authorRole, authorName, createdAt, updatedAt) VALUES (${w.sid}, ${r.id}, 'COMMENT', 'ADMIN', 'x', '${now}', '${now}')`,
      ),
    ).rejects.toThrow(/ck_ticket_comments_body/);
  });
});

describe('export and purge (T15-39)', () => {
  it('the provider streams every table of the society only, without removed comments; purge deletes everything without an FK error', async () => {
    const w = await helpdeskWorld();
    const other = await helpdeskWorld();
    const a = await run(async t =>
      createTicket(
        w.resident,
        {
          kind: 'BUILDING',
          categoryId: (await w.cat('Lift')).id,
          locationNodeId: w.buildingA.locationNodeId,
          urgency: 'URGENT',
          channel: 'APP',
          reporterRole: 'RESIDENT',
          fileIds: [ticketPhoto(w.sid, w.residentId)],
        } as never,
        t,
      ),
    );
    const b = await run(async t =>
      createTicket(
        w.admin,
        {
          kind: 'BUILDING',
          categoryId: (await w.cat('Lift')).id,
          locationNodeId: w.buildingA.locationNodeId,
          urgency: 'URGENT',
          channel: 'APP',
          reporterRole: 'OFFICE',
          duplicateReason: 'Second report from the office',
        } as never,
        t,
      ),
    );
    const up = await w.resident2([w.a201]);
    await run(t => addUpvote(up.ctx, b.id, {}, t));
    await run(t =>
      assignTicket(
        w.admin,
        b.id,
        admin(w.admin as never),
        { type: 'EXTERNAL', externalName: 'Shree Ganesh Lift Services', externalMobile: '9876543210' },
        t,
      ),
    );
    const c = await run(t =>
      addComment(w.admin, b.id, admin(w.admin as never), { body: 'Technician called' }, t),
    );
    await sequelize.query(`UPDATE ticket_comments SET deletedAt = NOW(3) WHERE id = ${c.id}`);
    await run(t => mergeTickets(w.admin, b.id, a.id, admin(w.admin as never), {}, t));
    const rows: Record<string, number> = {};
    for (const tbl of helpdeskExportProvider.tables) {
      let n = 0;
      for await (const r of tbl.stream(w.sid)) {
        n++;
        expect(r.societyId).toBe(w.sid);
        if (tbl.name === 'ticket_comments') expect(r.deletedAt).toBeNull();
      }
      rows[tbl.name] = n;
    }
    expect(rows.tickets).toBe(2);
    expect(rows.ticket_categories).toBeGreaterThan(30);
    expect(rows.ticket_upvotes).toBeGreaterThanOrEqual(1);
    expect(rows.ticket_assignments).toBe(1);
    const otherTickets = await count('tickets', other.sid);
    const res = await purgeHelpdesk(w.sid);
    expect(res.deleted).toBeGreaterThan(40);
    for (const t of PURGE_TABLES) expect(await count(t, w.sid), t).toBe(0);
    expect(await count('ticket_categories', other.sid)).toBeGreaterThan(30);
    expect(await count('tickets', other.sid)).toBe(otherTickets);
  });
});

describe('seeders', () => {
  it('the catalogue seeder is idempotent and backfills societies without one', async () => {
    const w = await helpdeskWorld();
    expect((await seedHelpdesk()).created).toEqual([]);
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of ['escalation_rules', 'ticket_categories', 'sla_policies'])
      await sequelize.query(`DELETE FROM ${t} WHERE societyId = ${w.sid}`);
    await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
    const r = await seedHelpdesk();
    expect(r.created.some(x => x.includes(`society ${w.sid}`))).toBe(true);
    expect((await seedHelpdesk()).created).toEqual([]);
  });
});
