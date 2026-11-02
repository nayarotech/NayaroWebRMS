# Nayaro RMS Cloud

Multi-tenant, browser-based restaurant management and POS by **Nayaro Technology**.
It is the web edition of the Nayaro RMS desktop application: the same billing,
kitchen, inventory, credit, loyalty, payroll and reporting rules, served to many
restaurants from one platform.

## Quick start

Requires Node.js 22.12+ and npm 10+.

```bash
npm install
cp .env.example .env        # defaults work for local development
npm run demo:seed           # creates the demo restaurants (safe to re-run)
npm run dev                 # API on :4000, web app on http://localhost:5180
```

Open http://localhost:5180 and sign in.

### Demo accounts

| Workspace           | Username  | Role    | Starts on    |
| ------------------- | --------- | ------- | ------------ |
| `himalayan-kitchen` | `owner`   | Owner   | Dashboard    |
| `himalayan-kitchen` | `manager` | Manager | Dashboard    |
| `himalayan-kitchen` | `cashier` | Cashier | Tables / POS |
| `himalayan-kitchen` | `waiter`  | Waiter  | Tables       |
| `himalayan-kitchen` | `kitchen` | Kitchen | Kitchen      |
| `everest-cafe`      | `owner`   | Owner   | Dashboard    |

All demo accounts use the password `Demo@2026`, or `DEMO_PASSWORD` if it was set
when seeding. Himalayan Kitchen has two weeks of sales history, open tables at
every service stage, kitchen tickets, stock (two items below reorder level),
customer credit, a refund and expenses. Everest Café is a second, separate
restaurant for showing tenant isolation. The guest QR menu is at
http://localhost:5180/m/himalayan-kitchen.

To start over, stop the API, delete `packages/server/.data/`, and seed again.

To empty one restaurant while keeping its staff logins, menu, tables and settings,
stop the API and run:

```bash
npm run tenant -- reset-data himalayan-kitchen             # preview
npm run tenant -- reset-data himalayan-kitchen --execute   # clear data
```

This clears orders, kitchen tickets, invoices, payments, refunds, customers,
credit/loyalty history, expenses, cash-drawer history, payroll history and saved
request receipts. Stock quantities become zero and order/KOT/invoice numbering
restarts. Staff must sign in again. Inventory items, recipes, payroll profiles,
offers and security logs are kept; other restaurants are unchanged. A full SQLite
backup is saved under `packages/server/.data/backups/` before any data is cleared.
This command supports local SQLite databases only. Do not seed again afterward;
the existing restaurant remains available with its existing credentials.

### Suggested demo path

1. Sign in as **owner**: the dashboard's Overview, Reports, Orders, Inventory and
   Notifications tabs.
2. Sign in as **cashier**: open a free table, add dishes, **Send to Kitchen**.
3. Sign in as **kitchen** in another browser: start and finish the ticket.
4. As **cashier**: open the bill, **Issue Invoice**, take payment, print the receipt.
5. As **owner**: End of day, Settings → Security (signed-in devices, activity log).
6. Sign in to `everest-cafe`: none of Himalayan Kitchen's data is visible.

New restaurants can register themselves at `/register` (14-day trial).

## Commands

| Command                | What it does                                                 |
| ---------------------- | ------------------------------------------------------------ |
| `npm run dev`          | API (with reload) and web app together                       |
| `npm run demo:seed`    | Create the demo restaurants through the real API             |
| `npm test`             | Security and tenant-isolation suite                          |
| `npm run test:all`     | Every suite: SaaS security plus all business-rule suites     |
| `npm run build`        | Type-check and build the web app into `apps/web/dist`        |
| `npm start`            | Run the API (production: set `NODE_ENV=production`)          |
| `npm run db:migrate`   | Apply database migrations (the API also does this on start)  |
| `npm run tenant -- …`  | Platform operator CLI: list tenants, suspend, renew          |
| `npm run typecheck`    | Type-check every workspace                                   |
| `npm run lint`         | ESLint                                                       |

