# Module 15 · Helpdesk and building issues (backend, folder `helpdesk`)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/15_Helpdesk_Building_Issues.md`. This README is the contract between the
**foundation** (15.0, this commit series) and the **four parts** that fill the module in parallel worktrees (15.1 to 15.4).
Built on top of module 14 (the real approvals engine); module 15 itself does not use approvals.

## What the foundation provides (do not rebuild it)

| Area       | File                                                                                                                                                   | Contents                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tables     | `migrations/20261120000100 … 000700`                                                                                                                   | `sla_policies`, `ticket_categories`, `escalation_rules`, `tickets`, `ticket_assignments` (adds the FK `tickets.currentAssignmentId`), `ticket_comments`, `ticket_upvotes` with every CHECK, generated column and index of 7.1 to 7.7. Never edit; add a migration. |
| Models     | `src/models/{sla-policy,ticket-category,escalation-rule,ticket,ticket-comment,ticket-upvote,ticket-assignment}.model.ts`                               | registered in `models/index.ts` with the 7.x associations. Generated columns are not mapped. `EscalationRule` and `TicketComment` are paranoid.                                                                                                                    |
| Constants  | `helpdesk.constants.ts`                                                                                                                                | `PERM`, `ENT`, `SETTING`, `ENTITY`, `JOBS`, every enum, `LIMITS`, `ACTIONS`, `AUDIT`, `RT` + rooms, `NOTIFY`, `ERR` (all section 12 codes)                                                                                                                         |
| Types      | `helpdesk.types.ts`                                                                                                                                    | `CreateTicketInput`, `CreatedTicket`, `TransitionInput`, `Actor`, `AssigneeInput`, `EffectiveCategory`, `BusinessCalendar`, `SlaSnapshot`                                                                                                                          |
| State      | `helpdesk.state.ts`                                                                                                                                    | PURE transition table 6.2: `TRANSITIONS`, `allowedActions(facts, caller)`, `resolveTransition`, `assertTransition` (409 `TICKET_INVALID_TRANSITION` with `errors[]` listing allowed actions)                                                                       |
| SLA        | `helpdesk.sla.ts`                                                                                                                                      | PURE calendar maths: `addBusinessMinutes`, `addMinutes`, `calendarMinutesBetween`, `slaDue`, `pauseMinutes`, `slaState`, `nextSlaCheck`, `escalationFireTime`; DB: `policyFor`, `snapshotFor`, `liveBusinessCalendar`                                              |
| Rules      | `helpdesk.rules.ts`                                                                                                                                    | PURE: `deriveAffectedLevel`, `allowedLevel`, `effectivePriority`, `defaultTitle`, `mergeCategory`, `reporterLabel`, `reporterRoleFor`                                                                                                                              |
| Routing    | `helpdesk.routing.ts`                                                                                                                                  | `pickLeastLoaded` (pure, BR-15-37), `autoAssign`, `validateAssignee` (BR-15-35), `assignTicket`, `unassignTicket`, `endCurrentAssignment`                                                                                                                          |
| Core       | `helpdesk.tickets.core.ts`, `helpdesk.tickets.transition.ts`, `helpdesk.tickets.merge.ts`, `helpdesk.tickets.upvote.ts`, `helpdesk.tickets.comment.ts` | `createTicket`, `transitionTicket`, `mergeTickets`, `addUpvote`, `removeUpvote`, `addComment`, `addTimeline` (see below)                                                                                                                                           |
| Duplicates | `helpdesk.duplicates.ts`                                                                                                                               | `findSimilarBuilding` (BR-15-17), `similarPersonalIds` (BR-15-19), `recurringCheck` (BR-15-16)                                                                                                                                                                     |
| Visibility | `helpdesk.visibility.ts`                                                                                                                               | `residentVisibleWhere(ctx)` (BR-15-50), `residentCanSee`, `visibleComments(ctx, ticket, audience)` (BR-15-51), `workVisibleWhere` (BR-15-53)                                                                                                                       |
| Escalation | `helpdesk.escalation.ts`                                                                                                                               | `evaluateTicketSla(ticketId, at)` used by the sweep (BR-15-59 to 61), `resolveTargets`, `fireResidentRequest`                                                                                                                                                      |
| Seed       | `helpdesk.seed.ts`, `seeders/helpdesk.ts`                                                                                                              | `ensureSeeded(societyId, t?)` (7.8; idempotent by name; lazy through `ensureSeededOnce`), `HELPDESK_SEEDERS`                                                                                                                                                       |
| Ports      | `helpdesk.ports.ts`                                                                                                                                    | `helpdeskPorts()` (notifications, staffDirectory 20, vendors 21, workOrders 21, gateConsole 27, reportsCache 24, files 01), `setHelpdeskPorts`, `helpdeskPortCalls`                                                                                                |
| Public     | `helpdesk.public.ts`                                                                                                                                   | 8.29 `helpdeskHooks`, 8.30 `helpdeskWork`, 8.31 `helpdeskReports`, `tickets`, `helpdesk.ensureSeeded`; `registerHelpdesk()`                                                                                                                                        |
| Wiring     | `registerHelpdesk()` in `server.ts`, `worker.ts`, `scripts/seed.ts`                                                                                    | production port guard, export provider, purge handler (order 150), queue `helpdesk`, `helpdesk.jobs.ts`, unit guard                                                                                                                                                |
| Exports    | `helpdesk.exports.ts`, `helpdesk.purge.ts`                                                                                                             | module 05 contract for the 7 tables                                                                                                                                                                                                                                |
| Tests      | `tests/modules/helpdesk/`, `tests/helpers/helpdesk.ts`                                                                                                 | state, SLA, rules, routing, visibility, duplicates, create/transition/merge/upvote/comment, escalation, ports, migrations                                                                                                                                          |

