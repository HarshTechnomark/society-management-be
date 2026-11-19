import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmergencyBroadcast, InboxItem, closeDb } from '../../../src/models';
import { clearInbox, listInbox } from '../../../src/lib/inbox';
import { smsSegments } from '../../../src/modules/communication/communication.render';
import { COMMUNICATION_TEMPLATES } from '../../../src/modules/communication/communication.templates.defs';
import { commWorld, idem, type CommWorld } from '../../helpers/communication';

afterAll(async () => {
  await closeDb();
});
let w: CommWorld;
beforeAll(async () => {
  w = await commWorld('STARTER');
}, 300_000);

const start = (body: Record<string, unknown>) =>
  w.chair(
    'post',
    '/emergency-broadcasts',
    { message: 'Smoke seen on the 2nd floor, use the stairs', confirm: true, ...body },
    { headers: idem() },
  );

describe('emergency links, texts and plurals (fix A)', () => {
  it('templates deep-link to the resident alert page, not /emergency/<id>', () => {
    const emg = COMMUNICATION_TEMPLATES.filter(t => t.key.includes('.emergency_'));
    expect(emg.length).toBeGreaterThan(0);
    for (const t of emg) expect(t.deepLink).toMatch(/^\/resident\/emergency-alert/);
  });

  it('SMS of start, update and re-alert carries the message, the new link, and fits 2 segments', async () => {
    await clearInbox();
    const long = 'Fire on the ground floor of Tower B. '.repeat(13).trim().slice(0, 500);
    const r = await start({ type: 'FIRE', message: long });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const { id, version } = r.body.data;
    const u = await w.chair('post', `/emergency-broadcasts/${id}/updates`, {
      version,
      message: 'Brigade arrived, keep the stairs clear',
    });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    const ra = await w.chair('post', `/emergency-broadcasts/${id}/realert`, { version: u.body.data.version });
    expect(ra.status, JSON.stringify(ra.body)).toBe(200);
    const sms = (await listInbox()).filter(m => m.channel === 'SMS');
    const pick = (h: string) => sms.find(m => m.body.includes(h));
    expect(pick('ALERT: Fire.')!.body).toContain('Fire on the ground floor');
    expect(pick('UPDATE: Fire.')!.body).toContain('Brigade arrived');
    expect(pick('RE-ALERT: Fire.')!.body).toContain('Fire on the ground floor');
    for (const m of sms) {
      expect(m.body).toContain(`/resident/emergency-alert?id=${id}`);
      expect(smsSegments(m.body).segments).toBeLessThanOrEqual(2);
    }
    // re-alert is push and SMS only: no inbox rows
    expect(await InboxItem.count({ where: { templateKey: 'communication.emergency_realert' } })).toBe(0);
    await w.chair('post', `/emergency-broadcasts/${id}/resolve`, {
      version: ra.body.data.version,
      allClearMessage: 'All clear, thank you everyone',
    });
  }, 120_000);

  it('re-alert and responses are refused when the broadcast does not collect responses', async () => {
    const r = await start({ type: 'GAS_LEAK', collectResponses: false });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const { id, version } = r.body.data;
    const ra = await w.chair('post', `/emergency-broadcasts/${id}/realert`, { version });
    expect(ra.status).toBe(422);
    expect(ra.body.code).toBe('EMERGENCY_REALERT_NOT_ALLOWED');
    const rs = await w.own(
      'post',
      `/emergency-broadcasts/${id}/responses`,
      { status: 'SAFE' },
      { headers: idem() },
    );
    expect(rs.status).toBe(422);
    expect(rs.body.code).toBe('EMERGENCY_RESPONSES_DISABLED');
    expect((await EmergencyBroadcast.findByPk(id))!.realertCount).toBe(0);
  }, 120_000);

  it('default titles follow the type labels', async () => {
    const { DEFAULT_TITLES } =
      await import('../../../src/modules/communication/communication.emergency.shared');
    expect(DEFAULT_TITLES.WATER).toBe('Water outage');
    expect(DEFAULT_TITLES.LIFT_STUCK).toBe('Lift trapped');
  });

  it('NEED_HELP carries the people count and the text is pluralised', async () => {
    await clearInbox();
    const r = await start({ type: 'WATER' });
    const { id } = r.body.data;
    const one = await w.own(
      'post',
      `/emergency-broadcasts/${id}/responses`,
      { status: 'NEED_HELP', note: 'Stuck' },
      { headers: idem() },
    );
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    expect(one.body.data.peopleCount).toBe(1);
    const three = await w.ownB(
      'post',
      `/emergency-broadcasts/${id}/responses`,
      { status: 'NEED_HELP', peopleCount: 3, note: 'Three stuck' },
      { headers: idem() },
    );
    expect(three.body.data.peopleCount).toBe(3);
    const bodies = (await listInbox()).map(m => m.body).join('\n');
    expect(bodies).toContain('(1 person)');
    expect(bodies).toContain('(3 people)');
    expect(bodies).not.toMatch(/\(1 people\)|1 people/);
  }, 120_000);
});
