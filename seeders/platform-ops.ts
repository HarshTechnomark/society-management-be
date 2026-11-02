import {
  PlatformTicket,
  PlatformTicketMessage,
  Society,
  SocietyMember,
  User,
  sequelize,
} from '../src/models';
import type { TicketPriority, TicketStatus } from '../src/models/platform-ticket.model';
import { addDays, addHours, addMinutes, now } from '../src/lib/clock';
import { seedPlatformSettings } from '../src/modules/platform-ops/platform-ops.settings.service';
import { dueTimes } from '../src/modules/platform-ops/platform-ops.sla';
import { SETTINGS_REGISTRY } from '../src/modules/platform-ops/platform-ops.settings-registry';

/**
 * Module 07 seeds, part 1.
 * - `platform-settings` (all environments): every registry key with its default; existing values are never overwritten.
 * - Demo tickets (not production): the six prototype tickets on the demo societies, idempotent by society and subject.
 *
 * Not seeded yet (part 2 of module 07, section 7.8): the non-production providers (`sms_fake`, `whatsapp_fake`,
 * `email_fake`, `push_fake`, `pg_fake`, `storage_s3`, `ivr_fake`), the two demo incidents and the published
 * announcement "New billing run wizard is live". Their tables exist already (migrations 20261106000400 to 600).
 */
export const seedSettings = seedPlatformSettings;

interface DemoTicket {
  society: string;
  subject: string;
  category:
    | 'BILLING'
    | 'PAYMENTS'
    | 'TECHNICAL'
    | 'ONBOARDING'
    | 'ACCOUNT'
    | 'DATA_FIX'
    | 'FEATURE_REQUEST'
    | 'OTHER';
  priority: TicketPriority;
  status: TicketStatus;
  body: string;
  reply?: string;
  hoursAgo: number;
}

const DEMO: DemoTicket[] = [
  {
    society: 'sky-heights',
    subject: 'UPI AutoPay mandate failing for 3 members',
    category: 'PAYMENTS',
    priority: 'HIGH',
    status: 'OPEN',
    body: 'Three members say the mandate debit failed with "limit exceeded". Please check.',
    hoursAgo: 3,
  },
  {
    society: 'green-park',
    subject: 'WhatsApp reminders not delivered since Monday',
    category: 'TECHNICAL',
    priority: 'HIGH',
    status: 'IN_PROGRESS',
    body: 'Residents did not get the maintenance reminder on WhatsApp this week.',
    reply: 'We are looking at the WhatsApp provider delay and will update you shortly.',
    hoursAgo: 20,
  },
  {
    society: 'tulip-gardens',
    subject: 'How do we import flats from our old software?',
    category: 'ONBOARDING',
    priority: 'LOW',
    status: 'OPEN',
    body: 'We have a spreadsheet export from our old accounting software. How do we import the flats?',
    hoursAgo: 30,
  },
  {
    society: 'sky-heights',
    subject: 'Need a second guard console',
    category: 'FEATURE_REQUEST',
    priority: 'MEDIUM',
    status: 'WAITING',
    body: 'We have two gates and need a guard console at both of them.',
    reply: 'Which gate should be the second console, and how many guards use it?',
    hoursAgo: 50,
  },
  {
    society: 'green-park',
    subject: 'Receipt PDF shows wrong society name',
    category: 'DATA_FIX',
    priority: 'MEDIUM',
    status: 'RESOLVED',
    body: 'The receipt PDF shows our old society name in the header.',
    reply: 'Fixed. The name is corrected on all new receipts.',
    hoursAgo: 90,
  },
  {
    society: 'tulip-gardens',
    subject: 'Reactivate our society after payment',
    category: 'ACCOUNT',
    priority: 'HIGH',
    status: 'OPEN',
    body: 'We paid the pending invoice yesterday but the society is still suspended.',
    hoursAgo: 6,
  },
];

/** Non-production demo tickets. Returns the subjects created. */
export async function seedDemoTickets(): Promise<{ created: string[]; skipped: string[] }> {
  const out = { created: [] as string[], skipped: [] as string[] };
  const support = await User.findOne({ where: { email: 'support@societyapp.in' } });
  const sla = SETTINGS_REGISTRY['support.slaHours'].default;
  for (const d of DEMO) {
    const society = await Society.findOne({ where: { slug: d.society } });
    if (!society) continue;
    if (await PlatformTicket.findOne({ where: { societyId: society.id!, subject: d.subject } })) {
      out.skipped.push(d.subject);
      continue;
    }
    const member = await SocietyMember.findOne({
      where: { societyId: society.id!, status: 'ACTIVE' },
      include: [{ model: User, attributes: ['id', 'name'], required: true }],
      order: [['id', 'ASC']],
    });
    // Tulip Gardens only has an invited admin so far: the invited user raises its tickets
    const raiser = member
      ? (member as unknown as { User: User }).User
      : await User.findOne({ where: { email: 'admin@tulipgardens.in' } });
    if (!raiser) continue;
    const created = addHours(now(), -d.hoursAgo);
    const replied = d.status !== 'OPEN';
    const first = addMinutes(created, 40);
    const due = dueTimes(created, d.priority, sla);
    await sequelize.transaction(async t => {
      const tk = await PlatformTicket.create(
        {
          societyId: society.id!,
          raisedByUserId: raiser.id!,
          source: 'ADMIN_APP',
          subject: d.subject,
          category: d.category,
          priority: d.priority,
          status: d.status,
          assigneeUserId: replied && support ? support.id! : null,
          ...due,
          firstRespondedAt: replied ? first : null,
          firstResponseBreachedAt: null,
          resolutionWarnedAt: null,
          resolutionBreachedAt: null,
          waitingSince: d.status === 'WAITING' ? first : null,
          pausedMinutes: 0,
          resolvedAt: d.status === 'RESOLVED' ? addDays(now(), -1) : null,
          closedAt: null,
          closedReason: null,
          reopenCount: 0,
          lastMessageAt: replied ? first : created,
          lastSocietyMessageAt: created,
          lastPlatformMessageAt: replied ? first : null,
          messageCount: replied ? 2 : 1,
          satisfactionRating: null,
          satisfactionComment: null,
          ratedAt: null,
          version: 1,
          createdBy: raiser.id!,
          updatedBy: null,
          createdAt: created,
          updatedAt: replied ? first : created,
        },
        { transaction: t },
      );
      await PlatformTicketMessage.create(
        {
          ticketId: tk.id!,
          societyId: society.id!,
          authorUserId: raiser.id!,
          authorSide: 'SOCIETY',
          authorName: `${raiser.name ?? 'Member'}, ${society.name}`,
          kind: 'MESSAGE',
          visibility: 'PUBLIC',
          body: d.body,
          meta: null,
          attachmentCount: 0,
          createdAt: created,
          updatedAt: created,
        },
        { transaction: t },
      );
      if (replied && d.reply)
        await PlatformTicketMessage.create(
          {
            ticketId: tk.id!,
            societyId: society.id!,
            authorUserId: support?.id ?? null,
            authorSide: 'PLATFORM',
            authorName: support?.name ?? 'SocietyApp Support',
            kind: 'MESSAGE',
            visibility: 'PUBLIC',
            body: d.reply,
            meta: null,
            attachmentCount: 0,
            createdAt: first,
            updatedAt: first,
          },
          { transaction: t },
        );
    });
    out.created.push(d.subject);
  }
  return out;
}
