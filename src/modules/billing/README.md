# Module 11: Maintenance billing (backend foundation)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/11_Maintenance_Billing.md`. Branch `module/11-maintenance-billing`.

This commit series is the **foundation only**: tables, models, constants, money helpers, ports, the public placeholders,
registration, export and purge. There are no services and no routes yet. Three sub-modules build on it in parallel.

## Who builds what

| Sub-module | Owns (spec sections)                                                                                                                                                                                                                                                                                                                   | Fills in                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **11.1**   | Charge heads (`chargeHeads.ensureSeeded`, section 7.13 seed), billing rules and versions (BR-11-14 to 21), split rules (BR-11-22/23, section 8.3), late fee policy configuration (BR-11-51 to 54 config, 8.4); routes 8.1 to 8.4; module 08 onboarding check `BILLING`; approval types `BILLING_RULE_CHANGE`, `LATE_FEE_POLICY_CHANGE` | new `billing.heads.*`, `billing.rules.*`, `billing.split.*`, `billing.policies.*` files                          |
| **11.2**   | `unitLedger.post` and `unitLedger.balance` (BR-11-57 to 59), opening balances import, post, reverse (BR-11-65/66, 8.23), unit statement (8.20), module 08 unit guard `UNIT_HAS_BALANCE`                                                                                                                                                | `billing.ledger.service.ts` (replace the two placeholder bodies), new `billing.opening.*`, `billing.statement.*` |
| **11.3**   | Calculator per rate type (BR-11-17 to 19, 28 to 31), GST (BR-11-30 to 32), compute engine (6.3), billing runs, exclude, publish, issue, `billing:*` run jobs (8.5 to 8.10)                                                                                                                                                             | new `billing.calculator.ts`, `billing.compute.ts`, `billing.runs.*`, `billing.issue.*`                           |
| later      | invoice service (`invoices.*` bodies), notes, cancel, write-off, reminders, defaulters, PDF, late fee job, reconcile                                                                                                                                                                                                                   | `billing.invoices.service.ts`                                                                                    |

Edit your own files; keep `billing.public.ts`, `billing.constants.ts` and the ports file for additive edits only, so the
three branches merge without conflicts. Add a line to `registerBilling()` in `billing.public.ts` for each hook or job you register.

## Files

- `billing.constants.ts`: every enum (same lists as the migration CHECKs), `GST_RATE_PCT`, `GST_HALF_RATE_PCT`, `VARIANCE_WARN_PCT`,
  reminder and defaulter constants, `JOBS` and `BILLING_QUEUE`, `AUDIT` action names (section 9.3), `REALTIME` events,
  `PERMISSIONS`, `FEATURES` (entitlement keys), `APPROVAL_TYPES`, `INVOICE_PDF_PURPOSE`, `CYCLE_MONTHS`.
- `billing.types.ts`: `LedgerPostInput`, `InvoiceDto`, `InvoiceLineDto`, `InvoiceBalanceDto`, `OpenInvoiceDto`, `CreateAdHocInput`,
  `MeterSource`, `MeterConsumption`; re-exports `Ctx`, `SystemCtx`, `Transaction`.
- `billing.ports.ts`: ports and fakes (below). `billing.public.ts`: the exported API and `registerBilling()`.
- `billing.ledger.service.ts` (`unitLedger`), `billing.invoices.service.ts` (`invoices`): placeholders, bodies throw `not implemented: <name>`.
- `billing.exports.ts`, `billing.purge.ts`: module 05 export provider, purge handler, retention expiry handler.
- `src/lib/money.ts` (shared, extended): `roundHalfUp(n, d)` (number result, accepts bigint), `roundHalfUpBig`, `percentOf`, `rateUnits` and
  its alias `rate4('21.0000') = 210000n`, `areaMilli('1150.500') = 1150500n`, `rupeesToPaise('12.50') = 1250`, `floorShare(T, w, W)`,
  `formatRupees`. Tests: `tests/lib/money.test.ts` (including seeded property loops).
