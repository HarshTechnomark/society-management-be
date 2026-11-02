import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Incident,
  PlatformNotification,
  PlatformTicket,
  PlatformTicketMessage,
  ServiceProvider,
  Society,
  closeDb,
  sequelize,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { listRoutes } from '../../../src/modules/access-control/access-control.registry';
import { seedDemoTickets, seedSettings } from '../../../seeders/platform-ops';
import { app } from '../../helpers/auth';
import { memberUser } from '../../helpers/access';
import { insertTicket, opsSociety, resetOps } from '../../helpers/platform-ops';

afterAll(closeDb);
beforeEach(async () => {
  await resetOps();
  setNow('2026-10-30T04:00:00Z');
});

describe('tables and models (7.1 to 7.6)', () => {
  it('7.3 ticket messages are immutable: update and destroy are refused', async () => {
    const society = await opsSociety();
    const u = await memberUser(society, 'treasurer');
    const t = await insertTicket(society, u);
    const m = (await PlatformTicketMessage.findOne({ where: { ticketId: t.id! } }))!;
    await expect(m.update({ body: 'edited' })).rejects.toThrow('immutable');
    await expect(m.destroy()).rejects.toThrow('immutable');
    await expect(PlatformTicketMessage.update({ body: 'x' }, { where: { id: m.id! } })).rejects.toThrow(
      'immutable',
    );
    await expect(PlatformTicketMessage.destroy({ where: { id: m.id! } })).rejects.toThrow('immutable');
    expect((await PlatformTicketMessage.findByPk(m.id!))!.body).not.toBe('edited');
  });

  it('7.2 the database refuses bad enums, ratings and reopen counts', async () => {
    const society = await opsSociety();
    const u = await memberUser(society, 'treasurer');
    const t = await insertTicket(society, u);
    for (const patch of [
      { status: 'BROKEN' },
      { priority: 'URGENT' },
      { category: 'NOPE' },
      { satisfactionRating: 6 },
      { reopenCount: 6 },
      { closedReason: 'WHATEVER' },
    ])
      await expect(
        PlatformTicket.update(patch as never, { where: { id: t.id! } }),
        JSON.stringify(patch),
      ).rejects.toThrow();
    // tickets and their society are protected from deletion
    await expect(sequelize.query(`DELETE FROM societies WHERE id = ${society.id}`)).rejects.toThrow();
  });

  it('7.4 provider default scope hides the ciphertext; withSecrets shows it; the credential CHECK holds together', async () => {
    const base = {
      providerKey: 'sms_one',
      channel: 'SMS',
      vendor: 'MSG91',
      displayName: 'SMS gateway (DLT)',
      credentialsSource: 'DATABASE',
      configJson: { senderId: 'SOCAPP' },
      credentialsMasked: { authKey: '••••••••3f9a' },
      version: 1,
    } as const;
    const p = await ServiceProvider.create({
      ...base,
      credentialsEnc: Buffer.from('cipher'),
      credentialsIv: Buffer.alloc(12, 1),
      credentialsTag: Buffer.alloc(16, 2),
      credentialsKeyVersion: 1,
    } as never);
    const plain = (await ServiceProvider.findByPk(p.id!))!.get({ plain: true });
    expect(plain).not.toHaveProperty('credentialsEnc');
    expect(plain).not.toHaveProperty('credentialsIv');
    expect(plain).not.toHaveProperty('credentialsTag');
    expect(plain.credentialsMasked).toEqual({ authKey: '••••••••3f9a' });
    const secret = (await ServiceProvider.scope('withSecrets').findByPk(p.id!))!;
    expect(Buffer.from(secret.credentialsEnc!).toString()).toBe('cipher');
    // ciphertext without iv violates the CHECK
    await expect(
      ServiceProvider.create({
        ...base,
        providerKey: 'sms_two',
        priority: 2,
        credentialsEnc: Buffer.from('x'),
      } as never),
    ).rejects.toThrow();
    // one priority per channel; deleted rows (priority NULL) do not collide
    await ServiceProvider.create({ ...base, providerKey: 'sms_three', priority: 1 } as never);
    await expect(
      ServiceProvider.create({ ...base, providerKey: 'sms_four', priority: 1 } as never),
    ).rejects.toThrow();
    await ServiceProvider.create({ ...base, providerKey: 'sms_five', priority: null } as never);
    await ServiceProvider.create({ ...base, providerKey: 'sms_six', priority: null } as never);
    await expect(ServiceProvider.create({ ...base, providerKey: 'sms_one' } as never)).rejects.toThrow(); // unique key
    await expect(
      ServiceProvider.create({ ...base, providerKey: 'bad_vendor', vendor: 'ACME' } as never),
    ).rejects.toThrow();
    await expect(
      ServiceProvider.create({ ...base, providerKey: 'bad_latency', degradedLatencyMs: 100 } as never),
    ).rejects.toThrow();
  });

  it('7.5 and 7.6 incidents and announcements: enums and the announcement CHECKs', async () => {
    const inc = await Incident.create({
      title: 'Delivery delays of about 4 minutes',
      severity: 'SEV3',
      status: 'MONITORING',
      components: ['whatsapp'],
      serviceProviderId: null,
      source: 'MANUAL',
      isPublic: true,
      updates: [],
      startedAt: new Date(),
      identifiedAt: null,
      monitoringAt: null,
      resolvedAt: null,
      durationMinutes: null,
      rootCause: null,
      version: 1,
      createdBy: null,
      updatedBy: null,
    });
    expect(inc.updates).toEqual([]);
    await expect(
      Incident.update({ severity: 'SEV9' as never }, { where: { id: inc.id! } }),
    ).rejects.toThrow();
    await expect(Incident.update({ status: 'DONE' as never }, { where: { id: inc.id! } })).rejects.toThrow();
    const ann = {
      title: 'New billing run wizard is live',
      body: 'The billing run wizard is now available to everyone.',
      kind: 'RELEASE_NOTE',
      severity: 'INFO',
      audienceType: 'ALL',
      audiencePlanKeys: null,
      audienceSocietyStatuses: null,
      audienceSocietyIds: null,
      audienceRoleKeys: ['chairman'],
      channels: [],
      status: 'DRAFT',
      publishAt: null,
      expiresAt: new Date('2026-12-01T00:00:00Z'),
      publishedAt: null,
      cancelledAt: null,
      cancelReason: null,
      isDismissible: true,
      ctaLabel: null,
      ctaUrl: null,
      incidentId: inc.id!,
      recipientCount: null,
      fanoutCompletedAt: null,
      version: 1,
      createdBy: null,
      updatedBy: null,
    } as const;
    await PlatformNotification.create({ ...ann } as never);
    await expect(PlatformNotification.create({ ...ann, ctaLabel: 'Open' } as never)).rejects.toThrow(); // label without url
    await expect(PlatformNotification.create({ ...ann, severity: 'CRITICAL' } as never)).rejects.toThrow(); // dismissible critical
    await PlatformNotification.create({ ...ann, severity: 'CRITICAL', isDismissible: false } as never);
    await expect(PlatformNotification.create({ ...ann, kind: 'SPAM' } as never)).rejects.toThrow();
    await expect(sequelize.query(`DELETE FROM incidents WHERE id = ${inc.id}`)).rejects.toThrow(); // RESTRICT from announcements
  });
});

