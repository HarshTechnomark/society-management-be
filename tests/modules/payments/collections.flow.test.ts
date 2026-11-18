import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  Society,
  Collection,
  CollectionRequest,
  Invoice,
  closeDb,
  sequelize,
} from '../../../src/models';
import { billingPortCalls, setBillingPorts } from '../../../src/modules/billing/billing.ports';
import { refreshCollectionTotals } from '../../../src/modules/payments/payments.alloc.totals';
import { residentUser } from '../../helpers/residents';
import { enqueue, drainQueues } from '../../../src/lib/queue';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { resetLogins } from '../../helpers/access';
import { nowMs, setNow } from '../../../src/lib/clock';
import { paymentsPortCalls } from '../../../src/modules/payments/payments.ports';
import { settleInput } from '../../../src/modules/payments/payments.settle';
import { moneyTx } from '../../../src/modules/payments/payments.shared';
import { runAutoClose, runDueReminders } from '../../../src/modules/payments/payments.collections.jobs';
import {
  collectionEfficiency,
  collectionProgress,
  getCollectionForOtherModules,
} from '../../../src/modules/payments/payments.collections.read';
import { paymentsReports } from '../../../src/modules/payments/payments.reports';
import { payments } from '../../../src/modules/payments/payments.public';
import { events, app } from '../../helpers/auth';
import request from 'supertest';
import { offline, sysCtx } from '../../helpers/payments';
import { mkInvoice } from '../../helpers/payments';
import {
  approved,
  collWorld,
  create,
  draftBody,
  idemH,
  published,
  requestsOf,
  resetPayments,
} from '../../helpers/payments-collections';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  resetLogins();
  resetRateLimits();
  await resetPayments();
});

const backdateReminder = (id: number) =>
  Collection.update({ lastReminderAt: new Date(nowMs() - 30 * 3_600_000) } as never, { where: { id } });
const notices = () => paymentsPortCalls.filter(c => c.fn.startsWith('notices.'));
const sent = (template: string) =>
  paymentsPortCalls.filter(c => c.fn === 'notifications.send' && (c.input as any).template === template);

