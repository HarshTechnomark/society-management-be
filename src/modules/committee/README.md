# Module 10: Committee and staff accounts (backend)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/10_Committee_and_Staff_Accounts.md`.

The module is built in three backend sub-modules on one branch (`module/10-committee-staff`). **10.1 (this README, first
commit series)** is committee terms and seats: the `committee_terms` table, create, edit, delete, seat edits, historical
committees and the service API. **10.2** builds activation (preview and take charge), mid-term changes, hand-over
delegations and the term transition. **10.3** builds the hand-over checklist, the reminder, auto-expiry and reconcile jobs,
the staff seat meter and the resident pages. The extension points are listed at the end.

Module 10 owns exactly one table, `committee_terms`. It never writes `society_members`, `roles` or `invitations`; every account
effect (10.2) goes through module 03.

## What 10.1 owns

- Migration `20261110000100-create-committee-terms.js`: the full table of section 7.1 with the generated columns
  `currentSlot`, `draftSlot`, `electionSlot`, the CHECKs, the unique indexes and the two foreign keys (society and
  predecessor, both RESTRICT). `electionId` has no foreign key; module 22 adds `fk_ct_election`. Run up, `undo:all` and up
  again on `societyapp` and `societyapp_test`.
- Model `CommitteeTerm` (`src/models/committee-term.model.ts`), registered in `models/index.ts` with the associations of 7.1
  (`belongsTo` society, `predecessor`, `hasOne` `successor`). Paranoid. `members` and `handoverChecklist` are JSON arrays whose
  getter and setter parse with the Zod schemas of section 7.2 (`committee.schemas.ts`); a malformed row is
  `500 INTERNAL_ERROR`. `beforeDestroy` throws `409 INVALID_STATE` unless the term is a DRAFT. The generated columns are never written.
- No new env variable, no new permission key (`settings.members.*` and the catalogue keys `governance.committee_terms`,
  `governance.office_bearers`, `iam.committee_term_auto_expiry` already exist) and no new setting key (the nine `committee.*`
  keys are in the module 08 registry; `committee.ownersOnly`, `maxTermYears`, `coOptionAllowed` and `showOnResidentApp` were
  added to the `SettingTypes` map there so they read typed).
- `registerCommittee()` (`committee.public.ts`) is called from `server.ts`, `worker.ts` and `npm run seed`, after
  `registerSocieties()`. It registers the module 05 export provider (module `members`, table `committee_terms`) and purge handler
  (order 10, newest id first, `{ deleted, anonymised: 0 }`).
- Demo seed `seeders/committee.ts` (called from `scripts/seed.ts`): Sky Heights "Managing Committee 2024–2029" ACTIVE (strength 5,
  three seats, two vacancies, ten hand-over items with H8 PENDING) and "2019–2024" HISTORICAL/ENDED; Green Park "2025–2030" ACTIVE
  (strength 3, three seats, hand-over pending). Idempotent per society and term.

## Files (`committee.*.ts`)

`constants` (enums, role map, entitlement keys, audit actions, default hand-over template), `schemas` (the Zod shapes of 7.2),
`planner` (pure functions: dates, duplicates, invariants, banner), `shared` (errors, society-time "today", settings, plan check,
data-dependent step-up, realtime), `rules` (date and strength rules that read other terms), `holders` (BR-10-7 and BR-10-8 through
module 03 `authAccess.listMemberships` and module 09 `residents.getActiveUnitLinks`), `seats` (building draft and historical
seats), `service` (create, update, delete, seat patch), `queries` (reads and the service API), `election` (`createDraftFromElection`),
`dto`, `exports`, `purge`, `ports`, `templates`, `validation`, `controller`, `routes`, `public`.

## Routes of 10.1 (7)

