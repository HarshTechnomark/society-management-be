import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  BillSplitRule,
  Invoice,
  BillingRun,
  ChargeHead,
  Society,
  Unit,
  UnitResident,
  closeDb,
} from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { systemCtx } from '../../../src/types/context';
import {
  billingPortCalls,
  placeholderApprovalTypes,
  setBillingPorts,
} from '../../../src/modules/billing/billing.ports';
import { approve, reject, requestChanges } from '../../../src/modules/billing/billing.runs.approvals-hook';
import { app } from '../../helpers/auth';
import { listRoutes } from '../../../src/modules/access-control/access-control.registry';
import { events } from '../../helpers/auth';
import { memberOf, rawUnits } from '../../helpers/society-setup';
import {
  addOwner,
  addTenant,
  createAndCompute,
  idemH,
  linkResident,
  makeResident,
  makeRule,
  makeSplitRule,
  resetRuns,
  runSociety,
  setSetting,
  standardRules,
  type RunSociety,
} from '../../helpers/billing-runs';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetRuns);

/** A society whose flats all have an owner and the standard rules; parking only for the first flat (example A). */
async function world(o: Parameters<typeof runSociety>[0] = {}) {
  const w = await runSociety(o);
  const owners = [];
  for (const u of w.units) owners.push(await addOwner(w.society.id!, u.id, `Owner of ${u.label}`));
  await standardRules(w.society.id!, w.heads, [w.units[0]!.id]);
  return { ...w, owners };
}

