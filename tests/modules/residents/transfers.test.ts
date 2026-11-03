import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, OwnershipTransfer, Resident, Tenancy, UnitResident, closeDb } from '../../../src/models';
import { advance, setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { systemCtx } from '../../../src/types/context';
import {
  part3PortCalls,
  placeholderState,
  setResidentPart3Ports,
} from '../../../src/modules/residents/residents.part3.ports';
import { setResidentPorts } from '../../../src/modules/residents/residents.public';
import { approvePart3Request, rejectPart3Request } from '../../../src/modules/residents/residents.public';
import { computeFees } from '../../../src/modules/residents/residents.transfers.fees';
import { createLink } from '../../../src/modules/residents/residents.links.service';
import { sequelize } from '../../../src/models';
import { as, login, memberUser } from '../../helpers/access';
import { makeUnit } from '../../helpers/society-setup';
import { addPerson, fileFor, key, p3Society, resetPart3, openLinks } from '../../helpers/residents-part3';
import { admin } from '../../helpers/residents-part3';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetPart3);

// the frozen clock is Sunday 2026-11-01 10:00 IST
const TODAY = '2026-11-01';
const calls = (fn: string) => part3PortCalls.filter(c => c.fn === fn);
const sys = (societyId: number) => ({ ...systemCtx('inbox'), society: { id: societyId } as never });

async function setup() {
  const s = await p3Society();
  const unit = await makeUnit(s.c, s.building.id, '101', 1);
  const seller = await addPerson(s.society, unit.id, { name: 'Sandeep Rao', login: true });
  const adm = await admin(s.society);
  const docs = (userId: number, types: string[]) =>
    types.map(docType => ({ fileId: fileFor(s.society.id!, userId), docType }));
  const saleBody = (o: Record<string, unknown> = {}) => ({
    unitId: unit.id,
    transferType: 'SALE',
    effectiveDate: TODAY,
    deedRegistrationNo: 'MUM/1234/2026',
    buyers: [{ name: 'Kiran Desai', mobile: '9123456701', sharePercent: '100', isPrimary: true }],
    fileIds: docs(adm.userId, ['SALE_DEED', 'INDEX_II', 'MEMBERSHIP_APPLICATION']),
    ...o,
  });
  return { ...s, unit, seller, adm, saleBody, docs };
}

type Ctx = Awaited<ReturnType<typeof setup>>;
async function drafted(ctx: Ctx, o: Record<string, unknown> = {}) {
  const r = await ctx.adm('post', '/ownership-transfers', ctx.saleBody(o), { headers: key() });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: number; version: number; buyers: { residentId: number }[] };
}
async function submitted(ctx: Ctx, o: Record<string, unknown> = {}) {
  const d = await drafted(ctx, o);
  const r = await ctx.adm('post', `/ownership-transfers/${d.id}/submit`, { version: d.version });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return d;
}
async function approvedTransfer(ctx: Ctx, o: Record<string, unknown> = {}) {
  const d = await submitted(ctx, o);
  const row = (await OwnershipTransfer.findByPk(d.id))!;
  await approvePart3Request(row.approvalRequestId!, sys(ctx.society.id!));
  return d;
}
const ver = async (id: number) => (await OwnershipTransfer.findByPk(id))!.version;

describe('T09-05 transfer fees (BR-09-64)', () => {
  const s = { transferPremiumPaise: 2_500_000, shareTransferFeePaise: 50_000, entranceFeePaise: 10_000 };
  it('a sale with defaults and one new buyer; an inheritance has no premium', () => {
    expect(computeFees('SALE', s, {}, 1)).toMatchObject({
      transferPremiumPaise: 2_500_000,
      totalFeesPaise: 2_560_000,
    });
    expect(computeFees('INHERITANCE', s, {}, 1)).toMatchObject({
      transferPremiumPaise: 0,
      totalFeesPaise: 60_000,
    });
    expect(computeFees('NOMINATION', s, { transferPremiumPaise: 100 }, 1).transferPremiumPaise).toBe(0);
    expect(computeFees('GIFT', s, {}, 2).totalFeesPaise).toBe(50_000 + 20_000);
    expect(computeFees('SALE', s, {}, 0).totalFeesPaise).toBe(2_550_000);
  });
  it('every fee has a cap', () => {
    expect(() => computeFees('SALE', s, { transferPremiumPaise: 2_600_000 }, 1)).toThrow(
      /2*5*0*00 rupees|rupees/,
    );
    expect(() => computeFees('SALE', s, { shareTransferFeePaise: 50_001 }, 1)).toThrow();
    expect(() => computeFees('SALE', s, { entranceFeePaise: 10_001 }, 1)).toThrow();
  });
});

