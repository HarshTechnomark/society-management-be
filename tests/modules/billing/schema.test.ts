import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import {
  Invoice,
  InvoiceLine,
  OpeningBalance,
  UnitLedgerEntry,
  closeDb,
  sequelize,
} from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import {
  billingWorld,
  rawHead,
  rawInvoice,
  rawLedger,
  rawLine,
  rawNote,
  rawOpening,
  rawPolicy,
  rawRule,
  rawRun,
  rawSplitRule,
  rawVersion,
  resetBillingTests,
} from '../../helpers/maint-billing';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetBillingTests);

const CHECK = /Check constraint|ck_/i;
const failing = (p: Promise<unknown>, re: RegExp = CHECK) => expect(p).rejects.toThrow(re);

/** Section 7: CHECKs, unique indexes and foreign keys of the twelve tables. */
describe('charge_heads (7.1)', () => {
  it('defaults and the key, type, routing, GST, SAC and status CHECKs', async () => {
    const w = await billingWorld();
    const sid = w.society.id!;
    const h = await rawHead(sid);
    expect([h.payerRouting, h.gstTreatment, h.prorate, h.interestBearing, h.isSystem, h.status]).toEqual([
      'BILL_TO',
      'NONE',
      true,
      true,
      false,
      'ACTIVE',
    ]);
    expect([h.sortOrder, h.version]).toEqual([100, 1]);
    await failing(rawHead(sid, { key: 'lower' }));
    await failing(rawHead(sid, { key: 'A' }));
    await failing(rawHead(sid, { headType: 'BOGUS' as never }));
    await failing(rawHead(sid, { payerRouting: 'BOTH' as never }));
    await failing(rawHead(sid, { gstTreatment: 'FOLLOW_SOURCE' })); // only INTEREST and LATE_FEE
    await rawHead(sid, { gstTreatment: 'FOLLOW_SOURCE', headType: 'INTEREST' });
    await failing(rawHead(sid, { sacCode: '12' }));
    await failing(rawHead(sid, { sacCode: 'ABCDEF' }));
    await rawHead(sid, { sacCode: '999599', gstTreatment: 'THRESHOLD' });
    await failing(rawHead(sid, { status: 'GONE' as never }));
    await failing(rawHead(sid, { sortOrder: 1000 }));
  });

  it('the key is unique per society', async () => {
    const w = await billingWorld();
    await rawHead(w.society.id!, { key: 'LIFT_FUND' });
    await expect(rawHead(w.society.id!, { key: 'LIFT_FUND' })).rejects.toThrow(
      /Validation|Duplicate|unique/i,
    );
  });
});

