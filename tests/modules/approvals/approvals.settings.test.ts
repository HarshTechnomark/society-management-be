import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, closeDb } from '../../../src/models';
import { advance } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { resetLogins } from '../../helpers/access';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { configWorld, type ConfigWorld } from '../../helpers/approvals-config';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
let w: ConfigWorld;
beforeEach(async () => {
  resetLogins();
  resetRateLimits();
  w = await configWorld();
});

describe('GET and PATCH /approvals/settings (8.17, 7.6)', () => {
  it('reads the defaults, also for a viewer', async () => {
    const r = await (await w.api('treasurer'))('get', '/approvals/settings');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ stepUpAbovePaise: 2_500_000, bulkApproveBelowPaise: 2_500_000 });
  });
  it('changes one or both values, writes the audit row and affects the next routing', async () => {
    const api = await w.api('chairman');
    const r = await api('patch', '/approvals/settings', { stepUpAbovePaise: 1_000_000 });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ stepUpAbovePaise: 1_000_000, bulkApproveBelowPaise: 2_500_000 });
    const a = await AuditLog.findOne({ where: { action: 'approvals.settings.updated' } });
    expect(a!.entityType).toBe('approval_settings');
    expect((a!.before as any).stepUpAbovePaise).toBe(2_500_000);
    expect((a!.after as any).stepUpAbovePaise).toBe(1_000_000);
    expect((await api('get', '/approvals/settings')).body.data.stepUpAbovePaise).toBe(1_000_000);
    const sim = await api('post', '/approvals/rules/simulate', { type: 'EXPENSE', amountPaise: 1_200_000 });
    expect(sim.body.data.stepUpRequired).toBe(true);
    const both = await api('patch', '/approvals/settings', {
      stepUpAbovePaise: 5_000_000,
      bulkApproveBelowPaise: 200_000,
    });
    expect(both.body.data).toEqual({ stepUpAbovePaise: 5_000_000, bulkApproveBelowPaise: 200_000 });
  });
  it('400 for an empty body, an out-of-range value or an unknown field', async () => {
    const api = await w.api('chairman');
    for (const body of [
      {},
      { stepUpAbovePaise: 99_999 },
      { bulkApproveBelowPaise: 10 ** 12 + 1 },
      { other: 1 },
      { stepUpAbovePaise: 1.5 },
    ]) {
      const r = await api('patch', '/approvals/settings', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }
    expect(await AuditLog.count({ where: { action: 'approvals.settings.updated' } })).toBe(0);
  });
  it('403 without the edit permission; 401 REAUTH_REQUIRED when the sign-in is old', async () => {
    for (const role of ['treasurer', 'auditor', 'accountant']) {
      const r = await (await w.api(role))('patch', '/approvals/settings', { stepUpAbovePaise: 1_000_000 });
      expect(r.status, role).toBe(403);
    }
    expect((await (await w.api('accountant'))('get', '/approvals/settings')).status).toBe(403);
    const api = await w.api('chairman');
    advance(12 * 60_000);
    const r = await api('patch', '/approvals/settings', { stepUpAbovePaise: 1_000_000 });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('REAUTH_REQUIRED');
    expect((await api('get', '/approvals/settings')).body.data.stepUpAbovePaise).toBe(2_500_000);
  });
});