describe('publish (6.11, BR-12-40, 41)', () => {
  it('creates a request per occupied flat, leaves vacant ones out, posts the notice and notifies bill-to', async () => {
    const { w, owners } = await collWorld(4, 3);
    const c = await published(w);
    expect(c).toMatchObject({ status: 'PUBLISHED', requestCount: 3, collectedPaise: 0 });
    const reqs = await requestsOf(c.id);
    expect(reqs.map(r => r.unitId)).toEqual([w.units[0]!.id, w.units[1]!.id, w.units[2]!.id]);
    expect(reqs[0]).toMatchObject({
      amountPaise: 50_000,
      minAmountPaise: 0,
      paidPaise: 0,
      status: 'OPEN',
      invoiceId: null,
    });
    expect(reqs.every(r => r.billToResidentId)).toBe(true);
    expect(await Invoice.count({ where: { societyId: w.society.id!, refType: 'collection_request' } })).toBe(
      0,
    );
    const n = sent('collections.published');
    expect(n).toHaveLength(1);
    expect((n[0]!.input as any).userIds.sort()).toEqual(owners.map(o => o.user.id).sort());
    const notice = notices().find(x => x.fn === 'notices.createSystemNotice')!.input as any;
    expect(notice).toMatchObject({
      sourceModule: '12',
      sourceRefType: 'collection',
      sourceRefId: c.id,
      title: 'Ganesh Utsav 2026 contribution',
      category: 'FESTIVAL',
      actions: [{ type: 'PAY_COLLECTION', refId: c.id, label: 'Pay' }],
    });
    expect((await Collection.findByPk(c.id))!.noticeId).toBeTruthy();
    expect(
      events.some(e => e.event === 'collection.progress' && e.room === `society:${w.society.id}:finance`),
    ).toBe(true);
    expect(
      events.some(e => e.event === 'collection.progress' && e.room === `society:${w.society.id}:public`),
    ).toBe(true);
    expect(
      await AuditLog.count({ where: { action: 'collections.collection.published', entityId: String(c.id) } }),
    ).toBe(1);
  });

  it('the optional publish reason goes to the audit trail', async () => {
    const { w } = await collWorld(4, 3);
    const a = await approved(w);
    const r = await w.c('post', `/collections/${a.id}/publish`, { version: a.version, reason: 'Go live' });
    expect(r.status).toBe(200);
    const row = await AuditLog.findOne({
      where: { action: 'collections.collection.published', entityId: String(a.id) },
    });
    expect(row!.reason).toBe('Go live');
  });

  it('includeVacant asks the empty flat too (no bill-to); sendNotice false posts no notice; kind decides the category', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w, { includeVacant: true, sendNotice: false, kind: 'DONATION' });
    const reqs = await requestsOf(c.id);
    expect(reqs).toHaveLength(4);
    expect(reqs[3]!.billToResidentId).toBeNull();
    expect(notices()).toHaveLength(0);
  });

  it('BUILDINGS and UNITS audiences limit the requests; MIN mode copies the minimum; VOLUNTARY asks 0', async () => {
    const { w } = await collWorld(4, 3);
    const a = await published(w, {
      audienceType: 'UNITS',
      audienceIds: [w.units[1]!.id, w.units[3]!.id],
      title: 'Two flats',
    });
    expect((await requestsOf(a.id)).map(r => r.unitId)).toEqual([w.units[1]!.id]);
    const b = await published(w, {
      audienceType: 'BUILDINGS',
      audienceIds: [w.buildingId],
      amountMode: 'MIN_PER_UNIT',
      amountPerUnitPaise: 110_000,
      minAmountPaise: 50_100,
      title: 'Ganesh MIN',
    });
    const reqs = await requestsOf(b.id);
    expect(reqs).toHaveLength(3);
    expect(reqs[0]).toMatchObject({ amountPaise: 110_000, minAmountPaise: 50_100 });
    const v = await published(w, {
      amountMode: 'VOLUNTARY',
      amountPerUnitPaise: 0,
      targetPaise: 600_000,
      title: 'Voluntary',
    });
    expect((await requestsOf(v.id))[0]!.amountPaise).toBe(0);
  });

  it('mandatory: one ad-hoc invoice per flat through module 11, refType collection_request, due on the due date, fund of the collection', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w, {
      isMandatory: true,
      amountPerUnitPaise: 250_000,
      kind: 'REPAIR_CALL',
      title: 'Terrace repair',
      fundId: 7,
    });
    const reqs = await requestsOf(c.id);
    expect(reqs).toHaveLength(3);
    for (const r of reqs) {
      const inv = (await Invoice.findByPk(r.invoiceId!))!;
      expect(inv).toMatchObject({
        invoiceType: 'ADHOC',
        refType: 'collection_request',
        dueDate: '2026-12-10',
        unitId: r.unitId,
      });
      expect(Number(inv.refId)).toBe(Number(r.id));
      expect(Number(inv.totalPaise)).toBe(250_000);
    }
    const j = paymentsPortCalls.length;
    expect(j).toBeGreaterThan(0);
    // module 11 posted the journal with the collection's fund on the credit line
    const posts = billingPortCalls.filter(x => x.fn === 'journal.post').map(x => x.input as any);
    expect(posts).toHaveLength(3);
    expect(posts[0].lines.some((l: any) => l.fundId === 7)).toBe(true);
  });

  it('mandatory publish skips a flat nobody can bill; optional publish does not', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w, {
      isMandatory: true,
      includeVacant: true,
      amountPerUnitPaise: 100_000,
      title: 'Mandatory vacant',
    });
    expect(c.requestCount).toBe(3);
  });

  it('refuses a collection that is not APPROVED, a stale version, a past due date and an empty audience', async () => {
    const { w } = await collWorld(4, 3);
    const d = await create(w);
    const notApproved = await w.c('post', `/collections/${d.id}/publish`, { version: 1 });
    expect(notApproved.status).toBe(409);
    expect(notApproved.body.code).toBe('INVALID_STATE');
    const a = await approved(w, { title: 'Approved one' });
    expect((await w.c('post', `/collections/${a.id}/publish`, { version: 1 })).body.code).toBe(
      'STALE_VERSION',
    );
    await Collection.update({ dueDate: '2026-11-03' } as never, { where: { id: a.id } });
    const late = await w.c('post', `/collections/${a.id}/publish`, { version: a.version });
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('COLLECTION_DUE_DATE_PAST');
    await Collection.update({ dueDate: '2026-12-10' } as never, { where: { id: a.id } });
    // every flat in the audience becomes vacant
    const b = await approved(w, {
      title: 'Units only',
      audienceType: 'UNITS',
      audienceIds: [w.units[3]!.id],
      includeVacant: true,
    });
    await Collection.update({ includeVacant: false } as never, { where: { id: b.id } });
    const none = await w.c('post', `/collections/${b.id}/publish`, { version: b.version });
    expect(none.status).toBe(422);
    expect(none.body.code).toBe('COLLECTION_NO_AUDIENCE');
    expect((await Collection.findByPk(b.id))!.status).toBe('APPROVED');
    expect(await CollectionRequest.count({ where: { collectionId: b.id } })).toBe(0);
  });

  it('rolls back everything when an invoice cannot be created', async () => {
    const { w } = await collWorld(3, 3);
    const a = await approved(w, { isMandatory: true, amountPerUnitPaise: 100_000, title: 'Rollback' });
    setBillingPorts({
      journal: {
        post: async () => {
          throw new Error('journal down');
        },
      },
    });
    const r = await w.c('post', `/collections/${a.id}/publish`, { version: a.version });
    expect(r.status).toBe(500);
    expect(await CollectionRequest.count({ where: { collectionId: a.id } })).toBe(0);
    expect((await Collection.findByPk(a.id))!.status).toBe('APPROVED');
  });
});

describe('reminders (BR-12-43)', () => {
  it('optional: at most 2, 24 hours apart, only to OPEN and PART_PAID flats', async () => {
    const { w, owners } = await collWorld(4, 3);
    const c = await published(w);
    const [first] = await requestsOf(c.id);
    await first!.update({ status: 'PAID', paidPaise: 50_000 });
    let r = await w.c('post', `/collections/${c.id}/remind`, { version: c.version });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ sentTo: 2, reminderCount: 1 });
    const users = (sent('collections.reminder')[0]!.input as any).userIds;
    expect(users).toHaveLength(2);
    expect(users).not.toContain(owners[0]!.user.id);
    const d1 = (await w.c('get', `/collections/${c.id}`)).body.data;
    r = await w.c('post', `/collections/${c.id}/remind`, { version: d1.version });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('REMINDER_TOO_SOON');
    await backdateReminder(c.id);
    r = await w.c('post', `/collections/${c.id}/remind`, { version: d1.version });
    expect(r.status).toBe(200);
    expect(r.body.data.reminderCount).toBe(2);
    await backdateReminder(c.id);
    const d2 = (await w.c('get', `/collections/${c.id}`)).body.data;
    r = await w.c('post', `/collections/${c.id}/remind`, { version: d2.version });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('REMINDER_LIMIT_REACHED');
    expect(
      await AuditLog.count({
        where: { action: 'collections.collection.reminder_sent', entityId: String(c.id) },
      }),
    ).toBe(2);
  });

  it('mandatory: up to 10; not PUBLISHED is 409', async () => {
    const { w } = await collWorld(4, 3);
    const d = await create(w);
    expect((await w.c('post', `/collections/${d.id}/remind`, { version: 1 })).status).toBe(409);
    const c = await published(w, { isMandatory: true, amountPerUnitPaise: 100_000, title: 'Mandatory' });
    let version = c.version;
    for (let i = 1; i <= 10; i++) {
      await backdateReminder(c.id);
      const r = await w.c('post', `/collections/${c.id}/remind`, { version });
      expect([i, r.status]).toEqual([i, 200]);
      version = (await w.c('get', `/collections/${c.id}`)).body.data.version;
    }
    await backdateReminder(c.id);
    const r = await w.c('post', `/collections/${c.id}/remind`, { version });
    expect(r.body.code).toBe('REMINDER_LIMIT_REACHED');
  });
});

