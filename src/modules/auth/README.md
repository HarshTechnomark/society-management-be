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

## Single sign-in address

An origin in `APP_ORIGINS` whose first host label is **not** a role label (`platform`, `admin`, `my`, `gate`, `work`) is the single sign-in address
(`isUnifiedOrigin` in `auth.apps.ts`). Everybody signs in there and the app is decided **after the first factor**, not from the host. The per-role
hosts keep working exactly as before (BR-02-43), so both can be configured together.

- **Sign-in:** a mobile number signs in with a one-time code, an email with its password (passkeys unchanged). `POST /auth/otp/send`, `/otp/verify`,
  `/password/login` and `/passkey/*` accept the request with no app. `completeFirstFactor` (`auth.signin.ts`) then lists the apps the person may open with
  that first factor (`candidateAppsFor`): the apps they have access to whose `APP_RULES` allow the factor (a platform account never signs in by OTP, a
  resident has no password). Everybody can be a resident, so the resident app is offered next to a real role only when the person has a resident link.
- **One app:** the second step (`MFA_REQUIRED` or `MFA_ENROLL_REQUIRED`) or the session follows as before; the challenge and the session carry the app.
- **More than one app:** the answer is `APP_CHOICE_REQUIRED` with the apps and a single-use challenge; the client calls `POST /auth/app/choose`
  `{ challengeToken, app }`, and the sign-in continues for that app. No session exists before the choice.
- **Errors:** `LOGIN_METHOD_NOT_ALLOWED` when the person has access but not with this first factor, `NO_ACCESS_FOR_APP` when they have none, `APP_NOT_ALLOWED` for a
  choice that was not offered.
- **After sign-in:** `authMiddleware` takes `ctx.clientApp` from the session (the access token names the app and must agree with it), so every
  module sees the same `clientApp` as on a per-role host. Idle and absolute timeouts are the app's own.
- **Switching app:** `POST /auth/switch-app` `{ app }` opens another app the person has access to with a new session that keeps the first factor,
  the second step and the sign-in time; the old session ends. An app whose rules do not allow the session's first factor refuses it (an OTP sign-in
  never opens the platform). Support sessions cannot switch.
- **Links in messages** (`appUrl`, `appHost`) use the app's own host when one is configured, else the single sign-in address.
- **Limitation:** one browser holds one session per address, so a platform admin who starts a support hand-off from the platform replaces their
  platform session in that browser when the hand-off opens on the same address. Keep a per-role admin host configured if both must stay open.