| Route                                      | Permission                | Entitlement                                                                                             |
| ------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /committee`                           | `settings.members.view`   | `governance.committee_terms` (read)                                                                     |
| `GET /committee/terms`                     | `settings.members.view`   | same (read)                                                                                             |
| `GET /committee/terms/:id`                 | `settings.members.view`   | same (read)                                                                                             |
| `POST /committee/terms` (Idempotency-Key)  | `settings.members.create` | `governance.committee_terms`; `governance.office_bearers` in the service for any seat other than MEMBER |
| `PATCH /committee/terms/:id`               | `settings.members.edit`   | `governance.committee_terms`; office bearers in the service when `seats` carries one                    |
| `DELETE /committee/terms/:id`              | `settings.members.delete` | `governance.committee_terms`                                                                            |
| `PATCH /committee/terms/:id/seats/:seatId` | `settings.members.edit`   | `governance.committee_terms`                                                                            |

Order on a route: society marker, permission, entitlement, validate, idempotency. `governance.office_bearers` is checked in the
service so that a MEMBER-only draft works without it (T10-31). The step-up of `PATCH /committee/terms/:id` (a changed `endDate` or
`strength` of an ACTIVE or EXPIRED term, BR-10-15) depends on the stored term, so the service calls `assertRecentAuth(ctx)`
(same rule and window as the `requireRecentAuth()` middleware) instead of a route middleware.

## Business rules implemented in 10.1

BR-10-1 (one current term, one draft; `409 COMMITTEE_DRAFT_EXISTS` with `errors[0].termId`, also on a race through the unique
index), BR-10-2 (dates, including the draft-after-current and the historical rules), BR-10-3 (strength range from the settings,
seats against strength, not below the SEATED count), BR-10-4 (unique office designations and one seat per user), BR-10-6 (the role
map constant), BR-10-7 and BR-10-8 (member state and owner or unit-link eligibility, `errors[0].seatIds`), BR-10-15 (step-up and
reason for a current term's end date or strength), BR-10-19 (`createDraftFromElection`: idempotent per election, replaces the open
draft, ELECTED holders locked in PATCH), BR-10-22 (state guard: ENDED is read-only, only DRAFT is deleted, historical terms are
created ENDED with LEFT seats and never call module 03), BR-10-23 (the EXPIRED to ACTIVE return on extension), BR-10-24 (an end
date change resets `lastReminderDays`), BR-10-30 (audit in the same transaction, no mobile stored), BR-10-31 (row lock,
`409 STALE_VERSION`, `version` bump), BR-10-32 (seat ids `max + 1` never reused, 150 limit).

## Placeholders (replace when the module is built)

`committee.ports.ts` (`setCommitteePorts`, calls recorded in `committeePortCalls`):

- **Module 14** `approvals.createHandoverDelegation`: records the call and creates nothing. Used by 10.2.
- **Module 16** `notifications.send`: the temporary `lib/notify.ts` stand-in with the template of `committee.templates.ts`
  (`committee.draft_from_election`). Module 16 replaces both.
- **Module 22** needs no port: it calls `committee.createDraftFromElection()` inside its own transaction and adds `fk_ct_election`.
  Until it exists nothing creates an ELECTION draft except tests.
- Module 23 is not used by module 10.

Also: `realtime.emit` is the `lib/realtime.ts` stand-in (event `committee.changed` to `society:<id>:admin`, payload without names).
The photo of a seat (`photoFileId`) and the mobile are read from the module 02 `users` table at request time.

## Service API (`committee.public.ts`, section 9.2)

`committee.getCurrent(societyId)`, `committee.listSeatedUserIds(societyId, designations?)`, `committee.isSeated(societyId, userId)`,
`committee.createDraftFromElection(ctx, input, t)`, `setCommitteePorts`, `registerCommittee`, and the constants `DESIGNATIONS`,
`DESIGNATION_ROLE`, `COMMITTEE_ROLE_KEYS`, `PORTFOLIOS`.

## Extension points for 10.2 and 10.3

- `committee.routes.ts`: mount the other routes of 8.7 to 8.13 on the same router (`activation-preview`, `activate`,
  `changes/preview`, `changes`, `handover` and its items, `seat-usage`) and the `/me/committee` routes in a second router.
- `committee.planner.ts`: add `revertRole`, action building and ordering, the staff seat effect, blockers and the preview hash
  (T10-01 to T10-03) and the reminder thresholds (T10-04). Already there for them: `missingOfficeBearers`, `holds`, `seatedSeats`,
  `seatInvariantProblem`, `nextSeatId`.
- `committee.service.ts`: `lockTerm(societyId, id, t)` is the row lock of BR-10-31; activation and changes lock the current term
  too (lower id first). `seatsForAudit` is the audit snapshot. `assertStored` runs the seat invariants before a write.
- `committee.holders.ts`: `membershipState` and `assertHoldersEligible` are the BR-10-7 and BR-10-8 checks to re-run at activation
  and at `ADD`; `committeePorts().approvals` is the BR-10-18 call.
- `committee.constants.ts` already lists every audit action of 9.3, the entitlement keys (`autoExpiry` for the job), the
  hand-over statuses and limits, `DEFAULT_HANDOVER_TEMPLATE` (the `committee.handoverTemplate` default) and `COMMITTEE_QUEUE`.
- `committee.schemas.ts` has `HandoverItem`; the model already carries `handoverChecklist`, `handoverCompletedAt`,
  `lastReminderDays`, `lastHandoverReminderDay`, `expiredAt`, `endedAt`, `endedBy`, `activatedAt`, `activatedBy`, `predecessorTermId`.
- `committee.templates.ts`: add the templates of section 10. `committee.public.ts`: register the jobs in `registerCommittee()`
  and add the hooks.
- Export and purge already cover the whole table, including the checklist columns.

## 10.2: activation, mid-term changes and hand-over delegations

Spec sections 3 (F04 to F08), 5 (BR-10-5 to BR-10-21), 6.3, 6.4, 8.7 to 8.9, 9.3, 9.4 and 10.

### Routes (4)

| Route                                         | Permission              | Entitlements                                         | Step-up | Idempotency-Key |
| --------------------------------------------- | ----------------------- | ---------------------------------------------------- | ------- | --------------- |
| `GET /committee/terms/:id/activation-preview` | `settings.members.edit` | `governance.committee_terms` and `...office_bearers` | no      | no              |
| `POST /committee/terms/:id/activate`          | `settings.members.edit` | same                                                 | yes     | yes             |
| `POST /committee/terms/:id/changes/preview`   | `settings.members.edit` | same                                                 | no      | no              |
| `POST /committee/terms/:id/changes`           | `settings.members.edit` | same                                                 | yes     | yes             |

Order on a route: society marker, permission, both entitlements, validate, step-up, idempotency. The two previews are a GET and a
POST; the POST is a write for the society state guard, so a suspended society gets `423 SOCIETY_SUSPENDED` on it too.

### Files

- `committee.planner.ts` (pure): `revertRole`, `buildActions` (BR-10-9, BR-10-10, BR-10-11 ordering A, B, C, D, then `seatDelta`
  ascending, then `userId`, `NONE` last), `staffSeatEffect` (BR-10-17), `canonicalJson`, `previewHash` (BR-10-13), `handoverPairs`
  (BR-10-18).
- `committee.plan.ts`: facts (module 03 `members.listForSociety`, roles, module 09 unit links), `evaluatePlan` (actions, staff
  seats from module 04 `getUsage('limit.admin_seats')`, blockers, warnings, hash), the authority rules of BR-10-14, `throwFirstBlocker`,
  `assertHash`, `runActions` (module 03 `changeRole` / `endMember` with `via: 'committee'`, in the planned order) and
  `createDelegations` (one savepoint per pair).
- `committee.activation.ts` (8.7, 8.8, section 6.3), `committee.changes.ts` (8.9, section 6.4), `committee.notify.ts`
  (after-commit sends through the module 16 port).
- `committee.holders.ts` got `holderBlockers`: the BR-10-7 and BR-10-8 checks of 10.1 as blockers (all kinds at once) for the previews.

### Behaviour worth knowing

- **Plan and blockers.** Blocker codes: `TERM_NOT_STARTED`, `OFFICE_BEARERS_REQUIRED`, `HOLDER_NOT_MEMBER`, `HOLDER_NOT_ACTIVE`,
  `HOLDER_INELIGIBLE` (each with `seatIds` and `userIds`), `ROLE_CONFLICT`, `SELF_CHANGE`, `UNHELD_PERMISSION` (with
  `permissionKeys`), `NO_FREE_SEAT`. Activation throws the first blocker in that order as the 422, 403 or 402 of section 12, then
  checks the hash, then the staff seat blocker (so `402 USAGE_LIMIT_EXCEEDED` comes after a stale hash). Warnings:
  `CUSTOM_ROLE_NOT_RESTORED`, `MEMBERSHIP_WILL_END`, `HOLDER_SUSPENDED_OUTGOING`.
- **Safe order.** Module 03 is called in the order of the sorted `actions[]`: step A (outgoing, role not chairman), B (incoming
  chairman, including a continuing holder), C (outgoing chairman), D (the rest, including a chairman who continues in a lower
  seat). The last-chairman guard (BR-03-8) is therefore true after every call. A staff role restored in step A before an incoming
  holder frees a seat in step D is judged on the net `delta`; module 03 may still refuse the intermediate call (`402`), which
  rolls everything back.
- **Authority (BR-10-14).** `ELECTION` activation: none beyond the route permission. `MANUAL` first committee (no current term):
  `settings.roles.edit` is required (`403 PERMISSION_DENIED`), no escalation check. Otherwise and for every change set: roles given to
  incoming and continuing holders must be held by the caller (`UNHELD_PERMISSION`), and the caller's own role may change only to a
  role whose permissions are a subset of the old one (`SELF_CHANGE`; ending the caller's own membership is refused). Reverts of
  outgoing holders are not checked (they restore something the person held).
- **Outgoing holders (BR-10-12).** Seated seats of the current term whose user is not in the draft; with no current term, members who
  hold a committee role and are not in the draft (the signed-in founding chairman is one of them, and is reverted or ended). A member
  who already moved to a non-committee role is left alone; an ended membership is skipped.
- **Dates (BR-10-16).** Activation: `startDate <= tookChargeOn <= today`, and not before the current term took charge; outgoing seats
  `toDate = tookChargeOn - 1 day` (never before the seat's `fromDate`), `actualEndDate` likewise. Changes: `tookChargeOn (or startDate)