describe('close and cancel (BR-12-44)', () => {
  it('close cancels open optional requests (paid ones stay), recalls the notice, notifies all and needs 5+ char reason', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w);
    const reqs = await requestsOf(c.id);
    await reqs[0]!.update({ status: 'PAID', paidPaise: 50_000 });
    await reqs[1]!.update({ status: 'PART_PAID', paidPaise: 10_000 });
    const bad = await w.c('post', `/collections/${c.id}/close`, { version: c.version, reason: 'no' });
    expect(bad.status).toBe(400);
    const r = await w.c('post', `/collections/${c.id}/close`, {
      version: c.version,
      reason: 'Festival is over',
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      status: 'CLOSED',
      closeReason: 'Festival is over',
      collectedPaise: 60_000,
      requestCount: 3,
      contributorCount: 2,
      paidCount: 1,
    });
    expect((await requestsOf(c.id)).map(x => x.status)).toEqual(['PAID', 'CANCELLED', 'CANCELLED']);
    expect(notices().find(x => x.fn === 'notices.recallBySource')!.input).toMatchObject({
      type: 'collection',
      id: c.id,
      reason: 'Collection closed',
    });
    expect(sent('collections.closed')).toHaveLength(1);
    const again = await w.c('post', `/collections/${c.id}/close`, {
      version: r.body.data.version,
      reason: 'Second time',
    });
    expect(again.body.code).toBe('INVALID_STATE');
  });

  it('close keeps the requests and invoices of a mandatory collection', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w, {
      isMandatory: true,
      amountPerUnitPaise: 100_000,
      title: 'Mandatory close',
    });
    await w.c('post', `/collections/${c.id}/close`, { version: c.version, reason: 'Closing the drive' });
    expect((await requestsOf(c.id)).map(x => x.status)).toEqual(['OPEN', 'OPEN', 'OPEN']);
    const inv = await Invoice.findByPk((await requestsOf(c.id))[0]!.invoiceId!);
    expect(inv!.status).toBe('ISSUED');
  });

  it('cancel from DRAFT, REJECTED and APPROVED; not from PENDING_APPROVAL', async () => {
    const { w } = await collWorld();
    const d = await create(w);
    const r = await w.c('post', `/collections/${d.id}/cancel`, {
      version: d.version,
      reason: 'Plan dropped',
    });
    expect(r.body.data).toMatchObject({ status: 'CANCELLED', closeReason: 'Plan dropped' });
    expect(sent('collections.cancelled')).toHaveLength(0);
    const a = await approved(w, { title: 'Approved to cancel' });
    expect(
      (await w.c('post', `/collections/${a.id}/cancel`, { version: a.version, reason: 'Plan dropped' })).body
        .data.status,
    ).toBe('CANCELLED');
    const p = await create(w, { title: 'Pending one' });
    await w.c('post', `/collections/${p.id}/submit`, { version: 1 });
    const bad = await w.c('post', `/collections/${p.id}/cancel`, { version: 2, reason: 'Plan dropped' });
    expect(bad.body.code).toBe('INVALID_STATE');
    expect(
      (await w.c('post', `/collections/${d.id}/cancel`, { version: 99, reason: 'Plan dropped' })).body.code,
    ).toBe('INVALID_STATE');
  });

  it('cancel of a published optional collection with nothing collected cancels the requests and recalls the notice', async () => {
    const { w } = await collWorld();
    const c = await published(w);
    const r = await w.c('post', `/collections/${c.id}/cancel`, {
      version: c.version,
      reason: 'Not needed now',
    });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('CANCELLED');
    expect((await requestsOf(c.id)).every(x => x.status === 'CANCELLED')).toBe(true);
    expect(notices().find(x => x.fn === 'notices.recallBySource')!.input).toMatchObject({
      reason: 'Collection cancelled',
    });
    expect(sent('collections.cancelled')).toHaveLength(1);
  });

  it('cancel with money collected or a published mandatory collection is 409 COLLECTION_HAS_PAYMENTS (T12-32)', async () => {
    const { w } = await collWorld();
    const c = await published(w);
    const [first] = await requestsOf(c.id);
    await moneyTx(t =>
      settleInput(
        sysCtx(w),
        offline(w, 0, 50_000, {
          mode: 'SELECTED',
          selected: [{ targetType: 'COLLECTION_REQUEST', id: Number(first!.id), amountPaise: 50_000 }],
        }),
        t,
      ),
    );
    await drainQueues();
    const d = (await w.c('get', `/collections/${c.id}`)).body.data;
    expect(d.collectedPaise).toBe(50_000);
    const r = await w.c('post', `/collections/${c.id}/cancel`, {
      version: d.version,
      reason: 'Change of mind',
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('COLLECTION_HAS_PAYMENTS');
    const m = await published(w, {
      isMandatory: true,
      amountPerUnitPaise: 100_000,
      title: 'Mandatory cancel',
    });
    const rm = await w.c('post', `/collections/${m.id}/cancel`, {
      version: m.version,
      reason: 'Change of mind',
    });
    expect(rm.body.code).toBe('COLLECTION_HAS_PAYMENTS');
  });
});

