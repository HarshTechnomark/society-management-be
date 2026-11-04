import { Invoice, InvoiceLine, Society } from '../../src/models';
import { drainQueues } from '../../src/lib/queue';
import { systemCtx, type Ctx } from '../../src/types/context';
import { setBillingPorts } from '../../src/modules/billing/billing.ports';
import { invoices } from '../../src/modules/billing/billing.invoices.service';
import { registerBillingInvoices } from '../../src/modules/billing/billing.pdf.jobs';
import { sequelize } from '../../src/models';
import { addOwner, idemH, resetRuns, runSociety, standardRules, type RunSociety } from './billing-runs';

export { idemH, addOwner, runSociety };
export type { RunSociety };

/** Fresh state for the 11.4 tests: the 11.3 reset plus the invoice job and approval types. Call from `beforeEach`. */
export async function resetInvoices(): Promise<void> {
  await resetRuns();
  registerBillingInvoices();
}

/** A society with an owner on every flat and the standard heads (and rules for the heads). */
export async function invoiceWorld(o: Parameters<typeof runSociety>[0] = {}): Promise<RunSociety> {
  const w = await runSociety(o);
  for (const u of w.units) await addOwner(w.society.id!, u.id, `Owner of ${u.label}`);
  await standardRules(w.society.id!, w.heads, []);
  return w;
}

/** A context of a signed-in member of the society, for calling hooks and services directly. */
export const ctxFor = (w: RunSociety, userId: number, permissions: string[] = []): Ctx => ({
  ...systemCtx('t'),
  user: { id: userId, name: 'Decider', mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' },
  society: { id: w.society.id!, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
  permissions: new Set(permissions),
});
export const sysCtx = (w: RunSociety): Ctx => ({
  ...systemCtx('t'),
  society: { id: w.society.id!, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
});

export interface AdHocLine {
  head: string;
  amountPaise: number;
  description?: string;
}

/** POST /invoices as the chairman; returns the response. */
export async function postAdHoc(
  w: RunSociety,
  unitIndex: number,
  lines: AdHocLine[],
  o: { dueDate?: string; description?: string } = {},
) {
  return w.c(
    'post',
    '/invoices',
    {
      unitId: w.units[unitIndex]!.id,
      lines: lines.map(l => ({
        chargeHeadId: w.heads[l.head]!.id,
        description: l.description ?? `${l.head} charge`,
        amountPaise: l.amountPaise,
      })),
      dueDate: o.dueDate ?? '2026-11-20',
      description: o.description ?? 'Test bill',
    },
    { headers: idemH() },
  );
}

/** An ad-hoc invoice of the parking head and the maintenance head (a typical two-line bill); returns the 8.12 body. */
export async function makeInvoice(
  w: RunSociety,
  unitIndex = 0,
  lines: AdHocLine[] = [
    { head: 'MAINTENANCE', amountPaise: 368_000 },
    { head: 'PARKING', amountPaise: 50_000 },
    { head: 'WATER', amountPaise: 35_000 },
  ],
) {
  const r = await postAdHoc(w, unitIndex, lines);
  if (r.status !== 201) throw new Error(`makeInvoice ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as any;
}

/** Module 12 stand-in: allocates a payment to an invoice (as `payments` would, inside its own transaction). */
export const pay = (w: RunSociety, invoiceId: number, amountPaise: number) =>
  sequelize.transaction(t => invoices.applyAllocation(sysCtx(w), invoiceId, amountPaise, t));

/** Module 12 stand-in for `onInvoiceCancelled`: releases every allocation of the invoice through `reverseAllocation`. */
export function module12ReleasesOnCancel(w: RunSociety): { calls: number[] } {
  const seen = { calls: [] as number[] };
  setBillingPorts({
    payments: {
      onInvoiceCancelled: async (_ctx, invoiceId, t) => {
        seen.calls.push(invoiceId);
        const inv = await Invoice.findByPk(invoiceId, { transaction: t });
        const paid = Number(inv?.paidPaise ?? 0);
        if (paid > 0) await invoices.reverseAllocation(sysCtx(w), invoiceId, paid, t);
      },
    },
  });
  return seen;
}

export async function lineOf(invoiceId: number, kind: string, headKey?: string): Promise<InvoiceLine> {
  const lines = await InvoiceLine.findAll({ where: { invoiceId }, order: [['lineNo', 'ASC']] });
  return lines.find(l => l.lineKind === kind && (headKey === undefined || l.headKey === headKey))!;
}

export const setGst = async (w: RunSociety, gstin = '27AAAAS1234A1Z5') => {
  await Society.update({ gstin } as never, { where: { id: w.society.id! } });
};

export const settle = () => drainQueues();
