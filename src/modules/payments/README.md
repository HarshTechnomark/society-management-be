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

- `payments.settle.ts`: `settleInput(ctx, input: SettleInput, t)` creates the effective payment in the caller's transaction:
  payment row, allocation (oldest first or `SELECTED`, rest to advance), invoice updates through module 11, advance row,
  receipt number, unit ledger credit, journal (6.9), audit `payments.payment.captured|recorded`, and `afterCommit`
  realtime, receipt-render job and advance-apply job. Idempotent by `gatewayPaymentId` and `referenceKey` (returns the
  existing payment). `settleCapture(gatewayAccountId, gp, ctx?)` is the 6.8 online entry (order lookup and locks,
  mismatch/duplicate/cancelled rules, `PaymentOrder` to PAID). Offline parts call `settleInput` on approval.
- `payments.alloc.plan.ts`: `buildPlan(open, input)` pure function (BR-12-15/16/17), `loadOpenTargets`.
- `payments.advances.ts`: `advanceBalance(societyId, unitId, t?)`, `postAdvance(ctx, unitId, entry, t)` (needs the unit lock, checks never negative, dedupe key),
  `applyAdvancesForUnit(ctx, societyId, unitId, t)` (job body), `creditOpeningAdvance`.
- `payments.receipts.core.ts`: `issueReceipt(payment, t)`, `cancelReceipt`, `bumpReceiptRevision`.
- `payments.reverse.core.ts`: `reverseAllocations(ctx, payment, opts, t)` is the one routine for reverse, bounce, return, refund freeing, reallocation and
  invoice cancel (negative rows, `invoices.reverseAllocation`, advance release, request totals, payment part columns).
  `reversePaymentCore(ctx, paymentId, {newStatus, reasonCode, reason}, t)` also removes excess advance, cancels the receipt and journals the mirror.
- `payments.duplicates.ts`: `referenceKeyOf`, `findDuplicateReference`, `findDuplicateSuspect` (F22).
- `payments.shared.ts`: `lockUnit`, `societyToday`, `setting(societyId, key)`, `emitFinance`, `paymentToAudit`, `auditPayment`.
- Journal builder: `payments.journal.ts` `captureJournal`, `mirrorJournal`, `advanceAppliedJournal`.

Lock order (BR-12-19) is: approvals request → order → unit (`units.lockActive`) → invoices → collection request → collection.

## Rules for every part

- Files only with your prefix (below). Shared files you may touch with **additive lines only**: `src/app.ts` (one `api.use(...)`
  mount line of your routes), this README (tick your part at the bottom), `scripts/seed.ts` and `seeders/payments.ts` (your own function in a
  file `seeders/payments-<part>.ts`, plus one call line), `payments.public.ts` (replace the body of the stubs you own; keep the signature),
  `src/modules/dev/dev.routes.ts` (one line in `PAYMENTS_APPROVAL_HOOKS`), `payments.jobs.ts` registry (one `register...()` call line in `registerPaymentJobs`).
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
- Own `payments.public.ts` stubs: `createOrder`, `registerOrderHook`, `getOrder`, `findByGatewayPaymentId`, `onUnitLinkEnded` (order part).

### 12.2 offline (prefix `payments.offline`, `payments.cheques`, `payments.declared`)

Spec: 8.6, 8.11, 8.12; F08–F10, F22 offline part; section 5.5; approval type `OFFLINE_PAYMENT`.

- Routes: `POST /payments/offline`, cheque routes (deposit batch, clear, bounce, return), `POST /me/payments/declared`.
- Writes: `payments` (PENDING_APPROVAL and cheque lifecycle columns), files link (`PAYMENT_PROOF`); money effects only through `settleInput` (on approval) and `reversePaymentCore` (bounce, return).
- Calls: `settleInput`, `reversePaymentCore`, `findDuplicateReference`, `findDuplicateSuspect`, `paymentsPorts().approvals`, `bankAccounts`, billing `invoices.createAdHoc` for the bounce charge.
- Registers the real `OFFLINE_PAYMENT` hooks and adds them to `PAYMENTS_APPROVAL_HOOKS`; jobs `cheque-reminder`; notifications `offline_rejected`, `cheque_received`, `cheque_bounced`, `cheque_deposit_due`.
- Own stubs: `chequeReturnCount`, `chequeReturnCounts` (and replace the placeholder in the billing port).

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
- [ ] 12.2 offline
- [ ] 12.3 admin
- [ ] 12.4 refunds and AutoPay
- [ ] 12.5 collections