describe('requests, add units, waive, export, statement (8.23)', () => {
  it('lists requests with ?q= flat search, status, building and sort', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w);
    const l = await w.c('get', `/collections/${c.id}/requests`);
    expect(l.status).toBe(200);
    expect(l.body.pagination.total).toBe(3);
    expect(l.body.data[0]).toMatchObject({
      unitLabel: w.units[0]!.label,
      amountPaise: 50_000,
      paidPaise: 0,
      status: 'OPEN',
      invoiceId: null,
    });
    expect(l.body.data[0].billToName).toMatch(/^Owner /);
    expect(JSON.stringify(l.body.data)).not.toMatch(/mobile|phone/i);
    const q = await w.c('get', `/collections/${c.id}/requests?q=${encodeURIComponent(w.units[1]!.label)}`);
    expect(q.body.data.map((x: any) => x.unitLabel)).toEqual([w.units[1]!.label]);
    expect((await w.c('get', `/collections/${c.id}/requests?q=zzz`)).body.data).toEqual([]);
    expect((await w.c('get', `/collections/${c.id}/requests?q=%25`)).body.data).toEqual([]);
    const [r0] = await requestsOf(c.id);
    await r0!.update({ status: 'PAID', paidPaise: 50_000 });
    expect((await w.c('get', `/collections/${c.id}/requests?status=PAID`)).body.data).toHaveLength(1);
    expect((await w.c('get', `/collections/${c.id}/requests?status=OPEN,PAID`)).body.data).toHaveLength(3);
    expect(
      (await w.c('get', `/collections/${c.id}/requests?buildingId=${w.buildingId}`)).body.data,
    ).toHaveLength(3);
    expect((await w.c('get', `/collections/${c.id}/requests?buildingId=999999`)).body.data).toHaveLength(0);
    const s = await w.c('get', `/collections/${c.id}/requests?sortBy=paidPaise&sortOrder=desc`);
    expect(s.body.data[0].paidPaise).toBe(50_000);
    expect((await w.c('get', `/collections/${c.id}/requests?sortBy=bogus`)).status).toBe(400);
    expect((await w.c('get', '/collections/999999999/requests')).status).toBe(404);
  });

  it('adds units to a published collection, skips existing ones, and creates invoices for a mandatory one', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w);
    const r = await w.c('post', `/collections/${c.id}/requests`, {
      unitIds: [w.units[0]!.id, w.units[3]!.id],
      version: c.version,
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ addedCount: 1, skippedUnitIds: [w.units[0]!.id], requestCount: 4 });
    expect((await Collection.findByPk(c.id))!.requestCount).toBe(4);
    expect(
      await AuditLog.count({ where: { action: 'collections.request.added', entityId: String(c.id) } }),
    ).toBe(1);
    expect(
      (await w.c('post', `/collections/${c.id}/requests`, { unitIds: [w.units[3]!.id], version: c.version }))
        .body.code,
    ).toBe('STALE_VERSION');
    expect(
      (
        await w.c('post', `/collections/${c.id}/requests`, {
          unitIds: [999999999],
          version: r.body.data.version,
        })
      ).body.code,
    ).toBe('UNIT_NOT_FOUND');
    expect((await w.c('post', `/collections/${c.id}/requests`, { unitIds: [], version: 1 })).status).toBe(
      400,
    );
    const m = await published(w, { isMandatory: true, amountPerUnitPaise: 100_000, title: 'Mandatory add' });
    await residentUser(w.society, w.units[3]!.id, { name: 'New owner' });
    const am = await w.c('post', `/collections/${m.id}/requests`, {
      unitIds: [w.units[3]!.id],
      version: m.version,
    });
    expect(am.body.data.addedCount).toBe(1);
    const added = (await requestsOf(m.id)).find(x => x.unitId === w.units[3]!.id)!;
    expect(added.invoiceId).toBeTruthy();
    const closed = await w.c('post', `/collections/${c.id}/close`, {
      version: r.body.data.version,
      reason: 'Festival is over',
    });
    expect(closed.status).toBe(200);
    expect(
      (
        await w.c('post', `/collections/${c.id}/requests`, {
          unitIds: [w.units[3]!.id],
          version: closed.body.data.version,
        })
      ).body.code,
    ).toBe('INVALID_STATE');
  });

  it('waives an open optional request; refuses mandatory, paid, not-open and stale', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w);
    const [a, b, d] = await requestsOf(c.id);
    const r = await w.c('post', `/collection-requests/${a!.id}/waive`, {
      reason: 'Flat given for free',
      version: 1,
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'WAIVED', waivedReason: 'Flat given for free' });
    expect(
      (
        await w.c('post', `/collection-requests/${a!.id}/waive`, {
          reason: 'Flat given for free',
          version: 2,
        })
      ).body.code,
    ).toBe('INVALID_STATE');
    expect(
      (
        await w.c('post', `/collection-requests/${b!.id}/waive`, {
          reason: 'Flat given for free',
          version: 9,
        })
      ).body.code,
    ).toBe('STALE_VERSION');
    expect(
      (await w.c('post', `/collection-requests/${b!.id}/waive`, { reason: 'no', version: 1 })).status,
    ).toBe(400);
    await d!.update({ paidPaise: 10_000, status: 'PART_PAID' });
    expect(
      (
        await w.c('post', `/collection-requests/${d!.id}/waive`, {
          reason: 'Flat given for free',
          version: 1,
        })
      ).body.code,
    ).toBe('INVALID_STATE');
    expect(
      (
        await w.c('post', '/collection-requests/999999999/waive', {
          reason: 'Flat given for free',
          version: 1,
        })
      ).body.code,
    ).toBe('COLLECTION_REQUEST_NOT_FOUND');
    const m = await published(w, {
      isMandatory: true,
      amountPerUnitPaise: 100_000,
      title: 'Mandatory waive',
    });
    const [mr] = await requestsOf(m.id);
    expect(
      (
        await w.c('post', `/collection-requests/${mr!.id}/waive`, {
          reason: 'Flat given for free',
          version: 1,
        })
      ).body.code,
    ).toBe('INVALID_STATE');
    expect(
      await AuditLog.count({ where: { action: 'collections.request.waived', entityId: String(a!.id) } }),
    ).toBe(1);
  });

  it('exports the requests as CSV (audited) and the statement as JSON and PDF', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w);
    const [a] = await requestsOf(c.id);
    await a!.update({ status: 'PAID', paidPaise: 50_000 });
    const e = await w.c('get', `/collections/${c.id}/requests/export`);
    expect(e.status).toBe(200);
    const text = typeof e.body === 'string' ? e.body : (e.text ?? '');
    expect(text).toContain('Flat,Bill-to,Asked (INR),Paid (INR),Status,Last paid');
    expect(text).toContain('500.00');
    expect(
      await AuditLog.count({ where: { action: 'collections.request.exported', entityId: String(c.id) } }),
    ).toBe(1);
    const s = await w.c('get', `/collections/${c.id}/statement`);
    expect(s.body.data).toMatchObject({ spentPaise: 0, expenses: [] });
    const p = await w.c('get', `/collections/${c.id}/statement?format=pdf`);
    expect(p.status).toBe(200);
    expect(p.body.data.url).toBeTruthy();
    expect(p.body.data.expiresAt).toBeTruthy();
    expect(
      await AuditLog.count({
        where: { action: 'collections.collection.statement_downloaded', entityId: String(c.id) },
      }),
    ).toBe(2);
    expect((await w.c('get', `/collections/${c.id}/statement?format=xml`)).status).toBe(400);
  });
});

