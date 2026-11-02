# Module 06: Platform billing (backend)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/06_Platform_Billing.md`. Built so far: task 6.1 (data layer),
task 6.2 (invoicing) and task 6.3 (payments, TDS, credits, refunds, autopay routes, the routes of 8.1 to 8.14, 8.18 to
8.23 and 8.28). Write-off, remind, extend-grace, approvals queue, dunning, reports, the other jobs and the PDF come in task 6.4.

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
- `platform-billing.payments.ts`: online order (8.5), `confirmGatewayPayment` (BR-06-28; shared by verify and webhook),
  `failGatewayPayment`, `verifyPayment` (8.6), manual payment record, approve and reject (8.18, 8.19, payments and refunds).
- `platform-billing.webhook.ts`: processor of `platform-billing:process-webhook` (`payment.captured`, `order.paid`,
  `payment.failed`, `refund.processed|failed`, `mandate.activated|cancelled`). The route (controller `webhook`) checks the
  signature on the raw body (`req.rawBody`, kept by `app.ts` for `/api/v1/webhooks/*`), enqueues with `jobId = eventId`.
- `platform-billing.tds.ts` (claim, certificate, decision), `platform-billing.credits.ts` (goodwill, refunds, gateway
  refund events), `platform-billing.autopay.ts` (flag `platform.autopay`), `platform-billing.queries.ts` (8.1 to 8.4, 8.7, 8.8, CSV).
- `platform-billing.shared.ts`: lock order helpers, `applyCapturedPayment` (BR-06-24), maker-checker check, payment views.
- `platform-billing.ports.ts`: file linking for certificates and attachments (module 01 placeholder, see below).
- `platform-billing.notify.ts`, `platform-billing.templates.ts`: section 10 notifications through `lib/notify`.
- `platform-billing.routes.ts`, `.controller.ts`, `.validation.ts`: section 8.
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
- Payment gateway: `src/adapters/payments/payment-gateway.ts` has the module 01 `PaymentGateway` interface and a fake
  (memory; `payOrder`, `failNext`; `POST /api/v1/dev/payments/:orderId/pay` in non-production). `paymentGateway()` /
  `setPaymentGateway()` in `src/adapters/index.ts`; real mode throws until the Razorpay adapter exists. Env:
  `PLATFORM_GATEWAY_ACCOUNT_ID`, `PLATFORM_RAZORPAY_KEY_ID`, `PLATFORM_RAZORPAY_KEY_SECRET`,
  `PLATFORM_RAZORPAY_WEBHOOK_SECRET` (defaults for fake mode, all required when `PROVIDERS_MODE=real`).
- Files: module 01 has no files service yet, so `billingPorts().files.link` accepts only ids registered in
  `placeholderBillingFiles` (`'TDS_CERTIFICATE:<id>'`). Module 01 replaces it with `setBillingPorts({ files })`.
- Credit ledger order: `postCredit` and goodwill approval set `postedAt` so that `(postedAt, id)` is the posting order even with a
  frozen clock or a goodwill row (low id) approved after other rows. `platform_payments.createdAt` follows `lib/clock` (model hook).
- Checkout: the payment order response builds `checkout` itself (`key`, `order_id`, `name`, `description`, `prefill`) merged over
  the adapter's; a reused open order rebuilds it the same way. `expiresAt` is `createdAt + 24 h`.
- Approve, reject, verify, tds-decision and complete-refund take no `Idempotency-Key` (the spec lists none; the `version`
  check makes a repeat a 409). Create routes of 8.5, 8.9, 8.12, 8.13, 8.18, 8.22 and 8.23 require it.
- Credits list (8.8) answers `data: [rows]`, `pagination` and a top-level `balancePaise`.
- TDS decision: rejecting a claim of a VOID or WRITTEN_OFF invoice is `409 INVALID_STATE` (its amounts are closed).
- Not yet (task 6.4): `invoice_issued` and `credit_note_issued` notifications, PDF rendering, write-off, remind,
  extend-grace, approvals queue, dunning, reports, jobs `reconcile-orders`, `refund-status`, `autopay-charge`,
  `tds-certificate-reminders`, export provider and retention-expiry handler for module 05.
