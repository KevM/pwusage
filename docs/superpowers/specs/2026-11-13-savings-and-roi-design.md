# Design: On-Device Bill Pricing, Lifetime Savings, and Return on Investment

- **Date:** 2026-11-13
- **Status:** Draft (pending user review)
- **Areas:** iOS app (`cmd/ios-app`), mobile history API and rate plan timeline (`cmd/next-app`)
- **Related:** [Historic effective-dated rate plans](./2026-11-11-historic-effective-tariffs-design.md) (#358),
  [Solar Health](./2026-11-11-solar-health-design.md), [`docs/voice-and-terms.md`](../../voice-and-terms.md),
  [`DesignDecisions.md`](../../../DesignDecisions.md)

## 1. Intent

Owners want an answer to "has my system paid for itself, and when will it?", worked out from their
own history. The app already has the inputs for most of it: the full 5-minute history back to
install (loaded for Panel Health), dated rate plans with re-attribution (#358), and the billing
day. The result is a **best guess with its assumptions stated**, not an accounting record.

Doing this on the phone also lets the Bill tab and the home screen price the bill themselves,
from the same flows, rate plans and billing day, instead of calling `GET /api/mobile/bill-summary`.

### Goals

1. **Phase 1, the phone prices its own bill:** the Bill tab and the home screen's bill figures are
   computed on the phone, checked against the server in shadow mode before switching over.
2. **Phase 2, savings:** "Your system saved about $142 this month", with a breakdown into solar and
   Powerwall plus rate plan, for billing cycle, year and lifetime.
3. **Phase 3, return on investment:** owner-entered costs, payback to date, and a projected
   break-even date.

### Non-goals (this project)

- Loans, interest, leases, and the return the money could have earned elsewhere.
- Comparing rate plans ("Am I on the best plan?"). Scenarios here pick a plan per scenario; they
  don't search across plans.
- Reading battery capacity from the Powerwall's local gateway API. It plugs into the Phase 3
  projection later as a separate feature.
- Removing server pricing. The web app, TRMNL and server re-attribution keep pricing on the server.
- The widget. It keeps reading the server's figures for now (follow-up).

### Anti-goals (a failure even if it technically works)

- The Bill tab and the savings figure disagree about the same billing cycle.
- An estimate is shown as if it were fact. Every figure built on estimated rates, simulation or
  projection is worded "about" (voice guide) and says what it assumed.
- An estimated (URDB) rate plan replaces a plan the owner entered or Tesla supplied.
- The home location, or anything derived from it, reaches the server (privacy policy).
- Savings are made to look bigger by pricing "no solar" on an expensive plan the owner would never
  have chosen.

## 2. Constraints

- **One pricing behaviour across server and phone.** Bills net imports and exports per
  `(plan name, rate period name)` across the billing cycle, offsetting proportionally and pricing
  the remainder at each bucket's own rates (`priceBillUsage` in `cmd/next-app/src/lib/bill-pricing.ts`).
  The Swift engine must reproduce this exactly, along with `resolveTariffForDate`, seasons,
  weekday/weekend windows and holidays (`schedule.ts`, `holidays.ts`).
- **Cross-app contract rule** (root `AGENTS.md`): any change to a mobile response changes both
  sides in the same PR.
- **No compatibility with older app builds.** The iOS app is in beta (user, 2026-11-14), so
  responses change in place. New fields are additive, and the response keeps `version: 1`.
- **Vercel Hobby 60 s limit, Supabase 500 MB shared quota and egress budget.** The phone approach
  adds roughly 1 MB of download per site-year, once per device. That's acceptable (user,
  2026-11-13).
- **Voice guide:** "rate plan", never "tariff"; "Time of Use", never "TOU"; estimates say "about".
- **iOS CI:** `swiftformat --lint` and `swiftlint --strict` must be clean, with zero compiler
  warnings. Tests use Swift Testing.

## 3. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | Server computes the four scenario costs per day, stores them, and serves rollups. | One pricing engine, reused by web and TRMNL. Needs a new table, recompute jobs within the 60 s limit, and server round trips for every figure. |
| B | Server computes on request with nothing stored. | Lifetime totals decode thousands of archived days on each request; needs caching that rebuilds most of A. |
| **C (chosen)** | **The phone stores raw 5-minute flows and prices everything itself; the server supplies flows and dated rate plans.** | A second pricing engine, kept honest by shared fixtures and shadow mode. Rate plan edits reprice instantly on the phone (flows never change, only prices). About 1 MB per site-year downloaded. Web and TRMNL need their own port if they ever show savings. |

**Why C:** the phone already downloads the full history and the dated rate plan timeline
(`SiteTariffsTimelineResponse`), and it already mirrors the server's per-day plan choice
(`SiteTariffsTimelineResponse.period(on:)` follows `resolveTariffForDate`). Re-attribution needs
no syncing: the phone never stores priced results, so a rate change just means repricing locally.
The user picked C on 2026-11-13 and asked to move the Bill tab and home screen onto it.

## 4. Data the phone needs

### 4.1 Flows in the history download

`GET`/`POST /api/mobile/solar-history` always send the new series (no opt-in parameter; the app
is in beta). Each day adds:

- `loadWh: [Double?]`: home usage per 5-minute slot.
- `gridWh: [Double?]`: the archive sample's signed `grid_power` (import positive, export
  negative), rounded to 0.01 Wh. The bill sums exactly this signed value per
  `(plan, rate period, rates)` (`EnergyRepo.aggregateUsageByTOU`) before `priceBillUsage` nets it,
  so the phone sums the same numbers and parity holds by construction.

