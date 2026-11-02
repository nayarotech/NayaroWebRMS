/** Product ownership, shared by the desktop and staff phone interfaces. */
export const NAYARO_BRAND = {
  companyName: 'Nayaro Technology',
  productName: 'Nayaro RMS',
  productAttribution: 'Product by Nayaro Technology',
  website: 'https://nayaro.tech',
} as const;

export function nayaroCopyright(year = new Date().getFullYear()): string {
  return `© ${year} ${NAYARO_BRAND.companyName}`;
}
