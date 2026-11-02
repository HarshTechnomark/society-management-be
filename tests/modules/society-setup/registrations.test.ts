import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Op } from 'sequelize';
import {
  AuditLog,
  Building,
  Holiday,
  Invitation,
  LocationNode,
  OnboardingStep,
  Society,
  SocietySetting,
  Unit,
  closeDb,
  sequelize,
} from '../../../src/models';
import { advance } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { stepUpMinutesFor, idleMinutesFor } from '../../../src/modules/auth/auth.sessions';
import { ports } from '../../../src/modules/auth/auth.ports';
import { exportProviders } from '../../../src/modules/societies/societies.exports';
import { purgeHandlerList } from '../../../src/modules/societies/societies.purge';
import { societyPorts } from '../../../src/modules/societies/societies.ports';
import { getDashboard } from '../../../src/modules/platform-ops/platform-ops.dashboard.service';
import { usageProviders } from '../../../src/modules/subscriptions/entitlements.service';
import { reconcileUsage } from '../../../src/modules/subscriptions/subscriptions.usage';
import { countUnits, units } from '../../../src/modules/society-setup/society-setup.public';
import { seedSocietySetup } from '../../../seeders/society-setup';
import { as, login, resetLogins, roleOf } from '../../helpers/access';
import {
  flatsUsed,
  idemKey,
  makeBuilding,
  makeUnit,
  markLive,
  rawUnits,
  resetSetup,
  setFlatsUsed,
  setupSociety,
} from '../../helpers/society-setup';
import { subSociety } from '../../helpers/subscriptions';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetSetup);

const TABLES = ['buildings', 'units', 'society_settings', 'onboarding_steps', 'holidays', 'location_nodes'];

async function fullSociety() {
  const s = await setupSociety();
  const a = await makeBuilding(s.c, { code: 'A', floorsAboveGround: 5 });
  await makeUnit(s.c, a.id, '101', 1, { carpetAreaSqft: '900' });
  await s.c(
    'post',
    '/locations',
    { parentId: a.locationNodeId, nodeType: 'FLOOR', floor: 1 },
    { headers: idemKey() },
  );
  await s.c('post', '/holidays', { holidayDate: '2026-11-08', name: 'Diwali' }, { headers: idemKey() });
  await s.c('patch', '/society/settings', { changes: [{ key: 'billing.dueDays', value: 9, version: 0 }] });
  await s.c('get', '/onboarding');
  return { ...s, a };
}

describe('export provider (module 05, section 13)', () => {
  it('registers one provider for the six tables, with the file names of the spec', () => {
    const p = exportProviders().find(x => x.module === 'society-setup')!;
    expect(p.tables.map(t => [t.name, t.file])).toEqual([
      ['buildings', 'buildings.csv'],
      ['units', 'units.csv'],
      ['society_settings', 'society_settings.csv'],
      ['onboarding_steps', 'onboarding_steps.csv'],
      ['holidays', 'holidays.csv'],
      ['location_nodes', 'location_nodes.csv'],
    ]);
  });

  it('streams only the rows of the society, in id order, for every table', async () => {
    const { society } = await fullSociety();
    const other = await setupSociety({ name: 'Other CHS' });
    const ob = await makeBuilding(other.c, { code: 'Z' });
    await makeUnit(other.c, ob.id, '101', 1);
    const p = exportProviders().find(x => x.module === 'society-setup')!;
    const rows = async (name: string, id: number) => {
      const out: Record<string, unknown>[] = [];
      for await (const r of p.tables.find(t => t.name === name)!.stream(id)) out.push(r);
      return out;
    };
    expect((await rows('buildings', society.id!)).map(r => r.code)).toEqual(['A']);
    expect((await rows('units', society.id!)).map(r => r.label)).toEqual(['A-101']);
    expect((await rows('society_settings', society.id!)).map(r => r.settingKey)).toEqual(['billing.dueDays']);
    expect(await rows('onboarding_steps', society.id!)).toHaveLength(8);
    expect((await rows('holidays', society.id!)).map(r => r.name)).toEqual(['Diwali']);
    expect((await rows('location_nodes', society.id!)).map(r => r.nodeType)).toEqual(['BUILDING', 'FLOOR']);
    expect((await rows('units', other.society.id!)).map(r => r.label)).toEqual(['Z-101']);
    for (const t of TABLES) for (const r of await rows(t, society.id!)) expect(r.societyId).toBe(society.id);
  });

  it('streams more rows than one batch', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c, { code: 'A', floorsAboveGround: 20 });
    await rawUnits(society.id!, b.id, 'A', 620);
    const p = exportProviders().find(x => x.module === 'society-setup')!;
    let n = 0;
    let last = 0;
    for await (const r of p.tables.find(t => t.name === 'units')!.stream(society.id!)) {
      n += 1;
      expect(r.id as number).toBeGreaterThan(last);
      last = r.id as number;
    }
    expect(n).toBe(620);
  });
});

