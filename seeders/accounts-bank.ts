import { BankAccount, Society } from '../src/models';
import { createBankAccount } from '../src/modules/accounts/accounts.bank.service';
import { accountNumberHash } from '../src/modules/accounts/accounts.bank.crypto';
import { ensureBooks } from '../src/modules/accounts/accounts.chart';
import { sequelize } from '../src/models';
import { systemCtx } from '../src/types/context';
import type { AccountsSeedReport } from './accounts';

/**
 * Module 13.2 demo seed (not run in production): Sky Heights CHS and Green Park CHS each get one HDFC Bank current account, verified and
 * set as the collection account (masked number only; the full number is encrypted at rest), so the browser test types no ids. The chart
 * and the three standard funds (Sinking, Repair, Corpus) come from `ensureBooks`. Idempotent by the account number hash.
 */
const DEMO: Record<string, { ifsc: string; number: string; branch: string }> = {
  'sky-heights': { ifsc: 'HDFC0001234', number: '50200012345678', branch: 'Andheri West' },
  'green-park': { ifsc: 'HDFC0004321', number: '50200087654321', branch: 'Kothrud' },
};

export async function seedAccountsBank(): Promise<AccountsSeedReport> {
  if (process.env.NODE_ENV === 'production') throw new Error('accounts demo seed must not run in production');
  const report: AccountsSeedReport = { created: [], skipped: [] };
  for (const [slug, d] of Object.entries(DEMO)) {
    const society = await Society.findOne({ where: { slug } });
    if (!society) {
      report.skipped.push(`${slug} (no demo society)`);
      continue;
    }
    const societyId = Number(society.id);
    await sequelize.transaction(t => ensureBooks(t, societyId));
    const existing = await BankAccount.findOne({
      where: { societyId, accountNumberHash: accountNumberHash(d.ifsc, d.number) },
    });
    if (existing) {
      report.skipped.push(`${slug} bank account (already there)`);
      continue;
    }
    const ctx = {
      ...systemCtx('seed'),
      society: { id: societyId, name: society.name, status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
    };
    const dto = await createBankAccount(ctx, {
      displayName: 'HDFC Current',
      bankName: 'HDFC Bank',
      branchName: d.branch,
      ifsc: d.ifsc,
      accountKind: 'CURRENT',
      accountHolderName: society.name,
      accountNumber: d.number,
      confirmAccountNumber: d.number,
      statementFormat: 'HDFC_CSV',
      isCollectionAccount: true,
    });
    await BankAccount.update(
      { verificationStatus: 'VERIFIED', verifiedAt: new Date() },
      { where: { id: dto.id, societyId } },
    );
    report.created.push(`${slug} bank account ${dto.maskedNumber} (verified, collection)`);
  }
  return report;
}
