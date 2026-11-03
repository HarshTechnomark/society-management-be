import {
  ENTRANCE_FEE_CAP,
  SHARE_TRANSFER_FEE_CAP,
  TRANSFER_PREMIUM_CAP,
  type TransferType,
} from './residents.part3.constants';
import { rule } from './residents.shared';

/**
 * BR-09-64 transfer fees (Maharashtra model bye-laws), in paise. The premium is charged for a sale and a court order only
 * (a gift may carry one when the society says so; inheritance, nomination and family settlement never do). The share transfer
 * fee is once per transfer and the entrance fee once per new buyer.
 */
export interface FeeSettings {
  transferPremiumPaise: number;
  shareTransferFeePaise: number;
  entranceFeePaise: number;
}
export interface FeeInput {
  transferPremiumPaise?: number;
  shareTransferFeePaise?: number;
  entranceFeePaise?: number;
}
export interface Fees {
  transferPremiumPaise: number;
  shareTransferFeePaise: number;
  entranceFeePaise: number;
  newBuyerCount: number;
  totalFeesPaise: number;
}

export const premiumApplies = (type: TransferType | string): boolean =>
  type === 'SALE' || type === 'COURT_ORDER';

/** The default premium of a type: the society setting for a sale or court order, else 0. */
export const defaultPremium = (type: string, s: FeeSettings): number =>
  premiumApplies(type) ? s.transferPremiumPaise : 0;

export function computeFees(type: string, s: FeeSettings, given: FeeInput, newBuyerCount: number): Fees {
  const premium = premiumApplies(type)
    ? (given.transferPremiumPaise ?? s.transferPremiumPaise)
    : type === 'GIFT'
      ? (given.transferPremiumPaise ?? 0)
      : 0;
  const share = given.shareTransferFeePaise ?? s.shareTransferFeePaise;
  const entrance = given.entranceFeePaise ?? s.entranceFeePaise;
  const over = (field: string, cap: number) =>
    rule(422, 'FEE_ABOVE_CAP', `This fee cannot be more than ${cap / 100} rupees`, field, { capPaise: cap });
  if (premium > TRANSFER_PREMIUM_CAP) throw over('transferPremiumPaise', TRANSFER_PREMIUM_CAP);
  if (share > SHARE_TRANSFER_FEE_CAP) throw over('shareTransferFeePaise', SHARE_TRANSFER_FEE_CAP);
  if (entrance > ENTRANCE_FEE_CAP) throw over('entranceFeePaise', ENTRANCE_FEE_CAP);
  return {
    transferPremiumPaise: premium,
    shareTransferFeePaise: share,
    entranceFeePaise: entrance,
    newBuyerCount,
    totalFeesPaise: premium + share + entrance * newBuyerCount,
  };
}
