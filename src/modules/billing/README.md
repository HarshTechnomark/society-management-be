# Module 11 · Maintenance Billing and Invoices (backend)

Spec: `Markdown_for_AI/11_Maintenance_Billing.md`. Sub-modules: 11.1 setup (this section), 11.2 unit ledger and opening balances,
11.3 calculator, billing runs and issue, 11.4 invoices, notes and PDFs, 11.5 late fee job, reminders, dashboard and resident bills.

## 11.1 Charge heads, billing rules and versions, bill split rules, late fee policies

Files (prefix keeps the sub-modules apart): `billing.heads.*` (seed list, service, Zod), `billing.rules.*` (service, dto, Zod,
`billing.rules.approvals-hook.ts`), `billing.split.ts` (pure split), `billing.split.*` (service, Zod), `billing.latefee-policy.*`,
`billing.setup.*` (routes, controller, shared helpers, scope checks, setup-mode test). Routes are mounted by `billingSetupRoutes` in `app.ts`.
Tests: `tests/modules/billing/{heads,rules,split,latefee-policy,access}.test.ts`, helper `tests/helpers/billing-setup.ts`.

- **Routes (8.1 to 8.4).** Charge heads: `GET|POST /billing/charge-heads`, `PATCH|DELETE /billing/charge-heads/:id`. Rules: `GET|POST /billing/rules`,
  `GET|PATCH|DELETE /billing/rules/:id`, `POST /billing/rules/:id/versions`. Split rules: `GET|POST /billing/split-rules`, `PATCH|DELETE /billing/split-rules/:id`.
  Late fee policies: `GET|POST /billing/late-fee-policies`. Order on a route: society marker, permission (`settings.billing_rules.view` for reads,
  `.edit` for writes), entitlement, validate, idempotency (creates). `POST /billing/rules/simulate` is built by 11.3 (`billing.sim.*`).
- **Heads.** `chargeHeads.ensureSeeded(societyId, t?)` inserts the 30 heads of 7.13 that are missing (by `key`, `INSERT IGNORE`; existing rows are never
  touched). It runs on the first read or write of heads and rules and from the demo seeder (the `BILLING` onboarding check of module 08 calls it when 11.5 registers it).
  BR-11-9 routing, BR-11-10 SAC (required only when the request sets a taxed treatment or a SAC; the seeded heads keep a NULL SAC until publish, 5.6), BR-11-11 system heads,
  BR-11-12 ledger code (port `journal.accountExists`, format only until module 13), BR-11-13 archive only without a live approved non-`NONE` version, BR-11-31 GST treatment
  per head type. There is no restore route (the spec has none).
- **Rules and versions.** All checks of BR-11-14 to BR-11-21 are in `billing.rules.service.ts`. The parent rule row is locked `FOR UPDATE` (a new rule locks the head row).
  `effectiveFrom` must start a period of the society's cycle (`isPeriodStart`) and be after the `periodEnd` of the latest ISSUED regular run. **Setup mode**
  (no ISSUED regular run yet): versions and late fee policies are approved at once, audit reason `SETUP_MODE`, and the first approved rule creates the first late fee policy from
  the module 08 defaults. Afterwards a version is `PENDING_APPROVAL` and `approvals.request` (type `BILLING_RULE_CHANGE`, entity `billing_rule_version`) is called; if the
  port answers `APPROVED` the version is activated in the same transaction. Activation (`activateVersion`) repeats the BR-11-20 checks, closes the previous version
  (`effectiveTo = F - 1`) and closes the new one before a later approved version. Versions are immutable (model hook).
- **Rate payloads** are validated per rate type with strict Zod objects (a foreign field is 400). METERED needs `billing.metered_water_slabs` and a registered meter source (422 otherwise); the last
  slab must be open (`uptoMilli: null`). NON_OCCUPANCY: percent or none, at most 10, maintenance bases only; no chains (BR-11-19). The calculator itself is 11.3.
- **Split rules.** `billing.split.ts` has `splitPaise(total, [{ unitId, weight }])` (BR-11-22, bigint, exact, remainder to the largest fraction then the lowest unit id) and
  `splitWeight(basis, unit, weights)` (EQUAL, AREA, UNIT_TYPE_WEIGHT, CUSTOM_WEIGHT; returns the exception code for a missing area or type rate). Both are exported from
  `billing.public.ts` for the compute engine.
