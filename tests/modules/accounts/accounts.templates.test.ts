import { describe, expect, it } from 'vitest';
import { hasTemplate } from '../../../src/lib/notify';
import { NOTIFY } from '../../../src/modules/accounts/accounts.constants';
import '../../../src/modules/accounts/accounts.jobs'; // pulls in every template module through the job registrations

describe('accounts notification templates', () => {
  it('registers a template for every NOTIFY key', () => {
    const missing = Object.values(NOTIFY).filter(k => !hasTemplate(k));
    expect(missing).toEqual([]);
  });
});

import { inrPdf, renderPdf } from '../../../src/modules/accounts/accounts.reports.export';

describe('report PDF amounts', () => {
  it('uses the rupee sign and Indian grouping, and keeps long names whole', () => {
    expect(inrPdf('1234567.50')).toBe('₹12,34,567.50');
    expect(inrPdf('-204.16')).toBe('-₹204.16');
    expect(inrPdf('Deposit deductions and forfeiture')).toBe('Deposit deductions and forfeiture');
    const pdf = renderPdf(
      {
        title: 'Trial balance',
        subtitle: 'As of today',
        header: ['Code', 'Account', 'Debit'],
        rows: [['4600', 'Deposit deductions and forfeiture income', '1234567.50']],
        footer: [],
        numeric: [2],
      } as never,
      'Sky Heights',
    ).toString('latin1');
    expect(pdf).toContain('Rs.12,34,567.50');
    expect(pdf).toContain('forfeiture');
  });
});