- `batteryWh: [Double?]`: the archive sample's signed `battery_power` (sign as stored), rounded to
  0.01 Wh.
- `batterySoc: [Double?]`: the archive sample's `battery_soc` (percent, rounded to 0.1; null when
  Tesla gave none).
  Historic state of charge has gaps because of Tesla API limits (user, 2026-11-14). Null state of
  charge never blocks pricing or readiness, and the capacity estimate uses only discharge spans
  with state of charge on every sample.

Battery series aren't needed by any scenario's arithmetic (battery value comes from the grid
figures), but they are sent now because adding them later would make every device re-read its
whole history again. Uses: the site's own round-trip efficiency for scenario 2's battery model,
a usable-capacity and fade estimate from energy per percent of charge over long discharges (a
rougher stand-in for the local gateway reading in Phase 3), and a data check against
`load − solar − grid`.

**Holidays:** the timeline response's `holidayDates` covers only this year and next today. It is
widened to every year from the history start through next year, so the phone matches weekend
schedules on past holidays without its own holiday rules. The phone stores the new series alongside
`solarWh` in `SolarHistoryStore` (or a sibling store; builder's call). Existing devices hold only
solar, so the first sync with the new series re-reads the whole history once.

### 4.2 Two rate plan timelines

- **Actual timeline:** today's dated plans. Priority: owner-entered (`manual`) > Tesla (`tesla`) >
  estimated (`estimated`, new, from URDB). Estimates only fill date ranges that no manual or Tesla
  plan covers, and they never replace a manual or Tesla plan. The Tesla plan gets a sourced start
  date (4.3), which bounds where estimates begin.
- **Reference fixed-rate timeline (new):** the utility's standard residential fixed plan over time,
  used only by the fixed-rate scenarios. It is never used for the Bill tab, Smart Shift or server
  re-attribution. It comes from URDB or from the owner, through the existing rate plan editor.
  The owner can set it to the plan they had before solar.

Both timelines come down through the existing timeline call (`SiteTariffsTimelineResponse`), with
a field saying which timeline each plan belongs to. How that's stored on the server (a timeline
column on `TariffEffectivePeriod`, or a sibling table) is left to the builder. It must keep the
append-only `Tariff` rule in `DesignDecisions.md`.

