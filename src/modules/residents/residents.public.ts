/**
 * The module 09 functions other modules may import (section 8.22), and the start-up hook `registerResidents()`.
 * Modules 02, 03, 08, 11, 12, 13, 16, 17, 19 to 27 read people and unit links only through this file. Parts 2 and 3 of
 * module 09 add the move, renovation, tenancy report and deposit functions here.
 */
import { Op } from 'sequelize';
import { Unit, UnitResident } from '../../models';
import { setAuthPorts } from '../auth/auth.ports';
import { setAccessPorts } from '../access-control/access-control.public';
import { registerExportProvider, registerPurgeHandler } from '../societies/societies.public';
import { onboarding, setSetupPorts, units } from '../society-setup/society-setup.public';
import { onUserAnonymised, onUserMobileChanged } from './residents.hooks';
import { onResidentInvitationAccepted, sendWelcomeInvites } from './residents.invite.service';
import { forSos } from './residents.emergency.service';
import { registerResidentsJobs } from './residents.jobs';
import { PURGE_TABLES, purgeResidents } from './residents.purge';
import { residentsExportProvider } from './residents.exports';
import { hasOpenPeopleOrRequests } from './residents.requests';
import { societyToday } from './residents.shared';
import {
  activeLinkCount,
  audienceUserIds,
  billToFor,
  changedSince,
  getActiveUnitLinks,
  getHouseholdControl,
  getSummary,
  listForUnit,
  occupancyOf,
  unitIdsForUser,
  visitorApproverUserIds,
} from './residents.queries';
import './residents.templates';
import './residents.part3.templates';
import { registerPart3Approvals } from './residents.part3.approvals-hook';
import { registerPart3Jobs } from './residents.part3.jobs';
import {
  isWorkDay,
  listForGate as permitsForGate,
  onRenovationDepositPaid,
  onRenovationDepositRefunded,
  passValidAt,
} from './residents.renovations.service';

export const residents = {
  listForUnit,
  changedSince,
  sendWelcomeInvites,
  billToFor,
  unitIdsForUser,
  getActiveUnitLinks,
  visitorApproverUserIds,
  audienceUserIds,
  activeLinkCount,
  occupancyOf,
  getSummary,
};
export { getHouseholdControl, onResidentInvitationAccepted };
/** Hooks module 02 calls (and, in part 2, module 13 deposit callbacks). */
export const residentsHooks = { onUserMobileChanged, onUserAnonymised };
export const emergencyProfiles = { forSos };

export { setResidentPorts } from './residents.ports';
export type { ResidentPorts } from './residents.ports';
export { registerSyncStep } from './residents.jobs';
export { createLink, endLinks, repairOwners, lockLinks, liveTenancyOf } from './residents.links.service';
export { syncMembership } from './residents.sync';
export { attachDocuments } from './residents.documents.service';
export { createResident } from './residents.service';
export { inviteResidentTx } from './residents.invite.service';
export type { ListedLink, BillTo } from './residents.queries';

/** Section 8.24: ACTIVE units that have an active OWNER or CO_OWNER link today. */
async function countUnitsWithActiveOwner(societyId: number): Promise<number> {
  const today = await societyToday(societyId);
  const links = await UnitResident.findAll({
    where: {
      societyId,
      relation: { [Op.in]: ['OWNER', 'CO_OWNER'] },
      fromDate: { [Op.lte]: today },
      [Op.or]: [{ toDate: null }, { toDate: { [Op.gte]: today } }],
    },
    attributes: ['unitId'],
  });
  const ids = [...new Set(links.map(l => l.unitId))];
  if (!ids.length) return 0;
  return Unit.count({ where: { societyId, status: 'ACTIVE', id: { [Op.in]: ids } } });
}

/**
 * Start-up hook (call after `registerAccessControl()`, `registerSubscriptions()`, `registerSocieties()` and
 * `registerSocietySetup()`; done in `server.ts`, `worker.ts` and `npm run seed`): module 02 hooks, module 03 unit-link
 * port, module 08 welcome invites, onboarding check and unit guard, module 05 export provider and purge handler, and jobs.
 */
export function registerResidents(): void {
  setAuthPorts({ residentsHooks: { onUserMobileChanged, onUserAnonymised } });
  setAccessPorts({
    residents: {
      getActiveUnitLinks,
      onResidentInvitationAccepted,
      getUnitLabels: async (societyId, unitIds) => {
        const rows = await Unit.findAll({
          where: { societyId, id: { [Op.in]: unitIds } },
          attributes: ['id', 'label'],
        });
        return Object.fromEntries(rows.map(u => [u.id!, u.label]));
      },
    },
  });
  setSetupPorts({
    residents: {
      sendWelcomeInvites: async (ctx, societyId) => {
        await sendWelcomeInvites(ctx, societyId);
      },
    },
  });
  onboarding.registerCheck('RESIDENTS', 'residents', async societyId => {
    const n = await countUnitsWithActiveOwner(societyId);
    const total = await units.count(societyId);
    return { done: n > 0, summary: n > 0 ? `${n} of ${total} flats have an owner` : 'No owners linked yet' };
  });
  units.registerUnitGuard({
    module: 'residents',
    check: async (societyId, unitId, _action, t) =>
      (await hasOpenPeopleOrRequests(societyId, unitId, t)) ? 'UNIT_HAS_RESIDENTS' : null,
  });
  registerExportProvider(residentsExportProvider);
  registerPurgeHandler({ module: 'residents', order: 9, tables: PURGE_TABLES, purge: purgeResidents });
  registerResidentsJobs();
  registerPart3Jobs();
  registerPart3Approvals();
}

// ---- part 3: renovation permits and ownership transfers
export const renovationPermits = {
  listForGate: permitsForGate,
  passValidAt,
  isWorkDay,
  /** Module 13 calls these for `refType = 'renovation_permit'` (part 2 routes `move_request` in `residentsHooks`). */
  onDepositPaid: onRenovationDepositPaid,
  onDepositRefunded: onRenovationDepositRefunded,
};
export { setResidentPart3Ports } from './residents.part3.ports';
export type { ResidentPart3Ports } from './residents.part3.ports';
export { permitApprovals } from './residents.renovations.service';
export { transferApprovals } from './residents.transfers.service';
export {
  approve as approvePart3Request,
  reject as rejectPart3Request,
} from './residents.part3.approvals-hook';
