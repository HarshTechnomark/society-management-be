import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Organization, Role, Society, closeDb, sequelize } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { replaceRoleKeys } from '../../../src/modules/access-control/access-control.util';
import { idem, platformLogin, as, resetLogins } from '../../helpers/access';
import { makeUser } from '../../helpers/auth';
import { platformAs } from '../../helpers/societies';
import { opsSociety, resetOps } from '../../helpers/platform-ops';

afterAll(closeDb);
beforeEach(async () => {
  await resetOps();
  resetLogins();
  setNow('2026-10-30T04:00:00Z');
});

const org = (o: Record<string, unknown> = {}) => ({
  name: 'Lodha Facility Group',
  slug: 'lodha-facility',
  gstin: '27ABCDE1234F1Z5',
  contactEmail: 'Ops@Lodha.example',
  contactMobile: '9820011111',
  ...o,
});

describe('organizations (8.12)', () => {
  it('creates an organization: lowercased email, masked mobile, audit row, idempotent replay', async () => {
    const sa = await platformAs('super_admin');
    const key = idem();
    const r = await sa.c('post', '/platform/organizations', org(), { headers: key });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      name: 'Lodha Facility Group',
      slug: 'lodha-facility',
      status: 'ACTIVE',
      contactEmail: 'ops@lodha.example',
      contactMobileMasked: '98XXXXX111',
      societyCount: 0,
    });
    expect(JSON.stringify(r.body)).not.toContain('9820011111');
    const again = await sa.c('post', '/platform/organizations', org(), { headers: key });
    expect(again.body.data.id).toBe(r.body.data.id);
    expect(await Organization.count()).toBe(1);
    const a = await AuditLog.findOne({ where: { action: 'platform.organization.created' } });
    expect(a).toMatchObject({ entityType: 'organization', societyId: null });
    expect(JSON.stringify(a!.after)).not.toContain('9820011111');
  });

  it('T07-51 a used slug is 409 ORGANIZATION_SLUG_TAKEN, also after closing; reserved words too', async () => {
    const sa = await platformAs('super_admin');
    const first = await sa.c('post', '/platform/organizations', org(), { headers: idem() });
    const dup = await sa.c('post', '/platform/organizations', org({ name: 'Another Group' }), {
      headers: idem(),
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('ORGANIZATION_SLUG_TAKEN');
    await sa.c('post', `/platform/organizations/${first.body.data.id}/status`, {
      status: 'CLOSED',
      reason: 'Contract ended',
    });
    expect((await sa.c('post', '/platform/organizations', org(), { headers: idem() })).body.code).toBe(
      'ORGANIZATION_SLUG_TAKEN',
    );
    expect(
      (await sa.c('post', '/platform/organizations', org({ slug: 'admin' }), { headers: idem() })).body.code,
    ).toBe('ORGANIZATION_SLUG_TAKEN');
  });

  it('validation: slug pattern, name length, GSTIN, mobile, unknown fields', async () => {
    const sa = await platformAs('super_admin');
    for (const bad of [
      { slug: 'Bad Slug' },
      { slug: 'ab' },
      { slug: '-bad-' },
      { name: 'x' },
      { gstin: '27abcde' },
      { contactMobile: '1234567890' },
      { contactEmail: 'nope' },
      { extra: true },
    ]) {
      const r = await sa.c('post', '/platform/organizations', org(bad), { headers: idem() });
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    }
  });

  it('lists with filters and searches; get-one shows the societies with their plan', async () => {
    const sa = await platformAs('super_admin');
    const a = await sa.c('post', '/platform/organizations', org(), { headers: idem() });
    await sa.c('post', '/platform/organizations', org({ name: 'Acme Towers', slug: 'acme-towers' }), {
      headers: idem(),
    });
    const s = await opsSociety('Lodha Park CHS');
    await Society.update({ organizationId: a.body.data.id }, { where: { id: s.id! } });
    const list = await sa.c('get', '/platform/organizations');
    expect(list.body.data.map((o: any) => o.slug)).toEqual(['acme-towers', 'lodha-facility']); // name ascending
    expect(list.body.data[1].societyCount).toBe(1);
    expect(list.body.data[1].societies).toBeUndefined();
    expect(
      (await sa.c('get', '/platform/organizations', undefined, { query: { q: 'lod' } })).body.data,
    ).toHaveLength(1);
    expect(
      (await sa.c('get', '/platform/organizations', undefined, { query: { q: 'tower' } })).body.data,
    ).toHaveLength(1);
    expect(
      (await sa.c('get', '/platform/organizations', undefined, { query: { status: 'SUSPENDED' } })).body.data,
    ).toHaveLength(0);
    const one = await sa.c('get', `/platform/organizations/${a.body.data.id}`);
    expect(one.body.data.societies).toEqual([
      { id: s.id, name: 'Lodha Park CHS', status: 'ACTIVE', planKey: 'PREMIUM' },
    ]);
    expect((await sa.c('get', '/platform/organizations/99999')).body.code).toBe('ORGANIZATION_NOT_FOUND');
    // Platform Support may read and create, not edit
    const agent = await platformAs('platform_support');
    expect((await agent.c('get', '/platform/organizations')).status).toBe(200);
    expect(
      (await agent.c('post', '/platform/organizations', org({ slug: 'from-support' }), { headers: idem() }))
        .status,
    ).toBe(201);
    expect(
      (await agent.c('patch', `/platform/organizations/${a.body.data.id}`, { name: 'Renamed Group' })).status,
    ).toBe(403);
  });

  it('PATCH edits with before and after in the audit, rejects a slug, refuses a closed organization', async () => {
    const sa = await platformAs('super_admin');
    const a = await sa.c('post', '/platform/organizations', org(), { headers: idem() });
    const id = a.body.data.id;
    expect((await sa.c('patch', `/platform/organizations/${id}`, { slug: 'new-slug' })).status).toBe(400);
    const r = await sa.c('patch', `/platform/organizations/${id}`, {
      name: 'Lodha Group',
      contactMobile: null,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      name: 'Lodha Group',
      contactMobileMasked: null,
      slug: 'lodha-facility',
    });
    const au = await AuditLog.findOne({ where: { action: 'platform.organization.updated' } });
    expect(au!.before).toMatchObject({ name: 'Lodha Facility Group' });
    expect(au!.after).toMatchObject({ name: 'Lodha Group', contactMobile: null });
    // nothing changed: no audit row
    await sa.c('patch', `/platform/organizations/${id}`, { name: 'Lodha Group' });
    expect(await AuditLog.count({ where: { action: 'platform.organization.updated' } })).toBe(1);
    expect((await sa.c('patch', '/platform/organizations/99999', { name: 'Nobody Here' })).body.code).toBe(
      'ORGANIZATION_NOT_FOUND',
    );
    await sa.c('post', `/platform/organizations/${id}/status`, {
      status: 'CLOSED',
      reason: 'Contract ended',
    });
    const closed = await sa.c('patch', `/platform/organizations/${id}`, { name: 'Too Late Group' });
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('INVALID_STATE');
  });

  it('BR-07-52 status moves ACTIVE <-> SUSPENDED and to CLOSED; closing needs every society CLOSED', async () => {
    const sa = await platformAs('super_admin');
    const a = await sa.c('post', '/platform/organizations', org(), { headers: idem() });
    const id = a.body.data.id;
    const set = (status: string, reason = 'Contract review') =>
      sa.c('post', `/platform/organizations/${id}/status`, { status, reason });
    expect((await set('SUSPENDED')).body.data.status).toBe('SUSPENDED');
    const same = await set('SUSPENDED');
    expect(same.status).toBe(409);
    expect(same.body.code).toBe('INVALID_STATE');
    expect((await set('ACTIVE')).body.data.status).toBe('ACTIVE');
    expect((await set('SUSPENDED', 'abc')).status).toBe(400);
    const s = await opsSociety('Lodha Park CHS', 'SUSPENDED');
    await Society.update({ organizationId: id }, { where: { id: s.id! } });
    const blocked = await set('CLOSED', 'Contract ended');
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('ORGANIZATION_HAS_SOCIETIES'); // a SUSPENDED society still blocks
    await Society.update({ organizationId: null }, { where: { id: s.id! } });
    const closed = await set('CLOSED', 'Contract ended');
    expect(closed.body.data.status).toBe('CLOSED');
    expect((await set('ACTIVE')).body.code).toBe('INVALID_STATE'); // CLOSED is final
    const rows = await AuditLog.findAll({
      where: { action: 'platform.organization.status_changed' },
      order: [['id', 'ASC']],
    });
    expect(rows.map(r => [(r.before as any).status, (r.after as any).status, r.reason])).toEqual([
      ['ACTIVE', 'SUSPENDED', 'Contract review'],
      ['SUSPENDED', 'ACTIVE', 'Contract review'],
      ['ACTIVE', 'CLOSED', 'Contract ended'],
    ]);
    expect(await Organization.count({ paranoid: false, where: { id } })).toBe(1);
    expect((await Organization.findByPk(id))!.deletedAt).toBeNull();
  });

  it('closing needs platform.societies.delete; the status route needs a recent sign-in', async () => {
    const sa = await platformAs('super_admin');
    const a = await sa.c('post', '/platform/organizations', org(), { headers: idem() });
    const id = a.body.data.id;
    const role = await Role.create({
      societyId: null,
      scope: 'platform',
      key: 'custom_org_editor',
      name: 'Org editor',
      description: null,
      isSystem: false,
      requiresMfa: true,
      consumesSeat: false,
      basedOnRoleId: null,
      version: 1,
      createdBy: null,
      updatedBy: null,
    });
    await sequelize.transaction(tx =>
      replaceRoleKeys(role, ['platform.societies.edit', 'platform.societies.view'], null, tx),
    );
    const u = await makeUser({ email: 'editor@societyapp.in', mfa: true, platformRoleId: role.id! });
    const c = as(await platformLogin({ ...u, email: 'editor@societyapp.in' }), 'PLATFORM');
    const close = await c('post', `/platform/organizations/${id}/status`, {
      status: 'CLOSED',
      reason: 'Contract ended',
    });
    expect(close.status).toBe(403);
    expect(close.body.code).toBe('PERMISSION_DENIED');
    expect(
      (
        await c('post', `/platform/organizations/${id}/status`, {
          status: 'SUSPENDED',
          reason: 'Contract review',
        })
      ).status,
    ).toBe(200);
    setNow('2026-10-30T04:06:00Z');
    const stale = await c('post', `/platform/organizations/${id}/status`, {
      status: 'ACTIVE',
      reason: 'Contract review',
    });
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
  });
});
