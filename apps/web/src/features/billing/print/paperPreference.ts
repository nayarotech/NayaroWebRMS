import { BILL_PAPER_SPECS, type BillPaperSize, type BillPaperSpec } from '@nayaro/shared';

/**
 * Which paper THIS till prints on.
 *
 * Kept in localStorage rather than RestaurantSettings, and that is a modelling
 * decision rather than a shortcut. The paper is a property of the printer
 * plugged into this machine: a counter with an 80mm thermal roll and a back
 * office with an A4 laser are the same restaurant, and a single server-side
 * setting would make them fight over it. It is also the kind of thing someone
 * sets once when the printer arrives and never touches again, which is exactly
 * what a per-machine preference is for.
 *
 * Every access is defensive. A locked-down profile makes localStorage throw
 * rather than return null, and a cashier who cannot print because storage is
 * unavailable would be a bad trade for remembering a dropdown.
 */

const STORAGE_KEY = 'nayaro.bill.paper';

export const DEFAULT_PAPER_SIZE: BillPaperSize = 'THERMAL_80';

export function paperSpec(size: BillPaperSize): BillPaperSpec {
  // The catalogue is a non-empty literal, but `find` cannot know that.
  return BILL_PAPER_SPECS.find((spec) => spec.id === size) ?? BILL_PAPER_SPECS[0]!;
}

export function readPaperPreference(): BillPaperSize {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_PAPER_SIZE;
  }
  // Validated against the catalogue, never trusted: a stored value from an
  // older build could name a paper size that no longer exists.
  return BILL_PAPER_SPECS.some((spec) => spec.id === raw)
    ? (raw as BillPaperSize)
    : DEFAULT_PAPER_SIZE;
}

export function writePaperPreference(size: BillPaperSize): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, size);
  } catch {
    // The choice still applies to this print; it just will not be remembered.
  }
}
