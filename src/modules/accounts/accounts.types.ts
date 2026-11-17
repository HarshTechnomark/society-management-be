import type { Transaction } from 'sequelize';
import type { Ctx } from '../../types/context';
import type { FundType, VoucherType } from './accounts.constants';

export type { Transaction, Ctx };
export type YmdString = string;

/** A context that may be a request context or a system context. */
export type AnyCtx = Ctx;

/** Section 8.20 `JournalLineInput`: `ledgerAccountCode` is a numeric code (`4100`, `1110-001`) or a system key (`BANK`). */
export interface JournalLineInput {
  ledgerAccountCode: string;
  debitPaise: number;
  creditPaise: number;
  fundId?: number | null;
  lineNarration?: string;
}

export interface PostJournalInput {
  date: YmdString;
  voucherType: VoucherType;
  refType: string;
  refId: string | number;
  narration: string;
  lines: JournalLineInput[];
  /** UTR, cheque number or gateway settlement UTR, for statement auto-match (BR-13-41). */
  instrumentRef?: string | null;
  /** Text of the `balance_history` row (admin only, at most 160 characters); defaults to the narration. */
  label?: string;
  /**
   * BR-13-32: refuse a USER posting that would take a fund below zero (`422 FUND_BALANCE_INSUFFICIENT`). Off by default so the
   * system postings of modules 11 and 12 never fail; expenses and fund transfers (13.2) switch it on where the spec says.
   */
  enforceFundBalance?: boolean;
  /** Year close only (13.4): the `CLOSING` voucher is the one writer allowed into a locked period (BR-13-8). */
  skipLockCheck?: boolean;
  /** `MANUAL` for manual journals (13.1); everything else is `SYSTEM`. Default: `MANUAL` when the voucher type is `JOURNAL` and the refType is `manual_journal`, else `SYSTEM`. */
  source?: 'SYSTEM' | 'MANUAL';
}

export interface PostJournalResult {
  id: number;
  voucherNo: string;
  entryDate: string;
  replayed: boolean;
}

export interface ReverseJournalInput {
  refType: string;
  refId: string | number;
  date?: YmdString;
  reason: string;
}

export interface FundDto {
  id: number;
  name: string;
  fundType: FundType;
  status: 'ACTIVE' | 'CLOSED';
  ledgerCode: string;
  balancePaise: number;
}

/** `balance.get` (section 8.20): the four figures, investments, funds and the derived "General" amount. */
export interface SocietyBalanceDto {
  societyId: number;
  inBankPaise: number;
  clearingPaise: number;
  cashPaise: number;
  chequesPaise: number;
  totalPaise: number;
  investmentsPaise: number;
  earmarkedFundsPaise: number;
  /** total − earmarked; negative means "Funds are not fully backed by cash" (BR-13-17). */
  generalPaise: number;
  lastChangedAt: string | null;
  lastJournalEntryId: number | null;
  funds: { id: number; name: string; fundType: FundType; balancePaise: number; showToResidents: boolean }[];
}

export interface ReadOpts {
  deadlineMs: number;
  replica?: boolean;
}
