import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, okList } from '../../utils/response';
import * as platformTickets from './platform-ops.tickets.service';
import * as societyTickets from './platform-ops.tickets.society';
import * as settings from './platform-ops.settings.service';
import * as orgs from './platform-ops.organizations.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const pid = (req: Request): number => req.valid.params.id;

export const platformOpsController = {
  // ---- 8.3 platform tickets
  listTickets: h(async (req, res) => {
    const r = await platformTickets.listTickets(req.ctx, v(req).query);
    okList(res, r.data as never, r.pagination);
  }),
  getTicket: h(async (req, res) => ok(res, await platformTickets.getTicket(req.ctx, pid(req)))),
  createTicket: h(async (req, res) =>
    created(res, await platformTickets.createTicket(req.ctx, v(req).body), 'Ticket raised'),
  ),
  patchTicket: h(async (req, res) =>
    ok(res, await platformTickets.updateTicket(req.ctx, pid(req), v(req).body), 'Ticket updated'),
  ),
  platformMessage: h(async (req, res) =>
    created(res, await platformTickets.addPlatformMessage(req.ctx, pid(req), v(req).body), 'Message sent'),
  ),

  // ---- 8.4 society tickets
  listSocietyTickets: h(async (req, res) => {
    const r = await societyTickets.listTickets(req.ctx, v(req).query);
    okList(res, r.data, r.pagination);
  }),
  createSocietyTicket: h(async (req, res) =>
    created(
      res,
      await societyTickets.createTicket(req.ctx, v(req).body),
      'Request sent to SocietyApp support',
    ),
  ),
  getSocietyTicket: h(async (req, res) => ok(res, await societyTickets.getTicket(req.ctx, pid(req)))),
  societyMessage: h(async (req, res) =>
    created(res, await societyTickets.addMessage(req.ctx, pid(req), v(req).body), 'Message sent'),
  ),
  reopen: h(async (req, res) =>
    ok(res, await societyTickets.reopenTicket(req.ctx, pid(req), v(req).body), 'Ticket reopened'),
  ),
  close: h(async (req, res) =>
    ok(res, await societyTickets.closeTicket(req.ctx, pid(req), v(req).body), 'Ticket closed'),
  ),
  rate: h(async (req, res) =>
    ok(res, await societyTickets.rateTicket(req.ctx, pid(req), v(req).body), 'Thanks for the feedback'),
  ),

  // ---- 8.10 settings
  listSettings: h(async (_req, res) => ok(res, await settings.listSettings())),
  patchSettings: h(async (req, res) =>
    ok(res, await settings.updateSettings(req.ctx, v(req).body), 'Settings saved'),
  ),

  // ---- 8.12 organizations
  listOrganizations: h(async (req, res) => {
    const r = await orgs.listOrganizations(v(req).query);
    okList(res, r.data, r.pagination);
  }),
  getOrganization: h(async (req, res) => ok(res, await orgs.getOrganization(pid(req)))),
  createOrganization: h(async (req, res) =>
    created(res, await orgs.createOrganization(req.ctx, v(req).body), 'Organization created'),
  ),
  updateOrganization: h(async (req, res) =>
    ok(res, await orgs.updateOrganization(req.ctx, pid(req), v(req).body), 'Organization saved'),
  ),
  organizationStatus: h(async (req, res) =>
    ok(res, await orgs.setOrganizationStatus(req.ctx, pid(req), v(req).body), 'Organization updated'),
  ),
};