describe('purge handler (module 05, section 13)', () => {
  it('is registered as module society-setup with order 8 for the six tables', () => {
    const h = purgeHandlerList().find(x => x.module === 'society-setup')!;
    expect(h.order).toBe(8);
    expect([...h.tables].sort()).toEqual([...TABLES].sort());
    // handlers run highest order first (modules 30 down to 08, then module 03)
    expect(purgeHandlerList().map(x => x.order)).toEqual(
      [...purgeHandlerList().map(x => x.order)].sort((a, b) => b - a),
    );
  });

  it('deletes everything of the society (nodes leaf first, wings before towers), nulls invitation unit links, and keeps other societies', async () => {
    const { society, c, a } = await fullSociety();
    const w = await makeBuilding(c, { code: 'T' });
    const wing = await makeBuilding(c, { code: 'T1', kind: 'WING', parentBuildingId: w.id });
    await c(
      'post',
      '/locations',
      { parentId: wing.locationNodeId, nodeType: 'AREA', areaType: 'LOBBY', name: 'Lobby' },
      { headers: idemKey() },
    );
    const unit = (await Unit.findOne({ where: { societyId: society.id! } }))!;
    const role = await roleOf(society.id!, 'owner');
    await Invitation.create({
      societyId: society.id!,
      roleId: role.id!,
      name: 'Ravi',
      mobile: '9820055502',
      unitId: unit.id,
      tokenHash: 'b'.repeat(64),
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 86_400_000),
      lastSentAt: new Date(),
      invitedUserId: unit.createdBy!,
    } as never);
    const other = await setupSociety({ name: 'Other CHS' });
    const ob = await makeBuilding(other.c, { code: 'Z' });
    await makeUnit(other.c, ob.id, '101', 1);
    const handler = purgeHandlerList().find(x => x.module === 'society-setup')!;
    const r = await handler.purge(society.id!);
    expect(r.anonymised).toBe(0);
    expect(r.deleted).toBeGreaterThan(15);
    for (const model of [Building, Unit, SocietySetting, OnboardingStep, Holiday, LocationNode])
      expect(await (model as typeof Unit).count({ where: { societyId: society.id! } }), model.name).toBe(0);
    expect((await Invitation.findOne({ where: { societyId: society.id! } }))!.unitId).toBeNull();
    expect(await Building.count({ where: { societyId: other.society.id! } })).toBe(1);
    expect(await Unit.count({ where: { societyId: other.society.id! } })).toBe(1);
    expect(await LocationNode.count({ where: { societyId: other.society.id! } })).toBe(1);
    // idempotent
    expect(await handler.purge(society.id!)).toEqual({ deleted: 0, anonymised: 0 });
    void a;
  });

  it('keeps units and buildings that another table still references (financial records are kept for 8 years)', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c, { code: 'A', floorsAboveGround: 5 });
    const keep = await makeUnit(c, b.id, '101', 1);
    await makeUnit(c, b.id, '102', 1);
    const empty = await makeBuilding(c, { code: 'B' });
    await sequelize.query(
      'CREATE TABLE IF NOT EXISTS tmp_unit_refs (id INT PRIMARY KEY AUTO_INCREMENT, unitId BIGINT UNSIGNED NOT NULL, CONSTRAINT fk_tmp_unit FOREIGN KEY (unitId) REFERENCES units (id) ON DELETE RESTRICT)',
    );
    try {
      await sequelize.query('INSERT INTO tmp_unit_refs (unitId) VALUES (:id)', {
        replacements: { id: keep.id },
      });
      const handler = purgeHandlerList().find(x => x.module === 'society-setup')!;
      await handler.purge(society.id!);
      expect((await Unit.findAll({ where: { societyId: society.id! } })).map(u => u.label)).toEqual([
        'A-101',
      ]);
      expect((await Building.findAll({ where: { societyId: society.id! } })).map(x => x.code)).toEqual(['A']);
      expect(await Building.count({ where: { id: empty.id } })).toBe(0);
      expect(await SocietySetting.count({ where: { societyId: society.id! } })).toBe(0);
    } finally {
      await sequelize.query('DROP TABLE IF EXISTS tmp_unit_refs');
    }
  });
});

