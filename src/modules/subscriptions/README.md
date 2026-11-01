# Module 04: Plans, subscriptions and entitlements (backend)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/04_Plans_Subscriptions_Entitlements.md`.

## What it owns

- Tables (migrations `20261103000100` to `20261103001100`): `plans`, `plan_versions`, `plan_entitlements`, `addons`,
  `subscriptions`, `subscription_addons`, `entitlement_overrides`, `feature_flags`, `feature_flag_overrides`,
  `usage_counters`. Generated columns (`publishedPlanId`, `draftPlanId`, `liveSocietyId`, `liveTarget`) are never written by
  the models. `PlanVersion` has the `beforeUpdate` immutability hook (BR-04-2).
- Catalogue in code: `subscriptions.catalogue.ts` (+ generated `subscriptions.catalogue-data.ts`): 561 feature keys (14
  always on, 6 PLANNED) and 12 limit keys; `FeatureKey` / `LimitKey` unions; `assertCatalogue()` runs at start-up.
- Files: `entitlements.service.ts` (resolver, cache, `consumeLimit`, `releaseLimit`, providers), `flags.service.ts`,
  `pricing.ts` (pure money and calendar functions), `subscriptions.service.ts` (state machine, change plan, renewal, module
  05/06/08/14 functions), `subscriptions.plans.service.ts` (plans, versions, publish, migration, catalogue, add-on admin),
  `subscriptions.society.service.ts` (society reads, quote, preview, add-on store, trials, overrides, platform subscriptions),
  `subscriptions.usage.ts` (month close, overage, reconciliation, usage view), `subscriptions.jobs.ts`,
  `subscriptions.integrations.ts` (ports to modules 05, 06, 14), `subscriptions.seed.ts`, `subscriptions.public.ts`.
- Middleware: `src/middlewares/entitlement.middleware.ts` — `requireFeature(key, { mode })` (402 `FEATURE_NOT_IN_PLAN` with
  the 8.1 `errors[]` body incl. `currentPlan`, `availableIn`, `unlockAddon`) and `requireLimitHeadroom(key, n)`. Unknown keys
  throw when the route file loads. Route tags record the keys (`RouteMeta.features`) for the contract test.
- Routes: `subscriptions.routes.ts`, all of section 8 (30 platform, 17 society). `GET /subscription/entitlements` uses the new
  `anyActiveMember()` marker (`memberOnly` in the route registry) because it needs no permission key.

## Start-up

`registerSubscriptions()` (from `subscriptions.public.ts`, called by `server.ts`, `worker.ts` and `npm run seed` after
`registerAccessControl()`):

- replaces the placeholder `entitlements` ports of module 03 (`consumeLimit`, `releaseLimit`, `getLimit` → `{ limit, used }`,
  `planKeyFor`) and module 02 (`getFeatures` for `/auth/me`);
- registers usage providers for `limit.admin_seats` (ACTIVE/SUSPENDED members whose role `consumesSeat`) and
  `limit.custom_roles` (non-system roles) so the nightly reconciliation fixes drift;
- hooks module 03's society-info cache (`planKey`) to entitlement invalidation; registers the jobs.
  `server.ts`/`worker.ts` also run `assertCatalogueComplete()` (every catalogue key has a row in every plan version).

Module 03 change: `consumeLimit` / `releaseLimit` port options take an optional `societyId` (module 03 now passes it), because
seat changes run with system contexts that have no `ctx.society`. Module 02/03 tests keep the placeholders (they never call
`registerSubscriptions()`).

Admin seats for the Team screen: `GET /api/v1/subscription/usage` (item `limit.admin_seats`) and, for holders of
`settings.subscription.view`, `GET /api/v1/subscription/entitlements` → `limits['limit.admin_seats'] = { limit, used, period }`.
`subscriptions.seatUsage(societyId)` returns the same for other modules.

## Placeholders other modules replace (`subscriptions.integrations.ts`, `setSubscriptionIntegrations`)

