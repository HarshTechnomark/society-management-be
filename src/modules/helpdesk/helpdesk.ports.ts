import type { Transaction } from 'sequelize';
import { logger } from '../../lib/logger';
import { notify } from '../../lib/notify';
import type { Ctx } from '../../types/context';
import { placeholderFiles } from '../societies/societies.ports';
import { UnprocessableError } from '../../utils/errors';
import type { NotificationsPort } from '../billing/billing.ports';
import { ERR } from './helpdesk.constants';

export type { NotificationsPort };

/**
 * What module 15 needs from modules 16 (notifications), 20 (staff directory), 21 (vendors and work orders), 24 (reports cache) and
 * 27 (guard console), plus module 01 files. Each port has a placeholder that behaves as the spec describes and records its calls;
 * the owning module replaces it at start-up with `setHelpdeskPorts({...})` (tests do the same). Same pattern as `accounts.ports.ts`.
 * Module 11 (invoices), 08 (units, locations, holidays, settings), 09 (residents) and 10 (committee) are real and imported directly.
 */

// ------------------------------------------------------------------ module 20 staff directory
export interface StaffDirectoryPort {
  /** `staffDirectory.getSummary(societyId, staffId)` (BR-15-35). Placeholder: no staff exist. */
  getSummary(
    societyId: number,
    staffId: number,
  ): Promise<{
    id: number;
    name: string;
    status: 'ACTIVE' | 'INACTIVE';
    userId: number | null;
    mobile?: string | null;
  } | null>;
}

// ------------------------------------------------------------------ module 21 vendors and work orders
export interface VendorsPort {
  /** `vendors.getAssignable(societyId, vendorId)` (BR-15-35): ACTIVE vendors only. Placeholder: none. */
  getAssignable(societyId: number, vendorId: number): Promise<{ id: number; name: string } | null>;
  /** BR-15-53: vendors the user may act for. Placeholder: none. */
  vendorIdsForUser(societyId: number, userId: number): Promise<number[]>;
}
export interface WorkOrdersPort {
  /** BR-15-36: creates the work order of a VENDOR assignment. Placeholder: records and returns a fake id. */
  createFromTicket(
    ctx: Ctx,
    input: { ticketId: number; vendorId: number; title: string; priority: string; assetId?: number | null },
    t: Transaction,
  ): Promise<{ workOrderId: number }>;
  /** BR-15-22, BR-15-42: cancels a work order (merge, cancel, unassign). Placeholder: records. */
  cancel(ctx: Ctx, workOrderId: number, reason: string, t: Transaction): Promise<void>;
}

// ------------------------------------------------------------------ module 27 guard console
export interface GateConsolePort {
  /** BR-15-48: the safety alert after commit. Placeholder: records (the realtime event and notification are sent by module 15). */
  onDutyGuardUserIds(societyId: number): Promise<number[]>;
}

// ------------------------------------------------------------------ module 24 reports cache
export interface ReportsCachePort {
  touch(societyId: number, area: 'helpdesk'): void | Promise<void>;
}

// ------------------------------------------------------------------ module 01 files (BR-15-10, BR-15-39, BR-15-54)
export type TicketFileOwner = 'ticket' | 'ticket_comment';
export interface TicketFilesPort {
  /** Adds the files to the entity (purpose `TICKET_PHOTO` or `TICKET_ATTACHMENT`). Placeholder over the shared memory file store. */
  link(ctx: Ctx, fileIds: number[], owner: TicketFileOwner, ownerId: number, t: Transaction): Promise<void>;
  list(owner: TicketFileOwner, ownerId: number): number[];
}

export interface HelpdeskPorts {
  notifications: NotificationsPort;
  staffDirectory: StaffDirectoryPort;
  vendors: VendorsPort;
  workOrders: WorkOrdersPort;
  gateConsole: GateConsolePort;
  reportsCache: ReportsCachePort;
  files: TicketFilesPort;
}
export type HelpdeskPortName = keyof HelpdeskPorts;

export interface HelpdeskPortCall {
  fn: string;
  input: unknown;
  t?: Transaction;
}
/** Every call a placeholder received (tests assert the calls). */
export const helpdeskPortCalls: HelpdeskPortCall[] = [];
const record = (fn: string, input: unknown, t?: Transaction) => {
  helpdeskPortCalls.push({ fn, input, t });
};

