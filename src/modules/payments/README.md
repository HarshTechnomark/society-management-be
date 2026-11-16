# Module 12 · Payments, receipts and collections (backend)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/12_Payments_Receipts_Collections.md`. This README is the contract
between the **foundation** (this commit series) and the **five parts** that fill the module in parallel worktrees.

## What the foundation provides (do not rebuild it)

| Area      | File                                                                                                                                                                      | Contents                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tables    | `migrations/20261117000100…000900`                                                                                                                                        | all 9 tables of section 7 (CHECKs, generated columns, indexes). Never edit; add a new migration if a part needs a column                                                              |
| Models    | `src/models/{payment-order,payment,payment-allocation,refund,payment-webhook-event,autopay-mandate,unit-advance,collection,collection-request}.model.ts`                  | registered in `src/models/index.ts` with associations. Generated columns (`openSlot`, `liveSlot`, `titleKey`) are not mapped                                                          |
| Constants | `payments.constants.ts`                                                                                                                                                   | `PERM`, `ENT`, `APPROVAL_TYPES`, `ENTITY`, `JOBS`, enums, `AUDIT`, `RT`, `NOTIFY`, `ERR`, `ACCOUNT` posting codes, `SETTING_DEFAULTS`                                                 |
| Types     | `payments.types.ts`                                                                                                                                                       | `OrderItem`, `SettleInput`, `AllocationPlan`, ...                                                                                                                                     |
| Ports     | `payments.ports.ts`                                                                                                                                                       | `paymentsPorts()` (approvals, journal, funds, bankAccounts, societyBalance, notifications, gateways, notices), `setPaymentsPorts`, `paymentsPortCalls`, `placeholderPaymentApprovals` |
| Core      | `payments.alloc.*`, `payments.advances.ts`, `payments.receipts.core.ts`, `payments.settle.ts`, `payments.reverse.core.ts`, `payments.duplicates.ts`, `payments.shared.ts` | see "Core API"                                                                                                                                                                        |
| Public    | `payments.public.ts`, `payments.reports.ts`                                                                                                                               | section 8.26 and 8.27; parts fill the stubs that throw `NOT_IMPLEMENTED_IN_FOUNDATION`                                                                                                |
| Wiring    | `registerPayments()` in `payments.public.ts`; called from `server.ts`, `worker.ts`, `scripts/seed.ts`                                                                     | queue `payments`, export provider, purge handler, approval types (placeholders), module 11 hooks (`setBillingPorts({ payments })`), fund resolver                                     |
| Dev       | `src/modules/dev/dev.routes.ts`                                                                                                                                           | `PAYMENTS_APPROVAL_HOOKS` table, `?source=payments`; parts add their hook                                                                                                             |

## Core API (call these; never write `payment_allocations`, `unit_advances` or `receiptNo` yourself)