| Port                                                                       | Owner     | Stub behaviour                                                                            |
| -------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------- |
| `billing.issuePeriodInvoice / issueProrationInvoice / issueOneTimeInvoice` | module 06 | records the call (`integrationCalls`, with the transaction) and returns a fake invoice id |
| `billing.periodValue`                                                      | module 06 | `pricing.periodValue` (BR-04-5)                                                           |
| `billing.previewTax`, `billing.addonRevenueThisMonth`                      | module 06 | `null` (quote `tax: null`), `0`                                                           |
| `lifecycle.closeForSubscriptionCancellation`                               | module 05 | records the call                                                                          |
| `lifecycle.getStatusInfo`                                                  | module 05 | reads `societies.status`                                                                  |
| `approvals.createRequest` (type `SUBSCRIPTION_CANCEL`)                     | module 14 | records the call and returns an id; module 14 must call `subscriptions.applyCancellation` |

The stub invoice total of `issuePeriodInvoice` is 0 (module 06 computes invoices). Module 06 replaces the `billing` stubs
in `registerPlatformBilling()`; for it, `getBillingSnapshot` takes an optional transaction (no usage-month close inside it)
and `renewIfDue` closes the usage months before it opens the renewal transaction. Notifications go through the temporary
`lib/notify.ts` (templates in `subscriptions.templates.ts`); in-app delivery is not sent by it. Kill-switch toggles and stale
flags log a warning in place of module 07 platform notifications.

## Cache, queue and Redis

- Entitlements: `ent:gen:<sid>` (new `KvStore.counterGet/counterIncr`) and `ent:v1:<sid>:<gen>` (TTL min(300 s, next
  expiry), min 5 s) through `lib/kv`; flags: `ff:gen` and `ff:v1:<gen>` (60 s). Redis (`REDIS_URL`) uses `INCR` on `ctr:*`;
  without it the in-process memory store is used. The memory store is tested; the Redis implementation is written but not run
  against a real Redis. A store error resolves from MySQL (never fails open). Invalidation runs after commit.
- `consumeLimit` resolves on a cache miss inside the caller's transaction (no second pool connection) and does not cache that
  value. ABSOLUTE counter rows are created with the subscription; a MONTHLY row is created outside the transaction on its first
  use, so concurrent first uses never deadlock.
- Jobs (queue `subscriptions`, in-process runner without Redis, BullMQ with it): `renewals` 00:15 IST, `close-usage-months`
  00:20, `override-expiry` every 15 min, `addon-expiry` hourly, `usage-reconcile` 03:00, `usage-threshold` and
  `apply-migration` on demand. The scheduler has no monthly or weekly cadence: `usage-purge` runs daily (idempotent) and
  `flag-stale-reminder` runs daily at 10:00 and acts on Mondays only.

## Seeds

`npm run seed`: `subscriptions-catalogue` everywhere (4 plans, v1 published, 573 rows per version, 8 add-ons, flags
`platform.autopay` and `payments.upi_autopay`, plus the catalogue sync that appends new keys). Non-production: the prototype
flags and demo subscriptions per spec 7.11 — Sky Heights CHS PREMIUM ACTIVE MONTHLY anchor 1 (72 flats, charged 100 =
2,50,000 paise), Green Park CHS STARTER ACTIVE MONTHLY anchor 1 (30 flats, 27,000 paise), Tulip Gardens CHS STANDARD
TRIALING. Until module 08 exists the demo flat counts are written into the `limit.flats` counter; until module 05 exists
`trialEndsAt` is the society's creation + 14 days. Seat and role counters are reconciled at the end of the seed.

## Decisions and notes

- BR-04-6 example: the spec prints "31 Jan–27 Feb, 28 Feb–30 Mar, 31 Mar–30 Apr". The rule (next start =
  min(anchor, days in month)) gives 31 Mar–29 Apr for the third period; no single rule produces all three ranges. The rule is
  implemented (test T04-04 notes it).
- PATCH platform subscription stores a new Enterprise custom price at once (no pending column exists for "applies from next
  period").
- `downgrade-preview` `stopsJobs` is true when `recordsInUse > 0`; `recordsInUse` is null for keys without a registered
  provider (no other module registers one yet).
- Plan advisor: `USING_PREMIUM_TRIAL`, `NEAR_FLAT_LIMIT` (≥ 80 % of the flat limit), `ANNUAL_SAVES` (monthly cycle).
- Tests: `tests/modules/subscriptions/` (unit, entitlements, society-routes, platform-routes, lifecycle). E2E T04-46 to
  T04-48 belong to the frontend.