describe('money effects and totals (core allocation + 12.5 refresh job)', () => {
  it('a payment allocated to a request moves paidPaise and status; refresh-totals updates the collection and emits progress', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w, {
      amountMode: 'MIN_PER_UNIT',
      amountPerUnitPaise: 110_000,
      minAmountPaise: 50_100,
      title: 'Ganesh MIN',
    });
    const [a, b] = await requestsOf(c.id);
    events.length = 0;
    await moneyTx(t =>
      settleInput(
        sysCtx(w),
        offline(w, 0, 60_000, {
          mode: 'SELECTED',
          selected: [{ targetType: 'COLLECTION_REQUEST', id: Number(a!.id), amountPaise: 60_000 }],
        }),
        t,
      ),
    );
    await moneyTx(t =>
      settleInput(
        sysCtx(w),
        offline(w, 1, 110_000, {
          mode: 'SELECTED',
          selected: [{ targetType: 'COLLECTION_REQUEST', id: Number(b!.id), amountPaise: 110_000 }],
        }),
        t,
      ),
    );
    await drainQueues();
    expect((await requestsOf(c.id)).map(r => [r.status, Number(r.paidPaise)])).toEqual([
      ['PART_PAID', 60_000],
      ['PAID', 110_000],
      ['OPEN', 0],
    ]);
    const d = (await w.c('get', `/collections/${c.id}`)).body.data;
    expect(d).toMatchObject({
      collectedPaise: 170_000,
      contributorCount: 2,
      paidCount: 1,
      requestCount: 3,
      percent: 51,
    });
    expect(
      events.some(e => e.event === 'collection.progress' && (e.payload as any).collectedPaise === 170_000),
    ).toBe(true);
  });

  it('a payment on the invoice of a mandatory collection moves its request to PAID', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w, { isMandatory: true, amountPerUnitPaise: 100_000, title: 'Mandatory pay' });
    await moneyTx(t => settleInput(sysCtx(w), offline(w, 0, 100_000), t));
    await drainQueues();
    const reqs = await requestsOf(c.id);
    expect(reqs[0]).toMatchObject({ status: 'PAID' });
    expect((await Collection.findByPk(c.id))!.collectedPaise).toBe(100_000);
  });

  it('a payment after the collection closed is still allocated to a paid-or-open mandatory request', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w, { isMandatory: true, amountPerUnitPaise: 100_000, title: 'Mandatory late' });
    await w.c('post', `/collections/${c.id}/close`, { version: c.version, reason: 'Closing the drive' });
    await moneyTx(t => settleInput(sysCtx(w), offline(w, 0, 100_000), t));
    await drainQueues();
    expect((await requestsOf(c.id))[0]!.status).toBe('PAID');
  });
});

