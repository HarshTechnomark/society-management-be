# Module 13 · Society balance, cash book, expenses, funds and bank (backend, folder `accounts`)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/13_Society_Balance_Accounts_Expenses.md`. This README is the contract between the
**foundation** (13.0, this commit series) and the **four parts** that fill the module in parallel worktrees (13.1 to 13.4).

## What the foundation provides (do not rebuild it)

| Area      | File                                                                                                                                                                                     | Contents                                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tables    | `migrations/20261118000100 … 001200`                                                                                                                                                     | all 12 tables of 7.1 to 7.12 (CHECKs, generated columns, indexes). Never edit them; add a new migration for a change.                                                                                                    |
| Models    | `src/models/{ledger-account,fund,journal-entry,journal-line,society-balance,balance-history,bank-account,expense,settlement,bank-statement-import,bank-statement-line,deposit}.model.ts` | registered in `src/models/index.ts` with the associations of section 7. Posted `JournalEntry` rows and `JournalLine` rows are immutable through the model hooks.                                                         |
| Constants | `accounts.constants.ts`                                                                                                                                                                  | `PERM`, `ENT`, `APPROVAL_TYPES`, `ENTITY`, `JOBS`, enums, `CODE` (ledger codes), `SYSTEM_KEYS`, `AUDIT`, `RT`, `roomFinance`, `NOTIFY`, `ERR` (all section 12 codes), limits                                             |
| Types     | `accounts.types.ts`                                                                                                                                                                      | `PostJournalInput`, `PostJournalResult`, `SocietyBalanceDto`, `FundDto`, `ReadOpts`                                                                                                                                      |
| Chart     | `accounts.chart.ts`                                                                                                                                                                      | the seeded chart of 7.13 (`CHART`, `SEEDED_FUNDS`), `ensureBooks(t, societyId)` (idempotent, lazy), `backfillBooks()`                                                                                                    |
| Engine    | `accounts.engine.ts`, `accounts.engine.core.ts`, `accounts.engine.lock.ts`                                                                                                               | `postJournal`, `postDraft`, `reverseByRef`, `reverseEntry`, `isDateLocked`, balance maintenance, realtime after commit                                                                                                   |
| Lookups   | `accounts.lookup.ts`                                                                                                                                                                     | `resolveLedger(societyId, codeOrKey, t?)`, `ledgerAccountByCode`, `fundLedger`, `collectionBank`, `bankLedgerCode`, `ledgerAccountExists`                                                                                |
| Ports     | `accounts.ports.ts`                                                                                                                                                                      | `accountsPorts()` (approvals, notifications, vendors, reportsCache), `setAccountsPorts`, `accountsPortCalls`, `placeholderAccountsApprovals`                                                                             |
| Public    | `accounts.public.ts`                                                                                                                                                                     | section 8.20 and 8.21 (`journal`, `accounts`, `balance`, `ledgerAccounts`, `funds`, `bankAccounts`, `expenses`, `deposits`, `settlements`, readers); parts fill the stubs that throw `501 NOT_IMPLEMENTED_IN_FOUNDATION` |
| Wiring    | `registerAccounts()` in `accounts.public.ts`; called from `server.ts`, `worker.ts`, `scripts/seed.ts` (before `registerBilling()`)                                                       | production guard, export provider, purge and retention handlers, queue `accounts`, job registry, real journal behind module 11 and 12 ports                                                                              |
| Jobs      | `accounts.jobs.ts`                                                                                                                                                                       | `registerAccountsJobs()` with one line per part, plus the done `accounts:balance-verify` (`accounts.verify.ts`)                                                                                                          |
| Seed      | `seeders/accounts.ts`                                                                                                                                                                    | `ACCOUNTS_SEEDERS` (chart for every society; parts add their demo seeders), `scripts/seed.ts` calls `seedAccounts()`                                                                                                     |
| Dev       | `src/modules/dev/dev.routes.ts`                                                                                                                                                          | `ACCOUNTS_APPROVAL_HOOKS` table, `?source=accounts`; parts add their hook line                                                                                                                                           |
| Tests     | `tests/modules/accounts/`, `tests/helpers/accounts.ts`                                                                                                                                   | engine, chart, ports, wiring of modules 11 and 12; helper `accountsSociety()`, `useRealJournal()`, `fundIdByType()`                                                                                                      |

