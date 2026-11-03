import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog, OnboardingStep, closeDb, sequelize } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { onboarding } from '../../../src/modules/society-setup/society-setup.public';
import { events, inboxFor } from '../../helpers/auth';
import {
  memberOf,
  rawUnits,
  resetSetup,
  setupSociety,
  makeBuilding,
  makeUnit,
} from '../../helpers/society-setup';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetSetup);

const KEYS = ['PROFILE', 'STRUCTURE', 'UNITS', 'RESIDENTS', 'BILLING', 'PAYMENTS', 'COMMITTEE', 'GO_LIVE'];
const audits = (societyId: number, action: string) =>
  AuditLog.findAll({ where: { societyId, action }, order: [['id', 'ASC']] });
const get = async (c: any) => (await c('get', '/onboarding')).body.data;
const complete = (c: any, k: string) => c('post', `/onboarding/steps/${k}/complete`, {});
const skip = (c: any, k: string, reason = 'We will do this after the AGM') =>
  c('post', `/onboarding/steps/${k}/skip`, { reason });
const reopen = (c: any, k: string) => c('post', `/onboarding/steps/${k}/reopen`, {});
const goLive = (c: any, headers?: Record<string, string>) =>
  c('post', '/onboarding/go-live', {}, { headers: headers ?? { 'Idempotency-Key': crypto.randomUUID() } });
const step = (data: any, k: string) => data.steps.find((s: any) => s.stepKey === k);

/** A society whose PROFILE, STRUCTURE, UNITS checks pass. */
async function readySociety(o: { units?: number } = {}) {
  const s = await setupSociety();
  await s.c('patch', '/society', {
    version: 1,
    registrationNo: 'PNA/HSG/1234/2009',
    reason: 'Registration certificate',
  });
  const b = await makeBuilding(s.c, { floorsAboveGround: 5 });
  for (let i = 1; i <= (o.units ?? 2); i++) await makeUnit(s.c, b.id, `10${i}`, 1, { carpetAreaSqft: '900' });
  return { ...s, b };
}

describe('GET /onboarding (8.23, BR-08-43, BR-08-46)', () => {
  it('US-08-08 a new society lands on step 1 with 0%: 8 steps in order with their flags and check states', async () => {
    const { society, c } = await setupSociety();
    const d = await get(c);
    expect(d).toMatchObject({ isLive: false, progressPercent: 0, currentStep: 'PROFILE' });
    expect(d.steps.map((s: any) => [s.stepKey, s.stepNo, s.isRequired, s.skippable, s.status])).toEqual([
      ['PROFILE', 1, true, false, 'PENDING'],
      ['STRUCTURE', 2, true, false, 'PENDING'],
      ['UNITS', 3, true, false, 'PENDING'],
      ['RESIDENTS', 4, false, true, 'PENDING'],
      ['BILLING', 5, true, false, 'PENDING'],
      ['PAYMENTS', 6, false, true, 'PENDING'],
      ['COMMITTEE', 7, false, true, 'PENDING'],
      ['GO_LIVE', 8, true, false, 'PENDING'],
    ]);
    expect(step(d, 'PROFILE')).toMatchObject({ checkState: 'FAIL', summary: 'Missing: registration number' });
    expect(step(d, 'STRUCTURE')).toMatchObject({ checkState: 'FAIL', summary: 'No buildings yet' });
    expect(step(d, 'UNITS')).toMatchObject({
      checkState: 'PASS',
      summary: 'All 0 billable units have an area',
    });
    expect(step(d, 'RESIDENTS')).toMatchObject({ checkState: 'NOT_AVAILABLE' });
    expect(step(d, 'BILLING')).toMatchObject({ checkState: 'NOT_AVAILABLE' });
    expect(step(d, 'COMMITTEE')).toMatchObject({
      checkState: 'FAIL',
      summary: 'Only one person can manage the society',
    });
    expect(step(d, 'GO_LIVE')).toMatchObject({ checkState: 'FAIL', summary: '7 steps left' });
    expect(await OnboardingStep.count({ where: { societyId: society.id! } })).toBe(8);
  });

  it('BR-08-43 creates the rows once, even for parallel first reads', async () => {
    const { society, c } = await setupSociety();
    const rs = await Promise.all([c('get', '/onboarding'), c('get', '/onboarding'), c('get', '/onboarding')]);
    expect(rs.map(r => r.status)).toEqual([200, 200, 200]);
    const rows = await OnboardingStep.findAll({
      where: { societyId: society.id! },
      order: [['stepNo', 'ASC']],
    });
    expect(rows.map(r => r.stepKey)).toEqual(KEYS);
    await get(c);
    expect(await OnboardingStep.count({ where: { societyId: society.id! } })).toBe(8);
    expect(await onboarding.progressPercent(society.id!)).toBe(0);
  });

  it('the COMMITTEE fallback passes when two people hold settings.society.view', async () => {
    const { society, c } = await setupSociety();
    await memberOf(society, 'secretary');
    expect(step(await get(c), 'COMMITTEE')).toMatchObject({
      checkState: 'PASS',
      summary: '2 committee members',
    });
  });

  it('is available to settings.society.view holders and not to others', async () => {
    const { society } = await setupSociety();
    expect((await (await memberOf(society, 'committee_member')).c('get', '/onboarding')).status).toBe(200);
    expect((await (await memberOf(society, 'security_supervisor')).c('get', '/onboarding')).status).toBe(403);
  });
});

