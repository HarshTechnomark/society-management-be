# Module 07: Platform operations (backend)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/07_Platform_Operations.md`. This folder is built in parts.
**Part 1 (done)**: all six tables, support tickets (8.3, 8.4), platform settings with the registry (8.10), organizations
(8.12), the settings reader and the wiring into modules 02, 05 and 06, the IP allowlist, the ticket jobs, ticket
notifications, audit and realtime. **Part 2 (not built)**: providers (8.5), incidents and status page (8.6),
announcements (8.7), jobs and queues monitor (8.8), audit viewers and archive (8.9), dashboard and health summary (8.2),
request metrics middleware (9.4), the other jobs of 9.1, provider/incident/announcement seed data.

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

## Part 2 must know

- Queue `platform-ops` and `registerPlatformOpsJobs()` exist; add processors and repeatables there.
- Audit constants in `platform-ops.types.ts` (`AUDIT`, `ENTITY`) cover tickets, settings and organizations only.
- `SETTINGS_REGISTRY` already holds the keys for part 2 (`alerts.*`, `audit.*`, `status.publicEnabled`, `security.ipAllowlist`).
- Tables for providers, incidents and announcements exist with models registered in `src/models/index.ts`; seeds for them are not written
  (`seeders/platform-ops.ts` says so at the top).
- Test helpers: `tests/helpers/platform-ops.ts` (`resetOps`, `opsSociety`, `insertTicket`, `placeholderAttachment`); `resetAll` clears the
  `ps:` cache and the new tables.