## Engine API (call these; never write `journal_entries`, `journal_lines`, `ledger_accounts.balancePaise` or `society_balances` yourself)

All functions run inside the caller's transaction `t` (module 13 never opens one for a post). Pass the society in `ctx.society` (use
`withSociety(ctx, id)` from `payments.shared.ts` for jobs). A context without `ctx.user` is a SYSTEM context.

- `postJournal(ctx, input, t)` (public name `journal.post`): BR-13-1 to 13-15. Throws `422 JOURNAL_LINE_INVALID`, `422 JOURNAL_NOT_BALANCED`
  (`errors: [{ field: 'lines', debitPaise, creditPaise }]`), `422 UNKNOWN_LEDGER_CODE`, `422 ACCOUNT_NOT_POSTABLE`, `422 ACCOUNT_INACTIVE`,
  `422 FUND_INACTIVE`, `422 COLLECTION_ACCOUNT_REQUIRED` (key `BANK` without a collection account), `409 PERIOD_LOCKED` (user context, locked date),
  `409 JOURNAL_DUPLICATE_REF`. Same `(refType, refId)` with the same lines returns `replayed: true`. A SYSTEM context posting into a locked
  date is re-dated to the first open date, `documentDate` keeps the original. Options: `instrumentRef` (UTR or cheque number for auto-match),
  `enforceFundBalance` (BR-13-32, off by default), `skipLockCheck` (year close only), `source`.
  It maintains `ledger_accounts.balancePaise`, `society_balances` (the four figures, investments, earmarked funds) and one `balance_history`
  row, audits `accounts.journal.posted`, and after commit emits `balance.updated` and calls `reportsCache.touch(societyId, 'finance')`.
- `postDraft(ctx, entryId, t)`: posts an existing DRAFT or PENDING_APPROVAL entry (manual journal) in place: re-validates, locks, numbers it, applies balances (13.1).
- `reverseByRef(ctx, { refType, refId, date?, reason }, t)` (public `journal.reverse`) and `reverseEntry(ctx, entryId, { date?, reason, viaManualRoute? }, t)`:
  BR-13-5 (`422 REVERSAL_NOT_ALLOWED`, `409 JOURNAL_ALREADY_REVERSED`, `404 JOURNAL_NOT_FOUND`).
- `isDateLocked(societyId, date, t?)`, `ensureBooks(t, societyId)` (locks `society_balances`, seeds the chart and the three funds once), `ledgerAccountExists`.
- `accounts.lookup.ts`: `resolveLedger(societyId, codeOrKey)` returns the active leaf; `bankLedgerCode(societyId, bankAccountId)`; `collectionBank(societyId)`.
- Bank accounts (13.2) create a ledger `1110-NNN` (subtype `BANK`, `isSystem`) under `1110`, and funds (13.2) a ledger `2440-NNN` / `2450-NNN` (type `FUND`,
  subtype `FUND`) under `2440` / `2450`; the engine recognises a bank by subtype `BANK` and a fund by subtype `FUND`, so the balance figures follow automatically.

Account mapping of the four figures (BR-13-16): In bank = Σ balance of subtype `BANK`; Reaching bank = `1140`; Cash in hand = `1120` + `1130`; Cheques in
clearing = `1150`; investments (subtype `INVESTMENT`) apart; earmarked = −Σ balance of subtype `FUND` ledgers.

## How modules 11 and 12 post now

