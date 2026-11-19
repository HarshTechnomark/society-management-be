import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog, InboxItem, Survey, SurveyResponse, closeDb } from '../../../src/models';
import { sha256Hex } from '../../../src/modules/communication/communication.crypto';
import { commWorld, idem, type CommWorld } from '../../helpers/communication';
import { setupSociety } from '../../helpers/society-setup';

afterAll(async () => {
  await closeDb();
});

let w: CommWorld;
beforeAll(async () => {
  w = await commWorld('PREMIUM');
}, 300_000);

const CLOSES = '2026-11-10T10:00:00.000Z';
const questions = [
  {
    type: 'SINGLE_CHOICE',
    prompt: 'Preferred gym hours?',
    options: [
      { key: 'o1', label: 'Morning' },
      { key: 'o2', label: 'Evening' },
    ],
  },
  {
    type: 'MULTI_CHOICE',
    prompt: 'Which machines?',
    maxSelections: 2,
    options: [
      { key: 'o1', label: 'Treadmill' },
      { key: 'o2', label: 'Bike' },
      { key: 'o3', label: 'Rower' },
    ],
  },
  { type: 'YES_NO', prompt: 'Extend the gym hours?' },
  { type: 'RATING', prompt: 'Rate the gym' },
  { type: 'NPS', prompt: 'Would you recommend it?' },
  { type: 'NUMBER', prompt: 'Visits per week', minValue: 0, maxValue: 14 },
  { type: 'TEXT', prompt: 'Any suggestion?', isRequired: false, maxLength: 100 },
  { type: 'DATE', prompt: 'Best date for the review', isRequired: false },
];
const create = (c: any, body: Record<string, unknown> = {}) =>
  c(
    'post',
    '/surveys',
    {
      title: 'Gym timings survey',
      description: 'Tell us',
      closesAt: CLOSES,
      resultsVisibility: 'ALL_AFTER_CLOSE',
      questions,
      ...body,
    },
    { headers: idem() },
  );
const publish = (c: any, id: number, version: number, body: Record<string, unknown> = {}) =>
  c('post', `/surveys/${id}/publish`, { version, ...body });
const qid = (s: any, i: number): number => s.questions[i].id;
const answersOf = (s: any, o: { rating: number; nps: number; single?: string; text?: string }) => [
  { questionId: qid(s, 0), optionKey: o.single ?? 'o1' },
  { questionId: qid(s, 1), optionKeys: ['o1', 'o2'] },
  { questionId: qid(s, 2), optionKey: 'yes' },
  { questionId: qid(s, 3), number: o.rating },
  { questionId: qid(s, 4), number: o.nps },
  { questionId: qid(s, 5), number: 3 },
  ...(o.text ? [{ questionId: qid(s, 6), text: o.text }] : []),
];
const answer = (c: any, id: number, answers: unknown[], extra: Record<string, unknown> = {}) =>
  c('post', `/me/surveys/${id}/responses`, { answers, ...extra }, { headers: idem() });

let named: any; // the published named survey

