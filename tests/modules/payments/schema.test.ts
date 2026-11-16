import { afterAll, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import { closeDb, sequelize } from '../../../src/models';
import { PAYMENTS_TABLES } from '../../../src/modules/payments/payments.exports';
import {
  referenceKeyOf,
  findDuplicateReference,
  findDuplicateSuspect,
  checkDuplicateSuspect,
} from '../../../src/modules/payments/payments.duplicates';
import { resetPayments, paymentsWorld } from '../../helpers/payments';
import { Payment } from '../../../src/models';
import { beforeEach } from 'vitest';

afterAll(closeDb);

describe('module 12 tables (7.1 to 7.9)', () => {
  it('all nine exist with their generated columns', async () => {
    const rows = await sequelize.query<{ TABLE_NAME: string }>(
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (:t)`,
      { replacements: { t: [...PAYMENTS_TABLES] }, type: QueryTypes.SELECT },
    );
    expect(rows).toHaveLength(9);
    const gen = await sequelize.query<{ TABLE_NAME: string; COLUMN_NAME: string }>(
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND GENERATION_EXPRESSION <> ''
         AND TABLE_NAME IN ('refunds','autopay_mandates','collections')`,
      { type: QueryTypes.SELECT },
    );
    expect(gen.map(g => `${g.TABLE_NAME}.${g.COLUMN_NAME}`).sort()).toEqual([
      'autopay_mandates.liveSlot',
      'collections.titleKey',
      'refunds.openSlot',
    ]);
  });
});

describe('database rules of module 12', () => {
  beforeEach(async () => {
    await resetPayments();
  });
  const base = (w: Awaited<ReturnType<typeof paymentsWorld>>, o: Record<string, unknown> = {}) => ({
    societyId: w.society.id!,
    unitId: w.units[0]!.id,
    source: 'OFFLINE',
    method: 'CASH',
    status: 'PENDING_APPROVAL',
    payerName: 'P',
    amountPaise: 1000,
    grossAmountPaise: 1000,
    paymentDate: '2026-11-04',
    ...o,
  });

  it('CHECKs: split must equal the amount for effective payments; cheque and gateway columns go together', async () => {
    const w = await paymentsWorld();
    await expect(
      Payment.create(base(w, { status: 'CONFIRMED', toInvoicesPaise: 400 }) as never),
    ).rejects.toThrow(/ck_payments_split/);
    await expect(Payment.create(base(w, { method: 'CHEQUE' }) as never)).rejects.toThrow(
      /ck_payments_cheque/,
    );
    await expect(Payment.create(base(w, { source: 'ONLINE' }) as never)).rejects.toThrow(
      /ck_payments_gateway/,
    );
    await expect(Payment.create(base(w, { amountPaise: 0, grossAmountPaise: 0 }) as never)).rejects.toThrow(
      /ck_payments_amount/,
    );
  });

  it('immutability hooks: amount, method, source and unit never change; the number is fixed once set; no delete', async () => {
    const w = await paymentsWorld();
    const p = await Payment.create(
      base(w, { receiptNo: 'RCT/2026-27/000009', receiptStatus: 'ISSUED' }) as never,
    );
    await expect(p.update({ amountPaise: 5, grossAmountPaise: 5 })).rejects.toThrow(/immutable/);
    const q = (await Payment.findByPk(p.id))!;
    await expect(q.update({ receiptNo: 'RCT/2026-27/000010' })).rejects.toThrow(/immutable/);
    await expect(q.destroy()).rejects.toThrow(/never deleted/);
    await expect((await Payment.findByPk(p.id))!.update({ notes: 'ok' })).resolves.toBeTruthy();
  });

  it('referenceKey is unique per society', async () => {
    const w = await paymentsWorld();
    await Payment.create(
      base(w, { method: 'NEFT', referenceNo: 'UTR1', referenceKey: 'BANK:UTR1' }) as never,
    );
    await expect(
      Payment.create(base(w, { method: 'NEFT', referenceNo: 'UTR1', referenceKey: 'BANK:UTR1' }) as never),
    ).rejects.toThrow();
  });
});

describe('duplicate detection (F22)', () => {
  beforeEach(async () => {
    await resetPayments();
  });
  it('builds reference keys per BR-12-26', () => {
    expect(referenceKeyOf({ method: 'NEFT', referenceNo: 'abc123def456' })).toBe('BANK:ABC123DEF456');
    expect(referenceKeyOf({ method: 'UPI_TO_BANK', referenceNo: '123456789012' })).toBe('BANK:123456789012');
    expect(
      referenceKeyOf({ method: 'CHEQUE', referenceNo: '654321', chequeBankName: 'State Bank of India' }),
    ).toBe('CHQ:statebankofindia:654321');
    expect(referenceKeyOf({ method: 'CASH' })).toBeNull();
    expect(referenceKeyOf({ method: 'UPI', referenceNo: 'x' })).toBeNull();
  });

  it('finds duplicate references and soft duplicates, ignoring rejected and failed ones', async () => {
    const w = await paymentsWorld();
    const mk = (o: Record<string, unknown>) =>
      Payment.create({
        societyId: w.society.id!,
        unitId: w.units[0]!.id,
        source: 'OFFLINE',
        method: 'CASH',
        status: 'PENDING_APPROVAL',
        payerName: 'P',
        amountPaise: 5_000,
        grossAmountPaise: 5_000,
        paymentDate: '2026-11-04',
        ...o,
      } as never);
    const a = await mk({ method: 'NEFT', referenceKey: 'BANK:U1' });
    expect(await findDuplicateReference(w.society.id!, 'BANK:U1')).toEqual({ id: Number(a.id) });
    expect(await findDuplicateReference(w.society.id!, 'BANK:U2')).toBeNull();
    expect(await findDuplicateReference(w.society.id!, null)).toBeNull();
    const q = {
      unitId: w.units[0]!.id,
      method: 'NEFT' as const,
      amountPaise: 5_000,
      paymentDate: '2026-11-04',
    };
    expect(await findDuplicateSuspect(w.society.id!, q)).toEqual({ id: Number(a.id) });
    await expect(checkDuplicateSuspect(w.society.id!, q, false)).rejects.toMatchObject({
      code: 'DUPLICATE_PAYMENT_SUSPECTED',
      status: 409,
    });
    expect(await checkDuplicateSuspect(w.society.id!, q, true)).toEqual({ id: Number(a.id) });
    await a.update({ status: 'REJECTED' });
    expect(await findDuplicateSuspect(w.society.id!, q)).toBeNull();
  });
});
