import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { JournalEntry, Society, closeDb, sequelize } from '../../../src/models';
import { registerAccounts } from '../../../src/modules/accounts/accounts.public';
import { collectionBank } from '../../../src/modules/accounts/accounts.lookup';
import { ACCOUNTS_SEEDERS, seedAccounts } from '../../../seeders/accounts';
import { resetAccounts } from '../../helpers/accounts';
import { lifecycleSociety } from '../../helpers/societies';

afterAll(closeDb);
beforeEach(resetAccounts);

describe('seed order (13 demo data)', () => {
  it('runs chart, bank, opening (books) before anything that posts, and the demo data last', () => {
    const names = ACCOUNTS_SEEDERS.map(s => s.name);
    expect(names.indexOf('chart')).toBeLessThan(names.indexOf('bank'));
    expect(names.indexOf('bank')).toBeLessThan(names.indexOf('opening'));
    expect(names.indexOf('opening')).toBeLessThan(names.indexOf('demo'));
    expect(ACCOUNTS_SEEDERS.filter(s => s.phase === 'books').map(s => s.name)).toEqual([
      'chart',
      'bank',
      'opening',
    ]);
  });

  it('the books phase gives a collection bank account and posts the bank opening line; the demo phase does not throw and a second run adds nothing', async () => {
    registerAccounts();
    const sky = await lifecycleSociety('ACTIVE', { name: 'Sky Heights CHS' });
    await Society.update({ slug: 'sky-heights' }, { where: { id: sky.id! } });
    const first = await seedAccounts('books');
    expect(first.created.join(';')).toContain('bank account');
    expect(await collectionBank(sky.id!)).not.toBeNull();
    const [r] = (await sequelize.query(
      `SELECT SUM(debitPaise) d, SUM(creditPaise) c FROM journal_lines WHERE societyId = ?`,
      { replacements: [sky.id!] },
    )) as [{ d: string; c: string }[], unknown];
    expect(Number(r[0]!.d)).toBeGreaterThan(0);
    expect(Number(r[0]!.d)).toBe(Number(r[0]!.c));
    expect(
      await JournalEntry.count({ where: { societyId: sky.id!, refType: 'opening', status: 'POSTED' } }),
    ).toBe(1);
    const again = await seedAccounts('books');
    expect(again.created).toEqual([]);
    await expect(seedAccounts('demo')).resolves.toBeDefined(); // no chairman user here: skipped, not thrown
  });
});