```bash
npm run tenant -- list
npm run tenant -- status himalayan-kitchen --set SUSPENDED --reason "Unpaid invoice"
npm run tenant -- status himalayan-kitchen --set ACTIVE --until 2027-11-30
```

## Architecture

```
apps/web            React 19 + Vite + Tailwind 4 (browser)
   │  HTTPS: REST + Socket.IO, Authorization: Bearer <token>
packages/server     Express 5 API, Socket.IO, business rules
packages/database   Prisma 7 schema, migrations, libSQL (SQLite) client
packages/shared     Types and contracts shared by the API and the web app
```

One API serves every restaurant. A modular monolith, not microservices: one
deployable, one database, clear module boundaries (`packages/server/src/modules`).

### Multi-tenancy

- **Tenant = restaurant.** Every restaurant-owned table carries `restaurantId`.
- The tenant is **derived on the server from the session**, never taken from the
  request. Body fields, query parameters or headers naming another restaurant are
  ignored (`verify-saas.ts` checks this).
- Every query filters by the session's `restaurantId`; records are loaded scoped to
  the tenant before any update, so another restaurant's ids return `404`.
- Usernames are unique per restaurant; sign-in takes a **workspace code**.
- Realtime events go only to the restaurant's own Socket.IO room.
- Tenants have a lifecycle (`TRIAL`, `ACTIVE`, `SUSPENDED`, `CANCELLED`) and an
  optional subscription end. It is checked on **every request** and socket recheck,
  so suspending a restaurant cuts off open sessions immediately.
- Business days are computed in each restaurant's own time zone, not the server's.

### Authentication

- Sign-in returns an opaque 256-bit token, kept in `localStorage` and sent as
  `Authorization: Bearer …`. The server stores only its SHA-256 hash.
- **Every protected request re-validates it**: token format, session exists, not
  revoked, not expired (12-hour sliding window), staff account active, session
  belongs to the staff member's restaurant, tenant active and subscribed. Role and
  service-duty guards then run per route. Invalid tokens get `401`; a suspended or
  expired restaurant gets `403`.
- A token in `localStorage` proves nothing to the web app either: on load it calls
  `/auth/me`, and staff identity, role and tenant come from that answer.
- Opaque server-side sessions rather than JWTs, so logout, password changes,
  deactivation, remote device sign-out and tenant suspension take effect instantly.

### Security controls

- scrypt password hashing with per-hash parameters and transparent upgrade.
- Sign-in throttling per address and per workspace/username; uniform error for
  unknown workspace, unknown user, disabled account and wrong password.
- Global API rate limit; registration rate limit.
- Zod validation on every input; Prisma parameterised queries (no string SQL).
- Strict security headers on the API; CORS restricted to `WEB_ORIGINS`, credentials off.
  Because authentication is a header, not a cookie, cross-site request forgery
  does not apply.
- Errors never expose stack traces or database detail.
- Append-only audit log: sign-ins and failures, staff and password changes, tax and
  settings changes, voids and refunds (owner: Settings → Security).
- Durable idempotency keys prevent duplicate orders, payments and refunds on retry.

**localStorage and XSS.** A token in `localStorage` can be read by any script that
runs on the page, so the web build ships a strict Content-Security-Policy
(`script-src 'self'`, no inline script, `connect-src` limited to the API). All data
is rendered through React's escaping (no `dangerouslySetInnerHTML`), and nothing
else sensitive is stored. Tokens expire after 12 idle hours and can be revoked
from Settings → Security.

## Production deployment

### Vercel services

Import this repository as **one Vercel project**, with its Root Directory at the
repository root. The root `vercel.json` builds `web` (`apps/web`, Vite) and
`server` (`packages/server`, Express) independently. `/api` and `/api/*` reach
the API, including `/api/socket.io`; all other paths reach the frontend. The
frontend service includes an SPA fallback for deep links such as `/register`
and `/m/himalayan-kitchen`.

