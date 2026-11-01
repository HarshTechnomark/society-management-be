# Module 06: Platform billing (backend)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/06_Platform_Billing.md`. Built so far: task 6.1 (data layer)
and task 6.2 (invoicing). Payments, TDS, refunds, write-off, dunning, reports, routes and the PDF come in later tasks.

## Files

- `pricing.ts`: pure calculator: `periodValue`, line builders (PLAN, DISCOUNT, ADDON, FLAT_TRUE_UP, OVERAGE,
  PRORATION, ONE_TIME, MANUAL), place of supply and GST, credit note tax, `amountDueOf`, `deriveInvoiceStatus`.
  Rounding through `src/lib/money.ts` (`roundHalfUp`, `percentOf` on BigInt with decimal-string rates).
- `platform-billing.settings.ts`: section 5.3 settings with code defaults and Zod validation.
  `setBillingSettingsSource()` is the hook module 07 uses; an invalid stored value falls back to the default.
- `platform-billing.settlement.ts`: society lock, credit ledger (`creditBalance`, `postCredit`, `applyCredits`),
  `settleInvoice` (amount due, status, `paidAt`/`voidedAt`, `.invoice.paid` audit, module 04 `onPlatformInvoicePaid`),
  `afterSettlement` (BR-06-40: module 05 `onFirstInvoicePaid` / `onAccountCleared`, CLEARED dunning event),
  `hasOverdueInvoice`, `getOutstanding`.
- `platform-billing.service.ts`: `issuePeriodInvoice`, `issueProrationInvoice`, `issueOneTimeInvoice` (9.3),
  `previewTax`, `addonRevenueThisMonth`, manual drafts (`createManualInvoice`), credit note drafts
  (`createCreditNote`), `approveDocument` / `rejectDocument` (maker-checker, version; step-up is for the routes).
- `platform-billing.jobs.ts`: queue `platform-billing`: `generate-invoices` (daily 02:00 IST) and a `render-pdf`
  placeholder (documents stay `pdfStatus = PENDING`).
- `platform-billing.public.ts`: `platformBilling` functions for other modules and `registerPlatformBilling()`.

## Start-up

`registerPlatformBilling()` (after `registerSocieties()`, in `server.ts` and `worker.ts`) replaces module 04's
recording billing stubs (`issue*Invoice`, `periodValue`, `previewTax`, so quotes carry GST, `addonRevenueThisMonth`)
and module 05's `billing.hasOverdueInvoice`, and registers the jobs. The test helpers of modules 04 and 05 restore their
stubs, so their tests are unchanged. Jobs use `lib/queue` (in-process without `REDIS_URL`, BullMQ with it).

## Decisions

- Every issue function locks the society row first and runs in the caller's transaction. The dedupe check is a plain
  read (a locking read of a missing key takes a gap lock, and parallel issuers deadlock on their inserts); the number
  and the insert run in a savepoint, so a concurrent issuer of the same key returns the existing invoice and the number
  goes back (no gap).
- Module 04 changes: `getBillingSnapshot(subscriptionId, periodStart, t?)` reads in the caller's transaction and does
  not close usage months when `t` is given; `renewIfDue` closes them before it opens the renewal transaction (closing
  issues annual overage invoices, which lock the society row the renewal holds). The generation job calls the
  snapshot once without a transaction before each item for the same reason.
- FLAT_TRUE_UP needs the previous PERIOD invoice (`billed` = its PLAN quantity); without one there is no true-up.
  `prorationDays` on that line is the number of days with flats above `billed`.
- PRORATION invoices carry `periodStart = effectiveDate`. Module 04's `lineType: 'ADDON'` for packs is stored as
  ONE_TIME. Zero-amount lines are dropped; a subtotal ≤ 0 issues nothing.
- `afterSettlement` runs only when money or credit actually moved (an invoice issued without credit applied changes
  nothing in the society state).
- `hasOverdueInvoice`: open invoice with `amountDuePaise ≥ dunningMinDuePaise` and `dueDate + pastDueAfterDays ≤ today`.
- Not yet: notifications (`invoice_issued`, `credit_note_issued`), PDF rendering, routes, payments, dunning job,
  export provider and retention-expiry handler for module 05.
