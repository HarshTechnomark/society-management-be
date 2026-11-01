# Module 05: Society creation, lifecycle and support access (backend)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/05_Society_Creation_Lifecycle_Support.md`.

## What it owns

- Migrations `20261104000100` to `20261104000500`: lifecycle columns on `societies` (re-runnable; back-fills rows created
  before module 05 so the new CHECK constraints hold), `society_lifecycle_events` (append-only, hooks throw on update and
  destroy), `support_access_grants` (generated `openLockUserId` + unique index, BR-05-26), `society_notes` (paranoid),
  `data_exports` (generated `runningLockSocietyId` + unique index, BR-05-22).
- Files: `societies.lifecycle.ts` (transition table, `transition()`, manual actions, module 04/06 hooks, `getStatusAt`,
  `trialConversionStats`), `societies.guard.ts` (pure: `routeMeta`, `societyStateGuard`, `isJobAllowed`, 6.4 derived
  permissions and support route checks), `societies.service.ts` (wizard, self-serve sign-up, list, detail, edit, CSV,
  slug helpers, `/society-status`), `societies.support-access.ts`, `societies.exports.ts` (+ `societies.zip.ts`),
  `societies.purge.ts`, `societies.health.ts` (score, at-risk list, nudge), `societies.notes.service.ts`,
  `societies.jobs.ts`, `societies.templates.ts`, `societies.notify.ts`, `societies.ports.ts`, `societies.public.ts`.
- Routes (`societies.routes.ts`): all 42 of section 8.0. Lists answer `data: [...]` plus `pagination` (`okList`), like
  modules 02 to 04.

## Start-up

`registerSocieties()` (call after `registerAccessControl()` and `registerSubscriptions()`; done in `server.ts`, `worker.ts`
and `npm run seed`):

