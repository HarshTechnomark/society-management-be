# Module 07: Platform operations (backend)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/07_Platform_Operations.md`. This folder was built in two parts and the
backend is complete. **Part 1**: all six tables, support tickets (8.3, 8.4), platform settings with the registry (8.10),
organizations (8.12), the settings reader and the wiring into modules 02, 05 and 06, the IP allowlist, the ticket jobs.
**Part 2**: service providers and credentials (8.5), provider health (6.4), incidents and the public status page (8.6),
announcements (8.7), the jobs and queues monitor (8.8), audit viewers, export and archive (8.9), dashboard, activity feed and
health strip (8.2), request metrics (9.4), the remaining jobs of 9.1, templates, audit actions, realtime events and seeds.

## Files

- `platform-ops.types.ts`: queue name, job names, audit actions and entity types, ticket number helpers (`TKT-` + 6 digits).
- `platform-ops.settings-registry.ts`: every setting key with category, type, default, description and Zod schema; the
  three cross-key rules (`crossKeyError`). The seeder (`seedPlatformSettings`, also run lazily by `GET /platform/settings`
  and `PATCH`) inserts missing keys and never overwrites; a cached "missing" is dropped when the key is inserted.
- `platform-ops.settings.service.ts`: `getPlatformSetting(key)` (registry default when no row), `getStoredSetting(key)`
  (`undefined` when no row, so another module keeps its own default), 60 second cache `ps:<key>` through `lib/kv`,
  `listSettings`, `updateSettings` (all or nothing, per key versions, audit per key, cache delete and
  `settingsEvents` `platform-ops:settings-changed` after commit).
- `platform-ops.ip-allowlist.ts`: `platformIpAllowlist()` mounted in `app.ts` on `/api/v1/platform` for every module
  (BR-07-43); `ipAllowed()` handles IPv4-mapped IPv6.
- `platform-ops.sla.ts`: pure SLA maths (due times, pause accounting, priority change, scan).
- `platform-ops.tickets.core.ts` (locking, messages, transitions, realtime, notifications), `.tickets.service.ts`
  (platform side), `.tickets.society.ts` (society side), `.tickets.view.ts` (serializers; the society one is an allowlist).
- `platform-ops.jobs.ts`: queue `platform-ops`: `ticket-sla-scan` (every 5 minutes), `ticket-housekeeping` (hourly).
- `platform-ops.organizations.service.ts`, `platform-ops.validation.ts`, `.controller.ts`, `.routes.ts`.
- `platform-ops.public.ts`: `registerPlatformOps()` (called in `server.ts`, `worker.ts`, `scripts/seed.ts` after the module 06 hook)
  and the section 8.13 functions that belong to part 1 (`getPlatformSetting`, `countOpenTicketsBySociety`, `createTicketForSociety`).
- `platform-ops.ports.ts`: replaceable placeholder for the module 01 files service (see below).
- `platform-ops.templates.ts`, `platform-ops.notify.ts`: section 10 ticket templates for the temporary `lib/notify`.
- Models: `platform-setting`, `platform-ticket`, `platform-ticket-message` (immutable hooks), `service-provider`
  (default scope hides the ciphertext, scope `withSecrets`), `incident`, `platform-notification`. Migrations
  `20261106000100` to `20261106000600`. Seeds: `seeders/platform-ops.ts` (settings everywhere, demo tickets outside production).

## Placeholders and decisions

- **Files (module 01)**: attachments (`fileIds`, purpose `PLATFORM_ATTACHMENT`) go through `opsPorts().files`. The default checks
  module 05's memory file store (`placeholderFiles`): clean file, purpose `PLATFORM_ATTACHMENT`, uploaded by the caller, society
  matches, not linked before; links are kept in memory. Module 01 replaces it with `setPlatformOpsPorts({ files })`.
- **Notifications** use `lib/notify`; only the email part is delivered by the stand-in (in-app and push wait for module 16).
- **Settings events** (`platform-ops:settings-changed`) are an in-process emitter; the Redis pub/sub channel is module 16's concern.
- **Settings wiring**: module 02 (`setAuthPorts({ getPlatformSetting })`), module 05 (`setSocietyPorts({ settings })`) and module 06
  (`setBillingSettingsSource`). A key with no row (or an invalid stored value) keeps the default of the reading module. Module 04
  reads no platform setting yet.
- **Auto-resolve reference time** (BR-07-12): the later of the last society message and the moment the ticket entered WAITING, so a
  ticket that has only just been put on WAITING is not resolved at once.
- **Platform PATCH RESOLVED -> IN_PROGRESS** restarts the resolution clock like a society reopen but does not count as a reopen.
- Society ticket serializer keeps `sla` with the due dates and `firstRespondedAt` only (no breach fields, no `version`).
- `/api/v1/platform/*` called by a society member answers `403 PLATFORM_ACCESS_REQUIRED` (module 03 middleware), not
  `PERMISSION_DENIED` as T07-52 words it.
- The rate limit of 20 tickets per society per 24 hours counts `ADMIN_APP` tickets in the database (so it follows the frozen clock in tests).

## Part 2 files

- `platform-ops.crypto.ts` (AES-256-GCM, key ring from `PROVIDER_CREDENTIALS_KEYS`, masking), `platform-ops.providers.schemas.ts`
  (vendor matrix, config and credentials Zod schemas), `.providers.registry.ts` (`resolveProvider`, `listEnabledProviders`, 60 s
  in-process cache of decrypted credentials cleared on `platform-ops:providers-changed`), `.providers.service.ts` (CRUD,
  credentials, delete, manual status, test send), `.providers.health.ts` (checks, uptime roll-up), `.providers.rekey.ts`
  (`npm run providers:rekey`, script `scripts/providers-rekey.ts`).