<= effectiveDate <= today`, and not before the seat's `fromDate`.
- **Redesignate (BR-10-21).** New seat id `S<max + 1>`; the new seat copies the holder, flat, join mode, portfolios, public email and
  `roleBeforeKey`. In place when the effective date equals the seat's `fromDate`.
- **Hand-over delegations (BR-10-18).** `createHandoverDelegation` of the module 14 placeholder, one savepoint per pair. The five
  module 14 refusal codes skip the pair (`summary.handoverDelegationsSkipped[{designation, fromUserId, toUserId, skippedBecause}]`
  and the audit row); any other error aborts the whole transaction. Window: `committee.handoverDelegationDays` (default 30).
- **Hand-over checklist.** Activation builds `handoverChecklist` from the `committee.handoverTemplate` setting (10 items, `H1`...).
  The checklist routes are 10.3.
- **Audit** (same transaction): `committee.term.activated` and `committee.term.ended` (activation); `committee.seat.added`,
  `committee.seat.redesignated`, `committee.seat.vacated` per change and `committee.term.changed` (changes). Keys avoid names the
  redaction masks (`skippedBecause`, not `code`). **Realtime** `committee.changed` with reason `ACTIVATED` or `CHANGED`.
- **Notifications** after commit through the port: `committee.term_activated` (incoming and outgoing holders),
  `committee.new_committee_announced` (module 09 audience `ALL`, unless `announceToResidents` is false), `committee.seat_assigned`
  (a change that gave a seat without a role change). Their templates are registered for the module 01 stand-in (EMAIL for
  `term_activated`; the push-only ones render a link and send nothing until module 16 exists).

### Placeholders in 10.2

`approvals.createHandoverDelegation` (module 14): the placeholder records the call in `committeePortCalls` and returns `{ id: 0 }`.
`notifications.send` (module 16): `lib/notify.ts`. Nothing else is new.

### Extension points for 10.3

`lockTerm`, `seatsForAudit`, `emitChanged` and `announce` (`committee.notify.ts`) are reusable; `committee.public.ts` is where 10.3
registers its jobs and adds its hooks. `activate` writes `handoverChecklist` with the `H<n>` ids that the checklist routes expect;
10.3 owns `handoverCompletedAt`, `lastReminderDays` (activation does not touch it) and the seat `flags`.

## 10.3: hand-over checklist, jobs, seat reconciliation, seat usage and the resident pages

Spec sections 3 (F09, F10, F11, F14 to F17, F19), 5 (BR-10-23 to BR-10-29), 8.10 to 8.13, 9.1, 9.3, 9.4 and 10. No new table,
no migration, no new env variable and no new permission key. One small edit outside the module: `committee.reminderDays`
(already in the module 08 registry) was added to the `SettingTypes` map so that it reads typed.

### Routes (6)

| Route                                               | Permission                                        | Entitlement                         | Idempotency-Key |
| --------------------------------------------------- | ------------------------------------------------- | ----------------------------------- | --------------- |
| `GET /committee/terms/:id/handover`                 | `settings.members.view`                           | `governance.committee_terms` (read) | no              |
| `POST /committee/terms/:id/handover/items`          | `settings.members.edit`                           | `governance.committee_terms`        | yes             |
| `PATCH /committee/terms/:id/handover/items/:itemId` | `settings.members.view` + BR-10-27 in the service | `governance.committee_terms`        | no              |
| `GET /committee/seat-usage`                         | `settings.members.view`                           | none                                | no              |
| `GET /me/committee`                                 | `resident.home.view`                              | `governance.committee_terms` (read) | no              |
| `GET /me/committee/history`                         | `resident.home.view`                              | `governance.committee_terms` (read) | no              |

### Files

`committee.handover.ts` (8.10: view, add, update; the checklist is the term's `handoverChecklist` JSON), `committee.jobs.ts` (the
three jobs and their per-society steps `autoExpireFor`, `sendRemindersFor`, `reconcileSeatsFor`), `committee.staff.ts` (8.11),
`committee.resident.ts` (8.12 and 8.13). `committee.planner.ts` got the pure `reminderThreshold`, `handoverReminderDay`, `seatFlags`
and `sameFlags`; `committee.notify.ts` got `officerIds`, `formatYmd` and `sendNow` (jobs have no transaction to wait for);
`committee.templates.ts` the four templates of section 10 that 10.1 and 10.2 did not need; `committee.ports.ts` the files port.

### Behaviour worth knowing

- **Checklist (BR-10-26, BR-10-27).** Only an ACTIVE or EXPIRED term accepts changes (`409 INVALID_STATE` otherwise, also for add).
  An update locks the term row, never bumps `version` and sets `updatedByUserId` and `updatedAt` on the item. `handoverCompletedAt`
  is set when every item is DONE or NOT_APPLICABLE (one `committee.handover.completed` audit row on the flip), cleared when one goes back
  to PENDING or an item is added. NOT_APPLICABLE needs a note of 5 to 300 characters (`400 VALIDATION_FAILED`). Order of checks on
  the PATCH: term (404), item (404 `HANDOVER_ITEM_NOT_FOUND`), BR-10-27 (403: `settings.members.edit`, or the SEATED holder of the item's
  `ownerDesignation`), state (409), note, files (422 `FILE_NOT_LINKABLE`). `canEdit` in the GET is that rule and is false on a
  DRAFT or ENDED term. `ownerName` is the seated holder of the owner designation (null if nobody sits there).
- **Evidence files.** Full replacement; only ids that are new on the item go to the port. Placeholder: see below.
- **Reminders (`members:term-reminders`, 09:00).** For the current term: `reminderThreshold` picks the smallest threshold `d` of
  `committee.reminderDays` (plus 0 once `endDate < today`) with `daysLeft <= d` and `lastReminderDays` NULL or `> d`; the guarded
  `UPDATE ... WHERE lastReminderDays IS NULL OR lastReminderDays > d` decides who notifies (affected rows = 1), so a second run, a retry or
  two workers send nothing twice. `committee.term_expiring` (data `daysLeft`, `endDate` as `DD MMM YYYY`) and `committee.term_expired`
  (threshold 0, every plan) go to the officers (seated Chairman and Secretary plus `usersWithPermission('settings.members.edit')`). The same job sends
  `committee.handover_pending` on day 15 and 30 after `tookChargeOn` while `handoverCompletedAt` is NULL and an item is PENDING (guarded by
  `lastHandoverReminderDay < day`), to the seated holders of the pending items' owner designations and the officers. These two
  notification kinds write no audit row (section 9.3 lists no action for them).
- **Auto-expiry (`members:term-auto-expiry`, 00:15).** Only when `iam.committee_term_auto_expiry` is on (Standard and above):
  `UPDATE ... SET status = 'EXPIRED', expiredAt, version = version + 1 WHERE status = 'ACTIVE' AND endDate < today`; audit
  `committee.term.expired` (actor `system`) and `committee.changed` (reason `EXPIRED`) only when one row changed. The `version` bump is
  an addition to section 9.1 so that an admin who opened the term before the job gets `409 STALE_VERSION` instead of editing a stale
  status. Roles and seats stay. A Starter term stays ACTIVE and shows `isOverdue` and the CARETAKER banner from the dates (module 10.1).
- **Reconcile (`members:reconcile-seats`, 02:00).** Per SEATED seat of the current term (BR-10-25): no ACTIVE or SUSPENDED membership ->
  `LEFT`, `MEMBERSHIP_ENDED`, `toDate = today`, flags cleared (no module 03 call); SUSPENDED -> `MEMBERSHIP_SUSPENDED`; role other than
  `DESIGNATION_ROLE[designation]` -> `ROLE_MISMATCH`; `ownersOnly` and no active OWNER link -> `NOT_OWNER`. Rewrites the term under its row
  lock only when something changed (`version + 1`, audit `committee.seat.vacated` and `committee.seat.flagged`, actor `system`, realtime
  reason `CHANGED`). `committee.seat_needs_attention` goes to the officers only when a seat was closed or a flag was newly set or changed to a
  non-empty set; clearing a flag is silent. Flags never touch roles.
- **Scheduling.** `registerCommitteeJobs()` (called by `registerCommittee()`, so `server.ts`, `worker.ts` and the seed script have it) registers queue
  `members` (concurrency 2), three processors and three `dailyAtIst` repeatables (`00:15`, `02:00`, `09:00`). The processors loop over the societies
  whose status allows ordinary jobs (`isJobAllowed(status, 'normal')`, not CLOSED), like module 09; one society failing is logged and skipped. There
  is no `core:dispatch-society-jobs` dispatcher in this code base, and every society is IST for the schedule.
- **Seat meter (8.11).** `used` is the count of ACTIVE or SUSPENDED memberships whose role has `consumesSeat` (module 03 `members.listForSociety`), `limit` is
  module 04 `getLimit('limit.admin_seats')`. `pendingStaffInvitations` counts PENDING, unexpired invitations to seat-consuming staff roles. The
  response also carries `staffRoles` (invite presets, F15) and `staff` (the table of the Staff and admins tab); both are additions to the spec shape.
- **Resident pages (8.12, 8.13).** Seats of the current term in designation order (members by name); a MEMBER with `showOnResidentPage = false` is
  hidden, the vacancies count the hidden seat as occupied. Mobile masked unless `residents.contacts.view` or the viewer's own. `visible: false` when
  `committee.showOnResidentApp` is off (history then returns an empty list). History: ENDED terms (including historical), by `endDate` descending,
  office bearers (not MEMBER) with all their seats, so a redesignation shows both rows.

### Placeholders in 10.3

- Module 01 `files.service.link(ctx, fileIds, 'committee_term', termId, 'HANDOVER_EVIDENCE')`: `committeePorts().files.linkEvidence`. The placeholder
  accepts a CLEAN file of the society with purpose `HANDOVER_EVIDENCE` from the memory store `placeholderFiles` (module 05) and links nothing; module
  01 must also let `settings.members.view` holders of the society download these PRIVATE files (7.5).
- Module 16: the `lib/notify.ts` stand-in. `committee.term_expiring` (EMAIL and PUSH), `committee.term_expired` (EMAIL), `committee.handover_pending`
  and `committee.seat_needs_attention` (in-app in the spec; declared PUSH here, so they render a link and send nothing) have templates in
  `committee.templates.ts`. In-app delivery, and the push for the two resident-facing ones, wait for module 16.
- Module 14 and 22 ports: unchanged from 10.1 and 10.2.

### Demo seed

Green Park CHS now has "Managing Committee 2025–2026" (ACTIVE, strength 3) with the end date 24 days after the seed day (TERM_ENDING banner), a
half-done checklist (H1 to H5 DONE, H7 NOT_APPLICABLE, four PENDING) and an attention flag `MEMBERSHIP_SUSPENDED` on the treasurer's seat (a stored flag; the
reconcile job recomputes it from module 03, so it vanishes after the next run). A term seeded by 10.1 ("2025–2030", untouched) is tuned to this once.
Sky Heights is unchanged (all done except H8).
