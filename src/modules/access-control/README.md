# Module 03: Roles and permissions (backend)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/03_Roles_and_Permissions.md`.

## What it owns

- Tables: `permissions`, `roles`, `role_permissions`, `society_members`, `member_grants`, `invitations`, plus the tenant roots
  `organizations` and `societies` (module 01 7.1 and 7.2, core columns only) and `idempotency_keys` (module 01 7.4), added here
  because module 01 was structure only. Migration `20261102000500` adds `fk_users_platform_role`.
  `societies.logoFileId` has no foreign key until the `files` table exists. `member_grants.activeSlot` is a VIRTUAL generated
  column (MySQL refuses ON DELETE CASCADE on base columns of a STORED one).
- Routes: `access-control.routes.ts` (section 8). Every route carries a marker (`societyMiddleware` + `requirePermission`,
  `platformMiddleware` + `requirePlatformPermission`, `publicRoute`, `authenticatedOnly`); `access-control.registry.ts`
  (`listRoutes(app)`) reads them for `route-registry`, `permission-matrix` and `tenant-isolation` tests.
- Middlewares (`src/middlewares/`): `society.middleware.ts`, `permission.middleware.ts`, `idempotency.middleware.ts`.
- Service API for other modules: `access-control.public.ts` (`authAccess`, `computeAccess`, `provisionSocietyRoles`,
  `createInitialMember`, `createInvitation`, `cancelAllPendingInvitations`, `endAllMembersForSociety`, `ensureResidentMember`,
  `setResidentRole`, `endResidentMember`, `endMember`, `changeRole`, `members.listForSociety`, `roles.getPermissionKeys`,
  `usersWithPermission`, `invalidateMember`, `invalidateSociety`, `revokeHouseholdGrants`, policies).
- Start-up: `registerAccessControl()` (called by `server.ts`, `worker.ts`) calls `setAuthPorts({ authAccess })` for module 02 and
  registers the jobs. Seeders: `seeders/demo-societies.ts`, `seeders/access-control.ts`; `npm run seed` runs them.
- Jobs (queue `access-control`): `expire-invitations` (15 min), `expire-grants` (5 min), `grant-expiry-reminder` (hourly),
  `sync-catalogue` (seeder step; also callable as a job).

## Placeholders other modules replace (`access-control.ports.ts`, `setAccessPorts`)

| Port                                                                          | Owner                   | Placeholder behaviour                                                        |
| ----------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| `entitlements.consumeLimit / releaseLimit / getLimit / planKeyFor`            | module 04 (done)        | replaced by `registerSubscriptions()`; tests of 02/03 keep the placeholder   |
| `support.getActiveGrant`                                                      | module 05               | returns null                                                                 |
| `residents.getActiveUnitLinks / onResidentInvitationAccepted / getUnitLabels` | modules 08, 09          | no links                                                                     |
| `approvals.onMemberEnded`                                                     | module 14               | no-op                                                                        |
| `files.storeExport`                                                           | module 01 files service | memory store, downloaded from `GET /api/v1/dev/exports/:id` (non-production) |

`getHouseholdControl` is derived from `getActiveUnitLinks` (caller OWNER or TENANT and target FAMILY on the same unit).
Module 02's `AuthPorts` are untouched except `authAccess`. Notifications use `lib/notify.ts` (templates in
`access-control.templates.ts`); in-app and push channels are not sent by that stand-in.

## Notes

- Permission cache: `acl:role|member|society|platform-role` keys through `lib/kv.ts` (Redis when `REDIS_URL` is set, memory
  otherwise; the memory one is tested, the Redis one is written but not run against a real Redis). A store error falls back to the
  database; grant windows are checked against the clock on every request.
- BR-03-8 uses locking reads (`FOR UPDATE OF m`) on the chairman rows first in every member change, so parallel demotions
  serialise (test T03-15).
- Seats: `consumeLimit` and `releaseLimit` are called on every path in BR-03-33; the default placeholder does not count.
- `PLATFORM_TEAM_EMAIL_DOMAIN` (default `societyapp.in`) is the new env variable.
