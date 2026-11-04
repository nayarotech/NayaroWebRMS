/**
 * Which country a visitor is in, without an IP database.
 *
 * nayaro.tech uses geoip-lite, but its data is ~115 MB held in memory - too
 * much for a 512 MB free instance. Instead, in order:
 *   1. a country header added by the host's edge (Cloudflare, Vercel), when present
 *   2. the browser's time zone, which is set by the device's location and is
 *      accurate at country level ("Asia/Tokyo" is Japan)
 *   3. the region in the browser's language ("ja-JP"), the weakest signal
 * No IP address is stored.
 */
const ZONE_COUNTRY: Readonly<Record<string, string>> = {
  'Asia/Kathmandu': 'NP',
  'Asia/Katmandu': 'NP',
  'Asia/Tokyo': 'JP',
  'Asia/Kolkata': 'IN',
  'Asia/Calcutta': 'IN',
  'Asia/Dhaka': 'BD',
  'Asia/Thimphu': 'BT',
  'Asia/Colombo': 'LK',
  'Asia/Karachi': 'PK',
  'Asia/Shanghai': 'CN',
  'Asia/Chongqing': 'CN',
  'Asia/Urumqi': 'CN',
  'Asia/Hong_Kong': 'HK',
  'Asia/Taipei': 'TW',
  'Asia/Seoul': 'KR',
  'Asia/Singapore': 'SG',
  'Asia/Kuala_Lumpur': 'MY',
  'Asia/Bangkok': 'TH',
  'Asia/Ho_Chi_Minh': 'VN',
  'Asia/Saigon': 'VN',
  'Asia/Jakarta': 'ID',
  'Asia/Manila': 'PH',
  'Asia/Dubai': 'AE',
  'Asia/Qatar': 'QA',
  'Asia/Riyadh': 'SA',
  'Asia/Kuwait': 'KW',
  'Asia/Bahrain': 'BH',
  'Asia/Muscat': 'OM',
  'Asia/Jerusalem': 'IL',
  'Asia/Tehran': 'IR',
  'Asia/Kabul': 'AF',
  'Asia/Yangon': 'MM',
  'Asia/Rangoon': 'MM',
  'Asia/Phnom_Penh': 'KH',
  'Asia/Vientiane': 'LA',
  'Asia/Ulaanbaatar': 'MN',
  'Asia/Almaty': 'KZ',
  'Asia/Tashkent': 'UZ',
  'Asia/Baku': 'AZ',
  'Asia/Tbilisi': 'GE',
  'Asia/Yerevan': 'AM',
  'Asia/Beirut': 'LB',
  'Asia/Amman': 'JO',
  'Asia/Baghdad': 'IQ',
  'Asia/Macau': 'MO',
  'Asia/Brunei': 'BN',
  'Indian/Maldives': 'MV',
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE',
  'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL',
  'Europe/Brussels': 'BE',
  'Europe/Zurich': 'CH',
  'Europe/Vienna': 'AT',
  'Europe/Stockholm': 'SE',
  'Europe/Oslo': 'NO',
  'Europe/Copenhagen': 'DK',
  'Europe/Helsinki': 'FI',
  'Europe/Warsaw': 'PL',
  'Europe/Prague': 'CZ',
  'Europe/Budapest': 'HU',
  'Europe/Lisbon': 'PT',
  'Europe/Athens': 'GR',
  'Europe/Istanbul': 'TR',
  'Europe/Moscow': 'RU',
  'Europe/Kiev': 'UA',
  'Europe/Kyiv': 'UA',
  'Europe/Bucharest': 'RO',
  'Europe/Sofia': 'BG',
  'Europe/Belgrade': 'RS',
  'Europe/Zagreb': 'HR',
  'Europe/Luxembourg': 'LU',
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Phoenix': 'US',
  'America/Los_Angeles': 'US',
  'America/Anchorage': 'US',
  'Pacific/Honolulu': 'US',
  'America/Detroit': 'US',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA',
  'America/Halifax': 'CA',
  'America/Mexico_City': 'MX',
  'America/Sao_Paulo': 'BR',
  'America/Argentina/Buenos_Aires': 'AR',
  'America/Bogota': 'CO',
  'America/Lima': 'PE',
  'America/Santiago': 'CL',
  'America/Caracas': 'VE',
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU',
  'Australia/Adelaide': 'AU',
  'Australia/Hobart': 'AU',
  'Australia/Darwin': 'AU',
  'Pacific/Auckland': 'NZ',
  'Africa/Cairo': 'EG',
  'Africa/Johannesburg': 'ZA',
  'Africa/Lagos': 'NG',
  'Africa/Nairobi': 'KE',
  'Africa/Casablanca': 'MA',
  'Africa/Accra': 'GH',
  'Africa/Addis_Ababa': 'ET',
};

export function resolveCountry(input: {
  readonly header: string | undefined;
  readonly timeZone: string | null;
  readonly language: string | null;
}): string | null {
  const header = input.header?.trim().toUpperCase();
  if (header && /^[A-Z]{2}$/.test(header) && header !== 'XX' && header !== 'T1') return header;
  if (input.timeZone !== null) {
    const zone = ZONE_COUNTRY[input.timeZone];
    if (zone !== undefined) return zone;
  }
  const region = input.language?.match(/[-_]([A-Za-z]{2})$/)?.[1];
  return region === undefined ? null : region.toUpperCase();
}