describe('billing_rules, billing_rule_versions, bill_split_rules (7.2 to 7.4)', () => {
  it('rule: scope CHECKs and the unique name per head', async () => {
    const sid = (await billingWorld()).society.id!;
    const h = await rawHead(sid);
    await failing(rawRule(sid, h.id!, { scopeType: 'WING' as never }));
    await failing(rawRule(sid, h.id!, { scopeType: 'BUILDINGS', scopeValues: null }));
    await failing(rawRule(sid, h.id!, { scopeType: 'ALL_UNITS', scopeValues: [1] }));
    await rawRule(sid, h.id!, { name: 'Maintenance', scopeType: 'BUILDINGS', scopeValues: [1] });
    await expect(rawRule(sid, h.id!, { name: 'Maintenance' })).rejects.toThrow(
      /Validation|Duplicate|unique/i,
    );
  });

  it('version: each rate type needs its own fields and no others', async () => {
    const sid = (await billingWorld()).society.id!;
    const h = await rawHead(sid);
    const r = await rawRule(sid, h.id!);
    let n = 1;
    const v = (o: Record<string, unknown>) => rawVersion(sid, r.id!, { versionNo: ++n, ...o } as never);
    await failing(v({ rateType: 'FLAT_PER_UNIT', amountPaise: null }));
    await failing(v({ rateType: 'FLAT_PER_UNIT', amountPaise: 100_000_001 }));
    await failing(v({ rateType: 'FLAT_PER_UNIT', amountPaise: 1, ratePerSqftPaise: 5 }));
    await v({ rateType: 'FLAT_PER_UNIT', amountPaise: 0 }); // exemption
    await failing(v({ rateType: 'PER_SQFT', amountPaise: null, ratePerSqftPaise: 0 }));
    await v({ rateType: 'PER_SQFT', amountPaise: null, ratePerSqftPaise: 320 });
    await failing(v({ rateType: 'PER_UNIT_TYPE', amountPaise: null, unitTypeRates: {} }));
    await failing(v({ rateType: 'PER_UNIT_TYPE', amountPaise: null, unitTypeRates: [1] }));
    await v({ rateType: 'PER_UNIT_TYPE', amountPaise: null, unitTypeRates: { '2BHK': 250_000 } });
    const metered = {
      rateType: 'METERED',
      amountPaise: null,
      meterType: 'WATER',
      slabs: [
        { uptoMilli: 15_000, ratePaise: 2000 },
        { uptoMilli: null, ratePaise: 3500 },
      ],
      minimumChargePaise: 20_000,
      missingReadingPolicy: 'EXCEPTION',
    };
    await v(metered);
    await failing(v({ ...metered, meterType: 'STEAM' }));
    await failing(v({ ...metered, missingReadingPolicy: 'SKIP' }));
    await failing(v({ ...metered, minimumChargePaise: null }));
    await failing(v({ rateType: 'SPLIT_TOTAL', amountPaise: null, billSplitRuleId: null }));
    const split = await rawSplitRule(sid);
    await v({ rateType: 'SPLIT_TOTAL', amountPaise: null, billSplitRuleId: split.id });
    await failing(
      v({ rateType: 'PERCENT_OF_HEADS', amountPaise: null, percent: '5.0000', baseChargeHeadIds: [] }),
    );
    await failing(
      v({ rateType: 'PERCENT_OF_HEADS', amountPaise: null, percent: '0.0000', baseChargeHeadIds: [1] }),
    );
    await v({
      rateType: 'PERCENT_OF_HEADS',
      amountPaise: null,
      percent: '10.0000',
      baseChargeHeadIds: [h.id],
    });
    await failing(v({ rateType: 'NONE', amountPaise: 5 }));
    await v({ rateType: 'NONE', amountPaise: null });
    await failing(v({ rateType: 'WEEKLY' }));
    await failing(v({ status: 'DONE' }));
    await failing(v({ effectiveTo: '2026-03-31' }));
  });

  it('version: unique number per rule, defaults to PENDING_APPROVAL, immutable apart from approval columns', async () => {
    const sid = (await billingWorld()).society.id!;
    const h = await rawHead(sid);
    const r = await rawRule(sid, h.id!);
    const v1 = await rawVersion(sid, r.id!, { status: 'PENDING_APPROVAL' });
    await expect(rawVersion(sid, r.id!, { versionNo: 1 })).rejects.toThrow(/Validation|Duplicate|unique/i);
    v1.amountPaise = 999;
    await expect(v1.save()).rejects.toThrow(/immutable.*amountPaise/);
    await v1.reload();
    v1.effectiveFrom = '2026-05-01';
    await expect(v1.save()).rejects.toThrow(/immutable/);
    await v1.reload();
    v1.status = 'APPROVED';
    v1.effectiveTo = '2027-03-31';
    v1.approvedAt = new Date();
    await v1.save();
    expect((await v1.reload()).status).toBe('APPROVED');
    await expect(v1.destroy()).rejects.toThrow(/never deleted/);
  });

  it('split rule: FIXED needs an amount, RUN_INPUT none; unique name', async () => {
    const sid = (await billingWorld()).society.id!;
    await failing(rawSplitRule(sid, { amountSource: 'FIXED', fixedAmountPaise: null }));
    await failing(rawSplitRule(sid, { amountSource: 'FIXED', fixedAmountPaise: 0 }));
    await failing(rawSplitRule(sid, { amountSource: 'RUN_INPUT', fixedAmountPaise: 5 }));
    await failing(rawSplitRule(sid, { basis: 'RANDOM' as never }));
    await rawSplitRule(sid, { name: 'Lift AMC', amountSource: 'RUN_INPUT', fixedAmountPaise: null });
    await expect(rawSplitRule(sid, { name: 'Lift AMC' })).rejects.toThrow(/Validation|Duplicate|unique/i);
  });
});

