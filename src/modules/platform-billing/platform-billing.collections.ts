/**
 * Collection actions of a platform user on one invoice: write-off request, approval and rejection (BR-06-34, 8.17),
 * manual reminder (BR-06-42, 8.15) and grace extension (BR-06-41, 8.16). Step-up is checked by the routes; the maker-checker
 * and version checks are here (BR-06-30).
 */
import { Op, type Transaction } from 'sequelize';
import { DunningEvent, PlatformInvoice, Society, sequelize } from '../../models';
import { addHours, now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { notifyAfterCommit } from '../societies/societies.notify';
import { addDaysYmd, OPEN_STATUSES } from './pricing';
import { invoiceNotFound } from './platform-billing.service';
import { afterSettlement, lockSociety, settleInvoice, todayIst } from './platform-billing.settlement';
import { notifyPlatform, payersOf } from './platform-billing.notify';
import {
  actorId,
  assertDecidable,
  invalidState,
  num,
  staleVersion,
  validationFailed,
} from './platform-billing.shared';
import { invoiceDto } from './platform-billing.types';

const isOpen = (i: PlatformInvoice): boolean =>
  i.documentType === 'INVOICE' && OPEN_STATUSES.includes(i.status) && num(i.amountDuePaise) > 0;

/** Locks society then invoice (BR-06-23); 404 when unknown. */
async function lockInvoice(id: number, t: Transaction): Promise<{ society: Society; inv: PlatformInvoice }> {
  const pre = await PlatformInvoice.findByPk(id, { attributes: ['id', 'societyId'], transaction: t });
  if (!pre) throw invoiceNotFound();
  const society = await lockSociety(pre.societyId, t);
  const inv = await PlatformInvoice.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!inv) throw invoiceNotFound();
  return { society, inv };
}

const checkReason = (v: string): string => {
  const r = v.trim();
  if (r.length < 10 || r.length > 500) throw validationFailed('reason', '10 to 500 characters');
  return r;
};

// ------------------------------------------------------------------ 8.17 write-off
export async function requestWriteOff(
  ctx: Ctx,
  invoiceId: number,
  input: { reason: string; version: number },
) {
  const reason = checkReason(input.reason);
  return sequelize.transaction(async t => {
    const { society, inv } = await lockInvoice(invoiceId, t);
    if (!isOpen(inv)) throw invalidState('Only an open invoice can be written off');
    if (inv.writeOffRequestedBy !== null) throw invalidState('A write-off is already waiting for a decision');
    if (inv.version !== input.version) throw staleVersion();
    inv.set({
      writeOffRequestedBy: actorId(ctx),
      writeOffRequestedAt: now(),
      writeOffReason: reason,
      updatedBy: actorId(ctx),
      version: inv.version + 1,
    });
    await inv.save({ transaction: t });
    await audit(
      ctx,
      {
        action: 'platform_billing.invoice.write_off_requested',
        entityType: 'platform_invoice',
        entityId: inv.id!,
        entityLabel: inv.invoiceNo,
        societyId: inv.societyId,
        reason,
        after: { amountDuePaise: num(inv.amountDuePaise) },
      },
      t,
    );
    notifyPlatform(
      t,
      'platform_billing.approval_pending',
      'platform.billing.approve',
      {
        what: `Write-off of ${inv.invoiceNo}`,
        amountPaise: num(inv.amountDuePaise),
        societyName: society.name,
      },
      actorId(ctx),
    );
    return invoiceDto(inv);
  });
}

/** Approval: `writtenOffPaise = amountDuePaise`, status WRITTEN_OFF, then BR-06-40 (nothing overdue may clear the society). */
export async function approveWriteOff(ctx: Ctx, invoiceId: number, input: { version: number }) {
  return sequelize.transaction(async t => {
    const { inv } = await lockInvoice(invoiceId, t);
    if (!isOpen(inv) || inv.writeOffRequestedBy === null)
      throw invalidState('This invoice has no write-off waiting for approval');
    assertDecidable(
      ctx,
      { status: 'PENDING', version: inv.version, createdBy: inv.writeOffRequestedBy },
      'PENDING',
      input.version,
      'write-off',
    );
    const due = num(inv.amountDuePaise);
    inv.set({ writtenOffBy: actorId(ctx), writtenOffAt: now() });
    await settleInvoice(ctx, inv, { writtenOffPaise: due }, t);
    await audit(
      ctx,
      {
        action: 'platform_billing.invoice.written_off',
        entityType: 'platform_invoice',
        entityId: inv.id!,
        entityLabel: inv.invoiceNo,
        societyId: inv.societyId,
        reason: inv.writeOffReason,
        before: { status: 'OPEN', amountDuePaise: due },
        after: { status: inv.status, writtenOffPaise: due },
      },
      t,
    );
    await afterSettlement(ctx, inv.societyId, [], t);
    return invoiceDto(inv);
  });
}

