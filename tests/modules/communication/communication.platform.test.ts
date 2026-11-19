import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, NotificationTemplate, Notification, closeDb } from '../../../src/models';
import { advance, setNow } from '../../../src/lib/clock';
import { call, makeUser } from '../../helpers/auth';
import { login, memberUser } from '../../helpers/access';
import { platformAs, resetSocieties } from '../../helpers/societies';
import { subSociety } from '../../helpers/subscriptions';
import { resetCommunication } from '../../helpers/communication';
import { NOTIFY } from '../../../src/modules/communication/communication.constants';
import { as } from '../../helpers/access';
import { syncTemplates } from '../../../src/modules/communication/communication.registry';
import { dropTemplateCache, getTemplate } from '../../../src/modules/communication/communication.templates';
import { encryptJson, mobileKey } from '../../../src/modules/communication/communication.crypto';
import { sanitizeEmailHtml } from '../../../src/modules/communication/communication.templates.admin';

afterAll(closeDb);
beforeEach(async () => {
  await resetSocieties();
  await resetCommunication();
  // the template rows are a platform seed kept by resetAll(): edits of earlier tests (or other files on the same database) leave them at version > 1,
  // and these tests patch with version 1, so every test starts from freshly seeded rows
  await NotificationTemplate.destroy({ where: {} });
  await syncTemplates();
  setNow('2026-11-01T04:30:00Z');
});

const row = (key: string, locale = 'en-IN') =>
  NotificationTemplate.findOne({ where: { templateKey: key, locale } }).then(r => r!);
const sa = () => platformAs('super_admin');

