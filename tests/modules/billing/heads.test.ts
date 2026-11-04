import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, ChargeHead, closeDb } from '../../../src/models';
import { chargeHeads } from '../../../src/modules/billing/billing.public';
import { SEED_HEADS } from '../../../src/modules/billing/billing.heads.seed';
import { setBillingPorts } from '../../../src/modules/billing/billing.ports';
import { adminOf } from '../../helpers/residents';
import { featureOff } from '../../helpers/society-setup';
import {
  billingWorld,
  headId,
  idem,
  postRule,
  resetBillingSetup,
  ruleBody,
} from '../../helpers/billing-setup';

afterAll(closeDb);
beforeEach(resetBillingSetup);

const newHead = (over: Record<string, unknown> = {}) => ({
  key: 'LIFT_FUND',
  name: 'Lift fund',
  headType: 'OTHER',
  ledgerAccountCode: '4100',
  ...over,
});

describe('charge heads: seed (7.13, US-11-01)', () => {
  it('ensureSeeded creates the 30 heads once, by key, and never touches existing rows', async () => {
    const w = await billingWorld();
    expect(await chargeHeads.ensureSeeded(w.society.id!)).toEqual({ created: SEED_HEADS.length });
    expect(SEED_HEADS.length).toBe(30);
    await ChargeHead.update({ name: 'Renamed' }, { where: { societyId: w.society.id!, key: 'WATER' } });
    expect(await chargeHeads.ensureSeeded(w.society.id!)).toEqual({ created: 0 });
    expect(await ChargeHead.count({ where: { societyId: w.society.id! } })).toBe(30);
    expect((await ChargeHead.findOne({ where: { societyId: w.society.id!, key: 'WATER' } }))!.name).toBe(
      'Renamed',
    );
  });

  it('the first read seeds the society; the rows match section 7.13', async () => {
    const w = await billingWorld();
    const r = await w.c('get', '/billing/charge-heads');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toHaveLength(30);
    expect(r.body.pagination).toMatchObject({ page: 1, limit: 100, total: 30 });
    const by = Object.fromEntries(r.body.data.map((h: any) => [h.key, h]));
    expect(by.MAINTENANCE).toMatchObject({
      name: 'Maintenance (service charges)',
      headType: 'MAINTENANCE',
      payerRouting: 'BILL_TO',
      gstTreatment: 'THRESHOLD',
      sacCode: null,
      prorate: true,
      interestBearing: true,
      ledgerAccountCode: '4100',
      isSystem: false,
      status: 'ACTIVE',
      version: 1,
    });
    expect(by.SINKING_FUND).toMatchObject({ payerRouting: 'OWNER', ledgerAccountCode: '2410' });
    expect(by.COLLECTION.ledgerAccountCode).toBe('COLLECTION_FUND');
    expect(by.INTEREST).toMatchObject({ isSystem: true, gstTreatment: 'FOLLOW_SOURCE' });
    expect(by.OPENING_ARREARS).toMatchObject({ isSystem: true, ledgerAccountCode: '3900' });
    // names are user-facing: no notes about other modules
    expect(by.DEPOSIT_ACCESS_CARD.name).toBe('Access card deposit');
    expect(by.EV_CHARGING.name).toBe('EV charging');
    expect(r.body.data.filter((h: any) => /module/i.test(h.name))).toEqual([]);
    expect(Object.keys(by.MAINTENANCE).sort()).toEqual(
      [
        'id',
        'societyId',
        'key',
        'name',
        'description',
        'headType',
        'payerRouting',
        'gstTreatment',
        'sacCode',
        'prorate',
        'interestBearing',
        'ledgerAccountCode',
        'fundId',
        'isSystem',
        'status',
        'sortOrder',
        'createdBy',
        'updatedBy',
        'version',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(r.body.data[0].key).toBe('MAINTENANCE'); // sortOrder ascending
  });

  it('list filters: status, headType, q', async () => {
    const w = await billingWorld();
    const dep = await w.c('get', '/billing/charge-heads', undefined, { query: { headType: 'DEPOSIT' } });
    expect(dep.body.data.map((h: any) => h.key)).toHaveLength(6);
    const q = await w.c('get', '/billing/charge-heads', undefined, { query: { q: 'sinking' } });
    expect(q.body.data.map((h: any) => h.key)).toEqual(['SINKING_FUND']);
    const arch = await w.c('get', '/billing/charge-heads', undefined, { query: { status: 'ARCHIVED' } });
    expect(arch.body.data).toEqual([]);
    const sorted = await w.c('get', '/billing/charge-heads', undefined, {
      query: { sortBy: 'key', sortOrder: 'desc', limit: '2' },
    });
    expect(sorted.body.data.map((h: any) => h.key)).toEqual(['WATER', 'TRANSFER_PREMIUM']);
    expect((await w.c('get', '/billing/charge-heads', undefined, { query: { limit: '101' } })).status).toBe(
      400,
    );
  });
});

describe('charge heads: create and edit (8.1)', () => {
  it('T11-14 creates LIFT_FUND; a second head with the same key is 409 CHARGE_HEAD_KEY_TAKEN', async () => {
    const w = await billingWorld();
    const r = await w.c('post', '/billing/charge-heads', newHead(), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      key: 'LIFT_FUND',
      headType: 'OTHER',
      payerRouting: 'BILL_TO',
      gstTreatment: 'NONE',
      prorate: true,
      interestBearing: true,
      isSystem: false,
      status: 'ACTIVE',
      sortOrder: 100,
      version: 1,
    });
    const again = await w.c('post', '/billing/charge-heads', newHead({ name: 'Other' }), { headers: idem() });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('CHARGE_HEAD_KEY_TAKEN');
    const seeded = await w.c('post', '/billing/charge-heads', newHead({ key: 'MAINTENANCE' }), {
      headers: idem(),
    });
    expect(seeded.body.code).toBe('CHARGE_HEAD_KEY_TAKEN');
    const audit = await AuditLog.findAll({
      where: { societyId: w.society.id!, action: 'billing.charge_head.created' },
    });
    expect(audit).toHaveLength(1);
  });

  it('the same Idempotency-Key replays the response and creates one head', async () => {
    const w = await billingWorld();
    const h = idem();
    const a = await w.c('post', '/billing/charge-heads', newHead(), { headers: h });
    const b = await w.c('post', '/billing/charge-heads', newHead(), { headers: h });
    expect(b.status).toBe(201);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await ChargeHead.count({ where: { societyId: w.society.id!, key: 'LIFT_FUND' } })).toBe(1);
  });

  it('BR-11-8 and the field rules: key format, system keys, system types, unknown fields are 400', async () => {
    const w = await billingWorld();
    const bad = async (over: Record<string, unknown>) =>
      (await w.c('post', '/billing/charge-heads', newHead(over), { headers: idem() })).body.code;
    expect(await bad({ key: 'lift fund' })).toBe('VALIDATION_FAILED');
    expect(await bad({ key: 'A' })).toBe('VALIDATION_FAILED');
    expect(await bad({ key: 'INTEREST' })).toBe('VALIDATION_FAILED');
    expect(await bad({ headType: 'INTEREST' })).toBe('VALIDATION_FAILED');
    expect(await bad({ name: 'x' })).toBe('VALIDATION_FAILED');
    expect(await bad({ ledgerAccountCode: '41' })).toBe('VALIDATION_FAILED');
    expect(await bad({ sortOrder: 1000 })).toBe('VALIDATION_FAILED');
    expect(await bad({ gstTreatment: 'FOLLOW_SOURCE' })).toBe('VALIDATION_FAILED');
    expect(await bad({ isSystem: true })).toBe('VALIDATION_FAILED');
  });

  it('BR-11-9: sinking fund, repair fund and non-occupancy heads must be OWNER', async () => {
    const w = await billingWorld();
    for (const headType of ['SINKING_FUND', 'REPAIR_FUND', 'NON_OCCUPANCY']) {
      const r = await w.c('post', '/billing/charge-heads', newHead({ key: `X_${headType}`, headType }), {
        headers: idem(),
      });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('CHARGE_HEAD_ROUTING_INVALID');
    }
    const ok = await w.c(
      'post',
      '/billing/charge-heads',
      newHead({ key: 'EXTRA_FUND', headType: 'SINKING_FUND', payerRouting: 'OWNER' }),
      { headers: idem() },
    );
    expect(ok.status).toBe(201);
    const head = ok.body.data;
    const patch = await w.c('patch', `/billing/charge-heads/${head.id}`, {
      payerRouting: 'BILL_TO',
      version: head.version,
    });
    expect(patch.body.code).toBe('CHARGE_HEAD_ROUTING_INVALID');
  });

  it('BR-11-10 and BR-11-31: SAC is required when taxed; THRESHOLD is refused on fee heads; deposits stay untaxed', async () => {
    const w = await billingWorld();
    const noSac = await w.c('post', '/billing/charge-heads', newHead({ gstTreatment: 'THRESHOLD' }), {
      headers: idem(),
    });
    expect(noSac.status).toBe(400);
    expect(noSac.body.errors[0].field).toBe('sacCode');
    const withSac = await w.c(
      'post',
      '/billing/charge-heads',
      newHead({ gstTreatment: 'ALWAYS', sacCode: '999593' }),
      { headers: idem() },
    );
    expect(withSac.status).toBe(201);
    expect(withSac.body.data.sacCode).toBe('999593');
    const fee = await w.c(
      'post',
      '/billing/charge-heads',
      newHead({ key: 'JOIN_FEE', headType: 'MEMBERSHIP', gstTreatment: 'THRESHOLD', sacCode: '999593' }),
      { headers: idem() },
    );
    expect(fee.status).toBe(422);
    expect(fee.body.code).toBe('RATE_TYPE_NOT_ALLOWED');
    const dep = await w.c(
      'post',
      '/billing/charge-heads',
      newHead({ key: 'DEP_X', headType: 'DEPOSIT', gstTreatment: 'ALWAYS', sacCode: '999593' }),
      { headers: idem() },
    );
    expect(dep.body.code).toBe('RATE_TYPE_NOT_ALLOWED');
    // a seeded head without a SAC can still be renamed, and taxed only with a SAC
    const m = (await w.c('get', '/billing/charge-heads', undefined, { query: { q: 'MAINTENANCE' } })).body
      .data[0];
    expect(
      (await w.c('patch', `/billing/charge-heads/${m.id}`, { name: 'Monthly maintenance', version: 1 }))
        .status,
    ).toBe(200);
    const sac = await w.c('patch', `/billing/charge-heads/${m.id}`, { sacCode: '998599', version: 2 });
    expect(sac.status).toBe(200);
    const clear = await w.c('patch', `/billing/charge-heads/${m.id}`, { sacCode: null, version: 3 });
    expect(clear.status).toBe(400);
  });

  it('BR-11-12: the ledger account must exist in the chart (module 13 port)', async () => {
    const w = await billingWorld();
    setBillingPorts({ journal: { accountExists: async (_s, code) => code === '4100' } });
    const r = await w.c('post', '/billing/charge-heads', newHead({ ledgerAccountCode: '4999' }), {
      headers: idem(),
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('LEDGER_ACCOUNT_NOT_FOUND');
    const ok = await w.c('post', '/billing/charge-heads', newHead(), { headers: idem() });
    expect(ok.status).toBe(201);
    const patch = await w.c('patch', `/billing/charge-heads/${ok.body.data.id}`, {
      ledgerAccountCode: '4888',
      version: 1,
    });
    expect(patch.body.code).toBe('LEDGER_ACCOUNT_NOT_FOUND');
  });

  it('PATCH: key and headType are unknown keys; STALE_VERSION; version increments; audit keeps before and after', async () => {
    const w = await billingWorld();
    const head = (await w.c('post', '/billing/charge-heads', newHead(), { headers: idem() })).body.data;
    const u = `/billing/charge-heads/${head.id}`;
    expect((await w.c('patch', u, { key: 'OTHER_KEY', version: 1 })).status).toBe(400);
    expect((await w.c('patch', u, { headType: 'FINE', version: 1 })).status).toBe(400);
    expect((await w.c('patch', u, { version: 1 })).status).toBe(400);
    const ok = await w.c('patch', u, {
      name: 'Lift sinking fund',
      prorate: false,
      sortOrder: 5,
      fundId: 7,
      version: 1,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      name: 'Lift sinking fund',
      prorate: false,
      sortOrder: 5,
      fundId: 7,
      version: 2,
    });
    const stale = await w.c('patch', u, { name: 'Again', version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
    expect((await w.c('patch', '/billing/charge-heads/999999', { name: 'No', version: 1 })).body.code).toBe(
      'CHARGE_HEAD_NOT_FOUND',
    );
    const a = await AuditLog.findOne({
      where: { societyId: w.society.id!, action: 'billing.charge_head.updated' },
    });
    expect((a!.before as any).name).toBe('Lift fund');
    expect((a!.after as any).name).toBe('Lift sinking fund');
  });

  it('BR-11-11: only name, description, sortOrder and sacCode of a system head change', async () => {
    const w = await billingWorld();
    const id = await headId(w.c, 'INTEREST');
    const u = `/billing/charge-heads/${id}`;
    for (const body of [
      { payerRouting: 'OWNER', version: 1 },
      { interestBearing: true, version: 1 },
      { ledgerAccountCode: '4141', version: 1 },
      { prorate: true, version: 1 },
    ]) {
      const r = await w.c('patch', u, body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.body.code).toBe('CHARGE_HEAD_SYSTEM');
    }
    const ok = await w.c('patch', u, {
      name: 'Interest on dues',
      description: 'Simple interest',
      sortOrder: 990,
      sacCode: '997119',
      version: 1,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const arch = await w.c('delete', u, { reason: 'No longer needed', version: 2 });
    expect(arch.status).toBe(422);
    expect(arch.body.code).toBe('CHARGE_HEAD_SYSTEM');
  });
});

describe('charge heads: archive (BR-11-13, US-11-01)', () => {
  it('a head with a live approved rule is CHARGE_HEAD_IN_USE; after a NONE version it can be archived and is then unusable', async () => {
    const w = await billingWorld();
    const id = await headId(w.c, 'PARKING');
    const rule = await postRule(
      w.c,
      ruleBody(id, {
        name: 'Parking – all flats',
        firstVersion: {
          rateType: 'FLAT_PER_UNIT',
          amountPaise: 50_000,
          effectiveFrom: '2026-04-01',
          reason: 'AGM rate',
        },
      }),
    );
    const u = `/billing/charge-heads/${id}`;
    const busy = await w.c('delete', u, { reason: 'Not needed any more', version: 1 });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('CHARGE_HEAD_IN_USE');
    const stop = await w.c(
      'post',
      `/billing/rules/${rule.id}/versions`,
      { rateType: 'NONE', effectiveFrom: '2026-11-01', reason: 'Stop parking charges' },
      { headers: idem() },
    );
    expect(stop.status, JSON.stringify(stop.body)).toBe(201);
    const ok = await w.c('delete', u, { reason: 'Not needed any more', version: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'ARCHIVED', version: 2 });
    expect((await w.c('delete', u, { reason: 'Not needed any more', version: 2 })).body.code).toBe(
      'INVALID_STATE',
    );
    const again = await w.c('post', '/billing/rules', ruleBody(id, { name: 'Parking again' }), {
      headers: idem(),
    });
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('CHARGE_HEAD_ARCHIVED');
    const arch = await w.c('get', '/billing/charge-heads', undefined, { query: { status: 'ARCHIVED' } });
    expect(arch.body.data.map((h: any) => h.key)).toEqual(['PARKING']);
    const a = await AuditLog.findOne({
      where: { societyId: w.society.id!, action: 'billing.charge_head.archived' },
    });
    expect(a!.reason).toBe('Not needed any more');
  });

  it('an unused head archives; the body needs reason and version', async () => {
    const w = await billingWorld();
    const id = await headId(w.c, 'FINE');
    expect((await w.c('delete', `/billing/charge-heads/${id}`, { version: 1 })).status).toBe(400);
    expect((await w.c('delete', `/billing/charge-heads/${id}`, { reason: 'ok', version: 1 })).status).toBe(
      400,
    );
    expect(
      (await w.c('delete', `/billing/charge-heads/${id}`, { reason: 'Never used', version: 5 })).body.code,
    ).toBe('STALE_VERSION');
    expect(
      (await w.c('delete', `/billing/charge-heads/${id}`, { reason: 'Never used', version: 1 })).status,
    ).toBe(200);
  });
});

describe('charge heads: access (section 2, 13)', () => {
  it('view-only roles read but cannot write; a plan without the feature is 402 for writes', async () => {
    const w = await billingWorld();
    const sec = await adminOf(w.society, 'secretary');
    expect((await sec.c('get', '/billing/charge-heads')).status).toBe(200);
    const denied = await sec.c('post', '/billing/charge-heads', newHead(), { headers: idem() });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
    await featureOff(w.society.id!, 'billing.charge_head_master');
    const r = await w.c('post', '/billing/charge-heads', newHead(), { headers: idem() });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('FEATURE_NOT_IN_PLAN');
  });

  it('one society cannot see or change the heads of another', async () => {
    const a = await billingWorld();
    const b = await billingWorld({ name: 'Green Park CHS' });
    const idA = await headId(a.c, 'WATER');
    for (const r of [
      await b.c('patch', `/billing/charge-heads/${idA}`, { name: 'Hack', version: 1 }),
      await b.c('delete', `/billing/charge-heads/${idA}`, { reason: 'Hacking', version: 1 }),
    ]) {
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('CHARGE_HEAD_NOT_FOUND');
    }
    const list = await b.c('get', '/billing/charge-heads');
    expect(list.body.data.every((h: any) => h.societyId === b.society.id)).toBe(true);
  });
});
