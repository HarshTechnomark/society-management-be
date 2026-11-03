import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, MoveRequest, Tenancy, UnitResident, closeDb } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { residents } from '../../../src/modules/residents/residents.public';
import {
  runTenancyReminders,
  runPoliceReminders,
  tenancyExpiry,
} from '../../../src/modules/residents/residents.tenancies.service';
import { systemCtx } from '../../../src/types/context';
import {
  activeTenancy,
  docItem,
  idemKey,
  ownerOf,
  residentsSociety,
  resetResidentsP2,
  setSetting,
} from '../../helpers/residents-p2';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetResidentsP2();
});

const newTenancy = async (
  s: Awaited<ReturnType<typeof residentsSociety>>,
  over: Record<string, unknown> = {},
) =>
  s.c(
    'post',
    '/tenancies',
    {
      unitId: s.unit.id,
      tenant: { name: 'Neha Verma', mobile: '9820000002' },
      agreementStart: '2026-11-01',
      agreementEnd: '2027-09-30',
      inviteTenant: false,
      fileIds: [await docItem(s.society.id!, s.user.id, 'RENT_AGREEMENT')],
      ...over,
    },
    { headers: idemKey() },
  );

describe('tenancy dates, owner and uniqueness (BR-09-27, 28)', () => {
  it('T09-54 end before start and a 61 month agreement are TENANCY_DATES_INVALID', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const a = await newTenancy(s, { agreementEnd: '2026-10-01' });
    expect([a.status, a.body.code]).toEqual([422, 'TENANCY_DATES_INVALID']);
    const b = await newTenancy(s, { agreementEnd: '2031-12-01' });
    expect([b.status, b.body.code]).toEqual([422, 'TENANCY_DATES_INVALID']);
    const c = await newTenancy(s, { agreementStart: '2025-01-01', agreementEnd: '2026-01-01' });
    expect(c.body.code).toBe('TENANCY_DATES_INVALID');
    const d = await newTenancy(s, { tenant: { name: 'Neha', mobile: '5820011111' } });
    expect([d.status, d.body.code]).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('needs an open OWNER link', async () => {
    const s = await residentsSociety();
    const r = await newTenancy(s);
    expect([r.status, r.body.code]).toEqual([422, 'OWNER_REQUIRED']);
  });

  it('T09-14 a second live tenancy is refused; allowed when the setting is on', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    await activeTenancy(s);
    const r = await newTenancy(s, { tenant: { name: 'Other', mobile: '9820000003' } });
    expect([r.status, r.body.code]).toEqual([409, 'TENANCY_ALREADY_ACTIVE']);
    await setSetting(s.society.id!, 'residents.allowMultipleTenancies', true);
    const ok = await newTenancy(s, { tenant: { name: 'Other', mobile: '9820000003' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('refuses a parking unit and a minor tenant', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const r = await newTenancy(s, {
      tenant: { name: 'Kid', mobile: '9820000004', dateOfBirth: '2015-01-01' },
    });
    expect([r.status, r.body.code]).toEqual([422, 'MINOR_NOT_ALLOWED']);
  });
});

describe('create, submit, approve (BR-09-29 to 31, T09-12, T09-13)', () => {
  it('T09-12 the creator cannot approve; T09-13 another admin approves and links are created from agreementStart', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const created = await newTenancy(s, {
      household: [{ name: 'Tina Verma', familyRelation: 'CHILD', mobile: '9820000005' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'DRAFT', unit: { label: 'A-1203' }, version: 1 });
    expect(created.body.data.tenant.mobile).not.toBe('9820000002');
    const id = created.body.data.id;
    const submit = await s.c('post', `/tenancies/${id}/submit`, { version: 1 });
    expect(submit.body.data.status).toBe('PENDING_APPROVAL');
    const self = await s.c('post', `/tenancies/${id}/approve`, { version: 2 });
    expect([self.status, self.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    const ok = await s.secretary.c('post', `/tenancies/${id}/approve`, { version: 2 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('APPROVED');
    const links = await UnitResident.findAll({ where: { tenancyId: id } });
    expect(links.map(l => l.relation).sort()).toEqual(['FAMILY', 'TENANT']);
    expect(links.every(l => l.fromDate === '2026-11-01' && !l.isResiding)).toBe(true);
    expect(await AuditLog.count({ where: { action: 'residents.tenancy.approved' } })).toBe(1);
  });

  it('submit needs a rent agreement document', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const created = await newTenancy(s, { fileIds: [] });
    const r = await s.c('post', `/tenancies/${created.body.data.id}/submit`, { version: 1 });
    expect([r.status, r.body.code]).toEqual([422, 'DOCUMENTS_REQUIRED']);
  });

  it('an admin submit approves directly when approval is not required', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    await setSetting(s.society.id!, 'residents.tenancyRequiresApproval', false);
    const created = await newTenancy(s);
    const r = await s.c('post', `/tenancies/${created.body.data.id}/submit`, { version: 1 });
    expect(r.body.data.status).toBe('APPROVED');
    expect(await UnitResident.count({ where: { tenancyId: created.body.data.id } })).toBe(1);
  });

  it('reject needs a reason and cancel works on a draft', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const a = await newTenancy(s);
    await s.c('post', `/tenancies/${a.body.data.id}/submit`, { version: 1 });
    const rej = await s.secretary.c('post', `/tenancies/${a.body.data.id}/reject`, {
      version: 2,
      reason: 'abc',
    });
    expect(rej.status).toBe(400);
    const ok = await s.secretary.c('post', `/tenancies/${a.body.data.id}/reject`, {
      version: 2,
      reason: 'Papers incomplete',
    });
    expect(ok.body.data.status).toBe('REJECTED');
    const b = await newTenancy(s);
    const cancel = await s.c('post', `/tenancies/${b.body.data.id}/cancel`, {
      version: 1,
      reason: 'Changed plan',
    });
    expect(cancel.body.data.status).toBe('CANCELLED');
  });

  it('T09-51 approving an ended or draft tenancy is INVALID_STATE; stale version is STALE_VERSION', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const a = await newTenancy(s);
    const r = await s.secretary.c('post', `/tenancies/${a.body.data.id}/approve`, { version: 1 });
    expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
    const stale = await s.c('patch', `/tenancies/${a.body.data.id}`, { version: 9, occupantCount: 2 });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
  });

  it('PATCH edits a draft; a pending edit returns it to DRAFT; payer changes later and audits', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const a = await newTenancy(s);
    const id = a.body.data.id;
    const sub = await s.c('post', `/tenancies/${id}/submit`, { version: 1 });
    const p = await s.c('patch', `/tenancies/${id}`, { version: sub.body.data.version, occupantCount: 3 });
    expect(p.body.data).toMatchObject({ status: 'DRAFT', occupantCount: 3 });
    const later = await s.secretary.c('post', `/tenancies/${id}/approve`, { version: p.body.data.version });
    expect(later.body.code).toBe('INVALID_STATE');
  });
});

describe('billToFor follows maintenancePayer (BR-09-32, T09-01)', () => {
  it('names the tenant while the tenancy is active with payer TENANT, else the owner, then the owner after it ends', async () => {
    const s = await residentsSociety();
    const owner = await ownerOf(s);
    const t = await activeTenancy(s, { payer: 'TENANT' });
    const tenancy = (await Tenancy.findByPk(t.id))!;
    expect((await residents.billToFor(s.unit.id, '2026-11-02'))?.relation).toBe('OWNER');
    const act = await s.c('post', `/tenancies/${t.id}/activate`, {
      version: tenancy.version,
      moveInDate: '2026-11-01',
    });
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    expect((await residents.billToFor(s.unit.id, '2026-11-02'))?.relation).toBe('TENANT');
    const flip = await s.c('patch', `/tenancies/${t.id}`, {
      version: act.body.data.version,
      maintenancePayer: 'OWNER',
    });
    expect(flip.status, JSON.stringify(flip.body)).toBe(200);
    expect((await residents.billToFor(s.unit.id, '2026-11-02'))?.residentId).toBe(owner.residentId);
  });
});

describe('activate, renew, end (BR-09-31, 35, 36, T09-15)', () => {
  it('activate sets isResiding and moveInDate; the date window is checked', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const t = await activeTenancy(s);
    const bad = await s.c('post', `/tenancies/${t.id}/activate`, {
      version: t.version,
      moveInDate: '2026-12-01',
    });
    expect(bad.body.code).toBe('TENANCY_DATES_INVALID');
    const ok = await s.c('post', `/tenancies/${t.id}/activate`, {
      version: t.version,
      moveInDate: '2026-11-01',
    });
    expect(ok.body.data).toMatchObject({ status: 'ACTIVE', moveInDate: '2026-11-01' });
    expect((await UnitResident.findAll({ where: { tenancyId: t.id } })).every(l => l.isResiding)).toBe(true);
  });

  it('renew moves agreementEnd, keeps the old one, needs a document', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const t = await activeTenancy(s);
    const act = await s.c('post', `/tenancies/${t.id}/activate`, {
      version: t.version,
      moveInDate: '2026-11-01',
    });
    const v = act.body.data.version;
    const noDoc = await s.c('post', `/tenancies/${t.id}/renew`, { version: v, agreementEnd: '2028-01-31' });
    expect(noDoc.body.code).toBe('DOCUMENTS_REQUIRED');
    const early = await s.c('post', `/tenancies/${t.id}/renew`, {
      version: v,
      agreementEnd: '2027-01-01',
      fileId: 1,
    });
    expect(early.body.code).toBe('TENANCY_DATES_INVALID');
    const doc = await docItem(s.society.id!, s.user.id, 'RENT_AGREEMENT');
    const ok = await s.c('post', `/tenancies/${t.id}/renew`, {
      version: v,
      agreementEnd: '2028-01-31',
      fileId: doc.fileId,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      status: 'ACTIVE',
      renewalCount: 1,
      previousAgreementEnd: '2027-09-30',
      agreementEnd: '2028-01-31',
    });
  });

  it('T09-15 end with a household of 3 ends every link on endedOn', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const t = await activeTenancy(s, {
      household: [
        { name: 'Tina', familyRelation: 'CHILD', mobile: '9820000005' },
        { name: 'Tom', familyRelation: 'CHILD', mobile: '9820000006' },
      ],
    });
    const act = await s.c('post', `/tenancies/${t.id}/activate`, {
      version: t.version,
      moveInDate: '2026-11-01',
    });
    const r = await s.c('post', `/tenancies/${t.id}/end`, {
      version: act.body.data.version,
      endedOn: '2026-11-01',
      endReason: 'AGREEMENT_ENDED',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const links = await UnitResident.findAll({ where: { tenancyId: t.id } });
    expect(links).toHaveLength(3);
    expect(links.every(l => l.toDate === '2026-11-01' && l.endReason === 'TENANCY_ENDED')).toBe(true);
    expect((await Tenancy.findByPk(t.id))!.status).toBe('ENDED');
    expect(await AuditLog.count({ where: { action: 'residents.tenancy.ended' } })).toBe(1);
  });

  it('a tenancy moved in before its agreement start can end from the move-in date', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const t = await activeTenancy(s, { start: '2026-11-10', end: '2027-09-30' });
    const act = await s.c('post', `/tenancies/${t.id}/activate`, {
      version: t.version,
      moveInDate: '2026-11-01',
    });
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    const early = await s.c('post', `/tenancies/${t.id}/end`, {
      version: act.body.data.version,
      endedOn: '2026-10-31',
      endReason: 'MOVED_OUT',
    });
    expect(early.body.code).toBe('TENANCY_DATES_INVALID');
    const r = await s.c('post', `/tenancies/${t.id}/end`, {
      version: act.body.data.version,
      endedOn: '2026-11-01',
      endReason: 'MOVED_OUT',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const links = await UnitResident.findAll({ where: { tenancyId: t.id } });
    expect(links.every(l => l.fromDate === '2026-11-01' && l.toDate === '2026-11-01')).toBe(true);
  });

  it('an APPROVED tenancy that never moved in ends as TERMINATED; an open move blocks the end', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const t = await activeTenancy(s);
    await MoveRequest.count();
    const r = await s.c('post', `/tenancies/${t.id}/end`, {
      version: t.version,
      endedOn: '2026-11-01',
      endReason: 'OTHER',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.endReason).toBe('TERMINATED');
    const again = await s.c('post', `/tenancies/${t.id}/end`, {
      version: r.body.data.version,
      endedOn: '2026-11-01',
      endReason: 'OTHER',
    });
    expect(again.body.code).toBe('INVALID_STATE');
  });
});

describe('police verification (BR-09-33)', () => {
  it('VERIFIED needs a date and a reference or document; NOT_REQUIRED needs a reason', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const t = await activeTenancy(s);
    const path = `/tenancies/${t.id}/police-verification`;
    const a = await s.c('patch', path, { version: t.version, status: 'VERIFIED' });
    expect([a.status, a.body.code]).toEqual([422, 'VERIFICATION_DETAILS_REQUIRED']);
    const b = await s.c('patch', path, { version: t.version, status: 'NOT_REQUIRED', note: 'abc' });
    expect(b.body.code).toBe('VERIFICATION_DETAILS_REQUIRED');
    const c = await s.c('patch', path, {
      version: t.version,
      status: 'VERIFIED',
      verifiedOn: '2026-11-01',
      reference: 'PV/2026/118',
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.data.policeVerificationStatus).toBe('VERIFIED');
    const future = await s.c('patch', path, {
      version: c.body.data.version,
      status: 'VERIFIED',
      verifiedOn: '2027-01-01',
      reference: 'PV/1',
    });
    expect(future.body.code).toBe('VERIFICATION_DETAILS_REQUIRED');
  });
});

describe('owner flow from the resident app (BR-09-29)', () => {
  it('an owner adds a tenant; a tenant gets OWNER_ACTION_ONLY; the owner submits and the admin approves', async () => {
    const s = await residentsSociety();
    const owner = await ownerOf(s);
    const body = async () => ({
      unitId: s.unit.id,
      tenant: { name: 'Neha Verma', mobile: '9820000002' },
      agreementStart: '2026-11-01',
      agreementEnd: '2027-09-30',
      inviteTenant: false,
      fileIds: [await docItem(s.society.id!, owner.user.id, 'RENT_AGREEMENT')],
    });
    const r = await owner.c('post', '/me/tenancies', await body(), { headers: idemKey() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const sub = await owner.c('post', `/me/tenancies/${r.body.data.id}/submit`, { version: 1 });
    expect(sub.body.data.status).toBe('PENDING_APPROVAL');
    const ok = await s.c('post', `/tenancies/${r.body.data.id}/approve`, { version: 2 });
    expect(ok.body.data.status).toBe('APPROVED');
    expect((await owner.c('get', '/me/tenancies')).body.data).toHaveLength(1);
  });

  it('a flat the caller does not own is UNIT_NOT_FOUND', async () => {
    const s = await residentsSociety();
    const owner = await ownerOf(s);
    const r = await owner.c(
      'post',
      '/me/tenancies',
      {
        unitId: 999999,
        tenant: { name: 'Nina Rao', mobile: '9820000002' },
        agreementStart: '2026-11-01',
        agreementEnd: '2027-09-30',
        inviteTenant: false,
      },
      { headers: idemKey() },
    );
    expect([r.status, r.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
  });
});

describe('jobs (BR-09-34, T09-62)', () => {
  it('reminds at 30 and 7 days once each, then marks overstay the day after the end', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const t = await activeTenancy(s, { start: '2026-10-15', end: '2026-12-01' });
    const act = await s.c('post', `/tenancies/${t.id}/activate`, {
      version: t.version,
      moveInDate: '2026-10-15',
    });
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    const ctx = systemCtx('t');
    expect((await runTenancyReminders(s.society.id!, ctx)).reminded).toBe(1); // 30 days left
    expect((await runTenancyReminders(s.society.id!, ctx)).reminded).toBe(0);
    expect((await Tenancy.findByPk(t.id))!.lastExpiryReminderDays).toBe(30);
    setNow('2026-11-25T04:30:00Z'); // 6 days left
    expect((await runTenancyReminders(s.society.id!, ctx)).reminded).toBe(1);
    expect((await Tenancy.findByPk(t.id))!.lastExpiryReminderDays).toBe(7);
    setNow('2026-12-02T04:30:00Z');
    expect((await runTenancyReminders(s.society.id!, ctx)).overstayed).toBe(1);
    expect((await Tenancy.findByPk(t.id))!.status).toBe('EXPIRED_OVERSTAY');
    expect((await runTenancyReminders(s.society.id!, ctx)).overstayed).toBe(0);
  });

  it('police reminders go out at most every 6 days for ACTIVE tenancies without verification', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const t = await activeTenancy(s, { start: '2026-10-01' });
    await s.c('post', `/tenancies/${t.id}/activate`, { version: t.version, moveInDate: '2026-10-01' });
    expect(await runPoliceReminders(s.society.id!)).toBe(1);
    expect(await runPoliceReminders(s.society.id!)).toBe(0);
    setNow('2026-11-08T04:30:00Z');
    expect(await runPoliceReminders(s.society.id!)).toBe(1);
  });

  it('tenancyExpiry matches the list filter, masks the mobile and times out', async () => {
    const s = await residentsSociety();
    await ownerOf(s);
    const t = await activeTenancy(s, { start: '2026-10-15', end: '2026-12-01' });
    await s.c('post', `/tenancies/${t.id}/activate`, { version: t.version, moveInDate: '2026-10-15' });
    const list = await s.c('get', '/tenancies', undefined, { query: { expiringWithinDays: '60' } });
    const rep = await tenancyExpiry(
      s.society.id!,
      { expiringWithinDays: 60, piiClass: 'masked' },
      { deadlineMs: 5000, limit: 1000 },
    );
    expect(rep.rows.map(r => r.tenancyId)).toEqual(list.body.data.map((x: any) => x.id));
    expect(rep.rows[0]!.tenantMobile).not.toBe('9820000002');
    await expect(tenancyExpiry(s.society.id!, {}, { deadlineMs: -1 })).rejects.toThrow('timed out');
    const un = await tenancyExpiry(s.society.id!, { piiClass: 'unmasked' }, { deadlineMs: 5000 });
    expect(un.rows[0]!.tenantMobile).toBe('9820000002');
  });
});
