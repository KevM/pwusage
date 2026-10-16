# Smart Shift & Battery Saver Copy Design

## Intent

"Load Timing" is a noun/verb combination the owner never liked, and the copy
around it reads like engineering notes ("Your observed tariff surplus covers
this run's estimated energy"). "Battery Hold" is being renamed too. This project
renames both features and rewrites the surrounding user-facing text so the app
sounds like the owner explains it:

> Time your heavy energy use for when grid power is cheapest, and save your
> battery for when rates spike.

The voice, rules and word list are recorded in
[`docs/voice-and-terms.md`](../../voice-and-terms.md); that file is the source of
truth and this design does not repeat it.

## Goals

- Every user-facing string on every surface uses the word list:
  **Smart Shift** (was Load Timing), **Battery Saver** (was Battery Hold),
  **job** (was load / load profile / run), **export cushion** (was surplus /
  billing-cycle balance), **import gap** (was deficit), **Even** (was Balanced),
  **grid rate** (was buy / marginal / tariff rate), **net export / net import**
  for daily grid totals, **rate plan** (was tariff), and **Home / home use**
  for the house's power draw (was load). Battery Saver's detected heavy use is
  a **job** too (user decision: load → job).
- Copy follows the voice: plain, benefit first, honest about estimates, calm.
- iOS-only identifiers that a user or the system can see are renamed while the
  app is unreleased (user decision):
  - URL `pwusage://battery-hold` → `pwusage://battery-saver`
  - Control kind `fm.rodeo.pwusage.battery-hold` → `fm.rodeo.pwusage.battery-saver`
  - Control / Live Activity / App Intent display names and descriptions
- New symbols: Battery Saver `bolt.shield`, Smart Shift `bolt.badge.clock`,
  Bill `receipt` (tab/sidebar use is in the navigation design; this project
  applies `bolt.shield` to the Control Center control, Live Activity and
  toolbar label).

## Surfaces in scope

| Surface | Where |
|---|---|
| iOS app | Smart Shift page, job list/editor sheet (`LoadProfilesSheet`), job details sheet, Home card, Battery Saver sheet and sections, alerts, banners, VoiceOver labels/hints, previews' visible strings |
| iOS extensions | Battery Saver Control Center control, Live Activity (lock screen + Dynamic Island), Today Energy widgets where they show surplus/deficit |
| Web app | Live page cards (`BatteryHoldCard`, `LiveDetailView`, `DailyTotalsRow`, `SankeyCard`, run-now widget), live stats and dashboard cards ("Load" tile → "Home"), charts and the NILM/analysis page ("Load Power", "Detected Load Events"), Settings and tariff pages (→ rate plans), Support and Privacy pages |
| Rate plans | iOS Settings "Rate Plans" row and the rate plan screen (`TariffSheet` content), every "tariff" string on iOS, web and TRMNL |
| TRMNL | Section titles/labels in markup and the manage page's option labels |

## Non-goals

- Renaming web API routes, cron paths, database tables/columns, or stored
  config keys (user has no strong preference; production migration cost for no
  visible gain).
- Renaming Swift types, files or TypeScript modules (`LoadTimingView`,
  `BatteryHold*`, `load-timing.ts`). Code keeps matching the server's
  `battery-hold` / `load-timing` routes and tables; only strings and the two
  iOS identifiers above change. (My call.)
- Changing behaviour, calculations, or layout. Copy only, plus symbols.
- The navigation rework (separate design,
  `2026-10-16-ios-sidebar-navigation-design.md`), which ships first and only
  renames tab label, page titles and the Home card heading.

## Anti-goals

- A rename that leaves both vocabularies on screen at once on any surface.
- Battery Saver copy that could be read as saving the *phone's* battery. The
  first mention on each surface says it saves the Powerwall charge.
- Losing precision: numbers, units and "about/estimated" qualifiers stay;
  only the words around them get simpler.
- Bare "job": always qualified ("Start a job", "Shift your job", or the job's
  name). Outside Smart Shift, name the job.

## Constraints

- Ship after the navigation rework lands; both touch `DashboardView`,
  `LoadTimingView` and Battery Saver views, so they run one after the other,
  never in parallel.
- Changing the control kind removes any already-added control on dev devices;
  re-add it after installing. Control Center caches control artwork until the
  device restarts, so the new `bolt.shield` icon may not show until then.
- Old `pwusage://battery-hold` links: keep accepting them as an alias of
  `battery-saver` so controls and Live Activities already on dev devices still
  open the right screen. (My call; cheap.) The QR codes are web links through
  `/continue` and are unaffected.
- Tests that assert strings (about 18 iOS test files, 19 web test files) are
  updated to the new copy, not loosened.
- The privacy policy is a legal page: change terms only, keep meaning
  identical, and bump its "last updated" date.

## Approach (decided)

1. Rewrite iOS app strings by area (Smart Shift, jobs sheet, Battery Saver,
   Home/Dashboard presentation helpers), applying the word list and the
   examples table in `voice-and-terms.md`.
2. iOS extensions: control, Live Activity, widgets; rename the two identifiers;
   add the `battery-hold` URL alias.
3. Web app and TRMNL strings.
4. Final sweep: grep for every "Don't use" term across user-facing strings on
   all surfaces; anything left is either fixed or listed as intentionally kept
   (code identifiers, API paths).

## Left to the builder

- Exact wording of each string, within the voice and word list. Flag any
  string where the plain version loses meaning, rather than forcing it.
- Order of commits within each step.
- Whether `LoadProfilesSheet`'s built-in job names ("Car charge", etc.) need
  rewording beyond the word list ("EV charging" vs "Car charge").

## Verification

- iOS `./run-tests.sh`, web `npm test`, `npm run lint`, `npm run build` pass.
- The final-sweep grep is clean for user-facing strings.
- Manual check of the Smart Shift page, jobs sheet, Battery Saver sheet,
  Control Center control, Live Activity, web live page and a TRMNL render.
- A `pwusage://battery-hold` link and a `pwusage://battery-saver` link both
  open Battery Saver for the right site.
