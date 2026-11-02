/**
 * Turns what somebody wants a QR code to DO into the string it has to contain.
 *
 * These formats are conventions phone cameras recognise, not standards anyone
 * publishes - which is exactly why they belong in one file with their quirks
 * written down, rather than being assembled inline wherever a code is drawn.
 */

export type QrPurpose = 'LINK' | 'WIFI' | 'PHONE' | 'TEXT';

export type WifiSecurity = 'WPA' | 'WEP' | 'NONE';

export interface WifiCredentials {
  readonly ssid: string;
  readonly password: string;
  readonly security: WifiSecurity;
  /** A network that does not broadcast its name. Rare, and easy to get wrong. */
  readonly hidden: boolean;
}

/**
 * The WIFI: format, as implemented by iOS and Android cameras.
 *
 * ESCAPING IS THE WHOLE JOB. The format is colon- and semicolon-delimited with
 * no quoting, so a password containing `;` or `:` - or a cafe SSID with a
 * comma in it - silently produces a code that scans and then fails to join,
 * with no clue as to why. Backslash-escaping the five reserved characters is
 * what the readers expect.
 */
export function wifiPayload(credentials: WifiCredentials): string {
  const escape = (value: string): string => value.replace(/([\\;,:"])/g, '\\$1');

  const parts = [
    `T:${credentials.security}`,
    `S:${escape(credentials.ssid)}`,
    // An open network carries no P field at all. An empty one makes some
    // Android readers prompt for a password that does not exist.
    credentials.security === 'NONE' ? null : `P:${escape(credentials.password)}`,
    credentials.hidden ? 'H:true' : null,
  ].filter((part): part is string => part !== null);

  return `WIFI:${parts.join(';')};;`;
}

/**
 * A link, with the scheme filled in when it is missing.
 *
 * Someone typing their menu address into a settings box writes
 * "nayaro.com/menu", and a QR code containing that opens nothing on most
 * phones - the camera treats a scheme-less string as plain text. Assuming
 * https is the only useful reading of what they meant.
 */
export function linkPayload(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** `tel:` so a scan offers to dial rather than showing digits to copy out. */
export function phonePayload(number: string): string {
  // Readers want digits and a leading +; spaces and dashes break some of them.
  const cleaned = number.replace(/[^\d+]/g, '');
  return cleaned.length === 0 ? '' : `tel:${cleaned}`;
}

export function buildQrPayload(
  purpose: QrPurpose,
  input: { readonly text: string; readonly wifi: WifiCredentials },
): string {
  switch (purpose) {
    case 'WIFI':
      return input.wifi.ssid.trim().length === 0 ? '' : wifiPayload(input.wifi);
    case 'LINK':
      return linkPayload(input.text);
    case 'PHONE':
      return phonePayload(input.text);
    case 'TEXT':
      return input.text.trim();
  }
}

export const QR_PURPOSE_LABELS: Readonly<
  Record<QrPurpose, { label: string; blurb: string; placeholder: string }>
> = {
  LINK: {
    label: 'Link',
    blurb: 'An online menu, a review page, a Facebook page — anything with a web address.',
    placeholder: 'nayaro.com/menu',
  },
  WIFI: {
    label: 'Wi-Fi',
    blurb: 'Guests join the network by scanning, without being read the password across the room.',
    placeholder: '',
  },
  PHONE: {
    label: 'Phone',
    blurb: 'A scan offers to call. Useful on a takeaway counter card.',
    placeholder: '+977 98XXXXXXXX',
  },
  TEXT: {
    label: 'Plain text',
    blurb: 'Anything else. The scan shows exactly what you type, and nothing opens.',
    placeholder: 'Wi-Fi password: guest123',
  },
};
