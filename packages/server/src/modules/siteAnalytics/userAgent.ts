/** Just enough user-agent parsing for analytics: device, browser and OS (same rules as nayaro.tech). */

const BOT =
  /bot|crawl|spider|slurp|mediapartners|preview|headless|lighthouse|pagespeed|facebookexternalhit|embedly|curl|wget|python|axios|node-fetch|go-http|java\/|httpclient|monitor|uptime/i;

export const isBot = (ua: string): boolean => ua === '' || BOT.test(ua);

export function parseUserAgent(ua: string): { device: string; browser: string; os: string } {
  const device = /ipad|tablet|(android(?!.*mobile))/i.test(ua)
    ? 'tablet'
    : /mobi|iphone|android/i.test(ua)
      ? 'mobile'
      : 'desktop';
  const browser = /edg\//i.test(ua)
    ? 'Edge'
    : /opr\/|opera/i.test(ua)
      ? 'Opera'
      : /samsungbrowser/i.test(ua)
        ? 'Samsung Internet'
        : /ucbrowser/i.test(ua)
          ? 'UC Browser'
          : /brave/i.test(ua)
            ? 'Brave'
            : /firefox|fxios/i.test(ua)
              ? 'Firefox'
              : /chrome|crios/i.test(ua)
                ? 'Chrome'
                : /safari/i.test(ua)
                  ? 'Safari'
                  : 'Other';
  const os = /windows/i.test(ua)
    ? 'Windows'
    : /iphone|ipad|ipod/i.test(ua)
      ? 'iOS'
      : /android/i.test(ua)
        ? 'Android'
        : /mac os x|macintosh/i.test(ua)
          ? 'macOS'
          : /cros/i.test(ua)
            ? 'ChromeOS'
            : /linux/i.test(ua)
              ? 'Linux'
              : 'Other';
  return { device, browser, os };
}
