import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditLog,
  BillingRun,
  BillingRunItem,
  Invoice,
  InvoiceLine,
  Society,
  Unit,
  UnitLedgerEntry,
  closeDb,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { drainQueues, tickScheduler } from '../../../src/lib/queue';
import { systemCtx } from '../../../src/types/context';
import { billingPortCalls, setBillingPorts } from '../../../src/modules/billing/billing.ports';
import { unitLedger } from '../../../src/modules/billing/billing.ledger.service';
import {
  issueItem,
  issueRun,
  startScheduledIssues,
} from '../../../src/modules/billing/billing.issue.service';
import { loadBillingSettings } from '../../../src/modules/billing/billing.runs.shared';
import { approve } from '../../../src/modules/billing/billing.runs.approvals-hook';
import { events } from '../../helpers/auth';
import { as, login, resetLogins } from '../../helpers/access';
import {
  addOwner,
  createAndCompute,
  idemH,
  makeResident,
  linkResident,
  makeRule,
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
afterEach(() => vi.restoreAllMocks());

async function world(o: Parameters<typeof runSociety>[0] = {}, parking = true) {
  const w = await runSociety(o);
  for (const u of w.units) await addOwner(w.society.id!, u.id, `Owner of ${u.label}`);
  await standardRules(w.society.id!, w.heads, parking ? [w.units[0]!.id] : []);
  return w;
}
const ctxOf = (w: RunSociety, userId: number) => ({
  ...systemCtx('t'),
  user: { id: userId, name: 'Decider', mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' },
  society: { id: w.society.id!, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
});
const detail = async (w: RunSociety, id: number) => (await w.c('get', `/billing/runs/${id}`)).body.data;

/** Creates and computes a run, publishes it as the chairman and approves it as the treasurer. */
async function approved(w: RunSociety, body: Record<string, unknown> = {}) {
  const run = await createAndCompute(w.c, body);
  const d = await detail(w, run.id);
  const p = await w.c(
    'post',
    `/billing/runs/${run.id}/publish`,
    { confirmLabel: d.runLabel, version: d.version },
    { headers: idemH() },
  );
  if (p.status !== 200) throw new Error(`publish ${JSON.stringify(p.body)}`);
  await approve(p.body.data.approvalRequestId, ctxOf(w, w.treasurer.user.id!));
  return { id: run.id as number, requestId: p.body.data.approvalRequestId as number };
}
const invoicesOf = (w: RunSociety) =>
  Invoice.findAll({ where: { societyId: w.society.id! }, order: [['invoiceNo', 'ASC']] });

describe('issue a run (BR-11-37, T11-22)', () => {
  it('issues one invoice per READY item with consecutive numbers, lines, ledger entries and a balanced journal; the run becomes ISSUED', async () => {
    const w = await world();
    await setSetting(w.society.id!, 'billing.dueDays', 9);
    const { id } = await approved(w);
    expect((await BillingRun.findByPk(id))!.status).toBe('ISSUING');
    await drainQueues();
    const run = (await BillingRun.findByPk(id))!;
    expect(run).toMatchObject({ status: 'ISSUED', issuedCount: 2, readyCount: 0, lastError: null });
    expect(run.issuedAt).toBeInstanceOf(Date);
    const inv = await invoicesOf(w);
    expect(inv.map(i => i.invoiceNo)).toEqual(['INV/2026-27/000001', 'INV/2026-27/000002']);
    expect(inv.map(i => i.unitLabel)).toEqual(['A-101', 'A-102']); // ordered by unit label
    expect(inv[0]).toMatchObject({
      invoiceType: 'REGULAR',
      financialYear: '2026-27',
      billingRunId: id,
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      invoiceDate: '2026-11-04',
      dueDate: '2026-11-13',
      subtotalPaise: 538_000,
      taxPaise: 0,
      roundOffPaise: 0,
      totalPaise: 538_000,
      outstandingPaise: 538_000,
      paidPaise: 0,
      status: 'ISSUED',
      pdfStatus: 'PENDING',
      previousDuesPaise: 0,
      gstApplied: false,
      societyGstin: null,
      dedupeKey: `REG:${w.units[0]!.id}:2026-11-01:${inv[0]!.billToResidentId}`,
      createdBy: w.treasurer.user.id,
    });
    const lines = await InvoiceLine.findAll({
      where: { invoiceId: inv[0]!.id! },
      order: [['lineNo', 'ASC']],
    });
    expect(lines.map(l => [l.lineNo, l.lineKind, l.headKey, Number(l.amountPaise)])).toEqual([
      [1, 'CHARGE', 'MAINTENANCE', 368_000],
      [2, 'CHARGE', 'SINKING_FUND', 60_000],
      [3, 'CHARGE', 'REPAIR_FUND', 25_000],
      [4, 'CHARGE', 'PARKING', 50_000],
      [5, 'CHARGE', 'WATER', 35_000],
    ]);
    expect(lines[0]).toMatchObject({
      quantity: '1150.0000',
      ratePaise: 320,
      ledgerAccountCode: '4100',
      creditedPaise: 0,
      invoiceId: inv[0]!.id,
    });
    expect(lines[0]!.computation).toMatchObject({ method: 'PER_SQFT' });
    expect(lines.every(l => l.billingRuleVersionId !== null)).toBe(true);
    const ledger = await UnitLedgerEntry.findAll({
      where: { societyId: w.society.id! },
      order: [['id', 'ASC']],
    });
    expect(
      ledger.map(e => [
        e.entryType,
        e.refType,
        e.refId,
        Number(e.debitPaise),
        Number(e.creditPaise),
        e.entryDate,
      ]),
    ).toEqual([
      ['INVOICE', 'invoice', inv[0]!.id, 538_000, 0, '2026-11-04'],
      ['INVOICE', 'invoice', inv[1]!.id, 488_000, 0, '2026-11-04'],
    ]);
    expect(await unitLedger.balance(w.society.id!, w.units[0]!.id)).toBe(538_000);
    const items = await BillingRunItem.findAll({ where: { billingRunId: id } });
    expect(items.every(i => i.status === 'ISSUED' && i.invoiceId !== null)).toBe(true);
    const journal = billingPortCalls.filter(c => c.fn === 'journal.post');
    expect(journal).toHaveLength(2);
    expect(journal[0]!.input).toMatchObject({
      voucherType: 'INVOICE',
      refType: 'invoice',
      date: '2026-11-04',
    });
    expect(await AuditLog.count({ where: { action: 'billing.invoice.issued' } })).toBe(2);
    const audit = (await AuditLog.findOne({ where: { action: 'billing.invoice.issued' } }))!;
    expect(audit.actorUserId).toBe(w.treasurer.user.id); // the run's approver
    expect(await AuditLog.count({ where: { action: 'billing.run.issued' } })).toBe(1);
    expect(events.filter(e => e.event === 'billing.invoice.updated')).toHaveLength(2);
    expect(
      events
        .filter(e => e.event === 'billing.dues.changed')
        .map(e => e.room)
        .sort(),
    ).toEqual([`unit:${w.units[0]!.id}`, `unit:${w.units[1]!.id}`].sort());
    expect(events.find(e => e.event === 'billing.dues.changed')!.payload).toEqual({
      unitId: expect.any(Number),
    });
    const final = events.filter(e => e.event === 'billing.run.updated').pop()!;
    expect(final.payload).toMatchObject({ runId: id, status: 'ISSUED', issuedCount: 2 });
    const sent = billingPortCalls
      .filter(c => c.fn === 'notifications.send')
      .map(c => (c.input as any).template);
    expect(sent).toContain('billing.run_issued');
  });

  it('example B and I: a taxed invoice carries CGST, SGST and the round-off line, and its journal balances', async () => {
    const w = await runSociety({ flats: 1, area: '2150.000' });
    await addOwner(w.society.id!, w.units[0]!.id);
    await standardRules(w.society.id!, w.heads, [w.units[0]!.id]);
    await Society.update({ gstin: '27AAAAG1234C1ZE' } as never, { where: { id: w.society.id! } });
    await setSetting(w.society.id!, 'billing.applyGst', true);
    await approved(w);
    await drainQueues();
    const [inv] = await invoicesOf(w);
    expect(inv).toMatchObject({
      subtotalPaise: 858_000,
      cgstPaise: 74_070,
      sgstPaise: 74_070,
      taxPaise: 148_140,
      roundOffPaise: -40,
      totalPaise: 1_006_100,
      taxableValuePaise: 823_000,
      thresholdBasePaise: 823_000,
      gstApplied: true,
      societyGstin: '27AAAAG1234C1ZE',
    });
    const lines = await InvoiceLine.findAll({ where: { invoiceId: inv!.id! }, order: [['lineNo', 'ASC']] });
    expect(lines.map(l => [l.lineKind, Number(l.amountPaise), l.ledgerAccountCode, l.isTaxable])).toEqual([
      ['CHARGE', 688_000, '4100', true],
      ['CHARGE', 60_000, '2410', true],
      ['CHARGE', 25_000, '2420', true],
      ['CHARGE', 50_000, '4120', true],
      ['CHARGE', 35_000, '4130', false],
      ['CGST', 74_070, '2310', false],
      ['SGST', 74_070, '2320', false],
      ['ROUND_OFF', -40, '4990', false],
    ]);
    const j = billingPortCalls.find(c => c.fn === 'journal.post')!.input as { lines: any[] };
    const drs = j.lines.filter(l => l.debitPaise > 0).map(l => [l.accountCode, l.debitPaise]);
    const crs = j.lines
      .filter(l => l.creditPaise > 0)
      .map(l => [l.accountCode, l.creditPaise, l.fundId ?? null]);
    expect(drs).toEqual([
      ['1300', 1_006_100],
      ['4990', 40],
    ]);
    expect(crs).toEqual([
      ['4100', 688_000, null],
      ['2410', 60_000, 1001],
      ['2420', 25_000, 1002],
      ['4120', 50_000, null],
      ['4130', 35_000, null],
      ['2310', 74_070, null],
      ['2320', 74_070, null],
    ]);
    expect(drs.reduce((a, d) => a + (d[1] as number), 0)).toBe(crs.reduce((a, c) => a + (c[1] as number), 0));
  });

  it('the invoice prefix is the setting at the time the financial year’s row is created', async () => {
    const w = await world({ flats: 1 });
    await setSetting(w.society.id!, 'billing.invoicePrefix', 'MNT');
    await approved(w);
    await drainQueues();
    expect((await invoicesOf(w)).map(i => i.invoiceNo)).toEqual(['MNT/2026-27/000001']);
  });

  it('previous dues of the same flat and party are printed; the due date can move to the next working day', async () => {
    const w = await world({ flats: 1 });
    const run0 = await createAndCompute(w.c);
    const item = (await BillingRunItem.findOne({ where: { billingRunId: run0.id } }))!;
    await Invoice.create({
      societyId: w.society.id!,
      invoiceNo: 'INV/2026-27/900001',
      financialYear: '2026-27',
      invoiceType: 'REGULAR',
      billingRunId: null,
      dedupeKey: 'REG:old',
      unitId: item.unitId,
      unitLabel: 'A-101',
      billToResidentId: item.billToResidentId!,
      billToRelation: 'OWNER',
      billToName: 'x',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      invoiceDate: '2026-10-01',
      dueDate: '2026-10-10',
      totalPaise: 300_000,
      outstandingPaise: 300_000,
      subtotalPaise: 300_000,
      issuedAt: new Date(),
      version: 1,
    } as never);
    await setSetting(w.society.id!, 'billing.dueDays', 4); // 4 Nov + 4 = Sunday 8 Nov
    await setSetting(w.society.id!, 'billing.shiftDueDateOnHoliday', true);
    await BillingRun.update({ status: 'CANCELLED', activeKey: null } as never, { where: { id: run0.id } });
    await approved(w);
    await drainQueues();
    const inv =
      (await Invoice.findOne({
        where: { societyId: w.society.id!, invoiceType: 'REGULAR', billingRunId: { $ne: null } as never },
      }).catch(() => null)) ??
      (await Invoice.findOne({ where: { societyId: w.society.id!, invoiceNo: 'INV/2026-27/000001' } }))!;
    expect(inv).toMatchObject({ previousDuesPaise: 300_000, dueDate: '2026-11-09' });
  });

  it('issued invoices and lines are immutable (BR-11-6)', async () => {
    const w = await world({ flats: 1 });
    await approved(w);
    await drainQueues();
    const inv = (await Invoice.findOne({ where: { societyId: w.society.id! } }))!;
    await expect(inv.update({ totalPaise: 1 })).rejects.toThrow(/immutable/);
    await expect(inv.destroy()).rejects.toThrow(/never deleted/);
    const line = (await InvoiceLine.findOne({ where: { invoiceId: inv.id! } }))!;
    await expect(line.update({ amountPaise: 1 })).rejects.toThrow(/immutable/);
    await expect(line.destroy()).rejects.toThrow(/never deleted/);
    const fresh = (await Invoice.findByPk(inv.id!))!;
    await fresh.update({ pdfStatus: 'READY' }); // a settlement or housekeeping column may change
    expect((await Invoice.findByPk(inv.id!))!.pdfStatus).toBe('READY');
  });

  it('T11-22 an issue that fails midway stays ISSUING with lastError; resume continues without duplicates or gaps', async () => {
    const w = await world({ flats: 3 });
    const real = unitLedger.post.bind(unitLedger);
    let calls = 0;
    vi.spyOn(unitLedger, 'post').mockImplementation(async (...a) => {
      calls += 1;
      if (calls >= 2) throw new Error('disk on fire');
      return real(...a);
    });
    const { id } = await approved(w);
    await drainQueues();
    let run = (await BillingRun.findByPk(id))!;
    expect(run).toMatchObject({ status: 'ISSUING', issuedCount: 1, lastError: 'disk on fire' });
    expect((await invoicesOf(w)).map(i => i.invoiceNo)).toEqual(['INV/2026-27/000001']);
    expect(await UnitLedgerEntry.count({ where: { societyId: w.society.id! } })).toBe(1);

    const wrongState = await w.c('post', `/billing/runs/${id}/resume-issue`, { version: 1 });
    expect([wrongState.status, wrongState.body.code]).toEqual([409, 'STALE_VERSION']);
    vi.restoreAllMocks();
    const r = await w.c('post', `/billing/runs/${id}/resume-issue`, { version: run.version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await drainQueues();
    run = (await BillingRun.findByPk(id))!;
    expect(run).toMatchObject({ status: 'ISSUED', issuedCount: 3, lastError: null });
    expect((await invoicesOf(w)).map(i => i.invoiceNo)).toEqual([
      'INV/2026-27/000001',
      'INV/2026-27/000002',
      'INV/2026-27/000003',
    ]);
    expect(await AuditLog.count({ where: { action: 'billing.run.issue_resumed' } })).toBe(1);
    const again = await w.c('post', `/billing/runs/${id}/resume-issue`, { version: run.version });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('a locked period stops the issue before anything is written and gives the number back', async () => {
    const w = await world({ flats: 1 });
    setBillingPorts({ journal: { isDateLocked: async () => true } });
    const { id } = await approved(w);
    await drainQueues();
    const run = (await BillingRun.findByPk(id))!;
    expect(run).toMatchObject({ status: 'ISSUING', issuedCount: 0 });
    expect(run.lastError).toContain('locked');
    expect(await Invoice.count({ where: { societyId: w.society.id! } })).toBe(0);
    setBillingPorts({ journal: { isDateLocked: async () => false } });
    await w.c('post', `/billing/runs/${id}/resume-issue`, { version: run.version });
    await drainQueues();
    expect((await invoicesOf(w)).map(i => i.invoiceNo)).toEqual(['INV/2026-27/000001']);
  });

  it('running the issue job again touches nothing that is already issued', async () => {
    const w = await world({ flats: 2 });
    const { id } = await approved(w);
    await drainQueues();
    const before = await Invoice.count({ where: { societyId: w.society.id! } });
    await issueRun(id); // status is ISSUED: exits
    expect(await Invoice.count({ where: { societyId: w.society.id! } })).toBe(before);
    await BillingRun.update({ status: 'ISSUING' } as never, { where: { id } });
    await issueRun(id); // no READY item left: finishes
    expect(await Invoice.count({ where: { societyId: w.society.id! } })).toBe(before);
    expect((await BillingRun.findByPk(id))!.status).toBe('ISSUED');
  });
});

describe('numbering under concurrency (BR-11-5)', () => {
  it('items issued in parallel get unique consecutive numbers', async () => {
    const w = await world({ flats: 8 });
    const run = await createAndCompute(w.c);
    const d = await detail(w, run.id);
    await BillingRun.update({ status: 'ISSUING', approvedBy: w.treasurer.user.id } as never, {
      where: { id: run.id },
    });
    const row = (await BillingRun.findByPk(run.id))!;
    const items = await BillingRunItem.findAll({ where: { billingRunId: run.id }, order: [['id', 'ASC']] });
    const s = await loadBillingSettings(w.society.id!);
    const ctx = {
      ...systemCtx('t'),
      society: { id: w.society.id!, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
    };
    const out = await Promise.all(
      items.map(i => issueItem(row, i.id!, s, ctx, { userId: null, name: 'x', role: 'approver' })),
    );
    expect(out.every(o => o === 'ISSUED')).toBe(true);
    const nos = (await invoicesOf(w)).map(i => i.invoiceNo);
    expect(nos).toEqual(Array.from({ length: 8 }, (_, i) => `INV/2026-27/${String(i + 1).padStart(6, '0')}`));
    expect(new Set(nos).size).toBe(8);
    expect((await BillingRun.findByPk(run.id))!.issuedCount).toBe(8);
    // the same item twice at once issues once
    const again = await Promise.all([
      issueItem(row, items[0]!.id!, s, ctx, { userId: null, name: 'x', role: 'approver' }),
      issueItem(row, items[0]!.id!, s, ctx, { userId: null, name: 'x', role: 'approver' }),
    ]);
    expect(again).toEqual(['SKIPPED', 'SKIPPED']);
    expect(d.counts.ready).toBe(8);
  });

  it('a rolled-back issue gives its number back', async () => {
    const w = await world({ flats: 2 });
    const real = unitLedger.post.bind(unitLedger);
    let first = true;
    vi.spyOn(unitLedger, 'post').mockImplementation(async (...a) => {
      if (first) {
        first = false;
        throw new Error('transient');
      }
      return real(...a);
    });
    await approved(w);
    await drainQueues(); // the queue retries; the second attempt succeeds
    expect((await invoicesOf(w)).map(i => i.invoiceNo)).toEqual(['INV/2026-27/000001', 'INV/2026-27/000002']);
  });
});

describe('items that cannot be issued (BR-11-37, BR-11-38)', () => {
  it('an archived flat is EXCLUDED with UNIT_ARCHIVED and the run still completes', async () => {
    const w = await world({ flats: 2 });
    const run = await createAndCompute(w.c);
    const d = await detail(w, run.id);
    const p = await w.c(
      'post',
      `/billing/runs/${run.id}/publish`,
      { confirmLabel: 'BR-2026-11', version: d.version },
      { headers: idemH() },
    );
    await Unit.update(
      { status: 'ARCHIVED', archivedAt: new Date(), archivedReason: 'test', archivedBy: null } as never,
      { where: { id: w.units[1]!.id } },
    );
    await approve(p.body.data.approvalRequestId, ctxOf(w, w.treasurer.user.id!));
    await drainQueues();
    const r = (await BillingRun.findByPk(run.id))!;
    expect(r).toMatchObject({ status: 'ISSUED', issuedCount: 1, excludedCount: 1, totalPaise: 538_000 });
    const item = (await BillingRunItem.findOne({ where: { billingRunId: run.id, unitId: w.units[1]!.id } }))!;
    expect(item).toMatchObject({ status: 'EXCLUDED', excludedReason: 'UNIT_ARCHIVED' });
    expect(await Invoice.count({ where: { societyId: w.society.id! } })).toBe(1);
  });

  it('a dedupe collision excludes the item as ALREADY_BILLED and the job continues', async () => {
    const w = await world({ flats: 2 });
    const run = await createAndCompute(w.c);
    const d = await detail(w, run.id);
    const p = await w.c(
      'post',
      `/billing/runs/${run.id}/publish`,
      { confirmLabel: 'BR-2026-11', version: d.version },
      { headers: idemH() },
    );
    const item = (await BillingRunItem.findOne({ where: { billingRunId: run.id, unitId: w.units[0]!.id } }))!;
    await Invoice.create({
      societyId: w.society.id!,
      invoiceNo: 'INV/2026-27/900009',
      financialYear: '2026-27',
      invoiceType: 'REGULAR',
      billingRunId: null,
      dedupeKey: `REG:${item.unitId}:2026-11-01:${item.billToResidentId}`,
      unitId: item.unitId,
      unitLabel: 'A-101',
      billToResidentId: item.billToResidentId!,
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
    await approve(p.body.data.approvalRequestId, ctxOf(w, w.treasurer.user.id!));
    await drainQueues();
    expect((await BillingRun.findByPk(run.id))!).toMatchObject({ status: 'ISSUED', issuedCount: 1 });
    expect((await BillingRunItem.findByPk(item.id!))!).toMatchObject({
      status: 'EXCLUDED',
      excludedReason: 'ALREADY_BILLED',
    });
    expect(
      (await Invoice.findAll({ where: { societyId: w.society.id!, billingRunId: run.id } })).map(
        i => i.invoiceNo,
      ),
    ).toEqual(['INV/2026-27/000001']);
  });
});

describe('bill date and the daily job (BR-11-36, T11-21)', () => {
  it('a run approved before its bill date waits in APPROVED; the scheduler issues it on the bill date', async () => {
    const w = await world({ flats: 2 });
    await setSetting(w.society.id!, 'billing.billingDay', 10);
    const { id } = await approved(w);
    await drainQueues();
    expect((await BillingRun.findByPk(id))!.status).toBe('APPROVED');
    expect(await startScheduledIssues()).toEqual([]);
    setNow('2026-11-09T18:45:00Z'); // 00:15 on 10 November in India
    const fired = await tickScheduler();
    expect(fired).toContain('billing:start-scheduled-issues');
    await drainQueues();
    const run = (await BillingRun.findByPk(id))!;
    expect(run).toMatchObject({ status: 'ISSUED', issuedCount: 2 });
    expect((await invoicesOf(w)).map(i => i.invoiceDate)).toEqual(['2026-11-10', '2026-11-10']);
  });

  it('FY boundary: approved 28 March for April, issued on 1 April in the 2027-28 series', async () => {
    const w = await world({ flats: 1 });
    setNow('2027-03-28T05:00:00Z');
    resetLogins(); // the earlier session is months old on this clock
    const later = { ...w, c: as(await login(w.user)) };
    const { id } = await approved(later, { periodStart: '2027-04-01' });
    await drainQueues();
    expect((await BillingRun.findByPk(id))!.status).toBe('APPROVED');
    setNow('2027-04-01T05:00:00Z');
    expect(await startScheduledIssues()).toEqual([id]);
    await drainQueues();
    expect((await invoicesOf(w)).map(i => [i.invoiceNo, i.financialYear, i.invoiceDate])).toEqual([
      ['INV/2027-28/000001', '2027-28', '2027-04-01'],
    ]);
  });

  it('a suspended society’s approved run is not started by the scheduler', async () => {
    const w = await world({ flats: 1 });
    await setSetting(w.society.id!, 'billing.billingDay', 10);
    await approved(w);
    setNow('2026-11-10T05:00:00Z');
    await Society.update(
      { status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL' } as never,
      { where: { id: w.society.id! } },
    );
    expect(await startScheduledIssues()).toEqual([]);
  });
});

describe('metered lines (T11-55)', () => {
  it('bills 18,400 litres as 41,900 and marks the readings billed once, in the invoice transaction', async () => {
    const w = await runSociety({ flats: 1 });
    await addOwner(w.society.id!, w.units[0]!.id);
    await makeRule(w.society.id!, w.heads.WATER!, {
      rateType: 'METERED',
      meterType: 'WATER',
      slabs: [
        { uptoMilli: 15_000, ratePaise: 2000 },
        { uptoMilli: null, ratePaise: 3500 },
      ],
      minimumChargePaise: 0,
      missingReadingPolicy: 'EXCEPTION',
    });
    setBillingPorts({
      meters: {
        getSource: () => ({
          consumptionForPeriod: async () =>
            new Map([[w.units[0]!.id, { quantityMilli: 18_400n, readingIds: [5, 6], isEstimated: false }]]),
        }),
      },
    });
    const { id } = await approved(w);
    await drainQueues();
    const [inv] = await invoicesOf(w);
    expect(Number(inv!.totalPaise)).toBe(41_900);
    const lines = await InvoiceLine.findAll({ where: { invoiceId: inv!.id! } });
    expect(lines[0]).toMatchObject({ quantity: '18.4000', headKey: 'WATER' });
    expect(lines[0]!.computation).toMatchObject({ readingIds: [5, 6] });
    const marks = billingPortCalls.filter(c => c.fn === 'meters.markBilled');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.input).toEqual({ readingIds: [5, 6], billingRunRef: 'BR-2026-11' });
    expect(marks[0]!.t).toBeDefined();
    await BillingRun.update({ status: 'ISSUING' } as never, { where: { id } });
    await issueRun(id);
    expect(billingPortCalls.filter(c => c.fn === 'meters.markBilled')).toHaveLength(1);
  });

  it('a missing reading is MISSING_READING without a source entry; METERED without a registered source fails the run', async () => {
    const w = await runSociety({ flats: 1 });
    await addOwner(w.society.id!, w.units[0]!.id);
    await makeRule(w.society.id!, w.heads.WATER!, {
      rateType: 'METERED',
      meterType: 'WATER',
      slabs: [{ uptoMilli: null, ratePaise: 2000 }],
      minimumChargePaise: 0,
      missingReadingPolicy: 'EXCEPTION',
    });
    const noSource = await createAndCompute(w.c);
    expect((await detail(w, noSource.id)).status).toBe('FAILED');
    expect((await detail(w, noSource.id)).computeError).toContain('Metered billing is not available');
    setBillingPorts({ meters: { getSource: () => ({ consumptionForPeriod: async () => new Map() }) } });
    const d = await detail(w, noSource.id);
    await w.c('post', `/billing/runs/${noSource.id}/recompute`, { version: d.version });
    await drainQueues();
    const items = (await w.c('get', `/billing/runs/${noSource.id}/items`)).body.data;
    expect(items[0]).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_READING' });
  });
});

void linkResident;
void makeResident;
