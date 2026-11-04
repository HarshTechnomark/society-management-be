import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Invoice, closeDb } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { drainQueues, tickScheduler } from '../../../src/lib/queue';
import { billingPortCalls } from '../../../src/modules/billing/billing.ports';
import {
  runDueReminders,
  OVERDUE_REMINDER_OFFSETS,
} from '../../../src/modules/billing/billing.reminders.service';
import { idemKey, memberOf } from '../../helpers/society-setup';
import { residentUser } from '../../helpers/residents';
import { duesWorld, makeInvoice, resetDues, type DuesWorld } from '../../helpers/billing-dues';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetDues);

const sends = (template?: string) =>
  billingPortCalls
    .filter(c => c.fn === 'notifications.send')
    .map(c => c.input as { template: string; userIds: number[]; data: Record<string, any> })
    .filter(i => !template || i.template === template);

/** A flat whose bill-to resident has a login. */
async function loginWorld(
  flats = 1,
): Promise<DuesWorld & { userIds: number[]; residents: { residentId: number; name: string }[] }> {
  const w = await duesWorld(flats);
  const userIds: number[] = [];
  const residents: { residentId: number; name: string }[] = [];
  for (const u of w.units) {
    const r = await residentUser(w.society, u.id, { name: `Payer ${u.label}`, relation: 'CO_OWNER' });
    userIds.push(r.user.id!);
    residents.push({ residentId: r.resident.id!, name: r.resident.name });
  }
  return { ...w, userIds, residents };
}
const day = (n: number): string =>
  new Date(Date.parse('2026-11-04T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

describe('manual reminder of one invoice (8.18, BR-11-63)', () => {
  it('sends billing.invoice_reminder to the bill-to user, counts it, audits it; a second one within 24 hours is 409 REMINDER_TOO_SOON', async () => {
    const w = await loginWorld();
    const inv = await makeInvoice(w, { unit: w.units[0]!, billTo: w.residents[0]!, dueDate: day(-5) });
    const r = await w.c('post', `/invoices/${inv.id}/remind`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.sentAt).toBe('2026-11-04T04:30:00.000Z');
    expect(sends('billing.invoice_reminder')).toHaveLength(1);
    expect(sends('billing.invoice_reminder')[0]!.userIds).toContain(w.userIds[0]);
    expect(sends('billing.invoice_reminder')[0]!.data).toMatchObject({
      invoiceNo: inv.invoiceNo,
      amountPaise: 800_000,
    });
    const fresh = (await Invoice.findByPk(inv.id!))!;
    expect(fresh.reminderCount).toBe(1);
    expect(
      await AuditLog.count({ where: { action: 'billing.invoice.reminded', entityId: String(inv.id) } }),
    ).toBe(1);
    const again = await w.c('post', `/invoices/${inv.id}/remind`, {});
    expect(again.status).toBe(409);
    expect(again.body.code ?? again.body.error?.code).toBe('REMINDER_TOO_SOON');
    await Invoice.update({ lastReminderAt: new Date('2026-11-03T03:00:00Z') }, { where: { id: inv.id! } }); // 25 hours ago
    expect((await w.c('post', `/invoices/${inv.id}/remind`, {})).status).toBe(200);
  });

  it('a paid invoice is 409 INVALID_STATE, an unknown or other society id is 404, body keys are refused, a Secretary (view only) is 403', async () => {
    const w = await loginWorld();
    const paid = await makeInvoice(w, {
      unit: w.units[0]!,
      billTo: w.residents[0]!,
      paidPaise: 800_000,
      settledOn: '2026-09-02',
    });
    const r = await w.c('post', `/invoices/${paid.id}/remind`, {});
    expect(r.status).toBe(409);
    expect(r.body.code ?? r.body.error?.code).toBe('INVALID_STATE');
    expect((await w.c('post', '/invoices/99999999/remind', {})).status).toBe(404);
    expect((await w.c('post', `/invoices/${paid.id}/remind`, { x: 1 })).status).toBe(400);
    const sec = await memberOf(w.society, 'secretary');
    expect((await sec.c('post', `/invoices/${paid.id}/remind`, {})).status).toBe(403);
    expect(sends()).toHaveLength(0);
  });
});

describe('bulk reminder of all overdue invoices (8.18)', () => {
  it('returns 202 { flats, invoices } and billing:send-reminders sends them; disputed, not overdue and recently reminded are skipped', async () => {
    const w = await loginWorld(4);
    const [a, b, c, d] = w.units;
    const i1 = await makeInvoice(w, { unit: a!, billTo: w.residents[0]!, dueDate: day(-5) });
    await makeInvoice(w, { unit: b!, billTo: w.residents[1]!, dueDate: day(-9), isDisputed: true });
    await makeInvoice(w, { unit: c!, billTo: w.residents[2]!, dueDate: day(10) });
    const i4 = await makeInvoice(w, { unit: d!, billTo: w.residents[3]!, dueDate: day(-2) });
    await Invoice.update(
      { lastReminderAt: new Date('2026-11-04T01:00:00Z'), reminderCount: 1 },
      { where: { id: i4.id! } },
    );
    const r = await w.c(
      'post',
      '/billing/reminders',
      { scope: 'OVERDUE' },
      { headers: { 'Idempotency-Key': idemKey()['Idempotency-Key']! } },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.data).toEqual({ flats: 1, invoices: 1 });
    await drainQueues();
    expect(sends('billing.invoice_reminder')).toHaveLength(1);
    expect((await Invoice.findByPk(i1.id!))!.reminderCount).toBe(1);
    expect(
      await AuditLog.count({ where: { action: 'billing.reminders.bulk_sent', societyId: w.society.id! } }),
    ).toBe(1);
  });

  it('needs an Idempotency-Key, finance.billing.edit and a valid body; a building filter narrows it', async () => {
    const w = await loginWorld(1);
    await makeInvoice(w, { unit: w.units[0]!, billTo: w.residents[0]!, dueDate: day(-5) });
    expect((await w.c('post', '/billing/reminders', { scope: 'OVERDUE' })).status).toBe(400);
    const h = { headers: { 'Idempotency-Key': idemKey()['Idempotency-Key']! } };
    expect((await w.c('post', '/billing/reminders', { scope: 'ALL' }, h)).status).toBe(400);
    const sec = await memberOf(w.society, 'secretary');
    expect(
      (await sec.c('post', '/billing/reminders', { scope: 'OVERDUE' }, { headers: idemKey() })).status,
    ).toBe(403);
    const other = await w.c(
      'post',
      '/billing/reminders',
      { scope: 'OVERDUE', buildingId: w.buildingId + 999 },
      { headers: idemKey() },
    );
    expect(other.body.data).toEqual({ flats: 0, invoices: 0 });
    const mine = await w.c(
      'post',
      '/billing/reminders',
      { scope: 'OVERDUE', buildingId: w.buildingId },
      { headers: idemKey() },
    );
    expect(mine.body.data).toEqual({ flats: 1, invoices: 1 });
  });
});

describe('automatic reminders (billing:due-reminders, BR-11-63)', () => {
  it('due soon goes out 3 days before the due date, once a day', async () => {
    const w = await loginWorld();
    await makeInvoice(w, {
      unit: w.units[0]!,
      billTo: w.residents[0]!,
      dueDate: day(3),
      invoiceDate: '2026-11-01',
    });
    expect(await runDueReminders(w.society.id!)).toEqual({ dueSoon: 1, overdue: 0 });
    expect(await runDueReminders(w.society.id!)).toEqual({ dueSoon: 0, overdue: 0 });
    expect(sends('billing.invoice_due_soon')).toHaveLength(1);
  });

  it('overdue goes out on due + 1 and every 7 days after, at most 4 times', async () => {
    const w = await loginWorld();
    const inv = await makeInvoice(w, { unit: w.units[0]!, billTo: w.residents[0]!, dueDate: '2026-10-01' });
    expect(OVERDUE_REMINDER_OFFSETS).toEqual([1, 8, 15, 22]);
    const fired: number[] = [];
    for (let off = 0; off <= 40; off++) {
      const today = new Date(Date.parse('2026-10-01T00:00:00Z') + off * 86_400_000)
        .toISOString()
        .slice(0, 10);
      setNow(`${today}T05:00:00Z`);
      const r = await runDueReminders(w.society.id!, today);
      if (r.overdue) fired.push(off);
    }
    expect(fired).toEqual([1, 8, 15, 22]);
    expect(sends('billing.invoice_overdue')).toHaveLength(4);
    expect((await Invoice.findByPk(inv.id!))!.reminderCount).toBe(4);
  });

  it('disputed and paid invoices get no automatic reminders', async () => {
    const w = await loginWorld(2);
    await makeInvoice(w, { unit: w.units[0]!, billTo: w.residents[0]!, dueDate: day(-1), isDisputed: true });
    await makeInvoice(w, {
      unit: w.units[1]!,
      billTo: w.residents[1]!,
      dueDate: day(-1),
      paidPaise: 800_000,
      settledOn: '2026-11-02',
    });
    expect(await runDueReminders(w.society.id!)).toEqual({ dueSoon: 0, overdue: 0 });
  });

  it('the job runs daily at 09:00 IST for every society', async () => {
    const w = await loginWorld();
    await makeInvoice(w, { unit: w.units[0]!, billTo: w.residents[0]!, dueDate: day(-1) });
    setNow('2026-11-04T03:30:00Z'); // 09:00 IST
    await tickScheduler();
    await drainQueues();
    expect(sends('billing.invoice_overdue')).toHaveLength(1);
  });
});