describe('route registry for module 07 part 1', () => {
  it('every route is marked, permissioned and carries step-up and idempotency as the spec says', () => {
    const routes = listRoutes(app);
    const find = (m: string, p: string) => routes.find(r => r.method === m && r.path === p)!;
    const rows: [
      string,
      string,
      string,
      string[],
      { stepUp?: boolean; idempotent?: boolean; suspended?: boolean },
    ][] = [
      ['GET', '/platform/tickets', 'platform', ['platform.tickets.view'], {}],
      ['GET', '/platform/tickets/:id', 'platform', ['platform.tickets.view'], {}],
      ['POST', '/platform/tickets', 'platform', ['platform.tickets.create'], { idempotent: true }],
      ['PATCH', '/platform/tickets/:id', 'platform', ['platform.tickets.edit'], {}],
      ['POST', '/platform/tickets/:id/messages', 'platform', ['platform.tickets.edit'], { idempotent: true }],
      ['GET', '/support-tickets', 'society', ['settings.support.view'], { suspended: true }],
      [
        'POST',
        '/support-tickets',
        'society',
        ['settings.support.create'],
        { idempotent: true, suspended: true },
      ],
      ['GET', '/support-tickets/:id', 'society', ['settings.support.view'], { suspended: true }],
      [
        'POST',
        '/support-tickets/:id/messages',
        'society',
        ['settings.support.create'],
        { idempotent: true, suspended: true },
      ],
      ['POST', '/support-tickets/:id/reopen', 'society', ['settings.support.create'], { suspended: true }],
      ['POST', '/support-tickets/:id/close', 'society', ['settings.support.create'], { suspended: true }],
      ['POST', '/support-tickets/:id/rating', 'society', ['settings.support.create'], { suspended: true }],
      ['GET', '/platform/settings', 'platform', ['platform.settings.view'], {}],
      ['PATCH', '/platform/settings', 'platform', ['platform.settings.edit'], { stepUp: true }],
      ['GET', '/platform/organizations', 'platform', ['platform.societies.view'], {}],
      ['GET', '/platform/organizations/:id', 'platform', ['platform.societies.view'], {}],
      ['POST', '/platform/organizations', 'platform', ['platform.societies.create'], { idempotent: true }],
      ['PATCH', '/platform/organizations/:id', 'platform', ['platform.societies.edit'], {}],
      [
        'POST',
        '/platform/organizations/:id/status',
        'platform',
        ['platform.societies.edit'],
        { stepUp: true },
      ],
    ];
    for (const [m, p, kind, perms, o] of rows) {
      const r = find(m, p);
      expect(r, `${m} ${p}`).toBeDefined();
      expect(r.kind, `${m} ${p}`).toBe(kind);
      expect(r.permissions, `${m} ${p}`).toEqual(perms);
      expect(r.stepUp, `${m} ${p} stepUp`).toBe(Boolean(o.stepUp));
      expect(r.idempotent, `${m} ${p} idempotent`).toBe(Boolean(o.idempotent));
      expect(r.allowWhenSuspended, `${m} ${p} suspended`).toBe(Boolean(o.suspended));
    }
  });
});