describe('checks (6.4, BR-08-45)', () => {
  it('PROFILE: name, address, city, state, PIN and registration number must be set', async () => {
    const { c } = await setupSociety();
    const fail = await complete(c, 'PROFILE');
    expect([fail.status, fail.body.code]).toEqual([422, 'ONBOARDING_STEP_INCOMPLETE']);
    expect(fail.body.errors[0]).toEqual({ field: 'PROFILE', message: 'Missing: registration number' });
    await c('patch', '/society', {
      version: 1,
      registrationNo: 'PNA/HSG/1234/2009',
      reason: 'Registration certificate',
    });
    const ok = await complete(c, 'PROFILE');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(step(ok.body.data, 'PROFILE')).toMatchObject({
      status: 'DONE',
      checkState: 'PASS',
      summary: 'Profile complete',
    });
    expect(step(ok.body.data, 'PROFILE').completedAt).toBeTruthy();
  });

  it('STRUCTURE needs an active building and an active unit; UNITS needs an area on every billable unit', async () => {
    const { society, c } = await setupSociety();
    expect((await complete(c, 'STRUCTURE')).body.errors[0].message).toBe('No buildings yet');
    const b = await makeBuilding(c, { floorsAboveGround: 5 });
    expect((await complete(c, 'STRUCTURE')).body.errors[0].message).toBe('No flats yet');
    await makeUnit(c, b.id, '101', 1);
    expect((await complete(c, 'STRUCTURE')).status).toBe(200);
    // a unit without an area fails UNITS; a non-billable unit without an area does not count
    expect((await complete(c, 'UNITS')).body.errors[0].message).toBe('1 billable unit has no area');
    await makeUnit(c, b.id, 'P1', 0, { unitType: 'PARKING_ONLY' });
    await sequelize.query(
      "UPDATE units SET areaSqft = 800, carpetAreaSqft = 800 WHERE societyId = :id AND unitNumber = '101'",
      { replacements: { id: society.id } },
    );
    const ok = await complete(c, 'UNITS');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(step(ok.body.data, 'UNITS').summary).toBe('All 1 billable units have an area');
  });

  it('T08-28 completing UNITS with 12 billable units missing an area is 422 "12 billable units have no area"', async () => {
    const { society, c, b } = await readySociety({ units: 1 });
    await rawUnits(society.id!, b.id, 'A', 12, { floor: 2 });
    const r = await complete(c, 'UNITS');
    expect([r.status, r.body.code]).toEqual([422, 'ONBOARDING_STEP_INCOMPLETE']);
    expect(r.body.errors[0].message).toBe('12 billable units have no area');
    expect(r.body.message).toBe('12 billable units have no area');
    expect(step(await get(c), 'UNITS')).toMatchObject({ status: 'PENDING', checkState: 'FAIL' });
  });

  it('steps without a registered check (RESIDENTS, BILLING, PAYMENTS) are completed by hand', async () => {
    const { c } = await setupSociety();
    for (const k of ['RESIDENTS', 'BILLING', 'PAYMENTS']) {
      const r = await complete(c, k);
      expect(r.status, `${k} ${JSON.stringify(r.body)}`).toBe(200);
      expect(step(r.body.data, k)).toMatchObject({
        status: 'DONE',
        checkState: 'PASS',
        summary: 'Completed by hand',
      });
    }
  });

  it('a check registered by an owning module decides: a failure refuses, a pass completes with its summary; one check per step', async () => {
    const { society, c } = await setupSociety();
    let done = false;
    onboarding.registerCheck('BILLING', 'billing', async () => ({
      done: false,
      summary: 'No charge head yet',
    }));
    onboarding.registerCheck('BILLING', 'billing', async sid => ({
      done,
      summary: done
        ? `Billing ready for ${sid === society.id ? 'this society' : 'another'}`
        : 'No active billing rule',
    }));
    expect(step(await get(c), 'BILLING')).toMatchObject({
      checkState: 'FAIL',
      summary: 'No active billing rule',
    });
    const fail = await complete(c, 'BILLING');
    expect([fail.status, fail.body.code]).toEqual([422, 'ONBOARDING_STEP_INCOMPLETE']);
    done = true;
    const ok = await complete(c, 'BILLING');
    expect(step(ok.body.data, 'BILLING')).toMatchObject({
      status: 'DONE',
      summary: 'Billing ready for this society',
    });
    // module 10 replaces the COMMITTEE fallback
    onboarding.registerCheck('COMMITTEE', 'committee', async () => ({
      done: false,
      summary: 'Committee not formed',
    }));
    expect(step(await get(c), 'COMMITTEE').summary).toBe('Committee not formed');
  });

  it('a check that takes longer than 2 seconds reports UNKNOWN and does not confirm the step', async () => {
    const { c } = await setupSociety();
    onboarding.registerCheck('PAYMENTS', 'payments', () => new Promise(() => undefined));
    onboarding.registerCheck('RESIDENTS', 'residents', async () => {
      throw new Error('module 09 is down');
    });
    const d = await get(c);
    expect(step(d, 'PAYMENTS')).toMatchObject({ checkState: 'UNKNOWN', summary: 'The check took too long' });
    expect(step(d, 'RESIDENTS')).toMatchObject({ checkState: 'UNKNOWN', summary: 'The check could not run' });
    const r = await complete(c, 'PAYMENTS');
    expect([r.status, r.body.code]).toEqual([422, 'ONBOARDING_STEP_INCOMPLETE']);
    expect((await skip(c, 'PAYMENTS')).status).toBe(200); // skipping needs no check
  });
});

