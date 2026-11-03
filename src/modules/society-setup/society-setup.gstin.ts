import { UnprocessableError } from '../../utils/errors';
import { gstStateCode } from '../platform-billing/platform-billing.constants';

/** GSTIN rules of BR-08-2 (module 06 supplies the state codes). */
export const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The mod-36 check character for the first 14 characters of a GSTIN. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = ALPHABET.indexOf(first14[i]!);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36]!;
}

export const gstinChecksumOk = (gstin: string): boolean =>
  GSTIN_PATTERN.test(gstin) && gstinCheckChar(gstin.slice(0, 14)) === gstin[14];

/**
 * Throws the BR-08-2 error for the first failed check, in the order checksum, state, PAN. The shape (pattern) is checked by
 * the request schema; a GSTIN that does not even match the pattern is reported as a checksum failure here.
 */
export function assertGstin(gstin: string, state: string | null, pan: string | null): void {
  if (!gstinChecksumOk(gstin))
    throw new UnprocessableError('GSTIN_CHECKSUM_INVALID', 'The GSTIN check digit is wrong', [
      { field: 'gstin', message: 'Check the GSTIN: the last character does not match' },
    ]);
  const code = gstStateCode(state);
  if (!code || gstin.slice(0, 2) !== code)
    throw new UnprocessableError('GSTIN_STATE_MISMATCH', 'The GSTIN does not belong to the society state', [
      {
        field: 'gstin',
        message: `A GSTIN of ${state ?? 'this state'} starts with ${code ?? 'its state code'}`,
      },
    ]);
  if (pan && gstin.slice(2, 12) !== pan)
    throw new UnprocessableError('GSTIN_PAN_MISMATCH', 'The GSTIN does not contain the society PAN', [
      { field: 'gstin', message: 'Characters 3 to 12 of the GSTIN must be the PAN' },
    ]);
}
