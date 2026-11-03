import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ArrowRight,
  BookOpen,
  ChefHat,
  Check,
  ClipboardList,
  Grid3x3,
  HandCoins,
  History,
  Lock,
  Package,
  QrCode,
  ReceiptText,
  RefreshCcw,
  ShieldCheck,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { NAYARO_BRAND, nayaroCopyright } from '@nayaro/shared';
import logoOnDark from '@/assets/brand/nayaro-lockup-dark.png';
import logoOnLight from '@/assets/brand/nayaro-lockup-light.png';
import { cn } from '@/lib/utils';

/**
 * The public front door at "/", in the same family as flow.nayaro.tech and
 * games.nayaro.tech: navy hero with the brand diagonal, Archivo headlines,
 * mono eyebrows, and a product mock that shows the real thing rather than a
 * stock photo. Signed-in staff never see it - PublicRoute sends them to work.
 *
 * Every claim here is something the product does today. A landing page that
 * promises an integration the till does not have is a support ticket waiting
 * to happen.
 */
export function LandingScreen(): JSX.Element {
  return (
    <div className="bg-surface text-text min-h-dvh">
      <Hero />
      <MadeFor />
      <HowItWorks />
      <Features />
      <Roles />
      <YourData />
      <Pricing />
      <Faq />
      <Cta />
      <Footer />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brand pieces
// ---------------------------------------------------------------------------

function Lockup({ onDark = false, className = 'h-6' }: { onDark?: boolean; className?: string }): JSX.Element {
  return (
    <span className="inline-flex items-center gap-2.5">
      <img src={onDark ? logoOnDark : logoOnLight} alt="Nayaro" className={cn(className, 'w-auto')} />
      <span
        className={cn(
          'rounded border px-1.5 py-1 font-mono text-[10px] leading-none tracking-[0.18em] uppercase',
          onDark ? 'border-white/35 text-white' : 'border-accent/40 text-accent',
        )}
      >
        RMS
      </span>
    </span>
  );
}

function Eyebrow({ children, onDark = false }: { children: ReactNode; onDark?: boolean }): JSX.Element {
  return (
    <p
      className={cn(
        'font-mono text-[11px] font-semibold tracking-[0.2em] uppercase',
        onDark ? 'text-[#6189ff]' : 'text-accent',
      )}
    >
      {children}
    </p>
  );
}

function SectionHeading({
  eyebrow,
  title,
  lead,
  onDark = false,
}: {
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  onDark?: boolean;
}): JSX.Element {
  return (
    <div className="max-w-3xl">
      <Eyebrow onDark={onDark}>{eyebrow}</Eyebrow>
      <h2
        className={cn(
          'font-display mt-3 text-[30px] leading-[1.12] font-bold tracking-tight sm:text-[40px]',
          onDark && 'text-white',
        )}
      >
        {title}
      </h2>
      {lead !== undefined && (
        <p className={cn('mt-4 text-[17px] leading-relaxed', onDark ? 'text-slate-300' : 'text-muted')}>{lead}</p>
      )}
    </div>
  );
}

const container = 'mx-auto w-full max-w-6xl px-4 sm:px-6';

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function Hero(): JSX.Element {
  return (
    <section className="relative overflow-hidden bg-[#0a0e17] text-white">
      <div aria-hidden className="ny-diagonal-dark absolute inset-0" />
      <div
        aria-hidden
        className="from-accent/25 via-accent/10 absolute top-0 -right-40 h-[140%] w-[260px] origin-top rotate-[-32deg] bg-gradient-to-b to-transparent sm:-right-10"
      />

      <header className="relative z-10">
        <div className={cn(container, 'flex h-[72px] items-center justify-between')}>
          <a href="#top" aria-label="Nayaro RMS home">
            <Lockup onDark className="h-5 sm:h-6" />
          </a>
          <nav aria-label="Sections" className="hidden items-center gap-8 text-sm text-slate-300 md:flex">
            <a href="#how" className="hover:text-white">
              How it works
            </a>
            <a href="#features" className="hover:text-white">
              Features
            </a>
            <a href="#pricing" className="hover:text-white">
              Pricing
            </a>
            <a href="#faq" className="hover:text-white">
              FAQ
            </a>
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/login" className="rounded-md px-3 py-2 text-sm font-semibold text-slate-200 hover:text-white">
              Log in
            </Link>
            <Link
              to="/register"
              className="bg-accent hover:bg-accent-hover hidden rounded-md px-4 py-2 text-sm font-bold text-white sm:inline-flex"
            >
              Start free trial
            </Link>
          </div>
        </div>
      </header>

      <div
        id="top"
        className={cn(container, 'relative grid items-center gap-14 pt-10 pb-20 lg:grid-cols-[1.05fr_1fr] lg:pt-16 lg:pb-28')}
      >
        <div>
          <Eyebrow onDark>Restaurant POS · Nepal</Eyebrow>
          <h1 className="font-display mt-5 text-[40px] leading-[1.05] font-bold tracking-tight sm:text-6xl">
            Every table.
            <br />
            <span className="text-[#6189ff]">Every bill.</span>
            <br />
            One screen.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-300">
            Nayaro RMS runs your floor, kitchen and counter together - orders go straight to the kitchen, bills come out
            with VAT and service charge done, and the day closes itself with a report you can trust.
          </p>
          <p className="mt-2 text-[15px] text-slate-400">टेबलदेखि बिलसम्म — सबै काम एउटै ठाउँमा।</p>

          <div className="mt-9 flex flex-wrap gap-3">
            <Link
              to="/register"
              className="bg-accent hover:bg-accent-hover inline-flex items-center gap-2 rounded-md px-6 py-3.5 text-base font-bold text-white"
            >
              Start 14-day free trial <ArrowRight size={18} aria-hidden />
            </Link>
            <a
              href="#how"
              className="inline-flex items-center rounded-md border border-white/25 px-6 py-3.5 text-base font-bold text-white hover:bg-white/5"
            >
              See how it works
            </a>
          </div>

          <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[15px] text-slate-300">
            {['No card needed', 'English & नेपाली menu', 'Works on any device'].map((item) => (
              <li key={item} className="flex items-center gap-2">
                <Check size={16} className="text-[#6189ff]" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <HeroMock />
      </div>
    </section>
  );
}

const MOCK_TABLES = [
  { name: 'T1', status: 'Occupied', tone: 'border-status-occupied/50 bg-status-occupied/10 text-status-occupied' },
  { name: 'T2', status: 'Preparing', tone: 'border-status-preparing/50 bg-status-preparing/10 text-status-preparing' },
  { name: 'T3', status: 'Available', tone: 'border-slate-200 bg-white text-slate-500' },
  { name: 'T4', status: 'Ready', tone: 'border-status-ready/50 bg-status-ready/10 text-status-ready' },
  { name: 'T5', status: 'Payment', tone: 'border-status-payment/50 bg-status-payment/10 text-status-payment' },
  { name: 'T6', status: 'Available', tone: 'border-slate-200 bg-white text-slate-500' },
] as const;

/** A small, honest picture of the product: the floor plan and a settled bill. */
function HeroMock(): JSX.Element {
  return (
    <div className="relative mx-auto w-full max-w-[520px] sm:pb-44" aria-hidden>
      <div className="rounded-[22px] border border-white/15 bg-white/5 p-2.5">
        <div className="rounded-[16px] bg-white p-5 text-slate-900">
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-[15px] font-bold">Himalayan Kitchen</p>
              <p className="text-accent font-mono text-[10px] tracking-[0.18em] uppercase">Floor plan · Main hall</p>
            </div>
            <span className="text-[11px] font-semibold text-slate-500">5 of 6 in use</span>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2.5">
            {MOCK_TABLES.map((table) => (
              <div key={table.name} className={cn('rounded-xl border px-3 py-2.5', table.tone)}>
                <p className="text-[15px] font-extrabold text-slate-900">{table.name}</p>
                <p className="mt-3 flex items-center gap-1.5 text-[11px] font-bold">
                  <span className="size-1.5 rounded-full bg-current" />
                  {table.status}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-[11.5px] text-slate-600">
            <ChefHat size={14} className="text-status-preparing" />
            KOT #187 sent to the kitchen · 2 × Chicken Momo
          </div>
        </div>
      </div>

      <div className="relative -mt-10 ml-auto w-[290px] rounded-2xl bg-white p-5 text-slate-900 shadow-[0_24px_64px_rgb(0_0_0/0.45)] sm:absolute sm:right-0 sm:bottom-0 sm:mt-0 lg:-right-6">
        <div className="flex items-center justify-between">
          <p className="font-mono text-[10px] tracking-[0.18em] text-slate-500 uppercase">Tax invoice</p>
          <span className="bg-accent/10 text-accent rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold">#182</span>
        </div>
        <p className="mt-2 text-[20px] font-bold">T4 · ₨ 671.00</p>
        <p className="text-accent font-mono text-[11px]">FY 2083/84 · Paid by cash</p>
        <ul className="mt-4 space-y-2 border-t border-slate-200 pt-4 text-[12.5px]">
          {[
            ['Service charge 10%', '₨ 54.00'],
            ['VAT 13%', '₨ 77.22'],
            ['Change given', '₨ 329.00'],
            ['Table T4', 'Free'],
          ].map(([label, value]) => (
            <li key={label} className="flex items-center gap-2">
              <span className="bg-status-ready grid size-4 place-items-center rounded-full text-white">
                <Check size={10} strokeWidth={3} />
              </span>
              <span className="flex-1">{label}</span>
              <span className="text-slate-500">{value}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function MadeFor(): JSX.Element {
  return (
    <section className="border-border bg-surface-2 border-b">
      <div className={cn(container, 'flex flex-col gap-4 py-6 lg:flex-row lg:items-center lg:justify-between')}>
        <p className="text-muted text-[15px]">Made for every kind of kitchen</p>
        <ul className="flex flex-wrap gap-2">
          {['Restaurants', 'Cafés', 'Momo & khaja ghar', 'Bars & lounges', 'Hotel restaurants', 'Cloud kitchens'].map(
            (kind) => (
              <li key={kind} className="border-border-3 bg-surface rounded-full border px-3.5 py-1.5 text-[14px]">
                {kind}
              </li>
            ),
          )}
        </ul>
      </div>
    </section>
  );
}

const STEPS = [
  {
    title: 'Seat a table',
    body: 'Tap a table on the floor plan or start a takeaway at the counter. Waiters, cashiers and managers all see the same live board.',
    tag: 'T4 · 4 seats',
  },
  {
    title: 'Send to the kitchen',
    body: 'Tap Send and the ticket is on the kitchen screen at once - no slips to lose - with a timer and a "food ready" chime.',
    tag: 'KOT #187 → Kitchen',
  },
  {
    title: 'Bill and get paid',
    body: 'Tax invoice with VAT, service charge and rounding worked out. Cash with change, QR, card, credit - or split between them.',
    tag: 'Cash · QR · Card · Credit',
  },
  {
    title: 'Close the day',
    body: 'Count the drawer, print the Z report and see every discount, void and cancellation - with who did it and why.',
    tag: 'Z report · 2083/84',
  },
] as const;

function HowItWorks(): JSX.Element {
  return (
    <section id="how" className="scroll-mt-4 py-20 sm:py-24">
      <div className={container}>
        <SectionHeading
          eyebrow="How it works"
          title={
            <>
              From the first order to the last bill,
              <br className="hidden sm:block" /> without paper.
            </>
          }
          lead="Today it is order pads, a shouted kitchen, a calculator at the counter and a notebook at closing. Nayaro RMS joins them into one flow every station shares."
        />
        <ol className="border-border mt-12 grid overflow-hidden rounded-card border sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li
              key={step.title}
              className="border-border flex flex-col border-b p-6 last:border-b-0 sm:[&:nth-child(odd)]:border-r lg:border-r lg:border-b-0 lg:last:border-r-0"
            >
              <span className="text-accent font-mono text-[13px]">{String(index + 1).padStart(2, '0')}</span>
              <h3 className="mt-4 text-[17px] font-bold">{step.title}</h3>
              <p className="text-muted mt-2 flex-1 text-[15px] leading-relaxed">{step.body}</p>
              <span className="bg-surface-2 text-text-3 mt-6 rounded-md px-2.5 py-1.5 font-mono text-[12px]">
                {step.tag}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const FEATURES: readonly { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Grid3x3,
    title: 'Live floor plan',
    body: 'Areas and tables coloured by what they need: seated, cooking, ready to serve, waiting to pay. Move a party to another table in one tap.',
  },
  {
    icon: ChefHat,
    title: 'Kitchen screen',
    body: 'Tickets in order with timers, notes like “no onion”, and a chime when food is ready. Late tickets turn red before anyone has to shout.',
  },
  {
    icon: ReceiptText,
    title: 'Tax invoices that add up',
    body: 'VAT, service charge, discounts and rounding calculated to the paisa, numbered by Nepali fiscal year, with buyer name and PAN.',
  },
  {
    icon: HandCoins,
    title: 'Split, credit and refunds',
    body: 'Split a bill by amount or by item, put regulars on credit with statements and repayments, and refund properly - never by deleting.',
  },
  {
    icon: BookOpen,
    title: 'Menu, set menus and offers',
    body: 'Bilingual menu, fixed combos and scheduled offers like happy hour. Mark a dish sold out and it disappears from every till.',
  },
  {
    icon: Package,
    title: 'Inventory by recipe',
    body: 'Each sale deducts its ingredients. Low stock is flagged on the dashboard, and dishes you cannot make are hidden automatically.',
  },
  {
    icon: QrCode,
    title: 'Guest QR menu',
    body: 'Print a QR card for every table. Guests see today’s menu and prices on their phone - always current, never a PDF.',
  },
  {
    icon: ClipboardList,
    title: 'End of day and reports',
    body: 'Sales, payments, top dishes, the drawer against what was counted, and fourteen days of trends for the owner at home.',
  },
  {
    icon: UsersRound,
    title: 'Staff, payroll and loyalty',
    body: 'Accounts per role, monthly salaries and advances, and loyalty points that customers earn and redeem at the counter.',
  },
];

function Features(): JSX.Element {
  return (
    <section id="features" className="border-border bg-surface-2 scroll-mt-4 border-y py-20 sm:py-24">
      <div className={container}>
        <SectionHeading
          eyebrow="Features"
          title="Everything the restaurant does, in one place."
          lead="No separate billing software, kitchen printer app, stock spreadsheet and salary notebook. One login per person, the same numbers everywhere."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <article key={title} className="border-border bg-surface rounded-card border p-6">
              <span className="bg-accent-soft text-accent-hover grid size-10 place-items-center rounded-control">
                <Icon size={19} aria-hidden />
              </span>
              <h3 className="mt-5 text-[17px] font-bold">{title}</h3>
              <p className="text-muted mt-2 text-[15px] leading-relaxed">{body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

const ROLES = [
  { role: 'Owner', sees: 'Dashboard, reports, payroll and every setting - from home.' },
  { role: 'Manager', sees: 'Menu, stock, staff, discounts and corrections.' },
  { role: 'Cashier', sees: 'Tables, bills, payments, drawer and customer credit.' },
  { role: 'Waiter', sees: 'Tables and orders - everything except taking money.' },
  { role: 'Kitchen', sees: 'The ticket board and dish availability. Nothing else.' },
] as const;

function Roles(): JSX.Element {
  return (
    <section className="py-20 sm:py-24">
      <div className={cn(container, 'grid gap-12 lg:grid-cols-[1fr_1.2fr] lg:items-start')}>
        <SectionHeading
          eyebrow="One app, every role"
          title="Everyone sees exactly their job."
          lead="Each person signs in with their own account. The screen shows what their role is for, and the server refuses the rest - so a waiter cannot take payment and only a manager can approve a discount."
        />
        <ul className="border-border divide-border divide-y rounded-card border">
          {ROLES.map(({ role, sees }) => (
            <li key={role} className="flex items-baseline gap-4 px-5 py-4">
              <span className="w-24 shrink-0 font-bold">{role}</span>
              <span className="text-muted text-[15px]">{sees}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const PROMISES: readonly { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: ShieldCheck,
    title: 'Every restaurant is separate',
    body: 'Your menu, bills and customers are visible only to your staff. Each restaurant signs in with its own workspace code.',
  },
  {
    icon: History,
    title: 'Nothing is quietly deleted',
    body: 'Bills are voided, payments reversed and items cancelled with a reason - never erased. The end-of-day report shows them all.',
  },
  {
    icon: Lock,
    title: 'Sign-ins are protected',
    body: 'Passwords are hashed, repeated failed sign-ins are throttled, and an owner can see and sign out every device.',
  },
  {
    icon: RefreshCcw,
    title: 'A double tap never bills twice',
    body: 'If the internet drops mid-payment, the till retries safely. The same payment is recorded once, not twice.',
  },
];

function YourData(): JSX.Element {
  return (
    <section className="relative overflow-hidden bg-[#0a0e17] py-20 sm:py-24">
      <div aria-hidden className="ny-diagonal-dark absolute inset-0" />
      <div className={cn(container, 'relative')}>
        <SectionHeading eyebrow="Your data" title="Money is involved. We built it that way." onDark />
        <div className="mt-12 grid overflow-hidden rounded-card border border-[#1e2738] bg-[#111726] sm:grid-cols-2">
          {PROMISES.map(({ icon: Icon, title, body }, index) => (
            <article
              key={title}
              className={cn(
                'border-[#1e2738] p-8',
                index < 2 && 'border-b',
                index % 2 === 0 && 'sm:border-r',
                index === 2 && 'border-b sm:border-b-0',
              )}
            >
              <Icon size={22} className="text-[#6189ff]" aria-hidden />
              <h3 className="mt-4 text-[17px] font-bold text-white">{title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-slate-400">{body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Pricing(): JSX.Element {
  return (
    <section id="pricing" className="scroll-mt-4 py-20 sm:py-24">
      <div className={container}>
        <SectionHeading eyebrow="Pricing" title="Try everything free. Pay when it works for you." />
        <div className="mt-12 grid gap-5 lg:grid-cols-2">
          <div className="border-accent bg-surface flex flex-col rounded-card border-2 p-8">
            <Eyebrow>Free trial</Eyebrow>
            <p className="mt-3 flex items-baseline gap-2">
              <span className="font-display text-5xl font-bold">14</span>
              <span className="text-muted text-2xl font-semibold">days</span>
            </p>
            <p className="text-muted mt-3 text-[15px]">
              Every feature, no card, no setup fee. Register in a few minutes and take your first order today.
            </p>
            <ul className="mt-6 flex-1 space-y-3 text-[15px]">
              {[
                'Floor plan, orders and kitchen screen',
                'Tax invoices, split and credit payments',
                'Menu, offers, inventory and QR menu',
                'Cash drawer and end-of-day reports',
                'Staff accounts for every role',
              ].map((item) => (
                <li key={item} className="flex items-center gap-3">
                  <Check size={17} className="text-accent shrink-0" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
            <Link
              to="/register"
              className="bg-accent hover:bg-accent-hover mt-8 rounded-md py-3.5 text-center font-bold text-white"
            >
              Start free trial
            </Link>
          </div>

          <div className="border-border bg-surface-2 flex flex-col rounded-card border p-8">
            <p className="text-muted-2 font-mono text-[11px] font-semibold tracking-[0.2em] uppercase">Subscription</p>
            <h3 className="font-display mt-3 text-3xl font-bold">Monthly or yearly</h3>
            <p className="text-muted mt-3 text-[15px]">
              Priced for your restaurant’s size and number of outlets. We help you set up your menu, tables and tax
              settings.
            </p>
            <ul className="text-muted mt-6 flex-1 space-y-3 text-[15px]">
              {[
                'Setup help: menu, floor plan, VAT and service charge.',
                'Support in English and Nepali.',
                'Your data is kept safe if a payment is late.',
              ].map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <Check size={17} className="mt-0.5 shrink-0" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
            <a
              href={`mailto:hello@nayaro.tech?subject=${encodeURIComponent('Nayaro RMS pricing')}`}
              className="border-border-3 bg-surface hover:border-border-4 mt-8 rounded-md border py-3.5 text-center font-bold"
            >
              Ask for a quote
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

const QUESTIONS = [
  {
    q: 'Do I need to buy special hardware?',
    a: 'No. Nayaro RMS runs in the browser on the laptop, tablet or phone you already have. Receipts and tax invoices print from the browser to a receipt or office printer.',
  },
  {
    q: 'Can it handle VAT, service charge and PAN on bills?',
    a: 'Yes. Turn VAT and service charge on or off and set their rates in Settings. Invoices are numbered by Nepali fiscal year and can carry the buyer’s name and PAN.',
  },
  {
    q: 'Does it connect to eSewa, Fonepay or card machines?',
    a: 'It records QR and card payments, but does not talk to the payment provider. The cashier confirms what they saw on the QR stand or card machine, and it is counted separately from cash.',
  },
  {
    q: 'Can my staff use it in Nepali?',
    a: 'Dishes and categories carry a Nepali name next to the English one, on the till, the kitchen screen and the guest QR menu.',
  },
  {
    q: 'What happens when the trial ends?',
    a: 'Nothing is deleted. Choose a monthly or yearly plan and carry on with the same menu, history and staff accounts.',
  },
] as const;

function Faq(): JSX.Element {
  return (
    <section id="faq" className="border-border bg-surface-2 scroll-mt-4 border-t py-20 sm:py-24">
      <div className={cn(container, 'grid gap-10 lg:grid-cols-[1fr_1.5fr]')}>
        <SectionHeading
          eyebrow="FAQ"
          title={
            <>
              Questions owners
              <br className="hidden lg:block" /> ask us.
            </>
          }
        />
        <div className="border-border bg-surface divide-border divide-y rounded-card border">
          {QUESTIONS.map(({ q, a }) => (
            <details key={q} className="group px-6 py-5">
              <summary className="flex cursor-pointer list-none items-center gap-4 font-semibold [&::-webkit-details-marker]:hidden">
                <span className="flex-1">{q}</span>
                <span className="border-border-3 text-muted grid size-6 shrink-0 place-items-center rounded-full border text-sm transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <p className="text-muted mt-3 text-[15px] leading-relaxed">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Cta(): JSX.Element {
  return (
    <section className="bg-accent relative overflow-hidden">
      <div aria-hidden className="ny-diagonal-light absolute inset-0" />
      <div className={cn(container, 'relative flex flex-col gap-8 py-16 lg:flex-row lg:items-center lg:justify-between')}>
        <div>
          <h2 className="font-display text-[30px] font-bold tracking-tight text-white sm:text-[40px]">
            Run a calmer service tonight.
          </h2>
          <p className="mt-3 text-[17px] text-white/85">Set up in an afternoon. Free for 14 days.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link to="/register" className="text-accent rounded-md bg-white px-6 py-3.5 font-bold hover:bg-white/90">
            Start free trial
          </Link>
          <a
            href={`mailto:hello@nayaro.tech?subject=${encodeURIComponent('Nayaro RMS demo')}`}
            className="rounded-md border border-white/60 px-6 py-3.5 font-bold text-white hover:bg-white/10"
          >
            Book a demo
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer(): JSX.Element {
  const column = (title: string, links: readonly (readonly [string, string])[]): JSX.Element => (
    <div>
      <p className="font-mono text-[11px] font-semibold tracking-[0.2em] text-slate-500 uppercase">{title}</p>
      <ul className="mt-4 space-y-2.5 text-[15px] text-slate-300">
        {links.map(([label, href]) => (
          <li key={label}>
            {href.startsWith('/') ? (
              <Link to={href} className="hover:text-white">
                {label}
              </Link>
            ) : (
              <a href={href} className="hover:text-white">
                {label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <footer className="bg-[#0a0e17]">
      <div className={cn(container, 'grid gap-10 py-14 md:grid-cols-[1.4fr_1fr_1fr_1fr]')}>
        <div>
          <Lockup onDark className="h-5" />
          <p className="mt-5 max-w-xs text-[15px] leading-relaxed text-slate-400">
            Restaurant management and POS for Nepal. {NAYARO_BRAND.productAttribution}.
          </p>
        </div>
        {column('Product', [
          ['Features', '#features'],
          ['Pricing', '#pricing'],
          ['Register a restaurant', '/register'],
          ['Staff log in', '/login'],
        ])}
        {column('Nayaro', [
          ['Nayaro Flow', 'https://flow.nayaro.tech'],
          ['Nayaro Games', 'https://games.nayaro.tech'],
          ['nayaro.tech', 'https://nayaro.tech'],
        ])}
        {column('Contact', [['hello@nayaro.tech', 'mailto:hello@nayaro.tech']])}
      </div>
      <div className="border-t border-[#1e2738]">
        <p className={cn(container, 'py-6 text-[13px] text-slate-500')}>{nayaroCopyright()}</p>
      </div>
    </footer>
  );
}