### 4.3 Estimated rate plans from URDB

- Source: the OpenEI Utility Rate Database `utility_rates` API (CC0 data, free API key stored as a
  server environment variable). Fetched on the server only.
- **Anchor on the Tesla plan** (user, 2026-11-13). Tesla's plan is the one good source we have, but
  it has no start date. Assign one, then build the rest from it:
  1. **Find the utility** by name (`Site.utility`) through URDB's `ratesforutility` or `eia`
     lookup. **Location is never used:** the privacy policy keeps the home location on the
     user's devices, and the server never receives it. When `Site.utility` is missing or doesn't
     match a URDB utility, the app **asks the owner to pick their utility**: a search by name,
     answered by a server endpoint that proxies URDB's utility list (the API key stays on the
     server). The chosen utility's URDB identifier is stored with the site; the privacy policy
     already covers stored utility information.
  2. **Match the Tesla plan to a URDB revision** of that utility by plan name and by prices, rate
     period by rate period, within half a cent (Tesla rounds to the cent). The matched revision's
     `startdate` becomes the Tesla plan's start date.
  3. **Without a match**, use when our sync first saw that Tesla version (an upper bound: owners
     often update Tesla late), and for the site's first Tesla plan, January 1 of the year it was
     first seen. Rate cases and annual true-ups most often take effect January 1, but many don't,
     so this is labeled "Assumed".
  4. **Auto-build the actual timeline** back to the history start by walking the matched
     revision's `supercedes` chain. These are `estimated` plans. Gaps the chain doesn't reach
     stay uncovered and fall back as today.
  5. **Auto-build the reference fixed timeline** from the same utility's `is_default` residential
     fixed plan per year.
- Each plan's start date records its source ("From public utility rates", "First seen in Tesla",
  "Assumed January 1"), and the owner can correct any of them in the editor.
- When the matched revision is older than URDB's newest revision of the same plan, the Tesla plan
  is probably out of date. Tell the owner and suggest updating the plan in the Tesla app or here.
