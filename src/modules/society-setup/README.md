# Module 08: Society setup and onboarding (backend)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/08_Society_Setup_Onboarding.md`.

Part 1 (this branch) builds the tables, the settings registry, the profile, buildings, units, the bulk generator, locations,
holidays and the onboarding checklist, with their routes, the service API for other modules, the registrations and the demo
seed. **Part 2** adds the unit import (CSV and XLSX), its validation report and Redis state, the unit export job and the
go-live welcome-invite job (see "Part 2: import, export, jobs").

## What it owns

- Migrations `20261107000100` to `20261107000700` (spec `08-01` to `08-07`): `buildings`, `units` (generated
  `activeNumberKey` and `activeLabelKey`, CHECKs, unique keys), `society_settings`, `onboarding_steps`, `holidays`,
  `location_nodes` (generated `parentKey` and `activeNameKey`) and the foreign key `invitations.unitId -> units.id` (checks
  `information_schema` first; clears orphan values first). The `REGEXP` CHECKs use `REGEXP_LIKE(..., 'c')` because the
  table collation is case-insensitive.
- Models `Building`, `Unit`, `SocietySetting`, `OnboardingStep`, `Holiday`, `LocationNode` (none paranoid) in `src/models`.
- Files (all `society-setup.*.ts`): `types` (audit actions, entity names, entitlement keys, DTOs), `settings-registry` (185
  keys, exactly the keys, defaults, ranges and order of section 7.3), `settings.service`, `profile.service`, `gstin`,
  `shared`, `limits` (`adjustFlats`), `buildings.service`, `units.service`, `generator.pattern` (pure parser and renderer),
  `generator.service`, `locations.service`, `holidays.service`, `holiday-suggestions`, `onboarding.service`, `notify`,
  `templates`, `ports`, `exports`, `purge`, `validation`, `controller`, `routes`, `public`.

## Routes (40, section 8.1 without import and export)

Profile and settings: `GET|PATCH /society`, `GET|PATCH /society/settings`.
Buildings: `GET /buildings`, `GET /buildings/:id`, `GET /buildings/:id/grid`, `POST /buildings`, `PATCH /buildings/:id`,
`POST /buildings/:id/archive`, `POST /buildings/:id/restore`, `DELETE /buildings/:id`.
Units: `GET /units`, `GET /units/:id`, `POST /units`, `PATCH /units/:id`, `POST /units/:id/archive`,
`POST /units/:id/restore`, `DELETE /units/:id`, `POST /units/bulk-update`, `POST /units/generator/preview`,
`POST /units/generator/commit`.
Locations: `GET /locations`, `GET /locations/:id`, `POST /locations`, `PATCH /locations/:id`,
`POST /locations/:id/archive`, `POST /locations/:id/restore`, `POST /locations/:id/regenerate-qr`.
Holidays: `GET /holidays`, `GET /holidays/suggestions`, `POST /holidays`, `POST /holidays/bulk`, `PATCH /holidays/:id`,
`DELETE /holidays/:id`.
Onboarding: `GET /onboarding`, `POST /onboarding/steps/:stepKey/complete|skip|reopen`, `POST /onboarding/go-live`.

Order on a route: society marker, permission, entitlement, validate, step-up, idempotency. Step-up routes: `PATCH /society`
(only when `legalName`, `registrationNo` or `gstin` really changes: an async check against the stored values),
`PATCH /society/settings` (when a changed key has `requiresStepUp`), `DELETE /buildings/:id`, `DELETE /units/:id`.
`GET` routes use `requireFeature(key, { mode: 'read' })` (the 90-day read grace of module 04); writes need the feature on.

## Start-up: `registerSocietySetup()`

Call after `registerAccessControl()`, `registerSubscriptions()` and `registerSocieties()` (done in `server.ts`, `worker.ts`,
`scripts/seed.ts`):

- module 02 port `societySettings.getSessionPolicy` (the keys `security.adminIdleMinutes` and `security.stepUpMinutes`);
- module 05 ports `units.count` and `onboarding.progressPercent` (health score, and module 07 `unitsUnderManagement`, which
  needed no code change: it reads `societyPorts().units.count`);
- module 04 `registerUsageProvider('limit.flats', units.count)` for the nightly reconciliation;
- module 05 `registerExportProvider` (six tables) and `registerPurgeHandler` (module `society-setup`, order 8).

## Public functions (`society-setup.public.ts`, section 8.30)

`units.get | listActive | count | getByLabel | lockActive | registerUnitGuard`, `countUnits(societyIds?)`,
`settings.get | getMany | getNamespace | set | setMany`, `societySettings.getSessionPolicy`, `buildings.list`,
`locations.get | listTree | listGates | getByQrToken`, `holidays.isHoliday | isWorkingDay | nextWorkingDay | addWorkingDays |
listBetween`, `onboarding.progressPercent | isLive | registerCheck | ensureSteps | registerGoLiveHook`, `setSetupPorts`.

