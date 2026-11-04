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

# Module 11: Maintenance billing (backend, `src/modules/billing`)

The module is built in sub-modules (11.1 charge heads, rules and policies; 11.2 unit ledger, statements and opening balances;
11.3 calculator, runs and issue; 11.4 invoices and notes; 11.5 late fees, reminders, dashboard and resident bills). Each
sub-module adds its own section below.

## 11.2 Unit ledger, statement of account and opening balances

**Purpose.** The per-flat receivable ledger (`unitLedger.post` and `unitLedger.balance`, spec 5.11 and 8.24), the statement
of account (8.20), opening balances at go-live (8.23) and the real hooks into modules 08 and 09.

**Files** (all prefixed): `billing.ledger.service.ts` (post, balance), `billing.statement.service.ts` (statement JSON and CSV),
`billing.opening.import.ts` (template, import, dry run), `billing.opening.service.ts` (list, post, reverse, delete),
`billing.opening.invoice.ts` (the small arrears invoice helper, see below), `billing.opening.shared.ts`,
`billing.ledger.routes.ts` / `.controller.ts` / `.validation.ts` / `.types.ts`, `billing.ledger.hooks.ts` (module 08 and 09
wiring). Seed: `seeders/billing-opening.ts` (demo data for Sky Heights, run by `npm run seed`, never in production).

**Tables.** `unit_ledger_entries` (7.11, append-only) and `opening_balances` (7.12). No migration was added by 11.2.

**Routes** (all under `/api/v1`, society routes; marker order: permission, entitlement, validate, step-up, idempotency):

