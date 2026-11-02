import {
  Incident,
  PlatformNotification,
  PlatformTicket,
  ServiceProvider,
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
 * Part 2 adds, outside production and idempotently: the providers `sms_fake`, `whatsapp_fake`, `email_fake`, `push_fake`,
 * `pg_fake`, `storage_s3` and `ivr_fake`, the two demo incidents and the published announcement "New billing run wizard
 * is live" (section 7.8).
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

// ------------------------------------------------------------------ part 2: providers, incidents, announcement
const DEMO_PROVIDERS = [
  {
    key: 'sms_fake',
    channel: 'SMS',
    vendor: 'FAKE',
    name: 'SMS gateway (DLT)',
    description: 'OTP and alerts',
  },
  {
    key: 'whatsapp_fake',
    channel: 'WHATSAPP',
    vendor: 'FAKE',
    name: 'WhatsApp Business API',
    description: 'Reminders and receipts',
  },
  {
    key: 'email_fake',
    channel: 'EMAIL',
    vendor: 'FAKE',
    name: 'Email (SES)',
    description: 'Invoices and notices',
  },
  { key: 'push_fake', channel: 'PUSH', vendor: 'FAKE', name: 'Push notifications', description: 'Web push' },
  {
    key: 'pg_fake',
    channel: 'PAYMENT_GATEWAY',
    vendor: 'FAKE',
    name: 'Payment gateway',
    description: 'Platform invoices',
  },
  {
    key: 'storage_s3',
    channel: 'STORAGE',
    vendor: 'S3_COMPATIBLE',
    name: 'Object storage (S3)',
    description: 'Documents and photos',
  },
  {
    key: 'ivr_fake',
    channel: 'IVR',
    vendor: 'FAKE',
    name: 'IVR and call bridge',
    description: 'Visitor calls',
  },
] as const;

export async function seedDemoProviders(): Promise<{ created: string[]; skipped: string[] }> {
  const out = { created: [] as string[], skipped: [] as string[] };
  for (const d of DEMO_PROVIDERS) {
    if (
      await ServiceProvider.findOne({ where: { providerKey: d.key }, paranoid: false, attributes: ['id'] })
    ) {
      out.skipped.push(d.key);
      continue;
    }
    const at = now();
    await ServiceProvider.create({
      providerKey: d.key,
      channel: d.channel,
      vendor: d.vendor,
      displayName: d.name,
      description: d.description,
      isEnabled: true,
      priority: 1,
      credentialsSource: 'ENV',
      configJson: d.vendor === 'FAKE' ? { failMode: 'none' } : {},
      credentialsEnc: null,
      credentialsIv: null,
      credentialsTag: null,
      credentialsKeyVersion: null,
      credentialsMasked: null,
      credentialsUpdatedAt: null,
      credentialsUpdatedBy: null,
      healthStatus: 'OPERATIONAL',
      statusMode: 'AUTOMATIC',
      statusReason: null,
      statusChangedAt: at,
      consecutiveFailures: 0,
      degradedLatencyMs: 3000,
      lastCheckAt: at,
      lastCheckOk: true,
      lastCheckLatencyMs: 120,
      lastCheckError: null,
      uptime30dPct: '99.950',
      lastTestAt: null,
      lastTestOk: null,
      lastTestBy: null,
      version: 1,
      createdBy: null,
      updatedBy: null,
    });
    out.created.push(d.key);
  }
  return out;
}

export async function seedDemoIncidents(): Promise<{ created: string[]; skipped: string[] }> {
  const out = { created: [] as string[], skipped: [] as string[] };
  const wa = await ServiceProvider.findOne({ where: { providerKey: 'whatsapp_fake' } });
  const pg = await ServiceProvider.findOne({ where: { providerKey: 'pg_fake' } });
  const at = now();
  const entry = (
    when: Date,
    status: 'INVESTIGATING' | 'IDENTIFIED' | 'MONITORING' | 'RESOLVED',
    message: string,
  ) => ({
    at: when.toISOString(),
    status,
    message,
    isPublic: true,
    byUserId: null,
    byName: 'Isha Kapoor',
  });
  const rows = [
    {
      title: 'Delivery delays of about 4 minutes',
      provider: wa,
      component: 'notifications_whatsapp',
      status: 'MONITORING' as const,
      startedAt: addHours(at, -4),
      resolvedAt: null as Date | null,
      updates: (s: Date) => [
        entry(s, 'INVESTIGATING', 'WhatsApp messages are reaching residents late.'),
        entry(addMinutes(s, 20), 'IDENTIFIED', 'The delay is on the provider side.'),
        entry(addMinutes(s, 100), 'MONITORING', 'Delivery times are back to normal. We are watching them.'),
      ],
    },
    {
      title: 'Webhook retries elevated for 12 minutes',
      provider: pg,
      component: 'payments',
      status: 'RESOLVED' as const,
      startedAt: addDays(at, -6),
      resolvedAt: addMinutes(addDays(at, -6), 12),
      updates: (s: Date) => [
        entry(s, 'INVESTIGATING', 'Payment confirmations are arriving late.'),
        entry(addMinutes(s, 12), 'RESOLVED', 'Payment confirmations are back to normal.'),
      ],
    },
  ];
  for (const r of rows) {
    if (await Incident.findOne({ where: { title: r.title }, attributes: ['id'] })) {
      out.skipped.push(r.title);
      continue;
    }
    await Incident.create({
      title: r.title,
      severity: 'SEV3',
      status: r.status,
      components: [r.component],
      serviceProviderId: r.provider?.id ?? null,
      source: 'PROVIDER_MANUAL',
      isPublic: true,
      updates: r.updates(r.startedAt),
      startedAt: r.startedAt,
      identifiedAt: r.status === 'MONITORING' ? addMinutes(r.startedAt, 20) : null,
      monitoringAt: r.status === 'MONITORING' ? addMinutes(r.startedAt, 100) : null,
      resolvedAt: r.resolvedAt,
      durationMinutes: r.resolvedAt ? 12 : null,
      rootCause: null,
      version: 1,
      createdBy: null,
      updatedBy: null,
    });
    out.created.push(r.title);
  }
  return out;
}

export async function seedDemoAnnouncement(): Promise<{ created: boolean }> {
  const title = 'New billing run wizard is live';
  if (await PlatformNotification.findOne({ where: { title }, attributes: ['id'] })) return { created: false };
  const at = now();
  await PlatformNotification.create({
    title,
    body: 'Run monthly maintenance billing in four steps: pick the period, review the charges, preview and send.',
    kind: 'RELEASE_NOTE',
    severity: 'INFO',
    audienceType: 'ALL',
    audiencePlanKeys: null,
    audienceSocietyStatuses: null,
    audienceSocietyIds: null,
    audienceRoleKeys: ['chairman', 'secretary', 'treasurer', 'society_admin'],
    channels: [],
    status: 'PUBLISHED',
    publishAt: null,
    expiresAt: addDays(at, 30),
    publishedAt: at,
    cancelledAt: null,
    cancelReason: null,
    isDismissible: true,
    ctaLabel: null,
    ctaUrl: null,
    incidentId: null,
    recipientCount: 0,
    fanoutCompletedAt: at,
    version: 1,
    createdBy: null,
    updatedBy: null,
  });
  return { created: true };
}
