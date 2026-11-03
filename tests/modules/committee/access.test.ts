import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CommitteeTerm, closeDb, sequelize } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { listRoutes } from '../../../src/modules/access-control/access-control.registry';
import { app } from '../../helpers/auth';
import { call } from '../../helpers/auth';
import { memberOf } from '../../helpers/society-setup';
import {
  committeeWorld,
  holder,
  idem,
  postTerm,
  rawTerm,
  resetCommittee,
  seat,
  seated,
  suspend,
  termBody,
} from '../../helpers/committee';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetCommittee);

async function withDraft() {
  const w = await committeeWorld();
  const a = await holder(w, 1, 'Rajesh Kulkarni');
  const d = await postTerm(w.c, termBody([seat(a, w, 1, 'CHAIRMAN')]));
  return { w, a, d };
}

describe('route registry (section 13)', () => {
  it('every committee route of 10.1 has a society marker, the permission and the entitlement of section 8', () => {
    const routes = listRoutes(app).filter(r => r.path.startsWith('/committee'));
    const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;
    const found = Object.fromEntries(routes.map(r => [key(r), r]));
    const expected: Record<string, [string, string | null, boolean]> = {
      'GET /committee': ['settings.members.view', 'governance.committee_terms', false],
      'GET /committee/terms': ['settings.members.view', 'governance.committee_terms', false],
      'POST /committee/terms': ['settings.members.create', 'governance.committee_terms', true],
      'GET /committee/terms/:id': ['settings.members.view', 'governance.committee_terms', false],
      'PATCH /committee/terms/:id': ['settings.members.edit', 'governance.committee_terms', false],
      'DELETE /committee/terms/:id': ['settings.members.delete', 'governance.committee_terms', false],
      'PATCH /committee/terms/:id/seats/:seatId': [
        'settings.members.edit',
        'governance.committee_terms',
        false,
      ],
    };
    for (const [k, [perm, feature, idempotent]] of Object.entries(expected)) {
      expect(found[k], k).toBeDefined();
      expect(found[k]).toMatchObject({
        kind: 'society',
        permissions: [perm],
        idempotent,
        features: [feature],
      });
    }
  });
});

describe('route registry of 10.2 (sections 2.1, 8.7 to 8.9)', () => {
  it('activation and change routes need settings.members.edit, both entitlements; activate and apply also step-up and idempotency', () => {
    const routes = listRoutes(app).filter(r => r.path.startsWith('/committee/terms/:id/'));
    const found = Object.fromEntries(routes.map(r => [`${r.method} ${r.path}`, r]));
    const expected: Record<string, [boolean, boolean]> = {
      'GET /committee/terms/:id/activation-preview': [false, false],
      'POST /committee/terms/:id/activate': [true, true],
      'POST /committee/terms/:id/changes/preview': [false, false],
      'POST /committee/terms/:id/changes': [true, true],
    };
    for (const [k, [idempotent, stepUp]] of Object.entries(expected)) {
      expect(found[k], k).toBeDefined();
      expect(found[k], k).toMatchObject({
        kind: 'society',
        permissions: ['settings.members.edit'],
        features: ['governance.committee_terms', 'governance.office_bearers'],
        idempotent,
        stepUp,
      });
    }
  });
});

