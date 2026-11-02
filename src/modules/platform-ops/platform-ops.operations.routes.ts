import { Router, type RequestHandler } from 'express';
import { validate } from '../../middlewares/validate.middleware';
import { requireRecentAuth } from '../../middlewares/recentAuth.middleware';
import { idempotency } from '../../middlewares/idempotency.middleware';
import { rateLimit } from '../../middlewares/rateLimit.middleware';
import { platformMiddleware, societyMiddleware } from '../../middlewares/society.middleware';
import {
  publicRoute,
  requirePermission as can,
  requirePlatformPermission as canPlatform,
} from '../../middlewares/permission.middleware';
import { tag } from '../access-control/access-control.registry';
import { routeMeta } from '../societies/societies.guard';
import { operationsController as c } from './platform-ops.operations.controller';
import { opsSchemas2 as s } from './platform-ops.operations.validation';

/**
 * Module 07 routes, part 2: dashboard (8.2), providers (8.5), incidents and the public status page (8.6), announcements
 * (8.7), jobs and queues (8.8) and audit logs (8.9). Same order as part 1: state policy, marker, permission, validate,
 * rate limit, step-up, idempotency, controller. Fixed paths come before `/:id` paths.
 */
const platform = () => platformMiddleware();
const society = () => societyMiddleware();
const stepUp = (): RequestHandler => tag(requireRecentAuth(), { stepUp: true });
const perUser =
  (name: string, limit: number, windowSeconds = 3600) =>
  () =>
    rateLimit({ name, limit, windowSeconds, key: req => String(req.ctx.user?.id ?? '') || null });
/** Banners and the society audit view keep working for a suspended society. */
const allowSuspended = () => routeMeta({ suspended: 'allow' });

export const operationsRoutes = Router();
const r = operationsRoutes;

// ---- 8.2 dashboard
r.get(
  '/platform/dashboard',
  platform(),
  canPlatform('platform.dashboard.view'),
  validate({ query: s.dashboardQuery }),
  c.dashboard,
);
r.get('/platform/dashboard/activity', platform(), canPlatform('platform.dashboard.view'), c.activity);
r.get('/platform/health/summary', platform(), canPlatform('platform.dashboard.view'), c.healthSummary);

// ---- 8.5 providers
r.get(
  '/platform/providers',
  platform(),
  canPlatform('platform.health.view'),
  validate({ query: s.providerList }),
  c.listProviders,
);
r.post(
  '/platform/providers/check-all',
  platform(),
  canPlatform('platform.health.view'),
  perUser('provider-check', 30)(),
  c.checkAll,
);
r.get(
  '/platform/providers/:id',
  platform(),
  canPlatform('platform.health.view'),
  validate({ params: s.idParam }),
  c.getProvider,
);
r.post(
  '/platform/providers',
  platform(),
  canPlatform('platform.settings.edit'),
  validate({ body: s.providerCreate }),
  stepUp(),
  idempotency(),
  c.createProvider,
);
r.patch(
  '/platform/providers/:id',
  platform(),
  canPlatform('platform.settings.edit'),
  validate({ params: s.idParam, body: s.providerPatch }),
  stepUp(),
  c.patchProvider,
);
r.put(
  '/platform/providers/:id/credentials',
  platform(),
  canPlatform('platform.settings.edit'),
  validate({ params: s.idParam, body: s.providerCredentials }),
  stepUp(),
  c.credentials,
);
r.delete(
  '/platform/providers/:id',
  platform(),
  canPlatform('platform.settings.edit'),
  validate({ params: s.idParam, body: s.providerDelete }),
  stepUp(),
  c.deleteProvider,
);
r.post(
  '/platform/providers/:id/check',
  platform(),
  canPlatform('platform.health.view'),
  validate({ params: s.idParam }),
  perUser('provider-check', 30)(),
  c.checkOne,
);
r.post(
  '/platform/providers/:id/test-send',
  platform(),
  canPlatform('platform.health.edit'),
  validate({ params: s.idParam, body: s.providerTestSend }),
  perUser('provider-test', 10)(),
  c.testSend,
);
r.post(
  '/platform/providers/:id/status',
  platform(),
  canPlatform('platform.health.edit'),
  validate({ params: s.idParam, body: s.providerStatus }),
  c.providerStatus,
);

// ---- 8.6 incidents and the public status page
r.get(
  '/platform/incidents',
  platform(),
  canPlatform('platform.health.view'),
  validate({ query: s.incidentList }),
  c.listIncidents,
);
r.get(
  '/platform/incidents/:id',
  platform(),
  canPlatform('platform.health.view'),
  validate({ params: s.idParam }),
  c.getIncident,
);
r.post(
  '/platform/incidents',
  platform(),
  canPlatform('platform.health.edit'),
  validate({ body: s.incidentCreate }),
  idempotency(),
  c.createIncident,
);
r.patch(
  '/platform/incidents/:id',
  platform(),
  canPlatform('platform.health.edit'),
  validate({ params: s.idParam, body: s.incidentPatch }),
  c.patchIncident,
);
r.post(
  '/platform/incidents/:id/updates',
  platform(),
  canPlatform('platform.health.edit'),
  validate({ params: s.idParam, body: s.incidentUpdate }),
  c.incidentUpdate,
);
r.post(
  '/platform/incidents/:id/resolve',
  platform(),
  canPlatform('platform.health.edit'),
  validate({ params: s.idParam, body: s.incidentResolve }),
  c.resolveIncident,
);
r.get(
  '/public/status',
  publicRoute(),
  rateLimit({
    name: 'public-status',
    limit: 60,
    windowSeconds: 60,
    key: req => req.ctx.ip || req.ip || 'unknown',
  }),
  c.publicStatus,
);

