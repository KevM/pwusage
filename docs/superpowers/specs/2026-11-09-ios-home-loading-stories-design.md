# iOS Home tab loading: "little stories"

Date: 2026-11-09 · App: `cmd/ios-app` · Status: draft for approval

## Why

After a cold launch or a long time away, the Home tab looks broken rather than busy. The owner
sees this rarely, but each time "it makes me sad", and because it is the first screen after a gap
it sets the tone for the whole app. Three specific problems:

1. **Loading reads as failure.** While the first fetch is still in flight, cards make false
   claims. Today says "Energy data unavailable", Smart Shift says "No rate plan is set up", and
   Live shows greyed tiles headed "Last readings" / "Flow unknown" over hours-old restored values.
2. **The layout jumps.** Live's `LoadingCard` (a one-line spinner row) is much shorter than the
   real card, so everything below moves when data lands.
3. **Old numbers.** Restored readings from hours ago aren't useful, and greying them out just looks
   sad.

## Goals

- While a card is waiting, it shows a calm, slightly characterful **story**: an animated SF Symbol
  and a short line about what it's fetching, rotating through a few lines.
- Each card **keeps its final size** while waiting, so nothing jumps.
- Each card **pops in on its own** as soon as its data arrives.
- "Unavailable", "No rate plan" and "unknown" copy appears **only when it is true**, never while
  loading.
- Saved readings up to **15 minutes** old still show right away. Anything older starts with the
  story.

## Non-goals

- The pre-Home launch screens ("Starting pwusage…", "Connecting to pwusage…") and the
  reconnect-Tesla / session-expired screens.
- Other tabs, widgets, Live Activities, TRMNL and web.
- Networking changes beyond **fetch on return** (below): request order, cadences and timeouts
  otherwise stay as they are.
- The widget's App Group snapshot keeps being written exactly as today.

## Anti-goals (a failure even if it works)

- **Cartoony.** No bouncing, scaling or emoji. The first mockup's pulsing icons were rejected as
  too cartoony. Motion should look native and quiet.
- **Lying while loading.** No card may say something is missing or unknown when it is just
  waiting.
- **Layout jumps** when a card switches state.

## Decided with the owner

### Card states

Every Home card (Live power, Today so far, Current bill, Smart Shift) is in exactly one state:

| State | Shows |
|---|---|
| **Waiting** | The card's story: symbol plus a rotating line, at the card's final size. |
| **Slow** | Still waiting 10 s after the card started waiting. The story keeps going, but the line becomes "Taking longer than usual…". The card does **not** break just for being slow. |
| **Broken** | The card's request failed. The symbol swaps to a broken symbol with iOS's replace animation, the motion stops, and the card shows a failure line plus "Pull down to try again." Other cards are unaffected. |
| **Loaded** | The real content, which pops in when its data arrives. |

Pull-to-refresh returns every Broken card to Waiting.

### Symbols and motion

Motion uses SF Symbols' native effects, which the owner chose over hand-drawn icons:

- Symbols with variable-colour layers use the **variable colour** effect (iterative: segments light
  up in turn, like Wi-Fi bars while connecting).
- Symbols without those layers **breathe** (a slow opacity fade, about 2.4 s per cycle).
- Story lines cross-fade slowly, about every 2 s.

| Card | Waiting symbol | Effect | Broken symbol |
|---|---|---|---|
| Live power | `bolt.fill` (matches the app icon) | breathe | `bolt.slash.fill` |
| Today so far | `chart.bar.xaxis` | variable colour | `exclamationmark.triangle` |
| Current bill | `dollarsign.circle` | variable colour | `exclamationmark.triangle` |
| Smart Shift | `timer` | breathe | `exclamationmark.triangle` |

Broken symbols are tinted the orange already used by the `AvailabilityBanner`.

### Freshness rule (replaces showing old readings)

The decision is made per card, both on cold launch and when the app returns from the background:

- A card whose reading is **15 minutes old or less** shows that reading immediately, as **Loaded**.
- If the reading is **older** than that, the card starts in **Waiting**. The old values are not
  drawn, not even greyed out.

### Fetch on return

A card that enters Waiting must always have a request on the way. On cold launch, and on return
from the background, every endpoint feeding a Waiting card is fetched immediately, bypassing its
normal cadence. In practice:

- **`live`** feeds Today and Smart Shift. A Waiting card here bypasses `summaryInterval`.
- **`bill`** feeds Current bill. A Waiting card here bypasses `billInterval`.
- **`power`** is already force-fetched on activation.

The owner chose this over matching each card's freshness limit to its cadence. The cost, at most
one extra bill estimate and one extra summary request per return, is accepted.

## Copy

These lines are my drafts, written to fit `docs/voice-and-terms.md`: plain, calm, no "sorry", and
"rate period" rather than "window". The owner can edit them freely.

