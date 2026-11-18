import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Society, closeDb } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { invalidateSociety } from '../../../src/modules/access-control/access-control.public';
import { setHelpdeskPorts } from '../../../src/modules/helpdesk/helpdesk.ports';
import { as, idem, lifecycleColumns, login } from '../../helpers/access';
import { helpdeskWorld, resetHelpdesk, type HelpdeskWorld } from '../../helpers/helpdesk';

afterAll(closeDb);

let w: HelpdeskWorld;
let A: ReturnType<typeof as>;
beforeAll(async () => {
  await resetHelpdesk();
  w = await helpdeskWorld('STARTER');
  A = as(await login(w.adminUser));
});
beforeEach(() => {
  setHelpdeskPorts();
  setNow('2026-11-01T04:30:00Z');
});

const bi = async (over: Record<string, unknown> = {}) =>
  A(
    'post',
    '/building-issues',
    {
      locationNodeId: w.buildingA.locationNodeId,
      categoryId: (await w.cat('Garden')).id,
      urgency: 'NORMAL',
      duplicateReason: 'Reported separately by another person',
      ...over,
    },
    { headers: idem() },
  );

describe('plan gates on a Starter society (T15-26, T15-27)', () => {
  it('keeps building issues and merge always on, gates QR, STAFF and VENDOR assignees', async () => {
    const a = await bi();
    const b = await bi({ title: 'Second report of the lawn' });
    expect([a.status, b.status]).toEqual([201, 201]);
    const m = await A(
      'post',
      `/tickets/${b.body.data.id}/merge`,
      { intoTicketId: a.body.data.id, version: 1 },
      { headers: idem() },
    );
    expect(m.status).toBe(200);
    const qr = await bi({ qrToken: 'ABCDEFGHIJKL' });
    expect([qr.status, qr.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    const flat = await A(
      'post',
      '/tickets',
      {
        unitId: w.a101,
        channel: 'WALK_IN',
        categoryId: (await w.cat('Noise')).id,
        title: 'Loud music every night',
        description: 'From the flat above, every night',
      },
      { headers: idem() },
    );
    expect(flat.status).toBe(201);
    for (const body of [
      { assigneeType: 'STAFF', staffId: 1 },
      { assigneeType: 'VENDOR', vendorId: 1 },
    ]) {
      const r = await A('post', `/tickets/${flat.body.data.id}/assign`, { ...body, version: 1 });
      expect([body.assigneeType, r.status, r.body.code]).toEqual([
        body.assigneeType,
        402,
        'FEATURE_NOT_IN_PLAN',
      ]);
    }
    const s = await A('get', '/tickets/stats');
    expect(s.status).toBe(200);
    const asg = await A('get', '/tickets/assignees');
    expect(asg.body.data).toMatchObject({ staff: [], vendors: [] });
  });
});

describe('suspended society (T15-36, admin part)', () => {
  it('keeps reads but refuses every admin write with 423 SOCIETY_SUSPENDED', async () => {
    const t = await A(
      'post',
      '/tickets',
      {
        unitId: w.a101,
        channel: 'PHONE',
        categoryId: (await w.cat('Noise')).id,
        title: 'Noise before suspension',
        description: 'Raised before the suspension',
      },
      { headers: idem() },
    );
    expect(t.status).toBe(201);
    await Society.update(lifecycleColumns('SUSPENDED') as never, { where: { id: w.sid } });
    await invalidateSociety(w.sid);
    expect((await A('get', '/tickets')).status).toBe(200);
    expect((await A('get', `/tickets/${t.body.data.id}`)).status).toBe(200);
    const writes: [string, string, unknown][] = [
      [
        'post',
        '/building-issues',
        { locationNodeId: w.buildingA.locationNodeId, categoryId: 1, urgency: 'NORMAL' },
      ],
      [
        'post',
        '/tickets',
        {
          unitId: w.a101,
          channel: 'PHONE',
          categoryId: 1,
          title: 'Raised while suspended',
          description: 'Should not be accepted',
        },
      ],
      ['patch', `/tickets/${t.body.data.id}`, { title: 'Edited while suspended', version: 1 }],
      ['post', `/tickets/${t.body.data.id}/comments`, { body: 'Comment while suspended' }],
      [
        'post',
        `/tickets/${t.body.data.id}/transition`,
        { action: 'CANCEL', reason: 'Cancel while suspended', version: 1 },
      ],
    ];
    for (const [m, path, body] of writes) {
      const r = await A(m as 'post', path, body, { headers: idem() });
      expect([m, path, r.status, r.body.code]).toEqual([m, path, 423, 'SOCIETY_SUSPENDED']);
    }
  });
});