describe('GET /platform/notification-templates (8.35)', () => {
  it('lists rows with the documented item shape, paged and sorted by key', async () => {
    const { c } = await sa();
    const r = await c('get', '/platform/notification-templates', undefined, {
      query: { module: '16', limit: '5' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.pagination).toMatchObject({ page: 1, limit: 5 });
    expect(r.body.pagination.total).toBeGreaterThan(18);
    const item = r.body.data[0];
    expect(Object.keys(item)).toEqual(
      expect.arrayContaining([
        'id',
        'templateKey',
        'locale',
        'module',
        'category',
        'deliveryClass',
        'defaultChannels',
        'smsDltTemplateId',
        'whatsappTemplateName',
        'whatsappStatus',
        'isActive',
        'textEditedAt',
        'version',
      ]),
    );
    expect(item).not.toHaveProperty('smsBody');
    const keys: string[] = r.body.data.map((x: { templateKey: string }) => x.templateKey);
    expect(keys).toEqual([...keys].sort());
  });
  it('filters by category, class, locale, key prefix and the missing flags', async () => {
    const { c } = await sa();
    const q = (query: Record<string, string>) =>
      c('get', '/platform/notification-templates', undefined, { query: { limit: '100', ...query } });
    const emg = await q({ deliveryClass: 'SAFETY', module: '16' });
    expect(emg.body.data.length).toBeGreaterThan(5);
    expect(emg.body.data.every((x: { deliveryClass: string }) => x.deliveryClass === 'SAFETY')).toBe(true);
    const hi = await q({ locale: 'hi-IN' });
    expect(hi.body.data.length).toBeGreaterThan(0);
    expect(hi.body.data.every((x: { locale: string }) => x.locale === 'hi-IN')).toBe(true);
    const pre = await q({ q: 'communication.survey' });
    expect(
      pre.body.data.every((x: { templateKey: string }) => x.templateKey.startsWith('communication.survey')),
    ).toBe(true);
    expect(pre.body.data.length).toBe(3);
    await NotificationTemplate.update(
      { smsDltTemplateId: null },
      { where: { templateKey: NOTIFY.noticePublished, locale: 'en-IN' } },
    );
    const noDlt = await q({ missing: 'SMS_DLT' });
    expect(noDlt.body.data.map((x: { templateKey: string }) => x.templateKey)).toContain(
      NOTIFY.noticePublished,
    );
    const noLoc = await q({ missing: 'LOCALE' });
    expect(noLoc.body.data.every((x: { locale: string }) => x.locale === 'en-IN')).toBe(true);
    expect(noLoc.body.data.map((x: { templateKey: string }) => x.templateKey)).not.toContain(
      NOTIFY.noticePublished,
    ); // has hi-IN
    const wa = await q({ missing: 'WHATSAPP' });
    expect(wa.status).toBe(200);
  });
  it('rejects unknown query keys and short q (strict validation)', async () => {
    const { c } = await sa();
    expect(
      (await c('get', '/platform/notification-templates', undefined, { query: { foo: '1' } })).status,
    ).toBe(400);
    expect(
      (await c('get', '/platform/notification-templates', undefined, { query: { q: 'a' } })).status,
    ).toBe(400);
    expect(
      (await c('get', '/platform/notification-templates', undefined, { query: { missing: 'NOPE' } })).status,
    ).toBe(400);
  });
  it('GET /:id returns the full row incl. variablesSchema and allowedChannels; 404 TEMPLATE_NOT_FOUND', async () => {
    const { c } = await sa();
    const t = await row(NOTIFY.noticePublished);
    const r = await c('get', `/platform/notification-templates/${t.id}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: t.id, templateKey: NOTIFY.noticePublished, version: 1 });
    expect(r.body.data.variablesSchema).toHaveProperty('title');
    expect(r.body.data.allowedChannels).toEqual(expect.arrayContaining(['IN_APP', 'PUSH']));
    expect(r.body.data.inAppTitle).toContain('{{title}}');
    const nf = await c('get', '/platform/notification-templates/99999999');
    expect(nf.status).toBe(404);
    expect(nf.body.code).toBe('TEMPLATE_NOT_FOUND');
  });
  it('permission matrix: support may read, society admins and anonymous callers may not', async () => {
    const support = await platformAs('platform_support');
    expect((await support.c('get', '/platform/notification-templates')).status).toBe(200);
    const { society } = await subSociety({ plan: 'PREMIUM' });
    const chair = await memberUser(society, 'chairman');
    const admin = as(await login(chair));
    expect([401, 403, 404]).toContain((await admin('get', '/platform/notification-templates')).status);
    expect((await admin('get', '/platform/notification-templates')).status).not.toBe(200);
    expect((await call('get', '/platform/notification-templates')).status).toBe(401);
    expect((await call('get', '/platform/notification-deliveries')).status).toBe(401);
  });
});

describe('PATCH /platform/notification-templates/:id (8.35)', () => {
  const patch = (c: any, id: number, body: Record<string, unknown>) =>
    c('patch', `/platform/notification-templates/${id}`, body);

  it('edits text, sets textEditedAt, bumps version, audits without the text and drops the template cache', async () => {
    const { c } = await sa();
    const t = await row(NOTIFY.noticePublished);
    dropTemplateCache();
    expect((await getTemplate(NOTIFY.noticePublished)).texts.inAppTitle).toBe('New notice: {{title}}');
    const r = await patch(c, t.id, {
      version: 1,
      inAppTitle: 'Fresh notice: {{title}}',
      pushBody: 'Read: {{title}}',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ version: 2, inAppTitle: 'Fresh notice: {{title}}' });
    expect(r.body.data.textEditedAt).not.toBeNull();
    const a = (await AuditLog.findAll({ where: { action: 'communication.template.updated' } }))!;
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0]!.after)).not.toContain('Fresh notice');
    expect(JSON.stringify(a[0]!.after)).toContain('inAppTitle');
    // the cache of this process was dropped by communication:templates-changed
    expect((await getTemplate(NOTIFY.noticePublished)).texts.inAppTitle).toBe('Fresh notice: {{title}}');
    // a later templates:sync keeps the edited text
    await syncTemplates();
    expect((await row(NOTIFY.noticePublished)).inAppTitle).toBe('Fresh notice: {{title}}');
  });
  it('409 STALE_VERSION when the version is old; an unchanged patch writes nothing', async () => {
    const { c } = await sa();
    const t = await row(NOTIFY.noticePublished);
    expect((await patch(c, t.id, { version: 1, pushTitle: 'One' })).status).toBe(200);
    const stale = await patch(c, t.id, { version: 1, pushTitle: 'Two' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    const same = await patch(c, t.id, { version: 2, pushTitle: 'One' });
    expect(same.status).toBe(200);
    expect(same.body.data.version).toBe(2);
    expect(await AuditLog.count({ where: { action: 'communication.template.updated' } })).toBe(1);
  });
  it('401 REAUTH_REQUIRED when the step-up is older than the platform window', async () => {
    const { c } = await sa();
    const t = await row(NOTIFY.noticePublished);
    advance(6 * 60_000); // past the 5-minute platform step-up, inside the access token life (30 minutes ends the token: UNAUTHENTICATED)
    const r = await patch(c, t.id, { version: 1, pushTitle: 'One' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('REAUTH_REQUIRED');
    expect((await row(NOTIFY.noticePublished)).version).toBe(1);
  });
  it('platform support cannot edit (403) and anonymous callers get 401', async () => {
    const support = await platformAs('platform_support');
    const t = await row(NOTIFY.noticePublished);
    expect((await patch(support.c, t.id, { version: 1, pushTitle: 'One' })).status).toBe(403);
    expect((await call('patch', `/platform/notification-templates/${t.id}`, { version: 1 })).status).toBe(
      401,
    );
  });
  it('422 TEMPLATE_INVALID for an unknown placeholder, an unknown whatsapp param and en-IN deactivation', async () => {
    const { c } = await sa();
    const t = await row(NOTIFY.noticePublished);
    const ph = await patch(c, t.id, { version: 1, pushBody: 'Hello {{nope}}' });
    expect(ph.status).toBe(422);
    expect(ph.body.code).toBe('TEMPLATE_INVALID');
    expect(ph.body.errors[0].field).toBe('pushBody');
    const wp = await patch(c, t.id, { version: 1, whatsappParams: ['title', 'ghost'] });
    expect(wp.body.code).toBe('TEMPLATE_INVALID');
    const off = await patch(c, t.id, { version: 1, isActive: false });
    expect(off.body.code).toBe('TEMPLATE_INVALID');
    expect((await row(NOTIFY.noticePublished)).version).toBe(1);
  });
  it('can deactivate a hi-IN row (falls back to en-IN) but not en-IN', async () => {
    const { c } = await sa();
    const hi = await row(NOTIFY.noticePublished, 'hi-IN');
    const r = await patch(c, hi.id, { version: 1, isActive: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await getTemplate(NOTIFY.noticePublished, 'hi-IN')).locale).toBe('en-IN');
  });
  it('422 TEMPLATE_INVALID when the SMS renders longer than 2 segments', async () => {
    const { c } = await sa();
    const t = await row(NOTIFY.noticePublished);
    const r = await patch(c, t.id, {
      version: 1,
      smsBody: 'x'.repeat(320),
      smsDltTemplateId: '123456789012',
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('TEMPLATE_INVALID');
  });
  it('422 TEMPLATE_DLT_REQUIRED when smsBody changes and the DLT id stays; the new id lets it through', async () => {
    const { c } = await sa();
    const t = await row(NOTIFY.noticePublished);
    expect(t.smsDltTemplateId).toBe('100000000000000'); // development seed id
    const stay = await patch(c, t.id, { version: 1, smsBody: 'Notice: {{title}} {{link}}' });
    expect(stay.status).toBe(422);
    expect(stay.body.code).toBe('TEMPLATE_DLT_REQUIRED');
    const same = await patch(c, t.id, {
      version: 1,
      smsBody: 'Notice: {{title}} {{link}}',
      smsDltTemplateId: '100000000000000',
    });
    expect(same.body.code).toBe('TEMPLATE_DLT_REQUIRED');
    const ok = await patch(c, t.id, {
      version: 1,
      smsBody: 'Notice: {{title}} {{link}}',
      smsDltTemplateId: '110000000000099',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.smsDltTemplateId).toBe('110000000000099');
  });
  it('validates DLT id, WhatsApp name, enums and unknown keys (strict)', async () => {
    const { c } = await sa();
    const t = await row(NOTIFY.noticePublished);
    for (const body of [
      { version: 1, smsDltTemplateId: '12345' },
      { version: 1, whatsappTemplateName: 'Bad Name' },
      { version: 1, whatsappStatus: 'MAYBE' },
      { version: 1, smsDltCategory: 'PROMO' },
      { version: 1, whatsappParams: Array.from({ length: 11 }, (_, i) => `p${i}`) },
      { version: 1, templateKey: 'x.y' },
      { pushTitle: 'no version' },
    ])
      expect((await patch(c, t.id, body)).status, JSON.stringify(body)).toBe(400);
  });
  it('sets WhatsApp name, category and status from the registered variables', async () => {
    const { c } = await sa();
    const t = await row(NOTIFY.noticePublished);
    const r = await patch(c, t.id, {
      version: 1,
      whatsappTemplateName: 'notice_published_v2',
      whatsappCategory: 'UTILITY',
      whatsappStatus: 'PENDING',
      whatsappParams: ['title', 'link'],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      whatsappTemplateName: 'notice_published_v2',
      whatsappStatus: 'PENDING',
      whatsappParams: ['title', 'link'],
    });
  });
  it('legacy templates of modules 01 to 15 are read-only for text but their DLT / WhatsApp data can be edited', async () => {
    const { c } = await sa();
    const legacy = await NotificationTemplate.findOne({
      where: { templateKey: 'auth.otp', locale: 'en-IN' },
    });
    if (!legacy) return; // module 02 stand-in not registered in this process
    const bad = await patch(c, legacy.id, { version: 1, smsBody: 'Your OTP {{code}}' });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('TEMPLATE_INVALID');
    const ok = await patch(c, legacy.id, { version: 1, smsDltTemplateId: '110000000000077' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
  it('sanitises the e-mail HTML (no scripts, frames, handlers or javascript: links)', async () => {
    const dirty =
      '<p onclick="x()">Hi {{title}}</p><script>alert(1)</script><a href="javascript:alert(1)">go</a><iframe src="x"></iframe>';
    const clean = sanitizeEmailHtml(dirty);
    expect(clean).not.toMatch(/script|iframe|onclick|javascript:/i);
    expect(clean).toContain('{{title}}');
    const { c } = await sa();
    const t = await row(NOTIFY.noticePublished);
    const r = await patch(c, t.id, { version: 1, emailHtml: dirty });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.emailHtml).not.toMatch(/script|iframe|onclick|javascript:/i);
  });
});

describe('POST /platform/notification-templates/:id/preview (8.35)', () => {
  it('renders every channel with the sample data; data overrides the sample; SMS shows segments', async () => {
    const { c } = await sa();
    const t = await row(NOTIFY.noticePublished);
    const r = await c('post', `/platform/notification-templates/${t.id}/preview`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.inApp.title).toBe('New notice: Water tank cleaning on Sunday');
    expect(r.body.data.push.body).toBe('Water tank cleaning on Sunday');
    expect(r.body.data.sms).toMatchObject({ segments: 1, encoding: 'GSM-7' });
    expect(r.body.data.sms.text).toContain('Water tank cleaning on Sunday');
    expect(r.body.data).toHaveProperty('whatsapp');
    expect(r.body.data.email.subject).toContain('Water tank');
    const o = await c('post', `/platform/notification-templates/${t.id}/preview`, {
      data: { title: 'Lift service' },
    });
    expect(o.body.data.inApp.title).toBe('New notice: Lift service');
    const bad = await c('post', `/platform/notification-templates/${t.id}/preview`, { nope: 1 });
    expect(bad.status).toBe(400);
    const nf = await c('post', '/platform/notification-templates/99999999/preview', {});
    expect(nf.status).toBe(404);
  });
  it('previews a hi-IN row and a money / date variable template', async () => {
    const { c } = await sa();
    const hi = await row(NOTIFY.noticePublished, 'hi-IN');
    const r = await c('post', `/platform/notification-templates/${hi.id}/preview`, {});
    expect(r.status).toBe(200);
    expect(r.body.data.inApp.title).toContain('Water tank');
    const rep = await row(NOTIFY.reportsExportReady);
    const p = await c('post', `/platform/notification-templates/${rep.id}/preview`, {});
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  });
});

describe('GET /platform/notification-deliveries (8.36)', () => {
  async function seed() {
    const { society } = await subSociety({ plan: 'PREMIUM' });
    const u = await makeUser({ name: 'Rita', mobile: '9811111111', email: 'rita@mail.in' });
    const mk = (o: Record<string, unknown>) =>
      Notification.create({
        societyId: society.id,
        batchId: 'b',
        templateKey: 'communication.notice_published',
        locale: 'en-IN',
        deliveryClass: 'STANDARD',
        channel: 'SMS',
        userId: u.id,
        recipientKey: mobileKey('9811111111'),
        destinationMasked: '98XXXXX111',
        destinationEnc: encryptJson('9811111111'),
        dataEnc: encryptJson({ data: { title: 'secret title' } }),
        status: 'SENT',
        providerKey: 'fake',
        ...o,
      } as never);
    await mk({});
    await mk({
      channel: 'EMAIL',
      recipientKey: 'e:other',
      destinationMasked: 'r****@mail.in',
      status: 'FAILED',
      lastErrorCode: 'BOUNCE',
      lastErrorMessage: 'internal detail',
    });
    return { society, u };
  }
  const q = (c: any, query: Record<string, string> = {}) =>
    c('get', '/platform/notification-deliveries', undefined, { query });

  it('platform support (platform.health.view) reads masked rows and never text, dataEnc or destinationEnc', async () => {
    await seed();
    const { c } = await platformAs('platform_support');
    const r = await q(c);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toHaveLength(2);
    expect(r.body.pagination.total).toBe(2);
    const raw = JSON.stringify(r.body);
    expect(raw).not.toMatch(/dataEnc|destinationEnc|secret title|internal detail|9811111111/);
    expect(r.body.data[0]).toEqual(
      expect.objectContaining({
        id: expect.any(Number),
        societyId: expect.any(Number),
        templateKey: 'communication.notice_published',
        destinationMasked: expect.any(String),
        attempts: 0,
        limitBypassed: false,
      }),
    );
    expect(await AuditLog.count({ where: { action: 'communication.deliveries.searched' } })).toBe(0);
  });
  it('filters by society, channel, status, template; by recipient (mobile or e-mail) and audits that search without the recipient', async () => {
    const { society } = await seed();
    const { c } = await sa();
    expect((await q(c, { channel: 'EMAIL' })).body.data).toHaveLength(1);
    expect((await q(c, { status: 'FAILED' })).body.data[0].lastErrorCode).toBe('BOUNCE');
    expect((await q(c, { societyId: String(society.id) })).body.data).toHaveLength(2);
    expect((await q(c, { societyId: '999999' })).body.data).toHaveLength(0);
    expect((await q(c, { templateKey: 'other.key' })).body.data).toHaveLength(0);
    const byMobile = await q(c, { recipient: '9811111111' });
    expect(byMobile.body.data).toHaveLength(1);
    const a = await AuditLog.findAll({ where: { action: 'communication.deliveries.searched' } });
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0])).not.toContain('9811111111');
    expect((await q(c, { recipient: 'nobody@mail.in' })).body.data).toHaveLength(0);
    expect(await AuditLog.count({ where: { action: 'communication.deliveries.searched' } })).toBe(2);
    expect((await q(c, { recipient: '12345' })).status).toBe(400);
  });
  it('the date range is at most 31 days and `to` must follow `from`', async () => {
    await seed();
    const { c } = await sa();
    expect((await q(c, { from: '2026-10-01', to: '2026-11-15' })).status).toBe(400);
    expect((await q(c, { from: '2026-11-05', to: '2026-11-01' })).status).toBe(400);
    expect((await q(c, { from: '2026-10-25', to: '2026-11-01' })).body.data).toHaveLength(2);
    expect((await q(c, { from: '2026-11-02', to: '2026-11-03' })).body.data).toHaveLength(0);
    expect((await q(c, { sortBy: 'status' })).status).toBe(400);
  });
  it('society users and anonymous callers are refused', async () => {
    const { society } = await subSociety({ plan: 'PREMIUM' });
    const chair = await memberUser(society, 'chairman');
    const admin = as(await login(chair));
    expect((await admin('get', '/platform/notification-deliveries')).status).not.toBe(200);
    expect((await call('get', '/platform/notification-deliveries')).status).toBe(401);
  });
});
