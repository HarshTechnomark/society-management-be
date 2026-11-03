import { Op, type Transaction } from 'sequelize';
import { CommitteeTerm } from '../../models';
import { termLengthProblem, rangesOverlap, type TermRange } from './committee.planner';
import { rule, type CommitteeSettings } from './committee.shared';

/** The term-level rules of BR-10-2 and BR-10-3 that need the database (other terms of the society). */
const datesInvalid = (message: string, field = 'endDate') =>
  rule('COMMITTEE_TERM_DATES_INVALID', message, field);

export interface DateRuleOptions {
  /** Create or edit of a draft: its start must be later than the current term's start. */
  draft?: boolean;
  /** A past committee (F13): must end before today and before every non-historical term, without overlapping another. */
  historical?: boolean;
  exceptId?: number;
  today: string;
  maxTermYears: number;
  t?: Transaction;
}

/** BR-10-2. Throws `422 COMMITTEE_TERM_DATES_INVALID`. */
export async function assertTermDates(societyId: number, r: TermRange, o: DateRuleOptions): Promise<void> {
  const problem = termLengthProblem(r, o.maxTermYears);
  if (problem) throw datesInvalid(problem);
  const others = { societyId, ...(o.exceptId ? { id: { [Op.ne]: o.exceptId } } : {}) };
  if (o.draft) {
    const current = await CommitteeTerm.findOne({
      where: { ...others, status: { [Op.in]: ['ACTIVE', 'EXPIRED'] } },
      attributes: ['startDate'],
      transaction: o.t,
    });
    if (current && r.startDate <= current.startDate)
      throw datesInvalid('The new committee must start after the current committee started', 'startDate');
  }
  if (o.historical) {
    if (r.endDate >= o.today) throw datesInvalid('A past committee must have ended before today');
    const live = await CommitteeTerm.findAll({
      where: others,
      attributes: ['source', 'startDate', 'endDate'],
      transaction: o.t,
    });
    const later = live
      .filter(x => x.source !== 'HISTORICAL')
      .map(x => x.startDate)
      .sort()[0];
    if (later && r.endDate >= later)
      throw datesInvalid('A past committee must end before the first recorded committee started');
    if (live.some(x => x.source === 'HISTORICAL' && rangesOverlap(r, x)))
      throw datesInvalid('This period overlaps another past committee');
  }
}

/** BR-10-3: `strength` within the society's range. */
export function assertStrengthRange(strength: number, cfg: CommitteeSettings): void {
  if (strength < cfg.minStrength || strength > cfg.maxStrength)
    throw rule(
      'COMMITTEE_STRENGTH_INVALID',
      `The strength must be between ${cfg.minStrength} and ${cfg.maxStrength}`,
      'strength',
    );
}