Open every transaction that touches the core with `moneyTx(fn)` from `payments.shared.ts` (it is `READ COMMITTED`: the advance
balance is read with `FOR UPDATE`, whose gap locks would deadlock two units' first rows under the default `REPEATABLE READ`).
Pass `ctx` (user or `systemCtx()`); the core adds the society with `withSociety`.

- `payments.settle.ts`
  - `settleInput(ctx, input: SettleInput, t)` creates an effective payment: takes the unit lock, makes the plan, inserts the payment
    (with parts), applies allocations (invoices through module 11 `applyAllocation`, collection requests), advance row for the rest,
    receipt number, unit ledger credit (`toInvoices + toAdvance`), journal (6.9), audit (`payments.payment.recorded|captured`), and after
    commit realtime `payment.received`, receipt render job, apply-advances job, `receipt_issued` notification. Idempotent by `gatewayPaymentId` and `referenceKey`
    (returns `{ payment, created: false }`). Use `mode: 'OLDEST_FIRST'` (+ `duesPaise`) or `mode: 'SELECTED'` (+ `selected`), or `advanceOnly`.
  - `effectivatePending(ctx, paymentId, { mode, selected, duesPaise, status: 'CONFIRMED' | 'RECEIVED', approvedBy }, t)` turns a `PENDING_APPROVAL` payment
    (created by 12.2 with the CHECK-friendly zero parts) effective: same effects, audit `payments.payment.approved`.
  - `settleCapture(gatewayAccountId, gp, t, ctx?)` is 6.8 inside a transaction (`gp = { id, status, amountPaise, method, orderId }`): returns
    `SETTLED | ALREADY_SETTLED | ATTEMPT_RECORDED | PENDING | UNKNOWN_ORDER` (the caller flags the webhook event). Mismatch, cancelled order and
    second capture (BR-12-13/14) are handled; order set to `PAID`; `registerOrderHook` hooks run. `settleCaptureTx(gatewayAccountId, gatewayPaymentId, ctx?)` is
    the wrapper for verify, webhook job and reconcile job (fetches the gateway payment before the transaction, treats the unique-key race as already settled).
  - `registerOrderHook`, `orderHookFor(refType)` (12.1 calls `onExpired` from it).
- `payments.alloc.plan.ts`: `buildPlan(open, input)` (pure, BR-12-15/16/17, tested with example 6.10), `loadOpenTargets(societyId, unitId, t, opts)`, `requestOutstanding`.
- `payments.alloc.apply.ts`: `applyPlan`, `moveRequestPaid`, `requestStatusFor`. `payments.alloc.totals.ts`: `refreshCollectionTotals(collectionId)` (body of `collections:refresh-totals`; 12.5 owns changes to it).
- `payments.advances.ts`: `advanceBalance(societyId, unitId, t?)`, `postAdvance(ctx, societyId, unitId, entry, t)` (unit lock must be held; idempotent by `dedupeKey`; `ADVANCE_INSUFFICIENT`),
  `applyAdvancesForUnit(ctx, societyId, unitId, t, { force? })` (body of `payments:apply-advances`), `applyAdvanceToInvoice`, `creditOpeningAdvance`, `queueAdvanceApply`, `listAdvanceEntries`, `lockUnitRow`.
- `payments.receipts.core.ts`: `issueReceipt`, `cancelReceipt`, `bumpReceiptRevision`, `enqueueReceiptRender` (job `payments:render-receipt` is a placeholder that 12.3 replaces).
- `payments.reverse.core.ts`: `reverseLiveAllocations(ctx, selector, { reasonCode, releaseToAdvance, newestFirst?, limitPaise? }, t)` is the routine for reverse, bounce, return, refund freeing,
  reallocation and invoice cancel (negative rows with `reversalOfId`, module 11 `reverseAllocation`, request totals, advance release with journal; payment parts follow when released to advance).
  `reversePaymentCore(ctx, paymentId, { newStatus: 'REVERSED' | 'BOUNCED' | 'RETURNED', reversalReasonCode?, reason?, patch? }, t)` takes a whole effective payment out: unwinds a spent advance first, receipt `CANCELLED`
  (number kept), unit ledger `PAYMENT_REVERSAL`, mirror journal, audit, realtime `payment.reversed`. `onInvoiceCancelled` is BR-12-53 (already wired to module 11).
- `payments.duplicates.ts`: `referenceKeyOf`, `findDuplicateReference`, `assertNoDuplicateReference`, `findDuplicateSuspect`, `checkDuplicateSuspect(…, confirmDuplicate)`, `firstPaymentOfOrder`.
- `payments.journal.ts`: `captureJournal`, `mirrorJournal`, `releaseJournal`, `advanceAppliedJournal`, `receiptDebitAccount`.
- `payments.shared.ts`: `moneyTx`, `lockUnit`, `withSociety`, `setting(societyId, key)`, `unitLabelOf`, `emitFinance`, `auditPayment`, `paymentToAudit`, `notImplemented`, `invalidState`.
- `payments.billing-hooks.ts` (done): `registerBillingHooks()` replaces the module 11 placeholders (`advanceBalance`, `applyAdvanceToInvoice`, `creditOpeningAdvance`, `queueAdvanceApply`, `onInvoiceCancelled`,
  `listAllocationsForInvoice`, `chequeReturnCount`) and registers the `collection_request` fund resolver (BR-12-55). `chequeReturnCounts` and `findByGatewayPaymentId` are real already.
- Known limits of the foundation: the payment's `paymentDate` for online captures is the UTC date (12.1: pass the society date when it wraps `settleCapture`); an archived unit makes `lockUnit` throw `UNIT_NOT_FOUND`
  (BR-12-19 asks for `NEEDS_REVIEW`; 12.1 handles that in the webhook job); mandatory-collection invoices mirror payments onto the request's `paidPaise` without an allocation row (12.3's integrity check must count
  allocations of `collection_requests.invoiceId` too).