## Notes and decisions

- **Settings.** Reads merge stored rows over registry defaults and are cached under `ss:set:<societyId>` (300 s) through
  `lib/kv` (a Redis string holding all rows of the society as JSON, not a Redis hash; memory without `REDIS_URL`, as in the
  other modules). Every write goes through `setMany` in the caller's transaction: schema check, namespace edit permission when
  the context has a user, version check when versions are passed (a racing first insert hits the unique key and gives
  `STALE_VERSION`; existing rows are locked by id so two first inserts cannot deadlock on gap locks), cross-key rules on the
  merged result (only for rules that involve a changed key), audit per changed key, and cache delete, realtime and
  notification after commit. A value equal to the stored one is skipped; a key without a row is always inserted on its
  first save. A JSON null (clearing a profile value) is written as the JSON literal. `PATCH /society/settings` and
  `GET /society/settings` use "any of the view / edit permissions of the registry" at the route and the per-key check in the
  service, because the spec's "authenticated member" would otherwise be an unmarked route in the route registry.
- **Profile.** `profile.*` keys are written by `PATCH /society` through `setMany` without their own audit row (they are part
  of the `setup.society.updated` row). `GSTIN_CHECKSUM_INVALID` is checked before the state and PAN rules. The GSTIN cannot be
  removed while `billing.applyGst` is on. The logo is linked through a port (`society-setup.ports.ts`) until module 01's
  files service exists; the placeholder reads `placeholderFiles` of module 05.
- **Units.** Lock order: societies (share changes only), buildings by id, units by id. The share total is a locking read
  (`FOR SHARE`) so a parallel edit that committed while this one waited is seen. A type change to `PARKING_ONLY` fails with
  `400 VALIDATION_FAILED` unless `bhk` is cleared in the same request. `areaSqft` follows `billing.areaBasis`; changing the
  basis recomputes the units whose value changes and writes one `setup.unit.area_recomputed` audit row with the count.
  Counter changes: `consumeLimit` or `releaseLimit` and then `onFlatCountChanged` once per transaction (`limits.ts`).
- **Generator.** `previewHash = sha256(canonical params + rendered labels + structure settings)`. Commit re-plans inside
  the transaction with the existing target buildings locked `FOR UPDATE` and the conflict check as a locking read, so two
  parallel commits into one building give one `201` and one `409 UNIT_NUMBER_CONFLICT`. Units are inserted in chunks of 100
  (`testHooks.afterUnitsInserted` lets a test fail the run between chunks and prove the rollback, T08-08). A pattern that gives
  one number to two cells of a building is `422 PATTERN_NOT_UNIQUE`. The response `used` is read after the commit.
- **Locations.** Materialized `path` is written after the insert (needs the id). Moves rewrite the subtree with one `UPDATE`.
  Archive archives the node and its ACTIVE descendants; restore restores the node only (its parent must be ACTIVE and the name
  free). Building archive archives the whole subtree, building restore brings back the BUILDING node only. `qrToken` is in
  responses only when `property.unit_qr_codes` is on; the public `locations.get` and `getByQrToken` always return it.
- **Onboarding.** Checks run with a 2-second timeout. A check that times out or throws is `UNKNOWN`; it does not confirm a
  step on `complete` and counts as failing at go-live. After go-live: `complete` and `skip` give `409 ALREADY_LIVE`,
  `reopen` gives `409 INVALID_STATE` (BR-08-47 and T08-37). `ensureSteps` counts first and only inserts when rows are
  missing (an `INSERT IGNORE` of existing rows deadlocks with a transaction that holds them), and retries a deadlock outside
  a transaction. The COMMITTEE fallback uses module 03 `usersWithPermission('settings.society.view')`.
- **Audit redaction.** The audit helper masks keys named `code`, `pan`, `token` and the like. Building audit rows therefore
  use `buildingCode`, and `qrToken` never appears in an audit row.
- **Support access.** Derived support permissions already exclude `delete`, `import` and `export` keys; `DELETE /buildings/:id`
  and `DELETE /holidays/:id` use `settings.society.edit`, so they carry `routeMeta({ noSupportAccess: true })`
  (`403 SUPPORT_ROUTE_FORBIDDEN`).
- **Suspended and closed.** No route is allow-listed (BR-08-48): the module 05 state guard applies its default policy.
- **Lists.** `GET /buildings` and `GET /units` answer `data: [...]` plus `pagination` (`okList`, like modules 02 to 07);
  settings, locations and holidays answer the object shapes of section 8.
- No new environment variable. No OpenAPI generator exists in the repository yet (modules 02 to 07 have none either).

## Differences and open points in the spec