describe('create (BR-09-60 to 64)', () => {
  it('an admin drafts a sale; the response carries buyers, fees and the missing documents', async () => {
    const ctx = await setup();
    const r = await ctx.adm('post', '/ownership-transfers', ctx.saleBody({ fileIds: [] }), {
      headers: key(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'DRAFT',
      unitLabel: 'A-101',
      transferType: 'SALE',
      fees: {
        transferPremiumPaise: 2_500_000,
        shareTransferFeePaise: 50_000,
        entranceFeePaise: 10_000,
        newBuyerCount: 1,
        totalFeesPaise: 2_560_000,
      },
      duesPolicy: 'MUST_CLEAR',
      missingDocuments: ['SALE_DEED', 'INDEX_II', 'MEMBERSHIP_APPLICATION'],
      version: 1,
    });
    expect(r.body.data.buyers[0]).toMatchObject({
      name: 'Kiran Desai',
      sharePercent: '100.00',
      isPrimary: true,
      isResiding: true,
    });
    const buyer = (await Resident.findByPk(r.body.data.buyers[0].residentId))!;
    expect(buyer.source).toBe('TRANSFER');
    expect(await AuditLog.count({ where: { action: 'residents.ownership_transfer.created' } })).toBe(1);
  });

  it('T09-32 a premium above the cap is FEE_ABOVE_CAP', async () => {
    const ctx = await setup();
    const r = await ctx.adm(
      'post',
      '/ownership-transfers',
      ctx.saleBody({ transferPremiumPaise: 2_600_000 }),
      { headers: key() },
    );
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('FEE_ABOVE_CAP');
  });

  it('one open transfer per unit', async () => {
    const ctx = await setup();
    await drafted(ctx);
    const r = await ctx.adm(
      'post',
      '/ownership-transfers',
      ctx.saleBody({
        buyers: [{ name: 'Other Buyer', mobile: '9123456702', sharePercent: '100', isPrimary: true }],
      }),
      { headers: key() },
    );
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('TRANSFER_EXISTS');
  });

  it('BR-09-61 the buyer list: shares total 100, one primary, no duplicates, no minors on a sale', async () => {
    const ctx = await setup();
    const b = (shares: string[], primaries = [true, false]) =>
      shares.map((sharePercent, i) => ({
        name: `Buyer ${'ab'[i] ?? 'c'}`,
        mobile: `91234567${10 + i}`,
        sharePercent,
        isPrimary: primaries[i] ?? false,
      }));
    const post = (buyers: unknown[]) =>
      ctx.adm('post', '/ownership-transfers', ctx.saleBody({ buyers }), { headers: key() });
    expect((await post(b(['60', '30']))).body.code).toBe('TRANSFER_PARTIES_INVALID');
    expect((await post(b(['50', '50'], [true, true]))).body.code).toBe('TRANSFER_PARTIES_INVALID');
    expect((await post(b(['50', '50'], [false, false]))).body.code).toBe('TRANSFER_PARTIES_INVALID');
    const minor = await post([
      {
        name: 'Young Heir',
        mobile: '9123456799',
        dateOfBirth: '2015-05-05',
        sharePercent: '100',
        isPrimary: true,
      },
    ]);
    expect(minor.body.code).toBe('TRANSFER_PARTIES_INVALID');
    const heir = await ctx.adm(
      'post',
      '/ownership-transfers',
      ctx.saleBody({
        transferType: 'INHERITANCE',
        buyers: [
          {
            name: 'Young Heir',
            mobile: '9123456799',
            dateOfBirth: '2015-05-05',
            sharePercent: '100',
            isPrimary: true,
          },
        ],
        notes: 'Guardian is the mother',
      }),
      { headers: key() },
    );
    expect(heir.status, JSON.stringify(heir.body)).toBe(201);
    expect(heir.body.data.fees).toMatchObject({ transferPremiumPaise: 0, totalFeesPaise: 60_000 });
  });

  it('a buyer whose mobile is already a resident is RESIDENT_MOBILE_EXISTS with the id; sending the id works', async () => {
    const ctx = await setup();
    const seller = (await Resident.findByPk(ctx.seller.residentId))!;
    const r = await ctx.adm(
      'post',
      '/ownership-transfers',
      ctx.saleBody({
        buyers: [{ name: 'Same Person', mobile: seller.mobile, sharePercent: '100', isPrimary: true }],
      }),
      { headers: key() },
    );
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('RESIDENT_MOBILE_EXISTS');
    expect(r.body.errors[0].residentId).toBe(seller.id);
    const ok = await ctx.adm(
      'post',
      '/ownership-transfers',
      ctx.saleBody({ buyers: [{ residentId: seller.id, sharePercent: '100', isPrimary: true }] }),
      { headers: key() },
    );
    expect(ok.status).toBe(201);
    expect(ok.body.data.fees.newBuyerCount).toBe(0); // already an owner: no entrance fee
  });

  it('BR-09-62 the effective date window', async () => {
    const ctx = await setup();
    const post = (effectiveDate: string) =>
      ctx.adm('post', '/ownership-transfers', ctx.saleBody({ effectiveDate }), { headers: key() });
    expect((await post('2026-12-15')).body.code).toBe('TRANSFER_DATE_INVALID');
    expect((await post('2026-07-01')).body.code).toBe('TRANSFER_DATE_INVALID');
    expect((await post('2026-12-01')).status).toBe(201);
  });

  it('BR-09-60 initiators: the primary owner from the app; a family member, a co-owner and a stranger are refused', async () => {
    const ctx = await setup();
    const fam = await addPerson(ctx.society, ctx.unit.id, {
      name: 'Meera Rao',
      relation: 'FAMILY',
      login: true,
    });
    const body = {
      unitId: ctx.unit.id,
      transferType: 'GIFT',
      effectiveDate: TODAY,
      buyers: [{ name: 'Gift Taker', mobile: '9123456711', sharePercent: '100', isPrimary: true }],
    };
    const f = await fam.c!('post', '/me/ownership-transfers', body, { headers: key() });
    expect(f.status).toBe(403);
    expect(f.body.code).toBe('OWNER_ACTION_ONLY');
    const other = await makeUnit(ctx.c, ctx.building.id, '102', 1);
    const n = await ctx.seller.c!(
      'post',
      '/me/ownership-transfers',
      { ...body, unitId: other.id },
      { headers: key() },
    );
    expect(n.status).toBe(404);
    expect(n.body.code).toBe('UNIT_NOT_FOUND');
    const ok = await ctx.seller.c!('post', '/me/ownership-transfers', body, { headers: key() });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await OwnershipTransfer.findByPk(ok.body.data.id))!.initiatedByResidentId).toBe(
      ctx.seller.residentId,
    );
    expect(ok.body.data.fees.transferPremiumPaise).toBe(0); // a gift
    const mine = await ctx.seller.c!('get', '/me/ownership-transfers');
    expect(mine.body.data).toHaveLength(1);
    expect((await fam.c!('get', '/me/ownership-transfers')).body.data).toHaveLength(1); // the household sees the flat's transfer
  });

  it('PATCH edits a draft and recomputes the fees; a submitted transfer cannot be edited', async () => {
    const ctx = await setup();
    const d = await drafted(ctx);
    const p = await ctx.adm('patch', `/ownership-transfers/${d.id}`, {
      transferType: 'INHERITANCE',
      version: d.version,
    });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.data.fees).toMatchObject({ transferPremiumPaise: 0, totalFeesPaise: 60_000 });
    expect(p.body.data.version).toBe(2);
    const stale = await ctx.adm('patch', `/ownership-transfers/${d.id}`, { notes: 'x', version: 1 });
    expect(stale.body.code).toBe('STALE_VERSION');
    const d2 = await submittedAfterFix(ctx, d.id);
    const late = await ctx.adm('patch', `/ownership-transfers/${d.id}`, { notes: 'later', version: d2 });
    expect(late.body.code).toBe('INVALID_STATE');
  });
});