Lock order (BR-12-19) is: approvals request → order → unit (`units.lockActive`) → invoices → collection request → collection.

## Rules for every part

- Files only with your prefix (below). Shared files you may touch with **additive lines only**: `src/app.ts` (one `api.use(...)`
  mount line of your routes), this README (tick your part at the bottom), `seeders/payments.ts` (one entry in `PAYMENT_SEEDERS`, your function in
  `seeders/payments-<part>.ts`; `scripts/seed.ts` already calls `seedPayments()`), `payments.public.ts` (replace the body of the stubs you own; keep the signature),
  `src/modules/dev/dev.routes.ts` (one line in `PAYMENTS_APPROVAL_HOOKS`), `payments.jobs.ts` (one `register...Jobs()` call line at the end of `registerPaymentJobs`; replace the `payments:render-receipt` placeholder line if you are 12.3), `tests/helpers/payments.ts` (additive helpers).
- Tests in `tests/modules/payments/<prefix>.*.test.ts`. Use `setPaymentsPorts()` and `paymentsPortCalls` like module 11.
- Routes go through `routeMeta`, `requirePermission`, `requireFeature` (entitlements `ENT.*`), `validate`, `idempotency` for money/create routes.
- Money is paise; times from `lib/clock`; notify only after commit; audit in the same transaction.
- Do not add dependencies between parts. If you need something another part owns, add the function to the foundation only if it is a pure helper; otherwise leave a TODO.

## The five parts

### 12.1 online (prefix `payments.online`, `payments.orders`, `payments.webhooks`, `payments.links`)

Spec: 8.2–8.5 order parts, 8.18, 8.24, 8.25, 8.26 order parts; F01–F04, F14–F16, F23, F26; sections 5.1, 5.2, 5.7, 6.1, 6.6, 6.7.

- Routes: `GET /me/payables`, `POST /me/payables/payment-orders`, `POST /me/payables/payment-orders/:id/verify`, `GET /me/payment-orders/:id`, order cancel / force check (admin), `POST /payment-links`, `GET|POST /public/pay/:code`, `POST /webhooks/payments/:gatewayAccountId`.
- Writes: `payment_orders`, `payment_webhook_events`; payments only through `settleCapture`.
- Calls: `settleCapture`, `buildPlan` for previews, `paymentsPorts().gateways`, `invoices.listOpen`.
- Also: convenience fee (BR-12-37), `payments.createOrder`, `registerOrderHook`, `getOrder`, jobs `process-webhook`, `reconcile-orders`, `recovery-nudge`, `expire-links`, `purge-webhook-events`, family pay, notifications `payment_failed`, `checkout_abandoned`, `payment_link`.
- Own `payments.public.ts` stubs: `createOrder`, `getOrder`, `onUnitLinkEnded` (order part). `registerOrderHook` and `findByGatewayPaymentId` are done.

### 12.2 offline (prefix `payments.offline`, `payments.cheques`, `payments.declared`)

Spec: 8.6, 8.11, 8.12; F08–F10, F22 offline part; section 5.5; approval type `OFFLINE_PAYMENT`.

