import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Society, SocietyNote, closeDb } from '../../../src/models';
import { addDays, now, setNow } from '../../../src/lib/clock';
import { listInbox } from '../../../src/lib/inbox';
import { setSocietyPorts } from '../../../src/modules/societies/societies.ports';
import {
  computeHealth,
  getHealth,
  listAtRiskSocieties,
  runComputeHealth,
} from '../../../src/modules/societies/societies.health';
import { listRoutes } from '../../../src/modules/access-control/access-control.registry';
import { as, idem, login, memberUser, platformLogin, resetLogins } from '../../helpers/access';
import { app } from '../../helpers/auth';
import { lifecycleSociety, platformAs, resetSocieties } from '../../helpers/societies';

afterAll(closeDb);
beforeEach(async () => {
  setNow('2026-10-30T07:00:00Z');
  await resetSocieties();
  resetLogins();
  setNow('2026-10-30T07:00:00Z');
});

describe('society notes (8.16, BR-05-34)', () => {
  it('add, list pinned first, edit within 24 h, pin limit, delete rules', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const isha = await platformAs('platform_support', 'Isha Kapoor');
    const ravi = await platformAs('platform_support', 'Ravi Support');
    const sa = await platformAs('super_admin');
    const add = (c: typeof isha.c, body: Record<string, unknown>) =>
      c('post', `/platform/societies/${s.id}/notes`, body, { headers: idem() });
    const n1 = await add(isha.c, { body: 'Promised a call on Monday about the import', category: 'SUPPORT' });
    expect(n1.status, JSON.stringify(n1.body)).toBe(201);
    expect(n1.body.data).toMatchObject({
      category: 'SUPPORT',
      isPinned: false,
      author: { name: 'Isha Kapoor' },
      canEdit: true,
      canDelete: true,
      version: 1,
    });
    for (let i = 0; i < 3; i++)
      expect((await add(sa.c, { body: `Pinned note ${i}`, isPinned: true })).status).toBe(201);
    const fourth = await add(sa.c, { body: 'One pin too many', isPinned: true });
    expect([fourth.status, fourth.body.code]).toEqual([422, 'NOTE_PIN_LIMIT']);
    expect((await add(isha.c, { body: 'ab' })).status).toBe(400);
    const list = await isha.c('get', `/platform/societies/${s.id}/notes`);
    expect(list.body.data.slice(0, 3).every((n: { isPinned: boolean }) => n.isPinned)).toBe(true);
    expect(list.body.pagination.total).toBe(4);
    const id = n1.body.data.id;
    const other = await ravi.c('patch', `/platform/societies/${s.id}/notes/${id}`, {
      body: 'Changed by someone else',
      version: 1,
    });
    expect([other.status, other.body.code]).toEqual([403, 'NOT_NOTE_AUTHOR']);
    const ok = await isha.c('patch', `/platform/societies/${s.id}/notes/${id}`, {
      body: 'Promised a call on Tuesday',
      version: 1,
    });
    expect(ok.body.data).toMatchObject({ body: 'Promised a call on Tuesday', version: 2 });
    const stale = await isha.c('patch', `/platform/societies/${s.id}/notes/${id}`, {
      body: 'Again',
      version: 1,
    });
    expect(stale.body.code).toBe('STALE_VERSION');
    setNow(addDays(now(), 1));
    resetLogins();
    const isha2 = as(await platformLogin(isha.user), 'PLATFORM');
    const late = await isha2('patch', `/platform/societies/${s.id}/notes/${id}`, {
      body: 'Too late now',
      version: 2,
    });
    expect([late.status, late.body.code]).toEqual([422, 'NOTE_EDIT_WINDOW_CLOSED']);
    expect(await AuditLog.count({ where: { action: 'societies.note.updated' } })).toBe(1);
  });

  it('T05-39 delete by another Support user is 403 NOT_NOTE_AUTHOR; by a Super Admin it works; unknown note 404', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const isha = await platformAs('platform_support', 'Isha Kapoor');
    const ravi = await platformAs('platform_support', 'Ravi Support');
    const sa = await platformAs('super_admin');
    const n = await isha.c(
      'post',
      `/platform/societies/${s.id}/notes`,
      { body: 'Some internal note' },
      { headers: idem() },
    );
    const del = await ravi.c('delete', `/platform/societies/${s.id}/notes/${n.body.data.id}`);
    expect([del.status, del.body.code]).toEqual([403, 'NOT_NOTE_AUTHOR']);
    expect((await sa.c('delete', `/platform/societies/${s.id}/notes/${n.body.data.id}`)).status).toBe(204);
    expect(await SocietyNote.count()).toBe(0);
    expect(await SocietyNote.count({ paranoid: false })).toBe(1);
    const nf = await sa.c('delete', `/platform/societies/${s.id}/notes/${n.body.data.id}`);
    expect([nf.status, nf.body.code]).toEqual([404, 'SOCIETY_NOTE_NOT_FOUND']);
    const wrongSociety = await lifecycleSociety('ACTIVE', { name: 'Other CHS' });
    const n2 = await isha.c(
      'post',
      `/platform/societies/${s.id}/notes`,
      { body: 'Second internal note' },
      { headers: idem() },
    );
    expect(
      (
        await isha.c('patch', `/platform/societies/${wrongSociety.id}/notes/${n2.body.data.id}`, {
          body: 'x y z',
          version: 1,
        })
      ).status,
    ).toBe(404);
  });

  it('T05-45 society routes never return note fields; note bodies stay platform only', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const isha = await platformAs('platform_support');
    await isha.c(
      'post',
      `/platform/societies/${s.id}/notes`,
      { body: 'SECRET-NOTE-BODY-123', isPinned: true },
      { headers: idem() },
    );
    const chair = await memberUser(s, 'chairman');
    const c = as(await login(chair, { societyId: s.id! }));
    const societyGets = listRoutes(app).filter(
      r => r.kind === 'society' && r.method === 'GET' && !r.path.includes(':'),
    );
    expect(societyGets.length).toBeGreaterThan(5);
    for (const r of societyGets) {
      const res = await c('get', r.path);
      expect(JSON.stringify(res.body), r.path).not.toContain('SECRET-NOTE-BODY-123');
      expect(JSON.stringify(res.body), r.path).not.toMatch(/"isPinned"/);
    }
  });
});

