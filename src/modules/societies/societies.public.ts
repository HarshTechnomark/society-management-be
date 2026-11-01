/**
 * The module 05 functions other modules may import (section 8.25), and the start-up hook `registerSocieties()`.
 */
import type { Request } from 'express';
import {
  DataExport,
  Invitation,
  Role,
  Society,
  SocietyLifecycleEvent,
  SocietyMember,
  Subscription,
  SubscriptionAddon,
  SupportAccessGrant,
  UsageCounter,
  User,
  sequelize,
} from '../../models';
import { setAuthPorts } from '../auth/auth.ports';
import { setAccessPorts } from '../access-control/access-control.public';
import { setSubscriptionIntegrations } from '../subscriptions/subscriptions.public';
import * as lifecycle from './societies.lifecycle';
import * as support from './societies.support-access';
import { getHealth, listAtRiskSocieties } from './societies.health';
import {
  derivedSupportPermissions,
  isJobAllowed,
  routeMeta,
  societyStateGuard as guard,
  supportRequestGuard,
} from './societies.guard';
import { registerExportProvider, type ExportProvider } from './societies.exports';
import { registerPurgeHandler, registerRetentionExpiryHandler } from './societies.purge';
import { registerSocietyJobs } from './societies.jobs';
import type { SocietyStatus } from './societies.types';
import './societies.templates';

export {
  routeMeta,
  isJobAllowed,
  registerExportProvider,
  registerPurgeHandler,
  registerRetentionExpiryHandler,
};
export { setSocietyPorts } from './societies.ports';
export type { SocietyPorts } from './societies.ports';
export type { StatePolicy, JobTag } from './societies.types';

/** `societyStateGuard(req)`: throws `423 SOCIETY_SUSPENDED` / `423 SOCIETY_CLOSED` (module 03 middleware uses the pure form). */
export function societyStateGuard(req: Request): void {
  const status = req.ctx.society?.status;
  if (!status) return;
  const e = guard({ status, method: req.method, policy: req.routePolicy });
  if (e) throw e;
}

export const societyLifecycle = {
  getStatusInfo: lifecycle.getStatusInfo,
  societyStateGuard,
  isJobAllowed,
  onInvoiceOverdue: lifecycle.onInvoiceOverdue,
  onGraceExpired: lifecycle.onGraceExpired,
  onAccountCleared: lifecycle.onAccountCleared,
  onFirstInvoicePaid: lifecycle.onFirstInvoicePaid,
  getStatusAt: lifecycle.getStatusAt,
  trialConversionStats: lifecycle.trialConversionStats,
  listAtRiskSocieties,
  getHealth,
  closeForSubscriptionCancellation: lifecycle.closeForSubscriptionCancellation,
};

export const supportAccess = {
  getActiveGrant: support.getActiveGrant,
  validateForHandoff: support.validateForHandoff,
  markEntered: support.markEntered,
};

// ------------------------------------------------------------------ export providers for tables that predate the registry
async function* rowsOf<T>(load: () => Promise<T[]>, map: (r: T) => Record<string, unknown>) {
  for (const r of await load()) yield map(r);
}
const plain = (r: { get(o: { plain: true }): object }) => r.get({ plain: true }) as Record<string, unknown>;

