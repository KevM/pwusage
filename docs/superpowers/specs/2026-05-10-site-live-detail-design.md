# Site Live Detail Page Design

## Purpose
The dashboard's site live data tile shows a momentary snapshot (solar, load, grid, battery, current tariff) and links to the full site page. Users want a richer "tap-through" detail view that adds:

1. **Daily totals so far** — grid in/out, solar, load — with a per-TOU-period mini-breakdown.
2. **A load-timing recommendation** — "is now a good time to start a large load?" — driven by the *marginal cost* of an additional kWh in each TOU period.

## Recommendation Logic

Under net metering with asymmetric buy/sell rates, the marginal cost of running a load in a TOU period depends on what that period's *meter* has been doing cumulatively over the current billing cycle.

Define `cycleNetExport` per period as the signed kWh that crossed the meter in that period during the cycle (positive = exported to grid, negative = imported from grid). Derived from `UsageData.gridUsage`; the implementation must confirm the sign convention of that field and adapt.

- **`cycleNetExport > 0`** (period is a net exporter) → an extra kWh of load reduces export by 1 kWh → marginal cost ≈ `sellRate`.
- **`cycleNetExport < 0`** (period is a net importer) → an extra kWh of load increases import by 1 kWh → marginal cost ≈ `buyRate`.
- **`|cycleNetExport| < epsilon`** (default 0.5 kWh) → neutral; render `—`.

The lowest marginal cost across periods is the cheapest place to put discretionary load — which is often the *higher-rate* period when the user is a net exporter there. The billing cycle is defined by `Site.billing_start_day`.

This deliberately ignores the instantaneous condition (solar > load right now is a real-time-only consideration) and battery state. The cycle accumulator is what the utility ultimately bills against.

## Architecture

### New route
- `cmd/next-app/src/app/site/[id]/live/page.tsx` (server component, auth-gated by `verifySiteAccess`).
- `src/components/DashboardCards.tsx` live tile `<Link>` retargeted from `/site/[id]` to `/site/[id]/live`.

### New shared helpers
- `src/lib/billing-cycle.ts` — extract `getCurrentCycleStart(billingStartDay: number, now: Date): Date` from the inline logic in `src/app/site/[id]/usage/page.tsx`. Update `usage/page.tsx` to use the shared helper. Preserve current behavior, including short-month handling.
- `src/lib/marginal-cost.ts` — pure function `computeMarginalCost(usage: UsageData, epsilonKwh = 0.5): { cycleNetExport: number; marginalCost: number | null; basis: 'sell' | 'buy' | 'neutral' }`. No I/O. The implementation derives `cycleNetExport` from `usage.gridUsage` once the sign convention is verified.

### New repo method
- `EnergyRepo.getCycleAndTodayTotals(siteId, cycleStart, todayStart, now): Promise<{ cycle: UsageData[]; today: UsageData[] }>` — single call, internally reuses `getUsageByTOU` for both windows. Both arrays keyed by TOU period name.

### New components (under `src/components/site/live/`)
- `LiveDetailView` (server) — composes the page sections.
- `DailyTotalsRow` (server) — compact stat row: today's grid in, grid out, solar, load.
- `DailyByPeriodTable` (server) — small table: each TOU period × today's net contribution (kWh).
- `PeriodCardRow` (server) — horizontal scroll on mobile, grid on desktop.
- `PeriodCard` (server) — period name, large colored marginal cost, ↑/↓ + cycle net (kWh), highlight ring on the active period.

### Reused
- `SiteLiveStats` (existing client component) — top section, polls `/api/site-live-data` every 60s for live row + 24h sparklines. Unchanged.

## Data Flow

Server render path on `/site/[id]/live`:
1. `verifySiteAccess(siteId)`; load `site`.
2. `cycleStart = getCurrentCycleStart(site.billing_start_day, now)`.
3. `todayStart = EnergyRepo.getSiteMidnight(now, site.timezone)`.
4. Build `Schedule` from site tariffs; `activePeriod = schedule.getTariffPeriod(now)`.
5. `EnergyRepo.getCycleAndTodayTotals(siteId, cycleStart, todayStart, now)` → `{ cycle, today }`.
6. For each cycle period: `computeMarginalCost(usage)`. Match by name with `activePeriod.schedule.name` for highlight.
7. Render `LiveDetailView` with: live polling section (top), `DailyTotalsRow`, `DailyByPeriodTable`, `PeriodCardRow`.

Client polling path (existing): `SiteLiveStats` continues to poll `/api/site-live-data`. No endpoint changes. Cycle and daily aggregates refresh only on navigation; this is acceptable because they shift slowly relative to the per-poll resolution of the live tile.

## Error Handling

- **No tariff configured:** render live tile + daily totals; replace period card row with a muted "Configure a tariff to see load-timing recommendations" link to `/site/[id]/settings`.
- **No cycle data yet (new site):** period cards render with `—` for kWh and marginal cost; daily row shows zeros. No error UI.
- **Schedule resolution returns null for `now`:** no card highlighted; all sections still render. Log a server-side warning; do not surface.
- **Repo errors:** propagate to the existing Next.js error boundary; no custom recovery.

## Testing

Test-first for new logic.

1. `src/lib/marginal-cost.test.ts` — net positive/negative/within-epsilon; boundary at exactly epsilon.
2. `src/lib/billing-cycle.test.ts` — `now` after vs before billing day; short-month handling for `billingStartDay = 31` in February (capture existing behavior).
3. `src/lib/energy-repo.test.ts` (extend) — `getCycleAndTodayTotals` returns both arrays from one call; today is a subset of cycle; empty site returns empty arrays without throwing.
4. `src/components/site/live/PeriodCard.test.tsx` — renders correctly for active, surplus, deficit, and neutral/no-data states.
5. **Skip** a full page integration test unless wiring proves fragile; the page is composition over already-tested units.

Manual verification per CLAUDE.md: start `npm run dev:agent` (port 5174), navigate to `/site/<id>/live` with real data; confirm `npm run lint` and `npm run build` pass.
