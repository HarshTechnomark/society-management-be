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
