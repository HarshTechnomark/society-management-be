import type { ChargeHead } from '../../models';
import { formatRupees } from '../../lib/money';
import { UnprocessableError } from '../../utils/errors';
import { gstOf, roundOffOf } from './billing.calc.gst';
import type { LineKind } from './billing.constants';

/**
 * Pure builder of the lines of a document that is created at once (ad-hoc invoice, debit note): GST per BR-11-31, CGST and
 * SGST lines, round-off per BR-11-4. No database access; `billing.invoices.adhoc.ts` and `billing.notes.debit.ts` call it.
 */
export interface DocLineInput {
  head: Pick<
    ChargeHead,
    | 'id'
    | 'key'
    | 'gstTreatment'
    | 'sacCode'
    | 'ledgerAccountCode'
    | 'interestBearing'
    | 'headType'
    | 'fundId'
  >;
  description: string;
  amountPaise: number;
  kind?: 'CHARGE' | 'INTEREST' | 'LATE_FEE';
  fundId?: number | null;
}

export interface BuiltLine {
  lineKind: LineKind;
  chargeHeadId: number | null;
  headKey: string | null;
  description: string;
  amountPaise: number;
  isTaxable: boolean;
  ledgerAccountCode: string;
  fundId: number | null;
  interestBearing: boolean;
}

export interface BuiltDocument {
  lines: BuiltLine[];
  subtotalPaise: number;
  taxableValuePaise: number;
  thresholdBasePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  gstApplied: boolean;
}

export interface BuildOptions {
  applyGst: boolean;
  /** Per month, paise (`billing.gstExemptLimitPerUnitPaise`). */
  exemptLimitPaise: number;
  roundToRupee: boolean;
  /**
   * `ADHOC`: THRESHOLD heads are tested on this document alone as one month. `DEBIT`: THRESHOLD and FOLLOW_SOURCE heads follow
   * the parent invoice (`parentGstApplied`).
   */
  mode: 'ADHOC' | 'DEBIT';
  parentGstApplied?: boolean;
}

export function buildDocument(input: DocLineInput[], o: BuildOptions): BuiltDocument {
  const thresholdBase = input
    .filter(l => l.head.gstTreatment === 'THRESHOLD')
    .reduce((a, l) => a + l.amountPaise, 0);
  const taxedFor = (l: DocLineInput): boolean => {
    switch (l.head.gstTreatment) {
      case 'ALWAYS':
        return o.applyGst;
      case 'THRESHOLD':
        return o.mode === 'DEBIT'
          ? Boolean(o.parentGstApplied)
          : o.applyGst && thresholdBase > o.exemptLimitPaise;
      case 'FOLLOW_SOURCE':
        return o.mode === 'DEBIT' && Boolean(o.parentGstApplied);
      default:
        return false;
    }
  };
  const lines: BuiltLine[] = input.map(l => {
    const taxed = taxedFor(l);
    if (taxed && !l.head.sacCode)
      throw new UnprocessableError('GST_SETTINGS_INVALID', 'A taxed charge head has no SAC code', [
        { field: 'chargeHeadId', message: `Head ${l.head.key} needs a SAC code before it can be taxed` },
      ]);
    return {
      lineKind: l.kind ?? 'CHARGE',
      chargeHeadId: Number(l.head.id),
      headKey: l.head.key,
      description: l.description,
      amountPaise: l.amountPaise,
      isTaxable: taxed,
      ledgerAccountCode: l.head.ledgerAccountCode,
      fundId: l.fundId ?? l.head.fundId ?? null,
      interestBearing: Boolean(l.head.interestBearing),
    };
  });
  const subtotal = lines.reduce((a, l) => a + l.amountPaise, 0);
  const taxable = lines.filter(l => l.isTaxable).reduce((a, l) => a + l.amountPaise, 0);
  const { cgstPaise, sgstPaise } = gstOf(taxable);
  const tax = cgstPaise + sgstPaise;
  const roundOff = roundOffOf(subtotal + tax, o.roundToRupee);
  const out = [...lines];
  const tail = (kind: LineKind, description: string, amountPaise: number, code: string) =>
    out.push({
      lineKind: kind,
      chargeHeadId: null,
      headKey: null,
      description,
      amountPaise,
      isTaxable: false,
      ledgerAccountCode: code,
      fundId: null,
      interestBearing: false,
    });
  if (tax > 0) {
    tail('CGST', `CGST 9% on ${formatRupees(taxable)}`, cgstPaise, '2310');
    tail('SGST', `SGST 9% on ${formatRupees(taxable)}`, sgstPaise, '2320');
  }
  if (roundOff !== 0) tail('ROUND_OFF', 'Round off', roundOff, '4990');
  return {
    lines: out,
    subtotalPaise: subtotal,
    taxableValuePaise: taxable,
    thresholdBasePaise: thresholdBase,
    cgstPaise,
    sgstPaise,
    roundOffPaise: roundOff,
    totalPaise: subtotal + tax + roundOff,
    gstApplied: tax > 0,
  };
}

/** BR-11-47: a line counts toward `nonInterestBearingPaise` when it is interest, a late fee or a charge of a non-interest head. */
export const isNonInterestBearing = (l: Pick<BuiltLine, 'lineKind' | 'interestBearing'>): boolean =>
  l.lineKind === 'INTEREST' || l.lineKind === 'LATE_FEE' || (l.lineKind === 'CHARGE' && !l.interestBearing);
