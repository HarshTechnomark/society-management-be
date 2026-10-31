# Module 02: Authentication (backend)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/02_Authentication.md`.

## What it owns

- Tables: `users`, `sessions`, `auth_otps`, `auth_tokens`, `user_recovery_codes`, `user_passkeys`, `auth_lockouts`
  (plus `audit_logs` from module 01 section 7.6, added on this branch because module 01 was structure only).
- Routes: `/api/v1/auth/*` (`auth.routes.ts`) and `/api/v1/me/security/*` (`meSecurityRoutes`). Public routes are listed in
  `public.routes.ts`; everything else passes `authMiddleware`.
- Middleware (in `src/middlewares/`): `appContext`, `csrf`, `auth`, `recentAuth` (`requireRecentAuth()`), `rateLimit`.
- Service functions for other modules: `auth.public.ts` (`users`, `sessions`, `auth`, `setAuthPorts`).
- Jobs (queue `auth`): `auth.jobs.ts` (`registerAuthJobs()`), started by `server.ts` (no Redis) or `worker.ts` (Redis).
- Seeders: `seeders/system-user.ts` (all environments), `seeders/demo-users.ts` (not production); `npm run seed`.

## Placeholders other modules replace

`auth.ports.ts` holds default stubs for module 03 (`authAccess`: memberships, app access, MFA requirement, permissions,
platform permissions, deletion blockers), 04 (`entitlements`), 05 (`supportAccess`), 07 (`getPlatformSetting`), 08
(`societySettings`), 09 (`residentsHooks`), 16 (`communicationHooks`), 25 (`residentApp`) and the module 01 files service
(`files.linkUserPhoto`). The owner calls `setAuthPorts({...})` at start-up. `lib/notify.ts` and `lib/realtime.ts` are stand-ins
for module 16 and the Socket.IO server.

## Redis and the in-process fallback

`lib/kv.ts` (rate-limit windows, dev inbox) and `lib/queue.ts` (jobs) each have a Redis implementation (used when `REDIS_URL`
is set) and a memory implementation (development and tests). The memory ones are tested; the Redis ones were written but not
run against a real Redis in this build.

## How to test

`npm test` (uses `.env.test` and the `societyapp_test` database; run `npm run migrate` against it first). Tests are in
`tests/modules/auth/`, `tests/lib/` and `tests/*.test.ts`. Time is frozen with `setNow()` from `src/lib/clock.ts`.