Settings (7.9), permissions (section 2) and entitlements already exist in modules 08, 03 and 04. Number series `TICKET` (`TKT`) exists in module 01.

## Core API (call these; never write ticket status, SLA columns, assignments or upvote counts yourself)

All write functions run in the caller's transaction `t` and take the ticket under `SELECT ... FOR UPDATE` themselves (BR-15-34); they compare `version` when
`input.version` is given (`409 STALE_VERSION`) and increment it. A context without `ctx.user` is a SYSTEM actor. Every write adds the timeline row
(`ticket_comments`, kinds STATUS_CHANGE, ASSIGNMENT, PRIORITY_CHANGE, MERGE, ESCALATION, ESTIMATE, RATING, SYSTEM), the audit row of 9.3, and queues the
after-commit realtime events (9.4) through `t.afterCommit`; notification sending after commit is the job of 15.4 (`helpdesk.notify.ts`, which the core calls through
the `emitAfterCommit` hook list: parts push their listener with `onTicketEvent(fn)`).

- `createTicket(ctx, input, t)`: BR-15-1 to BR-15-18: number from `nextNumber(societyId, 'TICKET')`, kind rules, level and affected count, category and priority,
  SLA snapshot and due times, files link, `STATUS_CHANGE` none to OPEN, duplicate check (`SIMILAR_ISSUE_EXISTS` unless `duplicateReason`), dispute invoice flag,
  recurring tag, auto-assignment (never fails the create), audit. Returns `CreatedTicket`. Does NOT check the daily rate limit (BR-15-14, part 15.3 with the route),
  idempotency or permissions (routes).
- `transitionTicket(ctx, ticketId, actor, input, t)`: every row of 6.2 except assign/unassign/merge: START, WAIT_ON_RESIDENT, RESUME, RESOLVE (after photo rule,
  chargeable rules BR-15-55, invoice through module 11), CLOSE, REOPEN (window, limit, new SLA cycle, keep or auto-assign assignee, dispute flag), CANCEL (assignment
  ends, dispute flag cleared, work order cancelled). Pause and resume of the SLA clock, `firstResponseAt`, `nextSlaCheckAt`.
- `assignTicket(ctx, ticketId, actor, assignee, t)` / `unassignTicket(...)`: BR-15-35, BR-15-36 (assignment rows, `currentAssignmentId`, denormalised assignee).
- `mergeTickets(ctx, duplicateId, intoTicketId, actor, input, t)`: BR-15-21, BR-15-22.
- `addUpvote` / `removeUpvote(ctx, ticketId, t)`: BR-15-20 and BR-15-38 (priority raise).
- `addComment(ctx, ticketId, actor, input, t)`: BR-15-52 to 54 (public or internal, files, first response, automatic resume of WAITING_ON_RESIDENT BR-15-43);
  `removeComment` soft delete (15.2 owns the route).
- `evaluateTicketSla(ticketId, at)`: BR-15-30, BR-15-59, BR-15-60: sets breach flags, writes unique ESCALATION rows, sets `escalationLevel`, sets `nextSlaCheckAt`;
  returns the fired rules so the job can notify.