describe('nudge (8.15, BR-05-36)', () => {
  it('sends to chairman and society admin once per 24 hours; never to a suspended society', async () => {
    const s = await lifecycleSociety('ACTIVE');
    await memberUser(s, 'chairman', { mobile: '9820012001' });
    await memberUser(s, 'society_admin', { mobile: '9820012002' });
    await memberUser(s, 'treasurer', { mobile: '9820012003' });
    const ps = await platformAs('platform_support');
    const r = await ps.c('post', `/platform/societies/${s.id}/nudge`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual({ sentTo: 2, lastNudgedAt: '2026-10-30T07:00:00.000Z' });
    expect((await listInbox()).filter(m => m.subject === 'Need help with SocietyApp?')).toHaveLength(2);
    const again = await ps.c('post', `/platform/societies/${s.id}/nudge`, { template: 'ADOPTION_TIPS' });
    expect([again.status, again.body.code]).toEqual([429, 'NUDGE_TOO_SOON']);
    const sus = await lifecycleSociety('SUSPENDED', { cause: 'MANUAL', name: 'Suspended CHS' });
    const no = await ps.c('post', `/platform/societies/${sus.id}/nudge`, {});
    expect([no.status, no.body.code]).toEqual([409, 'INVALID_STATE']);
  });
});

describe('health score job (6.5, BR-05-35)', () => {
  it('computes and stores the breakdown, band, snapshots; CLOSED gets 0; at-risk list for module 07', async () => {
    const s = await lifecycleSociety('ACTIVE', { name: 'Sky Heights CHS' });
    await Society.update({ approxFlats: 10 }, { where: { id: s.id! } });
    const chair = await memberUser(s, 'chairman');
    await login(chair, { societyId: s.id! }); // one active user in 30 days
    setSocietyPorts({
      onboarding: { progressPercent: async () => 100 },
      collections: { efficiency: async () => 0.85 },
      units: { count: async () => null },
    });
    const r = await computeHealth(s.id!);
    // adoption 0.1, onboarding 1, collections 0.85, admin activity 1/12 (role changes are audited today), billing 1
    expect(r.breakdown).toMatchObject({ adoption: 0.1, onboarding: 1, collections: 0.85, billing: 1 });
    const h = await getHealth(s.id!);
    expect(h.score).toBe(r.score);
    expect(h.band).toBe(r.score >= 75 ? 'HEALTHY' : r.score >= 55 ? 'WATCH' : 'AT_RISK');
    expect((await Society.findByPk(s.id!))!.activeUsers30).toBe(1);
    const t = await lifecycleSociety('TRIAL', { name: 'Tulip Gardens CHS' });
    const closed = await lifecycleSociety('CLOSED', { name: 'Closed CHS' });
    await Society.update({ healthScore: 50 }, { where: { id: closed.id! } });
    expect(await runComputeHealth()).toBe(3);
    expect((await Society.findByPk(closed.id!))!.healthScore).toBe(0);
    expect(await runComputeHealth()).toBe(2); // CLOSED with score 0 is skipped afterwards
    const risk = await listAtRiskSocieties({ below: 101, limit: 5 });
    expect(risk.map(x => x.societyId)).toContain(t.id);
    expect(risk[0]).toHaveProperty('planKey');
    expect(risk.every(x => x.status !== 'CLOSED')).toBe(true);
  });
});