`registerAccounts()` installs the real engine behind the module 11 (`billingPorts().journal`) and module 12 (`paymentsPorts().journal`) ports
(`accounts.ports-wiring.ts`): `post` maps `accountCode` to `ledgerAccountCode`, `isDateLocked` and `accountExists` are real. Tests that call
`setBillingPorts()` / `setPaymentsPorts()` with no argument go back to the recording placeholders; `useRealJournal()` from `tests/helpers/accounts.ts` installs the real one.
Module 12 `funds.exists`, `funds.name` and `bankAccounts.get` still accept any id (placeholders), because collection and cheque flows use ids before funds and
bank accounts can be created: **13.2 replaces them** with `realFundsPort` and `realBankAccountsPort` (already written in `accounts.ports-wiring.ts`), by uncommenting the
`TODO(13.2)` line in `registerAccounts()` and fixing the module 12 tests that use made-up ids. `societyBalance.get` already reads `society_balances.totalPaise`.

## Rules for every part

- Files only with your prefix (below). The foundation's files are `accounts.{constants,types,ports,ports-wiring,chart,engine*,lookup,verify,readers,exports,purge,jobs,public,shared,validation}.ts`; the part prefixes never collide with them.
- Shared files you may touch with **additive lines only**: `src/app.ts` (one `api.use(...)` mount line of your routes), this README (tick your part below),
  `seeders/accounts.ts` (one entry in `ACCOUNTS_SEEDERS`, your function in `seeders/accounts-<part>.ts`), `accounts.public.ts` (replace the body of the stubs you own; keep the signature),
  `src/modules/dev/dev.routes.ts` (one line in `ACCOUNTS_APPROVAL_HOOKS`), `accounts.jobs.ts` (one `register...Jobs()` call line at the end of `registerAccountsJobs`),
  the tenant-isolation and permission-matrix lists in `tests/` (add your routes), `tests/helpers/accounts.ts` (additive helpers).
  No new migration unless the spec needs a column the foundation lacks; if so a new file after the latest timestamp, never an edit.
- Tests in `tests/modules/accounts/<prefix>.*.test.ts`. Use `setAccountsPorts()` and `accountsPortCalls`.
- Routes go through `routeMeta`, `requirePermission`, `requireFeature` (entitlements `ENT.*`), `validate`, `idempotency` for money and create routes.
- Money is paise; times from `lib/clock`; notify only after commit; audit in the same transaction; services take `ctx` and never `req`/`res`.
- Every posting goes through the engine. If you need something another part owns, add the function to the foundation only if it is a pure helper; otherwise leave a TODO.
- Realtime: `emitToRoom(roomFinance(societyId), RT.xxx, payload)` from `t.afterCommit`. Approval handlers register with `accountsPorts().approvals.registerType` inside your `register...Jobs()` (called from `registerAccounts()` through `accounts.jobs.ts`).

## The four parts

### 13.1 journal, balance, opening balances (prefix `accounts.journal`, `accounts.balance`, `accounts.ledger`, `accounts.opening`)

Spec: 8.1, 8.2, 8.10, 8.11, 8.12; F03, F04, F17 to F19; sections 5.1, 5.2, 6.1, BR-13-51; approval type `MANUAL_JOURNAL`.

- Routes: `GET /society-balance`, `GET /society-balance/history`, `GET|POST /accounts/ledger-accounts`, `PATCH /accounts/ledger-accounts/:id`,
  `GET /accounts/journals`, `GET /accounts/journals/:id`, `POST /accounts/journals` (draft), `PATCH /accounts/journals/:id`, `POST /accounts/journals/:id/submit`,
  `DELETE /accounts/journals/:id`, `POST /accounts/journals/:id/reverse`, `POST /accounts/opening-balances`.