The web app calls the public `/api` path from the browser. There are currently
**no server-to-server calls and no internal service bindings**. Do not inject an
internal binding URL into `VITE_API_URL`: Vite embeds that variable at build time,
whereas bindings are available only to server functions at runtime.

Configure Vercel environment variables for each deployment environment:

- `DATABASE_URL`: a managed libSQL URL, such as `libsql://your-db.turso.io`.
  Local SQLite files cannot persist restaurant data on Vercel and are rejected.
- `DATABASE_AUTH_TOKEN`: the managed database's token, when required.
- `VITE_API_URL=/api`: optional default; remove any old localhost override.
- `WEB_ORIGINS`: comma-separated custom frontend origins, if any. Vercel's
  deployment and production origins are allowed automatically.

Use a separate managed database for Preview deployments to keep test activity
away from Production. Before deploying a new schema, run `npm run db:migrate`
from a trusted shell configured with that environment's database credentials.
The Vercel entrypoint checks schema integrity but does not run migrations on
each function startup. Never put database tokens in a `VITE_` variable.

Test services locally with `vercel dev` (or `vercel dev --local` without linking
a cloud project). Run `npm run db:migrate` first for a new local database. The
existing `npm run dev` also works: Vite proxies `/api` to the standalone API.

The API exports its HTTP server and the browser uses WebSocket transport directly.
Vercel reconnects are handled by the existing Socket.IO retry and query refresh
logic. Immediate broadcasts across multiple function instances require a shared
Socket.IO adapter; the current adapter is in memory, with periodic query refresh
as a fallback. Rate limits are also per instance (see below).

Validation with Vercel CLI 65.9.0 passes local page, asset and HTTP API checks,
but its local service proxy resets WebSocket upgrades. The disposable
`node --import tsx packages/server/scripts/verify-services.ts` suite verifies
WebSocket authentication directly against the API. Check the WebSocket connection
in a Vercel Preview deployment before promoting to Production.

### Other hosts

1. **API**: run `npm start` with `NODE_ENV=production`, `WEB_ORIGINS`, `DATABASE_URL`
   (and `DATABASE_AUTH_TOKEN` for a managed libSQL server), and `TRUST_PROXY` when
   behind a proxy. Terminate HTTPS at the proxy; the API sends HSTS.
2. **Web app**: `VITE_API_URL=https://api.example.com npm run build`, then serve
   `apps/web/dist` as static files with all unknown paths rewritten to
   `index.html`. Send the CSP from the built `index.html` as an HTTP header too
   (`frame-ancestors` only takes effect as a header).
3. The in-memory rate limiters are per instance. Running several API instances
   needs a shared store (for example Redis) behind the same interface.
4. Database: the schema runs on SQLite/libSQL today. Back it up at the database
   level (managed libSQL, or file snapshots for a single-server install).

## Differences from the desktop application

| Desktop feature                     | Web edition                                                       |
| ----------------------------------- | ----------------------------------------------------------------- |
| First-run setup for one restaurant  | Self-service registration; any number of restaurants              |
| Sign in with username               | Sign in with workspace code + username                            |
| Session kept in memory only         | Token in `localStorage`, verified by the server on every request  |
| Local backup / restore of the file  | Removed: restoring a shared database would roll back every tenant. Backups are a platform operation. |
| LAN address and staff-phone QR      | Not needed: every device opens the same web address               |
| Native print bridge                 | Browser printing at 80 mm, 58 mm or A4, with copy marking         |
| Fixed 1280 px window                | Responsive: desktop, tablet and phone                             |

All other workflows (floor plan, orders, kitchen board, billing, split and credit
payments, corrections, refunds, cash drawer, end-of-day report, menu, offers, set
menus, inventory and recipes, expenses, customers and loyalty, staff duties,
payroll) carry over with their original business rules and verification suites.
