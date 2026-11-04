import { afterEach, describe, expect, it } from 'vitest';
import {
  assertBillingPortsReady,
  billingPortCalls,
  billingPorts,
  clearMeterSources,
  fakePortsInUse,
  registerMeterSource,
  requireMeterSource,
  setBillingPorts,
} from '../../../src/modules/billing/billing.ports';
import { invoices, meterSources, unitLedger } from '../../../src/modules/billing/billing.public';
import { fundResolvers } from '../../../src/modules/billing/billing.invoices.service';
import { systemCtx } from '../../../src/types/context';
import { FINANCIAL_FILE_PURPOSES } from '../../../src/modules/societies/societies.purge';
import { INVOICE_PDF_PURPOSE } from '../../../src/modules/billing/billing.constants';
import { GST_RATE_PCT, VARIANCE_WARN_PCT } from '../../../src/modules/billing/billing.constants';

afterEach(() => {
  setBillingPorts();
  clearMeterSources();
});

describe('placeholder ports (section 1.1)', () => {
  it('the journal fake refuses unbalanced entries and records balanced ones', async () => {
    const t = {} as never;
    const line = (d: number, c: number) => ({ accountCode: '4100', debitPaise: d, creditPaise: c });
    await expect(
      billingPorts().journal.post(
        systemCtx(),
        {
          date: '2026-11-01',
          voucherType: 'INVOICE',
          refType: 'invoice',
          refId: 1,
          narration: 'x',
          lines: [line(5, 0), line(0, 4)],
        },
        t,
      ),
    ).rejects.toThrow(/does not balance/);
    const r = await billingPorts().journal.post(
      systemCtx(),
      {
        date: '2026-11-01',
        voucherType: 'INVOICE',
        refType: 'invoice',
        refId: 1,
        narration: 'x',
        lines: [line(5, 0), line(0, 5)],
      },
      t,
    );
    expect(r.id).toBeGreaterThan(0);
    expect(billingPortCalls.map(c => c.fn)).toEqual(['journal.post']);
  });

  it('the chart check only validates the code format until module 13 exists', async () => {
    const j = billingPorts().journal;
    expect(await j.accountExists(1, '4100')).toBe(true);
    expect(await j.accountExists(1, '4100-001')).toBe(true);
    expect(await j.accountExists(1, 'COLLECTION_FUND')).toBe(true);
    expect(await j.accountExists(1, 'x1')).toBe(false);
    expect(await j.isDateLocked(1, '2026-11-01')).toBe(false);
  });

  it('safe production defaults: no advance, no allocations, no meter source', async () => {
    const p = billingPorts();
    expect(await p.payments.advanceBalance(1, 1)).toBe(0);
    expect(
      await p.payments.applyAdvanceToInvoice(
        systemCtx(),
        { unitId: 1, invoiceId: 1, outstandingPaise: 5 },
        {} as never,
      ),
    ).toEqual({
      appliedPaise: 0,
    });
    expect(await p.payments.listAllocationsForInvoice(1, 1)).toEqual([]);
    expect(() => requireMeterSource('WATER')).toThrow(/Metered billing is not available/);
    try {
      requireMeterSource('WATER');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('METER_SOURCE_NOT_AVAILABLE');
      expect((e as { status?: number }).status).toBe(422);
    }
  });

  it('module 21 registers a meter source through meterSources.register', async () => {
    const src = { consumptionForPeriod: async () => new Map() };
    meterSources.register('WATER', src);
    expect(requireMeterSource('WATER')).toBe(src);
    expect(() => requireMeterSource('GAS')).toThrow();
    registerMeterSource('GAS', src);
    expect(billingPorts().meters.getSource('GAS')).toBe(src);
  });

  it('the approvals fake returns a pending request and records the call', async () => {
    const r = await billingPorts().approvals.request(
      systemCtx(),
      { type: 'BILLING_RUN_PUBLISH', entityType: 'billing_run', entityId: 1, title: 'Run' },
      {} as never,
    );
    expect(r.status).toBe('PENDING');
    expect(billingPortCalls[0]!.fn).toBe('approvals.request');
  });
});

describe('production start-up check (section 1.1)', () => {
  it('refuses to start in production while approvals, journal or notifications are placeholders', () => {
    expect(fakePortsInUse().sort()).toEqual(['approvals', 'journal', 'notifications']);
    expect(() => assertBillingPortsReady('production')).toThrow(/approvals, journal, notifications/);
    expect(() => assertBillingPortsReady('development')).not.toThrow();
    expect(() => assertBillingPortsReady('test')).not.toThrow();
  });

  it('passes once the real modules replaced the three ports; payments and meters may stay placeholders', () => {
    setBillingPorts({ approvals: {}, journal: {} });
    expect(() => assertBillingPortsReady('production')).toThrow(/notifications/);
    setBillingPorts({ notifications: { send: async () => undefined } });
    expect(fakePortsInUse()).toEqual([]);
    expect(() => assertBillingPortsReady('production')).not.toThrow();
  });

  it('setBillingPorts() with no argument restores the placeholders', () => {
    setBillingPorts({ approvals: {}, journal: {}, notifications: {} });
    setBillingPorts();
    expect(fakePortsInUse()).toHaveLength(3);
  });
});

describe('public placeholders (section 8.24)', () => {
  it('exports the fixed names; bodies throw not implemented until the sub-modules fill them', async () => {
    expect(Object.keys(unitLedger).sort()).toEqual(['balance', 'post']);
    expect(Object.keys(invoices).sort()).toEqual(
      [
        'applyAllocation',
        'billedForMonth',
        'cancelBySource',
        'createAdHoc',
        'creditBySource',
        'get',
        'listOpen',
        'registerFundResolver',
        'requestCancel',
        'reverseAllocation',
        'setDisputed',
      ].sort(),
    );
    expect(Object.keys(meterSources)).toEqual(['register']);
  });

  it('registerFundResolver stores the resolver', async () => {
    const fn = async () => 5;
    invoices.registerFundResolver('collection_request', fn);
    expect(fundResolvers.get('collection_request')).toBe(fn);
    fundResolvers.clear();
  });
});

describe('constants and cross-module items (section 17)', () => {
  it('INVOICE_PDF is a financial file purpose kept by the module 05 purge (BR-05-21)', () => {
    expect(FINANCIAL_FILE_PURPOSES).toContain(INVOICE_PDF_PURPOSE);
  });

  it('GST and variance constants', () => {
    expect(GST_RATE_PCT).toBe('18.0000');
    expect(VARIANCE_WARN_PCT).toBe(25);
  });
});