describe('late_fee_policies (7.10)', () => {
  it('interest is capped at 21 %, FLAT needs a fee in range, grace at most 30 days', async () => {
    const sid = (await billingWorld()).society.id!;
    await rawPolicy(sid, { interestRatePct: '21.0000' });
    await failing(rawPolicy(sid, { interestRatePct: '21.0001' }));
    await failing(rawPolicy(sid, { interestRatePct: '0.0000' }));
    await failing(rawPolicy(sid, { interestFrom: null }));
    await failing(rawPolicy(sid, { interestFrom: 'NEVER' as never }));
    await failing(
      rawPolicy(sid, { policyType: 'FLAT', interestRatePct: null, interestFrom: null, flatFeePaise: 99 }),
    );
    await rawPolicy(sid, {
      policyType: 'FLAT',
      interestRatePct: null,
      interestFrom: null,
      flatFeePaise: 50_000,
    });
    await failing(rawPolicy(sid, { graceDays: 31 }));
    await failing(rawPolicy(sid, { minChargePaise: 100_001 }));
    await failing(rawPolicy(sid, { status: 'OLD' as never }));
    const none = await rawPolicy(sid, { policyType: 'NONE', interestRatePct: null, interestFrom: null });
    expect(none.minChargePaise).toBe(100);
  });
});

describe('billing_runs and billing_run_items (7.5, 7.6)', () => {
  it('period, scope and status CHECKs; REGULAR is ALL_UNITS only', async () => {
    const sid = (await billingWorld()).society.id!;
    const run = await rawRun(sid);
    expect([run.status, run.itemCount, run.totalPaise, run.version, run.activeKey]).toEqual([
      'DRAFT',
      0,
      0,
      1,
      null,
    ]);
    await failing(rawRun(sid, { periodEnd: '2026-11-01' }));
    await failing(rawRun(sid, { runType: 'WEEKLY' as never }));
    await failing(rawRun(sid, { cycle: 'DAILY' as never }));
    await failing(rawRun(sid, { status: 'LOST' as never }));
    await failing(rawRun(sid, { scopeType: 'UNIT_TYPES' as never }));
    await failing(rawRun(sid, { runType: 'REGULAR', scopeType: 'UNITS', scopeValues: [1] }));
    await rawRun(sid, { runType: 'SUPPLEMENTARY', scopeType: 'UNITS', scopeValues: [1] });
  });

  it('one active regular run per period (activeKey) and a unique label; NULL keys do not collide', async () => {
    const sid = (await billingWorld()).society.id!;
    await rawRun(sid, { runType: 'REGULAR', activeKey: 'REG:2026-11-01', runLabel: 'BR-2026-11' });
    await expect(
      rawRun(sid, { runType: 'REGULAR', activeKey: 'REG:2026-11-01', runLabel: 'BR-2026-11-X' }),
    ).rejects.toThrow(/Validation|Duplicate|unique/i);
    await expect(rawRun(sid, { runLabel: 'BR-2026-11' })).rejects.toThrow(/Validation|Duplicate|unique/i);
    await rawRun(sid, { runType: 'REGULAR', activeKey: null, runLabel: 'BR-2026-11-C', status: 'CANCELLED' });
    await rawRun(sid, { runType: 'REGULAR', activeKey: null, runLabel: 'BR-2026-11-D', status: 'CANCELLED' });
  });

  it('runs are never deleted; items cascade only at the database level', async () => {
    const w = await billingWorld();
    const sid = w.society.id!;
    const run = await rawRun(sid);
    await expect(run.destroy()).rejects.toThrow(/never deleted/);
    const mk = (itemKey: string, o: Record<string, unknown> = {}) =>
      sequelize.query(
        `INSERT INTO billing_run_items (societyId, billingRunId, unitId, unitLabel, itemKey, status, linesSnapshot, createdAt, updatedAt)
         VALUES (:sid, :rid, :uid, 'A-101', :k, :st, '[]', NOW(3), NOW(3))`,
        { replacements: { sid, rid: run.id, uid: w.unit(1).id, k: itemKey, st: 'READY', ...o } },
      );
    await mk('1:2');
    await expect(mk('1:2')).rejects.toThrow(/Duplicate|Validation/i);
    await expect(mk('1:3', { st: 'MAYBE' })).rejects.toThrow(CHECK);
    await sequelize.query('DELETE FROM billing_runs WHERE id = :id', { replacements: { id: run.id } });
    const [{ n }] = await sequelize.query<{ n: number }>('SELECT COUNT(*) AS n FROM billing_run_items', {
      type: QueryTypes.SELECT,
    });
    expect(Number(n)).toBe(0);
  });
});

