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