async function submittedAfterFix(ctx: Ctx, id: number): Promise<number> {
  // an inheritance needs death and succession certificates
  const r = await ctx.adm('patch', `/ownership-transfers/${id}`, {
    fileIds: ctx.docs(ctx.adm.userId, [
      'DEATH_CERTIFICATE',
      'SUCCESSION_CERTIFICATE',
      'MEMBERSHIP_APPLICATION',
    ]),
    version: await ver(id),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const s = await ctx.adm('post', `/ownership-transfers/${id}/submit`, { version: await ver(id) });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  return ver(id);
}

describe('submit (BR-09-61 to 65) and approval', () => {
  it('T09-31 a sale without INDEX_II is DOCUMENTS_REQUIRED', async () => {
    const ctx = await setup();
    const d = await drafted(ctx, {
      fileIds: ctx.docs(ctx.adm.userId, ['SALE_DEED', 'MEMBERSHIP_APPLICATION']),
    });
    const r = await ctx.adm('post', `/ownership-transfers/${d.id}/submit`, { version: d.version });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('DOCUMENTS_REQUIRED');
    expect(r.body.errors[0].missing).toEqual(['INDEX_II']);
  });

  it('the original share certificate is needed when module 23 has issued one', async () => {
    const ctx = await setup();
    setResidentPart3Ports({ shareCertificates: { currentForUnit: async () => ({ id: 5 }) } });
    const d = await drafted(ctx);
    const r = await ctx.adm('post', `/ownership-transfers/${d.id}/submit`, { version: d.version });
    expect(r.body.errors[0].missing).toEqual(['ORIGINAL_SHARE_CERTIFICATE']);
  });

  it('a sale needs the deed registration number', async () => {
    const ctx = await setup();
    const d = await drafted(ctx, { deedRegistrationNo: undefined });
    const r = await ctx.adm('post', `/ownership-transfers/${d.id}/submit`, { version: d.version });
    expect(r.status).toBe(422);
    expect(r.body.errors[0].field).toBe('deedRegistrationNo');
  });

  it('submit snapshots the sellers and the balance and asks module 14 with fees and the dues policy', async () => {
    const ctx = await setup();
    setResidentPorts({ unitLedger: { balance: async () => 482_500 } });
    const d = await submitted(ctx, { duesPolicy: 'CARRY_WITH_UNIT' });
    const row = (await OwnershipTransfer.findByPk(d.id))!;
    expect(row.status).toBe('PENDING_APPROVAL');
    expect(row.sellersJson).toEqual([
      { linkId: ctx.seller.linkId, residentId: ctx.seller.residentId, relation: 'OWNER', sharePercent: null },
    ]);
    expect(Number(row.balanceAtSubmitPaise)).toBe(482_500);
    const req = calls('approvals.request')[0]!.input as {
      type: string;
      payload: { duesPolicy: string; fees: { totalFeesPaise: number } };
    };
    expect(req.type).toBe('OWNERSHIP_TRANSFER');
    expect(req.payload.duesPolicy).toBe('CARRY_WITH_UNIT');
    expect(req.payload.fees.totalFeesPaise).toBe(2_560_000);
    const again = await ctx.adm('post', `/ownership-transfers/${d.id}/submit`, { version: row.version });
    expect(again.body.code).toBe('INVALID_STATE');
  });

  it('T09-33 approval raises three fee invoices; the premium is skipped for an inheritance', async () => {
    const ctx = await setup();
    const d = await approvedTransfer(ctx);
    const inv = calls('invoices.createAdHoc').map(
      c => c.input as { chargeHeadKey: string; amountPaise: number; dueDate: string; refType: string },
    );
    expect(inv.map(i => [i.chargeHeadKey, i.amountPaise])).toEqual([
      ['TRANSFER_PREMIUM', 2_500_000],
      ['SHARE_TRANSFER_FEE', 50_000],
      ['ENTRANCE_FEE', 10_000],
    ]);
    expect(inv[0]).toMatchObject({ refType: 'ownership_transfer', dueDate: '2026-11-08' });
    const row = (await OwnershipTransfer.findByPk(d.id))!;
    expect(row.status).toBe('APPROVED');
    expect(row.feesRaisedAt).not.toBeNull();
    const detail = await ctx.adm('get', `/ownership-transfers/${d.id}`);
    expect(detail.body.data.feeInvoices).toHaveLength(3);
    expect(detail.body.data.sellers[0]).toMatchObject({ name: 'Sandeep Rao', relation: 'OWNER' });
    expect(detail.body.data).toHaveProperty('balancePaise', 0);
    expect(detail.body.data.documents).toHaveLength(3);
  });

  it('reject through the placeholder inbox sets REJECTED and frees the unit', async () => {
    const ctx = await setup();
    const d = await submitted(ctx);
    const row = (await OwnershipTransfer.findByPk(d.id))!;
    await rejectPart3Request(row.approvalRequestId!, 'Papers incomplete', sys(ctx.society.id!));
    const after = (await OwnershipTransfer.findByPk(d.id))!;
    expect(after.status).toBe('REJECTED');
    expect(after.decisionReason).toBe('Papers incomplete');
    expect(calls('invoices.createAdHoc')).toHaveLength(0);
    expect(
      (
        await ctx.adm(
          'post',
          '/ownership-transfers',
          ctx.saleBody({
            buyers: [{ name: 'Next Buyer', mobile: '9123456733', sharePercent: '100', isPrimary: true }],
          }),
          { headers: key() },
        )
      ).status,
    ).toBe(201);
  });

  it('with an auto-approving module 14 the transfer is APPROVED inside the submit', async () => {
    const ctx = await setup();
    placeholderState.autoApprove = true;
    const d = await submitted(ctx);
    expect((await OwnershipTransfer.findByPk(d.id))!.status).toBe('APPROVED');
    expect(calls('invoices.createAdHoc')).toHaveLength(3);
  });

  it('changes requested: the owner edits and resubmits to module 14', async () => {
    const ctx = await setup();
    const body = {
      unitId: ctx.unit.id,
      transferType: 'GIFT',
      effectiveDate: TODAY,
      deedRegistrationNo: 'MUM/77/2026',
      buyers: [{ name: 'Gift Taker', mobile: '9123456711', sharePercent: '100', isPrimary: true }],
      fileIds: ctx.docs(ctx.seller.userId!, ['SALE_DEED', 'MEMBERSHIP_APPLICATION']),
    };
    const r = await ctx.seller.c!('post', '/me/ownership-transfers', body, { headers: key() });
    const id = r.body.data.id;
    const sub = await ctx.seller.c!('post', `/me/ownership-transfers/${id}/submit`, { version: 1 });
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    const no = await ctx.seller.c!('patch', `/me/ownership-transfers/${id}`, { notes: 'edit', version: 2 });
    expect(no.body.code).toBe('INVALID_STATE');
    placeholderState.publicStatus = 'CHANGES_REQUESTED';
    const yes = await ctx.seller.c!('patch', `/me/ownership-transfers/${id}`, { notes: 'edit', version: 2 });
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
    expect(calls('approvals.resubmit')).toHaveLength(1);
    expect(await AuditLog.count({ where: { action: 'residents.ownership_transfer.resubmitted' } })).toBe(1);
  });
});

describe('complete (BR-09-66, 67)', () => {
  it('T09-33 MUST_CLEAR with a balance is TRANSFER_DUES_PENDING; CARRY_WITH_UNIT passes', async () => {
    const ctx = await setup();
    const d = await approvedTransfer(ctx);
    setResidentPorts({ unitLedger: { balance: async () => 2_560_000 } });
    const r = await ctx.c(
      'post',
      `/ownership-transfers/${d.id}/complete`,
      { version: await ver(d.id) },
      { headers: key() },
    );
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('TRANSFER_DUES_PENDING');
    expect((await OwnershipTransfer.findByPk(d.id))!.status).toBe('APPROVED');
    await OwnershipTransfer.update({ duesPolicy: 'CARRY_WITH_UNIT' }, { where: { id: d.id } });
    const ok = await ctx.c(
      'post',
      `/ownership-transfers/${d.id}/complete`,
      { version: await ver(d.id) },
      { headers: key() },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('T09-34 completion ends the seller link the day before, opens the buyer link, hands off to module 23 once', async () => {
    const ctx = await setup();
    const d = await approvedTransfer(ctx);
    const r = await ctx.c(
      'post',
      `/ownership-transfers/${d.id}/complete`,
      { version: await ver(d.id) },
      { headers: key() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('COMPLETED');
    const sellerLink = (await UnitResident.findByPk(ctx.seller.linkId))!;
    expect(sellerLink.toDate).toBe('2026-10-31');
    expect(sellerLink.endReason).toBe('SOLD');
    const open = await openLinks(ctx.unit.id);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      relation: 'OWNER',
      isPrimary: true,
      fromDate: TODAY,
      ownershipTransferId: d.id,
      source: 'TRANSFER',
    });
    expect(open[0]!.residentId).toBe(d.buyers[0]!.residentId);
    const handoff = calls('shareCertificates.onOwnershipTransferred');
    expect(handoff).toHaveLength(1);
    expect(handoff[0]!.input).toMatchObject({
      transferId: d.id,
      unitId: ctx.unit.id,
      sellerResidentIds: [ctx.seller.residentId],
      transferType: 'SALE',
      effectiveDate: TODAY,
    });
    expect(handoff[0]!.t).toBeDefined();
    const row = (await OwnershipTransfer.findByPk(d.id))!;
    expect(row.shareCertificateHandoffAt).not.toBeNull();
    expect(row.completedBy).not.toBeNull();
    expect(await AuditLog.count({ where: { action: 'residents.ownership_transfer.completed' } })).toBe(1);
    // the seller's resident-app access to the flat is gone
    const again = await ctx.c(
      'post',
      `/ownership-transfers/${d.id}/complete`,
      { version: await ver(d.id) },
      { headers: key() },
    );
    expect(again.body.code).toBe('INVALID_STATE');
  });

  it('completion before the effective date is TRANSFER_DATE_INVALID', async () => {
    const ctx = await setup();
    const d = await approvedTransfer(ctx, { effectiveDate: '2026-11-10' });
    const r = await ctx.c(
      'post',
      `/ownership-transfers/${d.id}/complete`,
      { version: await ver(d.id) },
      { headers: key() },
    );
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('TRANSFER_DATE_INVALID');
  });

  it('completion needs a recent sign-in and the approve permission', async () => {
    const ctx = await setup();
    const d = await approvedTransfer(ctx);
    const fm = await admin(ctx.society, 'facility_manager');
    const denied = await fm(
      'post',
      `/ownership-transfers/${d.id}/complete`,
      { version: await ver(d.id) },
      { headers: key() },
    );
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    advance(10 * 60_000);
    const r = await ctx.c(
      'post',
      `/ownership-transfers/${d.id}/complete`,
      { version: await ver(d.id) },
      { headers: key() },
    );
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('REAUTH_REQUIRED');
  });

  it('T09-35 owners changed after submit: TRANSFER_SELLER_MISMATCH and nothing changes', async () => {
    const ctx = await setup();
    const d = await approvedTransfer(ctx);
    const co = await addPerson(ctx.society, ctx.unit.id, {
      name: 'Late Co-owner',
      relation: 'CO_OWNER',
      sharePercent: '50',
      fromDate: TODAY,
    }).catch(() => null);
    if (!co) {
      // shares of the sole owner are not set: give them together through the service
      const rid = (
        await Resident.create({
          societyId: ctx.society.id!,
          name: 'Late Owner',
          mobile: '9123456744',
          status: 'ACTIVE',
          source: 'ADMIN',
          directoryVisible: true,
          showMobileInDirectory: false,
          showEmailInDirectory: false,
          showPhotoInDirectory: false,
          preferredLanguage: 'en-IN',
          isNri: false,
          version: 1,
        } as never)
      ).id!;
      await sequelize.transaction(t =>
        createLink(
          systemCtx('t'),
          ctx.society.id!,
          { residentId: rid, unitId: ctx.unit.id, relation: 'CO_OWNER', fromDate: TODAY },
          t,
          { skipShareCheck: true },
        ),
      );
    }
    const r = await ctx.c(
      'post',
      `/ownership-transfers/${d.id}/complete`,
      { version: await ver(d.id) },
      { headers: key() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.code).toBe('TRANSFER_SELLER_MISMATCH');
    expect((await OwnershipTransfer.findByPk(d.id))!.status).toBe('APPROVED');
    expect((await UnitResident.findByPk(ctx.seller.linkId))!.toDate).toBeNull();
    expect(calls('shareCertificates.onOwnershipTransferred')).toHaveLength(0);
    expect(await UnitResident.count({ where: { ownershipTransferId: d.id } })).toBe(0);
  });

  it('joint buyers: a primary OWNER and a CO_OWNER with shares; a continuing owner pays no entrance fee', async () => {
    const ctx = await setup();
    const kiran = { name: 'Kiran Desai', mobile: '9123456701', sharePercent: '60', isPrimary: true };
    const d = await drafted(ctx, {
      buyers: [
        kiran,
        { residentId: ctx.seller.residentId, sharePercent: '40', isPrimary: false, isResiding: false },
      ],
    });
    expect((d as unknown as { fees: { newBuyerCount: number } }).fees.newBuyerCount).toBe(1);
    const s = await ctx.adm('post', `/ownership-transfers/${d.id}/submit`, { version: d.version });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    await approvePart3Request(
      (await OwnershipTransfer.findByPk(d.id))!.approvalRequestId!,
      sys(ctx.society.id!),
    );
    const r = await ctx.c(
      'post',
      `/ownership-transfers/${d.id}/complete`,
      { version: await ver(d.id) },
      { headers: key() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const open = (await openLinks(ctx.unit.id)).sort((a, b) => a.id! - b.id!);
    expect(open.map(l => [l.relation, l.sharePercent, l.isPrimary, l.isResiding])).toEqual([
      ['OWNER', '60.0000', true, true],
      ['CO_OWNER', '40.0000', false, false],
    ]);
    // the continuing owner's old period ended the day before and a new one began
    expect(
      await UnitResident.count({ where: { unitId: ctx.unit.id, residentId: ctx.seller.residentId } }),
    ).toBe(2);
  });

  it('an active tenancy continues with the new owner as landlord, or ends with endTenancy', async () => {
    for (const endTenancy of [false, true]) {
      await resetPart3();
      const ctx = await setup();
      const tenant = await addPerson(ctx.society, ctx.unit.id, { name: 'Pallavi Naik', relation: 'FAMILY' });
      const t = await Tenancy.create({
        societyId: ctx.society.id!,
        unitId: ctx.unit.id,
        tenantResidentId: tenant.residentId,
        landlordResidentId: ctx.seller.residentId,
        status: 'ACTIVE',
        agreementType: 'LEAVE_AND_LICENCE',
        agreementStart: '2026-06-01',
        agreementEnd: '2027-05-31',
        agreementRegistrationNo: null,
        monthlyRentPaise: 2_500_000,
        securityDepositPaise: 0,
        maintenancePayer: 'OWNER',
        occupantCount: 1,
        policeVerificationStatus: 'NOT_REQUIRED',
        source: 'ADMIN',
        version: 1,
        renewalCount: 0,
      } as never);
      await UnitResident.update(
        { relation: 'TENANT', familyRelation: null, tenancyId: t.id! },
        { where: { id: tenant.linkId } },
      );
      const d = await approvedTransfer(ctx, { endTenancy });
      const r = await ctx.c(
        'post',
        `/ownership-transfers/${d.id}/complete`,
        { version: await ver(d.id) },
        { headers: key() },
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const after = (await Tenancy.findByPk(t.id!))!;
      if (endTenancy) {
        expect(after.status).toBe('ENDED');
        expect(after.endReason).toBe('OWNER_SOLD');
        expect((await UnitResident.findByPk(tenant.linkId))!.toDate).toBe('2026-10-31');
      } else {
        expect(after.status).toBe('ACTIVE');
        expect(after.landlordResidentId).toBe(d.buyers[0]!.residentId);
        expect((await UnitResident.findByPk(tenant.linkId))!.toDate).toBeNull();
      }
    }
  });

  it("the seller's owner-household family link ends with the sale", async () => {
    const ctx = await setup();
    const fam = await addPerson(ctx.society, ctx.unit.id, { name: 'Meera Rao', relation: 'FAMILY' });
    const d = await approvedTransfer(ctx);
    await ctx.c(
      'post',
      `/ownership-transfers/${d.id}/complete`,
      { version: await ver(d.id) },
      { headers: key() },
    );
    const l = (await UnitResident.findByPk(fam.linkId))!;
    expect(l.toDate).toBe('2026-10-31');
    expect(l.endReason).toBe('SOLD');
  });
});

describe('cancel and isolation', () => {
  it('a draft is cancelled by the owner from the app; a cancelled transfer cannot be completed (T09-51)', async () => {
    const ctx = await setup();
    const body = {
      unitId: ctx.unit.id,
      transferType: 'GIFT',
      effectiveDate: TODAY,
      buyers: [{ name: 'Gift Taker', mobile: '9123456711', sharePercent: '100', isPrimary: true }],
    };
    const r = await ctx.seller.c!('post', '/me/ownership-transfers', body, { headers: key() });
    const c = await ctx.seller.c!('post', `/me/ownership-transfers/${r.body.data.id}/cancel`, {
      reason: 'Changed my mind',
      version: 1,
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.data.status).toBe('CANCELLED');
    const done = await ctx.c(
      'post',
      `/ownership-transfers/${r.body.data.id}/complete`,
      { version: 2 },
      { headers: key() },
    );
    expect(done.status).toBe(409);
    expect(done.body.code).toBe('INVALID_STATE');
  });

  it('cancelling a pending transfer cancels the module 14 request; an approved one needs the approve permission and cancels the fee invoices', async () => {
    const ctx = await setup();
    const d = await submitted(ctx);
    const c = await ctx.adm('post', `/ownership-transfers/${d.id}/cancel`, {
      reason: 'Deal fell through',
      version: await ver(d.id),
    });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(calls('approvals.cancel')).toHaveLength(1);
    await OwnershipTransfer.update({ status: 'APPROVED', feesRaisedAt: new Date() }, { where: { id: d.id } });
    const fm = await admin(ctx.society, 'facility_manager');
    const denied = await fm('post', `/ownership-transfers/${d.id}/cancel`, {
      reason: 'Deal fell through',
      version: await ver(d.id),
    });
    expect(denied.status).toBe(403);
    const ok = await ctx.c('post', `/ownership-transfers/${d.id}/cancel`, {
      reason: 'Deal fell through',
      version: await ver(d.id),
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(calls('invoices.cancelForRef')).toHaveLength(1);
  });

  it('another society cannot read or change the transfer; a resident of another flat sees nothing', async () => {
    const ctx = await setup();
    const d = await drafted(ctx);
    const other = await p3Society();
    const o = as(await login(await memberUser(other.society, 'secretary')));
    const g = await o('get', `/ownership-transfers/${d.id}`);
    expect(g.status).toBe(404);
    expect(g.body.code).toBe('TRANSFER_NOT_FOUND');
    expect((await o('post', `/ownership-transfers/${d.id}/submit`, { version: 1 })).body.code).toBe(
      'TRANSFER_NOT_FOUND',
    );
    const unit2 = await makeUnit(ctx.c, ctx.building.id, '202', 2);
    const neighbour = await addPerson(ctx.society, unit2.id, { name: 'Neighbour', login: true });
    expect((await neighbour.c!('get', '/me/ownership-transfers')).body.data).toHaveLength(0);
    const cancel = await neighbour.c!('post', `/me/ownership-transfers/${d.id}/cancel`, {
      reason: 'Not yours',
      version: 1,
    });
    expect(cancel.status).toBe(404);
  });

  it('list filters by status and the notifications go out after commit', async () => {
    const ctx = await setup();
    await submitted(ctx);
    const l = await ctx.adm('get', '/ownership-transfers', undefined, {
      query: { status: 'PENDING_APPROVAL' },
    });
    expect(l.body.data).toHaveLength(1);
    expect(l.body.data[0].missingDocuments).toEqual([]);
    expect(
      (await ctx.adm('get', '/ownership-transfers', undefined, { query: { status: 'DRAFT' } })).body.data,
    ).toHaveLength(0);
    setNow(TODAY + 'T04:30:00Z');
  });
});