describe('invoices (7.7)', () => {
  it('stores a consistent invoice with defaults', async () => {
    const w = await billingWorld();
    const inv = await rawInvoice(w.society.id!, w.unit(1).id);
    expect([inv.status, inv.pdfStatus, inv.isDisputed, inv.gstApplied, inv.paidPaise, inv.version]).toEqual([
      'ISSUED',
      'PENDING',
      false,
      false,
      0,
      1,
    ]);
  });

  it('CHECKs: totals add up, round-off range, CGST equals SGST, due date, outstanding, written-off', async () => {
    const w = await billingWorld();
    const sid = w.society.id!;
    const u = w.unit(1).id;
    await failing(rawInvoice(sid, u, { totalPaise: 100_001 }));
    await failing(rawInvoice(sid, u, { totalPaise: 0, subtotalPaise: 0, outstandingPaise: 0 }));
    await failing(rawInvoice(sid, u, { roundOffPaise: 51, totalPaise: 100_051, outstandingPaise: 100_051 }));
    await rawInvoice(sid, u, { roundOffPaise: -49, totalPaise: 99_951, outstandingPaise: 99_951 });
    await rawInvoice(sid, u, { roundOffPaise: 50, totalPaise: 100_050, outstandingPaise: 100_050 });
    await failing(rawInvoice(sid, u, { roundOffPaise: -50, totalPaise: 99_950, outstandingPaise: 99_950 }));
    await failing(
      rawInvoice(sid, u, {
        cgstPaise: 900,
        sgstPaise: 800,
        taxPaise: 1700,
        totalPaise: 101_700,
        outstandingPaise: 101_700,
      }),
    );
    await rawInvoice(sid, u, {
      gstApplied: true,
      taxableValuePaise: 100_000,
      cgstPaise: 9000,
      sgstPaise: 9000,
      taxPaise: 18_000,
      totalPaise: 118_000,
      outstandingPaise: 118_000,
    });
    await failing(rawInvoice(sid, u, { taxPaise: 5, totalPaise: 100_005, outstandingPaise: 100_005 }));
    await failing(rawInvoice(sid, u, { dueDate: '2026-10-31' }));
    await failing(rawInvoice(sid, u, { outstandingPaise: 99_999 }));
    await failing(rawInvoice(sid, u, { paidPaise: 100_001, outstandingPaise: -1 }));
    await rawInvoice(sid, u, { paidPaise: 40_000, outstandingPaise: 60_000, status: 'PARTIALLY_PAID' });
    await rawInvoice(sid, u, { debitedPaise: 9_200, outstandingPaise: 109_200 });
    await failing(rawInvoice(sid, u, { writtenOffPaise: 10, creditedPaise: 5, outstandingPaise: 99_995 }));
    await rawInvoice(sid, u, { writtenOffPaise: 5, creditedPaise: 5, outstandingPaise: 99_995 });
    await failing(rawInvoice(sid, u, { invoiceType: 'RECURRING' as never }));
    await failing(rawInvoice(sid, u, { billToRelation: 'GUEST' as never }));
    await failing(rawInvoice(sid, u, { status: 'DRAFT' as never }));
    await failing(rawInvoice(sid, u, { financialYear: '2026/27' }));
    await failing(rawInvoice(sid, u, { pdfStatus: 'LOST' as never }));
  });

  it('invoice number and dedupe key are unique per society; several NULL dedupe keys are fine', async () => {
    const w = await billingWorld();
    const sid = w.society.id!;
    const u = w.unit(1).id;
    await rawInvoice(sid, u, { invoiceNo: 'INV/2026-27/000001' });
    await expect(rawInvoice(sid, u, { invoiceNo: 'INV/2026-27/000001' })).rejects.toThrow(
      /Validation|Duplicate|unique/i,
    );
    await rawInvoice(sid, u, { dedupeKey: 'OB:1:1', invoiceType: 'OPENING' });
    await expect(rawInvoice(sid, u, { dedupeKey: 'OB:1:1', invoiceType: 'OPENING' })).rejects.toThrow(
      /Validation|Duplicate|unique/i,
    );
    await rawInvoice(sid, u);
    await rawInvoice(sid, u);
  });

  it('immutability hook (BR-11-6): settlement columns change, everything else throws, nothing is deleted', async () => {
    const w = await billingWorld();
    const inv = await rawInvoice(w.society.id!, w.unit(1).id);
    inv.paidPaise = 40_000;
    inv.outstandingPaise = 60_000;
    inv.status = 'PARTIALLY_PAID';
    inv.reminderCount = 1;
    inv.isDisputed = true;
    inv.version = 2;
    await inv.save();
    expect((await inv.reload()).outstandingPaise).toBe(60_000);

    for (const [col, val] of [
      ['totalPaise', 5],
      ['invoiceNo', 'X'],
      ['dueDate', '2026-12-01'],
      ['billToName', 'Someone else'],
      ['unitId', 99],
      ['subtotalPaise', 1],
    ] as const) {
      await inv.reload();
      inv.set(col, val as never);
      await expect(inv.save()).rejects.toThrow(new RegExp(`immutable.*${col}`));
    }
    await inv.reload();
    await expect(inv.destroy()).rejects.toThrow(/never deleted/);
    await expect(Invoice.destroy({ where: { id: inv.id } })).rejects.toThrow(/never deleted/);
    // a bulk update runs the per-row hook as well
    await expect(Invoice.update({ totalPaise: 1 }, { where: { id: inv.id } })).rejects.toThrow(/immutable/);
    await Invoice.update({ reminderCount: 2 }, { where: { id: inv.id } });
    expect((await inv.reload()).reminderCount).toBe(2);
  });
});

