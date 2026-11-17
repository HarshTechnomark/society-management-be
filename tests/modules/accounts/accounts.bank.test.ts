import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, BankAccount, JournalEntry, LedgerAccount, closeDb, sequelize } from '../../../src/models';
import { advance, setNow } from '../../../src/lib/clock';
import { parseEnv } from '../../../src/lib/env';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import {
  accountNumberHash,
  decryptAccountNumber,
  encryptAccountNumber,
} from '../../../src/modules/accounts/accounts.bank.crypto';
import { accountsPortCalls } from '../../../src/modules/accounts/accounts.ports';
import { readSocietyBalance } from '../../../src/modules/accounts/accounts.lookup';
import { balanceOf, ctxOf, post, resetAccounts } from '../../helpers/accounts';
import { memberOf, setupSociety } from '../../helpers/society-setup';
import { activeGrant, enterAsSupport, platformAs } from '../../helpers/societies';
import { resetLogins } from '../../helpers/access';

afterAll(closeDb);
beforeEach(async () => {
  resetLogins();
  await resetRateLimits();
  await resetAccounts();
  setNow('2026-11-01T04:30:00Z');
});

const idem = () => ({ 'Idempotency-Key': randomUUID() });
const body = (o: Record<string, unknown> = {}) => ({
  displayName: 'HDFC Current',
  bankName: 'HDFC Bank',
  branchName: 'Baner',
  ifsc: 'HDFC0001234',
  accountKind: 'CURRENT',
  accountHolderName: 'Sky Heights CHS',
  accountNumber: '50200012344821',
  confirmAccountNumber: '50200012344821',
  ...o,
});

