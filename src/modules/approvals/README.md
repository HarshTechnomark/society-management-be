# Module 14 · Approvals engine (backend)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/14_Approvals_Engine.md`. Branch state: **14.3 done on top of module 13**
(`app.ts` mounts the rules/settings/delegations router before the inbox router; `server.ts`, `worker.ts` and `scripts/seed.ts`
call `wireApprovalsPorts()` and `registerApprovals()`). Modules 11, 12 and 13 run on the real engine everywhere, tests included:
their `approvals` port defaults to `engineApprovals` (`billing.ports.ts`). The development stand-in `/dev/approvals*` is gone;
decisions are taken in the inbox (`POST /approvals/:id/approve|reject|request-changes`). Module 09 keeps its auto-approving
placeholders for its own unit tests only (`approvalStub`, `approvalStore`); production wires it to the engine.

## What exists

| File                                                             | What it holds                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations/20261119000100..400`                                 | `approval_rules`, `approval_requests`, `approval_delegations`, `approval_actions` (7.1 to 7.4, CHECKs, generated `liveFlag`, `openFlag`, `approvalPrincipal`, `approvalActor`, unique keys of BR-14-8 and BR-14-16) |
| `src/models/approval-*.model.ts`                                 | four models, associations in `models/index.ts`; `ApprovalAction` is append-only (update and destroy throw)                                                                                                          |
| `approvals.constants.ts`                                         | permissions, entitlements, setting keys, enums, limits, error codes, job and queue names, audit actions, realtime events, notification keys                                                                         |
| `approvals.catalogue.ts`                                         | the 31 types of 5.1 (`CATALOGUE`, `APPROVAL_TYPES`), the 7.5 default rules (`DEFAULT_RULES`), step names                                                                                                            |
| `approvals.types.ts`                                             | `ApprovalCtx`, `TypeHandlers` (8.20), snapshot and step shapes                                                                                                                                                      |
| `approvals.match.ts`                                             | pure: rule matching (BR-14-3), canonical hash, slots, capacity and widening (BR-14-11), `openSlotFor` (6.2), `assessRule` (BR-14-32)                                                                                |
| `approvals.registry.ts`                                          | `registerType` (BR-14-2), boot log of unregistered types                                                                                                                                                            |
| `approvals.rules.seed.ts`                                        | lazy, idempotent default seed (BR-14-6)                                                                                                                                                                             |
| `approvals.route.ts`                                             | rule match, snapshot, step-up and bulk flags, SLA columns                                                                                                                                                           |
| `approvals.eligibility.ts`                                       | identities, delegations (BR-14-23 to 25), maker-checker, distinct approvers, who to notify                                                                                                                          |
| `approvals.engine.ts`                                            | `request`, `resubmit`, `cancel`, `cancelByRequester`, `lockOpenForEntity`, `getOpenForEntity`, `publicStatus`, stuck handling                                                                                       |
| `approvals.decide.ts`                                            | `approve`, `reject`, `requestChanges` (decision transaction 6.3, version lock, deadlock retry, step-up check)                                                                                                       |
| `approvals.notify.ts`, `approvals.ports.ts`, `approvals.jobs.ts` | notifications through a port, realtime, `approvals:notify-approvers`                                                                                                                                                |
| `approvals.port.ts`, `approvals.port.residents.ts`               | the real engine behind the placeholder ports (see below)                                                                                                                                                            |
| `approvals.public.ts`                                            | the only import other modules use; `registerApprovals()`                                                                                                                                                            |

Tests: `tests/modules/approvals/` (`approvals.match.test.ts`, `approvals.engine.test.ts`, `approvals.contract.test.ts`).
Helper: `tests/helpers/approvals.ts`. `tests/helpers/auth.ts` `resetAll` also clears the four tables.

## The port: switching a module is one line

`realApprovals` has exactly the interface of `ApprovalsPort` of `billing.ports.ts` and `payments.ports.ts`
(`registerType`, `request`, `resubmit`, `cancel`, `lockOpenForEntity`). Switch with
`setBillingPorts({ approvals: realApprovals })` or `setPaymentsPorts({ approvals: realApprovals })` before
`registerBilling()` / `registerPayments()`. The adapter hides three differences from the native 8.20 API:

1. Placeholder hooks take the entity id: `onApproved(ctx, entityId, t)`, `onRejected(ctx, entityId, reason, t)`, and
   `describe(entityId)` returns a flat list of facts. The adapter wraps them into native `TypeHandlers`. `onExpired` is passed
   through when a module registers it (payments does).
2. **Auto-approval contract.** The callers in billing and payments apply the action themselves when `request` returns
   `status: 'APPROVED'` (`if (req.status === 'APPROVED') await cancelInvoiceNow(...)`), while the spec (BR-14-4) has the engine
   call `onApproved` inside `request`. The port therefore passes `callOnApproved: false`. Native callers (module 09 through
   `realPart2Approvals`, modules 13 and later) get the spec behaviour. 14.3 should end the difference: let every caller rely on
   the engine and drop the `if (status === 'APPROVED')` branches, then remove the option.
3. `lockOpenForEntity(societyId, entityType, entityId, t)` finds the open request by **entity type**, like the placeholders.

`realPart2Approvals` and `realPart3Approvals` do the same for the two other shapes module 09 uses
(`part2Ports().approvals`, `part3Ports().approvals`: handlers get a request reference `{ id, societyId, entityId, type, reason }`,
`request` returns `{ id, autoApproved }` or `{ id }`, `publicStatus` returns `{ status }`). The committee port
(`createHandoverDelegation`) needs the delegation service (14.2).

## Approval types in use by modules 05 to 13

Owner module, `entityType` (must equal the catalogue; `request()` rejects a different one with 400) and the hooks it registers.
All use the `approvals` port of the module, shown in the last column.

| Type                                                                  | Owner | entityType                                                       | Hooks registered today                                                                     | Port today                                               |
| --------------------------------------------------------------------- | ----- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| JOIN_REQUEST                                                          | 09    | `join_request`                                                   | onApproved, onRejected, describe, onChangesRequested?, onCancelled?                        | `part2Ports().approvals` (`residents.public.ts`)         |
| MOVE_IN, MOVE_OUT                                                     | 09    | `move_request`                                                   | same (`moveHandlers`)                                                                      | `part2Ports().approvals`                                 |
| RENOVATION_PERMIT                                                     | 09    | `renovation_permit`                                              | onApproved, onRejected, onChangesRequested, onCancelled, describe (`permitApprovals`)      | `part3Ports().approvals` (`registerPart3Approvals`)      |
| OWNERSHIP_TRANSFER                                                    | 09    | `ownership_transfer`                                             | same (`transferApprovals`)                                                                 | `part3Ports().approvals`                                 |
| BILLING_RUN_PUBLISH                                                   | 11    | `billing_run`                                                    | onApproved (`onRunApproved`), onRejected, onChangesRequested, describe                     | `billingPorts().approvals` (`registerRunApprovalType`)   |
| BILLING_RULE_CHANGE                                                   | 11    | `billing_rule_version`                                           | onApproved, onRejected, describe (`ruleApprovalType`)                                      | `billingPorts().approvals`                               |
| LATE_FEE_POLICY_CHANGE                                                | 11    | `late_fee_policy`                                                | onApproved, onRejected, describe (`policyApprovalType`)                                    | `billingPorts().approvals`                               |
| CREDIT_NOTE, WRITE_OFF                                                | 11    | `billing_note`                                                   | onApproved, onRejected, onChangesRequested, onCancelled, describe                          | `billingPorts().approvals` (`registerNoteApprovalTypes`) |
| INVOICE_CANCEL                                                        | 11    | `invoice`                                                        | onApproved (`onCancelApproved`), onRejected (no-op), describe                              | `billingPorts().approvals`                               |
| OFFLINE_PAYMENT                                                       | 12    | `payment`                                                        | onApproved, onRejected, onCancelled, onExpired, describe                                   | `paymentsPorts().approvals`                              |
| PAYMENT_REFUND                                                        | 12    | `refund`                                                         | onApproved, onRejected, onCancelled, describe                                              | `paymentsPorts().approvals`                              |
| COLLECTION_PUBLISH                                                    | 12    | `collection`                                                     | onApproved, onRejected, onChangesRequested, onCancelled, describe                          | `paymentsPorts().approvals`                              |
| EXPENSE, MANUAL_JOURNAL, FUND_TRANSFER, DEPOSIT_REFUND, PERIOD_UNLOCK | 13    | `expense`, `journal_entry`, `fund`, `deposit`, `society_balance` | onApproved, onRejected, describe, onChangesRequested / onCancelled where the type has them | `accountsPorts().approvals` (= `engineApprovals`)        |

Not yet registered by anyone (log only): PURCHASE_ORDER, VENDOR_BILL (21), NOTICE_PUBLISH (16), BOOKING (18),
SUBSCRIPTION_CANCEL (04), FINE_WAIVER, CERTIFICATE_REQUEST, SHARE_CERTIFICATE_ACTION (23), GATEWAY_* (29),
AUTOMATION_RULE_ACTIVATE (30), MINUTES (22). Module 10 uses `createHandoverDelegation` and `onMemberEnded`; module 08 already
holds the two setting keys (`approvals.stepUpAbovePaise`, `approvals.bulkApproveBelowPaise`).

## Split of the remaining work

- **14.1 engine core, remainder** (file prefix `approvals.engine.*`, `approvals.jobs.*`): reassign (BR-14-21, `stepOverrides`),
  `approvals:sla-sweep` (reminders, escalation with `ESCALATION` slots, expiry, `CHANGES_REQUESTED` after 30 days, daily
  recompute), `approvals:recheck-member` and `approvals.onMemberEnded`, `approvals:delegation-sweep`, `countForUser`, bulk
  approve service (BR-14-27), the module 05 society-state guard and job skip (BR-14-30), export provider and purge handler
  (module 05), `registerApprovals()` lines in `server.ts` and `worker.ts` (repeatables with `registerRepeatable`).
- **14.2 inbox, history, rules, settings, delegations, resident** (prefixes `approvals.inbox.*`, `approvals.history.*`,
  `approvals.rules.*`, `approvals.settings.*`, `approvals.delegations.*`, `approvals.resident.*`; routes, controllers,
  validation): 8.1 to 8.6 inbox, counts (epoch bump), submitted, types, history, detail with `describe()`; 8.7 to 8.11 decision
  routes with `Idempotency-Key`, `requireRecentAuth` guard and visibility (BR-14-26, 404 for invisible); 8.12 to 8.16 rules CRUD
  with BR-14-28 validation, warnings (`RULE_SHADOWED`, `COVERAGE_GAP`, `RULE_MAY_BE_UNSATISFIABLE` via `assessRule`),
  reset defaults, simulate, `approvals:rule-health`; 8.17 settings; 8.18 delegations (BR-14-24, plan gate
  `iam.approval_delegation`) with `createHandoverDelegation`; 8.19 resident endpoints; tenant-isolation and permission-matrix
  entries.
- **14.2a done** (`approvals.inbox.*`, `approvals.history.*`, `approvals.resident.*`): 8.1 to 8.11 and 8.19 are routed and tested
  (`tests/modules/approvals/approvals.inbox.test.ts`). `approvals.inbox.eval.ts` is the one evaluator of visibility and `myAction`;
  `approvals.inbox.adapter.ts` holds `engine.reassign` as a local implementation: when 14.1's `reassign` lands in
  `approvals.engine.*`, point the adapter at it and delete `localReassign`. `emitChanged` bumps the count epoch
  (`approvals.inbox.epoch.ts`). `/approvals/:id` handlers skip non-numeric ids, so 14.2b's `/approvals/rules` and the like work in any mount order.
- **14.2b done** (prefixes `approvals.rules.*`, `approvals.settings.*`, `approvals.delegations.*`): rules CRUD, reset, simulate, `approvals:rule-health`, settings, delegations and `createHandoverDelegation` (`approvals.delegations.service.ts`; committee port wiring is 14.3). Router `approvalsRulesRoutes` must be mounted before the inbox router's `/approvals/:id`.
- **14.3 wiring** (prefix `approvals.wire.*`): **done for modules 05 to 12** in `approvals.wire.ts` (`wireApprovalsPorts()`: billing, payments, residents part 2 and 3, committee `createHandoverDelegation`, access-control `onMemberEnded`); the stand-ins are still to delete (next section). End-to-end proof over HTTP: `tests/modules/approvals/approvals.wiring.e2e.test.ts`.

## 14.3 switch-over (done)

- Migrations renamed to `20261119000100..400` so they run after module 13 (`20261118000100..001200`).
- `request` / `resubmit` always run `onApproved` on auto-approval (BR-14-4); the `callOnApproved` option is gone. Callers in
  billing (runs, rule versions, late fee policies, credit notes, write-offs, invoice cancel), payments (offline, refunds,
  collections) and accounts (journals, deposit refunds, period unlock) put the entity in its pending state first and never apply
  the action themselves; they re-read the entity after `request`.
- The entity-id adapter passes the request on `ctx.approval` (`{ requestId, actorUserId, payload }`, read with
  `approvalOf(ctx)` of `billing.ports.ts`): fund transfers and period unlocks read their payload there; hooks that check
  maker-checker themselves skip it when module 14 already did (`ctx.approval` present).
- Module 13's expense DTO: `approvalThresholdPaise` is the top of the society's live `EXPENSE` auto-approve band from 0 (7.5
  default: 500000), `approvalRequired = grossAmountPaise > approvalThresholdPaise`.
- Removed: `/dev/approvals*`, the `BILLING_/PAYMENTS_/ACCOUNTS_APPROVAL_HOOKS` dispatch and `?source=`, the decide helpers of the
  `*.approvals-hook.ts` files of billing, payments and accounts (the `register*` functions stay), the placeholder stores
  `placeholderApprovalRequests/Types`, `placeholderPaymentApprovals/Types`, `placeholderAccountsApprovals/Types`. Module 09's
  stubs and their decide helpers stay (its tests drive its handlers with them).
- `decideAsCommittee(requestId, verb)` (`approvals.committee.ts`, exported by `approvals.public`) decides through the real path as
  the society's eligible members: used by the demo seed. Tests use `tests/helpers/approvals-decide.ts` (inbox over HTTP,
  committee decisions, `everyRequestNeeds` and `autoApproveType` rule fixtures).

## Notes

- Money is integer paise; times come from `lib/clock`. Notifications use the `notify()` stand-in through
  `approvalsPorts().notifications` (module 16 replaces it); realtime uses `lib/realtime`.
- No Redis: the job `approvals:notify-approvers` runs on the in-process runner in dev and tests (same processor).
- Cancel through the owner port accepts any non-empty reason (the placeholders' callers pass short fixed texts); the API cancel
  by the requester enforces 5 to 500 characters (BR-14-12).