| Method and path                              | Permission                                                          | Entitlement                           | Notes                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /billing/units/:unitId/statement`       | `finance.billing.view` (`format=csv` also `finance.billing.export`) | `billing.statement_of_account` (read) | `from`, `to`, `format`; 404 `UNIT_NOT_FOUND`; CSV 10 per hour per user, audited |
| `GET /billing/opening-balances`              | `finance.billing.view`                                              | `billing.opening_balances` (read)     | `status`, `page`, `limit`                                                       |
| `GET /billing/opening-balances/template`     | `finance.billing.view`                                              | same (read)                           | header-only CSV                                                                 |
| `POST /billing/opening-balances/import`      | `finance.billing.import`                                            | `billing.opening_balances`            | Idempotency-Key; body `{ fileId, asOfDate, dryRun? }`                           |
| `POST /billing/opening-balances/post`        | `finance.billing.import`                                            | same                                  | step-up, Idempotency-Key; body `{ confirmTotalPaise }`                          |
| `POST /billing/opening-balances/:id/reverse` | `finance.billing.import`                                            | same                                  | step-up; body `{ reason, version }`                                             |
| `DELETE /billing/opening-balances/:id`       | `finance.billing.import`                                            | same                                  | body `{ version }`; 204                                                         |

**Ledger rules.** `post` validates the entry type and reference type pair (`PAYMENT` and `PAYMENT_REVERSAL` use `payment`,
`REFUND` uses `refund`, `DEBIT_NOTE` and `CREDIT_NOTE` use `billing_note`, `INVOICE` uses `invoice`, `OPENING_BALANCE` and
`ADJUSTMENT` use `opening_balance`), exactly one of debit and credit above zero (whole paise), a real date and a narration of
1 to 300 characters (`422 LEDGER_ENTRY_INVALID`). It is idempotent by `(societyId, refType, refId, entryType)`: the same
unit and amounts return the existing row, others are `409 LEDGER_ENTRY_CONFLICT`; two parallel posts of one reference leave
one row. The society is `ctx.society.id` when the context has one (a unit of another society is `404 UNIT_NOT_FOUND`);
a system context without a society takes the unit's own society. `balance(societyId, unitId, t?)` is the sum of debits minus
credits (the optional transaction lets a guard read inside its transaction).

**Statement.** Entries ordered by `entryDate`, then `id`; running balance is a window `SUM`; the opening balance is the sum before
`from`; the range is at most 1,100 days with both end days counted (`400 VALIDATION_FAILED` for more, for `from > to` and for
unknown query keys); default range is the current financial year up to today; an archived unit is `404`. The CSV has
`Date,Type,Reference,Narration,Debit,Credit,Balance` with an opening and a closing row; text goes through the module 08
injection-safe cell helper (`csvCell`), amounts are plain numbers in rupees with two decimals.

**Opening balances.** The file is CSV (or XLSX, read by module 08's `parseImportFile`) with the header
`unit,arrears_principal,arrears_interest,advance`; amounts are rupees `^\d{1,9}(\.\d{1,2})?$` or empty, parsed as strings.
Import is synchronous (at most 5,000 rows, `422 IMPORT_TOO_MANY_ROWS`) and replaces the society's earlier `DRAFT` and `INVALID`
rows in one transaction (the society row is locked, so imports of one society run one at a time). Row checks produce `INVALID`
with `validationError`: unknown flat, duplicate flat in the file (only when the first row is a DRAFT), amount format, arrears
and advance together, nothing at all, flat already `POSTED`, flat label too long for `OB/<label>` (30 characters) and, for
arrears rows, no owner or tenant to bill. `dryRun: true` checks and returns the same answer without writing or auditing. The file
comes from module 08's placeholder file store (`putPlaceholderFile`, `setupPorts().files.getImportFile`); a file of another
purpose is `422 IMPORT_FILE_INVALID`. The as-of date must be today or earlier and, once a regular run exists, the day before
the first regular run's period start (`422 OPENING_BALANCE_DATE_INVALID`).

Post (`confirmTotalPaise` = Σ arrears − Σ advances of the DRAFT rows, else `422 OPENING_BALANCE_TOTAL_MISMATCH`) refuses while
any row is `INVALID` and when the books are locked for the date (`422 PERIOD_LOCKED`, journal port). Rows are posted in
batches of 200, each batch in its own transaction, taking only rows that are still `DRAFT` (a run that stopped halfway can be
repeated; the typed total is then the remaining draft total). Lock order: unit, then invoice, then ledger. Each arrears row:
`OB/<flat>` invoice with a `CHARGE` line (head `OPENING_ARREARS`) and an `INTEREST` line, one `OPENING_BALANCE` ledger debit,
journal Dr 1300 / Cr 3900. Each advance row: `OPENING_BALANCE` ledger credit, journal Dr 3900 / Cr 2210, then the module 12 port
`payments.creditOpeningAdvance` in the same transaction and, after commit, `payments.queueAdvanceApply`. Realtime
`billing.dues.changed` goes to `unit:<id>` after commit.

Reverse (POSTED arrears rows only): needs `paidPaise = 0`, no issued credit note and no debit note on the arrears invoice
(`422 OPENING_BALANCE_HAS_PAYMENTS`; the debit note part goes beyond the spec so that a cancellation never leaves a debit
behind), an advance row is `422 OPENING_ADVANCE_NOT_REVERSIBLE`. It issues a `CANCELLATION` credit note directly
(`CN/` number from the `CREDIT_NOTE` series, no approval), cancels the invoice, posts one `ADJUSTMENT` ledger credit (the credit
note posts no second ledger entry) and a reversing journal (refType `opening_balance_reversal`). The flat can then be imported
and posted again (`OB/<flat>/2`).

**The small arrears invoice helper** (`billing.opening.invoice.ts`). The general issue core is 11.3 and 11.4; 11.2 only needs
to create the `OPENING` invoice and to close it. The helper creates the invoice row, its lines and the ledger debit, and the
`CANCELLATION` credit note with its lines. Invoice number is `OB/<unit label>` (spec BR-11-5 and BR-11-71: no number series,
so no `nextNumber`; a repeat after a reversal gets `OB/<label>/2`). Only the credit note takes a gapless number
(`nextNumber(societyId, 'CREDIT_NOTE', ...)`). If the society has no `OPENING_ARREARS` or `INTEREST` charge head yet, the
helper creates just that system head with the section 7.13 values (11.1's `ensureSeeded` finds and keeps it). Not for any other
document.

**Hooks registered by `registerBilling()`** (`billing.ledger.hooks.ts`): module 09's `residentPorts().unitLedger.balance` is the
real `unitLedger.balance`, so `duesPaise` in `GET /residents/units` and `/residents/units/:unitId` is real; module 08
`onboarding.registerCheck('BILLING', ...)` (done when an `ACTIVE` head and an `ACTIVE` rule with an `APPROVED` version exist;
summary `N billing rules approved` or `No approved billing rule yet`); `units.registerUnitGuard` returns `UNIT_HAS_BALANCE` when
the balance is not zero or the flat has a `READY` run item in a run that is not `ISSUED`, `CANCELLED` or `FAILED`.

**Ports (placeholders until the owner module exists).** Module 13 `journal.post` and `isDateLocked`; module 12
`payments.creditOpeningAdvance` and the new `payments.queueAdvanceApply(societyId, unitIds)` (added to `billing.ports.ts`; also
needed by the issue job of 11.3); module 14 `approvals.lockOpenForEntity` (reverse refuses with `409 INVOICE_CANCEL_PENDING` when
a request is open); module 01 files (module 08 `putPlaceholderFile` store).

**Audit.** `billing.opening_balance.imported|posted|reversed|deleted` (per row for post), `billing.statement.exported` (CSV).
Audit keys avoid `code`, `token` and `secret`.

**Tests.** `tests/modules/billing/ledger.test.ts` (post, balance, concurrency, immutability, module 08 and 09 wiring, T11-33,
T11-38, T11-39), `statement.test.ts` (8.20, CSV, limits, permissions), `opening.test.ts` (import, post, reverse, delete, T11-34,
T11-35, T11-42, seed). The new routes are listed in `tests/modules/access-control/tenant-isolation.test.ts`; the permission
matrix reads them from the route table. Run: `npx vitest run tests/modules/billing`.

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
