import type { GstTreatment, HeadType, PayerRouting } from './billing.constants';

/** Section 7.13: the heads every society gets from `chargeHeads.ensureSeeded` (idempotent by `key`). `sacCode` is seeded NULL.
 * Names are what members see on bills: no references to other modules (migration 20261116000100 renames older rows). */
export interface SeedHead {
  key: string;
  name: string;
  headType: HeadType;
  payerRouting: PayerRouting;
  gstTreatment: GstTreatment;
  prorate: boolean;
  interestBearing: boolean;
  ledgerAccountCode: string;
  isSystem: boolean;
}

type Row = [string, string, HeadType, PayerRouting, GstTreatment, boolean, boolean, string, boolean?];
const ROWS: Row[] = [
  ['MAINTENANCE', 'Maintenance (service charges)', 'MAINTENANCE', 'BILL_TO', 'THRESHOLD', true, true, '4100'],
  ['SINKING_FUND', 'Sinking fund', 'SINKING_FUND', 'OWNER', 'THRESHOLD', true, true, '2410'],
  ['REPAIR_FUND', 'Repair and maintenance fund', 'REPAIR_FUND', 'OWNER', 'THRESHOLD', true, true, '2420'],
  ['PARKING', 'Parking charges', 'PARKING', 'BILL_TO', 'THRESHOLD', true, true, '4120'],
  ['WATER', 'Water charges', 'WATER', 'BILL_TO', 'NONE', true, true, '4130'],
  ['ELECTRICITY', 'Common electricity share', 'ELECTRICITY', 'BILL_TO', 'NONE', false, true, '4135'],
  ['NON_OCCUPANCY', 'Non-occupancy charges', 'NON_OCCUPANCY', 'OWNER', 'THRESHOLD', true, true, '4110'],
  ['FESTIVAL', 'Festival and event contribution', 'FESTIVAL', 'BILL_TO', 'NONE', false, false, '4150'],
  ['AMENITY_BOOKING', 'Amenity booking charges', 'AMENITY', 'BILL_TO', 'ALWAYS', false, false, '4160'],
  ['AMENITY_DAMAGE', 'Amenity damage recovery', 'AMENITY', 'BILL_TO', 'NONE', false, true, '4950'],
  ['EV_CHARGING', 'EV charging', 'ELECTRICITY', 'BILL_TO', 'ALWAYS', false, true, '4135'],
  ['ACCESS_CARD_FEE', 'Access card replacement fee', 'SERVICE', 'BILL_TO', 'NONE', false, true, '4190'],
  ['FINE', 'Fines', 'FINE', 'BILL_TO', 'NONE', false, false, '4170'],
  ['CHARGEABLE_WORK', 'Chargeable repair work', 'SERVICE', 'BILL_TO', 'ALWAYS', false, false, '4180'],
  ['TRANSFER_PREMIUM', 'Transfer premium', 'TRANSFER', 'OWNER', 'NONE', false, false, '4190'],
  ['SHARE_TRANSFER_FEE', 'Share transfer fee', 'TRANSFER', 'OWNER', 'NONE', false, false, '4400'],
  ['CERTIFICATE_FEE', 'Certificate fee', 'SERVICE', 'BILL_TO', 'NONE', false, false, '4400'],
  ['ENTRANCE_FEE', 'Entrance fee', 'MEMBERSHIP', 'OWNER', 'NONE', false, false, '4420'],
  ['RENOVATION_FEE', 'Renovation permit fee', 'SERVICE', 'OWNER', 'NONE', false, false, '4190'],
  ['COLLECTION', 'Collection contribution', 'COLLECTION', 'BILL_TO', 'NONE', false, false, 'COLLECTION_FUND'],
  ['CHEQUE_BOUNCE_CHARGE', 'Cheque bounce charge', 'BOUNCE_CHARGE', 'BILL_TO', 'NONE', false, true, '4145'],
  ['DEPOSIT_RENOVATION', 'Renovation deposit', 'DEPOSIT', 'BILL_TO', 'NONE', false, false, '2510'],
  ['DEPOSIT_MOVE', 'Move-in / move-out deposit', 'DEPOSIT', 'BILL_TO', 'NONE', false, false, '2520'],
  ['DEPOSIT_AMENITY', 'Amenity booking deposit', 'DEPOSIT', 'BILL_TO', 'NONE', false, false, '2530'],
  ['DEPOSIT_ACCESS_CARD', 'Access card deposit', 'DEPOSIT', 'BILL_TO', 'NONE', false, false, '2540'],
  ['DEPOSIT_KEY', 'Key deposit', 'DEPOSIT', 'BILL_TO', 'NONE', false, false, '2540'],
  ['DEPOSIT_OTHER', 'Other refundable deposit', 'DEPOSIT', 'BILL_TO', 'NONE', false, false, '2550'],
  ['INTEREST', 'Interest on arrears', 'INTEREST', 'BILL_TO', 'FOLLOW_SOURCE', false, false, '4140', true],
  ['LATE_FEE', 'Late payment fee', 'LATE_FEE', 'BILL_TO', 'FOLLOW_SOURCE', false, false, '4145', true],
  [
    'OPENING_ARREARS',
    'Arrears brought forward',
    'OPENING_ARREARS',
    'BILL_TO',
    'NONE',
    false,
    true,
    '3900',
    true,
  ],
];

export const SEED_HEADS: readonly (SeedHead & { sortOrder: number })[] = ROWS.map((r, i) => ({
  key: r[0],
  name: r[1],
  headType: r[2],
  payerRouting: r[3],
  gstTreatment: r[4],
  prorate: r[5],
  interestBearing: r[6],
  ledgerAccountCode: r[7],
  isSystem: r[8] ?? false,
  sortOrder: (i + 1) * 10,
}));
