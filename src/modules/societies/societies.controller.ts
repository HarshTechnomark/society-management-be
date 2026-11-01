import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, noContent, ok, okList } from '../../utils/response';
import * as svc from './societies.service';
import * as lifecycle from './societies.lifecycle';
import * as notes from './societies.notes.service';
import * as grants from './societies.support-access';
import * as exportsSvc from './societies.exports';
import { nudge } from './societies.health';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const pid = (req: Request): number => req.valid.params.id;
const sid = (req: Request): number => req.ctx.society!.id;
const canDecide = (req: Request) => req.ctx.permissions.has('settings.support_access.approve');

export const societiesController = {
  // ---- public sign-up (8.1)
  signup: h(async (req, res) => {
    const r = await svc.signup(req.ctx, v(req).body);
    for (const c of r.cookies) res.cookie(c.name, c.value, c.options);
    created(res, r.result, 'Society created');
  }),

  // ---- platform societies (8.2 to 8.15)
  list: h(async (req, res) => {
    const r = await svc.listSocieties(v(req).query);
    okList(res, r.data, r.pagination);
  }),
  exportList: h(async (req, res) => {
    const csv = await svc.exportCsv(req.ctx, v(req).query);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="societies.csv"');
    res.status(200).send(csv);
  }),
  slugAvailability: h(async (req, res) => ok(res, await svc.slugAvailability(v(req).query.slug))),
  create: h(async (req, res) =>
    created(
      res,
      await svc.createSociety(req.ctx, v(req).body),
      'Society created. Invite sent to the chairman.',
    ),
  ),
  detail: h(async (req, res) => ok(res, await svc.getDetail(req.ctx, pid(req)))),
  update: h(async (req, res) =>
    ok(res, await svc.updateSociety(req.ctx, pid(req), v(req).body), 'Society saved'),
  ),
  events: h(async (req, res) => {
    const r = await svc.lifecycleEvents(pid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  extendTrial: h(async (req, res) =>
    ok(res, await lifecycle.extendTrial(req.ctx, pid(req), v(req).body), 'Trial extended'),
  ),
  convert: h(async (req, res) =>
    ok(res, await lifecycle.convert(req.ctx, pid(req), v(req).body), 'Society converted to a paid plan'),
  ),
  suspend: h(async (req, res) =>
    ok(res, await lifecycle.suspend(req.ctx, pid(req), v(req).body), 'Society suspended'),
  ),
  reactivate: h(async (req, res) =>
    ok(res, await lifecycle.reactivate(req.ctx, pid(req), v(req).body), 'Society reactivated'),
  ),
  close: h(async (req, res) =>
    ok(res, await lifecycle.close(req.ctx, pid(req), v(req).body), 'Society closed'),
  ),
  reopen: h(async (req, res) =>
    ok(res, await lifecycle.reopen(req.ctx, pid(req), v(req).body), 'Society reopened'),
  ),
  setPurgeHold: h(async (req, res) =>
    ok(res, await lifecycle.setPurgeHold(req.ctx, pid(req), v(req).body, true), 'Purge hold set'),
  ),
  clearPurgeHold: h(async (req, res) =>
    ok(res, await lifecycle.setPurgeHold(req.ctx, pid(req), v(req).body, false), 'Purge hold cleared'),
  ),
  nudge: h(async (req, res) => ok(res, await nudge(req.ctx, pid(req), v(req).body), 'Nudge sent')),

  // ---- notes (8.16)
  listNotes: h(async (req, res) => {
    const r = await notes.listNotes(req.ctx, pid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  createNote: h(async (req, res) =>
    created(res, await notes.createNote(req.ctx, pid(req), v(req).body), 'Note added'),
  ),
  updateNote: h(async (req, res) =>
    ok(res, await notes.updateNote(req.ctx, pid(req), v(req).params.noteId, v(req).body), 'Note saved'),
  ),
  deleteNote: h(async (req, res) => {
    await notes.deleteNote(req.ctx, pid(req), v(req).params.noteId);
    noContent(res);
  }),

  // ---- platform exports (8.17)
  platformExports: h(async (req, res) => {
    await svc.assertSocietyExists(pid(req));
    const r = await exportsSvc.listExports(pid(req), { ...v(req).query });
    okList(res, r.data, r.pagination);
  }),
  platformCreateExport: h(async (req, res) =>
    created(
      res,
      await exportsSvc.requestExport(req.ctx, pid(req), { ...v(req).body, via: 'PLATFORM' }),
      'Export queued',
    ),
  ),

  // ---- platform support access (8.18 to 8.21)
  listGrants: h(async (req, res) => {
    const r = await grants.listPlatform(v(req).query);
    okList(res, r.data, r.pagination);
  }),
  currentGrant: h(async (req, res) => ok(res, await grants.current(req.ctx))),
  getGrant: h(async (req, res) => ok(res, await grants.getPlatform(pid(req)))),
  requestGrant: h(async (req, res) => {
    const g = await grants.requestGrant(req.ctx, v(req).body);
    created(res, g, g.status === 'ACTIVE' ? 'Support access started' : 'Support access requested');
  }),
  endGrant: h(async (req, res) => ok(res, await grants.endOwn(req.ctx, pid(req)), 'Support access ended')),
  cancelGrant: h(async (req, res) => ok(res, await grants.cancelOwn(req.ctx, pid(req)), 'Request withdrawn')),
  revokeGrantPlatform: h(async (req, res) =>
    ok(res, await grants.revoke(req.ctx, pid(req), v(req).body, 'PLATFORM'), 'Support access revoked'),
  ),

  // ---- society (8.22 to 8.24)
  societyStatus: h(async (req, res) => ok(res, await svc.societyStatus(req.ctx))),
  societyGrants: h(async (req, res) => {
    const r = await grants.listSociety(sid(req), v(req).query, canDecide(req));
    okList(res, r.data, r.pagination);
  }),
  societyGrant: h(async (req, res) => ok(res, await grants.getSociety(sid(req), pid(req), canDecide(req)))),
  approveGrant: h(async (req, res) =>
    ok(
      res,
      await grants.approve(req.ctx, sid(req), pid(req), v(req).body.version),
      'Support access approved',
    ),
  ),
  denyGrant: h(async (req, res) =>
    ok(res, await grants.deny(req.ctx, sid(req), pid(req), v(req).body), 'Support access denied'),
  ),
  revokeGrantSociety: h(async (req, res) =>
    ok(
      res,
      await grants.revoke(req.ctx, pid(req), v(req).body, 'SOCIETY', sid(req)),
      'Support access revoked',
    ),
  ),
  consentSetting: h(async (req, res) => ok(res, await grants.getConsentSetting(sid(req)))),
  setConsentSetting: h(async (req, res) =>
    ok(res, await grants.setConsentSetting(req.ctx, sid(req), v(req).body), 'Setting saved'),
  ),
  societyExports: h(async (req, res) => {
    const r = await exportsSvc.listExports(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  societyCreateExport: h(async (req, res) =>
    created(
      res,
      await exportsSvc.requestExport(req.ctx, sid(req), { ...v(req).body, via: 'SOCIETY' }),
      'Export queued',
    ),
  ),
  societyExport: h(async (req, res) => ok(res, await exportsSvc.getExport(sid(req), pid(req)))),
  downloadUrl: h(async (req, res) =>
    ok(res, await exportsSvc.downloadUrl(req.ctx, sid(req), pid(req), v(req).query.part)),
  ),
};
