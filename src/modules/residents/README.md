# Module 09: Residents, ownership and tenants (backend)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/09_Residents_Ownership_Tenants.md`.

The module is built in three backend parts on one branch (`module/09-residents`). **Part 1 (this README, first commit
series)** is the foundation: all ten tables, the resident records, unit links and their rules, documents, directory, pets,
emergency profiles, invitations and membership sync, the hooks of modules 02, 03 and 08, import and export, unit panel,
timeline, statistics and owner portfolio. **Part 2** builds join requests, tenancies and move requests; **part 3** builds
renovation permits, ownership transfers and their jobs and notifications. The extension points are listed at the end.

## What part 1 owns

- Migrations `20261108000100` to `20261108001100`: `residents`, `tenancies`, `ownership_transfers`, `unit_residents`,
  `resident_documents`, `join_requests`, `move_requests`, `renovation_permits`, `pets`, `emergency_profiles` and the foreign
  key `invitations.residentId -> residents.id ON DELETE SET NULL`. Generated columns and CHECKs are those of section 7.
  Run up, `undo:all` and up again on `societyapp` and `societyapp_test`.
- Models (`src/models`): `Resident`, `UnitResident`, `Tenancy`, `ResidentDocument`, `JoinRequest`, `MoveRequest`,
  `RenovationPermit`, `OwnershipTransfer`, `Pet`, `EmergencyProfile`, registered in `models/index.ts` with the associations
  of section 7. Residents, documents and pets are paranoid. `version` is managed by the services (`409 STALE_VERSION`).
- Env variable `RESIDENT_DATA_KEY` (base64, 32 bytes) in `src/lib/env.ts`, `.env.example` and `.env.test.example`.

## Files (`residents.*.ts`)

`constants` (enums, entitlement keys, audit actions, queue and job names), `shared` (errors, society-time "today", masking,
relation mapping, share arithmetic in hundredths, `assertFeatureFor`), `crypto` (AES-256-GCM), `ports` (placeholders),
`sync` (`syncMembership`), `links.service` (create, end, patch, shares, vacate, owner invariants), `occupancy`, `requests`
(readers of the request tables: delete guard, unit guard, open requests), `queries` (the functions of section 8.22),
`service` (resident records), `dto`, `invite.service` (invite, accept hook, welcome invites), `documents.service`,
`units.service` (flats, panel, timeline, stats, portfolio), `household.service`, `pets.service`, `emergency.service`,
`directory.service` (+ privacy), `import.service`, `export.service`, `hooks` (module 02), `exports`, `purge`, `jobs`,
`templates`, `notify`, `validation`, `controller`, `routes`, `public`.

## Routes of part 1 (45)

Admin: `GET /residents`, `GET /residents/units`, `GET /residents/units/:unitId`, `GET /residents/units/:unitId/timeline`,
`PUT /residents/units/:unitId/ownership-shares`, `POST /residents/units/:unitId/vacate`, `GET /residents/stats`,
`GET /residents/export`, `POST /residents/import`, `GET /residents/import/:jobId`, `POST /residents`,
`PATCH /residents/links/:linkId`, `POST /residents/links/:linkId/end`, `GET|PATCH|DELETE /residents/:id`,
`POST /residents/:id/invite`, `POST /residents/:id/links`, `GET|POST /residents/:id/documents`,
`POST /resident-documents/:docId/verify`, `DELETE /resident-documents/:docId`,
`GET /resident-documents/:docId/download-url`, `GET /pets`, `GET /sos/:sosId/emergency-profiles`,
`GET /gate/sos/:sosId/emergency-profiles`.

Resident app: `GET /me/household`, `POST /me/household/members`, `PATCH|DELETE /me/household/members/:linkId`,
`POST /me/household/members/:linkId/invite`, `PUT /me/household/members/:linkId/emergency-profile`, `GET /me/portfolio`,
`GET|POST /me/pets`, `PATCH|DELETE /me/pets/:id`, `GET|PUT /me/emergency-profile`, `GET|PATCH /me/privacy`,
`GET /me/directory`, `GET|POST /me/documents`, `GET /me/documents/:docId/download-url`.

