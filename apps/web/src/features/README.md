# features/

Restaurant-specific functionality, one folder per domain area:
`auth/`, `tables/`, `menu/`, `orders/`, `kitchen/`, `billing/`.

Each owns its own `components/`, `hooks/`, `api/` and `types.ts`. Components like
TableCard, KotCard and OrderPanel belong here - not in `components/`.

Empty until Phase 3 domain design is agreed.