/** Module 05 registers providers for its own tables and, on their behalf, for the module 03 and 04 society tables. */
export const BUILT_IN_PROVIDERS: ExportProvider[] = [
  {
    module: 'societies',
    tables: [
      {
        name: 'societies',
        file: 'society.csv',
        stream: id =>
          rowsOf(
            () => Society.findAll({ where: { id } }),
            s => {
              const p = plain(s);
              delete p.healthBreakdown;
              return p;
            },
          ),
      },
      {
        name: 'society_lifecycle_events',
        file: 'lifecycle_events.csv',
        stream: id =>
          rowsOf(
            () => SocietyLifecycleEvent.findAll({ where: { societyId: id }, order: [['id', 'ASC']] }),
            plain,
          ),
      },
      {
        name: 'support_access_grants',
        file: 'support_access_grants.csv',
        stream: id =>
          rowsOf(
            () => SupportAccessGrant.findAll({ where: { societyId: id }, order: [['id', 'ASC']] }),
            plain,
          ),
      },
      {
        name: 'data_exports',
        file: 'data_exports.csv',
        stream: id =>
          rowsOf(
            () => DataExport.findAll({ where: { societyId: id }, order: [['id', 'ASC']] }),
            e => {
              const p = plain(e);
              delete p.fileIds;
              return p;
            },
          ),
      },
    ],
  },
  {
    module: 'access-control',
    tables: [
      {
        name: 'roles',
        file: 'roles.csv',
        stream: id => rowsOf(() => Role.findAll({ where: { societyId: id }, order: [['id', 'ASC']] }), plain),
      },
      {
        name: 'society_members',
        file: 'members.csv',
        stream: id =>
          rowsOf(
            () =>
              SocietyMember.findAll({
                where: { societyId: id },
                include: [
                  { model: User, attributes: ['name', 'mobile', 'email'] },
                  { model: Role, attributes: ['key', 'name'] },
                ],
                order: [['id', 'ASC']],
              }),
            m => {
              const p = plain(m) as Record<string, unknown> & {
                User?: Record<string, unknown>;
                Role?: Record<string, unknown>;
              };
              const { User: u, Role: role, ...rest } = p;
              return {
                ...rest,
                name: u?.name,
                mobile: u?.mobile,
                email: u?.email,
                roleKey: role?.key,
                roleName: role?.name,
              };
            },
          ),
      },
      {
        name: 'invitations',
        file: 'invitations.csv',
        stream: id =>
          rowsOf(
            () => Invitation.findAll({ where: { societyId: id }, order: [['id', 'ASC']] }),
            i => {
              const p = plain(i);
              delete p.tokenHash;
              delete p.pendingSlot;
              return p;
            },
          ),
      },
    ],
  },
  {
    module: 'subscriptions',
    tables: [
      {
        name: 'subscriptions',
        file: 'subscriptions.csv',
        stream: id =>
          rowsOf(() => Subscription.findAll({ where: { societyId: id }, order: [['id', 'ASC']] }), plain),
      },
      {
        name: 'subscription_addons',
        file: 'subscription_addons.csv',
        stream: id =>
          rowsOf(
            () => SubscriptionAddon.findAll({ where: { societyId: id } as never, order: [['id', 'ASC']] }),
            plain,
          ),
      },
      {
        name: 'usage_counters',
        file: 'usage_counters.csv',
        stream: id =>
          rowsOf(() => UsageCounter.findAll({ where: { societyId: id }, order: [['id', 'ASC']] }), plain),
      },
    ],
  },
];

/** Module 03 personal data in invitations and memberships (purge, BR-05-21). Users themselves belong to module 02. */
async function purgeAccessControl(societyId: number) {
  return sequelize.transaction(async t => {
    const [inv] = await sequelize.query(
      `UPDATE invitations SET name = CONCAT('Former member #', id), email = NULL, message = NULL,
         locationLabel = NULL, mobile = '6000000000' WHERE societyId = :societyId AND mobile <> '6000000000'`,
      { replacements: { societyId }, transaction: t },
    );
    const [mem] = await sequelize.query(
      'UPDATE society_members SET locationLabel = NULL WHERE societyId = :societyId AND locationLabel IS NOT NULL',
      { replacements: { societyId }, transaction: t },
    );
    const n = (r: unknown) => Number((r as { affectedRows?: number })?.affectedRows ?? 0);
    return { deleted: 0, anonymised: n(inv) + n(mem) };
  });
}

let hooked = false;
/**
 * Start-up hook (like `registerAccessControl()` and `registerSubscriptions()`; call after them): gives module 02 the
 * real support hand-off port, module 03 the grant resolver, derived permissions, route checks and the read log, module 04
 * the lifecycle functions, and registers the built-in export providers, the module 03 purge handler and the jobs.
 */
export function registerSocieties(): void {
  setAuthPorts({
    supportAccess: {
      validateForHandoff: support.validateForHandoff,
      markEntered: support.markEntered,
      isGrantActive: support.isGrantActive,
      getGrantSummary: support.getGrantSummary,
    },
  });
  setAccessPorts({
    support: {
      getActiveGrant: support.getActiveGrant,
      permissionsFor: async (_societyId, scope) => derivedSupportPermissions(scope),
      checkRequest: ({ grant, method, policy }) =>
        supportRequestGuard({ scope: grant.scope, method, policy }),
      onRequest: support.onSupportRequest,
    },
  });
  setSubscriptionIntegrations({
    lifecycle: {
      closeForSubscriptionCancellation: lifecycle.closeForSubscriptionCancellation,
      getStatusInfo: async societyId => {
        const s = await lifecycle.getStatusInfo(societyId);
        return { status: s.status as SocietyStatus, cause: s.suspensionCause };
      },
    },
  });
  if (!hooked) {
    hooked = true;
    for (const p of BUILT_IN_PROVIDERS) registerExportProvider(p);
    registerPurgeHandler({
      module: 'access-control',
      order: 3,
      tables: ['invitations', 'society_members'],
      purge: purgeAccessControl,
    });
  }
  registerSocietyJobs();
}