describe('complete, skip and reopen (8.24, BR-08-44)', () => {
  it('T08-29 BILLING cannot be skipped (and neither can PROFILE, STRUCTURE or UNITS); the skippable steps can, with a reason', async () => {
    const { society, c } = await setupSociety();
    for (const k of ['PROFILE', 'STRUCTURE', 'UNITS', 'BILLING']) {
      const r = await skip(c, k);
      expect([r.status, r.body.code], k).toEqual([422, 'ONBOARDING_STEP_NOT_SKIPPABLE']);
    }
    const r = await skip(c, 'RESIDENTS', 'Residents join after the AGM');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(step(r.body.data, 'RESIDENTS')).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'Residents join after the AGM',
      checkState: 'NOT_AVAILABLE',
      summary: 'Skipped: Residents join after the AGM',
    });
    expect(await skip(c, 'PAYMENTS')).toHaveProperty('status', 200);
    expect(await skip(c, 'COMMITTEE')).toHaveProperty('status', 200);
    const log = await audits(society.id!, 'setup.onboarding.step_skipped');
    expect(log).toHaveLength(3);
    expect(log[0]).toMatchObject({
      entityType: 'onboarding_step',
      entityId: 'RESIDENTS',
      reason: 'Residents join after the AGM',
    });
  });

  it('validates the step key, the reason (5 to 300) and the bodies', async () => {
    const { c } = await setupSociety();
    expect((await skip(c, 'GO_LIVE')).status).toBe(400);
    expect((await complete(c, 'GO_LIVE')).status).toBe(400);
    expect((await c('post', '/onboarding/steps/NOPE/complete', {})).body.code).toBe('VALIDATION_FAILED');
    expect((await skip(c, 'RESIDENTS', 'abcd')).body.code).toBe('VALIDATION_FAILED');
    expect((await skip(c, 'RESIDENTS', 'x'.repeat(301))).body.code).toBe('VALIDATION_FAILED');
    expect((await c('post', '/onboarding/steps/RESIDENTS/skip', {})).status).toBe(400);
    expect((await c('post', '/onboarding/steps/RESIDENTS/complete', { reason: 'x' })).status).toBe(400);
    expect((await reopen(c, 'GO_LIVE')).status).toBe(400);
  });

  it('INVALID_STATE for completing or skipping a step that is not PENDING, and for reopening a PENDING step', async () => {
    const { c } = await setupSociety();
    await complete(c, 'PAYMENTS');
    for (const r of [await complete(c, 'PAYMENTS'), await skip(c, 'PAYMENTS'), await reopen(c, 'BILLING')])
      expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
    await skip(c, 'RESIDENTS');
    expect((await complete(c, 'RESIDENTS')).body.code).toBe('INVALID_STATE');
  });

  it('reopen sets a DONE or SKIPPED step back to PENDING and clears who and when; every change is audited', async () => {
    const { society, c } = await setupSociety();
    await complete(c, 'BILLING');
    await skip(c, 'RESIDENTS');
    const a = await reopen(c, 'BILLING');
    expect(step(a.body.data, 'BILLING')).toMatchObject({
      status: 'PENDING',
      completedAt: null,
      skipReason: null,
    });
    const b = await reopen(c, 'RESIDENTS');
    expect(step(b.body.data, 'RESIDENTS')).toMatchObject({ status: 'PENDING', skipReason: null });
    const row = (await OnboardingStep.findOne({ where: { societyId: society.id!, stepKey: 'BILLING' } }))!;
    expect([row.completedAt, row.completedBy, row.lastCheckSummary]).toEqual([null, null, null]);
    expect(await audits(society.id!, 'setup.onboarding.step_completed')).toHaveLength(1);
    expect(await audits(society.id!, 'setup.onboarding.step_reopened')).toHaveLength(2);
    // completing again works
    expect((await complete(c, 'BILLING')).status).toBe(200);
  });

  it('T08-31 progress is floor(100 x done-or-skipped / 8): 3 done is 37, 3 done and 1 skipped is 50; currentStep is the first open step', async () => {
    const { society, c } = await setupSociety();
    await complete(c, 'BILLING');
    await complete(c, 'PAYMENTS');
    await complete(c, 'RESIDENTS');
    const three = await get(c);
    expect(three.progressPercent).toBe(37);
    expect(three.currentStep).toBe('PROFILE');
    const r = await skip(c, 'COMMITTEE');
    expect(r.body.data.progressPercent).toBe(50);
    expect(await onboarding.progressPercent(society.id!)).toBe(50);
    expect(r.body.data.currentStep).toBe('PROFILE');
  });

  it('tells the admin room after each change (progress, live, current step) and needs settings.society.edit', async () => {
    const { society, c } = await setupSociety();
    await complete(c, 'BILLING');
    await new Promise(res => setTimeout(res, 50));
    const ev = events.filter(e => e.event === 'setup.onboarding.updated');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      room: `society:${society.id}:admin`,
      payload: { progressPercent: 12, isLive: false, currentStep: 'PROFILE' },
    });
    const viewer = await memberOf(society, 'committee_member');
    expect((await complete(viewer.c, 'PAYMENTS')).status).toBe(403);
    expect((await skip(viewer.c, 'PAYMENTS')).status).toBe(403);
    expect((await reopen(viewer.c, 'BILLING')).status).toBe(403);
    expect((await goLive(viewer.c)).status).toBe(403);
  });
});