describe('seed (7.8, part 1)', () => {
  it('seeds the six demo tickets once, on the demo societies, with the right states', async () => {
    const sky = await opsSociety('Sky Heights CHS');
    const green = await opsSociety('Green Park CHS');
    const tulip = await opsSociety('Tulip Gardens CHS');
    await Society.update({ slug: 'sky-heights' }, { where: { id: sky.id! } });
    await Society.update({ slug: 'green-park' }, { where: { id: green.id! } });
    await Society.update({ slug: 'tulip-gardens' }, { where: { id: tulip.id! } });
    await memberUser(sky, 'treasurer', { name: 'Meera Iyer' });
    await memberUser(green, 'treasurer', { name: 'Ritu Agarwal' });
    await memberUser(tulip, 'chairman', { name: 'Kavita Rao' });
    expect((await seedSettings()).added).toBe(40);
    const first = await seedDemoTickets();
    expect(first.created).toHaveLength(6);
    const rows = await PlatformTicket.findAll({ order: [['id', 'ASC']] });
    expect(rows.map(r => [r.subject, r.priority, r.status])).toEqual([
      ['UPI AutoPay mandate failing for 3 members', 'HIGH', 'OPEN'],
      ['WhatsApp reminders not delivered since Monday', 'HIGH', 'IN_PROGRESS'],
      ['How do we import flats from our old software?', 'LOW', 'OPEN'],
      ['Need a second guard console', 'MEDIUM', 'WAITING'],
      ['Receipt PDF shows wrong society name', 'MEDIUM', 'RESOLVED'],
      ['Reactivate our society after payment', 'HIGH', 'OPEN'],
    ]);
    expect(await seedDemoTickets()).toEqual({ created: [], skipped: first.created });
  });
});