- Models in `src/models/`: `ChargeHead`, `BillSplitRule`, `BillingRule`, `BillingRuleVersion`, `LateFeePolicy`, `BillingRun`,
  `BillingRunItem`, `Invoice`, `BillingNote`, `InvoiceLine`, `UnitLedgerEntry`, `OpeningBalance`, with the associations of section 7
  and `_immutable.ts` (`immutableHooks(table, mutableColumns, lockedWhen?)`).

## Tables (migrations `20261111000100` to `20261111001200`)

`charge_heads`, `bill_split_rules`, `billing_rules`, `billing_rule_versions`, `late_fee_policies`, `billing_runs`, `invoices`,
`billing_run_items`, `billing_notes`, `invoice_lines`, `unit_ledger_entries`, `opening_balances`; `down` drops in reverse. Every column,
unique, index and CHECK of 7.1 to 7.12 is there (rate-type field rules per version, invoice arithmetic, ledger exactly-one-sided, line
single parent, note reason by type). No generated columns exist in section 7. Deviations, on purpose:

- **No database FK to `units`, `residents` or `files`** from the financial tables: module 05 keeps financial rows after closure
  (BR-05-21) while modules 08 and 09 purge their own rows, so an FK would block the purge. The columns are indexed BIGINT snapshots with
  `unitLabel`/`billToName` kept beside them. FKs to `societies` (RESTRICT) and between the module's own tables are all there.
- `charge_heads`: "sacCode required when taxed" is **not** a CHECK, because section 7.13 seeds every head with a NULL sacCode. It is the
  service check `422 GST_SETTINGS_INVALID` at publish and ad-hoc creation.
