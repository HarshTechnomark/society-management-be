/** TDS claims by the society or the platform and the platform decision (BR-06-33; 6.3; 8.9, 8.10, 8.20). */
import { Op } from 'sequelize';
import { PlatformInvoice, PlatformPayment, sequelize } from '../../models';
import type { TdsSection } from '../../models/platform-payment.model';
import { percentOf } from '../../lib/money';
import { now } from '../../lib/clock';
import { enqueue } from '../../lib/queue';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { notifyAfterCommit, send } from '../societies/societies.notify';
import { addDaysYmd } from './pricing';
import { billingSettings } from './platform-billing.settings';
import { billingPorts } from './platform-billing.ports';
import { invoiceNotFound } from './platform-billing.service';
import { afterSettlement, lockSociety, settleInvoice, todayIst } from './platform-billing.settlement';
import { payersOf } from './platform-billing.notify';
import {
  actorId,
  invalidState,
  isOpenInvoice,
  lockPayment,
  num,
  paymentNotFound,
  staleVersion,
} from './platform-billing.shared';

export interface TdsClaimInput {
  tdsSection: TdsSection;
  tdsRatePct?: string;
  amountPaise: number;
  deductedOn: string;
  certificateFileId?: number;
  notes?: string;
}

const claimView = (p: PlatformPayment, inv: PlatformInvoice) => ({
  id: p.id!,
  kind: p.kind,
  status: p.status,
  amountPaise: num(p.amountPaise),
  tdsSection: p.tdsSection,
  invoice: { id: inv.id!, status: inv.status, amountDuePaise: num(inv.amountDuePaise) },
});

/** 8.9. `societyId` set: society route (origin SOCIETY, another society's invoice is a 404); unset: platform route. */
export async function claimTds(ctx: Ctx, invoiceId: number, input: TdsClaimInput, o: { societyId?: number }) {
  const settings = await billingSettings();
  return sequelize.transaction(async t => {
    const pre = await PlatformInvoice.findByPk(invoiceId, {
      attributes: ['id', 'societyId'],
      transaction: t,
    });
    if (!pre || (o.societyId !== undefined && pre.societyId !== o.societyId)) throw invoiceNotFound();
    await lockSociety(pre.societyId, t);
    const inv = await PlatformInvoice.findByPk(invoiceId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!inv) throw invoiceNotFound();
    if (!isOpenInvoice(inv)) throw new ConflictError('INVOICE_NOT_PAYABLE', 'This invoice cannot take TDS');
    const today = todayIst();
    if (input.deductedOn > today || input.deductedOn < addDaysYmd(inv.issueDate ?? today, -30))
      throw new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [
        { field: 'deductedOn', message: 'Not before 30 days before the invoice date and not in the future' },
      ]);
    const active = await PlatformPayment.findOne({
      where: { invoiceId, kind: 'TDS', status: ['CLAIMED', 'VERIFIED'] },
      attributes: ['id'],
      transaction: t,
    });
    if (active) throw new ConflictError('TDS_ALREADY_CLAIMED', 'A TDS claim already exists for this invoice');
    const cap = percentOf(num(inv.subtotalPaise), settings['billing.tdsMaxRatePct']);
    if (input.amountPaise > cap || input.amountPaise > num(inv.amountDuePaise))
      throw new UnprocessableError('TDS_EXCEEDS_LIMIT', 'The TDS amount is above the allowed limit', [
        {
          field: 'amountPaise',
          message: `At most ${Math.min(cap, num(inv.amountDuePaise))} paise (TDS applies to the taxable value only)`,
        },
      ]);
    if (input.certificateFileId)
      await billingPorts().files.link(
        ctx,
        { fileId: input.certificateFileId, purpose: 'TDS_CERTIFICATE', societyId: inv.societyId },
        t,
      );
    const p = await PlatformPayment.create(
      {
        societyId: inv.societyId,
        invoiceId,
        kind: 'TDS',
        origin: o.societyId !== undefined ? 'SOCIETY' : 'PLATFORM',
        status: 'CLAIMED',
        method: 'TDS',
        amountPaise: input.amountPaise,
        appliedPaise: input.amountPaise,
        tdsSection: input.tdsSection,
        tdsRatePct: input.tdsRatePct ?? null,
        deductedOn: input.deductedOn,
        tdsCertificateFileId: input.certificateFileId ?? null,
        notes: input.notes ?? null,
        createdBy: actorId(ctx),
        updatedBy: actorId(ctx),
        version: 1,
      } as never,
      { transaction: t },
    );
    const r = await settleInvoice(ctx, inv, { tdsPaise: input.amountPaise }, t);
    await afterSettlement(ctx, inv.societyId, r.becamePaid ? [inv] : [], t);
    await audit(
      ctx,
      {
        action: 'platform_billing.tds.claimed',
        entityType: 'platform_payment',
        entityId: p.id!,
        entityLabel: inv.invoiceNo,
        societyId: inv.societyId,
        after: { amountPaise: input.amountPaise, tdsSection: input.tdsSection, origin: p.origin },
      },
      t,
    );
    return claimView(p, inv);
  });
}