- Writes: `ledger_accounts` (create custom accounts, rename, flags, never `balancePaise`), `journal_entries` and `journal_lines` as DRAFT / PENDING_APPROVAL / REJECTED / CANCELLED only; posting only through the engine.
- Engine calls: `postDraft` on approval, `reverseEntry(…, { viaManualRoute: true })`, `postJournal` with `voucherType OPENING_BALANCE`, `refType 'opening'` (`autoBalance` adds the `3900` line), `ensureBooks`.
- Also: `balance.get` (done as a plain reader; 13.1 owns the DTO details and `history`), the `MANUAL_JOURNAL` approval type hooks and dev hook, notification `accounts.journal_rejected`, audit `accounts.journal.*` for drafts, `accounts.ledger_account.*`, `accounts.opening_balance.posted`.
- Own stubs in `accounts.public.ts`: `balance.history`.

### 13.2 expenses, funds, bank accounts, cash book (prefix `accounts.expenses`, `accounts.funds`, `accounts.bank`, `accounts.cashbook`)

Spec: 8.4 to 8.9, 8.13, 8.14; F06 to F09, F10 to F12; sections 5.3, 5.4, 5.5 (BR-13-35 to 37), 6.2, 6.6, 6.8; approval types `EXPENSE`, `FUND_TRANSFER`.

- Routes: `GET /accounts/cash-book`, `GET|POST /expenses`, `GET|PATCH|DELETE /expenses/:id`, `POST /expenses/:id/submit|withdraw|reverse`, `GET /expenses/export`,
  `GET|POST /accounts/funds`, `GET /accounts/funds/:id/statement`, `PATCH /accounts/funds/:id`, `POST /accounts/fund-transfers`,
  `GET|POST /accounts/bank-accounts`, `GET|PATCH /accounts/bank-accounts/:id`, `POST …/verify|set-collection|close`, `GET …/reveal` (step-up, `noSupportAccess`).
- Writes: `expenses`, `funds` (+ their `ledger_accounts` rows `2440-NNN`, `2450-NNN`), `bank_accounts` (+ `1110-NNN` ledger; number encrypted AES-256-GCM, key `BANK_ACCOUNT_ENCRYPTION_KEY` in `src/lib/env.ts`, HMAC hash), money only through the engine.
- Engine calls: `postJournal` (`PAYMENT`, `refType 'expense'`, `enforceFundBalance` for fund-sourced lines per BR-13-32 as the spec test T13-16 decides), `reverseEntry` for expense reversal, `postJournal` `OPENING_BALANCE` for a bank opening balance, `JOURNAL` voucher for fund transfers, `ensureBooks`, `lookup.bankLedgerCode`.
- Ports: `accountsPorts().approvals` (`EXPENSE`, `FUND_TRANSFER` hooks, `lockOpenForEntity` first), `vendors.recordPayment|reversePayment`, `notifications` (`accounts.expense_reversed`, `accounts.bank_account_changed|verified`).
- Replaces the module 12 placeholders `paymentsPorts().funds` and `bankAccounts` with `realFundsPort` / `realBankAccountsPort` (see above) and the public `funds.get`, `bankAccounts.get`, `expenses.listForCollection`, `accounts.collectionBankAccount` stubs.
- Realtime `expense.updated`, jobs none. Dev hooks for `EXPENSE` and `FUND_TRANSFER`.

### 13.3 settlements and statements (prefix `accounts.settlements`, `accounts.statements`, `accounts.brs`)

Spec: 8.15, 8.16 and BRS (38, 51); F13 to F15; sections 5.5 (BR-13-38 to 43), 6.4, 6.5; jobs `settlement-reconcile`, `statement-parse`, `auto-match`, `clearing-age`.

- Routes: `GET /accounts/settlements`, `/:id`, `POST /accounts/settlements/import`, `POST …/:id/reconcile`, `POST …/:id/accept-difference`,
  `POST|GET /accounts/bank-statements`, `GET /:id`, `GET /:id/lines`, `POST /:id/auto-match`, `POST /:id/mark-reconciled`, `GET /accounts/bank-statement-lines/:id/candidates`,
  `POST …/match|unmatch|ignore|create-entry`, `GET /accounts/bank-accounts/:id/brs`.