- `platform-ops.incidents.service.ts`, `.status.service.ts` (public page, cache key `status:v1` 30 s, dropped on every incident or
  provider status change), `.announcements.service.ts`, `.announcements.audience.ts`.
- `platform-ops.queues.service.ts` (over `queueInspector()` of `lib/queue`), `.audit.service.ts` (viewers, CSV, archive list and
  download), `.audit-archive.ts` (the job and the only `DELETE FROM audit_logs`; ESLint rule `no-audit-delete` in `eslint.config.js`),
  `.dashboard.service.ts`, `.metrics.ts` (middleware mounted right after `requestId` in `app.ts`).
- `platform-ops.operations.{routes,controller,validation}.ts` hold the part 2 routes; `platform-ops.routes.ts` mounts them.
- Seeds in `seeders/platform-ops.ts`: `seedDemoProviders`, `seedDemoIncidents`, `seedDemoAnnouncement` (run by `npm run seed` outside
  production).
- Shared infrastructure added for this part: `lib/kv` (`setAdd`/`setHas`, `hashIncr`/`hashGetAll`/`hashKeys`/`hashDel`), `lib/queue`
  (job records, `queueInspector()` with BullMQ and in-process drivers, pause and resume, retry, remove), `lib/notify`
  (`options.channels`), `utils/audit` (`onAuditCommitted` listeners, used for `platform.activity`), `adapters/provider-adapter.ts`.

## Part 2 decisions and differences from the spec

- **Vendor adapters**: only the `FAKE` vendor has working `healthCheck`, `testSend` and `connectionTest` (`failMode` `none`, `error`,
  `slow`; `slow` reports 5000 ms without waiting). Every real vendor (MSG91, Gupshup, SES, Razorpay, ...) answers "adapter is not
  built yet" so a check fails honestly; module 16 wires the real ones (`buildProviderAdapter` in `adapters/provider-adapter.ts`). The
  optional `healthCheck?`/`testSend?` on the module 01 `SmsSender`, `EmailSender`, `WhatsAppSender` and `PaymentGateway` interfaces
  are declared but only the provider adapter implements them.
- **Environment**: `PROVIDER_CREDENTIALS_KEYS` and `PROVIDER_CREDENTIALS_ACTIVE_KEY_VERSION` are validated whenever set and are
  required in production; in development and tests a missing key ring makes credential routes answer
  `500 CREDENTIALS_KEY_UNAVAILABLE` (`.env`, `.env.test` and `.env.example` carry keys). `STATUS_PAGE_ORIGIN` and
  `AUDIT_ARCHIVE_PREFIX` are read; `PLATFORM_EMAIL_DOMAIN` is not added because module 03 already reads `PLATFORM_TEAM_EMAIL_DOMAIN`.
- **Audit `after` of credential changes** is `{ updated: ['credentials'], keyVersion }` (the log redactor would turn a key named
  `credentialsUpdated` into `[REDACTED]`). Provider `test_sent` keeps the masked recipient.
- **Redis structures**: dismissals use a set per announcement (`pn:dismissed:<id>`), request metrics one hash per minute
  (`m:<yyyyMMddHHmm>` with fields `t`, `e`, `l<bucket>`), provider day counters a hash per day (`ph:<id>:<yyyymmdd>`, fields `ok` and
  `fail`), fan-out marks a set (`pn:sent:<id>`) replacing module 16's `dedupeKey`, the failed-jobs alert one value (`pfa:last`).
  The Redis implementations are written but not run against a real Redis here; the memory ones are tested.
- **Object storage** for the audit archive is the `storage` port in `platform-ops.ports.ts` (memory placeholder, `placeholderObjects`);
  the module 01 storage service replaces it with `setPlatformOpsPorts({ storage })`. The archive is built in memory per month
  (the real one should stream a multipart upload).
- **Queue monitor** works through `queueInspector()`: the in-process runner keeps job records (failed jobs after 5 attempts, up to
  1000 per queue; completed jobs are only counted for `completed24h` and throughput) and honours pause and resume (jobs wait as
  `waiting`; `drainQueues()` does not wait for them). The BullMQ driver is written from the BullMQ API and not run here.
- **Announcements**: plan keys are stored upper case (module 04 codes) and accepted in any case. The linked incident banner is
  published even when no member matches (BR-07-36). In-app and push parts of the fan-out wait for module 16; only e-mail is
  delivered, and only when the `EMAIL` channel was chosen.
- **Incidents**: manual provider incidents are public, automatic ones private. Resolving through manual `OPERATIONAL` does not
  trigger BR-07-29 (the provider stays `MANUAL`, as BR-07-28 says).
- **Dashboard**: `unitsUnderManagement` is `null` until module 08 reports units, `paymentSuccessRatePct` is `null` until module 12;
  "providers not OPERATIONAL" lists enabled providers in `DEGRADED` or `OUTAGE` (not `UNKNOWN`). The activity allowlist covers
  `platform.society.*`, `platform.incident.*`, `platform_billing.invoice.paid`, `platform.ticket.created`,
  `platform.provider.status_changed` and `platform.announcement.published`; module 05 onboarding milestones are not audited under
  a name this module knows, so they are not listed. New items are pushed on `platform:ops` as `platform.activity`.
- **Realtime rooms** `platform:ops` and `platform:support` are only emitted to; authorising joins is module 01's Socket.IO server.
- Society routes `GET /platform-announcements`, the dismiss route and the society audit routes work for a suspended society.
- The permission-matrix test now uses a role with no permission at all (every platform key has a route now) and the isolation test
  lists the two new id routes.
- No migrations were added in part 2 (all six tables came with part 1).
