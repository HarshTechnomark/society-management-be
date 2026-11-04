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
  `.edit` for writes), entitlement, validate, idempotency (creates). `POST /billing/rules/simulate` is not built: it needs the calculator (11.3).
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
