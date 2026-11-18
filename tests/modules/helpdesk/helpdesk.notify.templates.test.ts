import { describe, expect, it } from 'vitest';
import { registerTemplates } from '../../../src/lib/notify';
import { NOTIFY } from '../../../src/modules/helpdesk/helpdesk.constants';
import { cleanData, excerptOf, FORBIDDEN_KEYS } from '../../../src/modules/helpdesk/helpdesk.notify';
import '../../../src/modules/helpdesk/helpdesk.notify.templates';

import { adapters } from '../../../src/adapters';
import * as notifyLib from '../../../src/lib/notify';

const rendered = async (key: string, data: Record<string, unknown>) => {
  const captured: { sms?: string; email?: { subject: string; text: string } }[] = [];
  const a = adapters();
  const sms = a.sms.send.bind(a.sms);
  const email = a.email.send.bind(a.email);
  a.sms.send = (async (_to: string, _k: string, text: string) => void captured.push({ sms: text })) as never;
  a.email.send = (async (_to: string, subject: string, _h: string, text: string) =>
    void captured.push({ email: { subject, text } })) as never;
  try {
    await notifyLib.notify(key, [{ mobile: '9876543210', email: 'a@b.in' }], data);
  } finally {
    a.sms.send = sms;
    a.email.send = email;
  }
  return captured;
};

describe('helpdesk notification templates (section 10)', () => {
  it('registers all 23 templates of section 10', () => {
    expect(Object.values(NOTIFY)).toHaveLength(23);
    for (const k of Object.values(NOTIFY)) expect(notifyLib.hasTemplate(k)).toBe(true);
  });
  it('cleanData removes every personal or internal key and keeps the rest', () => {
    const dirty: Record<string, unknown> = { ticketNo: 'T1', title: 'Leak' };
    for (const k of FORBIDDEN_KEYS) dirty[k] = 'secret';
    expect(cleanData(dirty)).toEqual({ ticketNo: 'T1', title: 'Leak' });
  });
  it('excerpts are flattened and cut at 140 characters', () => {
    expect(excerptOf('a\n\n  b')).toBe('a b');
    expect(excerptOf('x'.repeat(300)).length).toBe(140);
  });
  it('sla_escalated: level 1 sends no e-mail or SMS, level 2 e-mail, level 3 e-mail and SMS', async () => {
    const d = { ticketNo: 'TKT/1', title: 'Lift', ruleName: 'SLA breached', link: '/issues?id=1' };
    expect(await rendered(NOTIFY.slaEscalated, { ...d, level: 1 })).toHaveLength(0);
    const l2 = await rendered(NOTIFY.slaEscalated, { ...d, level: 2 });
    expect(l2.map(x => Object.keys(x)[0])).toEqual(['email']);
    const l3 = await rendered(NOTIFY.slaEscalated, { ...d, level: 3 });
    expect(l3.map(x => Object.keys(x)[0]).sort()).toEqual(['email', 'sms']);
  });
  it('the digest e-mail lists the counts and the urgent tickets', async () => {
    const out = await rendered(NOTIFY.dailyDigest, {
      date: '2026-11-01',
      open: 4,
      breached: 1,
      unassigned: 2,
      p1: 1,
      p1List: ['TKT/1 Lift stopped'],
    });
    expect(out[0]!.email!.text).toContain('4 open');
    expect(out[0]!.email!.text).toContain('TKT/1 Lift stopped');
  });
  it('registerTemplates stays additive', () => {
    registerTemplates({});
    expect(notifyLib.hasTemplate(NOTIFY.urgentGate)).toBe(true);
  });
});

import { adminLink, residentLink, staffLink } from '../../../src/modules/helpdesk/helpdesk.notify';

describe('deep links and wording', () => {
  it('links match the app routes', () => {
    expect(adminLink(9)).toBe('/admin/issues/9');
    expect(residentLink(9)).toBe('/resident/help/9');
    expect(staffLink(9)).toBe('/work/issues');
  });
  it('the assignment SMS uses priority names', async () => {
    const out = await rendered(NOTIFY.assigned, { ticketNo: 'T-1', title: 'Leak', priority: 'P2' });
    expect(out.map(o => o.sms).join(' ')).toContain('Priority: Urgent.');
  });
});