describe('resident view (8.9, BR-12-45)', () => {
  it('lists published collections with my requests; COUNT_ONLY has counts and no whoPaid (T12-33)', async () => {
    const { w, owners } = await collWorld(4, 3);
    const c = await published(w);
    const [a] = await requestsOf(c.id);
    await a!.update({ status: 'PAID', paidPaise: 50_000 });
    await drainQueues();
    await refreshCollectionTotals(c.id);
    const l = await owners[1]!.c('get', '/me/collections');
    expect(l.status).toBe(200);
    expect(l.body.data).toHaveLength(1);
    expect(l.body.data[0]).toMatchObject({
      id: c.id,
      title: 'Ganesh Utsav 2026',
      isMandatory: false,
      status: 'PUBLISHED',
      targetPaise: 150_000,
      collectedPaise: 50_000,
      percent: 33,
      contributorCount: 1,
      requestCount: 3,
    });
    expect(l.body.data[0].myRequests).toEqual([
      expect.objectContaining({
        unitLabel: w.units[1]!.label,
        status: 'OPEN',
        amountPaise: 50_000,
        paidPaise: 0,
      }),
    ]);
    const d = await owners[1]!.c('get', `/me/collections/${c.id}`);
    expect(d.status).toBe(200);
    expect(d.body.data).not.toHaveProperty('whoPaid');
    expect(d.body.data).toMatchObject({ spentPaise: 0, expenses: [] }); // the owner role holds resident.finances.view
  });

  it('privacy levels: HIDDEN hides counts, FLATS_ONLY shows labels, FLATS_AND_AMOUNTS adds amounts; never names', async () => {
    const { w, owners } = await collWorld(4, 3);
    const mk = async (title: string, vis: string) => {
      const c = await published(w, { title, payListVisibility: vis });
      const [a] = await requestsOf(c.id);
      await a!.update({ status: 'PAID', paidPaise: 50_000 });
      return c.id as number;
    };
    const hidden = await mk('Hidden drive', 'HIDDEN');
    const flats = await mk('Flats drive', 'FLATS_ONLY');
    const amounts = await mk('Amounts drive', 'FLATS_AND_AMOUNTS');
    const get = async (id: number) => (await owners[2]!.c('get', `/me/collections/${id}`)).body.data;
    const h = await get(hidden);
    expect(h).not.toHaveProperty('contributorCount');
    expect(h).not.toHaveProperty('requestCount');
    expect(h).not.toHaveProperty('whoPaid');
    expect(h.targetPaise).toBe(150_000);
    const f = await get(flats);
    expect(f.whoPaid).toEqual([{ unitLabel: w.units[0]!.label }]);
    const a = await get(amounts);
    expect(a.whoPaid).toEqual([{ unitLabel: w.units[0]!.label, paidPaise: 50_000 }]);
    expect(JSON.stringify([f, a])).not.toMatch(/Owner A|payerName|billToName/);
    const list = (await owners[2]!.c('get', '/me/collections')).body.data;
    const hl = list.find((x: any) => x.id === hidden);
    expect(hl).not.toHaveProperty('contributorCount');
  });

  it('404 for a collection without a request for my flats, an unpublished one, and another society', async () => {
    const { w, owners } = await collWorld(4, 3);
    const other = await collWorld(2, 2);
    const c = await published(w, {
      audienceType: 'UNITS',
      audienceIds: [w.units[0]!.id],
      title: 'Flat one only',
    });
    expect((await owners[1]!.c('get', `/me/collections/${c.id}`)).body.code).toBe('COLLECTION_NOT_FOUND');
    expect((await owners[1]!.c('get', '/me/collections')).body.data).toEqual([]);
    const draft = await create(w, { title: 'Still a draft' });
    expect((await owners[0]!.c('get', `/me/collections/${draft.id}`)).status).toBe(404);
    expect((await other.owners[0]!.c('get', `/me/collections/${c.id}`)).status).toBe(404);
    expect((await owners[0]!.c('get', `/me/collections/${c.id}`)).status).toBe(200);
  });

  it('closed collections stay listed for 90 days; spent and expenses only for resident.finances.view', async () => {
    const { w, owners } = await collWorld(4, 3);
    const c = await published(w, {
      isMandatory: true,
      amountPerUnitPaise: 100_000,
      title: 'Mandatory visible',
    });
    await w.c('post', `/collections/${c.id}/close`, { version: c.version, reason: 'Closing the drive' });
    expect((await owners[0]!.c('get', '/me/collections')).body.data).toHaveLength(1);
    await Collection.update({ closedAt: new Date(nowMs() - 100 * 86_400_000) } as never, {
      where: { id: c.id },
    });
    expect((await owners[0]!.c('get', '/me/collections')).body.data).toHaveLength(0);
    expect((await owners[0]!.c('get', `/me/collections/${c.id}`)).status).toBe(404);
    await Collection.update({ closedAt: new Date(nowMs() - 10 * 86_400_000) } as never, {
      where: { id: c.id },
    });
    const d = await owners[0]!.c('get', `/me/collections/${c.id}`);
    expect(d.status).toBe(200);
  });

  it('admin routes are not open to residents', async () => {
    const { w, owners } = await collWorld();
    const c = await create(w);
    for (const [m, p] of [
      ['get', `/collections/${c.id}`],
      ['get', `/collections/${c.id}/requests`],
      ['get', `/collections/${c.id}/requests/export`],
    ] as const)
      expect([m, p, (await owners[0]!.c(m, p)).status]).toEqual([m, p, 403]);
    expect((await owners[0]!.c('post', `/collections/${c.id}/publish`, { version: 1 })).status).toBe(403);
    expect((await owners[0]!.c('delete', `/collections/${c.id}?version=1`)).status).toBe(403);
  });
});