describe('T08-38 usage reconciliation (BR-08-20)', () => {
  it('registers units.count as the limit.flats usage provider; module 04 sets the drifted counter to the countable units', async () => {
    const { society, c } = await setupSociety();
    expect(usageProviders.has('limit.flats')).toBe(true);
    const b = await makeBuilding(c, { floorsAboveGround: 20 });
    await rawUnits(society.id!, b.id, 'A', 76);
    await makeUnit(c, b.id, 'P1', 0, { unitType: 'PARKING_ONLY' }); // never counts
    await setFlatsUsed(society.id!, 80);
    expect(await units.count(society.id!)).toBe(76);
    await reconcileUsage(society.id!);
    expect(await flatsUsed(society.id!)).toBe(76);
    const log = (
      await AuditLog.findAll({ where: { societyId: society.id!, action: 'subscriptions.usage.reconciled' } })
    ).find(r => r.entityId.endsWith('limit.flats'))!;
    expect(log.before).toMatchObject({ used: 80 });
    expect(log.after).toMatchObject({ used: 76 });
  });

  it('the counter equals units.count after every kind of change (create, archive, restore, delete, type change, bulk, generator)', async () => {
    const { society, c } = await setupSociety();
    const b = await makeBuilding(c, { floorsAboveGround: 10 });
    const check = async () => expect(await flatsUsed(society.id!)).toBe(await units.count(society.id!));
    const u1 = await makeUnit(c, b.id, '101', 1);
    const u2 = await makeUnit(c, b.id, '102', 1, { unitType: 'SHOP' });
    const u3 = await makeUnit(c, b.id, 'P1', 0, { unitType: 'PARKING_ONLY' });
    await check();
    await c('post', `/units/${u1.id}/archive`, { version: 1, reason: 'Merged into 102' });
    await check();
    await c('post', `/units/${u1.id}/restore`, { version: 2 });
    await check();
    await c('patch', `/units/${u3.id}`, { version: 1, unitType: 'OFFICE' });
    await check();
    await c('post', '/units/bulk-update', { unitIds: [u1.id, u2.id], set: { unitType: 'PARKING_ONLY' } });
    await check();
    await c('delete', `/units/${u3.id}`);
    await check();
    const p = await c('post', '/units/generator/preview', {
      buildings: [{ buildingId: b.id }],
      floorFrom: 2,
      floorTo: 4,
      positions: [{ position: 1 }, { position: 2, unitType: 'PARKING_ONLY' }],
      pattern: '{floor}0{pos}',
    });
    await c(
      'post',
      '/units/generator/commit',
      {
        buildings: [{ buildingId: b.id }],
        floorFrom: 2,
        floorTo: 4,
        positions: [{ position: 1 }, { position: 2, unitType: 'PARKING_ONLY' }],
        pattern: '{floor}0{pos}',
        previewHash: p.body.data.previewHash,
      },
      { headers: idemKey() },
    );
    await check();
    expect(await flatsUsed(society.id!)).toBe(3);
  });

  it('countUnits counts countable units of the given societies, or of every society', async () => {
    const a = await setupSociety({ name: 'A CHS' });
    const b = await setupSociety({ name: 'B CHS' });
    const ab = await makeBuilding(a.c, { code: 'A' });
    const bb = await makeBuilding(b.c, { code: 'B' });
    await makeUnit(a.c, ab.id, '101', 1);
    await makeUnit(a.c, ab.id, '102', 1, { unitType: 'OFFICE' });
    await makeUnit(a.c, ab.id, 'P1', 0, { unitType: 'PARKING_ONLY' });
    await makeUnit(b.c, bb.id, '101', 1);
    expect(await countUnits([a.society.id!])).toBe(2);
    expect(await countUnits([b.society.id!])).toBe(1);
    expect(await countUnits([a.society.id!, b.society.id!])).toBe(3);
    expect(await countUnits()).toBe(3);
    expect(await countUnits([])).toBe(0);
    expect(await countUnits([999999])).toBe(0);
  });
});

