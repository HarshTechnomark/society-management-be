import { registerType } from '../approvals/approvals.public';
import { backToDraft, onPublishApproved } from './communication.notices.publish';

/** 8.39: registers the approval type `NOTICE_PUBLISH` with module 14. `replace` keeps repeated `registerCommunication()` calls (tests) harmless. */
export function registerNoticeApprovalType(): void {
  registerType(
    'NOTICE_PUBLISH',
    {
      onApproved: onPublishApproved,
      onRejected: (ctx, req, t) =>
        backToDraft(req.societyId, req.entityId, 'REJECTED', ctx.approval.reason, t, ctx),
      onChangesRequested: (ctx, req, t) =>
        backToDraft(req.societyId, req.entityId, 'CHANGES_REQUESTED', ctx.approval.reason, t, ctx),
      onCancelled: (ctx, req, t) =>
        backToDraft(req.societyId, req.entityId, 'CANCELLED', ctx.approval.reason, t, ctx),
      onExpired: (ctx, req, t) => backToDraft(req.societyId, req.entityId, 'EXPIRED', null, t, ctx),
      describe: req => ({
        facts: [
          { label: 'Audience', value: String(req.payload.audienceLabel ?? ''), kind: 'text' },
          { label: 'People', value: String(req.payload.recipientEstimate ?? ''), kind: 'text' },
          { label: 'Scheduled', value: String(req.payload.scheduledAt ?? 'On approval'), kind: 'text' },
        ],
        link: `/notices/${req.entityId}`,
      }),
    },
    { replace: true },
  );
}