- `billing_notes`: CREDIT reasons are `BILLING_ERROR, WAIVER, DISPUTE_RESOLUTION, CANCELLATION, WRITE_OFF, SOURCE_REFUND, OTHER`
  (the spec's "first seven + OTHER" is read as the seven non-debit reasons); DEBIT reasons are as written.
- Unit, resident, file and approval columns are plain ids (the spec's "logical" columns).

## Immutability (BR-11-6)

Model hooks (`beforeUpdate`, bulk updates run the per-row hook, `beforeDestroy` and bulk destroy throw): `Invoice` (only the columns of
`INVOICE_MUTABLE_COLUMNS`), `InvoiceLine` (`creditedPaise`, `updatedBy`), `BillingRuleVersion` (status, effectiveTo, approval columns),
`BillingNote` (after ISSUED only `pdfFileId`, `pdfStatus`, `updatedBy`, `version`), `UnitLedgerEntry` (no update, no delete, no `updatedAt`),
`BillingRun` (never deleted), `OpeningBalance` (POSTED and REVERSED never deleted). Raw SQL bypasses hooks: change these rows only through the model.

## Ports (`billing.ports.ts`, section 1.1)

`billingPorts()` returns `{ approvals, journal, notifications, payments, meters }`; `setBillingPorts({...})` replaces some (modules 12, 13,
14, 16 and 21 do this at start-up, tests do it too; no argument restores the fakes and clears `billingPortCalls`).

- `approvals` (module 14): `registerType`, `request`, `resubmit`, `cancel`, `lockOpenForEntity`. Fake: request returns `PENDING`, records calls.
- `journal` (module 13): `post` (fake refuses unbalanced entries), `accountExists` (fake checks the code format, BR-11-12), `isDateLocked`.
- `notifications` (module 16): `send(template, userIds, data)`; fake delegates to `lib/notify.ts`, never throws.
- `payments` (module 12): `advanceBalance`, `applyAdvanceToInvoice`, `creditOpeningAdvance`, `onInvoiceCancelled`,
  `listAllocationsForInvoice`, `chequeReturnCount`. Safe production defaults: no advance, no allocations.
- `meters` (module 21): `getSource(type)`, `markBilled`; `registerMeterSource(type, source)` (public as `meterSources.register`);
  `requireMeterSource(type)` throws `422 METER_SOURCE_NOT_AVAILABLE` when nothing is registered.
- `assertBillingPortsReady()` (called by `registerBilling()`): in production it throws while approvals, journal or notifications is still a
  fake, so the server refuses to start until modules 13, 14 and 16 register. In development and tests nothing happens.

## Public API (`billing.public.ts`, section 8.24; `Ctx | SystemCtx` is the type `Ctx`)

```ts
unitLedger.post(ctx, e: LedgerPostInput, t): Promise<{ id: number }>;            // 11.2
unitLedger.balance(societyId, unitId): Promise<number>;                           // 11.2, + dues, - advance
invoices.applyAllocation(ctx, invoiceId, amountPaise, t): Promise<InvoiceBalanceDto>;
invoices.reverseAllocation(ctx, invoiceId, amountPaise, t): Promise<InvoiceBalanceDto>;
invoices.createAdHoc(ctx, input: CreateAdHocInput, t): Promise<{ invoiceId; invoiceNo; totalPaise }>;
invoices.listOpen(societyId, unitId, opts?: { payerUserId?: number }): Promise<OpenInvoiceDto[]>;
invoices.billedForMonth(societyId, month: string): Promise<{ billedPaise: number; invoiceIds: number[] }>;
invoices.registerFundResolver(refType, resolve: (societyId, refId) => Promise<number | null>): void;   // implemented (stores in fundResolvers)
invoices.get(societyId, invoiceId): Promise<InvoiceDto | null>;
invoices.setDisputed(ctx, invoiceId, isDisputed: boolean, t): Promise<void>;
invoices.requestCancel(ctx, invoiceId, reason, t): Promise<{ approvalRequestId: number; status: string }>;
invoices.creditBySource(ctx, invoiceId, { refType, refId, percent, reason }, t): Promise<{ noteId; noteNo; totalPaise }>;
invoices.cancelBySource(ctx, invoiceId, { refType, refId, reason }, t): Promise<{ noteId; noteNo }>;
meterSources.register(meterType: 'WATER' | 'ELECTRICITY' | 'GAS', source: MeterSource): void;          // implemented
registerBilling(): void;  setBillingPorts(...)
```

## Cross-module items of section 17 done by the foundation

- Permission `finance.billing.import` already exists in the module 03 catalogue (`finance.billing`: view, create, edit, delete, import, export,
  approve) and in the role matrix (Chairman, Treasurer all, Accountant `VCEIX`); nothing to add. `ROLES_AND_PERMISSIONS.md` already lists it.
- File purpose `INVOICE_PDF` is already in `FINANCIAL_FILE_PURPOSES` of module 05 (kept by purge, BR-05-21); constant `INVOICE_PDF_PURPOSE`.
- `nextNumber(societyId, series, { date, prefix, transaction })` already takes `prefix` (used only when the financial year's row is created);
  tests exist in `tests/modules/platform-billing/numbering.test.ts`. Module 11 passes `billing.invoicePrefix` for `INVOICE`.
- Export provider `billing` streams all 12 tables. Purge handler `billing` (order 110) is limited by module 05: it may not touch financial tables,
  so it only anonymises `billing_notes.billToName`; every financial row and `INVOICE_PDF` file is kept, and the retention expiry handler deletes
  all 12 tables at the end of financial retention. The spec's anonymisation of `invoices` and `billing_run_items` therefore happens at retention
  expiry, not at purge.
- Not yet registered (11.1 and later): approval types and their hooks, module 08 onboarding check and unit guard, jobs, notification templates.

## Tests

`tests/modules/billing/schema.test.ts` (constraints, hooks, uniqueness), `tests/modules/billing/ports.test.ts` (fakes, production check, public
placeholders), `tests/lib/money.test.ts`. Fixtures: `tests/helpers/maint-billing.ts` (`resetBillingTests`, `billingWorld`, `raw*` inserters);
`tests/helpers/auth.ts` clears the 12 tables on reset. Run only your module's files plus affected neighbours, never two vitest runs at once.

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