- module 02 `supportAccess` port: `validateForHandoff`, `markEntered`, `isGrantActive`, `getGrantSummary` (real grants);
- module 03 `support` port: `getActiveGrant` (checked on every request against the clock, `403 SUPPORT_ACCESS_EXPIRED`
  when the session's grant has ended, cache `sag:<userId>:<societyId>` with TTL to `endsAt`), `permissionsFor` (6.4),
  `checkRequest` (`403 SUPPORT_SCOPE_READ_ONLY`, `403 SUPPORT_ROUTE_FORBIDDEN`), `onRequest` (read log
  `societies.support_grant.viewed` once per route per grant per 5 minutes, request counter, `writeCount`);
- module 04 `lifecycle` integration: `closeForSubscriptionCancellation`, `getStatusInfo`;
- export providers for its own tables and, on their behalf, for the module 03 and 04 society tables; the module 03
  purge handler (invitations and member labels anonymised); the jobs.

Module 02/03/04 tests that never call `registerSocieties()` keep the old placeholders (for example
`SUPPORT_GRANT_READ_ONLY` and module 03's own support permission set), as module 04 did with its ports.

## Changes outside the module (small, as the brief allows)

- `society.middleware.ts`: the state check now goes through `societyStateGuard()` and honours `routeMeta()` placed
  **before** `societyMiddleware()` on a route (`req.routePolicy`); the support branch uses the new port functions and
  sets `actorRoleKey = support:<scope>`. `access-control.ports.ts` gained `support.permissionsFor`, `checkRequest`,
  `onRequest`; `access-control.registry.ts` records `noSupportAccess`. Module 03's `/members/export` is `noSupportAccess`.
- `idempotency.middleware.ts`: `idempotency({ publicScope })` for public routes (sign-up: the key is scoped to the
  mobile of the sign-up token, stored under user id 0 as a UUID derived from SHA-256(mobile, key)).
- `public.routes.ts` (`POST /public/signups`, `GET /dev/files/:id`), `dev.routes.ts` (placeholder file download),
  `app.ts`, `server.ts`, `worker.ts`, `scripts/seed.ts`, `express.d.ts` (`req.routePolicy`).
- Tests: the shared reset helper deletes the new tables; `makeSociety()` fills the columns the CHECK constraints need;
  two module 03 tests that set a status by raw SQL now also set `suspensionCause` / `closedAt`; the route-registry
  tests list the module 05 routes (as module 04 did).

## Placeholders other modules replace (`societies.ports.ts`, `setSocietyPorts`)

| Port                                                                                                                       | Owner                   | Placeholder behaviour                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.get(key)`                                                                                                        | module 07               | code defaults of section 17 (trial 14 days, 2 extensions, auto-close 60, purge 90…)                                                      |
| `billing.hasOverdueInvoice`                                                                                                | module 06               | false                                                                                                                                    |
| `guardDevices.revokeAllForSociety`                                                                                         | module 17               | records the call (with the close transaction), returns 0                                                                                 |
| `autopay.cancelAllForSociety`                                                                                              | module 12               | records the call, returns 0                                                                                                              |
| `units.count`, `onboarding.progressPercent`                                                                                | module 08               | null (health uses `approxFlats`; onboarding left out of the score)                                                                       |
| `collections.efficiency`                                                                                                   | module 12               | null (left out of the score)                                                                                                             |
| `files.storeSystemFile / downloadUrl / deleteFile / listSocietyDocuments / deleteNonFinancialFiles / deleteFinancialFiles` | module 01 files service | in-memory store `placeholderFiles`; download through `GET /api/v1/dev/files/:id` outside production (5-minute URL is only nominal there) |

Module 06 calls `societyLifecycle.onInvoiceOverdue / onGraceExpired / onAccountCleared / onFirstInvoicePaid` inside its
own transaction (they re-lock the society row and never open a transaction) and registers a retention-expiry handler.
Modules 08 to 30 register export providers (`registerExportProvider`), purge handlers (`registerPurgeHandler`; financial
tables and module 06 are refused) and retention-expiry handlers, tag society jobs for `isJobAllowed`, and put
`routeMeta({ suspended: 'allow' | closed: 'allow' | noSupportAccess: true })` on their routes per 6.2.1 and 6.4.

## Redis and jobs

The grant cache, request counters (`sag:req:<id>`, written to `requestCount` every minute and at the end), read-log
de-duplication and the per-mobile sign-up limit use `lib/kv` (Redis with `REDIS_URL`, memory otherwise; the memory store is
tested, the Redis one is written but not run against a real Redis). Jobs (queue `societies`): `expire-trials` (15 min),
`trial-reminders` (daily 10:00 IST; the per-society-timezone dispatcher of module 01 does not exist yet), `auto-close`
(03:00), `purge-closed` (03:30), `build-export` (on request; 3 attempts handled by the processor), `expire-exports`
(hourly :05), `expire-support-grants` (every minute, also flushes counters), `expire-support-consents` (5 min),
`expire-financial-retention` (runs daily at 02:00 and acts on 1 April only, or with `{ force: true }`), `compute-health`
(04:00, batches of 200). The delayed `end-support-grant` job is enqueued only with Redis: the in-process runner would hold a
timer for hours; expiry is enforced per request and by the every-minute job.

## Decisions and notes

- `societies.version` is checked and incremented by this module under the row lock (not Sequelize `version: true`, so
  module 04's saves of the same row stay unaffected).
- The wizard invites the first admin through module 03 `createInvitation` with the full society catalogue in the context
  (platform staff hold no society permissions; module 03's "cannot grant what you do not hold" is for society admins).
  Any module 03 refusal becomes `409 INVITATION_CONFLICT` with the original code in `errors[0].reason`.
- Self-serve: the trial subscription (module 04 `createTrial`) is created before `createInitialMember`, so the admin seat
  is counted against a real plan. Module 02 refuses a SIGNUP OTP for a mobile that already has an account, so
  `TRIAL_ALREADY_USED` can only be reached with a token issued otherwise (the rule is implemented and tested). The admin
  session is issued in a second transaction after the sign-up commits; MFA enrolment is left to the module 02 flow.
- Module 04 refuses an Enterprise trial (`PLAN_NOT_SELF_SERVE`), mapped to `422 PLAN_NOT_AVAILABLE`, as is `PLAN_INACTIVE`.
- Approve, deny and revoke on the society side do not take an `Idempotency-Key` (8.23 does not list one); the grant
  `version` protects them.
- Exports are built in memory (no streaming) because the file service is a placeholder; the part limit is 450 MB and can be
  lowered in tests (`setExportPartLimit`). `fileIds` is left out of the CSV of `data_exports`; notes are never exported.
- Health "admin activity" counts distinct days of audit rows by non-resident, non-system actors in `audit_logs` directly.
- Purge ends memberships through module 03 (members then get `403 MEMBERSHIP_INACTIVE`); module 02 user rows are not
  touched (their anonymisation is module 02's own flow).
- In-app, push and platform in-app notices are not delivered by the `lib/notify` stand-in; e-mail, SMS and WhatsApp are.
- No OpenAPI generator exists in the repository yet (modules 02 to 04 have none either).

## Seeds

`npm run seed` (not production): Sky Heights ACTIVE (health 94), Green Park ACTIVE (health 72, consent off), Tulip Gardens
TRIAL (trial ends seed time + 14 days, mirrored to its module 04 subscription, health 40), a CREATED event each, the
prototype's historic grants G-0041 (EXPIRED) and G-0042 (ENDED), and one pinned note on Tulip Gardens. Idempotent.

## Tests

`tests/modules/societies/`: `unit` (T05-01 to 05, retention date, guard, zip, CSV), `platform-societies` (T05-06 to 10,
43, 44, list, detail, edit, CSV), `lifecycle` (T05-13, 14, 17 to 25, convert, reopen, purge hold), `signup` (T05-11, 12),
`support-access` (T05-27 to 35, 34a, 34b, 41, 42, BR-05-33), `state-guard` (T05-15, 16, banners, default policy),
`exports-purge` (T05-19d, 26, 36 to 38, 41, registry contract), `notes-health` (T05-39, 40, 45, health job).
`tests/helpers/probe.ts` mounts stand-ins for routes of later modules (SOS, notice publish, resident payment order, KYC
download, ticket edit) behind the real pipeline. Not covered here: T05-15a to 15h (routes of modules 15 to 25), T05-19c
with real financial tables (modules 06, 11 to 13), T05-46 to 48 (frontend E2E).
