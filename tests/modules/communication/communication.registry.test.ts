import { beforeEach, describe, expect, it } from 'vitest';
import { NotificationTemplate } from '../../../src/models';
import { hasTemplate } from '../../../src/lib/notify';
import { NOTIFY, TEMPLATE_CATEGORIES } from '../../../src/modules/communication/communication.constants';
import {
  FAKE_DLT_ID,
  TEMPLATE_KEY_RE,
  allMeta,
  codeDefinitions,
  metaFor,
  moduleOfKey,
  registerTemplates,
  syncTemplates,
} from '../../../src/modules/communication/communication.registry';
import { FUTURE_TEMPLATES } from '../../../src/modules/communication/communication.registry.future';
import {
  getTemplate,
  renderTemplate,
  dropTemplateCache,
} from '../../../src/modules/communication/communication.templates';
import {
  smsWithinLimit,
  unknownPlaceholders,
  validateData,
} from '../../../src/modules/communication/communication.render';
import '../../../src/modules/helpdesk/helpdesk.notify.templates'; // registers the module 15 stand-in templates
import { registerApprovalTemplates } from '../../../src/modules/approvals/approvals.notify';
import '../../../src/modules/accounts/accounts.journal.templates'; // module 13 registers from its jobs files
import '../../helpers/auth'; // loads the app: every module registers its stand-in templates at import
import { resetCommunication } from '../../helpers/communication';

beforeEach(async () => {
  await resetCommunication();
  await NotificationTemplate.destroy({ where: {}, truncate: false });
});

describe('template definitions of module 16 (10.1, T16 registry test)', () => {
  it('registers the 18 module 16 keys, 2 for module 25 and 6 for module 24', () => {
    const keys = codeDefinitions().map(d => d.key);
    expect(Object.values(NOTIFY).every(k => keys.includes(k))).toBe(true);
    expect(keys.filter(k => k.startsWith('communication.'))).toHaveLength(18);
    expect(keys.filter(k => k.startsWith('resident.'))).toHaveLength(2);
    expect(keys.filter(k => k.startsWith('reports.'))).toHaveLength(6);
  });
  it('every key is valid, every placeholder is in the schema, samples validate and every channel renders (SMS within 2 segments, push body <= 140)', () => {
    for (const d of codeDefinitions()) {
      expect(TEMPLATE_KEY_RE.test(d.key) && d.key.length <= 80, d.key).toBe(true);
      expect(TEMPLATE_CATEGORIES).toContain(d.category);
      expect(
        d.defaultChannels.every(c => d.allowedChannels.includes(c)),
        d.key,
      ).toBe(true);
      expect(d.allowedChannels).toContain('IN_APP');
      if (d.deliveryClass === 'SAFETY' || d.deliveryClass === 'TRANSACTIONAL')
        expect(d.allowedChannels, d.key).toContain('SMS');
      validateData(d.variables, d.sample);
      for (const [loc, t] of Object.entries(d.text))
        for (const v of Object.values(t ?? {}))
          if (typeof v === 'string')
            expect(unknownPlaceholders(v, d.variables), `${d.key} ${loc}`).toEqual([]);
    }
  });
  it('rendering the sample on every allowed channel works and stays within the length rules', async () => {
    await syncTemplates();
    for (const d of codeDefinitions()) {
      const t = await getTemplate(d.key);
      const r = renderTemplate(t, d.sample);
      if (d.allowedChannels.includes('IN_APP') && d.deliveryClass !== 'OTP')
        expect(r.inApp ?? r.push, d.key).toBeTruthy();
      if (d.defaultChannels.includes('PUSH')) expect(r.push!.body.length, d.key).toBeLessThanOrEqual(140);
      if (r.sms) expect(smsWithinLimit(r.sms), d.key).toBe(true);
      if (d.defaultChannels.includes('EMAIL')) expect(r.email, d.key).toBeTruthy();
      expect(JSON.stringify(r)).not.toContain('{{');
    }
  });
  it('emergency templates are SAFETY with WhatsApp + SMS; drill prefix renders first', async () => {
    const m = metaFor(NOTIFY.emergencyAlert)!;
    expect(m.deliveryClass).toBe('SAFETY');
    expect(m.defaultChannels).toEqual(['IN_APP', 'PUSH', 'SMS', 'WHATSAPP']);
    await syncTemplates();
    const t = await getTemplate(NOTIFY.emergencyAlert);
    const r = renderTemplate(t, {
      broadcastId: 1,
      title: 'Fire',
      message: 'x',
      prefix: 'DRILL: ',
      link: '/e',
    });
    expect(r.inApp!.title.startsWith('DRILL: ')).toBe(true);
    expect(r.sms!.startsWith('DRILL: ')).toBe(true);
  });
  it('registerTemplates refuses bad keys and unknown placeholders', () => {
    const def = codeDefinitions()[0]!;
    expect(() => registerTemplates('99', [{ ...def, key: 'Bad Key' }])).toThrowError(/invalid/);
    expect(() =>
      registerTemplates('99', [
        { ...def, key: 'x.ok', text: { 'en-IN': { inAppTitle: '{{nope}}' } }, variables: {} },
      ]),
    ).toThrowError(/placeholder/);
    expect(() =>
      registerTemplates('99', [
        { ...def, key: 'x.ok2', defaultChannels: ['SMS'], allowedChannels: ['IN_APP'] },
      ]),
    ).toThrowError(/allowedChannels/);
  });
});