describe('invoice_lines and billing_notes (7.8, 7.9)', () => {
  it('a line belongs to exactly one parent, has a head for money kinds and a positive amount', async () => {
    const w = await billingWorld();
    const sid = w.society.id!;
    const h = await rawHead(sid);
    const inv = await rawInvoice(sid, w.unit(1).id);
    const note = await rawNote(sid, inv.id!, w.unit(1).id);
    await rawLine(sid, { invoiceId: inv.id!, chargeHeadId: h.id! });
    await failing(rawLine(sid, { lineNo: 2, chargeHeadId: h.id!, invoiceId: null, billingNoteId: null }));
    await failing(
      rawLine(sid, { lineNo: 2, chargeHeadId: h.id!, invoiceId: inv.id!, billingNoteId: note.id! }),
    );
    await rawLine(sid, { lineNo: 1, chargeHeadId: h.id!, invoiceId: null, billingNoteId: note.id! });
    await failing(rawLine(sid, { lineNo: 2, invoiceId: inv.id!, chargeHeadId: undefined as never }));
    await failing(rawLine(sid, { lineNo: 2, invoiceId: inv.id!, chargeHeadId: h.id!, amountPaise: 0 }));
    await failing(rawLine(sid, { lineNo: 2, invoiceId: inv.id!, chargeHeadId: h.id!, amountPaise: -5 }));
    await rawLine(sid, {
      lineNo: 2,
      invoiceId: inv.id!,
      lineKind: 'ROUND_OFF',
      amountPaise: -30,
      chargeHeadId: undefined as never,
    });
    await failing(
      rawLine(sid, {
        lineNo: 3,
        invoiceId: inv.id!,
        lineKind: 'ROUND_OFF',
        amountPaise: 0,
        chargeHeadId: undefined as never,
      }),
    );
    await failing(
      rawLine(sid, { lineNo: 3, invoiceId: inv.id!, lineKind: 'TAX' as never, chargeHeadId: h.id! }),
    );
    await failing(
      rawLine(sid, { lineNo: 3, invoiceId: inv.id!, chargeHeadId: h.id!, creditedPaise: 100_001 }),
    );
    await failing(rawLine(sid, { lineNo: 3, invoiceId: inv.id!, chargeHeadId: h.id!, creditedPaise: -1 }));
  });

  it('line numbers are unique per parent', async () => {
    const w = await billingWorld();
    const sid = w.society.id!;
    const h = await rawHead(sid);
    const inv = await rawInvoice(sid, w.unit(1).id);
    await rawLine(sid, { invoiceId: inv.id!, chargeHeadId: h.id! });
    await expect(rawLine(sid, { invoiceId: inv.id!, chargeHeadId: h.id! })).rejects.toThrow(
      /Validation|Duplicate|unique/i,
    );
  });

  it('line hook: only creditedPaise and updatedBy change; no delete', async () => {
    const w = await billingWorld();
    const sid = w.society.id!;
    const h = await rawHead(sid);
    const inv = await rawInvoice(sid, w.unit(1).id);
    const line = await rawLine(sid, { invoiceId: inv.id!, chargeHeadId: h.id! });
    line.creditedPaise = 50_000;
    line.updatedBy = 7;
    await line.save();
    expect((await line.reload()).creditedPaise).toBe(50_000);
    line.amountPaise = 1;
    await expect(line.save()).rejects.toThrow(/immutable.*amountPaise/);
    await line.reload();
    line.description = 'Edited';
    await expect(line.save()).rejects.toThrow(/immutable/);
    await expect(line.destroy()).rejects.toThrow(/never deleted/);
    await expect(InvoiceLine.destroy({ where: { id: line.id } })).rejects.toThrow(/never deleted/);
  });

  it('credit line may reference the credited invoice line (refInvoiceLineId)', async () => {
    const w = await billingWorld();
    const sid = w.society.id!;
    const h = await rawHead(sid);
    const inv = await rawInvoice(sid, w.unit(1).id);
    const note = await rawNote(sid, inv.id!, w.unit(1).id);
    const line = await rawLine(sid, { invoiceId: inv.id!, chargeHeadId: h.id! });
    const cl = await rawLine(sid, {
      billingNoteId: note.id!,
      invoiceId: null,
      chargeHeadId: h.id!,
      refInvoiceLineId: line.id!,
      amountPaise: 50_000,
    });
    expect(cl.refInvoiceLineId).toBe(line.id);
    await expect(
      rawLine(sid, {
        lineNo: 2,
        billingNoteId: note.id!,
        invoiceId: null,
        chargeHeadId: h.id!,
        refInvoiceLineId: 999_999,
      }),
    ).rejects.toThrow(/foreign key|constraint/i);
  });

  it('note CHECKs: reason by type, debit always ISSUED, issued notes carry a number and date, total > 0', async () => {
    const w = await billingWorld();
    const sid = w.society.id!;
    const u = w.unit(1).id;
    const inv = await rawInvoice(sid, u);
    const n = (o: Record<string, unknown>) => rawNote(sid, inv.id!, u, o as never);
    await failing(n({ reasonCode: 'INTEREST' })); // debit reason on a credit note
    await failing(
      n({
        noteType: 'DEBIT',
        reasonCode: 'WAIVER',
        status: 'ISSUED',
        noteNo: 'DN/1',
        noteDate: '2026-11-01',
      }),
    );
    await failing(n({ noteType: 'DEBIT', reasonCode: 'INTEREST', status: 'PENDING_APPROVAL' }));
    await n({
      noteType: 'DEBIT',
      reasonCode: 'INTEREST',
      status: 'ISSUED',
      noteNo: 'DN/2026-27/000001',
      noteDate: '2026-11-01',
    });
    await failing(n({ status: 'ISSUED' })); // no number
    await failing(n({ totalPaise: 0 }));
    await failing(n({ reasonCode: 'UNKNOWN' }));
    await failing(n({ status: 'LOST' }));
    await failing(n({ approvalType: 'REFUND' }));
    await failing(
      n({
        noteType: 'DEBIT',
        approvalType: 'CREDIT_NOTE',
        reasonCode: 'INTEREST',
        status: 'ISSUED',
        noteNo: 'DN/2',
        noteDate: '2026-11-01',
      }),
    );
    await failing(n({ cgstPaise: 5, sgstPaise: 4 }));
    await failing(n({ roundOffPaise: 10 })); // credit notes carry no round-off
    await n({ approvalType: 'WRITE_OFF', reasonCode: 'WRITE_OFF' });
  });

  it('note numbers and dedupe keys are unique; a pending note is editable, an issued one only its PDF columns', async () => {
    const w = await billingWorld();
    const sid = w.society.id!;
    const u = w.unit(1).id;
    const inv = await rawInvoice(sid, u);
    const a = await rawNote(sid, inv.id!, u, { dedupeKey: 'LFEE:1' });
    await expect(rawNote(sid, inv.id!, u, { dedupeKey: 'LFEE:1' })).rejects.toThrow(
      /Validation|Duplicate|unique/i,
    );
    a.remarks = 'Edited while pending';
    await a.save();
    a.status = 'ISSUED';
    a.noteNo = 'CN/2026-27/000001';
    a.noteDate = '2026-11-01';
    a.version = 2;
    await a.save();
    await expect(
      rawNote(sid, inv.id!, u, { status: 'ISSUED', noteNo: 'CN/2026-27/000001', noteDate: '2026-11-01' }),
    ).rejects.toThrow(/Validation|Duplicate|unique/i);
    a.pdfStatus = 'READY';
    a.pdfFileId = 12;
    a.version = 3;
    await a.save();
    await a.reload();
    a.totalPaise = 1;
    await expect(a.save()).rejects.toThrow(/immutable.*totalPaise/);
    await a.reload();
    a.remarks = 'Edited after issue';
    await expect(a.save()).rejects.toThrow(/immutable/);
    await a.reload();
    await expect(a.destroy()).rejects.toThrow(/never deleted/);
  });
});