- The example GSTINs of the spec (`27AAAAG1234C1Z5`, `27AAAAS1234C1Z5`) do not pass the mod-36 check digit that BR-08-2
  requires (the check characters would be `E` and `2`). The validator follows the algorithm (verified with the real
  GSTIN `27AAPFU0939F1ZV`); tests use correct numbers built by `gstinFor`.
- T08-32: with Sunday off only, `addWorkingDays('2026-11-06', 2)` is `2026-11-09` (Saturday works). The spec result
  `2026-11-10` needs Saturday off as well (`office.weeklyOffDays = [0, 6]`), which the test uses.
- `holidays.nextWorkingDay` searches 31 days (offsets 0 to 30) and returns the 30th day after the date when none works.
- Demo seed: `limit.flats` is set by resetting the counter written by the module 04 seed to 0 and then consuming through the
  generator (so `onFlatCountChanged` also runs); the final counters are 72 and 30 as in the spec.

## Part 2: import, export, jobs

- Files: `imports.parse` (CSV with `csv-parse`, XLSX with `exceljs`, first sheet, formulas as cached value), `imports.rules`
  (header synonyms, row rules, one `planImport` for the dry run and the commit), `imports.state` (JSON per import under
  `ss:import:<id>`, rows under `ss:import:<id>:rows`, 24 h; lock `ss:import-lock:<societyId>` through the new
  `kv().setIfAbsent`; Redis or memory depending on `REDIS_URL`; only the memory side is tested), `imports.service`
  (routes and the `validate-import` and `commit-import` jobs), `export.service` (`export-units`), `csv` (injection helper
  shared by export and report), `jobs` (`registerSocietySetupJobs()`, called by `registerSocietySetup()` and so by the API,
  the worker and the seed).
- A job exits unless the state has the status it expects. The final status and result are written with one `SET`.
- `limit.flats`: the dry run marks rows beyond the remaining limit `LIMIT_EXCEEDED` in file order; the commit keeps them
  refused and calls `adjustFlats` once.
- Go-live invites: the go-live hook queues `go-live-invites` with `jobId go-live:<societyId>` after commit. The job calls
  `setupPorts().residents.sendWelcomeInvites(ctx, societyId)`. **Module 09 does not exist yet**: the default port only
  records the call (`welcomeInviteCalls`) and logs. Module 09 replaces it and must be idempotent.
- Notifications: `setup.import.validated` (PUSH), `setup.import.committed`, `setup.import.failed` (EMAIL),
  `setup.export.ready` (in-app only, module 16). Realtime to `user:<id>`: `setup.import.updated`
  (`{ importId, status, counts }`), `setup.export.ready` (`{ fileId }`).
- Rate limit of the export route: 10 per hour per user (`setup-export`). `noSupportAccess` is set on it.

### What the real module 01 files service must provide

- `files.getImportFile(societyId, userId, fileId)` (see `society-setup.ports.ts`): `404 FILE_NOT_FOUND` for an unknown file,
  another society's file or a file the caller did not upload; `422 FILE_NOT_LINKABLE` unless the purpose is `IMPORT_FILE`;
  `409 IMPORT_FILE_NOT_READY` unless the scan status is `CLEAN`; the bytes (at most 20 MB) and the original name.
- `files.storeSystemFile` for the `EXPORT_FILE` of the export and of the import error report (owner = requester).
- `GET /files/:id/download-url` (answers `{ url, expiresAt }`). Until then module 08 registers a placeholder of the same
  path outside production (`can('residents.units.import', 'residents.units.export')`, the file must belong to the society).
- Development only: `POST /api/v1/dev/files?societyId=&ownerUserId=&name=[&purpose=IMPORT_FILE]` with the raw bytes as body
  stores a CLEAN file in the memory store and answers `{ fileId }`; tests use `putPlaceholderFile` (it can also put a file in
  as not scanned). Files vanish on restart.
- Files of module 01 cleanup: the upload and the report are unlinked files deleted 24 hours later (spec 16).

## Tests

`tests/modules/society-setup/` (helpers in `tests/helpers/society-setup.ts`; the shared reset deletes the new tables and the
`ss:` cache prefix): `unit` (T08-01 to 06, registry, cross-key rules, schemas), `settings` (T08-16 to 20, 41, BR-08-8 to
14), `profile` (US-08-01, BR-08-1 to 6), `buildings`, `units` (T08-10 to 15, 37), `generator` (T08-07 to 09, US-08-02, 05),
`locations` (T08-26, 27, US-08-09), `holidays` (T08-32, US-08-10), `onboarding` (T08-28 to 31, 37, US-08-08), `access`
(T08-33 to 36, support access, route table), `registrations` (export provider, purge, T08-38, ports, seed), `schema`.
`imports` (T08-21 to 25, every import, export and go-live-invite rule). Not covered here: T08-39 and 40 (frontend end to end). The tenant-isolation test lists the module 08 routes with ids; the permission matrix covers them automatically.