- **Late fee policies.** Create only (a "change" is a new policy with a later `effectiveFrom`); `billingSetup.policyFor(societyId, date)` returns the ACTIVE policy effective on a date for the job of 11.5.
- **Approvals (placeholder).** `registerBilling()` registers both types with `billingPorts().approvals.registerType` (`registerSetupApprovals`). `billing.rules.approvals-hook.ts`
  exports `approve(approvalRequestId, ctx)` and `reject(approvalRequestId, reason, ctx)` like `residents.part3.approvals-hook.ts`: they find the version or policy by its stored
  `approvalRequestId`, run `onApproved` or `onRejected` in one transaction and return `{ type, entityId, status }`. The coordinator can wire a development-only route to them.
  The placeholder `approvals.request` hands out ids from one counter shared by all billing types, so the id is unique across billing.
- **Audit.** `billing.charge_head.*`, `billing.rule.*`, `billing.rule_version.created|approved|rejected`, `billing.split_rule.*`, `billing.late_fee_policy.*`. No realtime events in 11.1 (none in 9.4).
- **Demo seed.** `seeders/billing-setup.ts` (wired in `scripts/seed.ts`, not run in production): the heads for the three demo societies and, for Sky Heights and Green Park,
  rules MAINTENANCE per sq ft 320, SINKING_FUND 60,000 and WATER 35,000 paise from 2026-04-01 (setup mode, so also the 18 % policy with 5 grace days). Tulip Gardens: heads only. The ISSUED
  run of Sky Heights is 11.3. Idempotent by rule name.

## 11.3 Calculator, compute engine, billing runs and issue

- **Files.** `billing.calc.*` (pure, no database: `period` cycles and labels, `rates` the formulas of BR-11-17 as fractions, `rules` specificity BR-11-14, `segments` liable
  segments and owner party BR-11-26/27, `gst` the 7,500 test, CGST/SGST and round-off, `unit` the calculator of one flat), `billing.runs.*` (`compute` the engine of 6.3, `service`
  routes 8.5 to 8.10, `shared`, `jobs`, `approvals-hook`, `validation`, `controller`, `routes`, `templates`), `billing.issue.service.ts`, `billing.sim.*` (rule simulation).
  The split uses `billing.split.ts` of 11.1 (one implementation).
- **Calculator.** Each line is one `roundHalfUp(num x liableDays, den x periodDays)`; a party's days for a head are summed over its segments, so a tenancy that cuts the month
  does not add a second rounding. `PERCENT_OF_HEADS` after the other heads; NOC counts only tenancy days and goes to the owner. `B` (GST test) uses the unprorated full amounts of
  THRESHOLD heads that produced a line. METERED and SPLIT_TOTAL lines are never prorated. Line `computation` is always stored in the snapshot and hidden in responses without `billing.explain_my_bill`.
- **Compute job.** `billing:compute-run` (`jobId compute:<runId>:<version>`): DRAFT to COMPUTING, bill-to resolved with module 09 `billToFor` per segment, split shares across all
  billable flats, items written in transactions of 200 flats, then PREVIEW (`computedAt` is the START of the compute, so changes made while it ran make the run stale). Failures that
  cannot succeed on retry (`SPLIT_NO_ELIGIBLE_UNITS`, no meter source, missing split input) mark the run FAILED at once; other errors retry and FAILED after 5 attempts (counted in process).
  Progress: `itemCount` grows per batch, `billing.run.updated` is emitted per batch and `GET /billing/runs/:id` has `progress` while COMPUTING (this process only).
- **Run labels.** `BR-YYYY-MM`; `uq_billing_runs_label` is unique per society, so a regular run re-created after a cancel is `BR-2026-11-R2`.
- **Publish.** Needs `confirmLabel` and `version`; optional `previewHash` (from `GET /billing/runs/:id` while in PREVIEW, over the items, states and totals) turns a mismatch into `409 RUN_STALE`.
  No step-up (the spec does not list one for publish). Approval type `BILLING_RUN_PUBLISH` through the port; `billing.runs.approvals-hook.ts` exports `approve(id, ctx)`,
  `reject(id, reason, ctx)` and `requestChanges(id, ctx)` for a development route; the placeholder enforces maker-checker (`409 MAKER_CHECKER_VIOLATION`). The placeholder
  request store lives in `billing.ports.ts` (`placeholderApprovalRequests`).
- **Issue job.** `billing:issue-run` (`jobId issue:<runId>:<version>`), per item one transaction: unit lock, item lock, dedupe, previous dues, `nextNumber` (prefix from the setting),
  invoice, lines, `unitLedger.post`, journal, readings marked billed, item ISSUED, `issuedCount + 1`; realtime and notifications after commit. Errors set `lastError` and rethrow
  (queue retries; `POST /billing/runs/:id/resume-issue` re-enqueues). `billing:start-scheduled-issues` (daily 00:15 IST) starts APPROVED runs on their bill date.
- **Not done here.** PDF rendering (`pdfStatus` stays PENDING, 11.4), advance auto-apply (module 12 port has no `queueAdvanceApply`), `reportsCache.touch`, late fees and reminders (11.5).
