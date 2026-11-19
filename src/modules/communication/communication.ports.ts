import type { Transaction } from 'sequelize';
import { recordInbox } from '../../lib/inbox';
import type { Ctx } from '../../types/context';
import { placeholderFiles } from '../societies/societies.ports';
import type { Channel } from './communication.constants';

/**
 * What module 16 needs from other modules that do not exist yet (or whose public API it must not hard-wire): push delivery (VAPID),
 * the module 07 provider resolver, module 12 collections, modules 22 and 26 targets, module 27 guards on duty and module 01 files.
 * Each port has a placeholder that behaves as the spec describes and records its calls; the owning module replaces it at start-up
 * with `setCommunicationPorts({...})` (tests do the same). Same pattern as `helpdesk.ports.ts`.
 * Modules 03 (members, permissions), 04 (entitlements), 08 (settings, units), 09 (residents) and 14 (approvals) are real and imported directly.
 */
export interface PushPayload {
  title: string;
  body: string;
  url: string | null;
  tag: string;
  requireInteraction: boolean;
}
export interface PushTarget {
  id: number;
  endpoint: string;
  p256dh: string;
  authSecret: string;
}
export type PushResult =
  { ok: true; providerMessageId: string } | { ok: false; gone: boolean; error: string };
export interface PushPort {
  /** Web Push send (BR-16-30). Placeholder: records the call and shows it in the dev inbox (channel PUSH). `to` is `user:<id>`. */
  send(
    target: PushTarget,
    payload: PushPayload,
    opts: { urgency: 'high' | 'normal'; ttlSeconds: number },
    userId: number,
  ): Promise<PushResult>;
  /** The VAPID public key, or null when not configured (`503 PUSH_NOT_CONFIGURED`). */
  publicKey(): string | null;
}

export interface ProvidersPort {
  /** Module 07 `resolveProvider(channel)` (BR-16-28). Placeholder: the fake provider. */
  resolve(channel: Channel): Promise<{ providerKey: string } | null>;
}

export interface CollectionsPort {
  /** Module 12 `collections.get()` for `PAY_COLLECTION` actions (BR-16-13). Placeholder: reads nothing, so the action is refused. */
  get(societyId: number, collectionId: number): Promise<{ id: number; status: string; title: string } | null>;
}
export interface TargetsPort {
  /** Module 22 poll (`VOTE`) or module 26 event (`RSVP`) is open. Placeholder: does not exist. */
  isOpen(kind: 'VOTE' | 'RSVP', societyId: number, refId: number): Promise<boolean>;
}
export interface GuardsPort {
  /** Module 27: user ids of guards on duty now (emergency help requests). Placeholder: none; active gate members are used instead. */
  onDutyGuardUserIds(societyId: number): Promise<number[]>;
}
export type NoticeFileOwner = 'notice';
export interface NoticeFilesPort {
  /** Links `NOTICE_ATTACHMENT` files (BR-16-1: all must be CLEAN). Placeholder over the shared memory file store. */
  link(ctx: Ctx, fileIds: number[], noticeId: number, t: Transaction): Promise<void>;
  list(noticeId: number): number[];
  /** Unlinks files from a notice (16.1 PATCH `fileIds` is the full new list). Placeholder: forgets the link. */
  unlink(ctx: Ctx, fileIds: number[], noticeId: number, t: Transaction): Promise<void>;
  /** Name, size and scan status of a file of the society (null when unknown or deleted). Placeholder reads the shared memory file store. */
  describe(
    societyId: number,
    fileId: number,
  ): Promise<{ name: string; sizeBytes: number; status: string } | null>;
}

export interface CommunicationPorts {
  push: PushPort;
  providers: ProvidersPort;
  collections: CollectionsPort;
  targets: TargetsPort;
  guards: GuardsPort;
  files: NoticeFilesPort;
}
export type CommunicationPortName = keyof CommunicationPorts;

export interface CommunicationPortCall {
  fn: string;
  input: unknown;
}
/** Every call a placeholder received (tests assert the calls). */
export const communicationPortCalls: CommunicationPortCall[] = [];
const record = (fn: string, input: unknown) => {
  communicationPortCalls.push({ fn, input });
};

export const placeholderNoticeLinks = new Map<number, number[]>();

export const defaultCommunicationPorts: CommunicationPorts = {
  push: {
    async send(target, payload, opts, userId) {
      record('push.send', { target: target.id, payload, opts });
      await recordInbox({
        channel: 'PUSH',
        to: `user:${userId}`,
        subject: payload.title,
        body: payload.body,
        link: payload.url,
        templateKey: payload.tag,
      });
      return { ok: true, providerMessageId: `fake-push-${target.id}-${Date.now()}` };
    },
    publicKey: () => 'BFAKEVAPIDPUBLICKEYFORDEVELOPMENTONLY',
  },
  providers: { resolve: async () => ({ providerKey: 'fake' }) },
  collections: { get: async () => null },
  targets: { isOpen: async () => false },
  guards: { onDutyGuardUserIds: async () => [] },
  files: {
    async link(_ctx, fileIds, noticeId, t) {
      record('files.link', { fileIds, noticeId });
      for (const fid of fileIds) {
        const f = placeholderFiles.get(fid);
        if (!f) throw new Error(`placeholder file ${fid} not found`);
      }
      placeholderNoticeLinks.set(noticeId, [
        ...new Set([...(placeholderNoticeLinks.get(noticeId) ?? []), ...fileIds]),
      ]);
      void t;
    },
    list: noticeId => placeholderNoticeLinks.get(noticeId) ?? [],
    async unlink(_ctx, fileIds, noticeId, t) {
      record('files.unlink', { fileIds, noticeId });
      placeholderNoticeLinks.set(
        noticeId,
        (placeholderNoticeLinks.get(noticeId) ?? []).filter(f => !fileIds.includes(f)),
      );
      void t;
    },
    async describe(societyId, fileId) {
      const f = placeholderFiles.get(fileId);
      if (!f || f.societyId !== societyId || f.status === 'DELETED') return null;
      return { name: f.name, sizeBytes: f.content.length, status: f.status };
    },
  },
};

let current: CommunicationPorts = defaultCommunicationPorts;
const replaced = new Set<CommunicationPortName>();
export const communicationPorts = (): CommunicationPorts => current;

/** Replace some ports (the owner module at start-up, or tests). Pass nothing to restore the placeholders. */
export function setCommunicationPorts(p?: {
  [K in keyof CommunicationPorts]?: Partial<CommunicationPorts[K]>;
}): void {
  if (!p) {
    current = defaultCommunicationPorts;
    replaced.clear();
    communicationPortCalls.length = 0;
    placeholderNoticeLinks.clear();
    return;
  }
  const next = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    next[k] = { ...(current as unknown as Record<string, object>)[k], ...v };
    replaced.add(k as CommunicationPortName);
  }
  current = next as unknown as CommunicationPorts;
}

/** Ports whose placeholder is not allowed in production (real push delivery and module 01 files). */
export const PRODUCTION_REQUIRED_PORTS: readonly CommunicationPortName[] = ['push', 'files'];
export const fakePortsInUse = (): CommunicationPortName[] =>
  PRODUCTION_REQUIRED_PORTS.filter(n => !replaced.has(n));
export function assertCommunicationPortsReady(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if (nodeEnv !== 'production') return;
  const fakes = fakePortsInUse();
  if (fakes.length)
    throw new Error(`Communication ports still use the placeholder in production: ${fakes.join(', ')}`);
}
