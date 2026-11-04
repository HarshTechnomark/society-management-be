import { ChargeHead, Invoice, InvoiceLine, Society, Unit, sequelize } from '../src/models';
import { istDate, now } from '../src/lib/clock';
import { addDaysYmd } from '../src/modules/billing/billing.calc.period';
import { renderPdfFor } from '../src/modules/billing/billing.pdf.service';
import { unitLedger } from '../src/modules/billing/billing.ledger.service';
import { residents } from '../src/modules/residents/residents.public';
import { financialYearOf } from '../src/utils/numberSequences';
import { systemCtx } from '../src/types/context';

/**
 * Module 11.5 demo seed (not run in production): one overdue invoice of 12,500 rupees in Sky Heights CHS, 120 days old, so the
 * defaulter list and the dues dashboard have a row. It is written straight into the tables (an ad-hoc invoice with the
 * number `INV/<year>/DEMO-OVERDUE`, one maintenance line, one ledger debit; no journal, no run). Idempotent by the invoice number.
 * The bill PDF is rendered in the seed with the `billing:render-pdf` function; an existing invoice whose PDF is still PENDING
 * (seeded before this step existed) is rendered on the next run.
 */
export interface BillingDuesSeedReport {
  created: string[];
  skipped: string[];
}

export async function seedBillingDues(): Promise<BillingDuesSeedReport> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('billing dues demo seed must not run in production');
  const report: BillingDuesSeedReport = { created: [], skipped: [] };
  const society = await Society.findOne({ where: { slug: 'sky-heights' } });
  if (!society) return report;
  const societyId = society.id!;
  const today = istDate(now());
  const fy = financialYearOf(addDaysYmd(today, -120));
  const invoiceNo = `INV/${fy}/DEMO-OVERDUE`;
  const existing = await Invoice.findOne({
    where: { societyId, invoiceNo },
    attributes: ['id', 'pdfStatus'],
  });
  if (existing) {
    if (existing.pdfStatus === 'PENDING' && (await renderPdfFor('invoice', Number(existing.id))) === 'READY')
      report.created.push('sky-heights PDF');
    else report.skipped.push('sky-heights');
    return report;
  }
  const head = await ChargeHead.findOne({ where: { societyId, key: 'MAINTENANCE' } });
  if (!head) {
    report.skipped.push('sky-heights (no MAINTENANCE head: run the billing setup seed first)');
    return report;
  }
  const flats = await Unit.findAll({
    where: { societyId, status: 'ACTIVE' },
    attributes: ['id', 'label'],
    order: [['label', 'ASC']],
    limit: 40,
  });
  for (const f of [...flats].reverse()) {
    const billTo = await residents.billToFor(Number(f.id), today);
    if (!billTo) continue;
    const invoiceDate = addDaysYmd(today, -120);
    const total = 1_250_000;
    const invoiceId = await sequelize.transaction(async t => {
      const inv = await Invoice.create(
        {
          societyId,
          invoiceNo,
          financialYear: fy,
          invoiceType: 'ADHOC',
          billingRunId: null,
          dedupeKey: null,
          unitId: Number(f.id),
          unitLabel: f.label,
          billToResidentId: billTo.residentId,
          billToRelation: billTo.relation,
          billToName: billTo.name,
          periodStart: null,
          periodEnd: null,
          invoiceDate,
          dueDate: addDaysYmd(invoiceDate, 15),
          description: 'Demo: overdue maintenance',
          refType: null,
          refId: null,
          societyGstin: null,
          gstApplied: false,
          thresholdBasePaise: 0,
          taxableValuePaise: 0,
          subtotalPaise: total,
          cgstPaise: 0,
          sgstPaise: 0,
          taxPaise: 0,
          roundOffPaise: 0,
          totalPaise: total,
          previousDuesPaise: 0,
          debitedPaise: 0,
          creditedPaise: 0,
          writtenOffPaise: 0,
          paidPaise: 0,
          outstandingPaise: total,
          nonInterestBearingPaise: 0,
          status: 'ISSUED',
          settledOn: null,
          isDisputed: false,
          interestPostedToDate: null,
          lateFeeChargedAt: null,
          reminderCount: 0,
          lastReminderAt: null,
          pdfFileId: null,
          pdfStatus: 'PENDING',
          issuedAt: now(),
          cancelledAt: null,
          createdBy: null,
          updatedBy: null,
          version: 1,
        } as never,
        { transaction: t },
      );
      await InvoiceLine.create(
        {
          societyId,
          invoiceId: inv.id!,
          billingNoteId: null,
          lineNo: 1,
          lineKind: 'CHARGE',
          chargeHeadId: head.id!,
          headKey: head.key,
          description: 'Maintenance (demo, overdue)',
          quantity: null,
          ratePaise: null,
          amountPaise: total,
          isTaxable: false,
          billingRuleVersionId: null,
          periodFrom: null,
          periodTo: null,
          prorationDays: null,
          periodDays: null,
          refInvoiceLineId: null,
          computation: null,
          ledgerAccountCode: head.ledgerAccountCode,
          creditedPaise: 0,
          createdBy: null,
          updatedBy: null,
        } as never,
        { transaction: t },
      );
      await unitLedger.post(
        {
          ...systemCtx('seed'),
          society: {
            id: societyId,
            name: society.name,
            status: society.status,
            timezone: 'Asia/Kolkata',
            planKey: '',
          },
        },
        {
          unitId: Number(f.id),
          entryType: 'INVOICE',
          refType: 'invoice',
          refId: inv.id!,
          debitPaise: total,
          creditPaise: 0,
          date: invoiceDate,
          narration: `Bill ${invoiceNo}`,
        },
        t,
      );
      return inv.id!;
    });
    await renderPdfFor('invoice', invoiceId);
    report.created.push(`sky-heights ${f.label}`);
    return report;
  }
  report.skipped.push('sky-heights (no flat with an owner: run the module 09 seed first)');
  return report;
}