- BRS rule for entries before the statement's period start: the BRS uses the latest statement ending on or before `asOf`. A book line dated before that statement's `periodFrom` is already part of the statement's opening balance, so it is NOT an uncleared item (the statement already shows its effect). Only unmatched book lines dated on or after `periodFrom` are uncleared. Statement lines are never dated before `periodFrom`. The demo statement (`accounts.statements.sample.ts`) starts 3 days before the earliest bank posting and its two deliberate extras (bank charge Rs 23.60, interest Rs 1,042.00) leave a BRS difference of +Rs 1,018.40 until the two entries are created, then 0.
- Writes: `settlements`, `bank_statement_imports`, `bank_statement_lines`, `bank_accounts.lastReconciledDate|lastReconciledBalancePaise` (only in `mark-reconciled`); journals only through the engine.
- Engine calls: `postJournal` (`CONTRA`, `refType 'settlement'` with `instrumentRef = utr`; `refType 'statement_line'` for entries from a line), `lookup.collectionBank`, `payments.findByGatewayPaymentId` (module 12).
- Registers its jobs in `accounts.settlements.jobs.ts` / `accounts.statements.jobs.ts` (one line each in `accounts.jobs.ts`); `settlements.ingest` public stub; notifications `settlement_mismatch`, `statement_imported`, `clearing_aged`; realtime `settlement.updated`, `statement.updated`.

### 13.4 deposits, periods, reports (prefix `accounts.deposits`, `accounts.periods`, `accounts.reports`, `accounts.resident`)

Spec: 8.3, 8.17, 8.18, 8.19, 8.21 and 8.20 deposits; F05, F16, F20 to F22; sections 5.2 (BR-13-19), 5.6, 6.3, 6.7, 9.1 (`deposit-sync`, `relock`, `year-close`, `report-export`); approval types `DEPOSIT_REFUND`, `PERIOD_UNLOCK`.

- Routes: `GET|POST /accounts/deposits`, `GET /:id`, `POST /:id/deduct|forfeit|refund-request|refund-paid|cancel`, `GET /me/deposits`, `GET /accounts/periods`, `POST /accounts/period-lock`,
  `POST /accounts/period-lock/unlock-requests|relock`, `POST /accounts/financial-years/:fy/close` (202), `GET /accounts/reports/:report`, `POST /accounts/exports`,
  `GET /me/society-finances`, `GET /me/society-finances/funds/:id/statement`.
- Writes: `deposits`, `society_balances` control columns (`booksLockedThrough`, `unlockFromDate`, `unlockUntil`, `unlockApprovalRequestId`, `lastClosedFinancialYear`, under the row lock) with `version`; money only through the engine.
- Engine calls: `postJournal` (deduction `JOURNAL` Dr deposit ledger Cr `4600`; refund `PAYMENT`; `CLOSING` voucher with `skipLockCheck: true` dated 31 March), `isDateLocked`, `ensureBooks`; module 11 `invoices.createAdHoc`, `cancelBySource`; module 12 `payments.createOrder`, `registerOrderHook('deposit', …)`.
- Replaces the 8.21 reader stubs in `accounts.readers.ts` (`accountReports.run`, `fundStatement`, `cashBook.monthlyTotals`, `expenseReports.byHead`, `expenseReports.tdsDeposited`, with `ReadTimeoutError`) and the deposit stubs (`deposits.request|requestRefund|registerOwner`).
- Jobs `deposit-sync`, `relock`, `year-close`, `report-export`; realtime `deposit.updated`; notifications `period_locked`, `period_unlocked`, `year_closed`, `deposit_*`, `export_ready`; dev hooks for `PERIOD_UNLOCK` and `DEPOSIT_REFUND`.
- Cash-book monthly totals (`cashBook.monthlyTotals`) are read from `journal_lines` of BANK, CASH and PETTY_CASH ledgers excluding entries whose lines are all on those ledgers (contra).

