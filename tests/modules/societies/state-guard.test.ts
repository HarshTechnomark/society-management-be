import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DataExport, Society, closeDb, sequelize } from '../../../src/models';
import { now, setNow } from '../../../src/lib/clock';
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';
import { onInvoiceOverdue } from '../../../src/modules/societies/societies.lifecycle';
import { systemCtx } from '../../../src/types/context';
import { as, idem, login, memberUser, resetLogins } from '../../helpers/access';
import { probeAs } from '../../helpers/probe';
import { lifecycleSociety, platformAs, resetSocieties, settle } from '../../helpers/societies';
import type { Society as SocietyRow } from '../../../src/models/society.model';

afterAll(closeDb);
beforeEach(async () => {
  setNow('2026-10-30T06:30:00Z');
  await resetSocieties();
  resetLogins();
  setNow('2026-10-30T06:30:00Z');
});

const setStatus = async (s: SocietyRow, status: 'SUSPENDED' | 'CLOSED', cause = 'NON_PAYMENT') => {
  await Society.update(
    status === 'SUSPENDED'
      ? ({ status, suspendedAt: now(), suspensionCause: cause } as never)
      : ({ status, closedAt: now(), closureReason: 'OTHER', suspensionCause: null } as never),
    { where: { id: s.id! } },
  );
  await flushAcl();
};

describe('suspended society (BR-05-11, BR-05-12, 6.2.1)', () => {
  it('T05-15 notice publish is 423; resident payment order, SOS and a data export request succeed; module 03 writes are 423', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const chair = await memberUser(s, 'chairman');
    const cookies = await login(chair, { societyId: s.id! });
    await setStatus(s, 'SUSPENDED');
    const p = probeAs(cookies);
    const notice = await p('post', '/notices/1/publish', {});
    expect([notice.status, notice.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
    expect((await p('post', '/me/payables/payment-orders', {})).status).toBe(201);
    expect((await p('post', '/me/sos', {})).status).toBe(201);
    const c = as(cookies);
    const exp = await c('post', '/data-exports', { includeDocuments: false }, { headers: idem() });
    expect(exp.status, JSON.stringify(exp.body)).toBe(201);
    expect(exp.body.data).toMatchObject({ kind: 'FULL', requestedVia: 'SOCIETY', status: 'QUEUED' });
    const role = await c(
      'post',
      '/roles',
      { name: 'Blocked role', scope: 'society', permissionKeys: ['dashboard.today.view'] },
      { headers: idem() },
    );
    expect(role.body.code).toBe('SOCIETY_SUSPENDED');
    expect((await c('get', '/roles')).status).toBe(200);
    // a consent setting change is a normal write (8.23)
    const set = await c('patch', '/support-access/settings', { requiresSupportConsent: false, version: 1 });
    expect(set.body.code).toBe('SOCIETY_SUSPENDED');
    await settle();
  });

  it('PAST_DUE blocks nothing', async () => {
    const s = await lifecycleSociety('ACTIVE');
    const chair = await memberUser(s, 'chairman');
    const cookies = await login(chair, { societyId: s.id! });
    await sequelize.transaction(t => onInvoiceOverdue(systemCtx('billing'), s.id!, t));
    expect((await probeAs(cookies)('post', '/notices/1/publish', {})).status).toBe(200);
  });
});

describe('closed society (BR-05-11, BR-05-13)', () => {
  it('T05-16 invoices list is 423 SOCIETY_CLOSED; /society-status and the closure export download URL are 200; SOS is 423', async () => {
    const s = await lifecycleSociety('ACTIVE', { name: 'Sky Heights CHS' });
    const chair = await memberUser(s, 'chairman');
    const cookies = await login(chair, { societyId: s.id! });
    const sa = await platformAs('super_admin');
    const close = await sa.c('post', `/platform/societies/${s.id}/close`, {
      closureReason: 'CUSTOMER_REQUEST',
      reason: 'The committee asked to close',
      confirmName: 'Sky Heights CHS',
      version: 1,
    });
    expect(close.status, JSON.stringify(close.body)).toBe(200);
    await settle();
    const p = probeAs(cookies);
    const inv = await p('get', '/invoices');
    expect([inv.status, inv.body.code]).toEqual([423, 'SOCIETY_CLOSED']);
    expect((await p('post', '/me/sos', {})).body.code).toBe('SOCIETY_CLOSED');
    const c = as(cookies);
    const st = await c('get', '/society-status');
    expect(st.status).toBe(200);
    expect(st.body.data).toMatchObject({
      status: 'CLOSED',
      readOnly: true,
      banner: { tone: 'bad', key: 'CLOSED' },
      closureExportId: close.body.data.closureExportId,
    });
    const exp = (await DataExport.findByPk(close.body.data.closureExportId))!;
    expect(exp.status).toBe('READY');
    expect(exp.expiresAt!.toISOString()).toBe('2026-11-29T06:30:00.000Z');
    const url = await c('get', `/data-exports/${exp.id}/download-url`);
    expect(url.status, JSON.stringify(url.body)).toBe(200);
    expect(url.body.data.fileName).toBe(`${s.slug}-export-20261030-1200-part-001.zip`);
    expect((await c('get', '/data-exports')).status).toBe(200);
    expect(
      (await c('post', '/data-exports', { includeDocuments: true }, { headers: idem() })).body.code,
    ).toBe('SOCIETY_CLOSED');
    expect((await c('get', '/support-access')).body.code).toBe('SOCIETY_CLOSED');
  });
});

describe('GET /society-status (8.22)', () => {
  it('trial banner and trial end only for subscription viewers; suspended banner for every admin user; past-due only for billing admins', async () => {
    const s = await lifecycleSociety('TRIAL');
    const chair = await memberUser(s, 'chairman');
    const fm = await memberUser(s, 'facility_manager');
    const cc = as(await login(chair, { societyId: s.id! }));
    const fc = as(await login(fm, { societyId: s.id! }));
    const a = (await cc('get', '/society-status')).body.data;
    expect(a).toMatchObject({
      status: 'TRIAL',
      readOnly: false,
      banner: { key: 'TRIAL', tone: 'info' },
      supportAccess: null,
      pendingSupportRequests: 0,
    });
    expect(a.trialEndsAt).not.toBeNull();
    const b = (await fc('get', '/society-status')).body.data;
    expect(b).toMatchObject({ banner: null, trialEndsAt: null, pendingSupportRequests: null });
    await setStatus(s, 'SUSPENDED', 'TRIAL_EXPIRED');
    const c = (await fc('get', '/society-status')).body.data;
    expect(c).toMatchObject({
      status: 'SUSPENDED',
      readOnly: true,
      banner: { key: 'SUSPENDED', tone: 'bad' },
      suspensionCause: null,
    });
    expect((await cc('get', '/society-status')).body.data.suspensionCause).toBe('TRIAL_EXPIRED');
  });
});
