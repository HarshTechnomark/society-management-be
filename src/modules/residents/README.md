# Module 09 Residents, ownership and tenants

## Part 3: renovation permits and ownership transfers

Files (all new, prefix `residents.renovations.*`, `residents.transfers.*`, `residents.part3.*`):

- `residents.renovations.service.ts` permit create, patch, resubmit, start, extend, violations, suspend, resume, work done, inspect, cancel, module 14 callbacks, module 13 deposit hooks, gate list and `passValidAt`, the daily job body.
- `residents.transfers.service.ts` transfer create, patch (DRAFT, or after changes were requested from the app), submit, cancel, module 14 callbacks, complete.
- `residents.transfers.fees.ts` the BR-09-64 fee rules and caps. `residents.transfers.docs.ts` the BR-09-63 document checklist.
- `residents.part3.routes.ts` all part 3 routes, mounted from `residents.routes.ts` with one `r.use(part3Routes)`.
- `residents.part3.ports.ts` placeholder ports for modules 11 (`invoices`), 13 (`deposits`), 14 (`approvals`), 23 (`shareCertificates`, `ruleViolations`). Replace them with `setResidentPart3Ports({...})` at start-up. `unitLedger.balance` is the part 1 port. Every placeholder call is recorded in `part3PortCalls`.
- `residents.part3.approvals-hook.ts` registers the module 14 handlers and exports `approve(approvalRequestId, actorCtx)` and `reject(approvalRequestId, reason, actorCtx)` (public names `approvePart3Request`, `rejectPart3Request`). They run the same `onApproved` or `onRejected` the module 14 inbox will run, for requests held in the placeholder's in-memory store (`approvalStore`). A development-only route can call them until module 14 exists. With `placeholderState.autoApprove = true` the placeholder approves inside `approvals.request`, as module 14 does when no rule matches.
- `residents.part3.jobs.ts` registers `residents:renovation-daily` (00:30 IST) on queue `residents`.
- `residents.part3.templates.ts` notification templates of section 10 for permits and transfers.

Rules worth knowing:

- A permit raised by an admin has no requester; its documents are kept on the flat's primary owner (`resident_documents.residentId` cannot be null outside join requests).
- Every action takes the row `version` (`409 STALE_VERSION`). Approval callbacks are idempotent: they return when the entity is no longer pending.
- Transfer completion runs in one transaction: unit lock, link locks, tenancy lock, transfer lock; sellers snapshot check (`409 TRANSFER_SELLER_MISMATCH`); dues policy (`422 TRANSFER_DUES_PENDING`); seller links end on `effectiveDate - 1` (`SOLD` for a sale, else `TRANSFERRED`); buyer links start on `effectiveDate` (primary buyer `OWNER`, others `CO_OWNER`, a sole buyer carries no stored share); owner-household FAMILY and CARETAKER links end unless a seller continues as a buyer; a live tenancy gets the new primary owner as landlord, or ends with `OWNER_SOLD` when `endTenancy` is true; module 23 hand-off; status `COMPLETED`.
- Transfer fee invoices are not stored on the transfer row; the detail reads them through `invoices.listForRef` (module 11), and cancelling an approved transfer calls `invoices.cancelForRef`.
- The transfer premium is charged for `SALE` and `COURT_ORDER` (a `GIFT` carries one only when given explicitly); it is forced to 0 for the other types.
- Jobs: the in-process runner is used when `REDIS_URL` is not set (same processors); `runRenovationDaily(societyId)` is tested directly.