describe('unit_ledger_entries (7.11)', () => {
  it('exactly one of debit or credit is positive; enums are checked', async () => {
    const w = await billingWorld();
    const sid = w.society.id!;
    const u = w.unit(1).id;
    await rawLedger(sid, u);
    await rawLedger(sid, u, { debitPaise: 0, creditPaise: 5000, entryType: 'PAYMENT', refType: 'payment' });
    await failing(rawLedger(sid, u, { debitPaise: 0, creditPaise: 0 }));
    await failing(rawLedger(sid, u, { debitPaise: 5, creditPaise: 5 }));
    await failing(rawLedger(sid, u, { debitPaise: -5, creditPaise: 0 }));
    await failing(rawLedger(sid, u, { entryType: 'GIFT' as never }));
    await failing(rawLedger(sid, u, { refType: 'voucher' as never }));
  });

  it('(refType, refId, entryType) is unique, which makes posting idempotent', async () => {
    const w = await billingWorld();
    const sid = w.society.id!;
    const u = w.unit(1).id;
    await rawLedger(sid, u, { refId: 77 });
    await expect(rawLedger(sid, u, { refId: 77 })).rejects.toThrow(/Validation|Duplicate|unique/i);
    await rawLedger(sid, u, { refId: 77, entryType: 'DEBIT_NOTE' });
  });

  it('is append-only: no update, no delete, no updatedAt column', async () => {
    const w = await billingWorld();
    const e = await rawLedger(w.society.id!, w.unit(1).id);
    expect(Object.keys(UnitLedgerEntry.getAttributes())).not.toContain('updatedAt');
    e.narration = 'changed';
    await expect(e.save()).rejects.toThrow(/immutable/);
    await expect(e.destroy()).rejects.toThrow(/never deleted/);
    await expect(UnitLedgerEntry.update({ narration: 'x' }, { where: { id: e.id } })).rejects.toThrow(
      /immutable/,
    );
    await expect(UnitLedgerEntry.destroy({ where: { id: e.id } })).rejects.toThrow(/never deleted/);
  });
});