- `fireResidentRequest(ctx, ticketId, t)` (BR-15-58) and `fireLowCsat(...)` for the RESIDENT_REQUEST and LOW_CSAT rules.
- Pure helpers (state, SLA, rules, visibility `where`) are tested without a database; the same files hold the DB wrappers.

## Rules for every part

- Files only with your prefix (below). Foundation files are `helpdesk.{constants,types,ports,shared,state,sla,rules,routing,duplicates,visibility,escalation,seed,tickets.*,exports,purge,jobs,public,settings}.ts`.
- Shared files you may touch with **additive lines only**: `src/app.ts` (one `api.use(...)` mount line of your routes), this README (tick your part), `seeders/helpdesk.ts`
  (one entry in `HELPDESK_SEEDERS`), `helpdesk.public.ts` (replace the body of the stubs you own; keep the signature), `helpdesk.jobs.ts` (one `register...Jobs()` call line),
  the tenant-isolation and permission-matrix lists in `tests/`, `tests/helpers/helpdesk.ts` (additive helpers), the allow-list of module 05 for suspended societies (15.3, BR-15-66).
- Routes go through `routeMeta`, `requirePermission`, `requireFeature` (`ENT.*`, `mode: 'read'` on GET), `validate` (strict Zod), `idempotency` for create routes.
- Times from `lib/clock`; notify only after commit; audit in the same transaction; services take `ctx` and never `req`/`res`. No migration unless a column is missing (new file after the latest).
- Tests in `tests/modules/helpdesk/<prefix>.*.test.ts`; use `setHelpdeskPorts()` and `helpdeskPortCalls`; tests run on your own pool database only.
- Description of a personal complaint never goes into audit rows or building-wide messages (only its length).

## The four parts

### 15.1 setup (prefix `helpdesk.setup`, `helpdesk.categories`, `helpdesk.policies`, `helpdesk.rules.admin`) [DONE: routes in `helpdesk.setup.routes.ts`, also `GET /gate|/work/ticket-categories`]

Spec 8.1 to 8.6, BR-15-62 to BR-15-65, 7.8, US config stories. Routes: `GET|POST /ticket-categories`, `PATCH /ticket-categories/:id`, `POST …/archive|restore`,
`GET /me/ticket-categories`, `GET|POST /sla-policies`, `PATCH /sla-policies/:id`, `POST …/archive`, `GET|POST /escalation-rules`, `PATCH|DELETE /escalation-rules/:id`,
`GET|PATCH /helpdesk/settings` (through module 08 `settings.setMany`).

- Writes: `ticket_categories`, `sla_policies`, `escalation_rules` (and their audit `helpdesk.category.*`, `helpdesk.sla_policy.*`, `helpdesk.escalation_rule.*`).
- Calls: `ensureSeeded` (first read or write; `ensureSeededOnce(societyId)`), `validateAssignee`-style checks of BR-15-35 for default assignees (`validateDefaultAssignee` in `helpdesk.routing.ts`).
- Replaces nothing in `helpdesk.public.ts`.

### 15.2 admin tickets (prefix `helpdesk.admin`) - DONE

Spec 8.7 to 8.9, 8.12 to 8.21. Routes: `GET /tickets`, `GET /tickets/stats|export|assignees`, `GET /tickets/:id`, `POST /tickets` (on behalf), `PATCH /tickets/:id`,
`POST /tickets/:id/assign|unassign|transition|merge|estimate`, `GET|POST /tickets/:id/comments`, `DELETE /tickets/:id/comments/:commentId`, `GET /tickets/:id/files/:fileId/download-url`.

- Writes: tickets through the core only (`createTicket` with channel PHONE/WALK_IN, `transitionTicket`, `assignTicket`, `unassignTicket`, `mergeTickets`, `addComment`); the PATCH of fields
  (title, description, priority with BR-15-29 recompute through `recomputeSla`, category, level, `isChargeable` before an estimate) and `sendEstimate` (BR-15-55) live in this part.
- Owns: `TicketDto` mapper (`allowedActions` from `allowedActions()`, masked mobile), CSV export (no internal notes, 20,000 row cap, `helpdesk.tickets.exported`), `helpdeskReports.*` (8.31) and `helpdeskWork.*` (8.30) bodies, `tickets.createInternal|get|getFacts`.
- Stubs it replaces in `helpdesk.public.ts`: `helpdeskReports.*`, `helpdeskWork.*`, `tickets.createInternal`, `helpdeskHooks.*` (8.29, calls `transitionTicket` as system and `endCurrentAssignment`).