async function world(plan: 'STANDARD' | 'PREMIUM' = 'PREMIUM') {
  const w = await setupSociety({ plan });
  const treasurer = await memberOf(w.society, 'treasurer');
  return { ...w, sid: w.society.id!, treasurer };
}
type W = Awaited<ReturnType<typeof world>>;
const add = async (w: W, o: Record<string, unknown> = {}) => {
  const r = await w.c('post', '/accounts/bank-accounts', body(o), { headers: idem() });
  if (r.status !== 201) throw new Error(`add ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as Record<string, any>;
};

describe('encryption of the account number (BR-13-35)', () => {
  it('round-trips, binds to the society and hashes ifsc + number', () => {
    const blob = encryptAccountNumber(7, '50200012344821');
    expect(blob.length).toBeGreaterThan(28);
    expect(blob.toString('utf8')).not.toContain('5020001');
    expect(decryptAccountNumber(7, blob)).toBe('50200012344821');
    expect(() => decryptAccountNumber(8, blob)).toThrow();
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => decryptAccountNumber(7, tampered)).toThrow();
    expect(encryptAccountNumber(7, '50200012344821').equals(blob)).toBe(false); // random IV
    const h = accountNumberHash('HDFC0001234', '50200012344821');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(accountNumberHash('HDFC0001235', '50200012344821')).not.toBe(h);
  });

  it('BANK_ACCOUNT_ENCRYPTION_KEY must be 32 bytes in base64 and is required in production', () => {
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.DATABASE_URL,
      JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
      JWT_REFRESH_PEPPER: process.env.JWT_REFRESH_PEPPER,
      AUTH_TOKEN_PEPPER: process.env.AUTH_TOKEN_PEPPER,
      TOTP_ENCRYPTION_KEY: process.env.TOTP_ENCRYPTION_KEY,
      WEBAUTHN_RP_ID: 'localhost',
      WEBAUTHN_RP_NAME: 'x',
      RESIDENT_DATA_KEY: process.env.RESIDENT_DATA_KEY,
    } as NodeJS.ProcessEnv;
    expect(() => parseEnv({ ...base })).not.toThrow();
    expect(() => parseEnv({ ...base, BANK_ACCOUNT_ENCRYPTION_KEY: 'AAAA' })).toThrow(
      /BANK_ACCOUNT_ENCRYPTION_KEY/,
    );
    expect(() =>
      parseEnv({ ...base, BANK_ACCOUNT_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') }),
    ).not.toThrow();
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', PROVIDERS_MODE: 'real' })).toThrow(
      /BANK_ACCOUNT_ENCRYPTION_KEY|PROVIDER|REDIS/,
    );
  });
});

describe('create (T13-31, BR-13-36, BR-13-37)', () => {
  it('needs a recent sign-in, then returns the masked account and writes an audit row without the number', async () => {
    const w = await world();
    advance(10 * 60_000); // 10 minutes after sign-in: older than the 5 minute window
    const stale = await w.c('post', '/accounts/bank-accounts', body(), { headers: idem() });
    expect([stale.status, stale.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    advance(-10 * 60_000);
    const r = await w.c('post', '/accounts/bank-accounts', body(), { headers: idem() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      displayName: 'HDFC Current',
      ifsc: 'HDFC0001234',
      maskedNumber: 'XXXXXX4821',
      isCollectionAccount: true,
      verificationStatus: 'UNVERIFIED',
      status: 'ACTIVE',
      ledgerCode: '1110-001',
      balancePaise: 0,
      version: 1,
    });
    expect(JSON.stringify(r.body)).not.toContain('50200012344821');
    const row = (await BankAccount.unscoped().findByPk(r.body.data.id))!;
    expect(Buffer.from(row.accountNumberEnc).toString('latin1')).not.toContain('5020001');
    expect(decryptAccountNumber(w.sid, Buffer.from(row.accountNumberEnc))).toBe('50200012344821');
    expect(row.accountNumberLast4).toBe('4821');
    const ledger = (await LedgerAccount.findOne({ where: { societyId: w.sid, code: '1110-001' } }))!;
    expect([ledger.name, ledger.subtype, ledger.accountType, ledger.isSystem]).toEqual([
      'Bank - HDFC Current',
      'BANK',
      'ASSET',
      true,
    ]);
    const log = (await AuditLog.findOne({
      where: { societyId: w.sid, action: 'accounts.bank_account.created' },
    }))!;
    expect(JSON.stringify(log.after)).toContain('XXXXXX4821');
    expect(JSON.stringify(log.after)).not.toContain('50200012344821');
    // the committee is told after commit (not the creator)
    const sent = accountsPortCalls.find(
      c => c.fn === 'notifications.send' && (c.input as any).template === 'accounts.bank_account_changed',
    );
    expect((sent!.input as any).userIds).toContain(w.treasurer.user.id);
    expect((sent!.input as any).userIds).not.toContain(w.user.id);
  });

  it('validates the body: confirm mismatch, digits, IFSC, opening date, unknown keys', async () => {
    const w = await world();
    const bad = async (o: Record<string, unknown>, field: string) => {
      const r = await w.c('post', '/accounts/bank-accounts', body(o), { headers: idem() });
      expect([r.status, r.body.code], field).toEqual([400, 'VALIDATION_FAILED']);
      expect(
        r.body.errors.map((e: any) => e.field),
        field,
      ).toContain(field);
    };
    await bad({ confirmAccountNumber: '1234567890' }, 'confirmAccountNumber');
    await bad({ accountNumber: '12345', confirmAccountNumber: '12345' }, 'accountNumber');
    await bad({ ifsc: 'HDFC1001234' }, 'ifsc');
    await bad({ accountKind: 'FIXED' }, 'accountKind');
    await bad({ openingBalancePaise: 5_000_00 }, 'openingBalanceDate');
    await bad({ surprise: true }, 'surprise');
    const lower = await w.c('post', '/accounts/bank-accounts', body({ ifsc: 'hdfc0001234' }), {
      headers: idem(),
    });
    expect(lower.body.data.ifsc).toBe('HDFC0001234');
  });

  it('the first account is the collection account; a duplicate IFSC + number is 409', async () => {
    const w = await world();
    const a = await add(w);
    expect(a.isCollectionAccount).toBe(true);
    const dup = await w.c('post', '/accounts/bank-accounts', body({ displayName: 'Again' }), {
      headers: idem(),
    });
    expect([dup.status, dup.body.code]).toEqual([409, 'DUPLICATE_BANK_ACCOUNT']);
    const same = await add(w, { displayName: 'Other IFSC', ifsc: 'HDFC0009999' }); // same number, other branch code is a different account
    expect(same.ledgerCode).toBe('1110-002');
  });

  it('a second active account needs accounting.bank_and_cash_accounts (T13-33); Premium allows up to 10 (BANK_ACCOUNT_LIMIT)', async () => {
    const std = await world('STANDARD');
    await add(std);
    const no = await std.c(
      'post',
      '/accounts/bank-accounts',
      body({ accountNumber: '60200012344822', confirmAccountNumber: '60200012344822' }),
      { headers: idem() },
    );
    expect([no.status, no.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    const w = await world();
    await add(w);
    for (let i = 2; i <= 10; i++) {
      const n = `7020001234${String(1000 + i)}`;
      const r = await add(w, { displayName: `Acc ${i}`, accountNumber: n, confirmAccountNumber: n });
      expect(r.isCollectionAccount).toBe(false);
    }
    const n = '80200012349999';
    const over = await w.c(
      'post',
      '/accounts/bank-accounts',
      body({ accountNumber: n, confirmAccountNumber: n }),
      { headers: idem() },
    );
    expect([over.status, over.body.code]).toEqual([422, 'BANK_ACCOUNT_LIMIT']);
  });

  it('isCollectionAccount true on a later account moves the flag (one collection account only)', async () => {
    const w = await world();
    const a = await add(w);
    const b = await add(w, {
      displayName: 'Second',
      accountNumber: '90200012341111',
      confirmAccountNumber: '90200012341111',
      isCollectionAccount: true,
    });
    expect(b.isCollectionAccount).toBe(true);
    expect((await w.c('get', `/accounts/bank-accounts/${a.id}`)).body.data.isCollectionAccount).toBe(false);
    expect(await BankAccount.count({ where: { societyId: w.sid, isCollectionAccount: true } })).toBe(1);
  });

  it('posts the opening balance (Dr bank, Cr 3900) dated by the account; a negative balance is a bank overdraft', async () => {
    const w = await world();
    const a = await add(w, { openingBalancePaise: 1_250_000, openingBalanceDate: '2026-04-01' });
    expect(a).toMatchObject({
      balancePaise: 1_250_000,
      openingBalancePaise: 1_250_000,
      openingBalanceDate: '2026-04-01',
    });
    const e = (await JournalEntry.findOne({
      where: { societyId: w.sid, refType: 'bank_opening', refId: String(a.id) },
    }))!;
    expect([e.voucherType, e.status, e.entryDate, Number(e.totalPaise)]).toEqual([
      'OPENING_BALANCE',
      'POSTED',
      '2026-04-01',
      1_250_000,
    ]);
    expect(await balanceOf(w.sid, '3900')).toBe(-1_250_000);
    expect((await readSocietyBalance(w.sid)).inBankPaise).toBe(1_250_000);
    const n = '55500012345678';
    const od = await add(w, {
      displayName: 'Overdraft',
      accountNumber: n,
      confirmAccountNumber: n,
      openingBalancePaise: -300_000,
      openingBalanceDate: '2026-04-01',
    });
    expect(od.balancePaise).toBe(-300_000);
    expect(await balanceOf(w.sid, '3900')).toBe(-950_000);
  });

  it('refuses an opening date in the future or in a locked period, and leaves nothing behind', async () => {
    const w = await world();
    const f = await w.c(
      'post',
      '/accounts/bank-accounts',
      body({ openingBalancePaise: 100_000, openingBalanceDate: '2027-01-05' }),
      { headers: idem() },
    );
    expect([f.status, f.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    await add(w, {
      displayName: 'First',
      accountNumber: '11100012345678',
      confirmAccountNumber: '11100012345678',
    });
    await sequelize.query('UPDATE society_balances SET booksLockedThrough = ? WHERE societyId = ?', {
      replacements: ['2026-06-30', w.sid],
    });
    const l = await w.c(
      'post',
      '/accounts/bank-accounts',
      body({ openingBalancePaise: 100_000, openingBalanceDate: '2026-04-01' }),
      { headers: idem() },
    );
    expect([l.status, l.body.code]).toEqual([409, 'PERIOD_LOCKED']);
    expect(await BankAccount.count({ where: { societyId: w.sid } })).toBe(1);
    expect(await LedgerAccount.count({ where: { societyId: w.sid, code: '1110-002' } })).toBe(0);
  });
});

describe('list, get and masking', () => {
  it('lists masked accounts with ledger balances, filters and never returns the number', async () => {
    const w = await world();
    const a = await add(w);
    const b = await add(w, {
      displayName: 'SBI Savings',
      accountKind: 'SAVINGS',
      accountNumber: '33300012345678',
      confirmAccountNumber: '33300012345678',
    });
    const r = await w.c('get', '/accounts/bank-accounts');
    expect(r.body.data.map((x: any) => [x.id, x.maskedNumber])).toEqual([
      [a.id, 'XXXXXX4821'],
      [b.id, 'XXXXXX5678'],
    ]);
    expect(JSON.stringify(r.body)).not.toMatch(/accountNumberEnc|50200012344821|33300012345678/);
    const f = await w.c('get', '/accounts/bank-accounts', undefined, {
      query: { isCollectionAccount: 'true' },
    });
    expect(f.body.data.map((x: any) => x.id)).toEqual([a.id]);
    const v = await w.c('get', '/accounts/bank-accounts', undefined, {
      query: { verificationStatus: 'VERIFIED' },
    });
    expect(v.body.data).toEqual([]);
    expect((await w.c('get', `/accounts/bank-accounts/${b.id}`)).body.data.displayName).toBe('SBI Savings');
    const nf = await w.c('get', '/accounts/bank-accounts/999999');
    expect([nf.status, nf.body.code]).toEqual([404, 'BANK_ACCOUNT_NOT_FOUND']);
  });
});

describe('edit and verify (BR-13-36, T13-32)', () => {
  it('the creator cannot verify (409), another approver can once, and the number change resets it', async () => {
    const w = await world();
    const a = await add(w);
    const own = await w.c('post', `/accounts/bank-accounts/${a.id}/verify`, { version: 1 });
    expect([own.status, own.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    const stale = await w.treasurer.c('post', `/accounts/bank-accounts/${a.id}/verify`, { version: 9 });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const ok = await w.treasurer.c('post', `/accounts/bank-accounts/${a.id}/verify`, { version: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      verificationStatus: 'VERIFIED',
      verifiedBy: w.treasurer.user.id,
      version: 2,
    });
    const twice = await w.treasurer.c('post', `/accounts/bank-accounts/${a.id}/verify`, { version: 2 });
    expect([twice.status, twice.body.code]).toEqual([409, 'INVALID_STATE']);
    // the creator is told it was verified
    expect(
      accountsPortCalls.some(
        c => c.fn === 'notifications.send' && (c.input as any).template === 'accounts.bank_account_verified',
      ),
    ).toBe(true);
    // renaming keeps VERIFIED
    const rn = await w.c('patch', `/accounts/bank-accounts/${a.id}`, {
      displayName: 'HDFC Main',
      version: 2,
    });
    expect(rn.status, JSON.stringify(rn.body)).toBe(200);
    expect(rn.body.data).toMatchObject({
      displayName: 'HDFC Main',
      verificationStatus: 'VERIFIED',
      version: 3,
    });
    expect((await LedgerAccount.findOne({ where: { societyId: w.sid, code: '1110-001' } }))!.name).toBe(
      'Bank - HDFC Main',
    );
    // a new number resets verification and re-masks
    const num = await w.c('patch', `/accounts/bank-accounts/${a.id}`, {
      accountNumber: '50200099990000',
      confirmAccountNumber: '50200099990000',
      version: 3,
    });
    expect(num.body.data).toMatchObject({
      maskedNumber: 'XXXXXX0000',
      verificationStatus: 'UNVERIFIED',
      verifiedBy: null,
      version: 4,
    });
    expect(
      decryptAccountNumber(
        w.sid,
        Buffer.from((await BankAccount.unscoped().findByPk(a.id))!.accountNumberEnc),
      ),
    ).toBe('50200099990000');
    // the last editor cannot verify either, another approver can
    const me = await w.c('post', `/accounts/bank-accounts/${a.id}/verify`, { version: 4 });
    expect(me.body.code).toBe('MAKER_CHECKER_VIOLATION');
    const ok2 = await w.treasurer.c('post', `/accounts/bank-accounts/${a.id}/verify`, { version: 4 });
    expect(ok2.status).toBe(200);
  });

  it('an IFSC-only change recomputes the hash, resets verification and respects uniqueness; mismatched confirm is 400', async () => {
    const w = await world();
    const a = await add(w);
    const b = await add(w, { displayName: 'Other', ifsc: 'HDFC0007777' });
    const r = await w.c('patch', `/accounts/bank-accounts/${b.id}`, { ifsc: 'HDFC0008888', version: 1 });
    expect(r.body.data).toMatchObject({ ifsc: 'HDFC0008888', verificationStatus: 'UNVERIFIED' });
    // a different account holder resets a verified account too
    await BankAccount.update(
      { verificationStatus: 'VERIFIED', verifiedBy: w.user.id, verifiedAt: new Date() } as never,
      { where: { id: b.id } },
    );
    const holder = await w.c('patch', `/accounts/bank-accounts/${b.id}`, {
      accountHolderName: 'Someone Else Housing Society',
      version: 2,
    });
    expect(holder.body.data).toMatchObject({ verificationStatus: 'UNVERIFIED', verifiedBy: null });
    const row = (await BankAccount.findByPk(b.id))!;
    expect(row.accountNumberHash).toBe(accountNumberHash('HDFC0008888', '50200012344821'));
    const clash = await w.c('patch', `/accounts/bank-accounts/${b.id}`, { ifsc: 'HDFC0001234', version: 3 });
    expect([clash.status, clash.body.code]).toEqual([409, 'DUPLICATE_BANK_ACCOUNT']);
    const mm = await w.c('patch', `/accounts/bank-accounts/${a.id}`, {
      accountNumber: '50200099990000',
      confirmAccountNumber: '1',
      version: 1,
    });
    expect([mm.status, mm.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    const audit = await AuditLog.findAll({
      where: { societyId: w.sid, action: 'accounts.bank_account.updated' },
    });
    expect(JSON.stringify(audit.map(x => x.after))).not.toContain('50200012344821');
  });
});

describe('collection account and close (BR-13-37)', () => {
  it('set-collection moves the flag in one step and is a no-op when already set', async () => {
    const w = await world();
    const a = await add(w);
    const b = await add(w, {
      displayName: 'Second',
      accountNumber: '90200012341111',
      confirmAccountNumber: '90200012341111',
    });
    const r = await w.treasurer.c('post', `/accounts/bank-accounts/${b.id}/set-collection`, { version: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.isCollectionAccount).toBe(true);
    expect((await w.c('get', `/accounts/bank-accounts/${a.id}`)).body.data.isCollectionAccount).toBe(false);
    expect(await BankAccount.count({ where: { societyId: w.sid, isCollectionAccount: true } })).toBe(1);
    const again = await w.treasurer.c('post', `/accounts/bank-accounts/${b.id}/set-collection`, {
      version: r.body.data.version,
    });
    expect(again.status).toBe(200);
    const stale = await w.treasurer.c('post', `/accounts/bank-accounts/${a.id}/set-collection`, {
      version: 1,
    });
    expect(stale.body.code).toBe('STALE_VERSION');
    expect(
      await AuditLog.count({ where: { societyId: w.sid, action: 'accounts.bank_account.collection_set' } }),
    ).toBe(1);
  });

  it('close: not the collection account, only with a zero book balance; then it is CLOSED and its ledger inactive', async () => {
    const w = await world();
    const a = await add(w, { openingBalancePaise: 500_000, openingBalanceDate: '2026-04-01' });
    const b = await add(w, {
      displayName: 'Second',
      accountNumber: '90200012341111',
      confirmAccountNumber: '90200012341111',
    });
    const col = await w.treasurer.c('post', `/accounts/bank-accounts/${a.id}/close`, {
      reason: 'Closing it',
      version: 1,
    });
    expect([col.status, col.body.code]).toEqual([422, 'COLLECTION_ACCOUNT_REQUIRED']);
    await w.treasurer.c('post', `/accounts/bank-accounts/${b.id}/set-collection`, { version: 1 });
    const bal = await w.treasurer.c('post', `/accounts/bank-accounts/${a.id}/close`, {
      reason: 'Closing it',
      version: 2,
    });
    expect([bal.status, bal.body.code]).toEqual([422, 'BANK_BALANCE_NOT_ZERO']);
    const bad = await w.treasurer.c('post', `/accounts/bank-accounts/${b.id}/close`, {
      reason: 'x',
      version: 2,
    });
    expect(bad.status).toBe(400);
    // empty the first account with a payment out, then close it
    await post(ctxOf(w.society, null), {
      date: '2026-10-10',
      voucherType: 'PAYMENT',
      refType: 'test_out',
      refId: '1',
      narration: 'Moved out',
      lines: [
        { ledgerAccountCode: '1110-002', debitPaise: 500_000, creditPaise: 0 },
        { ledgerAccountCode: '1110-001', debitPaise: 0, creditPaise: 500_000 },
      ],
    });
    const ok = await w.treasurer.c('post', `/accounts/bank-accounts/${a.id}/close`, {
      reason: 'Account closed at bank',
      version: 2,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('CLOSED');
    expect((await LedgerAccount.findOne({ where: { societyId: w.sid, code: '1110-001' } }))!.isActive).toBe(
      false,
    );
    const again = await w.treasurer.c('post', `/accounts/bank-accounts/${a.id}/close`, {
      reason: 'Account closed at bank',
      version: 3,
    });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
    const edit = await w.c('patch', `/accounts/bank-accounts/${a.id}`, {
      displayName: 'Closed one',
      version: 3,
    });
    expect(edit.body.code).toBe('INVALID_STATE');
    expect((await w.c('get', '/accounts/bank-accounts')).body.data.map((x: any) => x.id)).toEqual([b.id]);
    expect(
      (await w.c('get', '/accounts/bank-accounts', undefined, { query: { status: 'ALL' } })).body.data,
    ).toHaveLength(2);
    expect(
      await AuditLog.count({ where: { societyId: w.sid, action: 'accounts.bank_account.closed' } }),
    ).toBe(1);
    // a closed account frees a slot of the Premium limit and the next one can be the collection account again
    const n = '44400012345678';
    const c = await add(w, { displayName: 'Third', accountNumber: n, confirmAccountNumber: n });
    expect(c.ledgerCode).toBe('1110-003');
  });

  it('the only active account (the collection account) cannot be closed', async () => {
    const w = await world();
    const a = await add(w);
    const r = await w.treasurer.c('post', `/accounts/bank-accounts/${a.id}/close`, {
      reason: 'Close the only one',
      version: 1,
    });
    expect([r.status, r.body.code]).toEqual([422, 'COLLECTION_ACCOUNT_REQUIRED']);
  });
});

describe('reveal (BR-13-35, T13-34)', () => {
  it('needs step-up, returns the number with no-store, audits it and is limited to 10 an hour', async () => {
    const w = await world();
    const a = await add(w);
    advance(10 * 60_000);
    const stale = await w.c('get', `/accounts/bank-accounts/${a.id}/reveal`);
    expect([stale.status, stale.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    advance(-10 * 60_000);
    const r = await w.c('get', `/accounts/bank-accounts/${a.id}/reveal`);
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ accountNumber: '50200012344821' });
    expect(r.headers['cache-control']).toBe('no-store');
    const log = (await AuditLog.findOne({
      where: { societyId: w.sid, action: 'accounts.bank_account.revealed' },
    }))!;
    expect(JSON.stringify(log.after)).not.toContain('50200012344821');
    for (let i = 0; i < 9; i++)
      expect((await w.c('get', `/accounts/bank-accounts/${a.id}/reveal`)).status).toBe(200);
    const limited = await w.c('get', `/accounts/bank-accounts/${a.id}/reveal`);
    expect([limited.status, limited.body.code]).toEqual([429, 'RATE_LIMITED']);
  });

  it('is refused for a support access session (noSupportAccess)', async () => {
    const w = await world();
    const a = await add(w);
    const agent = await platformAs('platform_support');
    const rw = await enterAsSupport(
      agent.cookies,
      (await activeGrant(w.sid, agent.user.id, 'READ_WRITE')).id!,
    );
    const r = await rw.c('get', `/accounts/bank-accounts/${a.id}/reveal`);
    expect([r.status, r.body.code]).toEqual([403, 'SUPPORT_ROUTE_FORBIDDEN']);
  });

  it('another society sees 404 on every id route', async () => {
    const w = await world();
    const o = await world();
    const a = await add(o);
    for (const [m, p, b] of [
      ['get', `/accounts/bank-accounts/${a.id}`, undefined],
      ['patch', `/accounts/bank-accounts/${a.id}`, { displayName: 'Hijack', version: 1 }],
      ['post', `/accounts/bank-accounts/${a.id}/verify`, { version: 1 }],
      ['post', `/accounts/bank-accounts/${a.id}/set-collection`, { version: 1 }],
      ['post', `/accounts/bank-accounts/${a.id}/close`, { reason: 'Hijack it', version: 1 }],
      ['get', `/accounts/bank-accounts/${a.id}/reveal`, undefined],
    ] as const) {
      const r = await w.c(m, p, b);
      expect([r.status, r.body.code], p).toEqual([404, 'BANK_ACCOUNT_NOT_FOUND']);
    }
  });
});