describe('opening_balances (7.12)', () => {
  it('INVALID rows may lack a flat; others need one; advance and arrears are exclusive', async () => {
    const w = await billingWorld();
    const sid = w.society.id!;
    const u = w.unit(1).id;
    await rawOpening(sid, { unitId: null, status: 'INVALID', validationError: 'Unknown flat' });
    await failing(rawOpening(sid, { unitId: null, status: 'DRAFT', importRowNo: 3 }));
    await rawOpening(sid, {
      unitId: u,
      status: 'DRAFT',
      importRowNo: 4,
      arrearsPrincipalPaise: 500_000,
      activeKey: `OB:${u}`,
    });
    await failing(
      rawOpening(sid, {
        unitId: w.unit(2).id,
        status: 'DRAFT',
        advancePaise: 100,
        arrearsInterestPaise: 5,
        importRowNo: 5,
      }),
    );
    await failing(
      rawOpening(sid, { unitId: w.unit(2).id, status: 'DRAFT', arrearsPrincipalPaise: -1, importRowNo: 5 }),
    );
    await failing(rawOpening(sid, { unitId: w.unit(2).id, status: 'PENDING' as never, importRowNo: 5 }));
    await rawOpening(sid, { unitId: w.unit(2).id, status: 'DRAFT', advancePaise: 200_000, importRowNo: 5 });
  });

  it('one DRAFT or POSTED row per flat (activeKey); DRAFT rows delete, POSTED rows do not', async () => {
    const w = await billingWorld();
    const sid = w.society.id!;
    const u = w.unit(1).id;
    const a = await rawOpening(sid, {
      unitId: u,
      status: 'DRAFT',
      activeKey: `OB:${u}`,
      arrearsPrincipalPaise: 1,
    });
    await expect(
      rawOpening(sid, {
        unitId: u,
        status: 'DRAFT',
        activeKey: `OB:${u}`,
        importRowNo: 9,
        arrearsPrincipalPaise: 1,
      }),
    ).rejects.toThrow(/Validation|Duplicate|unique/i);
    await a.destroy();
    const b = await rawOpening(sid, {
      unitId: u,
      status: 'POSTED',
      activeKey: `OB:${u}`,
      arrearsPrincipalPaise: 1,
    });
    await expect(b.destroy()).rejects.toThrow(/never deleted/);
    expect(await OpeningBalance.count({ where: { societyId: sid } })).toBe(1);
  });
});

describe('migration shape', () => {
  it('has no database FK to units, residents or files, and one to societies on every table', async () => {
    const fks = await sequelize.query<{ t: string; ref: string }>(
      `SELECT TABLE_NAME AS t, REFERENCED_TABLE_NAME AS ref FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
         AND TABLE_NAME IN ('charge_heads','bill_split_rules','billing_rules','billing_rule_versions','late_fee_policies',
           'billing_runs','invoices','billing_run_items','billing_notes','invoice_lines','unit_ledger_entries','opening_balances')`,
      { type: QueryTypes.SELECT },
    );
    expect(fks.filter(f => ['units', 'residents', 'files'].includes(f.ref))).toEqual([]);
    expect(new Set(fks.filter(f => f.ref === 'societies').map(f => f.t)).size).toBe(12);
  });
});