- Routes: `POST /payments/offline`, cheque routes (deposit batch, clear, bounce, return), `POST /me/payments/declared`.
- Writes: `payments` (PENDING_APPROVAL and cheque lifecycle columns), files link (`PAYMENT_PROOF`); money effects only through `settleInput` (on approval) and `reversePaymentCore` (bounce, return).
- Calls: `settleInput`, `reversePaymentCore`, `findDuplicateReference`, `findDuplicateSuspect`, `paymentsPorts().approvals`, `bankAccounts`, billing `invoices.createAdHoc` for the bounce charge.
- Registers the real `OFFLINE_PAYMENT` hooks and adds them to `PAYMENTS_APPROVAL_HOOKS`; jobs `cheque-reminder`; notifications `offline_rejected`, `cheque_received`, `cheque_bounced`, `cheque_deposit_due`.
- `chequeReturnCount(s)` are done in the foundation; no stubs to fill. Nothing else of `payments.public.ts` belongs to 12.2.

### 12.3 admin (prefix `payments.admin`, `payments.receipts`, `payments.reverse`, `payments.advances`, `payments.reports`)

Spec: 8.5, 8.7, 8.10, 8.13–8.17, 8.27; F07, F12, F13, F18, F24, F25.

- Routes: `GET /payments`, `/payments/:id`, `/payments/summary`, `/payments/live-feed`, `/payments/export`, receipts (PDF, resend, review flag), `POST /payments/:id/reverse`, `POST /payments/:id/reallocate`, `GET /me/advances`, `GET /units/:unitId/advances`, `GET /me/payments`, `/me/payments/:id`, `/:id/receipt-url`.
- Writes: `payments` (review flag, receipt pdf columns), via core for money (`reversePaymentCore`, `reallocate` built on `reverseAllocations` + `buildPlan`/`applyPlan`).
- Own: job `render-receipt` (PDF), `apply-advances` queueing wrapper if the job needs changes, `integrity-check`, `payments.reports.ts` bodies (8.27), `payments.public.ts` stubs `successRate`.
- Notifications: `payment_reversed`, `needs_review`, `receipt_issued` resend.

### 12.4 refunds and AutoPay (prefix `payments.refunds`, `payments.autopay`)

Spec: 8.8, 8.19, 8.20; F11, F21; sections 5.6 (refunds), 5.9, 6.3, 6.5; approval type `PAYMENT_REFUND`.

- Routes: refund request/list/detail/complete/cancel, `/me/autopay-mandates` and admin mandates.
- Writes: `refunds`, `autopay_mandates`, `payment_orders` (source `AUTOPAY`, via 12.1 helpers in your own files only), `unit_advances` through `postAdvance` (`REFUND_HOLD`/`REFUND_RELEASE`), allocations through `reverseAllocations` (`REFUND_FREED`).
- Registers the `PAYMENT_REFUND` hooks and adds them to `PAYMENTS_APPROVAL_HOOKS`; jobs `refund-status`, `autopay-schedule`, `autopay-execute`, `mandate-auth-timeout`.
- Own stubs: `autopay.cancelAllForSociety`; the autopay part of `onUnitLinkEnded` (export `cancelMandatesForUnitLink` from `payments.autopay.service.ts`; 12.1 calls it).

### 12.5 collections (prefix `payments.collections`)

Spec: 8.9, 8.21–8.23, 6.4, 6.11; F19, F20; sections 5.8, 6.4; approval type `COLLECTION_PUBLISH`.

- Routes: `/collections*`, `/me/collections*`, requests, statement, export.
- Writes: `collections`, `collection_requests`, mandatory-collection invoices through `invoices.createAdHoc`.
- Calls: `paymentsPorts().funds`, `notices`, `approvals`; request money effects happen in the core (`settleInput`), which keeps `collection_requests.paidPaise` and enqueues `collections:refresh-totals`; you own that job.
- Registers `COLLECTION_PUBLISH` hooks and the dev hook; own stub: `collections.get`, `collections.efficiency`.

## Status

- [x] Foundation
- [ ] 12.1 online
- [x] 12.2 offline
- [ ] 12.3 admin
- [ ] 12.4 refunds and AutoPay
- [ ] 12.5 collections