/** The context module 14 would hand to the callbacks: the deciding user in the society. */
const ctxOf = (w: RunSociety, userId: number) => ({
  ...systemCtx('t'),
  user: { id: userId, name: 'Decider', mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' },
  society: { id: w.society.id!, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
});

const items = async (w: RunSociety, runId: number, query: Record<string, string> = {}) =>
  (await w.c('get', `/billing/runs/${runId}/items`, undefined, { query: { limit: '100', ...query } })).body
    .data as any[];
const detail = async (w: RunSociety, runId: number) => (await w.c('get', `/billing/runs/${runId}`)).body.data;
const post = (w: RunSociety, path: string, body: Record<string, unknown>, idem = false) =>
  w.c('post', path, body, idem ? { headers: idemH() } : undefined);

describe('create a run (8.5, BR-11-24, BR-11-25, BR-11-33)', () => {
  it('creates a DRAFT run, computes it in the background and reaches PREVIEW with the worked example A', async () => {
    const w = await world();
    const r = await w.c(
      'post',
      '/billing/runs',
      { runType: 'REGULAR', periodStart: '2026-11-01' },
      { headers: idemH() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.message).toBe('Billing run created; computing');
    expect(r.body.data).toEqual({
      id: expect.any(Number),
      runLabel: 'BR-2026-11',
      runType: 'REGULAR',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      billDate: '2026-11-01',
      status: 'DRAFT',
      version: 1,
    });
    await drainQueues();
    const d = await detail(w, r.body.data.id);
    expect(d).toMatchObject({
      status: 'PREVIEW',
      cycle: 'MONTHLY',
      counts: { items: 2, ready: 2, exceptions: 0, excluded: 0, warnings: 0, skipped: 0, issued: 0 },
      subtotalPaise: 538_000 + 488_000,
      taxPaise: 0,
      roundOffPaise: 0,
      totalPaise: 1_026_000,
      previousRunTotalPaise: null,
      changePct: null,
      isStale: false,
      approvalRequestId: null,
      version: 2,
    });
    expect(d.byHead).toEqual([
      { headKey: 'MAINTENANCE', name: 'Maintenance', amountPaise: 736_000 },
      { headKey: 'SINKING_FUND', name: 'Sinking fund', amountPaise: 120_000 },
      { headKey: 'REPAIR_FUND', name: 'Repair fund', amountPaise: 50_000 },
      { headKey: 'PARKING', name: 'Parking', amountPaise: 50_000 },
      { headKey: 'WATER', name: 'Water', amountPaise: 70_000 },
    ]);
    expect(d.computedAt).toBe('2026-11-04T04:30:00.000Z');
    expect(d.previewHash).toMatch(/^[0-9a-f]{64}$/);
    const list = await items(w, r.body.data.id);
    const a = list.find(i => i.unitLabel === 'A-101');
    expect(a).toMatchObject({
      status: 'READY',
      totalPaise: 538_000,
      subtotalPaise: 538_000,
      itemKey: `${a.unitId}:${a.billToResidentId}`,
      billToRelation: 'OWNER',
      thresholdBasePaise: 503_000,
      gstApplied: false,
    });
    expect(a.lines.map((l: any) => [l.headKey, l.amountPaise])).toEqual([
      ['MAINTENANCE', 368_000],
      ['SINKING_FUND', 60_000],
      ['REPAIR_FUND', 25_000],
      ['PARKING', 50_000],
      ['WATER', 35_000],
    ]);
    expect(a.lines[0].computation).toMatchObject({ method: 'PER_SQFT', areaBasis: 'CARPET' });
    expect(list.find(i => i.unitLabel === 'A-102').totalPaise).toBe(488_000);
    expect(await AuditLog.count({ where: { action: 'billing.run.created' } })).toBe(1);
    expect(await AuditLog.count({ where: { action: 'billing.run.computed' } })).toBe(1);
    expect(events.filter(e => e.event === 'billing.run.updated').length).toBeGreaterThan(2);
    expect(events.find(e => e.event === 'billing.run.updated')!.room).toBe(`society:${w.society.id}:finance`);
  });

  it('needs an Idempotency-Key, validates strictly, and replays the same key', async () => {
    const w = await world();
    const none = await w.c('post', '/billing/runs', { runType: 'REGULAR', periodStart: '2026-11-01' });
    expect([none.status, none.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const bad = await w.c(
      'post',
      '/billing/runs',
      { runType: 'REGULAR', periodStart: '2026-11-31', extra: 1 },
      { headers: idemH() },
    );
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: any) => e.field).sort()).toEqual(['extra', 'periodStart']);
    const key = idemH();
    const a = await w.c(
      'post',
      '/billing/runs',
      { runType: 'REGULAR', periodStart: '2026-11-01' },
      { headers: key },
    );
    const b = await w.c(
      'post',
      '/billing/runs',
      { runType: 'REGULAR', periodStart: '2026-11-01' },
      { headers: key },
    );
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await BillingRun.count({ where: { societyId: w.society.id! } })).toBe(1);
    const reused = await w.c(
      'post',
      '/billing/runs',
      { runType: 'REGULAR', periodStart: '2026-10-01' },
      { headers: key },
    );
    expect([reused.status, reused.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
  });

  it('period rules: misaligned, too old, too far, before billing start, scope of a regular run', async () => {
    const w = await world();
    const mk = (b: Record<string, unknown>) =>
      w.c('post', '/billing/runs', { runType: 'REGULAR', ...b }, { headers: idemH() });
    expect((await mk({ periodStart: '2026-11-02' })).body.code).toBe('RUN_PERIOD_INVALID');
    expect((await mk({ periodStart: '2025-10-01' })).body.code).toBe('RUN_PERIOD_INVALID');
    const far = await mk({ periodStart: '2027-01-01' });
    expect([far.status, far.body.code]).toEqual([422, 'RUN_PERIOD_TOO_FAR']);
    expect((await mk({ periodStart: '2026-11-01', scopeType: 'UNITS', scopeValues: [1] })).status).toBe(400);
    const dec = await mk({ periodStart: '2026-12-01' }); // one period ahead is allowed
    expect(dec.status, JSON.stringify(dec.body)).toBe(201);
    await drainQueues();
    expect((await mk({ periodStart: '2026-10-01' })).body.code).toBe('RUN_PERIOD_INVALID'); // before the billing start (Dec)
  });

  it('T11-17 two regular runs for the same period at once: one is created, the other is RUN_PERIOD_EXISTS', async () => {
    const w = await world();
    const [a, b] = await Promise.all([
      w.c('post', '/billing/runs', { runType: 'REGULAR', periodStart: '2026-11-01' }, { headers: idemH() }),
      w.c('post', '/billing/runs', { runType: 'REGULAR', periodStart: '2026-11-01' }, { headers: idemH() }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find(x => x.status === 409)!.body.code).toBe('RUN_PERIOD_EXISTS');
    await drainQueues();
    expect(await BillingRun.count({ where: { societyId: w.society.id! } })).toBe(1);
  });

  it('a cancelled run frees the period; an issued run blocks it and any overlapping period', async () => {
    const w = await world();
    const a = await createAndCompute(w.c);
    const c = await post(w, `/billing/runs/${a.id}/cancel`, { reason: 'Wrong rates', version: 2 });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.data.status).toBe('CANCELLED');
    expect((await BillingRun.findByPk(a.id))!.activeKey).toBeNull();
    const b = await createAndCompute(w.c);
    expect(b.status).toBe(201);
    await BillingRun.update({ status: 'ISSUED' } as never, { where: { id: b.id } });
    const again = await w.c(
      'post',
      '/billing/runs',
      { runType: 'REGULAR', periodStart: '2026-11-01' },
      { headers: idemH() },
    );
    expect([again.status, again.body.code]).toEqual([409, 'RUN_PERIOD_EXISTS']);
  });

  it('supplementary runs need BUILDINGS or UNITS and the society’s own ids', async () => {
    const starter = await runSociety({ plan: 'STARTER' });
    const w = await world();
    const mk = (b: Record<string, unknown>) =>
      w.c(
        'post',
        '/billing/runs',
        { runType: 'SUPPLEMENTARY', periodStart: '2026-11-01', ...b },
        { headers: idemH() },
      );
    expect((await mk({})).status).toBe(400);
    expect((await mk({ scopeType: 'ALL_UNITS' })).status).toBe(400);
    expect((await mk({ scopeType: 'UNITS', scopeValues: [starter.units[0]!.id] })).status).toBe(400); // another society's flat
    const ok = await mk({ scopeType: 'UNITS', scopeValues: [w.units[0]!.id] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.runLabel).toBe('BR-2026-11-S1');
    const second = await mk({ scopeType: 'BUILDINGS', scopeValues: [w.buildingId] });
    expect(second.body.data.runLabel).toBe('BR-2026-11-S2');
    await drainQueues();
    const list = await items(w, ok.body.data.id);
    expect(list.map(i => i.unitLabel)).toEqual(['A-101']);
  });

  it('a supplementary run flags a flat and party that already have a bill (ALREADY_BILLED)', async () => {
    const w = await world();
    const { resident } = w.owners[0]!;
    await Invoice.create({
      societyId: w.society.id!,
      invoiceNo: 'INV/2026-27/000001',
      financialYear: '2026-27',
      invoiceType: 'REGULAR',
      billingRunId: null,
      dedupeKey: `REG:${w.units[0]!.id}:2026-11-01:${resident.id}`,
      unitId: w.units[0]!.id,
      unitLabel: 'A-101',
      billToResidentId: resident.id!,
      billToRelation: 'OWNER',
      billToName: 'x',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      invoiceDate: '2026-11-01',
      dueDate: '2026-11-10',
      totalPaise: 100,
      outstandingPaise: 100,
      subtotalPaise: 100,
      issuedAt: new Date(),
      version: 1,
    } as never);
    const r = await w.c(
      'post',
      '/billing/runs',
      {
        runType: 'SUPPLEMENTARY',
        periodStart: '2026-11-01',
        scopeType: 'UNITS',
        scopeValues: [w.units[0]!.id],
      },
      { headers: idemH() },
    );
    await drainQueues();
    const list = await items(w, r.body.data.id);
    expect(list[0]).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'ALREADY_BILLED' });
  });
});

describe('exceptions, exclusion and publish (8.8, 8.9, BR-11-34, BR-11-35)', () => {
  async function withException() {
    const w = await world();
    await Unit.update({ areaSqft: null } as never, { where: { id: w.units[1]!.id } });
    const run = await createAndCompute(w.c);
    return { w, run };
  }

  it('T11-18 a flat without area is an EXCEPTION item; publish is refused until it is excluded', async () => {
    const { w, run } = await withException();
    const d = await detail(w, run.id);
    expect(d.counts).toMatchObject({ items: 2, ready: 1, exceptions: 1 });
    const ex = (await items(w, run.id, { status: 'EXCEPTION' }))[0];
    expect(ex).toMatchObject({
      unitLabel: 'A-102',
      exceptionCode: 'MISSING_AREA',
      itemKey: `${ex.unitId}:0`,
      lines: [],
      totalPaise: 0,
    });
    expect(ex.exceptionMessage).toContain('no area');
    const pub = await post(
      w,
      `/billing/runs/${run.id}/publish`,
      { confirmLabel: 'BR-2026-11', version: d.version },
      true,
    );
    expect([pub.status, pub.body.code]).toEqual([422, 'RUN_HAS_EXCEPTIONS']);

    const short = await post(w, `/billing/runs/${run.id}/items/${ex.id}/exclude`, {
      reason: 'no',
      version: ex.version,
    });
    expect(short.status).toBe(400);
    const exc = await post(w, `/billing/runs/${run.id}/items/${ex.id}/exclude`, {
      reason: 'Flat not yet measured',
      version: ex.version,
    });
    expect(exc.status, JSON.stringify(exc.body)).toBe(200);
    expect(exc.body.data.item).toMatchObject({
      status: 'EXCLUDED',
      excludedReason: 'Flat not yet measured',
      version: 2,
    });
    expect(exc.body.data.run.counts).toMatchObject({ exceptions: 0, excluded: 1, ready: 1 });
    const inc = await post(w, `/billing/runs/${run.id}/items/${ex.id}/include`, { version: 2 });
    expect([inc.status, inc.body.code]).toEqual([409, 'INVALID_STATE']); // an exception must be fixed and recomputed
    const d2 = await detail(w, run.id);
    const ok = await post(
      w,
      `/billing/runs/${run.id}/publish`,
      { confirmLabel: 'BR-2026-11', version: d2.version },
      true,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('PENDING_APPROVAL');
    expect(await AuditLog.count({ where: { action: 'billing.run_item.excluded' } })).toBe(1);
  });

  it('fixing the area and recomputing clears the exception', async () => {
    const { w, run } = await withException();
    await Unit.update({ areaSqft: '1150.000' } as never, { where: { id: w.units[1]!.id } });
    const d = await detail(w, run.id);
    const r = await post(w, `/billing/runs/${run.id}/recompute`, { version: d.version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('DRAFT');
    await drainQueues();
    expect((await detail(w, run.id)).counts).toMatchObject({ ready: 2, exceptions: 0 });
  });

  it('exclude and include a READY flat recalculates the totals; only in PREVIEW; stale item version', async () => {
    const w = await world();
    const run = await createAndCompute(w.c);
    const [a, b] = await items(w, run.id);
    const exc = await post(w, `/billing/runs/${run.id}/items/${a.id}/exclude`, {
      reason: 'Disputed flat',
      version: a.version,
    });
    expect(exc.body.data.run.totalPaise).toBe(b.totalPaise);
    const stale = await post(w, `/billing/runs/${run.id}/items/${a.id}/include`, { version: 1 });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const inc = await post(w, `/billing/runs/${run.id}/items/${a.id}/include`, { version: 2 });
    expect(inc.body.data.item.status).toBe('READY');
    expect(inc.body.data.run.totalPaise).toBe(a.totalPaise + b.totalPaise);
    expect(await AuditLog.count({ where: { action: 'billing.run_item.included' } })).toBe(1);
    await BillingRun.update({ status: 'PENDING_APPROVAL' } as never, { where: { id: run.id } });
    const no = await post(w, `/billing/runs/${run.id}/items/${a.id}/exclude`, {
      reason: 'Too late now',
      version: 3,
    });
    expect([no.status, no.body.code]).toEqual([409, 'INVALID_STATE']);
    const other = await post(w, `/billing/runs/${run.id}/items/999999/exclude`, {
      reason: 'Whatever it is',
      version: 1,
    });
    expect([other.status, other.body.code]).toEqual([404, 'RUN_ITEM_NOT_FOUND']);
  });

  it('a zero-rate UNITS rule exempts the flat: no line, item EXCLUDED with ZERO_TOTAL that cannot be included', async () => {
    const w = await runSociety({ flats: 1 });
    await addOwner(w.society.id!, w.units[0]!.id);
    await makeRule(w.society.id!, w.heads.WATER!, { rateType: 'FLAT_PER_UNIT', amountPaise: 35_000 });
    await makeRule(
      w.society.id!,
      w.heads.WATER!,
      { rateType: 'FLAT_PER_UNIT', amountPaise: 0 },
      { scopeType: 'UNITS', scopeValues: [w.units[0]!.id] },
    );
    const run = await createAndCompute(w.c);
    const [i] = await items(w, run.id);
    expect(i).toMatchObject({ status: 'EXCLUDED', excludedReason: 'ZERO_TOTAL', totalPaise: 0 });
    await post(w, `/billing/runs/${run.id}/items/${i.id}/exclude`, {
      reason: 'Already excluded',
      version: 1,
    }).then(r => expect(r.status).toBe(409));
    const inc = await post(w, `/billing/runs/${run.id}/items/${i.id}/include`, { version: 1 });
    expect([inc.status, inc.body.code]).toEqual([409, 'INVALID_STATE']);
    const d = await detail(w, run.id);
    const empty = await post(
      w,
      `/billing/runs/${run.id}/publish`,
      { confirmLabel: 'BR-2026-11', version: d.version },
      true,
    );
    expect([empty.status, empty.body.code]).toEqual([422, 'RUN_EMPTY']);
  });

  it('publish checks: label, version, state, staleness (T11-19), preview hash and the sac code of taxed heads', async () => {
    const w = await world();
    const run = await createAndCompute(w.c);
    const d = await detail(w, run.id);
    const pub = (b: Record<string, unknown>) =>
      post(
        w,
        `/billing/runs/${run.id}/publish`,
        { version: d.version, confirmLabel: 'BR-2026-11', ...b },
        true,
      );
    expect((await pub({ confirmLabel: 'BR-2026-10' })).body.code).toBe('RUN_CONFIRM_MISMATCH');
    expect((await pub({ version: 1 })).body.code).toBe('STALE_VERSION');
    expect((await pub({ previewHash: 'a'.repeat(64) })).body.code).toBe('RUN_STALE');
    // a rule changed after the compute: the run is stale
    await BillingRun.update({ computedAt: new Date('2000-01-01') } as never, { where: { id: run.id } });
    expect((await detail(w, run.id)).isStale).toBe(true);
    const stale = await pub({});
    expect([stale.status, stale.body.code]).toEqual([409, 'RUN_STALE']);
    const re = await post(w, `/billing/runs/${run.id}/recompute`, { version: d.version });
    await drainQueues();
    const d2 = await detail(w, run.id);
    expect(d2.isStale).toBe(false);
    const ok = await post(
      w,
      `/billing/runs/${run.id}/publish`,
      { version: d2.version, confirmLabel: 'BR-2026-11', previewHash: d2.previewHash },
      true,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(re.status).toBe(200);
    // not in PREVIEW any more
    const again = await post(
      w,
      `/billing/runs/${run.id}/publish`,
      { version: ok.body.data.version, confirmLabel: 'BR-2026-11' },
      true,
    );
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('a taxed head without a SAC code is GST_SETTINGS_INVALID at publish (BR-11-32)', async () => {
    const w = await world({ flats: 1 });
    await Society.update({ gstin: '27AAAAG1234C1ZE' } as never, { where: { id: w.society.id! } });
    await setSetting(w.society.id!, 'billing.applyGst', true);
    const club = await ChargeHead.create({
      societyId: w.society.id!,
      key: 'CLUB',
      name: 'Club',
      headType: 'OTHER',
      payerRouting: 'BILL_TO',
      gstTreatment: 'THRESHOLD',
      sacCode: null,
      prorate: true,
      interestBearing: true,
      ledgerAccountCode: '4190',
      isSystem: false,
      status: 'ACTIVE',
      sortOrder: 80,
      version: 1,
    } as never);
    await makeRule(w.society.id!, club, { rateType: 'FLAT_PER_UNIT', amountPaise: 500_000 });
    const run = await createAndCompute(w.c);
    const d = await detail(w, run.id);
    expect(d.taxPaise).toBeGreaterThan(0);
    const r = await post(
      w,
      `/billing/runs/${run.id}/publish`,
      { confirmLabel: 'BR-2026-11', version: d.version },
      true,
    );
    expect([r.status, r.body.code]).toEqual([422, 'GST_SETTINGS_INVALID']);
  });
});

describe('approval and the placeholder module 14 (BR-11-35, BR-11-36)', () => {
  async function preview() {
    const w = await world();
    const run = await createAndCompute(w.c);
    const d = await detail(w, run.id);
    return { w, run, d };
  }
  const publish = (w: RunSociety, id: number, version: number, c = w.c) =>
    c('post', `/billing/runs/${id}/publish`, { confirmLabel: 'BR-2026-11', version }, { headers: idemH() });

  it('publish requests BILLING_RUN_PUBLISH through the approvals port and waits in PENDING_APPROVAL', async () => {
    const { w, run, d } = await preview();
    const r = await publish(w, run.id, d.version);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'PENDING_APPROVAL', approvalRequestId: expect.any(Number) });
    const call = billingPortCalls.find(c => c.fn === 'approvals.request')!;
    expect(call.input).toMatchObject({
      type: 'BILLING_RUN_PUBLISH',
      entityType: 'billing_run',
      entityId: run.id,
      title: 'Billing run Nov 2026 · 2 flats',
      amountPaise: 1_026_000,
      payload: { periodStart: '2026-11-01', readyCount: 2, exceptionCount: 0, totalPaise: 1_026_000 },
    });
    expect(await AuditLog.count({ where: { action: 'billing.run.publish_requested' } })).toBe(1);
    const row = await BillingRun.findByPk(run.id);
    expect(row!.publishedBy).toBe(w.user.id);
  });

  it('T11-20 the publisher cannot approve; another member approves and a future bill date waits in APPROVED (T11-21)', async () => {
    const w = await world();
    await setSetting(w.society.id!, 'billing.billingDay', 10);
    const run = await createAndCompute(w.c);
    const d = await detail(w, run.id);
    const p = await publish(w, run.id, d.version);
    const id = p.body.data.approvalRequestId;
    await expect(approve(id, ctxOf(w, w.user.id!))).rejects.toMatchObject({
      status: 409,
      code: 'MAKER_CHECKER_VIOLATION',
    });
    expect((await detail(w, run.id)).status).toBe('PENDING_APPROVAL');
    const ok = await approve(id, ctxOf(w, w.treasurer.user.id!));
    expect(ok).toMatchObject({ status: 'APPROVED', type: 'BILLING_RUN_PUBLISH', entityId: run.id });
    const row = (await BillingRun.findByPk(run.id))!;
    expect(row).toMatchObject({ status: 'APPROVED', approvedBy: w.treasurer.user.id, issueStartedAt: null });
    expect(await approve(id, ctxOf(w, w.treasurer.user.id!))).toMatchObject({ status: 'APPROVED' }); // a second call changes nothing
    await drainQueues();
    expect((await BillingRun.findByPk(run.id))!.status).toBe('APPROVED');
  });

  it('reject returns the run to PREVIEW and it can be published again', async () => {
    const { w, run, d } = await preview();
    const p = await publish(w, run.id, d.version);
    const id = p.body.data.approvalRequestId;
    const rej = await reject(id, 'Rates look wrong', ctxOf(w, w.treasurer.user.id!));
    expect(rej.status).toBe('REJECTED');
    const after = await detail(w, run.id);
    expect(after).toMatchObject({ status: 'PREVIEW', approvalRequestId: null });
    expect(await AuditLog.count({ where: { action: 'billing.run.rejected' } })).toBe(1);
    const again = await publish(w, run.id, after.version);
    expect(again.body.data.status).toBe('PENDING_APPROVAL');
  });

  it('changes requested keeps the request: the requester resubmits, another user cancels and requests again', async () => {
    const { w, run, d } = await preview();
    const p = await publish(w, run.id, d.version);
    const id = p.body.data.approvalRequestId;
    const ctx = ctxOf(w, w.treasurer.user.id!);
    await requestChanges(id, ctx);
    const back = await detail(w, run.id);
    expect(back).toMatchObject({ status: 'PREVIEW', approvalRequestId: id });
    const re = await publish(w, run.id, back.version);
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body.data.approvalRequestId).toBe(id);
    expect(billingPortCalls.some(c => c.fn === 'approvals.resubmit')).toBe(true);
    await requestChanges(id, ctx);
    const b2 = await detail(w, run.id);
    const other = await publish(w, run.id, b2.version, w.treasurer.c);
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect(other.body.data.approvalRequestId).not.toBe(id);
    expect(billingPortCalls.find(c => c.fn === 'approvals.cancel')!.input).toMatchObject({
      id,
      reason: 'Republished by another user',
    });
  });

  it('module 14 auto-approval inside the publish transaction moves the run to APPROVED (bill date in the future)', async () => {
    const w = await world();
    await setSetting(w.society.id!, 'billing.billingDay', 10);
    setBillingPorts({ approvals: { request: async () => ({ id: 77, status: 'APPROVED' }) } });
    const run = await createAndCompute(w.c);
    const d = await detail(w, run.id);
    expect(d.billDate).toBe('2026-11-10');
    const r = await publish(w, run.id, d.version);
    expect(r.body.data).toMatchObject({ status: 'APPROVED', approvalRequestId: 77 });
    expect((await BillingRun.findByPk(run.id))!.approvedBy).toBe(w.user.id);
    expect(await AuditLog.count({ where: { action: 'billing.run.approved' } })).toBe(1);
  });

  it('describe returns the facts of the run for the approvals inbox', async () => {
    const { w, run, d } = await preview();
    await publish(w, run.id, d.version);
    const facts = await placeholderApprovalTypes.get('BILLING_RUN_PUBLISH')!.describe(run.id);
    expect(facts.map(f => f.label)).toEqual([
      'Period',
      'Flats',
      'Total billed',
      'Exceptions',
      'Change vs last month',
    ]);
    expect(facts.find(f => f.label === 'Total billed')!.value).toBe('₹10,260');
  });
});

describe('state machine: patch, recompute, cancel (8.7, 8.10, T11-46)', () => {
  it('PATCH changes the notes, goes back to DRAFT, recomputes and bumps the version', async () => {
    const w = await world();
    const run = await createAndCompute(w.c);
    const d = await detail(w, run.id);
    const r = await w.c('patch', `/billing/runs/${run.id}`, { notes: 'Festival month', version: d.version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'DRAFT', version: d.version + 1 });
    await drainQueues();
    const after = await detail(w, run.id);
    expect(after).toMatchObject({ status: 'PREVIEW', notes: 'Festival month', version: d.version + 2 });
    expect(await AuditLog.count({ where: { action: 'billing.run.updated' } })).toBe(1);
    const stale = await w.c('patch', `/billing/runs/${run.id}`, { notes: 'x', version: d.version });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const strict = await w.c('patch', `/billing/runs/${run.id}`, {
      runType: 'REGULAR',
      version: after.version,
    });
    expect(strict.status).toBe(400);
  });

  it('recompute and cancel are refused in the wrong state; cancel needs finance.billing.edit', async () => {
    const w = await world();
    const run = await createAndCompute(w.c);
    for (const status of ['PENDING_APPROVAL', 'APPROVED', 'ISSUING', 'ISSUED', 'CANCELLED']) {
      await BillingRun.update({ status } as never, { where: { id: run.id } });
      const v = (await BillingRun.findByPk(run.id))!.version;
      const rc = await post(w, `/billing/runs/${run.id}/recompute`, { version: v });
      expect([status, rc.status, rc.body.code]).toEqual([status, 409, 'INVALID_STATE']);
      const cn = await post(w, `/billing/runs/${run.id}/cancel`, { reason: 'Changed my mind', version: v });
      expect([status, cn.status, cn.body.code]).toEqual([status, 409, 'INVALID_STATE']);
    }
    await BillingRun.update({ status: 'FAILED' } as never, { where: { id: run.id } });
    const v = (await BillingRun.findByPk(run.id))!.version;
    const sec = await memberOf(w.society, 'accountant'); // V C E X I: may cancel
    const cn = await sec.c('post', `/billing/runs/${run.id}/cancel`, {
      reason: 'Changed my mind',
      version: v,
    });
    expect(cn.status, JSON.stringify(cn.body)).toBe(200);
    const denied = await w.secretary.c('post', `/billing/runs/${run.id}/cancel`, {
      reason: 'Changed my mind',
      version: v + 1,
    });
    expect(denied.status).toBe(403);
  });

  it('SPLIT_NO_ELIGIBLE_UNITS fails the run with the message; a recompute from FAILED works once fixed', async () => {
    const w = await world();
    const split = await makeSplitRule(w.society.id!, {
      basis: 'CUSTOM_WEIGHT',
      amountSource: 'FIXED',
      fixedAmountPaise: 100_000,
      weights: {},
    });
    const lift = await ChargeHead.create({
      societyId: w.society.id!,
      key: 'LIFT',
      name: 'Lift AMC',
      headType: 'SERVICE',
      payerRouting: 'BILL_TO',
      gstTreatment: 'NONE',
      sacCode: null,
      prorate: false,
      interestBearing: true,
      ledgerAccountCode: '4180',
      isSystem: false,
      status: 'ACTIVE',
      sortOrder: 70,
      version: 1,
    } as never);
    await makeRule(w.society.id!, lift, { rateType: 'SPLIT_TOTAL', billSplitRuleId: split.id! });
    const run = await createAndCompute(w.c);
    const d = await detail(w, run.id);
    expect(d).toMatchObject({ status: 'FAILED' });
    expect(d.computeError).toContain('No flat is eligible');
    expect(await AuditLog.count({ where: { action: 'billing.run.failed' } })).toBe(1);
    expect(
      billingPortCalls.some(
        c => c.fn === 'notifications.send' && (c.input as any).template === 'billing.run_failed',
      ),
    ).toBe(true);
    await BillSplitRule.update({ basis: 'EQUAL' } as never, { where: { id: split.id! } });
    const r = await post(w, `/billing/runs/${run.id}/recompute`, { version: d.version });
    expect(r.status).toBe(200);
    await drainQueues();
    const after = await detail(w, run.id);
    expect(after.status).toBe('PREVIEW');
    expect(after.byHead.find((h: any) => h.headKey === 'LIFT').amountPaise).toBe(100_000);
  });
});

describe('reads (8.6)', () => {
  it('lists runs with filters and sorting, and items with filters, search and sorting', async () => {
    const w = await world({ flats: 3 });
    const a = await createAndCompute(w.c);
    await Unit.update({ areaSqft: null } as never, { where: { id: w.units[2]!.id } });
    await post(w, `/billing/runs/${a.id}/recompute`, { version: 2 });
    await drainQueues();
    const list = await w.c('get', '/billing/runs', undefined, {
      query: { status: 'PREVIEW', runType: 'REGULAR', sortBy: 'totalPaise', sortOrder: 'asc' },
    });
    expect(list.status).toBe(200);
    expect(list.body.pagination).toMatchObject({ page: 1, limit: 20, total: 1 });
    expect(list.body.data[0]).toMatchObject({ runLabel: 'BR-2026-11', counts: { items: 3, exceptions: 1 } });
    expect((await w.c('get', '/billing/runs', undefined, { query: { status: 'ISSUED' } })).body.data).toEqual(
      [],
    );
    expect(
      (await w.c('get', '/billing/runs', undefined, { query: { periodFrom: '2026-12-01' } })).body.data,
    ).toEqual([]);
    expect((await w.c('get', '/billing/runs', undefined, { query: { sortBy: 'nope' } })).status).toBe(400);
    const byStatus = await items(w, a.id, { status: 'READY', sortBy: 'totalPaise', sortOrder: 'desc' });
    expect(byStatus.map(i => i.unitLabel)).toEqual(['A-101', 'A-102']);
    expect((await items(w, a.id, { exceptionCode: 'MISSING_AREA' })).map(i => i.unitLabel)).toEqual([
      'A-103',
    ]);
    expect((await items(w, a.id, { q: 'A-10' })).length).toBe(3);
    expect((await items(w, a.id, { q: 'Owner of A-102' })).map(i => i.unitLabel)).toEqual(['A-102']);
    expect((await items(w, a.id, { warningCode: 'PRORATED' })).length).toBe(0);
    const page = await w.c('get', `/billing/runs/${a.id}/items`, undefined, {
      query: { limit: '2', page: '2' },
    });
    expect(page.body.data.length).toBe(1);
    expect(page.body.pagination).toMatchObject({ total: 3, totalPages: 2 });
    expect((await w.c('get', '/billing/runs/999999')).body.code).toBe('RUN_NOT_FOUND');
  });

  it('the explanation of a line is only returned with billing.explain_my_bill (Starter has none)', async () => {
    const starter = await world({ plan: 'STARTER', flats: 1 });
    const run = await createAndCompute(starter.c);
    const [i] = await items(starter, run.id);
    expect(i.lines[0]).not.toHaveProperty('computation');
    expect(i.lines[0]).not.toHaveProperty('sacCode');
    const w = await world({ flats: 1 });
    const r2 = await createAndCompute(w.c);
    expect((await items(w, r2.id))[0].lines[0]).toHaveProperty('computation');
  });

  it('variance against the previous bill and run (BR-11-29): LARGE_VARIANCE above 25 percent, none without the plan feature', async () => {
    const w = await world({ flats: 1 });
    const owner = w.owners[0]!.resident;
    const prior = async (total: number) =>
      Invoice.create({
        societyId: w.society.id!,
        invoiceNo: 'INV/2026-27/000010',
        financialYear: '2026-27',
        invoiceType: 'REGULAR',
        billingRunId: null,
        dedupeKey: `REG:${w.units[0]!.id}:2026-10-01:${owner.id}`,
        unitId: w.units[0]!.id,
        unitLabel: 'A-101',
        billToResidentId: owner.id!,
        billToRelation: 'OWNER',
        billToName: 'x',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        invoiceDate: '2026-10-01',
        dueDate: '2026-10-10',
        totalPaise: total,
        outstandingPaise: total,
        subtotalPaise: total,
        issuedAt: new Date(),
        version: 1,
      } as never);
    await prior(400_000);
    await BillingRun.create({
      societyId: w.society.id!,
      runLabel: 'BR-2026-10',
      runType: 'REGULAR',
      cycle: 'MONTHLY',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      billDate: '2026-10-01',
      scopeType: 'ALL_UNITS',
      status: 'ISSUED',
      activeKey: 'REG:2026-10-01',
      totalPaise: 400_000,
      version: 1,
    } as never);
    const run = await createAndCompute(w.c);
    const d = await detail(w, run.id);
    // the flat has parking: 538,000 against 400,000
    expect(d).toMatchObject({ previousRunTotalPaise: 400_000, changePct: '34.5000' });
    const [i] = await items(w, run.id);
    expect(i).toMatchObject({
      previousTotalPaise: 400_000,
      variancePct: '34.5000',
      warningCodes: 'LARGE_VARIANCE',
    });
    expect((await detail(w, run.id)).counts.warnings).toBe(1);
    expect((await items(w, run.id, { warningCode: 'LARGE_VARIANCE' })).length).toBe(1);
  });
});

describe('worked examples through the engine (6.7 B, C, D)', () => {
  it('B: GST on the whole 823,000: CGST 74,070, SGST 74,070, round-off -40, total 1,006,100', async () => {
    const w = await runSociety({ flats: 1, area: '2150.000' });
    await addOwner(w.society.id!, w.units[0]!.id);
    await standardRules(w.society.id!, w.heads, [w.units[0]!.id]);
    await Society.update({ gstin: '27AAAAG1234C1ZE' } as never, { where: { id: w.society.id! } });
    await setSetting(w.society.id!, 'billing.applyGst', true);
    const run = await createAndCompute(w.c);
    const [i] = await items(w, run.id);
    expect(i).toMatchObject({
      subtotalPaise: 858_000,
      taxPaise: 148_140,
      roundOffPaise: -40,
      totalPaise: 1_006_100,
      thresholdBasePaise: 823_000,
      gstApplied: true,
    });
    expect(i.lines.map((l: any) => [l.lineKind, l.amountPaise])).toEqual([
      ['CHARGE', 688_000],
      ['CHARGE', 60_000],
      ['CHARGE', 25_000],
      ['CHARGE', 50_000],
      ['CHARGE', 35_000],
      ['CGST', 74_070],
      ['SGST', 74_070],
      ['ROUND_OFF', -40],
    ]);
    const d = await detail(w, run.id);
    expect(d).toMatchObject({
      subtotalPaise: 858_000,
      taxPaise: 148_140,
      roundOffPaise: -40,
      totalPaise: 1_006_100,
    });
  });

  it('C / T11-24: a let-out flat with a tenant who pays gets two items that add up to the unsplit total', async () => {
    const w = await runSociety({ flats: 1 });
    const unit = w.units[0]!.id;
    const { resident } = await addOwner(w.society.id!, unit, 'Landlord');
    const { tenant } = await addTenant(w.society.id!, unit, resident.id!, {
      from: '2026-01-01',
      name: 'Tenant Neha',
    });
    await standardRules(w.society.id!, w.heads, [unit]);
    await makeRule(w.society.id!, w.heads.NOC!, {
      rateType: 'PERCENT_OF_HEADS',
      percent: '10.0000',
      baseChargeHeadIds: [w.heads.MAINTENANCE!.id!],
    });
    const run = await createAndCompute(w.c);
    const list = await items(w, run.id);
    expect(list).toHaveLength(2);
    const t = list.find(i => i.billToResidentId === tenant.id)!;
    const o = list.find(i => i.billToResidentId === resident.id)!;
    expect([t.billToRelation, t.totalPaise, o.billToRelation, o.totalPaise]).toEqual([
      'TENANT',
      453_000,
      'OWNER',
      121_800,
    ]);
    expect(t.lines.map((l: any) => l.headKey)).toEqual(['MAINTENANCE', 'PARKING', 'WATER']);
    expect(o.lines.map((l: any) => [l.headKey, l.amountPaise])).toEqual([
      ['SINKING_FUND', 60_000],
      ['REPAIR_FUND', 25_000],
      ['NOC', 36_800],
    ]);
    expect(t.totalPaise + o.totalPaise).toBe(574_800);
  });

  it('D: possession on 12 November bills 19 of 30 days and warns PRORATED', async () => {
    const w = await runSociety({ flats: 1 });
    await Unit.update({ possessionDate: '2026-11-12' } as never, { where: { id: w.units[0]!.id } });
    await addOwner(w.society.id!, w.units[0]!.id);
    await standardRules(w.society.id!, w.heads);
    const run = await createAndCompute(w.c);
    const [i] = await items(w, run.id);
    expect(i.lines[0]).toMatchObject({
      headKey: 'MAINTENANCE',
      amountPaise: 233_067,
      prorationDays: 19,
      periodDays: 30,
      periodFrom: '2026-11-12',
      periodTo: '2026-11-30',
    });
    expect(i.lines[1]).toMatchObject({ headKey: 'SINKING_FUND', amountPaise: 38_000 });
    expect(i.warningCodes).toBe('PRORATED');
    expect(i.thresholdBasePaise).toBe(368_000 + 60_000 + 25_000);
  });

  it('ownership change on 12 November: the old and the new owner each get an invoice for their days', async () => {
    const w = await runSociety({ flats: 1 });
    const unit = w.units[0]!.id;
    const old = await makeResident(w.society.id!, 'Old owner');
    await linkResident(w.society.id!, unit, old.id!, { to: '2026-11-11' });
    const next = await makeResident(w.society.id!, 'New owner');
    await linkResident(w.society.id!, unit, next.id!, { from: '2026-11-12' });
    await makeRule(w.society.id!, w.heads.MAINTENANCE!, { rateType: 'PER_SQFT', ratePerSqftPaise: 320 });
    const run = await createAndCompute(w.c);
    const list = await items(w, run.id);
    expect(list.map(i => [i.billToResidentId, i.lines[0].amountPaise]).sort()).toEqual(
      [
        [old.id, 134_933],
        [next.id, 233_067],
      ].sort(),
    );
    expect(134_933 + 233_067).toBe(368_000);
  });

  it('tenant moves in on 16 November and the tenancy says the tenant pays: BILL_TO heads split by days', async () => {
    const w = await runSociety({ flats: 1 });
    const unit = w.units[0]!.id;
    const { resident } = await addOwner(w.society.id!, unit);
    const { tenant } = await addTenant(w.society.id!, unit, resident.id!, { from: '2026-11-16' });
    await makeRule(w.society.id!, w.heads.MAINTENANCE!, { rateType: 'PER_SQFT', ratePerSqftPaise: 320 });
    await makeRule(w.society.id!, w.heads.SINKING_FUND!, { rateType: 'FLAT_PER_UNIT', amountPaise: 60_000 });
    const run = await createAndCompute(w.c);
    const list = await items(w, run.id);
    const o = list.find(i => i.billToResidentId === resident.id)!;
    const t = list.find(i => i.billToResidentId === tenant.id)!;
    expect(o.lines.map((l: any) => [l.headKey, l.amountPaise])).toEqual([
      ['MAINTENANCE', 184_000],
      ['SINKING_FUND', 60_000],
    ]);
    expect(t.lines.map((l: any) => [l.headKey, l.amountPaise])).toEqual([['MAINTENANCE', 184_000]]);
  });

  it('flats with no owner on any day are skipped and counted; a flat without a rule match has no items', async () => {
    const w = await world({ flats: 2 });
    await UnitResident.destroy({ where: { societyId: w.society.id!, unitId: w.units[1]!.id } });
    const run = await createAndCompute(w.c);
    expect((await detail(w, run.id)).counts).toMatchObject({ items: 1, skipped: 1 });
  });

  it('a split rule with RUN_INPUT needs the amount; with it the shares add up exactly (example E)', async () => {
    const w = await runSociety({ flats: 3 });
    await Unit.update({ areaSqft: '700.000' } as never, { where: { id: w.units[2]!.id } });
    for (const u of w.units) await addOwner(w.society.id!, u.id);
    const split = await makeSplitRule(w.society.id!, { basis: 'AREA', amountSource: 'RUN_INPUT' });
    const lift = await ChargeHead.create({
      societyId: w.society.id!,
      key: 'LIFT',
      name: 'Lift AMC',
      headType: 'SERVICE',
      payerRouting: 'BILL_TO',
      gstTreatment: 'NONE',
      sacCode: null,
      prorate: false,
      interestBearing: true,
      ledgerAccountCode: '4180',
      isSystem: false,
      status: 'ACTIVE',
      sortOrder: 70,
      version: 1,
    } as never);
    await makeRule(w.society.id!, lift, { rateType: 'SPLIT_TOTAL', billSplitRuleId: split.id! });
    const miss = await w.c(
      'post',
      '/billing/runs',
      { runType: 'REGULAR', periodStart: '2026-11-01' },
      { headers: idemH() },
    );
    expect([miss.status, miss.body.code]).toEqual([422, 'RUN_SPLIT_INPUT_MISSING']);
    const extra = await w.c(
      'post',
      '/billing/runs',
      {
        runType: 'REGULAR',
        periodStart: '2026-11-01',
        splitInputs: [
          { billSplitRuleId: split.id!, amountPaise: 1_000_000 },
          { billSplitRuleId: 999, amountPaise: 5 },
        ],
      },
      { headers: idemH() },
    );
    expect(extra.status).toBe(400);
    const run = await createAndCompute(w.c, {
      splitInputs: [{ billSplitRuleId: split.id!, amountPaise: 1_000_000 }],
    });
    expect(run.status).toBe(201);
    const list = await items(w, run.id);
    const lines = list.map(i => i.lines.find((l: any) => l.headKey === 'LIFT').amountPaise);
    expect(lines).toEqual([383_334, 383_333, 233_333]);
    // PATCH can change the amount and recomputes
    const d = await detail(w, run.id);
    const patch = await w.c('patch', `/billing/runs/${run.id}`, {
      splitInputs: [{ billSplitRuleId: split.id!, amountPaise: 3_000_000 }],
      version: d.version,
    });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    const missingPatch = await w.c('patch', `/billing/runs/${run.id}`, {
      splitInputs: [],
      version: patch.body.data.version,
    });
    expect([missingPatch.status, missingPatch.body.code]).toEqual([409, 'INVALID_STATE']); // still DRAFT: the job has not finished
    await drainQueues();
    expect(
      (await items(w, run.id)).map(i => i.lines.find((l: any) => l.headKey === 'LIFT').amountPaise),
    ).toEqual([1_150_000, 1_150_000, 700_000]);
  });
});

describe('access, isolation and suspension (T11-40, T11-43, T11-47)', () => {
  it('T11-43 a member with view only cannot create, edit or publish; a viewer can read', async () => {
    const w = await world();
    const viewer = await memberOf(w.society, 'society_admin');
    expect(
      (
        await viewer.c(
          'post',
          '/billing/runs',
          { runType: 'REGULAR', periodStart: '2026-11-01' },
          { headers: idemH() },
        )
      ).status,
    ).toBe(403);
    const run = await createAndCompute(w.c);
    expect((await viewer.c('get', `/billing/runs/${run.id}`)).status).toBe(200);
    expect((await viewer.c('get', `/billing/runs/${run.id}/items`)).status).toBe(200);
    expect((await viewer.c('post', `/billing/runs/${run.id}/recompute`, { version: 2 })).status).toBe(403);
    expect(
      (
        await viewer.c(
          'post',
          `/billing/runs/${run.id}/publish`,
          { confirmLabel: 'x', version: 2 },
          { headers: idemH() },
        )
      ).status,
    ).toBe(403);
  });

  it('T11-40 another society’s run and item ids are 404', async () => {
    const a = await world();
    const run = await createAndCompute(a.c);
    const [item] = await items(a, run.id);
    const b = await runSociety({ flats: 1 });
    for (const [m, p, body] of [
      ['get', `/billing/runs/${run.id}`, undefined],
      ['get', `/billing/runs/${run.id}/items`, undefined],
      ['patch', `/billing/runs/${run.id}`, { notes: 'x', version: 2 }],
      ['post', `/billing/runs/${run.id}/recompute`, { version: 2 }],
      ['post', `/billing/runs/${run.id}/items/${item.id}/exclude`, { reason: 'Not my flat', version: 1 }],
      ['post', `/billing/runs/${run.id}/items/${item.id}/include`, { version: 1 }],
      ['post', `/billing/runs/${run.id}/publish`, { confirmLabel: 'BR-2026-11', version: 2 }],
      ['post', `/billing/runs/${run.id}/cancel`, { reason: 'Not my run', version: 2 }],
      ['post', `/billing/runs/${run.id}/resume-issue`, { version: 2 }],
    ] as const) {
      const r = await b.c(m, p, body as never, { headers: idemH() });
      expect([m, p, r.status, r.body.code]).toEqual([m, p, 404, 'RUN_NOT_FOUND']);
    }
    expect((await b.c('get', '/billing/runs')).body.data).toEqual([]);
  });

  it('T11-47 creating a run in a suspended society is 423', async () => {
    const w = await world();
    await Society.update(
      { status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL' } as never,
      { where: { id: w.society.id! } },
    );
    const r = await w.c(
      'post',
      '/billing/runs',
      { runType: 'REGULAR', periodStart: '2026-11-01' },
      { headers: idemH() },
    );
    expect([r.status, r.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
  });

  it('every run route has the society marker, the permission, the plan feature and idempotency where the spec says', () => {
    const routes = listRoutes(app).filter(r => r.path.startsWith('/billing/runs'));
    const found = Object.fromEntries(routes.map(r => [`${r.method} ${r.path}`, r]));
    const expected: Record<string, [string, boolean]> = {
      'GET /billing/runs': ['finance.billing.view', false],
      'POST /billing/runs': ['finance.billing.create', true],
      'GET /billing/runs/:id': ['finance.billing.view', false],
      'GET /billing/runs/:id/items': ['finance.billing.view', false],
      'PATCH /billing/runs/:id': ['finance.billing.create', false],
      'POST /billing/runs/:id/recompute': ['finance.billing.create', false],
      'POST /billing/runs/:id/items/:itemId/exclude': ['finance.billing.create', false],
      'POST /billing/runs/:id/items/:itemId/include': ['finance.billing.create', false],
      'POST /billing/runs/:id/publish': ['finance.billing.create', true],
      'POST /billing/runs/:id/cancel': ['finance.billing.edit', false],
      'POST /billing/runs/:id/resume-issue': ['finance.billing.create', false],
    };
    expect(Object.keys(found).sort()).toEqual(Object.keys(expected).sort());
    for (const [k, [perm, idem]] of Object.entries(expected)) {
      expect(found[k]).toMatchObject({ kind: 'society', permissions: [perm], idempotent: idem });
      expect(
        found[k]!.features.some(f =>
          ['billing.billing_run_pipeline', 'billing.exceptions_report'].includes(f),
        ),
      ).toBe(true);
    }
  });
});

describe('scale', () => {
  it('computes 400 flats well inside the 60 second budget of US-11-03', async () => {
    const w = await runSociety({ flats: 1 });
    await rawUnits(w.society.id!, w.buildingId, 'A', 399, { areaSqft: '1150.000', carpet: '1150.000' });
    const all = await Unit.findAll({ where: { societyId: w.society.id! } });
    for (const u of all) await addOwner(w.society.id!, u.id!, `Owner ${u.label}`);
    await standardRules(w.society.id!, w.heads);
    const t0 = Date.now();
    const run = await createAndCompute(w.c);
    expect(Date.now() - t0).toBeLessThan(60_000);
    const d = await detail(w, run.id);
    expect(d.counts).toMatchObject({ items: 400, ready: 400 });
    expect(d.totalPaise).toBe(400 * 488_000);
  }, 180_000);
});
