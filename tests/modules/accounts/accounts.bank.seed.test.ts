import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BankAccount, Fund, Society, closeDb } from '../../../src/models';
import { collectionBank } from '../../../src/modules/accounts/accounts.lookup';
import { seedAccountsBank } from '../../../seeders/accounts-bank';
import { ACCOUNTS_SEEDERS } from '../../../seeders/accounts';
import { resetAccounts } from '../../helpers/accounts';
import { lifecycleSociety } from '../../helpers/societies';

afterAll(closeDb);
beforeEach(resetAccounts);

describe('13.2 demo seeder (idempotent)', () => {
  it('gives each demo society one verified collection bank account (HDFC, masked) and the standard funds, and a second run adds nothing', async () => {
    const sky = await lifecycleSociety('ACTIVE', { name: 'Sky Heights CHS' });
    const green = await lifecycleSociety('ACTIVE', { name: 'Green Park CHS' });
    await Society.update({ slug: 'sky-heights' }, { where: { id: sky.id! } });
    await Society.update({ slug: 'green-park' }, { where: { id: green.id! } });
    expect(ACCOUNTS_SEEDERS.map(s => s.name)).toContain('bank');
    const a = await seedAccountsBank();
    expect(a.created).toHaveLength(2);
    for (const s of [sky, green]) {
      const rows = await BankAccount.findAll({ where: { societyId: s.id! } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        bankName: 'HDFC Bank',
        verificationStatus: 'VERIFIED',
        isCollectionAccount: true,
        status: 'ACTIVE',
      });
      expect(rows[0]!.accountNumberLast4).toMatch(/^\d{4}$/);
      expect((await collectionBank(s.id!))!.ledgerCode).toBe('1110-001');
      expect((await Fund.findAll({ where: { societyId: s.id! } })).map(f => f.fundType).sort()).toEqual([
        'CORPUS',
        'REPAIR',
        'SINKING',
      ]);
    }
    const b = await seedAccountsBank();
    expect(b.created).toEqual([]);
    expect(await BankAccount.count()).toBe(2);
  });

  it('skips a society that is not seeded', async () => {
    const r = await seedAccountsBank();
    expect(r.created).toEqual([]);
    expect(r.skipped.length).toBe(2);
  });
});
