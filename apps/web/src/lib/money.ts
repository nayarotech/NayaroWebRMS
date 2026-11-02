/**
 * Money is integer paisa everywhere in Nayaro RMS - in the database, on the
 * wire and in these helpers. It becomes a decimal string exactly once: here,
 * at the moment it is displayed.
 *
 * Never do arithmetic on the formatted value. 220.10 + 0.20 in floating point
 * is 220.29999999999998, and a bill that is one paisa short of itself is a bug
 * the owner finds at closing time, not the developer.
 *
 * en-IN grouping on purpose: Nepal uses the lakh/crore system, so 1,00,000
 * reads correctly to the person holding the till, and 100,000 does not.
 */
export function formatPaisa(paisa: number): string {
  return `₨ ${(paisa / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Rupee input -> integer paisa, or null for anything unparseable or negative.
 * Rounded, not truncated: 84.5 * 100 lands on 8449.999... often enough to matter.
 */
export function parseRupees(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** Short axis label: "₨ 12.5k", "₨ 1.2L" (lakh) for large sums. */
export function formatCompactPaisa(paisa: number): string {
  const rupees = paisa / 100;
  if (rupees >= 100_000) return `₨ ${(rupees / 100_000).toFixed(rupees >= 1_000_000 ? 0 : 1)}L`;
  if (rupees >= 1000) return `₨ ${(rupees / 1000).toFixed(rupees >= 10_000 ? 0 : 1)}k`;
  return `₨ ${Math.round(rupees).toString()}`;
}

/** Whole rupees for headline figures, e.g. "₨ 46,528". */
export function formatRupees(paisa: number): string {
  return `₨ ${Math.round(paisa / 100).toLocaleString('en-IN')}`;
}