/** 8.10: only while CLAIMED. */
export async function attachCertificate(
  ctx: Ctx,
  societyId: number,
  paymentId: number,
  input: { certificateFileId: number; version: number },
) {
  return sequelize.transaction(async t => {
    const { payment: p, invoice } = await lockPayment(paymentId, t, { societyId, kind: 'TDS' });
    if (p.status !== 'CLAIMED')
      throw invalidState('A certificate can be attached only while the claim is open');
    if (p.version !== input.version) throw staleVersion();
    await billingPorts().files.link(
      ctx,
      { fileId: input.certificateFileId, purpose: 'TDS_CERTIFICATE', societyId },
      t,
    );
    p.set({ tdsCertificateFileId: input.certificateFileId, updatedBy: actorId(ctx), version: p.version + 1 });
    await p.save({ transaction: t });
    await audit(
      ctx,
      {
        action: 'platform_billing.tds.certificate_attached',
        entityType: 'platform_payment',
        entityId: p.id!,
        entityLabel: invoice?.invoiceNo ?? null,
        societyId,
        after: { certificateFileId: input.certificateFileId },
      },
      t,
    );
    return claimView(p, invoice!);
  });
}

const VERIFIED_REJECT_DAYS = 90;

/** 8.20 and 6.3: VERIFIED from CLAIMED; REJECTED from CLAIMED, or from VERIFIED within 90 days. */
export async function decideTds(
  ctx: Ctx,
  paymentId: number,
  input: { decision: 'VERIFIED' | 'REJECTED'; reason?: string; version: number },
) {
  return sequelize.transaction(async t => {
    const { society, invoice, payment: p } = await lockPayment(paymentId, t, { kind: 'TDS' });
    if (input.decision === 'VERIFIED') {
      if (p.status !== 'CLAIMED') throw invalidState('Only an open claim can be verified');
    } else {
      const verifiedRecently =
        p.status === 'VERIFIED' &&
        p.decidedAt !== null &&
        now().getTime() - p.decidedAt.getTime() <= VERIFIED_REJECT_DAYS * 86_400_000;
      if (p.status !== 'CLAIMED' && !verifiedRecently)
        throw invalidState('A claim can be rejected while open or within 90 days of verification');
    }
    if (p.version !== input.version) throw staleVersion();
    if (!invoice) throw paymentNotFound();
    if (input.decision === 'REJECTED') {
      if (['VOID', 'WRITTEN_OFF'].includes(invoice.status))
        throw invalidState('The invoice is already closed; its TDS cannot be reopened');
      await settleInvoice(ctx, invoice, { tdsPaise: -num(p.amountPaise) }, t);
    }
    p.set({
      status: input.decision,
      decidedBy: ctx.user!.id,
      decidedAt: now(),
      rejectedReason: input.decision === 'REJECTED' ? (input.reason ?? null) : null,
      updatedBy: ctx.user!.id,
      version: p.version + 1,
    });
    await p.save({ transaction: t });
    await audit(
      ctx,
      {
        action:
          input.decision === 'VERIFIED' ? 'platform_billing.tds.verified' : 'platform_billing.tds.rejected',
        entityType: 'platform_payment',
        entityId: p.id!,
        entityLabel: invoice.invoiceNo,
        societyId: p.societyId,
        reason: input.reason ?? null,
        after: { status: p.status, amountPaise: num(p.amountPaise), invoiceStatus: invoice.status },
      },
      t,
    );
    if (input.decision === 'REJECTED')
      notifyAfterCommit(t, 'platform_billing.tds_rejected', () => payersOf(p.societyId), {
        invoiceNo: invoice.invoiceNo,
        amountPaise: num(p.amountPaise),
        reason: input.reason,
        societyName: society.name,
      });
    return claimView(p, invoice);
  });
}

export const TDS_REMINDER_ONE_JOB = 'platform-billing:tds-certificate-reminder';

/** Claims older than this many days without a certificate get the monthly reminder. */
const CERTIFICATE_REMINDER_DAYS = 60;

/**
 * `platform-billing:tds-certificate-reminders` (monthly, 5th 10:00 IST): CLAIMED TDS older than 60 days and no
 * certificate. One notification per claim per month: the per-claim job id carries the month.
 */
export async function runTdsCertificateReminders(): Promise<{ claims: number; queued: number }> {
  const cutoff = new Date(now().getTime() - CERTIFICATE_REMINDER_DAYS * 86_400_000);
  const claims = await PlatformPayment.findAll({
    where: { kind: 'TDS', status: 'CLAIMED', tdsCertificateFileId: null, createdAt: { [Op.lt]: cutoff } },
    attributes: ['id'],
    order: [['id', 'ASC']],
  });
  const month = todayIst().slice(0, 7);
  for (const c of claims)
    await enqueue(
      'platform-billing',
      TDS_REMINDER_ONE_JOB,
      { claimId: c.id! },
      { jobId: `tds-cert-${c.id}-${month}` },
    );
  return { claims: claims.length, queued: claims.length };
}

/** Sends the reminder of one claim (re-checks that it is still waiting for a certificate). */
export async function sendTdsCertificateReminder(claimId: number): Promise<boolean> {
  const claim = await PlatformPayment.findByPk(claimId);
  if (!claim || claim.status !== 'CLAIMED' || claim.tdsCertificateFileId !== null) return false;
  const inv = claim.invoiceId
    ? await PlatformInvoice.findByPk(claim.invoiceId, { attributes: ['invoiceNo'] })
    : null;
  await send('platform_billing.tds_certificate_due', await payersOf(claim.societyId), {
    invoiceNo: inv?.invoiceNo ?? '',
    amountPaise: num(claim.amountPaise),
  });
  return true;
}