### 15.3 resident and building issues (prefix `helpdesk.me`, `helpdesk.building`, `helpdesk.resident`) [DONE]

Spec 8.10, 8.11, 8.22 to 8.28, BR-15-14, BR-15-46 to 52, BR-15-66. Routes: `/me/tickets*`, `/me/building-issues*` (list, similar, qr), `POST /building-issues`, `GET /building-issues/similar`,
`POST|GET /gate/building-issues*`, `POST|GET /work/building-issues*`, `/me/tickets/:id/upvote|comments|confirm|rating|reopen|cancel|escalate|estimate-decision|files/:fileId/download-url`, `/me/helpdesk/transparency`.

- Writes: tickets through the core (`createTicket` with `reporterRole`/`channel`, `addUpvote`, `removeUpvote`, `addComment` with a resident actor, `transitionTicket` for CLOSE/REOPEN/CANCEL by residents),
  rating (BR-15-56: `ticket_upvotes.csat*` and `tickets.csat*`, recompute `csatAvgTenths`, call `fireLowCsat`), estimate decision (BR-15-55: `chargeStatus`, resumes IN_PROGRESS), resident escalation (`fireResidentRequest`).
- Owns the `ResidentTicketDto` mapper, `similar` endpoints (`findSimilarBuilding`), the daily limit and broadcast limit, QR prefill, the module 05 allow-list entries of BR-15-66 and the `423 SOCIETY_SUSPENDED` rule for personal tickets on shared routes.

### 15.4 jobs, realtime and notifications (prefix `helpdesk.jobs`, `helpdesk.notify`, `helpdesk.fanout`, `helpdesk.realtime`) [done]

Spec 9, 10, 6.4. Jobs of queue `helpdesk` registered from `helpdesk.jobs.ts`: `sla-sweep` (every minute, calls `evaluateTicketSla`), `auto-close`, `waiting-followup`, `unassigned-reminder`,
`fanout` (tag `safety`), `escalation-notify`, `daily-digest`, `seed`.

- Writes: tickets only through `transitionTicket` (system actor: auto-close, auto-resolve, estimate expiry), `ticket_comments` SYSTEM rows through `addTimeline`.
- Owns: all `registerTemplates({...})` of section 10 (`helpdesk.notify.ts`), the after-commit listener (`onTicketEvent`) that enqueues notifications and fan-out, the debounced `helpdesk.counts.changed`, the gate alert (BR-15-48, `gateConsole` port).
- Uses the foundation's realtime emit helpers (`emitTicketChanged`) which already emit the 9.4 admin / unit / user events from `t.afterCommit`.

## Foundation shortcuts the parts must know

- Business-hours calendar uses module 08 `holidays.isWorkingDay`, `office.openTime`, `office.closeTime` (Asia/Kolkata only, as everywhere in the code base).
- `helpdeskPorts().files` is the placeholder over the memory file store (purpose `TICKET_PHOTO`); module 01 replaces it.
- Module 21 hooks and `staffDirectory`/`vendors` are placeholders that find nothing: `STAFF` and `VENDOR` assignees are unreachable until those modules exist (tests inject fakes with `setHelpdeskPorts`).
- Plan checks in the core use `isFeatureOn` (BR-15-24 calendar, BR-15-37 auto assignment, BR-15-38 upvote raise, BR-15-39 after photo, BR-15-16 recurring, BR-15-54 internal notes, BR-15-55 chargeable); routes check their own entitlement.

## Notes from the foundation tests

- Every transaction of the core also reads through a second pool connection (settings, units, entitlements, members), so tests that run many writes in parallel
  must stay below the pool size (20): `T15-30` runs 20 upvoters 8 at a time.
- A building issue is visible society-wide on Standard and Premium (`helpdesk.public_community_issue_board`); on Starter only residents it affects, its requester
  and its upvoters see it (`residentVisibleWhere`).
- The sweep sets `responseBreached` / `resolutionBreached` when the due time is REACHED (`now >= due`), the settling transitions when the ticket is settled
  AFTER the due time (`now > due`).
- Tests build a world with `helpdeskWorld(plan)` (`tests/helpers/helpdesk.ts`): chairman, facility manager, a resident of A-101, towers A and B with their
  location nodes, seeded catalogue. Creating a world takes about 10 seconds (it signs in and creates buildings through the API); keep one world per test.
