import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BillingRule,
  BillingRuleVersion,
  BillingRun,
  BillingRunItem,
  ChargeHead,
  UnitLedgerEntry,
  closeDb,
  sequelize,
} from '../../../src/models';
import { residentPorts } from '../../../src/modules/residents/residents.ports';
import { setResidentPorts } from '../../../src/modules/residents/residents.public';
import { billingUnitGuard } from '../../../src/modules/billing/billing.ledger.hooks';
import { registerBilling } from '../../../src/modules/billing/billing.public';
import { drainQueues } from '../../../src/lib/queue';
import { unitLedger } from '../../../src/modules/billing/billing.public';
import { systemCtx, type Ctx } from '../../../src/types/context';
import { ledgerSociety, resetLedger, societyCtx } from '../../helpers/billing-ledger';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetLedger);

const post = (ctx: Ctx, unitId: number, o: Record<string, unknown>) =>
  sequelize.transaction(t =>
    unitLedger.post(
      ctx,
      {
        unitId,
        entryType: 'INVOICE',
        refType: 'invoice',
        refId: 1,
        debitPaise: 0,
        creditPaise: 0,
        date: '2026-11-01',
        narration: 'Bill',
        ...o,
      } as never,
      t,
    ),
  );

describe('unitLedger.post and balance (BR-11-57 to BR-11-59)', () => {
  it('T11-33 the same reference twice returns the same row; a different amount is 409 LEDGER_ENTRY_CONFLICT', async () => {
    const w = await ledgerSociety();
    const ctx = societyCtx(w.society);
    const a = await post(ctx, w.unit(1).id, { refId: 7, debitPaise: 538000 });
    const b = await post(ctx, w.unit(1).id, { refId: 7, debitPaise: 538000, narration: 'again' });
    expect(b.id).toBe(a.id);
    expect(await UnitLedgerEntry.count({ where: { societyId: w.society.id! } })).toBe(1);
    await expect(post(ctx, w.unit(1).id, { refId: 7, debitPaise: 538001 })).rejects.toMatchObject({
      status: 409,
      code: 'LEDGER_ENTRY_CONFLICT',
    });
    await expect(post(ctx, w.unit(2).id, { refId: 7, debitPaise: 538000 })).rejects.toMatchObject({
      code: 'LEDGER_ENTRY_CONFLICT',
    });
    await expect(post(ctx, w.unit(1).id, { refId: 7, creditPaise: 538000 })).rejects.toMatchObject({
      code: 'LEDGER_ENTRY_CONFLICT',
    });
  });

  it('the same refId under another entry type is another entry (the key includes the entry type)', async () => {
    const w = await ledgerSociety();
    const ctx = societyCtx(w.society);
    const a = await post(ctx, w.unit(1).id, { refId: 9, debitPaise: 1000 });
    const b = await post(ctx, w.unit(1).id, {
      entryType: 'CREDIT_NOTE',
      refType: 'billing_note',
      refId: 9,
      creditPaise: 400,
    });
    expect(b.id).not.toBe(a.id);
    expect(await unitLedger.balance(w.society.id!, w.unit(1).id)).toBe(600);
  });

  it('two parallel posts of one reference leave one row', async () => {
    const w = await ledgerSociety();
    const ctx = societyCtx(w.society);
    const ids = await Promise.all([
      post(ctx, w.unit(1).id, { refId: 11, debitPaise: 500 }),
      post(ctx, w.unit(1).id, { refId: 11, debitPaise: 500 }),
      post(ctx, w.unit(1).id, { refId: 11, debitPaise: 500 }),
    ]);
    expect(new Set(ids.map(i => i.id)).size).toBe(1);
    expect(await UnitLedgerEntry.count({ where: { societyId: w.society.id!, refId: 11 } })).toBe(1);
  });

  it('balance is debits minus credits: positive dues, negative advance, per flat and per society', async () => {
    const w = await ledgerSociety();
    const other = await ledgerSociety();
    const ctx = societyCtx(w.society);
    expect(await unitLedger.balance(w.society.id!, w.unit(1).id)).toBe(0);
    await post(ctx, w.unit(1).id, { refId: 1, debitPaise: 538000 });
    await post(ctx, w.unit(1).id, {
      entryType: 'PAYMENT',
      refType: 'payment',
      refId: 1,
      creditPaise: 538000,
    });
    await post(ctx, w.unit(1).id, { entryType: 'PAYMENT', refType: 'payment', refId: 2, creditPaise: 50000 });
    await post(ctx, w.unit(2).id, { refId: 2, debitPaise: 12345 });
    expect(await unitLedger.balance(w.society.id!, w.unit(1).id)).toBe(-50000);
    expect(await unitLedger.balance(w.society.id!, w.unit(2).id)).toBe(12345);
    expect(await unitLedger.balance(w.society.id!, w.unit(3).id)).toBe(0);
    expect(await unitLedger.balance(other.society.id!, w.unit(1).id)).toBe(0); // another society never sees it
  });

  it('balance can be read inside a transaction before it commits', async () => {
    const w = await ledgerSociety();
    const ctx = societyCtx(w.society);
    await sequelize.transaction(async t => {
      await unitLedger.post(
        ctx,
        {
          unitId: w.unit(1).id,
          entryType: 'INVOICE',
          refType: 'invoice',
          refId: 3,
          debitPaise: 700,
          creditPaise: 0,
          date: '2026-11-01',
          narration: 'x',
        },
        t,
      );
      expect(
        await (unitLedger.balance as (a: number, b: number, t?: unknown) => Promise<number>)(
          w.society.id!,
          w.unit(1).id,
          t,
        ),
      ).toBe(700);
    });
  });

  it('refuses both amounts, no amount, negative, fractional and unsafe amounts', async () => {
    const w = await ledgerSociety();
    const ctx = societyCtx(w.society);
    for (const o of [
      { debitPaise: 10, creditPaise: 10 },
      { debitPaise: 0, creditPaise: 0 },
      { debitPaise: -5 },
      { debitPaise: 10.5 },
      { debitPaise: Number.MAX_SAFE_INTEGER + 2 },
    ])
      await expect(post(ctx, w.unit(1).id, { refId: 20, ...o })).rejects.toMatchObject({
        status: 422,
        code: 'LEDGER_ENTRY_INVALID',
      });
    expect(await UnitLedgerEntry.count({ where: { societyId: w.society.id! } })).toBe(0);
  });

  it('validates the entry type and reference type pair (BR-11-58)', async () => {
    const w = await ledgerSociety();
    const ctx = societyCtx(w.society);
    const bad: [string, string][] = [
      ['PAYMENT', 'invoice'],
      ['PAYMENT_REVERSAL', 'refund'],
      ['REFUND', 'payment'],
      ['INVOICE', 'billing_note'],
      ['CREDIT_NOTE', 'invoice'],
      ['OPENING_BALANCE', 'invoice'],
      ['NOPE', 'invoice'],
    ];
    for (const [entryType, refType] of bad)
      await expect(
        post(ctx, w.unit(1).id, { entryType, refType, refId: 30, debitPaise: 10 }),
      ).rejects.toMatchObject({
        code: 'LEDGER_ENTRY_INVALID',
      });
    for (const [entryType, refType] of [
      ['PAYMENT', 'payment'],
      ['PAYMENT_REVERSAL', 'payment'],
      ['REFUND', 'refund'],
      ['DEBIT_NOTE', 'billing_note'],
      ['OPENING_BALANCE', 'opening_balance'],
      ['ADJUSTMENT', 'opening_balance'],
    ] as const)
      await post(ctx, w.unit(1).id, { entryType, refType, refId: 31, debitPaise: 10 });
  });

  it('refuses a bad date, an empty or long narration, a bad id', async () => {
    const w = await ledgerSociety();
    const ctx = societyCtx(w.society);
    for (const o of [
      { date: '2026-02-30' },
      { date: '01-11-2026' },
      { narration: '  ' },
      { narration: 'x'.repeat(301) },
      { refId: 0 },
    ])
      await expect(post(ctx, w.unit(1).id, { debitPaise: 10, ...o })).rejects.toMatchObject({
        code: 'LEDGER_ENTRY_INVALID',
      });
  });

  it('a unit of another society or an unknown unit is 404 UNIT_NOT_FOUND', async () => {
    const w = await ledgerSociety();
    const other = await ledgerSociety();
    await expect(post(societyCtx(w.society), other.unit(1).id, { debitPaise: 10 })).rejects.toMatchObject({
      status: 404,
      code: 'UNIT_NOT_FOUND',
    });
    await expect(post(societyCtx(w.society), 99999999, { debitPaise: 10 })).rejects.toMatchObject({
      code: 'UNIT_NOT_FOUND',
    });
    await expect(post(systemCtx('job'), 99999999, { debitPaise: 10 })).rejects.toMatchObject({
      code: 'UNIT_NOT_FOUND',
    });
  });

  it('a system context without a society uses the unit own society', async () => {
    const w = await ledgerSociety();
    const r = await post(systemCtx('job') as never, w.unit(2).id, { refId: 40, debitPaise: 90 });
    const row = (await UnitLedgerEntry.findByPk(r.id))!;
    expect(Number(row.societyId)).toBe(w.society.id);
    expect(row.createdBy).toBeNull();
  });

  it('the creator is the caller; the entry date and narration are stored as given', async () => {
    const w = await ledgerSociety();
    const r = await post(societyCtx(w.society, w.user.id!), w.unit(1).id, {
      refId: 50,
      debitPaise: 25,
      date: '2026-10-31',
      narration: ' Bill INV/2026-27/000150 (Nov 2026) ',
    });
    const row = (await UnitLedgerEntry.findByPk(r.id))!;
    expect(row.entryDate).toBe('2026-10-31');
    expect(row.narration).toBe('Bill INV/2026-27/000150 (Nov 2026)');
    expect(Number(row.createdBy)).toBe(w.user.id);
  });

  it('entries are immutable: update and delete throw', async () => {
    const w = await ledgerSociety();
    const r = await post(societyCtx(w.society), w.unit(1).id, { refId: 60, debitPaise: 25 });
    const row = (await UnitLedgerEntry.findByPk(r.id))!;
    await expect(row.update({ debitPaise: 1 })).rejects.toThrow(/immutable/);
    await expect(row.destroy()).rejects.toThrow(/never deleted/);
    await expect(UnitLedgerEntry.destroy({ where: { id: r.id } })).rejects.toThrow(/never deleted/);
    await expect(UnitLedgerEntry.update({ narration: 'x' }, { where: { id: r.id } })).rejects.toThrow(
      /immutable/,
    );
    expect(Number((await UnitLedgerEntry.findByPk(r.id))!.debitPaise)).toBe(25);
  });

  it('a rolled-back transaction leaves no entry', async () => {
    const w = await ledgerSociety();
    await expect(
      sequelize.transaction(async t => {
        await unitLedger.post(
          societyCtx(w.society),
          {
            unitId: w.unit(1).id,
            entryType: 'INVOICE',
            refType: 'invoice',
            refId: 70,
            debitPaise: 5,
            creditPaise: 0,
            date: '2026-11-01',
            narration: 'x',
          },
          t,
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await unitLedger.balance(w.society.id!, w.unit(1).id)).toBe(0);
  });
});

describe('module 08 and 09 wiring of registerBilling (section 5.13, 9.2)', () => {
  const ledgerOf = (
    w: Awaited<ReturnType<typeof ledgerSociety>>,
    unitId: number,
    debit: number,
    credit = 0,
    refId = 1,
  ) =>
    post(societyCtx(w.society), unitId, {
      refId,
      debitPaise: debit,
      creditPaise: credit,
      ...(credit ? { entryType: 'PAYMENT', refType: 'payment' } : {}),
    });

  it('module 09 duesPaise is the real ledger balance (the placeholder returned 0)', async () => {
    const w = await ledgerSociety();
    setResidentPorts(); // placeholder again: always 0
    expect(await residentPorts().unitLedger.balance(w.society.id!, w.unit(1).id)).toBe(0);
    registerBilling();
    await ledgerOf(w, w.unit(1).id, 538000);
    await ledgerOf(w, w.unit(2).id, 0, 7000, 2);
    expect(await residentPorts().unitLedger.balance(w.society.id!, w.unit(1).id)).toBe(538000);
    expect((await w.c('get', `/residents/units/${w.unit(1).id}`)).body.data.duesPaise).toBe(538000);
    const list = (await w.c('get', '/residents/units')).body.data as { unitId: number; duesPaise: number }[];
    expect(list.find(u => u.unitId === w.unit(1).id)!.duesPaise).toBe(538000);
    expect(list.find(u => u.unitId === w.unit(2).id)!.duesPaise).toBe(-7000);
    expect(list.find(u => u.unitId === w.unit(3).id)!.duesPaise).toBe(0);
    const owing = await w.c('get', '/residents/units', undefined, { query: { hasDues: 'true' } });
    expect(owing.body.data.map((u: any) => u.unitId)).toContain(w.unit(1).id);
  });

  const archive = (w: Awaited<ReturnType<typeof ledgerSociety>>, i: number) =>
    w.c('post', `/units/${w.unit(i).id}/archive`, {
      version: 1,
      reason: 'Merged with the next flat',
    });

  it('T11-38 UNIT_HAS_BALANCE blocks the archive of a flat with dues or an advance; a settled flat can go', async () => {
    const w = await ledgerSociety();
    await ledgerOf(w, w.unit(1).id, 538000);
    await ledgerOf(w, w.unit(2).id, 0, 100, 2);
    for (const i of [1, 2]) {
      const r = await archive(w, i);
      expect([r.status, r.body.code]).toEqual([409, 'UNIT_ARCHIVE_BLOCKED']);
      expect(r.body.errors.map((e: any) => [e.message, e.module])).toContainEqual([
        'UNIT_HAS_BALANCE',
        'billing',
      ]);
    }
    // paid in full: balance 0
    await ledgerOf(w, w.unit(1).id, 0, 538000, 3);
    expect((await archive(w, 1)).status).toBe(200);
    expect((await archive(w, 3)).status).toBe(200);
  });

  it('a READY run item blocks the archive until the run is ISSUED, CANCELLED or FAILED', async () => {
    const w = await ledgerSociety();
    const run = await BillingRun.create({
      societyId: w.society.id!,
      runLabel: 'BR-2026-11',
      runType: 'REGULAR',
      cycle: 'MONTHLY',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      billDate: '2026-11-01',
      scopeType: 'ALL_UNITS',
      status: 'PREVIEW',
      activeKey: 'REG:2026-11-01',
      totalPaise: 0,
      version: 1,
    } as never);
    const item = await BillingRunItem.create({
      societyId: w.society.id!,
      billingRunId: run.id!,
      unitId: w.unit(1).id,
      unitLabel: w.unit(1).label,
      itemKey: `${w.unit(1).id}:0`,
      status: 'READY',
      linesSnapshot: [],
      version: 1,
    } as never);
    const blocked = await archive(w, 1);
    expect([blocked.status, blocked.body.code]).toEqual([409, 'UNIT_ARCHIVE_BLOCKED']);
    expect(blocked.body.errors.map((e: any) => e.message)).toContain('UNIT_HAS_BALANCE');
    const guard = (action: 'ARCHIVE' | 'DELETE') =>
      sequelize.transaction(t => billingUnitGuard(w.society.id!, w.unit(1).id, action, t));
    expect(await guard('ARCHIVE')).toBe('UNIT_HAS_BALANCE');
    expect(await guard('DELETE')).toBe('UNIT_HAS_BALANCE');
    for (const status of ['ISSUED', 'CANCELLED', 'FAILED']) {
      await run.update({ status, activeKey: null } as never);
      expect(await guard('ARCHIVE'), status).toBeNull();
      await run.update({ status: 'PREVIEW', activeKey: 'REG:2026-11-01' } as never);
    }
    await item.update({ status: 'EXCLUDED' } as never);
    expect(await guard('ARCHIVE')).toBeNull();
    expect((await archive(w, 1)).status).toBe(200);
  });

  it('T11-39 the BILLING onboarding check: not done, then done after the first approved rule', async () => {
    const w = await ledgerSociety();
    const other = await ledgerSociety();
    const step = async () =>
      ((await w.c('get', '/onboarding')).body.data.steps as any[]).find(x => x.stepKey === 'BILLING');
    expect(await step()).toMatchObject({ checkState: 'FAIL', summary: 'No approved billing rule yet' });
    const head = await ChargeHead.create({
      societyId: w.society.id!,
      key: 'MAINTENANCE',
      name: 'Maintenance',
      description: null,
      headType: 'MAINTENANCE',
      payerRouting: 'BILL_TO',
      gstTreatment: 'NONE',
      sacCode: null,
      prorate: true,
      interestBearing: true,
      ledgerAccountCode: '4100',
      fundId: null,
      isSystem: false,
      status: 'ACTIVE',
      sortOrder: 1,
      createdBy: null,
      updatedBy: null,
      version: 1,
    });
    const rule = await BillingRule.create({
      societyId: w.society.id!,
      chargeHeadId: head.id!,
      name: 'Maintenance',
      scopeType: 'ALL_UNITS',
      scopeValues: null,
      status: 'ACTIVE',
      sortOrder: 1,
      createdBy: null,
      updatedBy: null,
      version: 1,
    });
    const version = (status: string) =>
      BillingRuleVersion.create({
        societyId: w.society.id!,
        billingRuleId: rule.id!,
        versionNo: status === 'APPROVED' ? 2 : 1,
        rateType: 'FLAT_PER_UNIT',
        amountPaise: 350000,
        ratePerSqftPaise: null,
        unitTypeRates: null,
        meterType: null,
        slabs: null,
        minimumChargePaise: null,
        missingReadingPolicy: null,
        billSplitRuleId: null,
        percent: null,
        baseChargeHeadIds: null,
        effectiveFrom: '2026-04-01',
        effectiveTo: null,
        status,
        reason: 'Initial rate',
        resolutionRef: null,
        approvalRequestId: null,
        approvedBy: null,
        approvedAt: null,
        rejectedReason: null,
        createdBy: null,
        updatedBy: null,
      } as never);
    await version('PENDING_APPROVAL'); // a rule with only a pending version is not approved
    expect((await step()).summary).toBe('No approved billing rule yet');
    await version('APPROVED');
    expect(await step()).toMatchObject({ checkState: 'PASS', summary: '1 billing rule approved' });
    await rule.update({ status: 'ARCHIVED' });
    expect((await step()).summary).toBe('No approved billing rule yet');
    await rule.update({ status: 'ACTIVE' });
    await head.update({ status: 'ARCHIVED' });
    expect((await step()).checkState).toBe('FAIL'); // no ACTIVE charge head
    void other;
  });
});