/** Photos uploaded by residents, guards and staff are `TICKET_PHOTO`; the admin app uploads `TICKET_ATTACHMENT`: both link. */
export const TICKET_PURPOSES: readonly string[] = ['TICKET_PHOTO', 'TICKET_ATTACHMENT'];
/** `owner:ownerId` to file ids of the placeholder. */
export const placeholderTicketLinks = new Map<string, number[]>();
const linkKey = (o: TicketFileOwner, id: number) => `${o}:${id}`;
const notLinkable = () =>
  new UnprocessableError(ERR.fileNotLinkable, 'This file cannot be attached to a ticket', [
    { field: 'fileIds', message: 'Upload the photo again as a ticket photo' },
  ]);

let fakeWorkOrderId = 9000;

export const defaultHelpdeskPorts: HelpdeskPorts = {
  notifications: {
    send: async (template, userIds, data) => {
      record('notifications.send', { template, userIds, data });
      try {
        await notify(
          template,
          userIds.map(userId => ({ userId })),
          data,
        );
      } catch (err) {
        logger.error({ err, template }, 'helpdesk notify failed');
      }
    },
  },
  staffDirectory: { getSummary: async () => null },
  vendors: { getAssignable: async () => null, vendorIdsForUser: async () => [] },
  workOrders: {
    createFromTicket: async (_ctx, input, t) => {
      record('workOrders.createFromTicket', input, t);
      return { workOrderId: ++fakeWorkOrderId };
    },
    cancel: async (_ctx, workOrderId, reason, t) => record('workOrders.cancel', { workOrderId, reason }, t),
  },
  gateConsole: { onDutyGuardUserIds: async () => [] },
  reportsCache: { touch: (societyId, area) => record('reports.touch', { societyId, area }) },
  files: {
    async link(ctx, fileIds, owner, ownerId, t) {
      record('files.link', { fileIds, owner, ownerId }, t);
      const societyId = ctx.society?.id;
      const key = linkKey(owner, ownerId);
      const current = placeholderTicketLinks.get(key) ?? [];
      for (const fid of fileIds) {
        const f = placeholderFiles.get(fid);
        const elsewhere = [...placeholderTicketLinks.entries()].some(
          ([k, ids]) => k !== key && ids.includes(fid),
        );
        if (
          !f ||
          f.societyId !== societyId ||
          f.status !== 'CLEAN' ||
          !TICKET_PURPOSES.includes(f.purpose) ||
          elsewhere ||
          (!current.includes(fid) && f.ownerUserId !== ctx.user?.id)
        )
          throw notLinkable();
      }
      placeholderTicketLinks.set(key, [...new Set([...current, ...fileIds])]);
    },
    list: (owner, ownerId) => placeholderTicketLinks.get(linkKey(owner, ownerId)) ?? [],
  },
};

let current: HelpdeskPorts = defaultHelpdeskPorts;
const replaced = new Set<HelpdeskPortName>();
export const helpdeskPorts = (): HelpdeskPorts => current;

/** Replace some ports (the owner module at start-up, or tests). Pass nothing to restore the placeholders. */
export function setHelpdeskPorts(p?: { [K in keyof HelpdeskPorts]?: Partial<HelpdeskPorts[K]> }): void {
  if (!p) {
    current = defaultHelpdeskPorts;
    replaced.clear();
    helpdeskPortCalls.length = 0;
    placeholderTicketLinks.clear();
    return;
  }
  const next = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    next[k] = { ...(current as unknown as Record<string, object>)[k], ...v };
    replaced.add(k as HelpdeskPortName);
  }
  current = next as unknown as HelpdeskPorts;
}

/** Ports whose placeholder is not allowed in production (module 16 notifications and module 01 files). */
export const PRODUCTION_REQUIRED_PORTS: readonly HelpdeskPortName[] = ['notifications', 'files'];
export const fakePortsInUse = (): HelpdeskPortName[] =>
  PRODUCTION_REQUIRED_PORTS.filter(n => !replaced.has(n));
export function assertHelpdeskPortsReady(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if (nodeEnv !== 'production') return;
  const fakes = fakePortsInUse();
  if (fakes.length)
    throw new Error(`Helpdesk ports still use the placeholder in production: ${fakes.join(', ')}`);
}