## Notes and decisions of the foundation (read before you build)

- **No routes yet.** The foundation mounts nothing in `app.ts`, so no route registry meta, permission-matrix or tenant-isolation entries exist; each part adds its own routes to those lists in `tests/`.
- **`(refType, refId)` is unique among posted entries** (BR-13-6). Module 12 used `('payment', id)` for several journals of one payment, so the foundation changed it:
  receipt `('payment', id)` (unchanged), cheque clearance `('cheque_clearance', id)` (as in 7.14), reversal, bounce and return mirror `('payment_reversal', id)`, reallocation
  `('payment_realloc', '<id>:<version>')`. The spec table 7.14 says `payment` for the bounce journal; the engine cannot accept two different journals for one source. `JournalInput.refId` is `number | string`.
- **MySQL triggers** (`trg_journal_entries_*`, `trg_journal_lines_*`) are created by the migrations when the server allows it. A server with binary logging and a user without SUPER refuses triggers
  (error 1419); the migrations then print a warning and continue, and the model hooks (which every service goes through) still enforce immutability. Set `log_bin_trust_function_creators=1` and re-run the
  trigger statements of migrations `20261118000300` and `20261118000400` to get both layers. The retention delete uses `@accounts_purge = 1` on its own connection to pass the delete triggers.
- **Tests reset the 12 tables with `TRUNCATE`** (`resetAll` in `tests/helpers/auth.ts`), because posted journals cannot be `DELETE`d.
- **BR-13-32 (fund may not go negative by a user posting)** is opt-in: `postJournal(…, { enforceFundBalance: true })`. T13-16 expects an expense from the Repair fund to take it negative, so 13.2 decides per case.
- **Sources:** an entry is `MANUAL` only when `source: 'MANUAL'` is passed or `refType` is `manual_journal`; everything else is `SYSTEM`, which the manual reverse route (`viaManualRoute`) refuses.
- **Draft journals (13.1):** create the DRAFT entry and its lines yourself (`JournalEntry`, `JournalLine`), with `resolveLines`/`validateLines` from `accounts.engine.core.ts` so each line carries its `fundId`; lines of a PENDING entry cannot be changed (trigger). `postDraft` then numbers and posts it.
- **Retention:** the handler has order 130, so it runs before modules 12 and 11 (expenses reference collections, deposits reference invoices).
- **Realtime public room** gets `balance.updated` only when the society setting `finance.showFinancesToResidents` is true; the cache touch (`reportsCache.touch(societyId, 'finance')`) is a port with a recording placeholder until module 24.
- **Lock order** inside the engine: `society_balances` row (via `lockBooks`) → ledger accounts, funds. Callers lock their own rows (unit, invoice) first, never after a posting.
- **Speed:** a posting is about 20 statements (around 70 ms on the development machine) and serialises per society on the `society_balances` row; do not post inside loops of thousands without batching transactions.

## Status

- [x] Foundation (13.0)
- [ ] 13.1 journal, balance, opening balances
- [ ] 13.2 expenses, funds, bank accounts, cash book
  - [x] 13.2a expenses and cash book (prefix `accounts.expenses`, `accounts.cashbook`): routes 5 to 14 of section 8, `EXPENSE` approval type and dev hook, placeholder bill files port `accounts.expenses.files.ts`
  - [ ] 13.2b funds and bank accounts
- [ ] 13.2 expenses, funds, bank accounts, cash book (13.2b funds and bank accounts done: `accounts.funds.*`, `accounts.bank.*`, seeder `accounts-bank.ts`, module 12 ports `realFundsPort` / `realBankAccountsPort` installed; expenses and cash book (13.2a) pending)
- [ ] 13.3 settlements and statements
- [ ] 13.4 deposits, periods, reports (13.4a deposits, periods and year close done; reports and resident finances follow in 13.4b)
