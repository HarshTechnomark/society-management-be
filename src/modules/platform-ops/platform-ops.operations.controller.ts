import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { logger } from '../../lib/logger';
import { created, noContent, ok, okList } from '../../utils/response';
import * as dashboard from './platform-ops.dashboard.service';
import * as providers from './platform-ops.providers.service';
import * as health from './platform-ops.providers.health';
import * as incidents from './platform-ops.incidents.service';
import * as status from './platform-ops.status.service';
import * as announcements from './platform-ops.announcements.service';
import * as queues from './platform-ops.queues.service';
import * as auditSvc from './platform-ops.audit.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const pid = (req: Request): number => req.valid.params.id;

/** Streams a prepared CSV export (headers first, then batches); an error after the first byte closes the connection. */
async function sendCsv(res: Response, prepared: auditSvc.PreparedExport): Promise<void> {
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${prepared.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  const write = (chunk: string) =>
    new Promise<void>((resolve, reject) => res.write(chunk, err => (err ? reject(err) : resolve())));
  try {
    await prepared.stream(write);
    res.end();
  } catch (err) {
    logger.error({ err }, 'audit export failed while streaming');
    res.destroy();
  }
}

export const operationsController = {
  // ---- 8.2
  dashboard: h(async (req, res) => ok(res, await dashboard.getDashboard(v(req).query.period))),
  activity: h(async (_req, res) => ok(res, await dashboard.getActivity())),
  healthSummary: h(async (_req, res) => ok(res, await dashboard.getHealthSummary())),

  // ---- 8.5 providers
  listProviders: h(async (req, res) => ok(res, await providers.listProviders(v(req).query))),
  getProvider: h(async (req, res) => ok(res, await providers.getProvider(pid(req)))),
  createProvider: h(async (req, res) =>
    created(res, await providers.createProvider(req.ctx, v(req).body), 'Provider created'),
  ),
  patchProvider: h(async (req, res) =>
    ok(res, await providers.updateProvider(req.ctx, pid(req), v(req).body), 'Provider saved'),
  ),
  credentials: h(async (req, res) =>
    ok(res, await providers.replaceCredentials(req.ctx, pid(req), v(req).body), 'Credentials replaced'),
  ),
  deleteProvider: h(async (req, res) => {
    await providers.deleteProvider(req.ctx, pid(req), v(req).body);
    noContent(res);
  }),
  checkOne: h(async (req, res) => ok(res, { results: [await health.checkOne(pid(req))] })),
  checkAll: h(async (_req, res) => ok(res, await health.checkAll())),
  testSend: h(async (req, res) => ok(res, await providers.testSend(req.ctx, pid(req), v(req).body))),
  providerStatus: h(async (req, res) =>
    ok(res, await providers.setProviderStatus(req.ctx, pid(req), v(req).body), 'Status saved'),
  ),

  // ---- 8.6 incidents
  listIncidents: h(async (req, res) => {
    const r = await incidents.listIncidents(v(req).query);
    okList(res, r.data, r.pagination);
  }),
  getIncident: h(async (req, res) => ok(res, await incidents.getIncident(pid(req)))),
  createIncident: h(async (req, res) =>
    created(res, await incidents.createIncident(req.ctx, v(req).body), 'Incident opened'),
  ),
  patchIncident: h(async (req, res) =>
    ok(res, await incidents.updateIncident(req.ctx, pid(req), v(req).body), 'Incident saved'),
  ),
  incidentUpdate: h(async (req, res) =>
    ok(res, await incidents.postIncidentUpdate(req.ctx, pid(req), v(req).body), 'Update posted'),
  ),
  resolveIncident: h(async (req, res) =>
    ok(res, await incidents.resolveIncident(req.ctx, pid(req), v(req).body), 'Incident resolved'),
  ),
  publicStatus: h(async (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=30');
    ok(res, await status.getStatusPage());
  }),

  // ---- 8.7 announcements
  listAnnouncements: h(async (req, res) => {
    const r = await announcements.listAnnouncements(v(req).query);
    okList(res, r.data, r.pagination);
  }),
  getAnnouncement: h(async (req, res) => ok(res, await announcements.getAnnouncement(pid(req)))),
  createAnnouncement: h(async (req, res) =>
    created(res, await announcements.createDraft(req.ctx, v(req).body), 'Draft saved'),
  ),
  patchAnnouncement: h(async (req, res) =>
    ok(res, await announcements.updateAnnouncement(req.ctx, pid(req), v(req).body), 'Announcement saved'),
  ),
  previewAudience: h(async (req, res) => ok(res, await announcements.previewAudience(v(req).body))),
  publishAnnouncement: h(async (req, res) =>
    ok(
      res,
      await announcements.publishAnnouncement(req.ctx, pid(req), v(req).body),
      'Announcement published',
    ),
  ),
  cancelAnnouncement: h(async (req, res) =>
    ok(res, await announcements.cancelAnnouncement(req.ctx, pid(req), v(req).body), 'Announcement cancelled'),
  ),
  deleteAnnouncement: h(async (req, res) => {
    await announcements.deleteAnnouncement(req.ctx, pid(req), v(req).body);
    noContent(res);
  }),
  banners: h(async (req, res) => ok(res, await announcements.bannersForMe(req.ctx))),
  dismiss: h(async (req, res) => {
    await announcements.dismissBanner(req.ctx, pid(req));
    noContent(res);
  }),

  // ---- 8.8 queues
  listQueues: h(async (_req, res) => ok(res, await queues.listQueues())),
  queueJobs: h(async (req, res) => {
    const q = v(req).query;
    const r = await queues.listJobs(v(req).params.name, q);
    okList(res, r.data, r.pagination);
  }),
  failedJobs: h(async (req, res) => {
    const r = await queues.listFailedJobs(v(req).query);
    okList(res, r.data, r.pagination);
  }),
  getJob: h(async (req, res) => ok(res, await queues.getJob(v(req).params.name, v(req).params.jobId))),
  retryJob: h(async (req, res) =>
    ok(res, await queues.retryJob(req.ctx, v(req).params.name, v(req).params.jobId)),
  ),
  discardJob: h(async (req, res) => {
    await queues.discardJob(req.ctx, v(req).params.name, v(req).params.jobId, v(req).body.reason);
    noContent(res);
  }),
  pauseQueue: h(async (req, res) =>
    ok(res, await queues.pauseQueue(req.ctx, v(req).params.name, v(req).body.reason), 'Queue paused'),
  ),
  resumeQueue: h(async (req, res) =>
    ok(res, await queues.resumeQueue(req.ctx, v(req).params.name, v(req).body.reason), 'Queue resumed'),
  ),
  bulkRetry: h(async (req, res) => ok(res, await queues.bulkRetry(req.ctx, v(req).body))),

  // ---- 8.9 audit
  platformAudit: h(async (req, res) => {
    const r = await auditSvc.listPlatformAudit(v(req).query);
    res.status(200).json({ success: true, data: r.data, message: 'OK', pagination: r.pagination });
  }),
  platformAuditRow: h(async (req, res) => ok(res, await auditSvc.getPlatformAuditRow(pid(req)))),
  platformAuditExport: h(async (req, res) =>
    sendCsv(res, await auditSvc.preparePlatformExport(req.ctx, v(req).query)),
  ),
  archives: h(async (_req, res) => ok(res, await auditSvc.listArchives())),
  archiveUrl: h(async (req, res) => ok(res, await auditSvc.archiveDownloadUrl(req.ctx, v(req).body))),
  societyAudit: h(async (req, res) => {
    const r = await auditSvc.listSocietyAudit(req.ctx, v(req).query);
    res.status(200).json({ success: true, data: r.data, message: 'OK', pagination: r.pagination });
  }),
  societyAuditRow: h(async (req, res) => ok(res, await auditSvc.getSocietyAuditRow(req.ctx, pid(req)))),
  societyAuditExport: h(async (req, res) =>
    sendCsv(res, await auditSvc.prepareSocietyExport(req.ctx, v(req).query)),
  ),
};
