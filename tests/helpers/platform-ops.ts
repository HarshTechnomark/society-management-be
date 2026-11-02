import { PlatformTicket, PlatformTicketMessage, Society, User, sequelize } from '../../src/models';
import type { TicketCategory, TicketPriority, TicketStatus } from '../../src/models/platform-ticket.model';
import { now } from '../../src/lib/clock';
import { drainQueues } from '../../src/lib/queue';
import { setBillingSettingsSource } from '../../src/modules/platform-billing/platform-billing.public';
import { registerPlatformOps } from '../../src/modules/platform-ops/platform-ops.public';
import { setPlatformOpsPorts } from '../../src/modules/platform-ops/platform-ops.ports';
import { dueTimes } from '../../src/modules/platform-ops/platform-ops.sla';
import { SETTINGS_REGISTRY } from '../../src/modules/platform-ops/platform-ops.settings-registry';
import { placeholderFiles } from '../../src/modules/societies/societies.ports';
import { memberUser } from './access';
import { lifecycleSociety, resetSocieties } from './societies';

/** Fresh state with the real module 02 to 06 ports and the module 07 settings source and jobs registered. */
export async function resetOps(): Promise<void> {
  setBillingSettingsSource();
  setPlatformOpsPorts();
  await resetSocieties();
  registerPlatformOps();
  await drainQueues();
}

/** A ticket row inserted directly (for tests that do not exercise the create route). */
export async function insertTicket(
  society: Society,
  raiser: { id: number },
  o: {
    status?: TicketStatus;
    priority?: TicketPriority;
    category?: TicketCategory;
    subject?: string;
    createdAt?: Date;
    assigneeUserId?: number | null;
    withPlatformReply?: boolean;
    patch?: Record<string, unknown>;
  } = {},
): Promise<PlatformTicket> {
  const created = o.createdAt ?? now();
  const priority = o.priority ?? 'MEDIUM';
  const t = await PlatformTicket.create({
    societyId: society.id!,
    raisedByUserId: raiser.id,
    source: 'ADMIN_APP',
    subject: o.subject ?? 'Receipt PDF shows wrong society name',
    category: o.category ?? 'TECHNICAL',
    priority,
    status: o.status ?? 'OPEN',
    assigneeUserId: o.assigneeUserId ?? null,
    ...dueTimes(created, priority, SETTINGS_REGISTRY['support.slaHours'].default),
    firstRespondedAt: null,
    firstResponseBreachedAt: null,
    resolutionWarnedAt: null,
    resolutionBreachedAt: null,
    waitingSince: null,
    pausedMinutes: 0,
    resolvedAt: null,
    closedAt: null,
    closedReason: null,
    reopenCount: 0,
    lastMessageAt: created,
    lastSocietyMessageAt: created,
    lastPlatformMessageAt: null,
    messageCount: 1,
    satisfactionRating: null,
    satisfactionComment: null,
    ratedAt: null,
    version: 1,
    createdBy: raiser.id,
    updatedBy: null,
    createdAt: created,
    updatedAt: created,
    ...(o.patch as object),
  });
  await PlatformTicketMessage.create({
    ticketId: t.id!,
    societyId: society.id!,
    authorUserId: raiser.id,
    authorSide: 'SOCIETY',
    authorName: 'Meera Iyer, Treasurer, Sky Heights CHS',
    kind: 'MESSAGE',
    visibility: 'PUBLIC',
    body: 'The receipt PDF shows our old society name in the header.',
    meta: null,
    attachmentCount: 0,
    createdAt: created,
    updatedAt: created,
  });
  if (o.withPlatformReply)
    await PlatformTicketMessage.create({
      ticketId: t.id!,
      societyId: society.id!,
      authorUserId: null,
      authorSide: 'PLATFORM',
      authorName: 'Isha Kapoor',
      kind: 'MESSAGE',
      visibility: 'PUBLIC',
      body: 'We are looking into it.',
      meta: null,
      attachmentCount: 0,
      createdAt: created,
      updatedAt: created,
    });
  return t;
}

/** A treasurer of the society (holds `settings.support.view` and `create`). */
export const treasurer = (society: Society, name = 'Meera Iyer') =>
  memberUser(society, 'treasurer', { name });

/** A clean `PLATFORM_ATTACHMENT` file in the placeholder store. */
export function placeholderAttachment(
  id: number,
  ownerUserId: number,
  societyId: number | null = null,
): number {
  placeholderFiles.set(id, {
    fileId: id,
    societyId,
    purpose: 'PLATFORM_ATTACHMENT',
    name: 'mandate-error.png',
    contentType: 'image/png',
    content: Buffer.from('png'),
    ownerUserId,
    status: 'CLEAN',
  });
  return id;
}

export async function activeUser(id: number): Promise<User> {
  return (await User.findByPk(id))!;
}

export const countRows = async (table: string, where = '1=1'): Promise<number> => {
  const [rows] = await sequelize.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`);
  return Number((rows as { n: number }[])[0]!.n);
};

/** A society with a subscription (Premium, so seats never run out) in the given lifecycle status. */
export const opsSociety = (
  name = 'Sky Heights CHS',
  status: 'ACTIVE' | 'SUSPENDED' | 'TRIAL' | 'CLOSED' = 'ACTIVE',
) =>
  lifecycleSociety(status, {
    name,
    plan: 'PREMIUM',
    ...(status === 'SUSPENDED' ? { cause: 'MANUAL' as const } : {}),
  });