// ---- 8.7 announcements (platform side)
r.get(
  '/platform/announcements',
  platform(),
  canPlatform('platform.announcements.view'),
  validate({ query: s.announcementList }),
  c.listAnnouncements,
);
r.post(
  '/platform/announcements/audience-preview',
  platform(),
  canPlatform('platform.announcements.create'),
  validate({ body: s.audiencePreview }),
  c.previewAudience,
);
r.get(
  '/platform/announcements/:id',
  platform(),
  canPlatform('platform.announcements.view'),
  validate({ params: s.idParam }),
  c.getAnnouncement,
);
r.post(
  '/platform/announcements',
  platform(),
  canPlatform('platform.announcements.create'),
  validate({ body: s.announcementCreate }),
  idempotency(),
  c.createAnnouncement,
);
r.patch(
  '/platform/announcements/:id',
  platform(),
  canPlatform('platform.announcements.edit'),
  validate({ params: s.idParam, body: s.announcementPatch }),
  c.patchAnnouncement,
);
r.post(
  '/platform/announcements/:id/publish',
  platform(),
  canPlatform('platform.announcements.edit'),
  validate({ params: s.idParam, body: s.announcementVersion }),
  c.publishAnnouncement,
);
r.post(
  '/platform/announcements/:id/cancel',
  platform(),
  canPlatform('platform.announcements.edit'),
  validate({ params: s.idParam, body: s.announcementCancel }),
  c.cancelAnnouncement,
);
r.delete(
  '/platform/announcements/:id',
  platform(),
  canPlatform('platform.announcements.edit'),
  validate({ params: s.idParam, body: s.announcementVersion }),
  c.deleteAnnouncement,
);

// ---- 8.7 announcements (society side)
r.get('/platform-announcements', allowSuspended(), society(), can('dashboard.today.view'), c.banners);
r.post(
  '/platform-announcements/:id/dismiss',
  allowSuspended(),
  society(),
  can('dashboard.today.view'),
  validate({ params: s.idParam }),
  c.dismiss,
);

// ---- 8.8 jobs and queues (`retry-failed` and `jobs/failed` before the `:name` paths)
r.get('/platform/queues', platform(), canPlatform('platform.jobs.view'), c.listQueues);
r.post(
  '/platform/queues/retry-failed',
  platform(),
  canPlatform('platform.jobs.edit'),
  validate({ body: s.bulkRetry }),
  c.bulkRetry,
);
r.get(
  '/platform/jobs/failed',
  platform(),
  canPlatform('platform.jobs.view'),
  validate({ query: s.failedJobsQuery }),
  c.failedJobs,
);
r.get(
  '/platform/queues/:name/jobs',
  platform(),
  canPlatform('platform.jobs.view'),
  validate({ params: s.queueParam, query: s.queueJobsQuery }),
  c.queueJobs,
);
r.get(
  '/platform/queues/:name/jobs/:jobId',
  platform(),
  canPlatform('platform.jobs.view'),
  validate({ params: s.jobParam }),
  c.getJob,
);
r.post(
  '/platform/queues/:name/jobs/:jobId/retry',
  platform(),
  canPlatform('platform.jobs.edit'),
  validate({ params: s.jobParam }),
  c.retryJob,
);
r.post(
  '/platform/queues/:name/jobs/:jobId/discard',
  platform(),
  canPlatform('platform.jobs.edit'),
  validate({ params: s.jobParam, body: s.reasonBody }),
  stepUp(),
  c.discardJob,
);
r.post(
  '/platform/queues/:name/pause',
  platform(),
  canPlatform('platform.jobs.edit'),
  validate({ params: s.queueParam, body: s.reasonBody }),
  stepUp(),
  c.pauseQueue,
);
r.post(
  '/platform/queues/:name/resume',
  platform(),
  canPlatform('platform.jobs.edit'),
  validate({ params: s.queueParam, body: s.reasonBody }),
  stepUp(),
  c.resumeQueue,
);

// ---- 8.9 audit logs (platform): fixed paths before `:id`
r.get(
  '/platform/audit-logs',
  platform(),
  canPlatform('platform.audit_log.view'),
  validate({ query: s.platformAuditQuery }),
  c.platformAudit,
);
r.get(
  '/platform/audit-logs/export',
  platform(),
  canPlatform('platform.audit_log.export'),
  validate({ query: s.platformAuditExport }),
  perUser('audit-export', 10)(),
  c.platformAuditExport,
);
r.get('/platform/audit-logs/archives', platform(), canPlatform('platform.audit_log.view'), c.archives);
r.post(
  '/platform/audit-logs/archives/download-url',
  platform(),
  canPlatform('platform.audit_log.export'),
  validate({ body: s.archiveDownload }),
  stepUp(),
  c.archiveUrl,
);
r.get(
  '/platform/audit-logs/:id',
  platform(),
  canPlatform('platform.audit_log.view'),
  validate({ params: s.idParam }),
  c.platformAuditRow,
);

// ---- 8.9 audit logs (society)
r.get(
  '/audit-logs',
  allowSuspended(),
  society(),
  can('settings.audit_log.view'),
  validate({ query: s.societyAuditQuery }),
  c.societyAudit,
);
r.get(
  '/audit-logs/export',
  allowSuspended(),
  society(),
  can('settings.audit_log.export'),
  validate({ query: s.societyAuditExport }),
  perUser('audit-export', 10)(),
  c.societyAuditExport,
);
r.get(
  '/audit-logs/:id',
  allowSuspended(),
  society(),
  can('settings.audit_log.view'),
  validate({ params: s.idParam }),
  c.societyAuditRow,
);