describe('draft: create, edit, validate, permissions (8.31)', () => {
  it('creates a draft with eight question types, positions and defaults', async () => {
    const r = await create(w.chair);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    named = r.body.data;
    expect(named).toMatchObject({
      status: 'DRAFT',
      isAnonymous: false,
      responseScope: 'PERSON',
      questionCount: 8,
      version: 1,
    });
    expect(named.audience).toMatchObject({ type: 'ALL', relation: 'ANY', label: 'All residents' });
    expect(named.questions.map((q: any) => q.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(named.questions[6].maxLength).toBe(100);
    expect(named.questions[1].maxSelections).toBe(2);
    expect(
      await AuditLog.count({ where: { societyId: w.sid, action: 'communication.survey.created' } }),
    ).toBe(1);
    const audit = (await AuditLog.findOne({
      where: { societyId: w.sid, action: 'communication.survey.created' },
    }))!;
    expect(JSON.stringify(audit.after)).not.toContain('Gym timings'); // lengths and ids only
  }, 60_000);

  it('validates question shapes, strict bodies, idempotency key and permissions', async () => {
    const bad = await create(w.chair, {
      questions: [
        {
          type: 'TEXT',
          prompt: 'Say more',
          options: [
            { key: 'o1', label: 'A' },
            { key: 'o2', label: 'B' },
          ],
        },
      ],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    expect((await create(w.chair, { extra: 1 })).status).toBe(400);
    expect((await create(w.chair, { title: 'abc' })).status).toBe(400);
    expect((await w.chair('post', '/surveys', { title: 'Gym timings again' })).status).toBe(400); // key required
    expect((await create(w.acc)).status).toBe(403);
    expect((await create(w.tre)).status).toBe(403); // view only
    expect((await create(w.own)).status).toBe(403);
    expect((await w.tre('get', '/surveys')).status).toBe(200);
    expect((await w.acc('get', '/surveys')).status).toBe(403);
    expect((await w.own('get', '/surveys')).status).toBe(403);
    const key = idem();
    const body = { title: 'Idempotent survey' };
    const a = await w.sec('post', '/surveys', body, { headers: key });
    const b = await w.sec('post', '/surveys', body, { headers: key });
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await Survey.count({ where: { societyId: w.sid, title: 'Idempotent survey' } })).toBe(1);
  }, 60_000);

  it('edits a draft (replaces the questions as a set), refuses a stale version, own-versus-any rule', async () => {
    const stale = await w.chair('patch', `/surveys/${named.id}`, {
      version: 9,
      title: 'Gym timings survey v2',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    const ok = await w.chair('patch', `/surveys/${named.id}`, {
      version: 1,
      title: 'Gym timings survey v2',
      questions,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.version).toBe(2);
    named = ok.body.data;
    expect(named.title).toBe('Gym timings survey v2');
    expect(named.questions).toHaveLength(8);
    // the secretary holds `communication.surveys.edit` too, the treasurer neither
    expect(
      (await w.sec('patch', `/surveys/${named.id}`, { version: 2, description: 'Edited by the secretary' }))
        .status,
    ).toBe(200);
    expect((await w.tre('patch', `/surveys/${named.id}`, { version: 3, description: 'No' })).status).toBe(
      403,
    );
    const list = await w.chair('get', '/surveys?q=Gym&sortBy=responseCount');
    expect(list.body.data.length).toBeGreaterThan(0);
    expect(list.body.pagination).toBeTruthy();
    expect((await w.chair('get', '/surveys?q=G')).status).toBe(400);
    const d = await w.chair('get', `/surveys/${named.id}`);
    named = d.body.data;
  }, 60_000);

  it('deletes only drafts (soft), with the version', async () => {
    const t = (await create(w.chair, { title: 'Throwaway survey', questions: [] })).body.data;
    expect((await w.chair('delete', `/surveys/${t.id}?version=5`)).body.code).toBe('STALE_VERSION');
    expect((await w.tre('delete', `/surveys/${t.id}?version=1`)).status).toBe(403);
    const del = await w.chair('delete', `/surveys/${t.id}?version=1`);
    expect(del.status).toBe(204);
    expect((await w.chair('get', `/surveys/${t.id}`)).body.code).toBe('SURVEY_NOT_FOUND');
    expect(await Survey.count({ where: { id: t.id }, paranoid: false })).toBe(1);
  }, 60_000);

  it('Standard plan: every survey write and resident route is gated by the Premium feature', async () => {
    const std = await setupSociety({ plan: 'STANDARD', name: 'Std Chair' });
    const r = await std.c('post', '/surveys', { title: 'Plan gated survey' }, { headers: idem() });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('FEATURE_NOT_IN_PLAN');
    expect((await std.c('get', '/surveys')).status).toBe(402);
  }, 60_000);
});

describe('publish (8.32)', () => {
  it('needs questions, a valid closing time and an audience', async () => {
    const empty = (await create(w.chair, { title: 'Empty survey', questions: [] })).body.data;
    const noQ = await publish(w.chair, empty.id, 1);
    expect(noQ.status).toBe(422);
    expect(noQ.body.code).toBe('SURVEY_QUESTIONS_REQUIRED');
    const soon = await publish(w.chair, named.id, named.version, { closesAt: '2026-11-01T04:40:00.000Z' });
    expect(soon.status).toBe(422);
    expect(soon.body.code).toBe('SURVEY_CLOSE_INVALID');
    const far = await publish(w.chair, named.id, named.version, { closesAt: '2027-03-01T00:00:00.000Z' });
    expect(far.body.code).toBe('SURVEY_CLOSE_INVALID');
    const noClose = (await create(w.chair, { title: 'No closing time', closesAt: null })).body.data;
    expect((await publish(w.chair, noClose.id, 1)).body.code).toBe('SURVEY_CLOSE_INVALID');
    const nobody = (
      await create(w.chair, { title: 'Nobody survey', audience: { type: 'BUILDINGS', ids: [999999] } })
    ).body.data;
    const none = await publish(w.chair, nobody.id, 1);
    expect(none.status).toBe(422);
    expect(none.body.code).toBe('SURVEY_AUDIENCE_EMPTY');
    expect((await publish(w.tre, named.id, named.version)).status).toBe(403);
    expect((await publish(w.chair, named.id, 99)).body.code).toBe('STALE_VERSION');
  }, 90_000);

  it('opens the survey, records recipients, locks the draft, notifies the audience', async () => {
    const r = await publish(w.chair, named.id, named.version);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'OPEN', recipientCount: 5 }); // five residents with a login
    expect(r.body.data.openedAt).toBeTruthy();
    expect(
      await AuditLog.count({ where: { societyId: w.sid, action: 'communication.survey.published' } }),
    ).toBe(1);
    named = r.body.data;
    const edit = await w.chair('patch', `/surveys/${named.id}`, {
      version: named.version,
      title: 'Edited after publish',
    });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('INVALID_STATE');
    expect((await w.chair('delete', `/surveys/${named.id}?version=${named.version}`)).body.code).toBe(
      'INVALID_STATE',
    );
    expect((await publish(w.chair, named.id, named.version)).body.code).toBe('INVALID_STATE');
    expect(await InboxItem.count({ where: { userId: w.ownId, societyId: w.sid } })).toBeGreaterThan(0);
  }, 60_000);
});

describe('resident answers (8.34)', () => {
  it('lists open surveys for audience members only and shows the survey to answer', async () => {
    const mine = await w.own('get', '/me/surveys');
    expect(mine.status).toBe(200);
    expect(mine.body.data[0]).toMatchObject({
      id: named.id,
      responded: false,
      resultsAvailable: false,
      questionCount: 8,
    });
    expect((await w.chair('get', '/me/surveys')).status).toBe(403);
    const d = await w.own('get', `/me/surveys/${named.id}`);
    expect(d.status).toBe(200);
    expect(d.body.data).toMatchObject({
      title: 'Gym timings survey v2',
      status: 'OPEN',
      responded: false,
      isAnonymous: false,
    });
    expect(d.body.data.questions[0].options).toEqual([
      { key: 'o1', label: 'Morning' },
      { key: 'o2', label: 'Evening' },
    ]);
    expect(d.body.data.results).toBeUndefined();
    expect((await w.own('get', '/me/surveys/99999999')).body.code).toBe('SURVEY_NOT_FOUND');
  }, 60_000);

  it('rejects wrong answers (with the question id), accepts a valid set once, replays by key, blocks duplicates', async () => {
    const wrong = await answer(w.own, named.id, [{ questionId: qid(named, 3), number: 9 }]);
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe('SURVEY_ANSWER_INVALID');
    expect(wrong.body.errors[0].questionId).toBeTruthy();
    expect((await answer(w.own, named.id, [])).status).toBe(400);
    const key = idem();
    const body = { answers: answersOf(named, { rating: 4, nps: 10, single: 'o1', text: 'Add a spin bike' }) };
    const ok = await w.own('post', `/me/surveys/${named.id}/responses`, body, { headers: key });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.submissionId).toMatch(/^[0-9a-f-]{36}$/);
    const replay = await w.own('post', `/me/surveys/${named.id}/responses`, body, { headers: key });
    expect(replay.body.data.submissionId).toBe(ok.body.data.submissionId);
    const dup = await answer(w.own, named.id, answersOf(named, { rating: 1, nps: 1 }));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('SURVEY_ALREADY_RESPONDED');
    const s = (await Survey.findByPk(named.id))!;
    expect(s.responseCount).toBe(1);
    // 8 answer rows plus one extra for the second multi-choice selection
    expect(await SurveyResponse.count({ where: { surveyId: named.id } })).toBe(8);
    const row = (await SurveyResponse.findOne({ where: { surveyId: named.id } }))!;
    expect(row.userId).toBe(w.ownId); // named survey: person is stored
    expect(row.respondentKey).toBe(sha256Hex(`${named.id}:PERSON:${w.ownId}`));
    expect(
      await AuditLog.count({
        where: { societyId: w.sid, action: 'communication.survey_response.submitted' },
      }),
    ).toBe(1);
    expect((await w.own('get', '/me/surveys')).body.data[0].responded).toBe(true);
  }, 60_000);

  it('four more residents answer; results aggregate exactly (counts, percentages, average, NPS)', async () => {
    const people: [any, number, number, string][] = [
      [w.fam, 4, 9, 'o1'],
      [w.own2, 5, 8, 'o2'],
      [w.ownB, 3, 6, 'o1'],
      [w.own3, 5, 3, 'o2'],
    ];
    for (const [c, rating, nps, single] of people) {
      const r = await answer(c, named.id, answersOf(named, { rating, nps, single }));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const res = await w.chair('get', `/surveys/${named.id}/results`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({
      surveyId: named.id,
      status: 'OPEN',
      responses: 5,
      recipients: 5,
      isAnonymous: false,
    });
    expect(d.questions[0]).toMatchObject({ prompt: 'Preferred gym hours?', answered: 5 });
    expect(d.questions[0].options).toEqual([
      { key: 'o1', label: 'Morning', count: 3, pct: '60.0' },
      { key: 'o2', label: 'Evening', count: 2, pct: '40.0' },
    ]);
    expect(d.questions[1].options[0]).toMatchObject({ key: 'o1', count: 5, pct: '100.0' });
    expect(d.questions[2].options[0]).toMatchObject({ key: 'yes', count: 5 });
    expect(d.questions[3]).toMatchObject({ average: '4.20', distribution: { 1: 0, 2: 0, 3: 1, 4: 2, 5: 2 } });
    expect(d.questions[4]).toMatchObject({ answered: 5, promoters: 2, passives: 1, detractors: 2, nps: 0 });
    expect(d.questions[5]).toMatchObject({ average: '3.00', min: 3, max: 3 });
    expect(d.questions[6]).toMatchObject({ answered: 1, samples: ['Add a spin bike'], hidden: false });
    expect((await w.tre('get', `/surveys/${named.id}/results`)).status).toBe(200);
    expect((await w.own('get', `/surveys/${named.id}/results`)).status).toBe(403);
  }, 120_000);

  it('a resident outside the audience gets 404 and cannot answer', async () => {
    const onlyA = (
      await create(w.chair, {
        title: 'Tower A only',
        audience: { type: 'BUILDINGS', ids: [w.a.id] },
        questions: [questions[2]],
      })
    ).body.data;
    expect((await publish(w.chair, onlyA.id, 1)).status).toBe(200);
    expect((await w.ownB('get', `/me/surveys/${onlyA.id}`)).body.code).toBe('SURVEY_NOT_FOUND');
    expect(
      (await answer(w.ownB, onlyA.id, [{ questionId: onlyA.questions[0].id, optionKey: 'yes' }])).status,
    ).toBe(404);
    expect((await w.ownB('get', '/me/surveys')).body.data.some((s: any) => s.id === onlyA.id)).toBe(false);
    expect(
      (await answer(w.own, onlyA.id, [{ questionId: onlyA.questions[0].id, optionKey: 'yes' }])).status,
    ).toBe(201);
  }, 90_000);
});

describe('flat scope and anonymity (BR-16-47, BR-16-48)', () => {
  let anon: any;
  it('flat scope: the first resident of the flat answers for everyone in it', async () => {
    const f = (
      await create(w.chair, {
        title: 'One answer per flat',
        responseScope: 'FLAT',
        questions: [questions[2]],
      })
    ).body.data;
    expect((await publish(w.chair, f.id, 1)).status).toBe(200);
    const a = [{ questionId: f.questions[0].id, optionKey: 'yes' }];
    expect((await answer(w.own, f.id, a)).status).toBe(201);
    const second = await answer(w.fam, f.id, a);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('SURVEY_ALREADY_RESPONDED');
    expect((await w.fam('get', `/me/surveys/${f.id}`)).body.data.responded).toBe(true);
    expect((await answer(w.own2, f.id, a)).status).toBe(201); // another flat
    const badUnit = await answer(w.ownB, f.id, a, { unitId: w.a101 });
    expect(badUnit.status).toBe(422);
    expect(badUnit.body.code).toBe('SURVEY_UNIT_REQUIRED');
  }, 90_000);

  it('anonymous survey: no user, no flat, hashed key, hour-truncated times, no audit row, text hidden below 5 answers', async () => {
    anon = (
      await create(w.chair, {
        title: 'Anonymous feedback',
        isAnonymous: true,
        questions: [questions[3], { type: 'TEXT', prompt: 'Your feedback', maxLength: 200 }],
      })
    ).body.data;
    expect((await publish(w.chair, anon.id, 1)).status).toBe(200);
    const a = (n: number, t: string) => [
      { questionId: anon.questions[0].id, number: n },
      { questionId: anon.questions[1].id, text: t },
    ];
    expect((await answer(w.own, anon.id, a(4, 'Louder music please'))).status).toBe(201);
    const rows = await SurveyResponse.findAll({ where: { surveyId: anon.id } });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.userId).toBeNull();
      expect(r.unitId).toBeNull();
      expect(r.createdBy).toBeNull();
      expect(r.respondentKey).not.toBe(sha256Hex(`${anon.id}:PERSON:${w.ownId}`));
      expect(r.createdAt.getUTCMinutes()).toBe(0);
      expect(r.createdAt.getUTCSeconds()).toBe(0);
    }
    expect(
      await AuditLog.count({
        where: {
          societyId: w.sid,
          action: 'communication.survey_response.submitted',
          entityId: rows[0]!.submissionId,
        },
      }),
    ).toBe(0);
    expect((await answer(w.own, anon.id, a(1, 'Again'))).body.code).toBe('SURVEY_ALREADY_RESPONDED');
    const res = await w.chair('get', `/surveys/${anon.id}/results`);
    expect(res.body.data.questions[1]).toMatchObject({ answered: 1, hidden: true, samples: [] });
    const csv = await w.chair('get', `/surveys/${anon.id}/results/export`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const text = csv.text ?? String(csv.body);
    expect(text).not.toContain('Name');
    expect(text).not.toContain('Alok');
    expect(text).not.toContain('A-101');
    expect(text.split(/\r?\n/)[0]).toBe('Submission,Submitted at,Q1: Rate the gym,Q2: Your feedback');
    expect(
      await AuditLog.count({ where: { societyId: w.sid, action: 'communication.survey.exported' } }),
    ).toBe(1);
    // four more answers: five responses reveal the text answers
    for (const c of [w.fam, w.own2, w.ownB, w.own3]) await answer(c, anon.id, a(5, 'Fine'));
    const res2 = await w.chair('get', `/surveys/${anon.id}/results`);
    expect(res2.body.data.questions[1].hidden).toBe(false);
    expect(res2.body.data.questions[1].samples).toHaveLength(5);
  }, 120_000);

  it('export: needs the export permission; a named survey lists names and flats', async () => {
    expect((await w.tre('get', `/surveys/${named.id}/results/export`)).status).toBe(403);
    const csv = await w.chair('get', `/surveys/${named.id}/results/export`);
    expect(csv.status).toBe(200);
    const text: string = csv.text ?? String(csv.body);
    const lines = text.trim().split(/\r?\n/);
    expect(lines).toHaveLength(6); // header + 5 submissions
    expect(lines[0]).toContain('Name,Flat,Q1: Preferred gym hours?');
    expect(text).toContain('Alok Owner');
    expect(text).toContain('A-101');
    expect(text).toContain('Morning');
    expect(text).toContain('Treadmill; Bike');
  }, 60_000);
});

describe('close, cancel and results visibility (6.4, BR-16-46, BR-16-49)', () => {
  it('close now: version, state, notify respondents; residents then see results; answers refused', async () => {
    expect((await w.chair('post', `/surveys/${named.id}/close`, { version: 99 })).body.code).toBe(
      'STALE_VERSION',
    );
    expect((await w.tre('post', `/surveys/${named.id}/close`, { version: named.version })).status).toBe(403);
    const cur = await w.chair('get', `/surveys/${named.id}`);
    const closed = await w.chair('post', `/surveys/${named.id}/close`, { version: cur.body.data.version });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data).toMatchObject({ status: 'CLOSED', responseCount: 5 });
    expect(closed.body.data.closedAt).toBeTruthy();
    expect(
      (await w.chair('post', `/surveys/${named.id}/close`, { version: closed.body.data.version })).body.code,
    ).toBe('INVALID_STATE');
    expect(
      (
        await w.chair('post', `/surveys/${named.id}/cancel`, {
          version: closed.body.data.version,
          reason: 'Cancel after the close',
        })
      ).body.code,
    ).toBe('INVALID_STATE');
    const late = await answer(w.ownB, named.id, answersOf(named, { rating: 1, nps: 1 }));
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('SURVEY_NOT_OPEN');
  }, 90_000);

  it('after the close residents see the results (ALL_AFTER_CLOSE); a cancelled survey hides them', async () => {
    const d = await w.own('get', `/me/surveys/${named.id}`);
    expect(d.body.data.status).toBe('CLOSED');
    expect(d.body.data.results.questions[3].average).toBe('4.20');
    expect(
      (await w.own('get', '/me/surveys')).body.data.find((s: any) => s.id === named.id).resultsAvailable,
    ).toBe(true);
    const c = (
      await create(w.chair, {
        title: 'To be cancelled',
        resultsVisibility: 'RESPONDENTS_AFTER_CLOSE',
        questions: [questions[2]],
      })
    ).body.data;
    expect((await publish(w.chair, c.id, 1)).status).toBe(200);
    expect((await answer(w.own, c.id, [{ questionId: c.questions[0].id, optionKey: 'no' }])).status).toBe(
      201,
    );
    expect((await w.chair('post', `/surveys/${c.id}/cancel`, { version: 2, reason: 'short' })).status).toBe(
      400,
    );
    const cancelled = await w.chair('post', `/surveys/${c.id}/cancel`, {
      version: 2,
      reason: 'Question was unclear to everyone',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Question was unclear to everyone',
    });
    expect((await w.own2('get', `/me/surveys/${c.id}`)).status).toBe(404);
    const mineList = await w.own('get', '/me/surveys');
    expect(mineList.body.data.some((s: any) => s.id === c.id)).toBe(false);
    expect((await answer(w.own2, c.id, [{ questionId: c.questions[0].id, optionKey: 'no' }])).body.code).toBe(
      'SURVEY_NOT_OPEN',
    );
  }, 120_000);

  it('a draft has no results; tenant isolation: another society sees 404', async () => {
    const dft = (await create(w.chair, { title: 'Draft results check', questions: [] })).body.data;
    const r = await w.chair('get', `/surveys/${dft.id}/results`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('INVALID_STATE');
    const other = await setupSociety({ plan: 'PREMIUM', name: 'Other Chair' });
    expect((await other.c('get', `/surveys/${named.id}`)).body.code).toBe('SURVEY_NOT_FOUND');
    expect((await other.c('get', `/surveys/${named.id}/results`)).status).toBe(404);
    expect((await other.c('post', `/surveys/${named.id}/close`, { version: 1 })).status).toBe(404);
    expect((await other.c('get', '/surveys')).body.data).toEqual([]);
  }, 90_000);
});