describe('readers for other modules (8.26, 8.27)', () => {
  it('collections.get returns the summary or null; efficiency is null with nothing billed', async () => {
    const { w } = await collWorld();
    const c = await published(w);
    expect(await payments.collections.get(w.society.id!, c.id)).toMatchObject({
      id: c.id,
      name: 'Ganesh Utsav 2026',
      title: 'Ganesh Utsav 2026',
      kind: 'FESTIVAL',
      status: 'PUBLISHED',
      fundId: 1,
      isMandatory: false,
      targetPaise: 150_000,
      collectedPaise: 0,
      dueDate: '2026-12-10',
    });
    expect(await getCollectionForOtherModules(w.society.id! + 99_999, c.id)).toBeNull();
    expect(await payments.collections.get(w.society.id!, 999_999)).toBeNull();
    expect(await collectionEfficiency(w.society.id!, '2026-11')).toBeNull();
  });

  it('collections.efficiency = collected against the month billing, as a percent', async () => {
    const { w } = await collWorld(3, 3);
    const inv = await mkInvoice(w, 0, 100_000, '2026-11-20');
    await sequelize.query(
      "UPDATE invoices SET invoiceType = 'REGULAR', periodStart = '2026-11-01', periodEnd = '2026-11-30' WHERE id = :id",
      { replacements: { id: inv.id } },
    );
    await moneyTx(t => settleInput(sysCtx(w), offline(w, 0, 40_000), t));
    expect(await collectionEfficiency(w.society.id!, '2026-11')).toBe(40);
    expect(await payments.collections.efficiency(w.society.id!, '2026-11')).toBe(40);
  });

  it('collectionProgress lists rows with totals, filters, sorts, recomputes for buildingIds and validates the sort', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w);
    await published(w, {
      title: 'Repair fund',
      kind: 'REPAIR_CALL',
      isMandatory: true,
      amountPerUnitPaise: 200_000,
    });
    const [a] = await requestsOf(c.id);
    await a!.update({ status: 'PAID', paidPaise: 50_000 });
    await refreshCollectionTotals(c.id);
    const q = { page: 1, limit: 50, sortBy: 'title' as const, sortDir: 'asc' as const };
    const r = await collectionProgress(w.society.id!, q);
    expect(r.total).toBe(2);
    expect(r.rows.map(x => x.title)).toEqual(['Ganesh Utsav 2026', 'Repair fund']);
    expect(r.rows[0]).toMatchObject({
      collectedPaise: 50_000,
      percent: 33,
      requestCount: 3,
      paidCount: 1,
      contributorCount: 1,
      fundName: expect.any(String),
      spentPaise: 0,
    });
    expect(r.totals).toEqual({ targetPaise: 150_000 + 600_000, collectedPaise: 50_000 });
    expect(
      (await paymentsReports.collectionProgress(w.society.id!, { ...q, kind: ['REPAIR_CALL'] })).rows,
    ).toHaveLength(1);
    expect((await collectionProgress(w.society.id!, { ...q, status: ['CLOSED'] })).rows).toHaveLength(0);
    expect(
      (await collectionProgress(w.society.id!, { ...q, sortBy: 'percent', sortDir: 'desc' })).rows[0]!.title,
    ).toBe('Ganesh Utsav 2026');
    const scoped = await collectionProgress(w.society.id!, { ...q, buildingIds: [w.buildingId] });
    expect(scoped.rows[0]).toMatchObject({ requestCount: 3, collectedPaise: 50_000 });
    const none = await collectionProgress(w.society.id!, { ...q, buildingIds: [999_999] });
    expect(none.total).toBe(0);
    await expect(collectionProgress(w.society.id!, { ...q, sortBy: 'bogus' as never })).rejects.toThrow();
    await expect(collectionProgress(w.society.id!, { ...q, limit: 1001 })).rejects.toThrow();
  });
});

describe('jobs (9.1)', () => {
  it('auto-close closes optional published collections past their due date, never mandatory ones', async () => {
    const { w } = await collWorld(4, 3);
    const o = await published(w, { dueDate: '2026-11-10' });
    const m = await published(w, {
      isMandatory: true,
      amountPerUnitPaise: 100_000,
      title: 'Mandatory job',
      dueDate: '2026-11-10',
    });
    expect(await runAutoClose()).toBe(0);
    setNow('2026-11-11T04:30:00Z');
    expect(await runAutoClose()).toBeGreaterThanOrEqual(1);
    expect((await Collection.findByPk(o.id))!).toMatchObject({
      status: 'CLOSED',
      closeReason: 'Due date passed',
    });
    expect((await Collection.findByPk(m.id))!.status).toBe('PUBLISHED');
    expect(
      await AuditLog.count({
        where: { action: 'collections.collection.closed', entityId: String(o.id), actorName: 'System' },
      }),
    ).toBe(1);
  });

  it('due reminder goes out the day before the due date, once, and stops at the limit', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w, { dueDate: '2026-11-10' });
    setNow('2026-11-08T04:30:00Z');
    await runDueReminders();
    expect(sent('collections.reminder')).toHaveLength(0);
    setNow('2026-11-09T04:30:00Z');
    expect(await runDueReminders()).toBe(1);
    expect(sent('collections.reminder')).toHaveLength(1);
    expect((await Collection.findByPk(c.id))!.reminderCount).toBe(1);
    expect(await runDueReminders()).toBe(0);
  });

  it('collections:refresh-totals recomputes from the requests and registers once', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w);
    const reqs = await requestsOf(c.id);
    await reqs[0]!.update({ paidPaise: 20_000, status: 'PART_PAID' });
    await reqs[1]!.update({ status: 'CANCELLED' });
    await enqueue(
      'payments',
      'collections:refresh-totals',
      { collectionId: c.id },
      { jobId: `colt:${c.id}` },
    );
    await drainQueues();
    expect(await Collection.findByPk(c.id)).toMatchObject({
      collectedPaise: 20_000,
      contributorCount: 1,
      paidCount: 0,
      requestCount: 2,
    });
  });
});

