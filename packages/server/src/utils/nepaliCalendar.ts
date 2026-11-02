// An ambient declaration cannot be pulled in with `import`, which is what the
// lint rule would prefer; a triple-slash reference is the only mechanism.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../types/bikram-sambat.d.ts" />
// The reference above travels with this file. `bikram-sambat` ships no types,
// and this module is compiled from three different tsconfig projects (server,
// desktop main, verification scripts); a triple-slash reference makes the
// declaration available in all of them without each one knowing it exists.
import { toBik, toGreg } from 'bikram-sambat';

/**
 * The ONLY place Nayaro RMS talks to a Bikram Sambat library.
 *
 * Billing, invoicing and reporting import from here and never from
 * `bikram-sambat` directly. That matters because BS conversion is not a solved
 * problem the way Gregorian arithmetic is: month lengths are fixed by
 * published decision, not formula, so different libraries carry different
 * tables for future years. Keeping the dependency behind one adapter means a
 * correction later touches one file instead of the billing layer.
 *
 * WHAT WE VERIFIED (see scripts/verify-bootstrap.ts):
 *
 * Three independent libraries - bikram-sambat, nepali-datetime and
 * nepali-date-converter - were compared day by day. They agree on every day
 * from 2022 through 2027-06-14, and they agree on the Shrawan 1 fiscal-year
 * boundary for BS 2079 through 2085 and for 2087.
 *
 * They DISAGREE on BS 2086: bikram-sambat places Shrawan 1, 2086 on
 * 2029-07-16, while the other two place it on 2029-07-17. One of them is
 * wrong, and no amount of cross-checking libraries can settle it - only the
 * official Nepali calendar can.
 *
 * Consequence, stated plainly: invoice fiscal-year assignment is
 * independently corroborated through BS 2085 (mid-2028). Before then, the
 * Shrawan 1 dates for 2086 onward must be confirmed against the official
 * calendar. The risk is narrow - a single day, in 2029 - but it would put an
 * invoice in the wrong numbering series, so it is tracked rather than assumed.
 */

/** Shrawan. Nepali months are 1-indexed here: 1 Baishakh ... 3 Ashadh, 4 Shrawan. */
const FISCAL_YEAR_START_MONTH = 4;

/** Range bikram-sambat can actually convert; outside it we refuse rather than guess. */
const MIN_SUPPORTED_BS_YEAR = 1970;
const MAX_SUPPORTED_BS_YEAR = 2090;

/**
 * Boundary dates corroborated by three independent libraries.
 *
 * Used by the test suite to detect a silent change in the underlying library's
 * table. BS 2086 is deliberately absent: the libraries disagree, so there is
 * nothing here to assert against.
 */
export const CORROBORATED_FISCAL_YEAR_STARTS: ReadonlyMap<number, string> = new Map([
  [2079, '2022-07-17'],
  [2080, '2023-07-17'],
  [2081, '2024-07-16'],
  [2082, '2025-07-17'],
  [2083, '2026-07-17'],
  [2084, '2027-07-17'],
  [2085, '2028-07-16'],
]);

export interface BikramSambatDate {
  /** B.S. year, e.g. 2082. */
  readonly year: number;
  /** 1-indexed: 1 = Baishakh ... 12 = Chaitra. */
  readonly month: number;
  readonly day: number;
}

export class NepaliCalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NepaliCalendarError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Converts a local business date to Bikram Sambat.
 *
 * Takes a "YYYY-MM-DD" string, not a Date, on purpose. A business date is
 * already a local calendar day - the timezone question was settled when it was
 * computed. Passing a Date here would reopen it and invite an off-by-one at
 * 05:45.
 */
export function toBikramSambat(businessDate: string): BikramSambatDate {
  if (!ISO_DATE.test(businessDate)) {
    throw new NepaliCalendarError(
      `Expected a business date formatted YYYY-MM-DD, received "${businessDate}".`,
    );
  }

  let converted: { year: number; month: number; day: number };
  try {
    converted = toBik(businessDate);
  } catch {
    throw new NepaliCalendarError(
      `Cannot convert ${businessDate} to Bikram Sambat; it falls outside the supported range.`,
    );
  }

  if (converted.year < MIN_SUPPORTED_BS_YEAR || converted.year > MAX_SUPPORTED_BS_YEAR) {
    throw new NepaliCalendarError(
      `Bikram Sambat year ${String(converted.year)} is outside the supported range ` +
        `${String(MIN_SUPPORTED_BS_YEAR)}-${String(MAX_SUPPORTED_BS_YEAR)}.`,
    );
  }

  return converted;
}

/**
 * The authoritative fiscal-year integer for a business date.
 *
 * The Nepali fiscal year runs Shrawan 1 to the last day of Ashadh, so it spans
 * two B.S. years and is named by the first: a date in Shrawan 2082 through
 * Ashadh 2083 belongs to fiscal year 2082 (displayed "2082/83").
 *
 * Returns 2082, never "2082/83". One fiscal year, one representation - the
 * string form exists only for printing.
 */
export function resolveNepaliFiscalYear(businessDate: string): number {
  const bs = toBikramSambat(businessDate);
  return bs.month >= FISCAL_YEAR_START_MONTH ? bs.year : bs.year - 1;
}

/** Display form for receipts and reports: 2082 -> "2082/83". */
export function formatNepaliFiscalYear(fiscalYearStartBsYear: number): string {
  const endShort = String((fiscalYearStartBsYear + 1) % 100).padStart(2, '0');
  return `${String(fiscalYearStartBsYear)}/${endShort}`;
}

/** The Gregorian date on which a fiscal year begins (Shrawan 1). */
export function fiscalYearStartDate(fiscalYearStartBsYear: number): string {
  const g = toGreg(fiscalYearStartBsYear, FISCAL_YEAR_START_MONTH, 1);
  return `${String(g.year)}-${String(g.month).padStart(2, '0')}-${String(g.day).padStart(2, '0')}`;
}