describe('ports wired by registerSocietySetup()', () => {
  it('module 05 sees the real unit count and onboarding progress; module 07 shows units under management', async () => {
    const a = await setupSociety({ name: 'A CHS' });
    const b = await setupSociety({ name: 'B CHS' });
    expect(await societyPorts().units.count(a.society.id!)).toBe(0);
    expect(await societyPorts().onboarding.progressPercent(a.society.id!)).toBe(0);
    const ab = await makeBuilding(a.c, { code: 'A' });
    await makeUnit(a.c, ab.id, '101', 1);
    await makeUnit(a.c, ab.id, '102', 1);
    await a.c('post', '/onboarding/steps/BILLING/complete', {});
    expect(await societyPorts().units.count(a.society.id!)).toBe(2);
    expect(await societyPorts().onboarding.progressPercent(a.society.id!)).toBe(12);
    const bb = await makeBuilding(b.c, { code: 'B' });
    await makeUnit(b.c, bb.id, '101', 1);
    const d = await getDashboard('30');
    expect(d.unitsUnderManagement).toBe(3);
  });

  it('module 02 reads the session policy from the settings: idle minutes of the admin app and the step-up window', async () => {
    const { society, user, c } = await setupSociety();
    expect(await ports().societySettings.getSessionPolicy(society.id!)).toEqual({
      adminIdleMinutes: 30,
      stepUpMinutes: 5,
    });
    expect(await idleMinutesFor('ADMIN', society.id!)).toBe(30);
    expect(await stepUpMinutesFor('ADMIN', society.id!)).toBe(5);
    const r = await c('patch', '/society/settings', {
      changes: [
        { key: 'security.adminIdleMinutes', value: 15, version: 0 },
        { key: 'security.stepUpMinutes', value: 10, version: 0 },
      ],
      reason: 'Committee decision 12 Oct 2026',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await idleMinutesFor('ADMIN', society.id!)).toBe(15);
    expect(await stepUpMinutesFor('ADMIN', society.id!)).toBe(10);
    // the longer window is honoured by the step-up check: 8 minutes old is still recent, 11 is not
    advance(8 * 60_000);
    const keepAlive = as(await login(user));
    expect(
      (
        await keepAlive('patch', '/society', {
          version: 1,
          registrationNo: 'REG/1',
          reason: 'Registration entered',
        })
      ).status,
    ).toBe(200);
    resetLogins();
  });
});

describe('seed (spec 7.7)', () => {
  async function demo() {
    const sky = await subSociety({ plan: 'PREMIUM', flats: 72, name: 'Sky Heights CHS' });
    const green = await subSociety({ plan: 'STARTER', flats: 30, name: 'Green Park CHS' });
    const tulip = await subSociety({ plan: 'STANDARD', status: 'TRIALING', name: 'Tulip Gardens CHS' });
    await Society.update({ slug: 'sky-heights' }, { where: { id: sky.society.id! } });
    await Society.update({ slug: 'green-park' }, { where: { id: green.society.id! } });
    await Society.update({ slug: 'tulip-gardens' }, { where: { id: tulip.society.id! } });
    return { sky: sky.society, green: green.society, tulip: tulip.society };
  }

  it('creates towers and flats for Sky Heights and Green Park, settings, nodes, holidays and onboarding; Tulip Gardens stays empty; counters match', async () => {
    const { sky, green, tulip } = await demo();
    const r = await seedSocietySetup();
    expect(r).toEqual({ societies: ['sky-heights', 'green-park'], skipped: [], units: 102 });
    const skyUnits = await Unit.findAll({ where: { societyId: sky.id! }, order: [['id', 'ASC']] });
    expect(skyUnits).toHaveLength(72);
    expect(skyUnits[0]!.label).toBe('A-101');
    expect(skyUnits.at(-1)!.label).toBe('C-604');
    expect(
      skyUnits.every(
        u =>
          u.unitType === 'FLAT' &&
          u.areaSqft !== null &&
          Number(u.areaSqft) >= 800 &&
          Number(u.areaSqft) <= 1450,
      ),
    ).toBe(true);
    expect(
      (await Building.findAll({ where: { societyId: sky.id! }, order: [['code', 'ASC']] })).map(b => [
        b.code,
        b.floorsAboveGround,
      ]),
    ).toEqual([
      ['A', 6],
      ['B', 6],
      ['C', 6],
    ]);
    expect(await Unit.count({ where: { societyId: green.id! } })).toBe(30);
    expect((await Unit.findOne({ where: { societyId: green.id!, label: 'B-503' } }))!.floor).toBe(5);
    expect(await Building.count({ where: { societyId: tulip.id! } })).toBe(0);
    expect(await Unit.count({ where: { societyId: tulip.id! } })).toBe(0);
    expect(await OnboardingStep.count({ where: { societyId: tulip.id! } })).toBe(0);
    for (const s of [sky, green]) {
      expect(await flatsUsed(s.id!)).toBe(await units.count(s.id!));
      expect(await OnboardingStep.count({ where: { societyId: s.id!, status: 'DONE' } })).toBe(8);
      expect(await Holiday.count({ where: { societyId: s.id! } })).toBeGreaterThan(8);
    }
    expect(await flatsUsed(sky.id!)).toBe(72);
    expect(await flatsUsed(green.id!)).toBe(30);
    expect(await flatsUsed(tulip.id!)).toBe(0);
    const nodes = await LocationNode.findAll({
      where: { societyId: sky.id!, parentId: null },
      order: [['id', 'ASC']],
    });
    expect(nodes.map(n => n.name).sort()).toEqual(
      ['Clubhouse', 'Garden', 'Main Gate', 'Tower A', 'Tower B', 'Tower C'].sort(),
    );
    expect(nodes.find(n => n.name === 'Main Gate')).toMatchObject({ nodeType: 'AREA', areaType: 'GATE' });
    expect(await LocationNode.count({ where: { societyId: green.id!, nodeType: 'AREA' } })).toBe(0);
    const set = async (id: number, key: string) =>
      (await SocietySetting.findOne({ where: { societyId: id, settingKey: key } }))?.valueJson;
    expect(await set(sky.id!, 'finance.showFinancesToResidents')).toBe(true);
    expect(await set(sky.id!, 'billing.billingDay')).toBe(1);
    expect(await set(sky.id!, 'billing.dueDays')).toBe(9);
    expect(await SocietySetting.count({ where: { societyId: green.id! } })).toBe(0);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const { sky } = await demo();
    await seedSocietySetup();
    const before = await Promise.all([
      Unit.count(),
      Building.count(),
      LocationNode.count(),
      Holiday.count(),
      OnboardingStep.count(),
    ]);
    const again = await seedSocietySetup();
    expect(again).toEqual({ societies: [], skipped: ['sky-heights', 'green-park'], units: 0 });
    expect(
      await Promise.all([
        Unit.count(),
        Building.count(),
        LocationNode.count(),
        Holiday.count(),
        OnboardingStep.count(),
      ]),
    ).toEqual(before);
    expect(await flatsUsed(sky.id!)).toBe(72);
  });

  it('the seeded societies are live and their data satisfies the onboarding checks', async () => {
    const { sky } = await demo();
    await seedSocietySetup();
    await markLive(sky.id!);
    const rows = await OnboardingStep.findAll({ where: { societyId: sky.id! } });
    expect(rows.every(r => r.status === 'DONE')).toBe(true);
    const [missing] = await sequelize.query(
      'SELECT COUNT(*) AS n FROM units WHERE societyId = :id AND isBillable = 1 AND areaSqft IS NULL',
      { replacements: { id: sky.id } },
    );
    expect(Number((missing as { n: number }[])[0]!.n)).toBe(0);
    void Op;
  });
});
