import { NAYARO_BRAND, nayaroCopyright } from '@nayaro/shared';
import logoDark from '@/assets/brand/nayaro-lockup-dark.png';
import logoLight from '@/assets/brand/nayaro-lockup-light.png';
import mark from '@/assets/brand/nayaro-mark.svg';

/** Official, unmodified assets from nayaro.tech, bundled for offline use. */
export function NayaroLogo({
  compact = false,
  tone = 'dark',
  className = '',
}: {
  compact?: boolean;
  tone?: 'dark' | 'light';
  className?: string;
}) {
  return (
    <img
      src={compact ? mark : tone === 'dark' ? logoDark : logoLight}
      alt="Nayaro"
      width={compact ? 32 : 165}
      height={compact ? 32 : 30}
      className={className}
    />
  );
}

export function NayaroAttribution({ className = '' }: { className?: string }) {
  return (
    <div className={className}>
      <p>{NAYARO_BRAND.productAttribution}</p>
      <p className="mt-1 opacity-70">{nayaroCopyright()}</p>
    </div>
  );
}
