# Module 09 Part 2: join requests, tenancies and move requests

Files (all new, prefix `residents.joins.*`, `residents.tenancies.*`, `residents.moves.*`, `residents.part2.*`):

- `residents.joins.service.ts`: society lookup by code, flat search, submit (BR-09-22 to 24), owner or tenant confirmation,
  withdraw, admin list and detail, module 14 handlers `joinRequestHandlers` (BR-09-25), job `residents:join-requests`
  (3 day escalation, 14 day expiry).
- `residents.tenancies.service.ts`: create, edit, submit, approve (maker-checker), reject, cancel, activate, renew, end
  (`endTenancyTx` is the function ownership transfers call), police verification, jobs `residents:tenancy-reminders` and
  `residents:police-reminders`, sync step "APPROVED tenancy starts without a move-in request", and `tenancyExpiry` for module 24.
- `residents.moves.service.ts`: create, `advanceMove` pipeline (owner NOC, dues, deposit, approval), dues recheck and override,
  slot and lift conflicts, gate pass, start, complete, inspection and refund, cancel, edit after changes requested,
  `moveHandlers` for `MOVE_IN` and `MOVE_OUT`, jobs `residents:deposit-refunds` and the stale-move sync step.
- `residents.part2.ports.ts`: placeholders for module 14 `approvals` and module 13 `deposits` (module 11
  `unitLedger.balance` is the part 1 port). `setPart2Ports({...})` replaces them.
- `residents.part2.approvals-hook.ts`: `approve(approvalRequestId, actorCtx)` and `reject(approvalRequestId, reason, actorCtx)`,
  exported from `residents.public.ts` as `approveRequest` and `rejectRequest`. They run the registered handlers in one
  transaction (the code module 14's callback runs). A development-only route can call them; none is added here.

Notes:

- Placeholders: approvals auto-approve and call `onApproved` in the same transaction (`approvalStub.mode = 'manual'` keeps
  them PENDING for tests); deposits are paid at once (`depositStub.mode = 'pending'` waits for `residentsHooks.onDepositPaid`).
  Requests live in an in-memory map (the memory implementation of the "no Redis" rule; module 14 will own a table).
- Migration `20261109000100-add-tenancy-household-and-invite.js` adds `tenancies.householdJson` and `tenancies.inviteTenant`:
  section 7.3 has no place to keep the household members and the invite choice of a DRAFT tenancy until approval.
- `residents:police-reminders` runs daily (the queue has no weekly schedule); `policeReminderSentAt` limits it to every 6 days.
- `residents.joinRequestNeedsApproval = false` approves a join request directly, without a module 14 request.
- Audit keys avoid `code`, `token` and `secret`; the gate pass is never written to an audit row.
- `residentsHooks.onDepositPaid` and `onDepositRefunded` dispatch by `refType`; part 3 registers `renovation_permit` with
  `registerDepositHandler`.
