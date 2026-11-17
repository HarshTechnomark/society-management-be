import { setBillingPorts, type JournalPort } from '../billing/billing.ports';
import { setPaymentsPorts, type BankAccountsPort, type FundsPort } from '../payments/payments.ports';
import { getBankAccount, getFund, ledgerAccountExists, readSocietyBalance } from './accounts.lookup';
import { isDateLocked, postJournal } from './accounts.engine';
import type { VoucherType } from './accounts.constants';

/**
 * The module 11 and module 12 journal ports are the same shape: `post` with `accountCode` lines. This adapter maps them to the real
 * engine (`ledgerAccountCode`); the extra `unitId` on a line is not stored (journal lines have no unit column).
 */
export const realJournalPort: JournalPort = {
  post: async (ctx, input, t) => {
    const r = await postJournal(
      ctx,
      {
        date: input.date,
        voucherType: input.voucherType as VoucherType,
        refType: input.refType,
        refId: input.refId,
        narration: input.narration,
        lines: input.lines.map(l => ({
          ledgerAccountCode: l.accountCode,
          debitPaise: l.debitPaise,
          creditPaise: l.creditPaise,
          fundId: l.fundId ?? undefined,
          lineNarration: l.narration,
        })),
      },
      t,
    );
    return { id: r.id };
  },
  accountExists: (societyId, code) => ledgerAccountExists(societyId, code),
  isDateLocked: (societyId, date) => isDateLocked(societyId, date),
};

/** Real fund and bank account lookups for module 12 (installed by 13.2, see README; the foundation keeps the permissive placeholders). */
export const realFundsPort: FundsPort = {
  exists: async (societyId, fundId) => (await getFund(societyId, fundId)) !== null,
  name: async (societyId, fundId) => (await getFund(societyId, fundId))?.name ?? null,
};
export const realBankAccountsPort: BankAccountsPort = {
  get: async (societyId, id) => {
    const b = await getBankAccount(societyId, id);
    return b ? { id: b.id, label: `${b.displayName} (${b.maskedNumber})` } : null;
  },
};

/** Installs the real engine behind the module 11 and 12 ports. Called by `registerAccounts()`. */
export function installRealJournal(): void {
  setBillingPorts({ journal: realJournalPort });
  setPaymentsPorts({
    journal: realJournalPort,
    societyBalance: {
      get: async societyId => ({ balancePaise: (await readSocietyBalance(societyId)).totalPaise }),
    },
    funds: realFundsPort,
    bankAccounts: realBankAccountsPort,
  });
}
