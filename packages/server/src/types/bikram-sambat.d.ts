/**
 * Type declarations for `bikram-sambat`, which ships none.
 *
 * Deliberately narrow: only the three functions our calendar adapter uses are
 * declared. If billing ever needs more, it goes through
 * src/utils/nepaliCalendar.ts and gets added here - not imported directly.
 *
 * Months are 1-indexed: 1 = Baishakh ... 3 = Ashadh, 4 = Shrawan ... 12 = Chaitra.
 */
declare module 'bikram-sambat' {
  export interface CalendarDate {
    year: number;
    month: number;
    day: number;
  }

  /** Gregorian "YYYY-MM-DD" -> Bikram Sambat. Throws outside the supported range. */
  export function toBik(gregorianIsoDate: string): CalendarDate;

  /** Bikram Sambat -> Gregorian. Throws outside the supported range. */
  export function toGreg(year: number, month: number, day: number): CalendarDate;

  /** Number of days in a given B.S. month (varies by year; from a published table). */
  export function daysInMonth(year: number, month: number): number;
}
