/**
 * The business day a moment belongs to, as "YYYY-MM-DD".
 *
 * A restaurant's day is not the calendar's. A momo sold at 01:30 on Tuesday
 * belongs to Monday's trade, Monday's cash drawer and Monday's report - and if
 * the software disagrees, the owner's own totals will not reconcile with the
 * till. `RestaurantSettings.businessDayStartsAtMinutes` (04:00 by default) is
 * where the day rolls over, so anything before it counts as the previous date.
 *
 * Local time deliberately, not UTC: the boundary is 4am where the restaurant
 * stands. Nepal is UTC+05:45, so a UTC date would put every evening service
 * after 18:15 on the wrong day.
 */
export function resolveBusinessDate(
  now: Date,
  businessDayStartsAtMinutes: number,
  timeZone?: string | null,
): string {
  if (timeZone) return resolveZonedBusinessDate(now, businessDayStartsAtMinutes, timeZone);
  const minutesIntoDay = now.getHours() * 60 + now.getMinutes();
  const shifted = new Date(now);
  if (minutesIntoDay < businessDayStartsAtMinutes) {
    shifted.setDate(shifted.getDate() - 1);
  }
  return formatLocalDate(shifted);
}

/**
 * `toISOString()` would convert to UTC first and can shift the date by a day.
 * This formats the local calendar date the Date already holds.
 */
export function formatLocalDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = zonedFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    zonedFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * The business date in the restaurant's own time zone. A hosted server runs in
 * UTC, so reading the machine's clock would file a Kathmandu restaurant's
 * 01:00 sale under the wrong day; every tenant's day is computed from its own
 * configured IANA zone instead.
 */
function resolveZonedBusinessDate(
  now: Date,
  businessDayStartsAtMinutes: number,
  timeZone: string,
): string {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = zonedFormatter(timeZone);
  } catch {
    // An unknown zone name must not stop billing; fall back to the server clock.
    return resolveBusinessDate(now, businessDayStartsAtMinutes);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const year = Number(parts['year']);
  const month = Number(parts['month']);
  const day = Number(parts['day']);
  const minutesIntoDay = Number(parts['hour']) * 60 + Number(parts['minute']);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (minutesIntoDay < businessDayStartsAtMinutes) calendar.setUTCDate(calendar.getUTCDate() - 1);
  return calendar.toISOString().slice(0, 10);
}
