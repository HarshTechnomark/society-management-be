import type { HolidayType } from '../../models/holiday.model';

/**
 * Bundled suggestions for the holiday calendar (module 08 section 8.22), maintained per year for 2026 to 2028.
 * Fixed national days are exact. Lunar and religious dates are best-effort and MUST be verified every year before a
 * release (section 17); regional holidays per state are not bundled yet.
 */
export interface SuggestedHoliday {
  date: string;
  name: string;
  holidayType: HolidayType;
}

const fixed = (year: number): SuggestedHoliday[] => [
  { date: `${year}-01-26`, name: 'Republic Day', holidayType: 'NATIONAL' },
  { date: `${year}-08-15`, name: 'Independence Day', holidayType: 'NATIONAL' },
  { date: `${year}-10-02`, name: 'Gandhi Jayanti', holidayType: 'NATIONAL' },
  { date: `${year}-12-25`, name: 'Christmas', holidayType: 'FESTIVAL' },
];

const f = (date: string, name: string): SuggestedHoliday => ({ date, name, holidayType: 'FESTIVAL' });

export const HOLIDAY_SUGGESTIONS: Record<number, SuggestedHoliday[]> = {
  2026: [
    ...fixed(2026),
    f('2026-03-04', 'Holi'),
    f('2026-03-21', 'Eid-ul-Fitr'),
    f('2026-03-26', 'Ram Navami'),
    f('2026-04-03', 'Good Friday'),
    f('2026-05-27', 'Eid-ul-Adha (Bakrid)'),
    f('2026-09-14', 'Ganesh Chaturthi'),
    f('2026-10-20', 'Dussehra'),
    f('2026-11-08', 'Diwali (Lakshmi Puja)'),
  ],
  2027: [
    ...fixed(2027),
    f('2027-03-10', 'Eid-ul-Fitr'),
    f('2027-03-22', 'Holi'),
    f('2027-03-26', 'Good Friday'),
    f('2027-05-17', 'Eid-ul-Adha (Bakrid)'),
    f('2027-09-04', 'Ganesh Chaturthi'),
    f('2027-10-09', 'Dussehra'),
    f('2027-10-29', 'Diwali (Lakshmi Puja)'),
  ],
  2028: [
    ...fixed(2028),
    f('2028-02-26', 'Eid-ul-Fitr'),
    f('2028-03-11', 'Holi'),
    f('2028-04-14', 'Good Friday'),
    f('2028-05-05', 'Eid-ul-Adha (Bakrid)'),
    f('2028-08-25', 'Ganesh Chaturthi'),
    f('2028-09-28', 'Dussehra'),
    f('2028-10-17', 'Diwali (Lakshmi Puja)'),
  ],
};
