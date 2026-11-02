import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, DunningEvent, PlatformInvoice, Society, closeDb, sequelize } from '../../../src/models';
import { advance, setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { runDunning } from '../../../src/modules/platform-billing/platform-billing.dunning';
import { inboxFor } from '../../helpers/auth';
import { billedSociety, platformTeam, resetBilling } from '../../helpers/billing';

/** Task 6.4: write-off with maker-checker (BR-06-34, 8.17; T06-29) and manual reminders (BR-06-42, 8.15). */
beforeEach(async () => {
  await resetBilling();
});
afterAll(async () => {
  await drainQueues();
  setNow(null);
  await closeDb();
});

async function setup() {
  const s = await billedSociety();
  return { ...s, ...(await platformTeam()) };
}
const reason = 'Society dissolved; amount is uncollectable';
const reload = async (id: number) => (await PlatformInvoice.findByPk(id))!;

describe('write-off (8.17)', () => {
  it('T06-29 a PAID invoice cannot be written off', async () => {
    const { invoice, maker } = await setup();
    await sequelize.query("UPDATE platform_invoices SET status = 'PAID', amountDuePaise = 0 WHERE id = :id", {
      replacements: { id: invoice.id },
    });
    const r = await maker.c('post', `/platform/invoices/${invoice.id}/write-off`, { reason, version: 1 });
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('request, a second request, maker approval, stale version, approval by another admin, clearing the society, audit', async () => {
    const { society, invoice, maker, checker, view } = await setup();
    const url = `/platform/invoices/${invoice.id}/write-off`;
    // the society went past due first
    setNow('2026-11-17T04:00:00Z');
    await runDunning('2026-11-17');
    expect((await Society.findByPk(society.id!))!.status).toBe('PAST_DUE');
    expect((await reload(invoice.id!)).status).toBe('OVERDUE');
    setNow('2026-11-01T06:00:00Z'); // back inside the step-up window of the sign-ins

    const req = await maker.c('post', url, { reason, version: (await reload(invoice.id!)).version });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    const v = req.body.data.version;
    const row = await reload(invoice.id!);
    expect([row.writeOffRequestedBy, row.writeOffReason]).toEqual([maker.user.id, reason]);
    expect(row.writeOffRequestedAt).not.toBeNull();
    expect((await maker.c('post', url, { reason, version: v })).body.code).toBe('INVALID_STATE');
    // the queue shows it, with the version, and the maker cannot approve it
    const q = await maker.c('get', '/platform/billing/approvals?type=WRITE_OFF');
    expect(q.body.data).toEqual([
      expect.objectContaining({
        type: 'WRITE_OFF',
        id: invoice.id,
        version: v,
        canApprove: false,
        amountPaise: 1239000,
      }),
    ]);
    const self = await maker.c('post', `${url}/approve`, { version: v });
    expect([self.status, self.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    expect((await checker.c('post', `${url}/approve`, { version: v - 1 })).body.code).toBe('STALE_VERSION');
    expect(
      (await checker.c('get', '/platform/billing/approvals?type=WRITE_OFF')).body.data[0].canApprove,
    ).toBe(true);

    const ok = await checker.c('post', `${url}/approve`, { version: v });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      status: 'WRITTEN_OFF',
      amountDuePaise: 0,
      writtenOffPaise: 1239000,
    });
    const done = await reload(invoice.id!);
    expect([done.writtenOffBy, done.status]).toEqual([checker.user.id, 'WRITTEN_OFF']);
    expect((await Society.findByPk(society.id!))!.status).toBe('ACTIVE'); // nothing overdue is left (BR-06-40)
    expect(await DunningEvent.count({ where: { societyId: society.id!, step: 'CLEARED' } })).toBe(1);
    for (const a of ['write_off_requested', 'written_off'])
      expect(
        await AuditLog.count({ where: { action: `platform_billing.invoice.${a}`, societyId: society.id! } }),
      ).toBe(1);
    // final: no more actions
    expect((await checker.c('post', `${url}/approve`, { version: v + 1 })).body.code).toBe('INVALID_STATE');
    expect((await maker.c('post', url, { reason, version: v + 1 })).body.code).toBe('INVALID_STATE');
    expect((await view('post', url, { reason, version: 1 })).status).toBe(403);
  });

  it('step-up is needed to request and to approve, not to reject; a platform support user gets 403', async () => {
    const { invoice, maker, support } = await setup();
    const url = `/platform/invoices/${invoice.id}/write-off`;
    expect((await support.c('post', url, { reason, version: 1 })).body.code).toBe('PERMISSION_DENIED');
    advance(6 * 60_000);
    const r1 = await maker.c('post', url, { reason, version: 1 });
    expect([r1.status, r1.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    expect((await reload(invoice.id!)).writeOffRequestedBy).toBeNull();
  });

  it('rejection clears the request, needs a reason and another admin; the invoice can be requested again', async () => {
    const { invoice, maker, checker } = await setup();
    const url = `/platform/invoices/${invoice.id}/write-off`;
    expect((await checker.c('post', `${url}/reject`, { reason, version: 1 })).body.code).toBe(
      'INVALID_STATE',
    ); // none pending
    const req = await maker.c('post', url, { reason, version: 1 });
    const v = req.body.data.version;
    expect((await checker.c('post', `${url}/reject`, { reason: 'no', version: v })).status).toBe(400);
    expect((await maker.c('post', `${url}/reject`, { reason, version: v })).body.code).toBe(
      'MAKER_CHECKER_VIOLATION',
    );
    const rej = await checker.c('post', `${url}/reject`, { reason: 'Customer promised to pay', version: v });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    const row = await reload(invoice.id!);
    expect([row.writeOffRequestedBy, row.writeOffRequestedAt, row.writeOffReason, row.status]).toEqual([
      null,
      null,
      null,
      'ISSUED',
    ]);
    expect(await AuditLog.count({ where: { action: 'platform_billing.invoice.write_off_rejected' } })).toBe(
      1,
    );
    const again = await maker.c('post', url, { reason, version: rej.body.data.version });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
  });
});

describe('manual reminder (8.15)', () => {
  it('sends once per 24 hours, writes MANUAL_REMINDER and the audit row, mails the payers', async () => {
    const { society, invoice, maker, treasurer, support } = await setup();
    const url = `/platform/invoices/${invoice.id}/remind`;
    expect((await support.c('post', url, {})).body.code).toBe('PERMISSION_DENIED');
    const r = await maker.c('post', url, { note: 'Please clear before month end' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const ev = await DunningEvent.findAll({ where: { invoiceId: invoice.id!, step: 'MANUAL_REMINDER' } });
    expect(ev).toHaveLength(1);
    expect([ev[0]!.dedupeKey, ev[0]!.notes, ev[0]!.createdBy]).toEqual([
      null,
      'Please clear before month end',
      maker.user.id,
    ]);
    expect(
      await AuditLog.count({
        where: { action: 'platform_billing.invoice.reminder_sent', societyId: society.id! },
      }),
    ).toBe(1);
    expect((await inboxFor(treasurer.email!)).some(m => m.subject?.startsWith('Reminder: invoice'))).toBe(
      true,
    );
    const again = await maker.c('post', url, {});
    expect([again.status, again.body.code]).toEqual([429, 'REMINDER_TOO_SOON']);
    await sequelize.query(
      'UPDATE dunning_events SET createdAt = DATE_SUB(createdAt, INTERVAL 25 HOUR) WHERE invoiceId = :id',
      {
        replacements: { id: invoice.id },
      },
    );
    expect((await maker.c('post', url, {})).status).toBe(200);
    expect((await maker.c('post', url, { note: 'x'.repeat(301) })).status).toBe(400);
  });

  it('is INVALID_STATE for a paid invoice or a closed society and 404 for an unknown invoice', async () => {
    const { society, invoice, maker } = await setup();
    expect((await maker.c('post', '/platform/invoices/999999/remind', {})).body.code).toBe(
      'PLATFORM_INVOICE_NOT_FOUND',
    );
    await Society.update(
      {
        status: 'CLOSED',
        closedAt: new Date(),
        closureReason: 'OTHER',
        purgeAfter: new Date('2027-03-01'),
        activatedAt: new Date(),
      } as never,
      { where: { id: society.id! } },
    );
    expect((await maker.c('post', `/platform/invoices/${invoice.id}/remind`, {})).body.code).toBe(
      'INVALID_STATE',
    );
    await sequelize.query(
      "UPDATE societies SET status = 'ACTIVE', closedAt = NULL, closureReason = NULL, purgeAfter = NULL WHERE id = :id",
      { replacements: { id: society.id } },
    );
    await sequelize.query("UPDATE platform_invoices SET status = 'PAID', amountDuePaise = 0 WHERE id = :id", {
      replacements: { id: invoice.id },
    });
    expect((await maker.c('post', `/platform/invoices/${invoice.id}/remind`, {})).body.code).toBe(
      'INVALID_STATE',
    );
  });
});
