import type { JSX, ReactNode } from 'react';
import { BarChart3, ChefHat, ReceiptText, ShieldCheck } from 'lucide-react';
import { NayaroAttribution, NayaroLogo } from './NayaroBrand';

const HIGHLIGHTS = [
  { icon: ReceiptText, text: 'Fast table and takeaway billing with VAT-ready invoices' },
  { icon: ChefHat, text: 'Live kitchen tickets on any screen in the restaurant' },
  { icon: BarChart3, text: 'Daily sales, stock and cash reports in one place' },
  { icon: ShieldCheck, text: 'Each restaurant’s data kept private to its own team' },
];

/** Sign-in and registration: brand panel beside the form, stacked on small screens. */
export function AuthLayout({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="bg-base grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <aside className="bg-navy relative hidden flex-col justify-between overflow-hidden p-12 text-white lg:flex">
        <div className="relative">
          <NayaroLogo className="h-auto w-[150px]" />
          <h2 className="mt-14 max-w-md text-[2rem] leading-tight font-extrabold tracking-tight">
            Run every shift from one place.
          </h2>
          <p className="mt-3 max-w-md text-body text-white/65">
            Nayaro RMS brings the floor, the kitchen, the till and the back office together, in the
            browser.
          </p>
          <ul className="mt-10 space-y-4">
            {HIGHLIGHTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-body text-white/80">
                <span className="grid size-9 shrink-0 place-items-center rounded-control bg-white/8">
                  <Icon size={18} aria-hidden />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <NayaroAttribution className="relative text-caption text-white/45" />
      </aside>

      <main className="flex flex-col px-5 py-8 sm:px-10">
        <div className="mb-8 lg:hidden">
          <NayaroLogo tone="light" className="h-auto w-[130px] dark:hidden" />
          <NayaroLogo className="hidden h-auto w-[130px] dark:block" />
        </div>
        <div className="mx-auto my-auto w-full max-w-[440px]">{children}</div>
      </main>
    </div>
  );
}
