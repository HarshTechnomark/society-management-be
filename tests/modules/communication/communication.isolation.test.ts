import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboxItem, closeDb } from '../../../src/models';
import { as, login, memberUser } from '../../helpers/access';
import { commWorld, idem, makeNotice, type CommWorld } from '../../helpers/communication';
import { residentUser } from '../../helpers/residents';
import { makeBuilding, makeUnit, setupSociety } from '../../helpers/society-setup';

/**
 * Tenant isolation of the module 16 id routes (T16-31): every survey, emergency and resident notice route answers 404 with the
 * entity code for an id of another society, for the chairman, a resident and a guard of that other society.
 * Listed in the route coverage of tests/modules/access-control/tenant-isolation.test.ts.
 */
afterAll(async () => {
  await closeDb();
});

let w: CommWorld;
let other: { sid: number; c: any; res: any; guard: any };
beforeAll(async () => {
  w = await commWorld('PREMIUM');
  const o = await setupSociety({ plan: 'PREMIUM', name: 'Other' });
  const b = await makeBuilding(o.c, { code: 'Z' });
  const u = await makeUnit(o.c, b.id, '101', 1);
  const res = await residentUser(o.society, u.id, { name: 'Zara Owner' });
  const g = await memberUser(o.society, 'guard', { name: 'Zed Guard' });
  other = {
    sid: o.society.id!,
    c: o.c,
    res: res.c,
    guard: as(await login(g, { app: 'GATE', societyId: o.society.id! }), 'GATE'),
  };
}, 300_000);

const expect404 = (r: { status: number; body: any }, code: string, label: string) =>
  expect([label, r.status, r.body.code]).toEqual([label, 404, code]);

describe('module 16 tenant isolation (T16-31)', () => {
  it('surveys: another society gets SURVEY_NOT_FOUND on every survey route', async () => {
    const made = await w.chair(
      'post',
      '/surveys',
      {
        title: 'Isolation survey',
        closesAt: '2026-11-10T10:00:00.000Z',
        resultsVisibility: 'ALL_AFTER_CLOSE',
        questions: [{ type: 'YES_NO', prompt: 'Extend the gym hours?' }],
      },
      { headers: idem() },
    );
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const s = made.body.data;
    const pub = await w.chair('post', `/surveys/${s.id}/publish`, { version: s.version });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    const id = s.id;
    const v = pub.body.data.version;
    const C = 'SURVEY_NOT_FOUND';
    expect404(await other.c('get', `/surveys/${id}`), C, 'GET');
    expect404(await other.c('patch', `/surveys/${id}`, { version: v, title: 'Hijacked survey' }), C, 'PATCH');
    expect404(
      await other.c('delete', `/surveys/${id}`, undefined, { query: { version: String(v) } }),
      C,
      'DELETE',
    );
    expect404(await other.c('post', `/surveys/${id}/publish`, { version: v }), C, 'publish');
    expect404(await other.c('post', `/surveys/${id}/close`, { version: v }), C, 'close');
    expect404(
      await other.c('post', `/surveys/${id}/cancel`, { version: v, reason: 'Hijack attempt here' }),
      C,
      'cancel',
    );
    expect404(await other.c('get', `/surveys/${id}/results`), C, 'results');
    expect404(await other.c('get', `/surveys/${id}/results/export`), C, 'export');
    expect404(await other.res('get', `/me/surveys/${id}`), C, 'me GET');
    expect404(
      await other.res(
        'post',
        `/me/surveys/${id}/responses`,
        { answers: [{ questionId: s.questions[0].id, optionKey: 'yes' }] },
        { headers: idem() },
      ),
      C,
      'me respond',
    );
  }, 180_000);

  it('emergency: another society gets EMERGENCY_NOT_FOUND on every alert route, gate routes included', async () => {
    const st = await w.chair(
      'post',
      '/emergency-broadcasts',
      { type: 'FIRE', message: 'Smoke seen on the 2nd floor, use the stairs', confirm: true },
      { headers: idem() },
    );
    expect(st.status, JSON.stringify(st.body)).toBe(201);
    const id = st.body.data.id;
    const resp = await w.own(
      'post',
      `/emergency-broadcasts/${id}/responses`,
      { status: 'SAFE' },
      { headers: idem() },
    );
    expect(resp.status, JSON.stringify(resp.body)).toBeLessThan(300);
    const responseId = resp.body.data.responseId;
    const C = 'EMERGENCY_NOT_FOUND';
    const msg = 'A message from elsewhere';
    expect404(await other.c('get', `/emergency-broadcasts/${id}`), C, 'GET');
    expect404(await other.c('get', `/emergency-broadcasts/${id}/roll-call`), C, 'roll-call');
    expect404(
      await other.c('post', `/emergency-broadcasts/${id}/updates`, { version: 1, message: msg }),
      C,
      'updates',
    );
    expect404(await other.c('post', `/emergency-broadcasts/${id}/realert`, { version: 1 }), C, 'realert');
    expect404(
      await other.c('post', `/emergency-broadcasts/${id}/resolve`, { version: 1, allClearMessage: msg }),
      C,
      'resolve',
    );
    expect404(
      await other.c('post', `/emergency-broadcasts/${id}/cancel`, { version: 1, reason: msg }),
      C,
      'cancel',
    );
    expect404(
      await other.res(
        'post',
        `/emergency-broadcasts/${id}/responses`,
        { status: 'SAFE' },
        { headers: idem() },
      ),
      C,
      'responses',
    );
    expect404(
      await other.c('post', `/emergency-broadcasts/${id}/responses/${responseId}/attend`, {}),
      C,
      'attend',
    );
    expect404(await other.guard('get', `/gate/emergency-broadcasts/${id}/roll-call`), C, 'gate roll-call');
    expect404(
      await other.guard(
        'post',
        `/gate/emergency-broadcasts/${id}/responses`,
        { status: 'SAFE' },
        { headers: idem() },
      ),
      C,
      'gate responses',
    );
  }, 180_000);

  it('resident notices: another society gets NOTICE_NOT_FOUND on read, acknowledge and attachment', async () => {
    const n = await makeNotice(w.sid, { title: 'Isolation notice', requiresAck: true });
    const C = 'NOTICE_NOT_FOUND';
    expect404(await other.res('get', `/me/notices/${n.id}`), C, 'GET');
    expect404(await other.res('post', `/me/notices/${n.id}/acknowledge`, {}), C, 'acknowledge');
    expect404(await other.res('get', `/me/notices/${n.id}/attachments/1/download-url`), C, 'attachment');
  }, 180_000);

  it('bell: an item of another society is 404 NOTIFICATION_NOT_FOUND, even for its own user', async () => {
    const foreign = await InboxItem.create({
      scope: 'SOCIETY',
      societyId: other.sid,
      userId: w.ownId,
      batchId: '00000000-0000-4000-8000-000000000016',
      templateKey: 'approvals.pending',
      category: 'APPROVALS',
      deliveryClass: 'TRANSACTIONAL',
      tone: 'warn',
      title: 'Approval needed',
      body: 'Something to approve',
      deepLink: '/approvals/77',
    } as never);
    expect404(await w.own('post', `/notifications/${foreign.id}/read`, {}), 'NOTIFICATION_NOT_FOUND', 'read');
    expect((await foreign.reload()).readAt).toBeNull();
  }, 180_000);
});
