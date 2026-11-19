import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, ApprovalRequest, Notice, NoticeReceipt, Society, closeDb } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { sequelize } from '../../../src/models';
import { systemCtx } from '../../../src/types/context';
import { settings } from '../../../src/modules/society-setup/society-setup.public';
import { invalidateSociety } from '../../../src/modules/access-control/access-control.public';
import { setCommunicationPorts } from '../../../src/modules/communication/communication.ports';
import { placeholderFiles, nextPlaceholderFileId } from '../../../src/modules/societies/societies.ports';
import { onPublishApproved } from '../../../src/modules/communication/communication.notices.publish';
import {
  runNoticeExpiry,
  runNoticeFanout,
  runNoticeScheduler,
} from '../../../src/modules/communication/communication.notices.fanout';
import { resetAll } from '../../helpers/auth';
import { idem, lifecycleColumns } from '../../helpers/access';
import {
  approvalMode,
  autoApproveNotices,
  inboxItems,
  mkNotice,
  noticeWorld,
  publishNow,
  resetNotices,
  type NoticeWorld,
} from '../../helpers/communication';

afterAll(closeDb);
let w: NoticeWorld;
let sec: Awaited<ReturnType<NoticeWorld['member']>>;
let acc: Awaited<ReturnType<NoticeWorld['member']>>;
beforeAll(async () => {
  await resetAll();
  await resetNotices();
  w = await noticeWorld('PREMIUM');
  await autoApproveNotices(w.sid);
  sec = await w.member('secretary');
  acc = await w.member('accountant');
}, 240_000);
beforeEach(async () => {
  setNow('2026-11-01T04:30:00Z');
  setCommunicationPorts();
  await approvalMode(w.sid, 'AUTO');
  await setStatus('ACTIVE');
});

const setStatus = async (status: 'ACTIVE' | 'SUSPENDED') => {
  await Society.update(lifecycleColumns(status) as never, { where: { id: w.sid } });
  await invalidateSociety(w.sid);
};
const audits = (action: string, id: number) => AuditLog.findAll({ where: { action, entityId: String(id) } });
const act = (who: typeof w.c, id: number, path: string, body: Record<string, unknown> = {}, headers = {}) =>
  who('post', `/notices/${id}/${path}`, body, { headers });
const get = async (id: number) => (await w.c('get', `/notices/${id}`)).body.data;