export async function rejectWriteOff(
  ctx: Ctx,
  invoiceId: number,
  input: { reason: string; version: number },
) {
  const reason = checkReason(input.reason);
  return sequelize.transaction(async t => {
    const { inv } = await lockInvoice(invoiceId, t);
    if (!isOpen(inv) || inv.writeOffRequestedBy === null)
      throw invalidState('This invoice has no write-off waiting for a decision');
    assertDecidable(
      ctx,
      { status: 'PENDING', version: inv.version, createdBy: inv.writeOffRequestedBy },
      'PENDING',
      input.version,
      'write-off',
    );
    const requestedReason = inv.writeOffReason;
    inv.set({
      writeOffRequestedBy: null,
      writeOffRequestedAt: null,
      writeOffReason: null,
      updatedBy: actorId(ctx),
      version: inv.version + 1,
    });
    await inv.save({ transaction: t });
    await audit(
      ctx,
      {
        action: 'platform_billing.invoice.write_off_rejected',
        entityType: 'platform_invoice',
        entityId: inv.id!,
        entityLabel: inv.invoiceNo,
        societyId: inv.societyId,
        reason,
        before: { requestedReason },
      },
      t,
    );
    return invoiceDto(inv);
  });
}

// ------------------------------------------------------------------ 8.15 manual reminder
export async function sendManualReminder(ctx: Ctx, invoiceId: number, input: { note?: string }) {
  return sequelize.transaction(async t => {
    const { society, inv } = await lockInvoice(invoiceId, t);
    if (!isOpen(inv) || society.status === 'CLOSED')
      throw invalidState('A reminder can only be sent for an open invoice of an active society');
    const last = await DunningEvent.findOne({
      where: { invoiceId, step: 'MANUAL_REMINDER', createdAt: { [Op.gt]: addHours(now(), -24) } },
      attributes: ['id'],
      transaction: t,
    });
    if (last)
      throw new AppError(429, 'REMINDER_TOO_SOON', 'A reminder was already sent in the last 24 hours');
    const note = input.note?.trim() || null;
    await DunningEvent.create(
      {
        societyId: inv.societyId,
        invoiceId,
        step: 'MANUAL_REMINDER',
        offsetDays: null,
        scheduledFor: todayIst(),
        dedupeKey: null,
        outcome: 'DONE',
        templateKey: 'platform_billing.payment_reminder',
        notes: note,
        createdBy: actorId(ctx),
      } as never,
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: 'platform_billing.invoice.reminder_sent',
        entityType: 'platform_invoice',
        entityId: inv.id!,
        entityLabel: inv.invoiceNo,
        societyId: inv.societyId,
        after: { note },
      },
      t,
    );
    notifyAfterCommit(t, 'platform_billing.payment_reminder', () => payersOf(inv.societyId), {
      invoiceNo: inv.invoiceNo,
      amountDuePaise: num(inv.amountDuePaise),
      dueDate: inv.dueDate,
      societyName: society.name,
      manual: true,
      note,
    });
    return { invoiceId, sentAt: now().toISOString() };
  });
}

// ------------------------------------------------------------------ 8.16 extend grace
export async function extendGrace(
  ctx: Ctx,
  invoiceId: number,
  input: { days: number; reason: string; version: number },
) {
  const reason = checkReason(input.reason);
  return sequelize.transaction(async t => {
    const { society, inv } = await lockInvoice(invoiceId, t);
    if (!isOpen(inv) || !inv.suspendOn || !inv.dueDate)
      throw invalidState('Only an open invoice can get more time');
    if (inv.version !== input.version) throw staleVersion();
    const before = inv.suspendOn;
    const after = addDaysYmd(before, input.days);
    const limit = addDaysYmd(inv.dueDate, 60);
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > 30 || after > limit)
      throw new AppError(422, 'GRACE_EXTENSION_INVALID', 'The extension is not allowed', [
        { field: 'days', message: `1 to 30 days, and not beyond ${limit}` },
      ]);
    inv.set({ suspendOn: after, updatedBy: actorId(ctx), version: inv.version + 1 });
    await inv.save({ transaction: t });
    await DunningEvent.create(
      {
        societyId: inv.societyId,
        invoiceId,
        step: 'GRACE_EXTENDED',
        offsetDays: null,
        scheduledFor: todayIst(),
        dedupeKey: null,
        outcome: 'DONE',
        templateKey: 'platform_billing.grace_extended',
        suspendOnBefore: before,
        suspendOnAfter: after,
        notes: reason,
        createdBy: actorId(ctx),
      } as never,
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: 'platform_billing.invoice.grace_extended',
        entityType: 'platform_invoice',
        entityId: inv.id!,
        entityLabel: inv.invoiceNo,
        societyId: inv.societyId,
        reason,
        before: { suspendOn: before },
        after: { suspendOn: after, days: input.days },
      },
      t,
    );
    notifyAfterCommit(t, 'platform_billing.grace_extended', () => payersOf(inv.societyId), {
      invoiceNo: inv.invoiceNo,
      suspendOnBefore: before,
      suspendOnAfter: after,
      societyName: society.name,
    });
    return invoiceDto(inv);
  });
}