- **Estimates are used on the server too** (**my call**, following the user's direction): server
  attribution, the web app and TRMNL use the same actual timeline as the phone, so every surface
  agrees. Adding estimates queues re-attribution through the existing mechanism (#358). Today
  those days are priced at the earliest known plan, which is a weaker guess.
- If the owner skips picking a utility, or no plan revision matches, no estimate is made and
  screens ask the owner to add a rate plan.
  Walk `supercedes` and `startdate`/`enddate` back in time for the actual timeline. Use the
  utility's `is_default` residential fixed plan for each year for the reference timeline.
- Conversion: URDB's 12×24 weekday/weekend schedules and per-period `rate` plus `adj` (buy) and
  `sell` map onto our seasons and rate periods. A tiered fixed plan is flattened to one blended
  rate at the site's median monthly usage (**my call**; tier support is a follow-up).
- Reference plan export rate (**my call**): the plan's own sell rate when URDB or the owner gives
  one. Otherwise, how exports are paid follows the utility's solar rules more than the plan, so
  use the buy rate when URDB's `dgrules` says Net Metering, and otherwise the actual timeline's
  average sell rate for that date. The owner-entered path asks for both rates, as the editor does
  today.
- Where an estimate is used, screens say so: "Estimated from public utility rates. Add your
  rate plan for a better figure."
- URDB often leaves out riders such as fuel adjustments, so estimates tend to run low. That's
  acceptable for a best guess, and the label says so.

### 4.4 Knowing when to reprice

- **Timeline changed** (edit, new Tesla plan, new estimate): on foreground, the phone compares a
  fingerprint of both timelines with the one it last priced against, and reprices every stored day
  when it differs.
- **Day changed** (an open day finished, a gap was repaired): the existing `changedSince` sync
  and the `open`/`complete`/`gapped` statuses drive re-fetching.
- **Server re-attribution in progress:** the timeline response already carries `reattribution`.
  While it's running, the Bill tab's shadow comparison is skipped for affected cycles.

## 5. Phase 1: The phone prices its own bill

### 5.1 Pricing engine (Swift)

A pure, testable unit: dated plans + flows + billing day → cycle cost by
`(plan, rate period)`. It reproduces `priceBillUsage` netting and `resolveTariffForDate` plan
choice exactly. Pricing moves out of views into this unit (refactor for cohesion; reused by the
Bill tab, the home screen and the Phase 2 scenarios).

### 5.2 Everything `bill-summary` provides today

`GET /api/mobile/bill-summary` returns more than the bill:

- `currentBill` (cycle total and per-period costs): from the engine.
- `outlook` (recorded cycle history plus the `tariffTimeline` to cycle end): built on the phone
  from the engine and the timeline. The projection already runs in Swift (`EnergyFlowProjection`).
- `loadTiming` (Smart Shift's export cushion and import gap per rate period, plus its
  `tariffTimeline`): **port `computeLoadTiming` (about 200 lines) and `buildLoadTimingTimeline` to
  Swift** (**my call**: otherwise the app can't stop calling `bill-summary`).
- `revision` and 304 handling: replaced by local change detection (4.4).

### 5.3 Today's data

Today's open day must be as fresh on the phone as it is in `bill-summary` today. `bill-summary`
reads today's raw rows directly; the history GET reads the archive "as it fills". **The builder
must confirm the open day's archive lags no more than `bill-summary` does**, or the phone tops up
today from the live feed it already polls.

**First load** (**my call**): the Bill tab only needs the current cycle, so the phone fetches the
current cycle's flows first and keeps showing `bill-summary` figures until they're stored. The
rest of the history (needed for Phase 2) loads in the background through the existing deep-history
walk, re-reading days that are missing the new series. Savings show a loading state until it ends.

**Partial and gapped days:** priced from whatever samples exist, exactly as the server's rollups
do. The Bill tab and every scenario use the same set of days, so they can't disagree.

### 5.4 Shadow mode, then switch

1. Release N: the phone computes everything in 5.2 and still calls `bill-summary`. It compares
   cycle totals and per-period costs and reports any difference over $0.01. The app has no
   remote telemetry, so the report goes to a small new endpoint that logs it on the server
   (amounts, period keys and app build only), where it reaches the existing server logs. Screens still show the server's figures.
2. Once the reported differences are explained or gone: the Bill tab, Smart Shift and the home
   screen's `todayCost`/`currentBill` use the phone's figures, and the app stops calling
   `bill-summary` while its own figures are ready. The endpoint stays as the fallback while the
   phone's data isn't ready (first install, backfill in progress).

### 5.5 Shared fixtures

One fixture set in the repo (sample days, plans, holidays, billing day, expected per-period costs)
read by both Jest (`cmd/next-app`) and Swift Testing (`cmd/ios-app`). It includes DST days, a plan
change mid-cycle, a season boundary, a holiday, and net-export periods.

## 6. Phase 2: Savings

### 6.1 Four scenarios, each on the plan that fits it

| # | Scenario | Rate plans | Flows |
|---|---|---|---|
| 1 | Solar + Powerwall, Time of Use | Actual timeline | Recorded (this is the bill from Phase 1) |
| 2 | Solar + Powerwall, fixed rate | Reference timeline | Simulated: battery stores spare solar and covers evening use, no grid charging |
| 3 | Solar alone, fixed rate | Reference timeline | Simulated: per slot, solar covers load first, the rest is imported or exported |
| 4 | No solar, fixed rate | Reference timeline | All load imported |

- Time of Use only makes sense with a battery, so scenarios 2–4 use the fixed reference plan
  (user). Where a utility requires Time of Use for solar customers, scenarios 2 and 3 use the
  actual timeline instead, through a small per-utility rule list (**my call**).
- All four scenarios price through the same engine and the same cycle netting.
- **Battery model for scenario 2** (**my call**, defaults left to tune): usable capacity from Tesla's
  `nameplate_energy`, 90% round-trip efficiency, the site's backup reserve held back, charge only
  from solar surplus, discharge to cover load. Under full net metering this scenario will show the
  battery adding about nothing, which is a correct answer. `nameplate_energy` and the backup
  reserve come from Tesla's site info. The server adds both to the timeline or a site-info response
  (builder picks where), and the phone already knows the current reserve for Battery Saver.
- **Before the Powerwall's install date** (**my call**): scenarios 1 and 2 have no battery to
  simulate or remove, so scenario 2 equals scenario 3 for those days. The "Powerwall and your rate
  plan" share (3 − 1) is then only the plan difference, which the breakdown wording already covers.
  For return on investment (7.2), Powerwall savings count only from its install date.

### 6.2 What's shown

- **Headline:** scenario 4 − scenario 1. "Your system saved about $142 this month."
- **Breakdown line (shown with the headline, user):** solar = 4 − 3; Powerwall and your rate plan
  = 3 − 1. "Solar about $96 · Powerwall and your rate plan about $46."
- **Fixed-rate comparison:** 3 − 2 and 4 − 2, for owners wary of Time of Use ("On a fixed rate
  plan, your system would have saved about $…").
- **Periods:** the current billing cycle (Bill tab), the year and lifetime (Solar System view).
- **Coverage:** days with no samples contribute nothing, and partial days are priced as recorded,
  the same as the bill. The count is shown ("Based on 2,914 of 2,950 days").
- **Estimated plans:** the figure is still shown, labeled with the share of days priced on
  estimates ("About 40% of these days use estimated rates").

Exact layout is settled with mockups before Phase 2 UI work starts.

## 7. Phase 3: Return on investment

### 7.1 Inputs (owner-entered, stored on the server per site so they survive reinstalls)

- Per component (solar, Powerwall): install date (defaults: `Site.installed`; the battery can
  differ), cash price, federal tax credit (toggle, 30% default), rebates and other incentives ($).
- Who may edit (**my call**): whoever may edit the site's rate plans today, under the same API
  permission check. The values are shared by everyone on the site.
- No loans or interest (non-goal). Help text says loan holders can enter their total loan cost
  as the price.

### 7.2 Payback to date

Lifetime savings (Phase 2) against net cost, per component and combined. Solar uses 4 − 3; the
Powerwall uses 3 − 1, counted from the battery's install date.

### 7.3 Break-even projection

- Usage: future years look like the last 12 months.
- Rates: rise at the average pace seen in the actual timeline; 3%/yr when there's under two years
  of plan history.
- Solar output: falls at the degradation rate the Panel Health backtest measured; 0.5%/yr default.
- Battery capacity: a standard fade curve (builder picks a published one) until the local gateway
  reading exists.
- Output: a month and year ("around spring 2029"), per component and combined, with the
  assumptions listed under it.

## 8. Testing

- Shared pricing fixtures (5.5) in both test suites.
- Swift Testing for the engine, the scenario simulators (energy conservation per slot: load =
  solar + grid + battery), repricing on timeline change, and projection maths.
- Jest for the new series in the history download, URDB conversion
  (recorded API responses as fixtures, no live calls in tests), and the timelines' priority rules.
- Shadow mode (5.4) is the production check for Phase 1.

## 9. Left to the builder

- Storage layout for the new series on the phone, and for the reference timeline on the server.
- Fingerprint format for timeline change detection.
- Per-utility "Time of Use required for solar" rule list contents.
- Battery fade curve choice and simulation details beyond 6.1.
- URDB matching thresholds and what happens when no confident match exists (default: no estimate,
  ask the owner to add a rate plan).

## 10. Follow-ups (not this project)

- Widget reads the phone's figures.
- Rate plan comparison ("Time of Use versus fixed for your home").
- Local Powerwall gateway capacity reading for battery fade.
- Loans and interest; tiered fixed plans.
- Savings on web and TRMNL (port of the scenario pricing).