| Card | Story lines (rotate) | Broken line |
|---|---|---|
| Live power | "Reaching your Powerwall…" · "Checking your solar…" · "Reading the grid…" | "Couldn’t reach your Powerwall." |
| Today so far | "Adding up today’s energy…" · "Counting kilowatt-hours…" | "Couldn’t load today’s energy." |
| Current bill | "Estimating your bill…" · "Applying your rate plan…" | "Couldn’t estimate your bill." |
| Smart Shift | "Checking your rate periods…" · "Finding the cheapest times…" | "Couldn’t check your rate periods." |

All of them use "Taking longer than usual…" for Slow and "Pull down to try again." as the broken
hint.

## How it maps onto the code today (context for the builder)

From a read of the current code:

- **Views.** `DashboardView.swift` contains the Today, Bill and Smart Shift sections.
  `DashboardView+Live.swift` contains Live. `LivePowerFlowCards.swift` holds `LoadingCard`,
  `EmptyCard` and `AvailabilityBanner`. Nothing in the app uses `.redacted`, shimmer or skeletons.
- **Store.** `DashboardCoordinator` publishes three `DashboardEndpointState`s: `power`, `live` and
  `bill`. Each carries `response`, `lastSuccess`, `isRestored` and `isUnavailable`. There is no
  explicit loading flag; "loading" is implied by `response == nil && !isUnavailable`.
- **Which endpoint feeds which card:**
  - Live power reads `power`, falling back to a snapshot built from `live`.
  - Today and Smart Shift read `live`. Smart Shift's rate also needs `bill`'s currency; leave that
    later fill-in as it is.
  - Current bill reads `bill`.
  - So a `live` failure breaks Today and Smart Shift together. Live power breaks only when neither
    `power` nor a `live` snapshot is available.
- **Cache.** `DashboardCache.restoreCachedReadings()` restores `live` and `bill` with `savedAt` and
  sets `isRestored`. The freshness rule hooks in here, plus on scene activation for in-memory
  responses.
- **Copy that must stop showing while loading:**
  - Today's fallback `EmptyCard("Energy data unavailable")` (`DashboardView.swift` ~:202).
  - Smart Shift's `loadTimingSummary` with `live == nil`, which yields "No rate plan is set up"
    (`DashboardPresentation.swift` ~:221).
  - Bill's text-only "Bill estimate is loading" (~:258).
  - Live's `LoadingCard`.
- **Copy that stays.** "Last readings" / "Flow unknown" stay *only* when a **freshly fetched**
  reading reports stale Powerwall data, because then they are true.

## Left to the builder

- **Card state.** How Waiting, Slow, Broken and Loaded are modelled, for example a small per-card
  enum derived in `DashboardPresentation` (testable) from the endpoint states plus a
  "waiting since" timestamp.
- **Fixed waiting heights.** How the waiting heights are fixed, whether by rendering the real
  layout hidden or by measuring. The requirement is no visible jump.
- **The pop-in.** A short opacity and scale transition; a gentle spring is fine. No bounce, matching
  the anti-goal.
- **Reduce Motion.** Symbols stay still, lines still change (cross-fade or instant), and the
  pop-in becomes a plain fade.
- **VoiceOver.** A waiting card reads as one element, for example "Live power, loading". A broken
  card reads its failure line and hint.
- **Tests.** Unit tests for the state derivation and the freshness rule. Follow the repo's TDD
  habit and iOS lint/warning rules (`cmd/ios-app/AGENTS.md`).

## My calls (not explicitly confirmed by the owner)

- The 15-minute freshness limit applies to the Bill card as well, even though the bill only
  refreshes about every 30 minutes. In practice the Bill card will often start in Waiting after a
  gap.
- The 10 s Slow timer is per card, measured from when that card entered Waiting.
- **Failure with fresh data on hand.** A card goes Broken only when its request fails *and* it has
  nothing within the 15-minute limit to show. If a refresh fails while the card holds fresh data, it
  stays Loaded and the existing stale-readings banner covers it.
- **The freshness rule applies on arrival only** (launch, site switch, return from the background,
  re-auth). A reading shown during a session stays shown as it ages, covered by the stale banner,
  so a card never flips back to its story mid-session (the bill refreshes only every 30 minutes).
- **Reading age is fetch time.** Age is measured from when the response was fetched (`lastSuccess`
  / cache `savedAt`), not from the data's own timestamps. Today's `energyDataThrough` normally lags
  well past 15 minutes, so using it would almost always show the story.
  - The background save (`storeLive(..., at: now())` at the moment the app goes to the background)
    must preserve the original fetch time instead of stamping the save time. Otherwise an
    hour-old reading saved at backgrounding would look fresh.
- **Home only.** The freshness rule hides old values on Home only. It does not clear them from
  `DashboardCoordinator`, so the Bill tab, the Smart Shift tab and the widget snapshot behave as
  before.
- The broken-symbol choices and the orange tint.
- All the copy above.