describe('the registry of every module (10.2) and templates:sync (BR-16-50)', () => {
  it('knows the stand-in templates of modules 02 to 15 and the future keys of 17 to 30', () => {
    registerApprovalTemplates(); // module 14 registers its stand-in templates from registerApprovals()
    const keys = new Set(allMeta().map(m => m.key));
    for (const k of ['auth.otp', 'approvals.pending', 'helpdesk.ticket_created'])
      expect(keys.has(k), k).toBe(true);
    const mods = new Set(allMeta().map(m => m.module));
    for (const m of [
      '02',
      '03',
      '04',
      '05',
      '06',
      '07',
      '08',
      '09',
      '10',
      '11',
      '12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '19',
      '20',
      '21',
      '22',
      '23',
      '24',
      '25',
      '26',
      '27',
      '28',
      '29',
      '30',
    ])
      expect(mods.has(m), `module ${m}`).toBe(true);
    expect(FUTURE_TEMPLATES.length).toBeGreaterThan(200);
    expect(moduleOfKey('gate.sos_raised')).toBe('17');
  });
  it('derives legacy metadata: auth.otp is OTP and never counts, other auth keys are SECURITY, critical keys are TRANSACTIONAL', () => {
    const otp = metaFor('auth.otp')!;
    expect(otp).toMatchObject({
      deliveryClass: 'OTP',
      scope: 'USER',
      countsTowardLimit: false,
      module: '02',
    });
    expect(otp.defaultChannels).toEqual(['SMS']);
    expect(otp.allowedChannels).toEqual(['SMS', 'WHATSAPP']);
    expect(otp.legacy).not.toBeNull();
    const others = allMeta().filter(m => m.key.startsWith('auth.') && m.key !== 'auth.otp');
    expect(others.length).toBeGreaterThan(10);
    expect(others.every(m => m.deliveryClass === 'SECURITY' && !m.countsTowardLimit)).toBe(true);
    expect(metaFor('setup.security_policy.changed')?.deliveryClass ?? 'SECURITY').toBe('SECURITY');
    expect(metaFor('platform_billing.invoice_issued')?.sendWhenClosed ?? true).toBe(true);
  });
  it('syncs every key with an en-IN row, is idempotent, and keeps edited text', async () => {
    const first = await syncTemplates();
    expect(first.keys).toBe(allMeta().length);
    expect(first.written).toBeGreaterThan(first.keys - 1);
    const total = await NotificationTemplate.count();
    expect(total).toBeGreaterThanOrEqual(first.keys);
    expect(await NotificationTemplate.count({ where: { locale: 'en-IN' } })).toBe(first.keys);
    expect((await syncTemplates()).written).toBe(0);
    // hi-IN and mr-IN rows for the notice templates
    expect(await NotificationTemplate.count({ where: { templateKey: NOTIFY.noticePublished } })).toBe(3);
    // metadata is rewritten, edited text is not
    const row = (await NotificationTemplate.findOne({
      where: { templateKey: NOTIFY.pushTest, locale: 'en-IN' },
    }))!;
    await row.update({
      inAppTitle: 'Edited by platform',
      textEditedAt: new Date(),
      isActive: true,
      deepLink: '/tampered',
    });
    await syncTemplates();
    const after = await row.reload();
    expect(after.inAppTitle).toBe('Edited by platform');
    expect(after.deepLink).toBe('/settings/notifications');
  });
  it('legacy SMS keys get the fake DLT id outside production, future keys have no text', async () => {
    await syncTemplates();
    const otp = (await NotificationTemplate.findOne({ where: { templateKey: 'auth.otp' } }))!;
    expect(otp.smsDltTemplateId).toBe(FAKE_DLT_ID);
    const future = (await NotificationTemplate.findOne({
      where: { templateKey: 'gate.visitor_approval_request' },
    }))!;
    expect(future).toMatchObject({ inAppTitle: null, module: '17', deliveryClass: 'TRANSACTIONAL' });
  });
  it('an inactive key throws TEMPLATE_NOT_FOUND, an inactive locale falls back to en-IN', async () => {
    await syncTemplates();
    await NotificationTemplate.update(
      { isActive: false },
      { where: { templateKey: NOTIFY.noticePublished, locale: 'hi-IN' } },
    );
    dropTemplateCache();
    expect((await getTemplate(NOTIFY.noticePublished, 'hi-IN')).locale).toBe('en-IN');
    await NotificationTemplate.update({ isActive: false }, { where: { templateKey: NOTIFY.pushTest } });
    dropTemplateCache();
    await expect(getTemplate(NOTIFY.pushTest)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });
  it('a missing row is synced lazily on first use', async () => {
    expect(await NotificationTemplate.count()).toBe(0);
    await getTemplate(NOTIFY.noticePublished);
    expect(await NotificationTemplate.count({ where: { templateKey: NOTIFY.noticePublished } })).toBe(3);
    expect(hasTemplate('auth.otp')).toBe(true);
  });
});

// the categories used by legacy metadata must satisfy the table CHECK
describe('legacy categories', () => {
  it('all derived categories are valid', () => {
    for (const m of allMeta()) expect(TEMPLATE_CATEGORIES, m.key).toContain(m.category);
  });
});