describe('publish with no matching rule (T16-20, BR-16-6)', () => {
  it('publishes at once, fans out receipts and notifies', async () => {
    const n = await mkNotice(w.c, { title: 'Publish me now please' });
    const r = await act(w.c, n.id, 'publish', { version: n.version }, idem());
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('Published to 3 people');
    expect(r.body.data).toMatchObject({
      status: 'PUBLISHED',
      version: 3,
      approval: { requestId: expect.any(Number) },
    });
    expect(r.body.data.publishedAt).toBe('2026-11-01T04:30:00.000Z');
    await drainQueues();
    const after = await get(n.id);
    expect(after).toMatchObject({ recipientCount: 3, unitCount: 3, reachedCount: 3, readCount: 0 });
    const receipts = await NoticeReceipt.findAll({ where: { noticeId: n.id } });
    expect(receipts.map(x => x.recipientKey).sort()).toEqual(
      [w.r1.user.id, w.r2.user.id, w.r3.user.id]
        .map((u, i) => `u:${u}:${[w.units[0]!.id, w.units[1]!.id, w.buildingB.unitId][i]}`)
        .sort(),
    );
    expect(receipts.every(x => x.reachedVia === 'IN_APP' && x.reachedAt)).toBe(true);
    for (const u of [w.r1, w.r2, w.r3]) {
      const items = await inboxItems(u.user.id);
      expect(items.some(i => /Publish me now please/.test(i.title ?? ''))).toBe(true);
    }
    expect((await audits('communication.notice.submitted', n.id)).length).toBe(1);
    expect((await audits('communication.notice.published', n.id)).length).toBe(1);
    expect((await Notice.findByPk(n.id))!.fanoutCompletedAt).not.toBeNull();
  });
  it('is idempotent on the key, and a second publish is INVALID_STATE', async () => {
    const n = await mkNotice(w.c);
    const h = idem();
    const a = await act(w.c, n.id, 'publish', { version: 1 }, h);
    const b = await act(w.c, n.id, 'publish', { version: 1 }, h);
    expect(b.status).toBe(200);
    expect(b.body.data.version).toBe(a.body.data.version);
    const c = await act(w.c, n.id, 'publish', { version: a.body.data.version }, idem());
    expect([c.status, c.body.code]).toEqual([409, 'INVALID_STATE']);
    await drainQueues();
    expect(await NoticeReceipt.count({ where: { noticeId: n.id } })).toBe(3);
  });
  it('fans out only to the chosen buildings and owners; rerunning the job writes nothing new', async () => {
    const n = await publishNow(w.c, {
      title: 'Tower B only notice',
      audience: { type: 'BUILDINGS', ids: [w.buildingB.id] },
    });
    expect(n.recipientCount).toBe(1);
    const rows = await NoticeReceipt.findAll({ where: { noticeId: n.id } });
    expect(rows.map(r => r.userId)).toEqual([w.r3.user.id]);
    expect(await runNoticeFanout({ noticeId: n.id, societyId: w.sid })).toBeNull();
    expect(await NoticeReceipt.count({ where: { noticeId: n.id } })).toBe(1);
    expect((await inboxItems(w.r1.user.id)).some(i => /Tower B only/.test(i.title ?? ''))).toBe(false);
  });
  it('sends to a role audience (staff, no flat)', async () => {
    const n = await publishNow(w.c, {
      title: 'Committee only notice',
      audience: { type: 'ROLES', roleKeys: ['secretary'] },
    });
    expect(n.recipientCount).toBe(1);
    const [r] = await NoticeReceipt.findAll({ where: { noticeId: n.id } });
    expect(r).toMatchObject({ userId: sec.user.id, unitId: null, relation: 'MEMBER' });
    expect(r!.recipientKey).toBe(`u:${sec.user.id}:0`);
  });
});

