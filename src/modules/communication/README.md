# Module 16 · Notices, communication and emergency (backend, folder `communication`)

Spec: `Society_Management_Build_Modules/Markdown_for_AI/16_Notices_Communication_Emergency.md`. This README is the contract between the
**foundation** (16.0, this commit series) and the **four parts** that fill the module in parallel worktrees (16.1 to 16.4).
Built on top of module 15. Module 16 is also the REAL notification service: it replaces the stand-in `src/lib/notify.ts` engine
(see "The notify swap-in").

## What the foundation provides (do not rebuild it)

| Area      | File                                                                                                                                                                                                                | Contents                                                                                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tables    | `migrations/20261121000100 … 001200`                                                                                                                                                                                | `notices`, `notice_receipts`, `notification_templates`, `notifications`, `inbox_items`, `notification_preferences`, `push_subscriptions`, `emergency_broadcasts`, `emergency_responses`, `surveys`, `survey_questions`, `survey_responses` (7.1 to 7.12, every CHECK, generated column and index). Never edit; add a migration. |
| Models    | `src/models/{notice,notice-receipt,notification-template,notification,inbox-item,notification-preference,push-subscription,emergency-broadcast,emergency-response,survey,survey-question,survey-response}.model.ts` | registered in `models/index.ts` with the 7.x associations. Generated columns (`activeKey`, `latestKey`, `answerKey`) are not mapped. `Notice` and `Survey` are paranoid.                                                                                                                                                        |
| Constants | `communication.constants.ts`                                                                                                                                                                                        | `PERM`, `ENT`, `LIMIT`, `SETTING`, `ENTITY`, `JOBS`, `BUS`, every enum, `LIMITS`, `RETRY`, `AUDIT`, `RT` + rooms, `NOTIFY` (template keys), `ERR` (all section 12 codes)                                                                                                                                                        |
| Types     | `communication.types.ts`                                                                                                                                                                                            | `Recipient`, `NotifyOptions`, `NotifyResult`, `TemplateDefinition`, `ChannelTexts`, `NoticeAudience`, `SystemNoticeInput`, `ResolvedAudience`                                                                                                                                                                                   |
| Ports     | `communication.ports.ts`                                                                                                                                                                                            | `communicationPorts()` (push, providers 07, collections 12, targets 22/26, guards 27, files 01), `setCommunicationPorts`, `communicationPortCalls`                                                                                                                                                                              |
| State     | `communication.state.ts`                                                                                                                                                                                            | PURE machines: notice 6.1, emergency 6.3, survey 6.4 (`noticeTransition`, `assertNoticeTransition`, `emergencyTransition`, `surveyTransition`, guards: cancel window, realert spacing, remind spacing, survey close window)                                                                                                     |
| Audience  | `communication.audience.ts`                                                                                                                                                                                         | `resolveAudience(societyId, audience)` (BR-16-3, BR-16-4), pure `normaliseAudience` (sorted unique ids, relation rules), `audienceLabel`                                                                                                                                                                                        |
| Core      | `communication.core.ts` (+ `.route`, `.mode`, `.render`, `.crypto`, `.registry`, `.registry.future`, `.templates`, `.templates.defs`, `.prefs`, `.recipients`, `.inbox`, `.deliver`)                                | the REAL `notify()` pipeline 6.5 and delivery step 6.2 (see "What the core offers")                                                                                                                                                                                                                                             |
| Public    | `communication.public.ts`                                                                                                                                                                                           | 8.38: `notify`, `notifyMany`, `registerTemplates`, `notices.*`, `emergency.*`, `communicationHooks`, `reach`, `noticeReports` (real notify, stubs `501 NOT_IMPLEMENTED_IN_FOUNDATION` for parts); `registerCommunication()`                                                                                                     |
| Seed      | `communication.seed.ts`, `seeders/communication.ts`                                                                                                                                                                 | `templates:sync` (section 10.2: every module's keys in `notification_templates`), `COMMUNICATION_SEEDERS`                                                                                                                                                                                                                       |
| Wiring    | `registerCommunication()` in `server.ts`, `worker.ts`, `scripts/seed.ts`                                                                                                                                            | installs the real notify engine, export provider, purge handler (order 160), queue `communication`, deliver + sweep jobs, port guard                                                                                                                                                                                            |
| Exports   | `communication.exports.ts`, `communication.purge.ts`                                                                                                                                                                | module 05 contract for the 12 tables                                                                                                                                                                                                                                                                                            |
| Tests     | `tests/modules/communication/`, `tests/helpers/communication.ts`                                                                                                                                                    | state, render, audience, registry/seed, notify core (routing, quiet hours, preferences, dedupe, limits, retries), swap-in of the stand-in                                                                                                                                                                                       |

Settings (7.13), permissions (section 2) and entitlements already exist in modules 08, 03 and 04. The approval type `NOTICE_PUBLISH` exists in module 14's
catalogue (handlers are registered by 16.1). Number series: none (notices show `NTC-` + id padded to 6, computed).

## The notify swap-in

`src/lib/notify.ts` keeps its API (`notify`, `registerTemplates`, `hasTemplate`, `setContactResolver`, `Template`, `Recipient`) so modules 01 to 15 are unchanged.
It now holds an engine hook: `setNotifyEngine(engine)`. `registerCommunication()` installs the real engine (`communication.core.ts`); without it (unit tests of other
modules) the original stand-in behaviour runs. The old in-code templates (`render(data) => { sms, email, link }`) are **preserved**: they are registered as
_legacy templates_; the real engine creates a `notification_templates` row for each (metadata derived from the key prefix, `scope`, `deliveryClass` from `critical`),
keeps their `render()` for the SMS / e-mail / in-app text, and treats them leniently (no `societyId` needed, no quiet hours). New templates (section 10.1) are real
`TemplateDefinition`s with `{{placeholders}}`. `GET /api/v1/dev/inbox` shows SMS, WhatsApp, e-mail, **PUSH and IN_APP** rows.

## What the core offers (call these; never write `notifications`, `inbox_items`, `notification_preferences` or receipts yourself)

- `notify(templateKey, recipients, data, opts)` and `notifyMany(items)`: 6.5 steps 1 to 7. Returns `NotifyResult`. Throws only the programmer errors of 8.38. In development
  and test delivery runs inline after the rows are written (so the dev inbox fills at once); in production deliver jobs are enqueued (`communication:deliver`).
- Module 16's own templates are `COMMUNICATION_TEMPLATES` in `communication.templates.defs.ts` (10.1 + `resident.*` + `reports.*`, with hi-IN and mr-IN for the notice and emergency keys); `communication.registry.future.ts` lists the keys of modules 17 to 30 read from their specs (metadata only; the owner registers the real definition).
- `registerTemplates(module, defs)` (new style) and the legacy `registerTemplates({...})` of `lib/notify`; `templates:sync` (`syncTemplates()`) upserts both into `notification_templates`
  (never overwrites text with `textEditedAt`), lazily on first use too.
- `getTemplate(key, locale)` (60 s cache, `dropTemplateCache()`), `renderTemplate(row, data, channel)` (pure `renderText`, `formatMoney`, `formatDate`, `smsSegments`).
- `deliverNotification(id)` (6.2 step 7: lock row, society state re-check, limit, provider, render, adapter, SENT / retry / FAILED + fallback BR-16-27) and `runDeliverJob`.
- Preferences: `getOrCreatePreferences(userId)`, pure `inQuietHours(window, at)`, `nextQuietEnd`, `isChannelOn(prefs, category, channel)`; the routes are 16.2.
- Inbox: `createInboxItem`, `unreadCount(userId, scope)`, `markRead`: realtime `notification.created` / `notification.read` (9.3).
- Audience: `resolveAudience`; recipients of a notice fan-out are written by 16.1's job with `notify(..., { audience })`-style helpers from the core.
- Pure routing in `communication.route.ts` (`routeChannels`, `failureFallback`, `retryPolicy`, `suppressedBySociety`), `communication.render.ts` (`formatMoney`, `renderText`, `smsSegments`, `validateData`).
- Pure state machines in `communication.state.ts` (the parts call `assertNoticeTransition(from, to)` etc.; they never compare status strings themselves).

## Rules for every part

- Files only with your prefix (below). Foundation files are `communication.{constants,types,ports,state,audience,route,mode,render,crypto,registry,registry.future,templates,templates.defs,prefs,recipients,core,deliver,inbox,seed,exports,purge,jobs,public}.ts`.
- Shared files you may touch with **additive lines only**: `src/app.ts` (one `api.use(...)` line per mount), this README (tick your part), `seeders/communication.ts` (one entry in `COMMUNICATION_SEEDERS`),
  `communication.public.ts` (replace the body of the stubs you own; keep the signature), `communication.jobs.ts` (one `register...Jobs()` line), the allow-list of module 05 for suspended societies
  (emergency routes are listed, 16.3 adds the NEW entries of section 8), `tests/helpers/communication.ts` (additive helpers), the tenant-isolation and permission-matrix lists in `tests/`.
- Routes go through `routeMeta`, `requirePermission`, `requireFeature` (`ENT.*`, `mode: 'read'` on GET), `validate` (strict Zod), `idempotency` for create routes.
- Times from `lib/clock`; call `notify` after commit; audit in the same transaction; services take `ctx` and never `req`/`res`. No migration unless a column is missing (new file after the latest).
- Tests in `tests/modules/communication/<prefix>.*.test.ts`; use `setCommunicationPorts()` and `communicationPortCalls`; tests run on your own pool database only.
- Audit actions are in `AUDIT`; realtime in `RT`; never put a notice body, an emergency note or survey text into audit rows (only lengths and ids).

## The four parts

### 16.1 notices admin (prefix `communication.notices`, `communication.composer`, `communication.approval`)

**Status: DONE (16.1).** Files: `communication.notices.{sanitize,templates,validation,dto,shared,service,publish,receipts,fanout,jobs,system,reports,controller,routes}.ts`, `communication.composer.ts`, `communication.approval.ts`.
Jobs registered here: `notice-fanout`, `ack-remind-notice` (`communication.notices.jobs.ts`). For 16.4 to register (one line each): `runNoticeScheduler()`, `runNoticeExpiry()`, `runAckReminders({ societyId? })`,
`runUtilityReminders()` exported from `communication.notices.fanout.ts`. Ports gained `files.unlink` and `files.describe` (additive). `POST /notices/:id/acknowledge` is implemented by
`acknowledgeNotice(ctx, id, body)` in `communication.notices.receipts.ts` (live-match aware): 16.2 may reuse it for `/me/notices/:id/acknowledge`, and `noticeFileUrl(ctx, id, fileId, disposition, visible?)` for `/me/.../download-url`.

Spec 8.1 to 8.17, 8.39, BR-16-1 to BR-16-17, F01 to F13. Routes: `GET|POST /notices`, `GET /notices/templates`, `POST /notices/audience-preview`, `GET|PATCH|DELETE /notices/:id`,
`POST /notices/:id/publish|withdraw|cancel-schedule|recall|pin|unpin|archive|duplicate|remind|restored`, `GET /notices/:id/receipts`, `GET /notices/:id/receipts/export`,
`GET /notices/:id/attachments/:fileId/download-url`, `POST /notices/:id/acknowledge` (role recipients).

- Tables written: `notices`, `notice_receipts` (fan-out job `communication:notice-fanout`; read and ack counters), files links.
- Calls: `normaliseAudience`/`resolveAudience`, `assertNoticeTransition`, `approvals.request('NOTICE_PUBLISH')` and the handler registration of 8.39 (`onApproved` etc. → `noticesService.onPublishApproved|backToDraft`),
  `notify(NOTIFY.noticePublished | noticeAckRequired | noticeRecalled | utilityRestored, ..., { dedupeKey: 'notice:<id>' })`.
- Replaces in `communication.public.ts`: `notices.createSystemNotice|recallBySource|createDraft|ackSummary|hasUserAcknowledged`, `reach.forNotices`, `noticeReports.reachByNotice`.
- Owns the HTML sanitiser (BR-16-2), the 8 starter template texts of the library (`GET /notices/templates`), `NoticeDto`.

### 16.2 resident notices, notification bell, preferences, push (prefix `communication.me`, `communication.inbox`, `communication.prefs.routes`, `communication.push`)

**16.2 status: done.** Files: `communication.inbox.{service,routes}.ts` (bells 8.20 to 8.22), `communication.me.{notices.service,routes}.ts` (8.17 `/me`, 8.18, 8.19; `acknowledgeNotice(ctx, id, body)` owns `/me/notices/:id/acknowledge`; 16.1's `communication.notices.receipts.ts` owns the admin `/notices/:id/acknowledge`), `communication.prefs.{service,routes}.ts` (8.23), `communication.push.{service,routes,sender}.ts` (8.24; real Web Push sender RFC 8291 + VAPID from `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, installed by `registerCommunication()` when set). `registerCommunication()` also wires the module 02 `communicationHooks`. `GET /public/push/vapid-public-key` is listed in `auth/public.routes.ts`.

Spec 8.18 to 8.24 (8.22 platform bell), BR-16-11, BR-16-32 to BR-16-36. Routes: `GET /me/notices`, `GET /me/notices/:id`, `POST /me/notices/:id/acknowledge`, `GET /me/notices/:id/attachments/:fileId/download-url`,
`GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all`, `GET|POST|POST|POST /platform/notifications*`, `GET|PUT /me/notification-preferences`,
`GET|POST|DELETE /me/push-subscriptions*`, `POST /me/push-subscriptions/:id/test`, `GET /public/push/vapid-public-key`.

- Tables written: `inbox_items` (read flags), `notification_preferences`, `push_subscriptions`, `notice_receipts` (read, ack).
- Calls: core `getOrCreatePreferences`, `unreadCount`, `markRead`, `isChannelOn`; `notify(NOTIFY.pushTest, [userId], {}, { pushSubscriptionId })`; ports `push`.
- Replaces in `communication.public.ts`: `communicationHooks.onSessionRevoked`, `onUserAnonymised`.
- Owns the real push sender body (`communicationPorts().push` implementation with the allow-list of endpoints, `PUSH_ENDPOINT_NOT_ALLOWED`), the 10-subscription cap (BR-16-35) and revocation rules (BR-16-36), the module 05 allow-list entries `read` and `read-all`.

### 16.3 emergency and surveys (prefix `communication.emergency`, `communication.surveys`) [DONE: branch `tmp/16-3-be`]

Spec 8.25 to 8.30 (emergency), 8.31 to 8.34 (surveys), BR-16-37 to BR-16-49, F22 to F25. Routes: `/emergency-broadcasts*`, `/gate/emergency-broadcasts*`, `/me/emergency-broadcasts/active`,
`/surveys*`, `/me/surveys*`.

- Tables written: `emergency_broadcasts`, `emergency_responses` (`isLatest` flip in one transaction), `surveys`, `survey_questions`, `survey_responses`.
- Calls: `assertEmergencyTransition`, `canCancel`, `canRealert`, `assertSurveyTransition`, `surveyCloseWindowOk`, `notify(NOTIFY.emergency* | surveyPublished | surveyClosed, ..., { societyId })` (SAFETY class, drills in-app + push only),
  `resolveAudience`, `members.listForSociety` for staff and guards, ports `guards`.
- Replaces in `communication.public.ts`: `emergency.startFromSos|getActive`.
- Owns the HMAC respondent key (BR-16-48, `communication.crypto.ts` has `hmacKey`), results aggregation, CSV, the module 05 allow-list entries of section 8 (updates, realert, resolve, cancel, attend, gate responses).

### 16.4 jobs, webhooks, platform registry and deliveries, templates (prefix `communication.jobs`, `communication.webhooks`, `communication.platform`, `communication.templates.admin`)

Spec 8.35 to 8.37, 9.1 to 9.4, section 10, BR-16-27, BR-16-28, F18, F26. Routes: `GET|PATCH /platform/notification-templates*`, `POST /platform/notification-templates/:id/preview`, `GET /platform/notification-deliveries`,
`POST /webhooks/messaging/:providerKey`.

- Jobs of queue `communication` registered from `communication.jobs.ts` (the foundation registers `deliver`, `notify-fanout` and `repair-stuck`; 16.4 adds `notice-scheduler`, `notice-expiry`, `ack-reminders`, `ack-remind-notice`,
  `utility-reminders`, `emergency-resolve-reminder`, `survey-close`, `process-webhook`, `purge`, `push-expiry` with ONE line each, calling services of 16.1 / 16.3 where they exist).
- Tables written: `notification_templates` (editor: text, DLT, WhatsApp; `textEditedAt`; `communication:templates-changed` → `dropTemplateCache`), `notifications` (webhook status moves forward only), `notification_preferences` (STOP, bounce).
- Calls: core `getTemplate`, `renderTemplate`, `smsSegments`; module 07 `resolveProvider` (replace `communicationPorts().providers`), adapter `verifyWebhook` (NEW adapter method in module 01 §10).
- Owns the registry test that renders every template with its sample on every allowed channel, the template audit `communication.template.updated`, `communication.deliveries.searched`.

## Shortcuts the parts must know

- Legacy templates (modules 01 to 15) have no `variablesSchema`; `getTemplate` returns `legacy: true` for them and `renderTemplate` calls their `render()`. Do not try to edit their text in the platform editor
  (the editor lists them read-only until a module migrates them to `TemplateDefinition`).
- `communicationPorts().push` placeholder records the send in the dev inbox as channel `PUSH` (`to: user:<id>`); 16.2 replaces it with Web Push.
- Delivery in development and test is inline; to test the production queue path call `setDeliveryMode('queue')` then `drainQueues()` and `runDeliverJob`.
- `notification_templates` is NOT truncated by `resetAll` (platform seed table); lazily re-synced from code when a key is missing.

## Part 16.4 status (jobs, webhooks, platform registry and deliveries)

Done in `communication.jobs.{common,notices,safety,maintenance,register}.ts`, `communication.webhooks.service.ts`, `communication.platform.{routes,validation,deliveries,providers}.ts`, `communication.templates.admin.ts`.

- Jobs (9.1): `notice-scheduler`, `notice-expiry`, `ack-reminders` (hourly dispatcher, 10:00 society time), `ack-remind-notice` (payload `{ noticeId, reminderNo }`, enqueued by 16.1's manual remind after it counted the reminder), `utility-reminders`,
  `emergency-resolve-reminder`, `survey-close` (close + 24 h reminder + `survey_closed` to named respondents), `process-webhook`, `purge`, `push-expiry`. Registered by `registerCommunicationPartJobs()` (one line in `communication.jobs.ts`); each job name has exactly one processor (16.1 registers only `notice-fanout`). `registerCommunicationJobs()` installs the default hooks: `publishScheduledNotice` = 16.1's, `recordEmergencyResponse` = 16.3's (`recordWhatsappResponse`). **Status: DONE (16.4).**
- Hooks (`jobHooks` in `communication.jobs.common.ts`, set with `setJobHooks`): 16.1 may register `publishScheduledNotice(societyId, noticeId, at)` (default: PUBLISHED + audit + enqueue `communication:notice-fanout` `{ noticeId, societyId }`);
  16.3 must register `recordEmergencyResponse({ societyId, broadcastId, userId, unitId, status, channel: 'WHATSAPP' })` for WhatsApp button replies (without it the reply is logged and ignored).
- Webhook (8.37): module 01 adapter contract gained `verifyWebhook(rawBody, headers, credentials)` and `parseWebhook(rawBody)` (`src/adapters/provider-adapter.ts`); the fake vendor signs `<x-webhook-timestamp>.<body>` with HMAC-SHA256 (`signFakeWebhook`).
- Platform (8.35, 8.36): routes mounted in `app.ts` (`communicationPlatformRoutes`); `registerCommunication()` now installs the module 07 provider port (`moduleSevenProviders`, BR-16-28).