Order on a route: `routeMeta` (noSupportAccess), society marker, permission, entitlement, validate, step-up, rate limit,
idempotency. Step-up: `DELETE /residents/:id` and `GET /residents/export`. `noSupportAccess`: the two document download
routes, export, import start and import status. Fixed paths (`/residents/units/*`, `/residents/stats`, `/residents/export`,
`/residents/import`, `/residents/links/:linkId`) come before `/residents/:id`.

## Start-up: `registerResidents()`

Call after `registerAccessControl()`, `registerSubscriptions()`, `registerSocieties()` and `registerSocietySetup()` (done
in `server.ts`, `worker.ts` and `scripts/seed.ts`):

- module 02 port `residentsHooks` (`onUserMobileChanged`, `onUserAnonymised`);
- module 03 port `residents` (`getActiveUnitLinks`, `onResidentInvitationAccepted`, `getUnitLabels`);
- module 08: replaces the placeholder port `residents.sendWelcomeInvites`, registers the `RESIDENTS` onboarding check
  (`n of m flats have an owner`) and the unit guard (`UNIT_HAS_RESIDENTS`);
- module 05 `registerExportProvider` (ten tables, the notes decrypted in the society's own export) and
  `registerPurgeHandler` (module `residents`, order 9, so it runs before module 08 deletes the units);
- jobs: queue `residents` with `residents:sync-links` (daily 00:15 IST), `residents:pet-reminders` (daily 09:00 IST),
  `residents:import` and `residents:welcome-invites` (on demand).

## Public functions (`residents.public.ts`)

`residents.listForUnit | changedSince | sendWelcomeInvites | billToFor | unitIdsForUser | getActiveUnitLinks |
visitorApproverUserIds | audienceUserIds | activeLinkCount | occupancyOf | getSummary`, `getHouseholdControl`,
`onResidentInvitationAccepted`, `residentsHooks.onUserMobileChanged | onUserAnonymised`,
`emergencyProfiles.forSos`, `registerResidents`, `setResidentPorts`, `registerSyncStep`, and for parts 2 and 3
`createLink`, `endLinks`, `repairOwners`, `lockLinks`, `liveTenancyOf`, `syncMembership`, `attachDocuments`,
`createResident`, `inviteResidentTx`.

## Notes and decisions

- **Placeholders** (`residents.ports.ts`, replaced with `setResidentPorts`): module 01 files (document and photo link, delete,
  download URL: they use the memory file store of module 05, so a test or `POST /dev/files` puts the file there), module 12
  `payments.onUnitLinkEnded`, module 19 `parking.onUnitLinkEnded`, module 24 `reportsCache.touch`, module 11
  `unitLedger.balance` (0), module 17 `sos.getActive` (null: every SOS route answers `404 SOS_NOT_FOUND`). Calls are
  recorded in `residentPortCalls`. Notifications go through the temporary `lib/notify.ts` (templates in
  `residents.templates.ts`), realtime through `lib/realtime.ts`.
- **Locks (BR-09-19)**: unit row (`units.lockActive`), then the unit's link rows `FOR UPDATE`, then the tenancy, then the
  request row. The unique keys of section 7.2 back it up.
- **Ending a link and "today"**: BR-09-9 makes a link with `toDate = today` active until midnight. The resident turns INACTIVE
  at once (no open link) and loses `ctx.unitIds` at once (`getActiveUnitLinks` needs an ACTIVE resident), but the
  membership of a resident-scope user is ended by `syncMembership` only when no link is active: a link ended today is
  therefore cleaned up by the daily `sync-links` job; ending with yesterday's date ends the membership in the same request.
- **Shares (BR-09-12)**: a sole owner has `sharePercent` NULL in the table and the API shows `"100.00"`. Several owners either
  all have a share totalling exactly 100.00 or none has one; `PUT .../ownership-shares` sets them atomically. Ending an owner
  link re-scales the remaining shares (one owner left: NULL again; several: proportional, the rest to the primary).
- **Primary (BR-09-14)**: the first owner link is primary; `repairOwners` runs after every owner change and promotion
  (`promoteLinkId` turns a CO_OWNER into the OWNER).
- **`userId` foreign key**: `residents.userId -> users.id` is `RESTRICT`, not `SET NULL` as the spec says: MySQL does not allow
  `SET NULL` on the base column of a stored generated column (`activeUserId`). Module 02 anonymises users, it never deletes
  them. There is no foreign key on `photoFileId` and `fileId` (the module 01 `files` table does not exist yet).
- **Tenancies in part 1**: the table exists and is read (occupancy, `billToFor`, panel, stats, timeline, delete guard). The
  only writers in part 1 are the demo seed, `POST /residents/units/:unitId/vacate` (ends the live tenancy) and the import
  (a TENANT row creates an ACTIVE tenancy, source `IMPORT`, or APPROVED when the agreement starts later).
- **Import**: state in `lib/kv` under `res:import:<jobId>` (24 h), lock `res:import-lock:<societyId>`; Redis or memory
  depending on `REDIS_URL`, only the memory side is tested. Dry run: one transaction with a savepoint per row, rolled back at
  the end; commit: one transaction per row. Rows of one flat with an owner relation and a share are checked as a group
  (all owners with a share, total 100.00) before any row runs. The template has no family-relation column, so a FAMILY row
  gets `RELATIVE` and household OWNER. A rerun reports `ALREADY_IMPORTED` for rows whose person already has that link.
  The result CSV holds masked mobile numbers only.
- **Welcome invites (BR-09-79)**: `residents.sendWelcomeInvites` skips residents with a PENDING invitation (by resident or by
  mobile), minors, residents without a mobile or a login-allowed link, and users who are already members.
- **Audit redaction**: the audit helper masks keys named like `code`, `pan` or `token`; the audit rows of this module use
  `changedFields`, `docType`, `fullyAnonymised` and similar names, never the medical notes.
- **Jobs run for every society in one daily job** (the global repeatable of module 01), not per society time zone; each step
  uses the society's own "today". Suspended societies are skipped (BR-09-74).

## Left for parts 2 and 3 (extension points)

- Part 2 (`join-requests.service`, `tenancies.service`, `moves.service`): routes of sections 8.13 to 8.15, the `/me/...`
  join, tenancy and move routes, the `JOIN_REQUEST`, `MOVE_IN`, `MOVE_OUT` approval types, `residentsHooks.onDepositPaid` and
  `onDepositRefunded` (add them to `residentsHooks` in `residents.public.ts`), `residentsReports.tenancyExpiry`,
  `moveRequests.listForGate`, the jobs `tenancy-reminders`, `police-reminders`, `join-requests`, `deposit-refunds` and the
  steps of `sync-links` (register with `registerSyncStep`), the notifications of section 10 for these flows (append to
  `residents.templates.ts`). Use `createLink` with `{ internal: true }` for TENANT links, `endLinks` to end a tenancy's links
  and `liveTenancyOf`. The tables, models and DTO readers already exist.
- Part 3 (`renovation.service`, `transfers.service`): sections 8.16 and 8.17, `RENOVATION_PERMIT` and `OWNERSHIP_TRANSFER`
  approval types, `renovationPermits.listForGate`, the job `renovation-daily`, module 11, 13, 23 ports (add to
  `ResidentPorts`), transfer completion through `createLink` with `ownershipTransferId` and `allowMinorOwner`, `endLinks`
  and `repairOwners`.
- Both: add the routes to `residents.routes.ts` (or their own router mounted beside it), add the new routes with ids to the
  `covered` list of `tests/modules/access-control/tenant-isolation.test.ts`, and the new tables are already in the export
  provider and the purge handler.

## Tests

`tests/modules/residents/` (helpers in `tests/helpers/residents.ts`; the shared reset deletes the new tables and the `res:`
cache prefix): `residents` (T09-06, 07, 09, 48, 52 to 55, BR-09-1 to 7, masking), `links` (T09-02 to 04, 08, 10, 11, 43, 58,
59 to 61, BR-09-9 to 19), `public` (T09-01, 42, section 8.22), `invitations-hooks` (T09-39 to 41, 44, invite rules),
`documents` (T09-48, 49, BR-09-37 to 39), `community` (T09-36 to 38, 50, pets, emergency, directory, privacy),
`household`, `units` (flats, panel, timeline, stats, portfolio), `import-export` (T09-45), `access` (route table, T09-46),
`registrations` (provider, purge, onboarding check, jobs, schema, seed). T09-05, 12 to 35, 47, 51, 56, 57, 62 belong to
parts 2 and 3 or to the frontend.