describe('validation at publish (8.8)', () => {
  const publish = (id: number, body: Record<string, unknown> = {}) =>
    act(w.c, id, 'publish', { version: 1, ...body }, idem());
  it('NOTICE_INCOMPLETE for a short body or title', async () => {
    const n = await mkNotice(w.c, { body: '<p>short</p>' });
    const r = await publish(n.id);
    expect([r.status, r.body.code]).toEqual([422, 'NOTICE_INCOMPLETE']);
    expect((await get(n.id)).status).toBe('DRAFT');
  });
  it('NOTICE_AUDIENCE_EMPTY when nobody matches', async () => {
    const n = await mkNotice(w.c, { audience: { type: 'UNITS', ids: [w.units[2]!.id] } });
    const r = await publish(n.id);
    expect([r.status, r.body.code]).toEqual([422, 'NOTICE_AUDIENCE_EMPTY']);
  });
  it('NOTICE_SCHEDULE_INVALID outside 5 minutes to 90 days', async () => {
    const n = await mkNotice(w.c);
    for (const at of ['2026-11-01T04:32:00.000Z', '2027-03-01T04:30:00.000Z', '2026-10-31T04:30:00.000Z']) {
      const r = await publish(n.id, { scheduledAt: at });
      expect([r.status, r.body.code], at).toEqual([422, 'NOTICE_SCHEDULE_INVALID']);
    }
  });
  it('NOTICE_EXPIRY_INVALID for an expiry under an hour or an ack date in the past', async () => {
    const n = await mkNotice(w.c, { expiresAt: '2026-11-01T05:00:00.000Z' });
    const r = await publish(n.id);
    expect([r.status, r.body.code]).toEqual([422, 'NOTICE_EXPIRY_INVALID']);
    const m = await mkNotice(w.c, { requiresAck: true, ackDueAt: '2026-10-30T00:00:00.000Z' });
    const r2 = await publish(m.id);
    expect([r2.status, r2.body.code]).toEqual([422, 'NOTICE_EXPIRY_INVALID']);
  });
  it('NOTICE_UTILITY_INVALID for an outage in the past or longer than 7 days', async () => {
    const mk = (s: string, e: string) =>
      mkNotice(w.c, { kind: 'UTILITY_SHUTDOWN', utilityType: 'POWER', outageStartsAt: s, outageEndsAt: e });
    const past = await mk('2026-10-31T04:30:00.000Z', '2026-10-31T08:30:00.000Z');
    expect((await publish(past.id)).body.code).toBe('NOTICE_UTILITY_INVALID');
    const long = await mk('2026-11-05T04:30:00.000Z', '2026-11-20T08:30:00.000Z');
    expect((await publish(long.id)).body.code).toBe('NOTICE_UTILITY_INVALID');
  });
  it('NOTICE_ACTION_INVALID while the target is not open; an open collection passes', async () => {
    const n = await mkNotice(w.c, { actions: [{ type: 'PAY_COLLECTION', refId: 7 }] });
    const r = await publish(n.id);
    expect([r.status, r.body.code]).toEqual([422, 'NOTICE_ACTION_INVALID']);
    const v = await mkNotice(w.c, { actions: [{ type: 'VOTE', refId: 1 }] });
    expect((await publish(v.id)).body.code).toBe('NOTICE_ACTION_INVALID');
    setCommunicationPorts({
      collections: { get: async (_s, id) => ({ id, status: 'PUBLISHED', title: 'Terrace fund' }) },
    });
    const ok = await publish(n.id);
    expect(ok.status).toBe(200);
    expect(ok.body.data.actions[0]).toMatchObject({
      type: 'PAY_COLLECTION',
      label: 'Pay',
      target: { title: 'Terrace fund', status: 'PUBLISHED' },
    });
  });
  it('NOTICE_ATTACHMENTS_PENDING while a file is not CLEAN, FILE_INFECTED for a bad one', async () => {
    const id = nextPlaceholderFileId();
    placeholderFiles.set(id, {
      fileId: id,
      societyId: w.sid,
      purpose: 'NOTICE_ATTACHMENT',
      name: 'a.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('x'),
      ownerUserId: null,
      status: 'CLEAN',
    });
    const n = await mkNotice(w.c, { fileIds: [id] });
    placeholderFiles.get(id)!.status = 'PENDING' as never;
    const r = await publish(n.id);
    expect([r.status, r.body.code]).toEqual([409, 'NOTICE_ATTACHMENTS_PENDING']);
    placeholderFiles.get(id)!.status = 'INFECTED' as never;
    expect((await publish(n.id)).body.code).toBe('FILE_INFECTED');
    placeholderFiles.get(id)!.status = 'CLEAN';
    expect((await publish(n.id)).status).toBe(200);
  });
  it('STALE_VERSION and a bad body', async () => {
    const n = await mkNotice(w.c);
    expect((await publish(n.id, { version: 5 })).body.code).toBe('STALE_VERSION');
    expect((await act(w.c, n.id, 'publish', { version: 1, scheduledAt: 'tomorrow' }, idem())).status).toBe(
      400,
    );
    expect((await act(w.c, n.id, 'publish', {}, idem())).status).toBe(400);
  });
  it('423 on a suspended society', async () => {
    const n = await mkNotice(w.c);
    await setStatus('SUSPENDED');
    const r = await publish(n.id);
    expect([r.status, r.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
  });
});

describe('approval flow (BR-16-6, BR-16-7, 8.39)', () => {
  const submit = async (who = sec.c, over: Record<string, unknown> = {}) => {
    await approvalMode(w.sid, 'MANUAL');
    const n = await mkNotice(who, over);
    const r = await act(who, n.id, 'publish', { version: n.version }, idem());
    expect(r.status).toBe(200);
    return { n, r };
  };
  it('waits for the approver: locked for edits, then the chairman approves and it publishes', async () => {
    const { n, r } = await submit();
    expect(r.body.message).toBe('Sent for approval');
    expect(r.body.data).toMatchObject({
      status: 'PENDING_APPROVAL',
      approval: { status: 'PENDING', requestId: expect.any(Number) },
    });
    const edit = await sec.c('patch', `/notices/${n.id}`, {
      version: r.body.data.version,
      title: 'Edit while pending',
    });
    expect([edit.status, edit.body.code]).toEqual([409, 'INVALID_STATE']);
    const req = await ApprovalRequest.findByPk(r.body.data.approval.requestId);
    expect(req).toMatchObject({ type: 'NOTICE_PUBLISH', entityType: 'notice', entityId: n.id });
    expect((req!.payload as any).recipientEstimate).toBe(3);
    const ap = await w.c(
      'post',
      `/approvals/${req!.id}/approve`,
      { version: req!.version },
      { headers: idem() },
    );
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    const pub = await get(n.id);
    expect(pub).toMatchObject({ status: 'PUBLISHED', approvedBy: { id: w.chairman.id } });
    expect(pub.approvedAt).not.toBeNull();
    await drainQueues();
    expect((await get(n.id)).recipientCount).toBe(3);
  });
  it('a rejection returns it to DRAFT with the reason, and publishing again resubmits', async () => {
    const { n, r } = await submit();
    const req = await ApprovalRequest.findByPk(r.body.data.approval.requestId);
    const rej = await w.c(
      'post',
      `/approvals/${req!.id}/reject`,
      { version: req!.version, reason: 'Wrong audience selected' },
      { headers: idem() },
    );
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    const d = await get(n.id);
    expect(d).toMatchObject({
      status: 'DRAFT',
      lastDecisionReason: 'Wrong audience selected',
      scheduledAt: null,
    });
    expect((await audits('communication.notice.returned_to_draft', n.id)).length).toBe(1);
    const again = await act(sec.c, n.id, 'publish', { version: d.version }, idem());
    expect(again.body.data.status).toBe('PENDING_APPROVAL');
    expect(again.body.data.approval.requestId).not.toBe(req!.id);
  });
  it('changes requested returns to DRAFT and the next publish resubmits the same request', async () => {
    const { n, r } = await submit();
    const req = await ApprovalRequest.findByPk(r.body.data.approval.requestId);
    const cr = await w.c(
      'post',
      `/approvals/${req!.id}/request-changes`,
      { version: req!.version, reason: 'Please add the date' },
      { headers: idem() },
    );
    expect(cr.status, JSON.stringify(cr.body)).toBe(200);
    const d = await get(n.id);
    expect(d.status).toBe('DRAFT');
    expect(d.lastDecisionReason).toBe('Please add the date');
    const again = await act(sec.c, n.id, 'publish', { version: d.version }, idem());
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data).toMatchObject({ status: 'PENDING_APPROVAL', approval: { requestId: req!.id } });
  });
  it('the author withdraws (approval cancelled, back to DRAFT); a stranger cannot', async () => {
    const { n } = await submit(sec.c);
    const d0 = await get(n.id);
    expect((await act(acc.c, n.id, 'withdraw', { version: d0.version })).status).toBe(403);
    const r = await act(sec.c, n.id, 'withdraw', { version: d0.version, reason: 'Needs another look' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'DRAFT', lastDecisionReason: 'Needs another look' });
    const req = await ApprovalRequest.findByPk(d0.approval.requestId);
    expect(req!.status).toBe('CANCELLED');
    expect((await audits('communication.notice.withdrawn', n.id)).length).toBe(1);
    expect((await audits('communication.notice.returned_to_draft', n.id)).length).toBe(0);
    const twice = await act(sec.c, n.id, 'withdraw', { version: r.body.data.version });
    expect([twice.status, twice.body.code]).toEqual([409, 'INVALID_STATE']);
  });
  it('a handler call for a notice that is not pending does nothing (idempotent)', async () => {
    const n = await publishNow(w.c);
    await sequelize.transaction(t =>
      onPublishApproved(
        {
          ...systemCtx('x'),
          approval: {
            requestId: 1,
            decision: 'APPROVED',
            actorUserId: 1,
            onBehalfOfUserId: null,
            reason: null,
          },
        } as never,
        { societyId: w.sid, entityId: n.id, id: 1 } as never,
        t,
      ),
    );
    expect((await Notice.findByPk(n.id))!.version).toBe(n.version);
  });
});

describe('scheduling (BR-16-5, 6.1)', () => {
  it('SCHEDULED, cancel back to DRAFT, schedule again and the scheduler publishes it', async () => {
    const n = await mkNotice(w.c, { title: 'Scheduled for later' });
    const at = '2026-11-01T06:30:00.000Z';
    const r = await act(w.c, n.id, 'publish', { version: 1, scheduledAt: at }, idem());
    expect(r.body.message).toBe('Scheduled');
    expect(r.body.data).toMatchObject({ status: 'SCHEDULED', scheduledAt: at });
    expect(
      (await w.c('patch', `/notices/${n.id}`, { version: r.body.data.version, title: 'Edit scheduled one' }))
        .body.code,
    ).toBe('INVALID_STATE');
    const c = await act(w.c, n.id, 'cancel-schedule', { version: r.body.data.version });
    expect(c.body.data).toMatchObject({ status: 'DRAFT', scheduledAt: null });
    expect((await audits('communication.notice.schedule_cancelled', n.id)).length).toBe(1);
    const again = await act(w.c, n.id, 'publish', { version: c.body.data.version, scheduledAt: at }, idem());
    expect(again.body.data.status).toBe('SCHEDULED');
    expect(await runNoticeScheduler()).toBe(0);
    await Notice.update({ scheduledAt: new Date('2026-11-01T06:30:00.000Z') }, { where: { id: n.id } });
    setNow('2026-11-01T06:31:00Z');
    await setStatus('SUSPENDED');
    expect(await runNoticeScheduler()).toBe(0);
    expect((await Notice.findByPk(n.id))!.status).toBe('SCHEDULED');
    await setStatus('ACTIVE');
    expect(await runNoticeScheduler()).toBe(1);
    await drainQueues();
    setNow('2026-11-01T04:30:00Z');
    const d = await get(n.id);
    expect(d.status).toBe('PUBLISHED');
    expect(d.publishedAt).toBe('2026-11-01T06:31:00.000Z');
    expect(d.recipientCount).toBe(3);
    expect(await runNoticeScheduler()).toBe(0);
  });
  it('cancel-schedule on a published notice is INVALID_STATE', async () => {
    const n = await publishNow(w.c);
    const r = await act(w.c, n.id, 'cancel-schedule', { version: n.version });
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
  });
});

describe('pin, recall, archive, expiry, edits after publish', () => {
  it('pins up to the limit; the next pin is 409 with the pinned ids; parallel pins let one through', async () => {
    await sequelize.transaction(t =>
      settings.set(systemCtx('t'), w.sid, 'communication.maxPinnedNotices', 2, t),
    );
    await Notice.update({ isPinned: false }, { where: { societyId: w.sid } });
    const a = await publishNow(w.c, { title: 'Pinned notice one' });
    const b = await publishNow(w.c, { title: 'Pinned notice two' });
    const c = await publishNow(w.c, { title: 'Pinned notice three' });
    const d = await publishNow(w.c, { title: 'Pinned notice four' });
    expect((await act(w.c, a.id, 'pin', { version: a.version })).body.data.isPinned).toBe(true);
    const pb = await act(w.c, b.id, 'pin', { version: b.version });
    expect(pb.status).toBe(200);
    const over = await act(w.c, c.id, 'pin', { version: c.version });
    expect([over.status, over.body.code]).toEqual([409, 'NOTICE_PIN_LIMIT_REACHED']);
    expect(over.body.errors.map((e: any) => e.message).sort()).toEqual([String(a.id), String(b.id)].sort());
    // unpin one, then two parallel pins: exactly one wins
    const ua = await act(w.c, a.id, 'unpin', { version: (await get(a.id)).version });
    expect(ua.body.data.isPinned).toBe(false);
    const [x, y] = await Promise.all([
      act(w.c, c.id, 'pin', { version: c.version }),
      act(w.c, d.id, 'pin', { version: d.version }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const un = await act(w.c, a.id, 'pin', { version: (await get(a.id)).version }); // a is unpinned, limit full again
    expect(un.status).toBe(409);
    await sequelize.transaction(t =>
      settings.set(systemCtx('t'), w.sid, 'communication.maxPinnedNotices', 5, t),
    );
    await Notice.update({ isPinned: false }, { where: { societyId: w.sid } });
  });
  it('recalls with a reason, unpins, notifies receipt holders and audits', async () => {
    const n = await publishNow(w.c, { title: 'Recall this notice' });
    await act(w.c, n.id, 'pin', { version: n.version });
    const v = (await get(n.id)).version;
    expect((await act(w.c, n.id, 'recall', { version: v, reason: 'short' })).status).toBe(400);
    expect((await act(acc.c, n.id, 'recall', { version: v, reason: 'Posted by mistake here' })).status).toBe(
      403,
    );
    const r = await act(w.c, n.id, 'recall', { version: v, reason: 'Posted by mistake here' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      status: 'RECALLED',
      isPinned: false,
      recalledReason: 'Posted by mistake here',
    });
    const items = await inboxItems(w.r1.user.id);
    expect(items.some(i => /withdrawn: Recall this notice/i.test(i.title ?? ''))).toBe(true);
    expect((await audits('communication.notice.recalled', n.id)).length).toBe(1);
    expect(
      (await act(w.c, n.id, 'recall', { version: r.body.data.version, reason: 'Again and again' })).body.code,
    ).toBe('INVALID_STATE');
    expect((await act(w.c, n.id, 'pin', { version: r.body.data.version })).body.code).toBe('INVALID_STATE');
  });
  it('recall with notifyRecall=false sends nothing', async () => {
    const n = await publishNow(w.c, { title: 'Quiet recall of notice' });
    const before = (await inboxItems(w.r2.user.id)).length;
    const r = await act(w.c, n.id, 'recall', {
      version: n.version,
      reason: 'Posted by mistake here',
      notifyRecall: false,
    });
    expect(r.status).toBe(200);
    expect((await inboxItems(w.r2.user.id)).length).toBe(before);
  });
  it('archives published, expired and recalled notices; a draft cannot be archived', async () => {
    const n = await publishNow(w.c);
    const a = await act(w.c, n.id, 'archive', { version: n.version });
    expect(a.body.data).toMatchObject({ status: 'ARCHIVED' });
    expect((await act(w.c, n.id, 'archive', { version: a.body.data.version })).body.code).toBe(
      'INVALID_STATE',
    );
    const d = await mkNotice(w.c);
    expect((await act(w.c, d.id, 'archive', { version: 1 })).body.code).toBe('INVALID_STATE');
    expect((await audits('communication.notice.archived', n.id)).length).toBe(1);
  });
  it('the expiry job expires published notices and unpins them', async () => {
    const n = await publishNow(w.c, { title: 'Expires in a day', expiresAt: '2026-11-02T10:00:00.000Z' });
    await act(w.c, n.id, 'pin', { version: n.version });
    expect(await runNoticeExpiry()).toBe(0);
    setNow('2026-11-03T04:30:00Z');
    expect(await runNoticeExpiry()).toBeGreaterThanOrEqual(1);
    expect(await Notice.findByPk(n.id)).toMatchObject({ status: 'EXPIRED', isPinned: false });
    expect(await runNoticeExpiry()).toBe(0);
    expect((await audits('communication.notice.expired', n.id)).length).toBe(1);
    setNow('2026-11-01T04:30:00Z');
    const arch = await act(w.c, n.id, 'archive', { version: (await get(n.id)).version });
    expect(arch.status).toBe(200);
  });
  it('after publish only title, body, expiry and files change, with an edit note (T16-25)', async () => {
    const n = await publishNow(w.c, { title: 'Typo in this titel' });
    const aud = await w.c('patch', `/notices/${n.id}`, {
      version: n.version,
      editNote: 'fix',
      audience: { type: 'ALL' },
    });
    expect([aud.status, aud.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const noNote = await w.c('patch', `/notices/${n.id}`, {
      version: n.version,
      title: 'Typo in this title',
    });
    expect(noNote.status).toBe(400);
    const r = await w.c('patch', `/notices/${n.id}`, {
      version: n.version,
      title: 'Typo in this title',
      editNote: 'Fixed a typo',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      title: 'Typo in this title',
      revisionNo: 2,
      lastEditNote: 'Fixed a typo',
      status: 'PUBLISHED',
      version: n.version + 1,
    });
    const exp = await w.c('patch', `/notices/${n.id}`, {
      version: r.body.data.version,
      expiresAt: '2026-11-01T05:00:00.000Z',
      editNote: 'Too soon',
    });
    expect([exp.status, exp.body.code]).toEqual([422, 'NOTICE_EXPIRY_INVALID']);
    const ok = await w.c('patch', `/notices/${n.id}`, {
      version: r.body.data.version,
      expiresAt: '2026-12-01T05:00:00.000Z',
      editNote: 'Set expiry',
    });
    expect(ok.body.data.expiresAt).toBe('2026-12-01T05:00:00.000Z');
    const sendsNothing = (await inboxItems(w.r1.user.id)).filter(i =>
      /Typo in this/.test(i.title ?? ''),
    ).length;
    expect(sendsNothing).toBe(1); // only the publish message
    expect(
      (
        await acc.c('patch', `/notices/${n.id}`, {
          version: ok.body.data.version,
          title: 'Someone else edit',
          editNote: 'nope nope',
        })
      ).status,
    ).toBe(403);
  });
});

describe('remind (8.13, BR-16-12) and utility restored (8.14, BR-16-16)', () => {
  it('reminds unacknowledged receipts once per 6 hours up to the maximum', async () => {
    const n = await publishNow(w.c, {
      title: 'Please acknowledge this',
      requiresAck: true,
      ackDueAt: '2026-11-20T00:00:00.000Z',
    });
    const plain = await publishNow(w.c, { title: 'No ack needed here' });
    expect((await act(w.c, plain.id, 'remind', { version: plain.version })).body.code).toBe('INVALID_STATE');
    const r = await act(w.c, n.id, 'remind', { version: n.version });
    expect([r.status, r.body.data]).toEqual([200, { queuedFor: 3 }]);
    await drainQueues();
    expect(
      (await inboxItems(w.r1.user.id)).filter(i => /Reminder: acknowledge/.test(i.title ?? '')).length,
    ).toBe(1);
    const rec = await NoticeReceipt.findOne({ where: { noticeId: n.id, userId: w.r1.user.id } });
    expect(rec!.remindersSent).toBe(1);
    const soon = await act(w.c, n.id, 'remind', { version: (await get(n.id)).version });
    expect([soon.status, soon.body.code]).toEqual([422, 'NOTICE_REMIND_TOO_SOON']);
    const back = () =>
      Notice.update(
        {
          lastRemindedAt:
            new Date('2026-11-01T04:30:00Z').getTime() - 7 * 3_600_000 > 0
              ? new Date(Date.parse('2026-11-01T04:30:00Z') - 7 * 3_600_000)
              : null,
        },
        { where: { id: n.id } },
      );
    await back();
    expect((await act(w.c, n.id, 'remind', { version: (await get(n.id)).version })).status).toBe(200);
    await back();
    expect((await act(w.c, n.id, 'remind', { version: (await get(n.id)).version })).status).toBe(200);
    await back();
    const limit = await act(w.c, n.id, 'remind', { version: (await get(n.id)).version });
    expect([limit.status, limit.body.code]).toEqual([422, 'NOTICE_REMIND_LIMIT']);
    expect((await audits('communication.notice.reminded', n.id)).length).toBe(3);
  });
  it('marks a utility notice restored once and notifies the receipts', async () => {
    const n = await publishNow(w.c, {
      title: 'Water cut tomorrow morning',
      kind: 'UTILITY_SHUTDOWN',
      utilityType: 'WATER',
      outageStartsAt: '2026-11-02T04:30:00.000Z',
      outageEndsAt: '2026-11-02T08:30:00.000Z',
    });
    const std = await publishNow(w.c, { title: 'Ordinary standard notice' });
    expect((await act(w.c, std.id, 'restored', { version: std.version })).body.code).toBe('INVALID_STATE');
    const r = await act(w.c, n.id, 'restored', { version: n.version, message: 'Supply is back' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.utility.restoredAt).toBe('2026-11-01T04:30:00.000Z');
    expect((await inboxItems(w.r1.user.id)).some(i => /WATER restored|restored/i.test(i.title ?? ''))).toBe(
      true,
    );
    const twice = await act(w.c, n.id, 'restored', { version: r.body.data.version });
    expect([twice.status, twice.body.code]).toEqual([409, 'INVALID_STATE']);
    expect((await audits('communication.notice.restored', n.id)).length).toBe(1);
  });
});

describe('acknowledge as a role recipient (8.18)', () => {
  it('acknowledges once, keeps the first time, and refuses others', async () => {
    const n = await publishNow(w.c, {
      title: 'Committee must acknowledge',
      requiresAck: true,
      audience: { type: 'ROLES', roleKeys: ['secretary'] },
    });
    expect((await act(acc.c, n.id, 'acknowledge')).status).toBe(404); // not in the audience
    const a = await act(sec.c, n.id, 'acknowledge');
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.data).toEqual({
      noticeId: n.id,
      acknowledgedAt: '2026-11-01T04:30:00.000Z',
      revisionNo: 1,
    });
    const b = await act(sec.c, n.id, 'acknowledge');
    expect(b.body.data.acknowledgedAt).toBe('2026-11-01T04:30:00.000Z');
    expect((await get(n.id)).ackCount).toBe(1);
    expect((await audits('communication.notice.acknowledged', n.id)).length).toBe(1);
    const no = await publishNow(w.c, {
      title: 'No ack on this notice',
      audience: { type: 'ROLES', roleKeys: ['secretary'] },
    });
    const r = await act(sec.c, no.id, 'acknowledge');
    expect([r.status, r.body.code]).toEqual([422, 'NOTICE_ACK_NOT_REQUIRED']);
    await act(w.c, n.id, 'recall', { version: (await get(n.id)).version, reason: 'Posted by mistake here' });
    const rec = await act(sec.c, n.id, 'acknowledge');
    expect([rec.status, rec.body.code]).toEqual([409, 'INVALID_STATE']);
    const rec2 = await publishNow(w.c, {
      title: 'Recalled before ack',
      requiresAck: true,
      audience: { type: 'ROLES', roleKeys: ['secretary'] },
    });
    await act(w.c, rec2.id, 'recall', { version: rec2.version, reason: 'Posted by mistake here' });
    expect((await act(sec.c, rec2.id, 'acknowledge')).body.code).toBe('INVALID_STATE');
  });
});