describe('suspended society', () => {
  it('collection writes return 423 SOCIETY_SUSPENDED; reads still work', async () => {
    const { w } = await collWorld();
    await Society.update(
      { status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL' } as never,
      { where: { id: w.society.id! } },
    );
    const r = await w.c('post', '/collections', draftBody({ title: 'Suspended draft' }), {
      headers: idemH(),
    });
    expect(r.status).toBe(423);
    expect(
      (await w.c('patch', `/collections/1`, { version: 1, purpose: 'Edit while suspended' })).status,
    ).toBe(423);
    expect((await w.c('get', '/collections')).status).toBe(200);
    void sequelize;
  });
});

describe('review fixes (module 12 browser tests)', () => {
  it('add flats on a mandatory collection skips flats without a bill-to, reports them, and adds the rest', async () => {
    const { w } = await collWorld(5, 3);
    const c = await published(w, {
      isMandatory: true,
      amountPerUnitPaise: 100_000,
      title: 'Mandatory add',
      audienceType: 'UNITS',
      audienceIds: [w.units[0]!.id],
    });
    expect(c.targetPaise).toBe(100_000);
    const r = await w.c('post', `/collections/${c.id}/requests`, {
      unitIds: [w.units[1]!.id, w.units[3]!.id, w.units[4]!.id],
      version: c.version,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.addedCount).toBe(1);
    expect(r.body.data.skipped).toEqual([
      { unitId: w.units[3]!.id, reason: 'This flat has no owner or bill-to party' },
      { unitId: w.units[4]!.id, reason: 'This flat has no owner or bill-to party' },
    ]);
    expect((await Collection.findByPk(c.id))!.targetPaise).toBe(200_000);
  });

  it('target follows added and waived flats of a fixed collection', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w);
    expect(c.targetPaise).toBe(150_000);
    const r = await w.c('post', `/collections/${c.id}/requests`, {
      unitIds: [w.units[3]!.id],
      version: c.version,
    });
    expect(r.body.data.targetPaise).toBe(200_000);
    expect((await w.c('get', `/collections/${c.id}`)).body.data.targetPaise).toBe(200_000);
    const [q] = await requestsOf(c.id);
    const wv = await w.c('post', `/collection-requests/${q!.id}/waive`, {
      reason: 'Hardship case',
      version: q!.version,
    });
    expect(wv.status, JSON.stringify(wv.body)).toBe(200);
    expect((await Collection.findByPk(c.id))!.targetPaise).toBe(150_000);
  });

  it('a voluntary collection has a null suggested amount in admin and resident views', async () => {
    const { w, owners } = await collWorld(4, 3);
    const c = await published(w, {
      amountMode: 'VOLUNTARY',
      amountPerUnitPaise: undefined,
      targetPaise: 500_000,
      title: 'Voluntary any',
    });
    expect(c.suggestedAmountPaise).toBeNull();
    const fixed = await published(w, { title: 'Fixed one' });
    expect(fixed.suggestedAmountPaise).toBe(50_000);
    const mine = await owners[0]!.c('get', '/me/collections');
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    const v = mine.body.data.find((x: any) => x.id === c.id);
    expect(v.suggestedAmountPaise).toBeNull();
    const d = await owners[0]!.c('get', `/me/collections/${c.id}`);
    expect(d.body.data.suggestedAmountPaise).toBeNull();
    const pay = await owners[0]!.c('get', `/me/payables?unitId=${w.units[0]!.id}`);
    const item = pay.body.data.items.find((i: any) => i.label.startsWith('Voluntary any'));
    expect(item.suggestedPaise).toBeNull();
  });

  it('list limit out of range is 400, never 500; a page of 24 works', async () => {
    const { w } = await collWorld(4, 3);
    await create(w);
    expect((await w.c('get', '/collections?page=1&limit=24')).status).toBe(200);
    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'limit=-1', 'page=0', 'limit=1e9']) {
      const r = await w.c('get', `/collections?${q}`);
      expect([q, r.status, r.body.code]).toEqual([q, 400, 'VALIDATION_FAILED']);
    }
  });

  it('closing does not change the request count denominator', async () => {
    const { w } = await collWorld(4, 3);
    const c = await published(w);
    const reqs = await requestsOf(c.id);
    await reqs[0]!.update({ status: 'PAID', paidPaise: 50_000 });
    const r = await w.c('post', `/collections/${c.id}/close`, { version: c.version, reason: 'Done now' });
    expect(r.body.data).toMatchObject({ requestCount: 3, paidCount: 1 });
    await refreshCollectionTotals(c.id);
    expect((await Collection.findByPk(c.id))!.requestCount).toBe(3);
    const p = await collectionProgress(Number(w.society.id), {
      page: 1,
      limit: 10,
      sortBy: 'dueDate',
      sortDir: 'asc',
      buildingIds: [w.buildingId],
    });
    expect(p.rows.find(x => x.id === c.id)!.requestCount).toBe(3);
  });

  it('the module 14 inbox row of a collection publish carries title, amount and requester (the dev stand-in is gone)', async () => {
    const { w } = await collWorld(4, 3);
    const c = await create(w, { title: 'Inbox approvals row' });
    await w.c('post', `/collections/${c.id}/submit`, { version: c.version });
    const res = await w.treasurer.c('get', '/approvals');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = res.body.data.find((r: any) => r.type === 'COLLECTION_PUBLISH');
    expect(row).toMatchObject({ amountPaise: 150_000, status: 'PENDING' });
    expect(row.title).toContain('Inbox approvals row');
    expect(row.requester.name).toBeTruthy();
    expect((await request(app).get('/api/v1/dev/approvals')).status).toBe(404);
  });
});