describe('POST /onboarding/go-live (8.25, 6.5, BR-08-47)', () => {
  async function allButGoLive(s: Awaited<ReturnType<typeof readySociety>>) {
    for (const k of ['PROFILE', 'STRUCTURE', 'UNITS', 'BILLING'])
      expect((await complete(s.c, k)).status, k).toBe(200);
    for (const k of ['RESIDENTS', 'PAYMENTS', 'COMMITTEE']) expect((await skip(s.c, k)).status, k).toBe(200);
  }

  it('US-08-08 goes live with the skippable steps skipped: isLive, 100%, audit, notification, realtime and the go-live hook', async () => {
    const s = await readySociety();
    const hook = vi.fn();
    onboarding.registerGoLiveHook(async (_ctx, societyId, t) => {
      hook(societyId, typeof (t as any).commit);
    });
    await allButGoLive(s);
    const r = await goLive(s.c);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ isLive: true, progressPercent: 100, currentStep: null });
    expect(step(r.body.data, 'GO_LIVE')).toMatchObject({
      status: 'DONE',
      checkState: 'PASS',
      summary: 'Society is live',
    });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(s.society.id, 'function');
    const log = await audits(s.society.id!, 'setup.society.went_live');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ entityType: 'society', entityId: String(s.society.id) });
    const row = (await OnboardingStep.findOne({ where: { societyId: s.society.id!, stepKey: 'GO_LIVE' } }))!;
    expect([row.status, row.completedBy]).toEqual(['DONE', s.user.id]);
    await new Promise(res => setTimeout(res, 100));
    expect(events.filter(e => e.event === 'setup.onboarding.updated').at(-1)).toMatchObject({
      payload: { progressPercent: 100, isLive: true },
    });
    expect((await inboxFor(s.user.email!)).some(m => /is live on SocietyApp/.test(m.subject ?? ''))).toBe(
      true,
    );
    expect((await s.c('get', '/society')).body.data.isLive).toBe(true);
  });

  it('T08-30 going live twice: the first is 200, the second 409 ALREADY_LIVE; the hook ran once; the same key replays', async () => {
    const s = await readySociety();
    const hook = vi.fn();
    onboarding.registerGoLiveHook(() => {
      hook();
    });
    await allButGoLive(s);
    const headers = { 'Idempotency-Key': crypto.randomUUID() };
    const first = await goLive(s.c, headers);
    expect(first.status).toBe(200);
    const replay = await goLive(s.c, headers);
    expect(replay.headers['idempotent-replay']).toBe('true');
    const second = await goLive(s.c);
    expect([second.status, second.body.code]).toEqual([409, 'ALREADY_LIVE']);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(await audits(s.society.id!, 'setup.society.went_live')).toHaveLength(1);
    expect((await c2(s)).status).toBe(400); // an Idempotency-Key is required
  });
  const c2 = (s: { c: any }) => s.c('post', '/onboarding/go-live', {});

  it('two parallel go-lives: one succeeds, the other is ALREADY_LIVE', async () => {
    const s = await readySociety();
    await allButGoLive(s);
    const rs = await Promise.all([goLive(s.c), goLive(s.c)]);
    expect(rs.map(r => r.status).sort()).toEqual([200, 409]);
    expect(rs.find(r => r.status === 409)!.body.code).toBe('ALREADY_LIVE');
  });

  it('refuses while a step is PENDING and lists every failing step (422 ONBOARDING_NOT_READY)', async () => {
    const { c } = await setupSociety();
    const r = await goLive(c);
    expect([r.status, r.body.code]).toEqual([422, 'ONBOARDING_NOT_READY']);
    expect(r.body.errors.map((e: any) => e.field)).toEqual([
      'PROFILE',
      'STRUCTURE',
      'UNITS',
      'RESIDENTS',
      'BILLING',
      'PAYMENTS',
      'COMMITTEE',
    ]);
    expect(r.body.errors[0]).toEqual({ field: 'PROFILE', message: 'This step is not done yet' });
    expect(step(await get(c), 'GO_LIVE').status).toBe('PENDING');
  });

  it('US-08-08 re-runs the checks of the required steps: units that lost their area after the step was DONE block go-live', async () => {
    const s = await readySociety();
    await allButGoLive(s);
    await rawUnits(s.society.id!, s.b.id, 'A', 12, { floor: 2 });
    const r = await goLive(s.c);
    expect([r.status, r.body.code]).toEqual([422, 'ONBOARDING_NOT_READY']);
    expect(r.body.errors).toEqual([{ field: 'UNITS', message: '12 billable units have no area' }]);
    expect((await get(s.c)).isLive).toBe(false);
  });

  it('a skipped step is not re-checked; a required step that fails its owner check blocks go-live', async () => {
    const s = await readySociety();
    await allButGoLive(s);
    onboarding.registerCheck('RESIDENTS', 'residents', async () => ({
      done: false,
      summary: 'No owners linked yet',
    }));
    onboarding.registerCheck('BILLING', 'billing', async () => ({
      done: false,
      summary: 'The charge head was deleted',
    }));
    const r = await goLive(s.c);
    expect(r.body.errors).toEqual([{ field: 'BILLING', message: 'The charge head was deleted' }]);
  });

  it('T08-37 after go-live nothing can be reopened (INVALID_STATE) and nothing completed or skipped (ALREADY_LIVE)', async () => {
    const s = await readySociety();
    await allButGoLive(s);
    await goLive(s.c);
    const r = await reopen(s.c, 'RESIDENTS');
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
    expect((await reopen(s.c, 'PROFILE')).body.code).toBe('INVALID_STATE');
    expect((await complete(s.c, 'PROFILE')).body.code).toBe('ALREADY_LIVE');
    expect((await skip(s.c, 'RESIDENTS')).body.code).toBe('ALREADY_LIVE');
    expect((await get(s.c)).progressPercent).toBe(100);
  });

  it('the service API reports progress and whether the society is live', async () => {
    const s = await readySociety();
    expect(await onboarding.isLive(s.society.id!)).toBe(false);
    expect(await onboarding.progressPercent(s.society.id!)).toBe(0); // no rows yet
    await allButGoLive(s);
    await goLive(s.c);
    expect(await onboarding.isLive(s.society.id!)).toBe(true);
    expect(await onboarding.progressPercent(s.society.id!)).toBe(100);
    await sequelize.transaction(t => onboarding.ensureSteps(s.society.id!, t));
    expect(await OnboardingStep.count({ where: { societyId: s.society.id! } })).toBe(8);
  });
});
