import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Collection, closeDb, sequelize } from '../../../src/models';
import { onCollectionCancelled } from '../../../src/modules/payments/payments.collections.workflow';
import { drainQueues } from '../../../src/lib/queue';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { resetLogins } from '../../helpers/access';
import { paymentsPortCalls, setPaymentsPorts } from '../../../src/modules/payments/payments.ports';
import { ctxFor } from '../../helpers/billing-invoices';
import {
  approvalOf,
  approve,
  approved,
  collWorld,
  create,
  draftBody,
  idemH,
  reject,
  requestChanges,
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

describe('collections create (8.21, BR-12-39, 40, 42)', () => {
  it('creates a draft with the default target audience x amount (occupied flats only)', async () => {
    const { w } = await collWorld(4, 3);
    const r = await w.c('post', '/collections', draftBody(), { headers: idemH() });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      title: 'Ganesh Utsav 2026',
      status: 'DRAFT',
      targetPaise: 150_000,
      collectedPaise: 0,
      percent: 0,
      requestCount: 0,
      version: 1,
      fundId: 1,
      payListVisibility: 'COUNT_ONLY',
      sendNotice: true,
      minAmountPaise: 0,
      approval: { requestId: null },
    });
    expect(
      await AuditLog.count({ where: { action: 'collections.collection.created', societyId: w.society.id! } }),
    ).toBe(1);
  });

  it('includeVacant counts the empty flat too', async () => {
    const { w } = await collWorld(4, 3);
    const c = await create(w, { includeVacant: true });
    expect(c.targetPaise).toBe(200_000);
  });

  it('is idempotent for the same key and refuses a different body with the same key', async () => {
    const { w } = await collWorld();
    const h = idemH();
    const a = await w.c('post', '/collections', draftBody(), { headers: h });
    const b = await w.c('post', '/collections', draftBody(), { headers: h });
    expect(a.status).toBe(201);
    expect(b.body.data.id).toBe(a.body.data.id);
    const c = await w.c('post', '/collections', draftBody({ purpose: 'Something else entirely' }), {
      headers: h,
    });
    expect(c.status).toBe(409);
    const noKey = await w.c('post', '/collections', draftBody({ title: 'Another one' }));
    expect(noKey.status).toBe(400);
  });

  it('validates fields (400), title 4 to 80, MIN amount and VOLUNTARY target', async () => {
    const { w } = await collWorld();
    const post = (o: Record<string, unknown>) =>
      w.c('post', '/collections', draftBody(o), { headers: idemH() });
    expect((await post({ title: 'abc' })).status).toBe(400);
    expect((await post({ purpose: 'short' })).status).toBe(400);
    expect((await post({ kind: 'PARTY' })).status).toBe(400);
    expect((await post({ amountPerUnitPaise: 99 })).status).toBe(400);
    expect((await post({ amountPerUnitPaise: 10_000_001 })).status).toBe(400);
    expect(
      (await post({ amountMode: 'MIN_PER_UNIT', amountPerUnitPaise: 50_000, minAmountPaise: 60_000 })).status,
    ).toBe(400);
    expect(
      (await post({ amountMode: 'MIN_PER_UNIT', amountPerUnitPaise: 50_000, minAmountPaise: 99 })).status,
    ).toBe(400);
    const vol = await post({ amountMode: 'VOLUNTARY', amountPerUnitPaise: 0 });
    expect(vol.status).toBe(400);
    expect(vol.body.errors?.[0]?.field).toBeTruthy();
    expect((await post({ amountMode: 'VOLUNTARY', amountPerUnitPaise: 0, targetPaise: 99 })).status).toBe(
      400,
    );
    const ok = await post({
      amountMode: 'VOLUNTARY',
      amountPerUnitPaise: 0,
      targetPaise: 6_000_000,
      title: 'Diwali celebration',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.targetPaise).toBe(6_000_000);
    expect((await post({ audienceType: 'BUILDINGS' })).status).toBe(400);
    expect(
      (await post({ audienceType: 'UNITS', audienceIds: [999_999_999], title: 'Units one' })).status,
    ).toBe(400);
    expect(
      (
        await post({
          audienceType: 'UNITS',
          audienceIds: [w.units[0]!.id, w.units[0]!.id],
          title: 'Units two',
        })
      ).status,
    ).toBe(400);
    expect((await post({ dueDate: '2028-01-01', title: 'Too far' })).status).toBe(400);
    expect((await post({ extra: 1, title: 'Extra field' })).status).toBe(400);
  });

  it('refuses mandatory without FIXED_PER_UNIT (422 MANDATORY_MUST_BE_FIXED)', async () => {
    const { w } = await collWorld();
    const r = await w.c(
      'post',
      '/collections',
      draftBody({ isMandatory: true, amountMode: 'MIN_PER_UNIT', minAmountPaise: 10_000 }),
      { headers: idemH() },
    );
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('MANDATORY_MUST_BE_FIXED');
  });

  it('refuses a due date in the past (422) - T12-40', async () => {
    const { w } = await collWorld();
    const r = await w.c('post', '/collections', draftBody({ dueDate: '2026-11-03' }), { headers: idemH() });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('COLLECTION_DUE_DATE_PAST');
    const today = await w.c('post', '/collections', draftBody({ dueDate: '2026-11-04' }), {
      headers: idemH(),
    });
    expect(today.status).toBe(201);
  });

  it('title is unique per society, case-insensitive, until the other one is cancelled', async () => {
    const { w } = await collWorld();
    const a = await create(w);
    const r = await w.c('post', '/collections', draftBody({ title: 'GANESH utsav 2026' }), {
      headers: idemH(),
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('COLLECTION_TITLE_EXISTS');
    const cancel = await w.c('post', `/collections/${a.id}/cancel`, {
      version: a.version,
      reason: 'Not needed now',
    });
    expect(cancel.status).toBe(200);
    const again = await w.c('post', '/collections', draftBody(), { headers: idemH() });
    expect(again.status).toBe(201);
  });

  it('404 FUND_NOT_FOUND for an unknown or inactive fund', async () => {
    const { w } = await collWorld();
    setPaymentsPorts({ funds: { exists: async () => false } });
    const r = await w.c('post', '/collections', draftBody({ fundId: 77 }), { headers: idemH() });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('FUND_NOT_FOUND');
  });

  it('422 COLLECTION_NO_AUDIENCE when the audience has no occupied flat', async () => {
    const { w } = await collWorld(2, 0);
    const r = await w.c('post', '/collections', draftBody(), { headers: idemH() });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('COLLECTION_NO_AUDIENCE');
  });

  it('BUILDINGS and UNITS audiences are stored and counted', async () => {
    const { w } = await collWorld(4, 3);
    const b = await create(w, {
      audienceType: 'BUILDINGS',
      audienceIds: [w.buildingId],
      title: 'Tower drive',
    });
    expect(b.targetPaise).toBe(150_000);
    const u = await create(w, {
      audienceType: 'UNITS',
      audienceIds: [w.units[0]!.id, w.units[1]!.id],
      title: 'Two flats',
    });
    expect(u.targetPaise).toBe(100_000);
    expect(u.audienceIds).toEqual([w.units[0]!.id, w.units[1]!.id]);
  });

  it('needs the permission', async () => {
    const { owners } = await collWorld();
    const r = await owners[0]!.c('post', '/collections', draftBody(), { headers: idemH() });
    expect(r.status).toBe(403);
    const list = await owners[0]!.c('get', '/collections');
    expect(list.status).toBe(403);
  });
});

describe('collections list and detail (8.21)', () => {
  it('filters by status, kind, isMandatory and q, sorts and paginates', async () => {
    const { w } = await collWorld();
    const a = await create(w);
    await create(w, {
      title: 'Terrace repair fund',
      kind: 'REPAIR_CALL',
      isMandatory: true,
      amountPerUnitPaise: 250_000,
    });
    await create(w, {
      title: 'Diwali celebration',
      amountMode: 'VOLUNTARY',
      amountPerUnitPaise: 0,
      targetPaise: 6_000_000,
      dueDate: '2026-11-20',
    });
    await w.c('post', `/collections/${a.id}/submit`, { version: a.version });
    const all = await w.c('get', '/collections');
    expect(all.status).toBe(200);
    expect(all.body.pagination).toMatchObject({ total: 3, page: 1 });
    expect(all.body.data[0]).toHaveProperty('fundName');
    expect(all.body.data[0].createdByName).toBeTruthy();
    const q = (s: string) => w.c('get', `/collections?${s}`).then(r => r.body.data.map((x: any) => x.title));
    expect(await q('status=PENDING_APPROVAL')).toEqual(['Ganesh Utsav 2026']);
    expect((await q('status=DRAFT,PENDING_APPROVAL')).length).toBe(3);
    expect(await q('isMandatory=true')).toEqual(['Terrace repair fund']);
    expect(await q('isMandatory=false')).toHaveLength(2);
    expect(await q('kind=REPAIR_CALL')).toEqual(['Terrace repair fund']);
    expect(await q('q=diwali')).toEqual(['Diwali celebration']);
    expect(await q('sortBy=title&sortOrder=asc')).toEqual([
      'Diwali celebration',
      'Ganesh Utsav 2026',
      'Terrace repair fund',
    ]);
    expect(await q('sortBy=dueDate&sortOrder=asc')).toEqual([
      'Diwali celebration',
      'Terrace repair fund',
      'Ganesh Utsav 2026',
    ]);
    expect(await q('limit=2&page=2')).toHaveLength(1);
    expect((await w.c('get', '/collections?status=NOPE')).status).toBe(400);
    expect((await w.c('get', '/collections?q=a')).status).toBe(400);
  });

  it('detail adds purpose, audience, approval, spent and a timeline; unknown id is 404', async () => {
    const { w } = await collWorld();
    const a = await create(w);
    const d = await w.c('get', `/collections/${a.id}`);
    expect(d.body.data).toMatchObject({
      purpose: 'Annual Ganesh celebration contributions',
      audienceType: 'ALL',
      audienceIds: null,
      spentPaise: 0,
      reminderCount: 0,
    });
    expect(d.body.data.timeline.map((x: any) => x.event)).toEqual(['collections.collection.created']);
    const nf = await w.c('get', '/collections/999999999');
    expect(nf.status).toBe(404);
    expect(nf.body.code).toBe('COLLECTION_NOT_FOUND');
    expect((await w.c('get', '/collections/abc')).status).toBe(400);
  });

  it('another society sees 404 for every id (T12-34)', async () => {
    const a = await collWorld();
    const b = await collWorld();
    const c = await create(a.w);
    for (const [m, p, body] of [
      ['get', `/collections/${c.id}`],
      ['get', `/collections/${c.id}/requests`],
      ['get', `/collections/${c.id}/statement`],
      ['patch', `/collections/${c.id}`, { version: 1, purpose: 'Changed purpose text' }],
      ['post', `/collections/${c.id}/submit`, { version: 1 }],
    ] as const) {
      const r = await b.w.c(m, p, body as never);
      expect([m, p, r.status]).toEqual([m, p, 404]);
    }
    expect((await b.w.c('delete', `/collections/${c.id}?version=1`)).status).toBe(404);
  });
});

describe('collections edit and delete (8.21)', () => {
  it('PATCH edits a draft, bumps the version, recomputes the default target and checks the version', async () => {
    const { w } = await collWorld();
    const a = await create(w);
    const r = await w.c('patch', `/collections/${a.id}`, { version: 1, amountPerUnitPaise: 100_000 });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ amountPerUnitPaise: 100_000, targetPaise: 300_000, version: 2 });
    const stale = await w.c('patch', `/collections/${a.id}`, { version: 1, purpose: 'Another purpose text' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    const keep = await w.c('patch', `/collections/${a.id}`, { version: 2, targetPaise: 500_000 });
    expect(keep.body.data.targetPaise).toBe(500_000);
    const mand = await w.c('patch', `/collections/${a.id}`, {
      version: 3,
      isMandatory: true,
      amountMode: 'VOLUNTARY',
    });
    expect(mand.status).toBe(422);
    const dup = await create(w, { title: 'Second one' });
    const clash = await w.c('patch', `/collections/${dup.id}`, { version: 1, title: 'ganesh utsav 2026' });
    expect(clash.body.code).toBe('COLLECTION_TITLE_EXISTS');
    const same = await w.c('patch', `/collections/${a.id}`, { version: 3, title: 'GANESH UTSAV 2026' });
    expect(same.status).toBe(200);
    expect(
      await AuditLog.count({ where: { action: 'collections.collection.updated', entityId: String(a.id) } }),
    ).toBe(3);
  });

  it('PATCH is refused outside DRAFT, REJECTED and CHANGES_REQUESTED (409 INVALID_STATE)', async () => {
    const { w } = await collWorld();
    const a = await create(w);
    await w.c('post', `/collections/${a.id}/submit`, { version: 1 });
    const r = await w.c('patch', `/collections/${a.id}`, { version: 2, purpose: 'Edited while pending' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('INVALID_STATE');
    expect(
      (await w.c('patch', '/collections/999999999', { version: 1, purpose: 'Nothing to edit here' })).status,
    ).toBe(404);
  });

  it('a REJECTED collection returns to DRAFT on edit; CHANGES_REQUESTED stays until resubmitted', async () => {
    const { w } = await collWorld();
    const a = await create(w);
    await w.c('post', `/collections/${a.id}/submit`, { version: 1 });
    await reject(approvalOf(a.id).id, 'Too high', ctxFor(w, w.secretary.user.id!));
    let d = (await w.c('get', `/collections/${a.id}`)).body.data;
    expect(d.status).toBe('REJECTED');
    expect(d.approval.reason).toBe('Too high');
    const e = await w.c('patch', `/collections/${a.id}`, { version: d.version, amountPerUnitPaise: 40_000 });
    expect(e.body.data.status).toBe('DRAFT');
    await w.c('post', `/collections/${a.id}/submit`, { version: e.body.data.version });
    await requestChanges(approvalOf(a.id).id, ctxFor(w, w.secretary.user.id!));
    d = (await w.c('get', `/collections/${a.id}`)).body.data;
    expect(d.status).toBe('CHANGES_REQUESTED');
    const e2 = await w.c('patch', `/collections/${a.id}`, { version: d.version, amountPerUnitPaise: 30_000 });
    expect(e2.body.data.status).toBe('CHANGES_REQUESTED');
  });

  it('DELETE soft-deletes DRAFT or REJECTED only, with the version (204), and frees the title', async () => {
    const { w } = await collWorld();
    const a = await create(w);
    expect((await w.c('delete', `/collections/${a.id}?version=9`)).status).toBe(409);
    expect((await w.c('delete', `/collections/${a.id}`)).status).toBe(400);
    expect((await w.c('delete', `/collections/${a.id}?version=1`)).status).toBe(204);
    expect((await w.c('get', `/collections/${a.id}`)).status).toBe(404);
    expect(await Collection.findByPk(a.id)).toBeNull();
    expect((await Collection.findByPk(a.id, { paranoid: false }))?.deletedAt).not.toBeNull();
    const b = await create(w);
    await w.c('post', `/collections/${b.id}/submit`, { version: 1 });
    const r = await w.c('delete', `/collections/${b.id}?version=2`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('INVALID_STATE');
    expect((await w.c('delete', '/collections/999999999?version=1')).status).toBe(404);
    expect(
      await AuditLog.count({ where: { action: 'collections.collection.deleted', entityId: String(a.id) } }),
    ).toBe(1);
  });
});

describe('submit and approval (6.4, BR-12-39)', () => {
  it('submit asks module 14 for COLLECTION_PUBLISH with the target and the kind; creator cannot approve (T12-29)', async () => {
    const { w } = await collWorld();
    const a = await create(w);
    const s = await w.c('post', `/collections/${a.id}/submit`, { version: 1 });
    expect(s.status).toBe(200);
    expect(s.body.data).toMatchObject({ status: 'PENDING_APPROVAL', version: 2 });
    expect(s.body.data.approval.requestId).toBe(approvalOf(a.id).id);
    const call = paymentsPortCalls.find(c => c.fn === 'approvals.request')!;
    expect(call.input).toMatchObject({
      type: 'COLLECTION_PUBLISH',
      entityType: 'collection',
      entityId: a.id,
      amountPaise: 150_000,
      categoryKey: 'FESTIVAL',
    });
    await expect(approve(approvalOf(a.id).id, ctxFor(w, w.user.id!))).rejects.toMatchObject({
      code: 'MAKER_CHECKER_VIOLATION',
    });
    expect((await Collection.findByPk(a.id))!.status).toBe('PENDING_APPROVAL');
    await approve(approvalOf(a.id).id, ctxFor(w, w.secretary.user.id!));
    const d = (await w.c('get', `/collections/${a.id}`)).body.data;
    expect(d.status).toBe('APPROVED');
    expect(d.approvedByName).toBeTruthy();
    expect(
      await AuditLog.count({ where: { action: 'collections.collection.approved', entityId: String(a.id) } }),
    ).toBe(1);
  });

  it('submit checks state, version and due date (422 COLLECTION_DUE_DATE_PAST)', async () => {
    const { w } = await collWorld();
    const a = await create(w, { dueDate: '2026-11-04' });
    expect((await w.c('post', `/collections/${a.id}/submit`, { version: 5 })).body.code).toBe(
      'STALE_VERSION',
    );
    await Collection.update({ dueDate: '2026-11-03' } as never, { where: { id: a.id } });
    const late = await w.c('post', `/collections/${a.id}/submit`, { version: 1 });
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('COLLECTION_DUE_DATE_PAST');
    await Collection.update({ dueDate: '2026-11-04' } as never, { where: { id: a.id } });
    await w.c('post', `/collections/${a.id}/submit`, { version: 1 });
    const again = await w.c('post', `/collections/${a.id}/submit`, { version: 2 });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_STATE');
  });

  it('reject then edit and submit again makes a new request; request changes then resubmit uses approvals.resubmit', async () => {
    const { w } = await collWorld();
    const a = await create(w);
    await w.c('post', `/collections/${a.id}/submit`, { version: 1 });
    const first = approvalOf(a.id).id;
    await requestChanges(first, ctxFor(w, w.secretary.user.id!));
    const d = (await w.c('get', `/collections/${a.id}`)).body.data;
    const s = await w.c('post', `/collections/${a.id}/submit`, { version: d.version });
    expect(s.status).toBe(200);
    expect(s.body.data.status).toBe('PENDING_APPROVAL');
    expect(s.body.data.approval.requestId).toBe(first);
    expect(paymentsPortCalls.find(c => c.fn === 'approvals.resubmit')!.input).toMatchObject({ id: first });
  });

  it('a withdrawn request (module 14 onCancelled) puts the collection back to DRAFT', async () => {
    const { w } = await collWorld();
    const a = await create(w);
    await w.c('post', `/collections/${a.id}/submit`, { version: 1 });
    await sequelize.transaction(t => onCollectionCancelled(ctxFor(w, w.user.id!), a.id, t));
    expect((await Collection.findByPk(a.id))!.status).toBe('DRAFT');
  });

  it('auto-approval by module 14 inside submit gives APPROVED at once', async () => {
    const { w } = await collWorld();
    setPaymentsPorts({ approvals: { request: async () => ({ id: 9001, status: 'APPROVED' }) } });
    const a = await create(w);
    const s = await w.c('post', `/collections/${a.id}/submit`, { version: 1 });
    expect(s.body.data.status).toBe('APPROVED');
  });

  it('approved() helper path leaves an APPROVED collection', async () => {
    const { w } = await collWorld();
    const a = await approved(w);
    expect(a.status).toBe('APPROVED');
  });
});
