import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { NumberSequence, closeDb, sequelize } from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { financialYearOf, nextNumber } from '../../../src/utils/numberSequences';
import { resetAll } from '../../helpers/auth';

/** Module 01 BR-01-11/12 and T01-09/T01-10 as used by module 06 (PLT and PCN through `nextNumber(0, …)`). */
const take = (
  series: 'PLATFORM_INVOICE' | 'PLATFORM_CREDIT_NOTE' = 'PLATFORM_INVOICE',
  date = '2026-11-01',
) => sequelize.transaction(t => nextNumber(0, series, { date, transaction: t }));

beforeEach(async () => {
  await resetAll();
});
afterAll(async () => {
  setNow(null);
  await closeDb();
});

describe('financial year (BR-01-12)', () => {
  it('starts on 1 April', () => {
    expect(financialYearOf('2027-03-15')).toBe('2026-27');
    expect(financialYearOf('2027-04-01')).toBe('2027-28');
    expect(financialYearOf('2099-12-31')).toBe('2099-00');
  });
  it('reads a moment as its Asia/Kolkata date', () => {
    // 31 March 2027 19:00 UTC is 1 April 00:30 IST
    expect(financialYearOf(new Date('2027-03-31T19:00:00Z'))).toBe('2027-28');
    expect(financialYearOf(new Date('2027-03-31T18:00:00Z'))).toBe('2026-27');
  });
  it('defaults to today from the clock helper', () => {
    setNow('2026-05-10T06:00:00Z');
    expect(financialYearOf()).toBe('2026-27');
    setNow(null);
  });
});

describe('nextNumber (BR-01-11, BR-06-17)', () => {
  it('formats PLT and PCN numbers with six digits per financial year', async () => {
    expect(await take()).toBe('PLT/2026-27/000001');
    expect(await take()).toBe('PLT/2026-27/000002');
    expect(await take('PLATFORM_CREDIT_NOTE')).toBe('PCN/2026-27/000001');
    expect(await take('PLATFORM_INVOICE', '2027-04-01')).toBe('PLT/2027-28/000001');
    expect(await take('PLATFORM_INVOICE', '2027-03-31')).toBe('PLT/2026-27/000003');
    expect(await take()).toMatch(/^PLT\/\d{4}-\d{2}\/\d{6}$/);
  });

  it('keeps each society and the platform (societyId 0) apart; prefix applies only to a new row', async () => {
    const a = await sequelize.transaction(t =>
      nextNumber(5, 'INVOICE', { date: '2026-11-01', prefix: 'SKY', transaction: t }),
    );
    const b = await sequelize.transaction(t =>
      nextNumber(5, 'INVOICE', { date: '2026-11-01', prefix: 'NEW', transaction: t }),
    );
    expect([a, b]).toEqual(['SKY/2026-27/000001', 'SKY/2026-27/000002']);
    expect(await take()).toBe('PLT/2026-27/000001');
    expect(await NumberSequence.count()).toBe(2);
  });

  it('T01-09: 50 parallel committed calls give 1 to 50 exactly once', async () => {
    const numbers = await Promise.all(Array.from({ length: 50 }, () => take()));
    const values = numbers.map(n => Number(n.split('/')[2])).sort((x, y) => x - y);
    expect(values).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const row = await NumberSequence.findOne({ where: { societyId: 0, series: 'PLATFORM_INVOICE' } });
    expect(row!.nextValue).toBe(51);
  });

  it('T01-10: a number taken in a rolled-back transaction is reused', async () => {
    expect(await take()).toBe('PLT/2026-27/000001');
    let seen = '';
    await expect(
      sequelize.transaction(async t => {
        seen = await nextNumber(0, 'PLATFORM_INVOICE', { date: '2026-11-01', transaction: t });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(seen).toBe('PLT/2026-27/000002');
    expect(await take()).toBe('PLT/2026-27/000002');
  });

  it('a rolled-back first call of a year leaves the sequence able to start at 1', async () => {
    await expect(
      sequelize.transaction(async t => {
        await nextNumber(0, 'PLATFORM_CREDIT_NOTE', { date: '2026-11-01', transaction: t });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await take('PLATFORM_CREDIT_NOTE')).toBe('PCN/2026-27/000001');
  });

  it('refuses to run outside a transaction', async () => {
    await expect(nextNumber(0, 'PLATFORM_INVOICE', { transaction: undefined as never })).rejects.toThrow(
      /inside a transaction/,
    );
  });
});
