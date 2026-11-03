import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, noContent, ok, okList } from '../../utils/response';
import { assertUnitAccess } from '../access-control/access-control.public';
import * as residentSvc from './residents.service';
import * as links from './residents.links.service';
import * as invite from './residents.invite.service';
import * as docs from './residents.documents.service';
import * as unitsSvc from './residents.units.service';
import * as importSvc from './residents.import.service';
import * as exportSvc from './residents.export.service';
import * as household from './residents.household.service';
import * as pets from './residents.pets.service';
import * as emergency from './residents.emergency.service';
import * as directory from './residents.directory.service';
import { linkDtos } from './residents.dto';
import { UnitResident } from '../../models';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;

export const residentController = {
  // ---- flats, timeline, statistics (8.3, 8.4)
  listFlats: h(async (req, res) => {
    const r = await unitsSvc.listFlats(req.ctx, sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  unitPanel: h(async (req, res) =>
    ok(
      res,
      await unitsSvc.unitPanel(req.ctx, sid(req), v(req).params.unitId, {
        reveal: v(req).query.reveal === 'contacts',
      }),
    ),
  ),
  timeline: h(async (req, res) => ok(res, await unitsSvc.unitTimeline(sid(req), v(req).params.unitId))),
  stats: h(async (req, res) => ok(res, await unitsSvc.residentStats(sid(req)))),

  // ---- residents (8.2, 8.5, 8.6, 8.7)
  list: h(async (req, res) => {
    const r = await residentSvc.listResidents(req.ctx, sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  create: h(async (req, res) =>
    created(res, await residentSvc.createResident(req.ctx, sid(req), v(req).body), 'Resident added'),
  ),
  get: h(async (req, res) =>
    ok(
      res,
      await residentSvc.getResident(req.ctx, sid(req), v(req).params.id, {
        reveal: v(req).query.reveal === 'contacts',
      }),
    ),
  ),
  patch: h(async (req, res) =>
    ok(
      res,
      await residentSvc.patchResident(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Resident saved',
    ),
  ),
  remove: h(async (req, res) => {
    await residentSvc.deleteResident(req.ctx, sid(req), v(req).params.id, v(req).body);
    noContent(res);
  }),
  invite: h(async (req, res) =>
    ok(res, await invite.inviteResident(req.ctx, sid(req), v(req).params.id, v(req).body), 'Invitation sent'),
  ),

  // ---- links (8.8 to 8.10)
  addLink: h(async (req, res) =>
    created(
      res,
      await residentSvc.addLinkToResident(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Link added',
    ),
  ),
  patchLink: h(async (req, res) => {
    const l = await links.patchLink(req.ctx, sid(req), v(req).params.linkId, v(req).body);
    ok(res, (await linkDtos(sid(req), [l]))[0], 'Link saved');
  }),
  endLink: h(async (req, res) => {
    const id = v(req).params.linkId as number;
    await links.endLink(req.ctx, sid(req), id, v(req).body);
    const l = await UnitResident.findOne({ where: { id, societyId: sid(req) } });
    ok(res, (await linkDtos(sid(req), [l!]))[0], 'Link ended');
  }),
  shares: h(async (req, res) => {
    const unitId = v(req).params.unitId as number;
    await links.setOwnershipShares(req.ctx, sid(req), unitId, v(req).body);
    ok(res, await residentSvc.ownersOfUnit(sid(req), unitId), 'Shares saved');
  }),
  vacate: h(async (req, res) =>
    ok(
      res,
      await links.vacateUnit(req.ctx, sid(req), v(req).params.unitId, v(req).body),
      'Flat marked vacant',
    ),
  ),

  // ---- documents (8.11)
  listDocs: h(async (req, res) => ok(res, await docs.listDocuments(sid(req), v(req).params.id))),
  addDoc: h(async (req, res) =>
    created(
      res,
      await docs.uploadDocument(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Document added',
    ),
  ),
  verifyDoc: h(async (req, res) =>
    ok(
      res,
      await docs.verifyDocument(req.ctx, sid(req), v(req).params.docId, v(req).body),
      'Document checked',
    ),
  ),
  deleteDoc: h(async (req, res) => {
    await docs.deleteDocument(req.ctx, sid(req), v(req).params.docId, v(req).body.reason);
    noContent(res);
  }),
  docUrl: h(async (req, res) =>
    ok(res, await docs.downloadUrl(req.ctx, sid(req), v(req).params.docId, v(req).query.disposition)),
  ),
  myDocUrl: h(async (req, res) =>
    ok(
      res,
      await docs.downloadUrl(req.ctx, sid(req), v(req).params.docId, v(req).query.disposition, {
        ownOnly: true,
      }),
    ),
  ),

  // ---- export and import (8.12)
  exportCsv: h(async (req, res) => ok(res, await exportSvc.exportResidents(req.ctx, sid(req), v(req).query))),
  startImport: h(async (req, res) =>
    ok(res, await importSvc.startImport(req.ctx, sid(req), v(req).body), 'Import started', 202),
  ),
  getImport: h(async (req, res) =>
    ok(res, await importSvc.getImport(sid(req), req.ctx.user!.id, v(req).params.jobId)),
  ),

  // ---- pets, emergency profiles (8.19, 8.20)
  listPets: h(async (req, res) => {
    const r = await pets.listPets(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  sosProfiles: h(async (req, res) => ok(res, await emergency.forSos(req.ctx, v(req).params.sosId))),

  // ---- resident app: household (8.18)
  myHousehold: h(async (req, res) => ok(res, await household.myHousehold(req.ctx, sid(req)))),
  addMember: h(async (req, res) =>
    created(res, await household.addMember(req.ctx, sid(req), v(req).body), 'Member added'),
  ),
  patchMember: h(async (req, res) =>
    ok(
      res,
      await household.patchMember(req.ctx, sid(req), v(req).params.linkId, v(req).body),
      'Member saved',
    ),
  ),
  removeMember: h(async (req, res) => {
    await household.removeMember(req.ctx, sid(req), v(req).params.linkId, v(req).body.reason);
    noContent(res);
  }),
  inviteMember: h(async (req, res) =>
    ok(
      res,
      await household.inviteMember(req.ctx, sid(req), v(req).params.linkId, v(req).body),
      'Invitation sent',
    ),
  ),
  memberEmergency: h(async (req, res) =>
    ok(
      res,
      await household.saveMemberEmergency(req.ctx, sid(req), v(req).params.linkId, v(req).body),
      'Emergency profile saved',
    ),
  ),
  portfolio: h(async (req, res) => ok(res, await unitsSvc.portfolio(req.ctx, sid(req)))),

  // ---- resident app: pets, own profile, privacy, directory, documents
  myPets: h(async (req, res) => ok(res, await pets.listMine(req.ctx, sid(req)))),
  createPet: h(async (req, res) => {
    const { unitId, ...fields } = v(req).body;
    created(res, await pets.createPet(req.ctx, sid(req), unitId, fields), 'Pet registered');
  }),
  patchPet: h(async (req, res) =>
    ok(res, await pets.patchPet(req.ctx, sid(req), v(req).params.id, v(req).body), 'Pet saved'),
  ),
  deletePet: h(async (req, res) => {
    await pets.deletePet(req.ctx, sid(req), v(req).params.id);
    noContent(res);
  }),
  myEmergency: h(async (req, res) => {
    const own = await residentSvc.ownResident(req.ctx, sid(req));
    ok(res, await emergency.getProfile(sid(req), own.id!));
  }),
  saveMyEmergency: h(async (req, res) => {
    const own = await residentSvc.ownResident(req.ctx, sid(req));
    ok(res, await emergency.saveProfile(req.ctx, sid(req), own, v(req).body), 'Emergency profile saved');
  }),
  getPrivacy: h(async (req, res) => ok(res, await directory.getPrivacy(req.ctx, sid(req)))),
  patchPrivacy: h(async (req, res) =>
    ok(res, await directory.patchPrivacy(req.ctx, sid(req), v(req).body), 'Settings saved'),
  ),
  directory: h(async (req, res) => {
    const r = await directory.listDirectory(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  myDocs: h(async (req, res) => {
    const own = await residentSvc.ownResident(req.ctx, sid(req));
    ok(res, await docs.listDocuments(sid(req), own.id!));
  }),
  addMyDoc: h(async (req, res) => {
    const own = await residentSvc.ownResident(req.ctx, sid(req));
    const body = v(req).body;
    if (body.unitId) assertUnitAccess(req.ctx, body.unitId, 'UNIT_NOT_FOUND');
    created(res, await docs.uploadDocument(req.ctx, sid(req), own.id!, body), 'Document added');
  }),
};
