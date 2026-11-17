import { Fund, JournalEntry, LedgerAccount, Society, sequelize } from '../src/models';
import { istDate, now } from '../src/lib/clock';
import { ensureBooks } from '../src/modules/accounts/accounts.chart';
import { postJournal } from '../src/modules/accounts/accounts.engine';
import type { JournalLineInput } from '../src/modules/accounts/accounts.types';
import { systemCtx } from '../src/types/context';
import type { AccountsSeedReport } from './accounts';

/**
 * Module 13.1 demo seed (not run in production): one opening-balance voucher for Sky Heights CHS and Green Park CHS through the
 * engine (`OPENING_BALANCE`, `refType 'opening'`, `refId` `DEMO:OPENING`), so the Today balance card shows real numbers: bank
 * Rs 10,00,000 (on the first bank ledger `1110-NNN` when 13.2 has created one; skipped when there is none), cash Rs 25,000,
 * sinking fund Rs 6,00,000 and repair fund Rs 2,00,000; the difference goes to 3900. Idempotent: the same refId replays.
 */
const DEMO_SLUGS = ['sky-heights', 'green-park'];
const REF = 'DEMO:OPENING';

export async function seedAccountsOpening(): Promise<AccountsSeedReport> {
  if (process.env.NODE_ENV === 'production') throw new Error('accounts demo seed must not run in production');
  const report: AccountsSeedReport = { created: [], skipped: [] };
  for (const slug of DEMO_SLUGS) {
    const society = await Society.findOne({ where: { slug } });
    if (!society) {
      report.skipped.push(`${slug} (no demo society)`);
      continue;
    }
    const societyId = Number(society.id);
    if (await JournalEntry.count({ where: { societyId, refType: 'opening', refId: REF } })) {
      report.skipped.push(`${slug} (opening balances already posted)`);
      continue;
    }
    const ctx = {
      ...systemCtx('seed'),
      society: {
        id: societyId,
        name: society.name,
        status: society.status,
        timezone: 'Asia/Kolkata',
        planKey: '',
      },
    };
    await sequelize.transaction(async t => {
      await ensureBooks(t, societyId);
      const lines: JournalLineInput[] = [];
      const bank = await LedgerAccount.findOne({
        where: { societyId, subtype: 'BANK', isGroup: false, isActive: true },
        order: [['code', 'ASC']],
        transaction: t,
      });
      if (bank) lines.push({ ledgerAccountCode: bank.code, debitPaise: 100_000_000, creditPaise: 0 });
      lines.push({ ledgerAccountCode: '1120', debitPaise: 2_500_000, creditPaise: 0 });
      for (const [type, paise] of [
        ['SINKING', 60_000_000],
        ['REPAIR', 20_000_000],
      ] as const) {
        const fund = await Fund.findOne({ where: { societyId, fundType: type }, transaction: t });
        if (fund)
          lines.push({
            ledgerAccountCode: 'COLLECTION_FUND',
            fundId: Number(fund.id),
            debitPaise: 0,
            creditPaise: paise,
          });
      }
      const debit = lines.reduce((s, l) => s + l.debitPaise, 0);
      const credit = lines.reduce((s, l) => s + l.creditPaise, 0);
      if (debit !== credit)
        lines.push({
          ledgerAccountCode: '3900',
          debitPaise: Math.max(0, credit - debit),
          creditPaise: Math.max(0, debit - credit),
        });
      await postJournal(
        ctx,
        {
          date: `${istDate(now()).slice(0, 8)}01`,
          voucherType: 'OPENING_BALANCE',
          refType: 'opening',
          refId: REF,
          narration: 'Opening balances (demo)',
          label: 'Opening balances',
          lines,
        },
        t,
      );
    });
    report.created.push(`${slug} opening balances`);
  }
  return report;
}