describe('T10-30 permissions (section 2.1)', () => {
  it('a committee member (settings.members view only) can read and gets 403 PERMISSION_DENIED on every write', async () => {
    const { w, d } = await withDraft();
    const m = await memberOf(w.society, 'committee_member');
    expect((await m.c('get', '/committee')).status).toBe(200);
    expect((await m.c('get', '/committee/terms')).status).toBe(200);
    expect((await m.c('get', `/committee/terms/${d.id}`)).status).toBe(200);
    const writes: [string, string, Record<string, unknown>][] = [
      ['post', '/committee/terms', termBody([])],
      ['patch', `/committee/terms/${d.id}`, { version: 1, name: 'A new name' }],
      ['delete', `/committee/terms/${d.id}`, { version: 1, reason: 'Not allowed' }],
      ['patch', `/committee/terms/${d.id}/seats/S1`, { version: 1, portfolios: [] }],
    ];
    for (const [method, path, body] of writes) {
      const r = await m.c(method as 'post', path, body, { headers: idem() });
      expect([r.status, r.body.code], `${method} ${path}`).toEqual([403, 'PERMISSION_DENIED']);
    }
    expect((await CommitteeTerm.findByPk(d.id))!.version).toBe(1);
  });

  it('the secretary (view, create, edit) cannot delete; the treasurer and staff roles with view only can read', async () => {
    const { w, d } = await withDraft();
    const sec = await memberOf(w.society, 'secretary');
    expect(
      (await sec.c('patch', `/committee/terms/${d.id}`, { version: 1, name: 'Renamed by secretary' })).status,
    ).toBe(200);
    const del = await sec.c('delete', `/committee/terms/${d.id}`, { version: 2, reason: 'Secretary cannot' });
    expect([del.status, del.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    for (const role of ['treasurer', 'facility_manager', 'auditor']) {
      const m = await memberOf(w.society, role);
      expect((await m.c('get', '/committee')).status, role).toBe(200);
      expect((await m.c('post', '/committee/terms', termBody([]), { headers: idem() })).status, role).toBe(
        403,
      );
    }
  });

  it('a resident-scope member and a signed-out caller are refused', async () => {
    const { w, d } = await withDraft();
    const owner = await holder(w, 2, 'Plain Owner');
    expect((await owner.c('get', '/committee')).status).toBe(403);
    const r = await call('get', `/api/v1/committee/terms/${d.id}`, undefined);
    expect([r.status, r.body.code]).toEqual([401, 'UNAUTHENTICATED']);
  });
});

describe('T10-29 tenant isolation', () => {
  it("society A's chairman gets 404 COMMITTEE_TERM_NOT_FOUND for every route with society B's term", async () => {
    const a = await committeeWorld();
    const b = await committeeWorld();
    const hb = await holder(b, 1, 'Other Chairman');
    const term = await postTerm(b.c, termBody([seat(hb, b, 1, 'CHAIRMAN')]));
    const cases: [string, string, Record<string, unknown> | undefined][] = [
      ['get', `/committee/terms/${term.id}`, undefined],
      ['patch', `/committee/terms/${term.id}`, { version: 1, name: 'Hijacked name' }],
      ['delete', `/committee/terms/${term.id}`, { version: 1, reason: 'Hijack attempt' }],
      ['patch', `/committee/terms/${term.id}/seats/S1`, { version: 1, portfolios: ['LEGAL'] }],
    ];
    for (const [method, path, body] of cases) {
      const r = await a.c(method as 'get', path, body, { headers: idem() });
      expect([r.status, r.body.code], `${method} ${path}`).toEqual([404, 'COMMITTEE_TERM_NOT_FOUND']);
    }
    expect((await a.c('get', '/committee/terms')).body.data).toEqual([]);
    expect((await a.c('get', '/committee')).body.data).toMatchObject({ current: null, draft: null });
    const row = (await CommitteeTerm.findByPk(term.id))!;
    expect(row.version).toBe(1);
    expect(row.deletedAt).toBeNull();
    // the other society's draft does not block a draft of society A
    const ha = await holder(a, 1, 'Chair A');
    expect(
      (await a.c('post', '/committee/terms', termBody([seat(ha, a, 1, 'CHAIRMAN')]), { headers: idem() }))
        .status,
    ).toBe(201);
  });

  it("a holder of another society cannot be seated: their membership there is not this society's", async () => {
    const a = await committeeWorld();
    const b = await committeeWorld();
    const foreign = await holder(b, 1, 'Foreign Owner');
    const r = await a.c(
      'post',
      '/committee/terms',
      termBody([{ userId: foreign.user.id, unitId: a.unit(1).id, designation: 'MEMBER' }]),
      { headers: idem() },
    );
    expect([r.status, r.body.code]).toEqual([422, 'COMMITTEE_HOLDER_NOT_MEMBER']);
  });
});

describe('T10-34 society state', () => {
  it('a SUSPENDED society can read the committee and every write is 423 SOCIETY_SUSPENDED', async () => {
    const { w, d } = await withDraft();
    await suspend(w.society.id!);
    expect((await w.c('get', '/committee')).status).toBe(200);
    expect((await w.c('get', `/committee/terms/${d.id}`)).status).toBe(200);
    const writes: [string, string, Record<string, unknown>][] = [
      ['post', '/committee/terms', termBody([])],
      ['patch', `/committee/terms/${d.id}`, { version: 1, name: 'Not while suspended' }],
      ['delete', `/committee/terms/${d.id}`, { version: 1, reason: 'Not while suspended' }],
      ['patch', `/committee/terms/${d.id}/seats/S1`, { version: 1, portfolios: [] }],
    ];
    for (const [method, path, body] of writes) {
      const r = await w.c(method as 'post', path, body, { headers: idem() });
      expect([r.status, r.body.code], `${method} ${path}`).toEqual([423, 'SOCIETY_SUSPENDED']);
    }
    expect((await CommitteeTerm.findByPk(d.id))!.version).toBe(1);
  });
});

describe('plan (section 2.2)', () => {
  it('a STARTER society has the committee (governance.committee_terms and office_bearers are Starter)', async () => {
    const w = await committeeWorld({ plan: 'STARTER' });
    const a = await holder(w, 1, 'Rajesh Kulkarni');
    const d = await w.c('post', '/committee/terms', termBody([seat(a, w, 1, 'CHAIRMAN')]), {
      headers: idem(),
    });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect((await w.c('get', '/committee')).status).toBe(200);
  });
});

describe('BR-10-31 concurrency and malformed data', () => {
  it('two parallel edits with the same version: one wins, the other is 409 STALE_VERSION; the version moves by one', async () => {
    const { w, d } = await withDraft();
    const [x, y] = await Promise.all([
      w.c('patch', `/committee/terms/${d.id}`, { version: 1, name: 'First writer' }),
      w.c('patch', `/committee/terms/${d.id}`, { version: 1, name: 'Second writer' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x, y].find(r => r.status === 409)!.body.code).toBe('STALE_VERSION');
    expect((await CommitteeTerm.findByPk(d.id))!.version).toBe(2);
  });

  it('a malformed seat list in the row is 500 INTERNAL_ERROR, not a partial answer (section 12)', async () => {
    const { w, d } = await withDraft();
    await sequelize.query(`UPDATE committee_terms SET members = '[{"seatId":"S1"}]' WHERE id = ${d.id}`);
    const r = await w.c('get', `/committee/terms/${d.id}`);
    expect([r.status, r.body.code]).toEqual([500, 'INTERNAL_ERROR']);
  });

  it('a term row that no seat of is read still lists (an empty seats array)', async () => {
    const w = await committeeWorld();
    const t = await rawTerm(w.society.id!, {
      members: [seated('S1', { user: { id: 1 } }, 'Someone', 'MEMBER')],
    });
    const r = await w.c('get', '/committee/terms');
    expect(r.body.data[0].id).toBe(t.id);
  });
});
