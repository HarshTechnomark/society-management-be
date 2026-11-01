/**
 * Module 06 constants: the enums of section 7 (re-exported from the model files, which own them) and the GST state
 * code table used for the place of supply (BR-06-14).
 */
export {
  DOCUMENT_TYPES,
  INVOICE_KINDS,
  INVOICE_STATUSES,
  TAX_TYPES,
  CREDIT_NOTE_REASONS,
  PDF_STATUSES,
  ISSUED_MUTABLE_COLUMNS,
} from '../../models/platform-invoice.model';
export { LINE_TYPES } from '../../models/platform-invoice-line.model';
export {
  PAYMENT_KINDS,
  PAYMENT_ORIGINS,
  PAYMENT_STATUSES,
  PAYMENT_METHODS,
  STATUSES_BY_KIND,
  TDS_SECTIONS,
} from '../../models/platform-payment.model';
export { CREDIT_ENTRY_TYPES, CREDIT_STATUSES } from '../../models/platform-credit.model';
export { DUNNING_STEPS, DUNNING_OUTCOMES, DUNNING_SKIP_REASONS } from '../../models/dunning-event.model';

/** Number series of this module (module 01 `nextNumber(0, …)`, prefixes PLT and PCN). */
export const INVOICE_SERIES = 'PLATFORM_INVOICE' as const;
export const CREDIT_NOTE_SERIES = 'PLATFORM_CREDIT_NOTE' as const;

/** The platform's own state (default `company.stateCode`). */
export const PLATFORM_STATE_CODE = '27';

/** GST state codes by state or union territory name (BR-06-14). */
export const GST_STATE_CODES: Readonly<Record<string, string>> = {
  'Jammu and Kashmir': '01',
  'Himachal Pradesh': '02',
  Punjab: '03',
  Chandigarh: '04',
  Uttarakhand: '05',
  Haryana: '06',
  Delhi: '07',
  Rajasthan: '08',
  'Uttar Pradesh': '09',
  Bihar: '10',
  Sikkim: '11',
  'Arunachal Pradesh': '12',
  Nagaland: '13',
  Manipur: '14',
  Mizoram: '15',
  Tripura: '16',
  Meghalaya: '17',
  Assam: '18',
  'West Bengal': '19',
  Jharkhand: '20',
  Odisha: '21',
  Chhattisgarh: '22',
  'Madhya Pradesh': '23',
  Gujarat: '24',
  'Dadra and Nagar Haveli and Daman and Diu': '26',
  Maharashtra: '27',
  Karnataka: '29',
  Goa: '30',
  Lakshadweep: '31',
  Kerala: '32',
  'Tamil Nadu': '33',
  Puducherry: '34',
  'Andaman and Nicobar Islands': '35',
  Telangana: '36',
  'Andhra Pradesh': '37',
  Ladakh: '38',
};

/** GST state code of a state name (case-insensitive), or null when unknown. */
export function gstStateCode(state: string | null | undefined): string | null {
  if (!state) return null;
  const key = state.trim().toLowerCase();
  for (const [name, code] of Object.entries(GST_STATE_CODES)) if (name.toLowerCase() === key) return code;
  return null;
}
