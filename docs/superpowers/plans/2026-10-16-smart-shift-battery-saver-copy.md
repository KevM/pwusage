# Smart Shift & Battery Saver Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite every user-facing string on iOS, iOS extensions, web and TRMNL to the agreed voice and word list, and rename the two iOS-visible identifiers for Battery Saver.

**Architecture:** Copy-only change, done surface by surface. Each task first updates the tests that assert the old strings, then the strings. Code identifiers, API routes, cron paths, DB names and stored config keys stay. A final grep sweep proves no "Don't use" term remains in user-facing text.

**Tech Stack:** SwiftUI + Swift Testing (`cmd/ios-app`, `./run-tests.sh`), Next.js + Vitest (`cmd/next-app`, `npm test`, `npm run lint`, `npm run build`).

**Spec:** `docs/superpowers/specs/2026-10-16-smart-shift-battery-saver-copy-design.md`. Word list and voice (source of truth for every string): `docs/voice-and-terms.md`.

## Global Constraints

- Starts only after the navigation branch (`feat/ios-sidebar-navigation`) has merged to `main`; branch `feat/smart-shift-copy` from that `main`.
- Word list (`docs/voice-and-terms.md`): Smart Shift, Battery Saver, job, export cushion, import gap, Even, rate plan, rate period, grid rate, Home / home use, net export / net import, billing cycle. Every "Don't use" term is gone from user-facing strings.
- "job" is never bare: qualify with an action, owner or the job's name. Outside Smart Shift, name the job.
- First mention of Battery Saver on each surface says it saves the Powerwall charge.
- Title case for navigation titles, tab labels, buttons; sentence case for body, captions, VoiceOver hints. No dashes as sentence separators; use "·" for metadata.
- Keep every number, unit and "about/estimated" qualifier.
- Billing-cycle per-period values → export cushion / import gap / Even. Daily or live grid totals → net export / net import.
- Unchanged: Swift/TS identifiers and file names, `/api/**` routes, cron paths, DB tables/columns, TRMNL stored config keys, `MobileSite`/API JSON field names.
- Never push. Stage explicit paths only.

## Review Focus

1. A rate period with exactly 0 kWh balance → "Even", not "Import gap 0 kWh" (test in Task 1).
2. Sign conventions differ between `loadBalance` (negative = cushion) and `liveLoadBalance` (positive net export = cushion); a rewrite must not flip them (tests in Task 1).
3. An old `pwusage://battery-hold?site=…` link from a control or Live Activity added before the rename still opens Battery Saver (test in Task 5).
4. VoiceOver strings still read numbers in words ("kilowatt-hours") after the rewrite (tests in Task 1 and Task 2).
5. TRMNL markup stays under 500 KB and the section still renders when no rate plan is configured (test in Task 7).

---

### Task 1: iOS presentation helpers (cushion, gap, rate plan)

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/DashboardPresentation.swift` (`tariffBalance`, `loadBalance`, `liveLoadBalance`, both accessibility variants, `loadTimingSummary` unavailable texts ~247-258, `hasActiveTariff` callers' labels)
- Modify: `cmd/ios-app/PWUsage/Views/DashboardView.swift`, `BillView.swift` (headings and labels using "tariff", "Surplus", "Load timing")
- Test: `cmd/ios-app/PWUsageTests/DashboardPresentationTests.swift`

Exact copy for the balance helpers (status word + amount):
- cushion → `"Export cushion \(amount)"`, gap → `"Import gap \(amount)"`, zero → `"Even"`, nil → `"Not measured yet"`.
- Accessibility: same words with "kilowatt-hours", e.g. `"Import gap 12 kilowatt-hours"`, zero → `"Even"`.
- "Active tariff · X" → "Rate plan · X"; "No active tariff is configured" → "No rate plan for this site"; "Waiting for active tariff" → "Waiting for a rate plan".

- [ ] **Step 1: Update the tests first** — add, for each helper, the three sign cases and nil:

```swift
@Test("Billing-cycle balances read as export cushion, import gap or even")
func cycleBalanceWords() {
    #expect(DashboardPresentation.loadBalance(-3.2) == "Export cushion 3.2 kWh")
    #expect(DashboardPresentation.loadBalance(12) == "Import gap 12 kWh")
    #expect(DashboardPresentation.loadBalance(0) == "Even")
    #expect(DashboardPresentation.loadBalance(nil) == "Not measured yet")
    #expect(DashboardPresentation.liveLoadBalance(3.2) == "Export cushion 3.2 kWh")
    #expect(DashboardPresentation.liveLoadBalance(-12) == "Import gap 12 kWh")
    #expect(DashboardPresentation.loadBalanceAccessibilityLabel(12) == "Import gap 12 kilowatt-hours")
}
```

  Amounts keep `loadEnergyNumber`'s existing formatting; match the numbers in these expectations to what today's tests show for the same inputs. Replace every existing assertion on "Surplus"/"Deficit"/"Balanced"/"No balance yet"/"Load timing unavailable".
- [ ] **Step 2: Run** `./run-tests.sh DashboardPresentationTests` → FAIL.
- [ ] **Step 3: Rewrite the helpers and the Home/Bill strings** per the word list (Bill's "Tariff period balances" → "Rate periods this billing cycle").
- [ ] **Step 4: Run** → PASS. Fix callers that branch on `hasPrefix("Surplus")` (`DashboardView` load-timing card colour) to branch on the numeric sign instead.
- [ ] **Step 5: Commit** — `copy(ios): export cushion, import gap and rate plan in shared helpers`

---

### Task 2: Smart Shift page

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/LoadTimingView.swift`, `LoadTimingForecastPresentation.swift`
- Test: `cmd/ios-app/PWUsageTests/LoadTimingViewTests.swift`, `LoadTimingRecommendationTests.swift`, `LoadTimingForecastEstimatorTests.swift`

Pinned rewrites (from `voice-and-terms.md` Examples): "Good fit now" → "Good time to start" / "Your export cushion covers this job."; "Your surplus won't cover a full load." → "Your export cushion won't cover this whole job."; segment lines → "3.2 kWh from your export cushion · 1.1 kWh at the grid rate" and "No export cushion here yet · priced at the grid rate"; "Explore another load" → "Try Another Job"; "Load run details" / "Load Run Details" → "Job Details"; "Loading load timing" → "Loading Smart Shift"; "Tariff data needed" → "Add a Rate Plan" / "Smart Shift needs your rate plan to compare costs."; "Cheaper time · Lower marginal rate in X" → "Cheaper time · Lower rate in X". Everything else: rewrite to the voice, keeping each message's meaning and numbers.

- [ ] **Step 1: Update the tests first** — every assertion on a changed string in the three test files, using the pinned copy above.
- [ ] **Step 2: Run** `./run-tests.sh LoadTimingViewTests LoadTimingRecommendationTests LoadTimingForecastEstimatorTests` → FAIL.
- [ ] **Step 3: Rewrite the strings.** Flag in the commit body any string where the plain version would lose meaning and was kept closer to the original.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `copy(ios): Smart Shift page in plain language`

---

### Task 3: Jobs sheet

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/LoadProfilesSheet.swift`, `cmd/ios-app/PWUsage/Models/LoadProfile.swift` (built-in display names only, not stored IDs)
- Test: `cmd/ios-app/PWUsageTests/LoadProfileStoreTests.swift`

Pinned: title "Load Profiles" → "Jobs"; "Add custom load" → "Add Custom Job"; "Custom load" → "Custom job"; "New Custom Load" → "New Custom Job"; "Delete Custom Load" → "Delete Custom Job"; "Load name" → "Job name"; "Load estimate" → "Estimate"; Smart Shift toolbar button label "Manage load profiles" → "Manage jobs". Built-in "Car charge" → "EV charging" (spec leaves this to the builder; this plan decides it).

- [ ] **Step 1: Update tests asserting these strings.**
- [ ] **Step 2: Run** `./run-tests.sh LoadProfileStoreTests` → FAIL.
- [ ] **Step 3: Rewrite.** Persisted profile IDs/kinds must not change (existing saved jobs keep loading).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `copy(ios): load profiles become jobs`

---

### Task 4: Battery Saver in the app

**Files:**
- Modify: `cmd/ios-app/PWUsage/Views/battery-hold-*.swift`, `cmd/ios-app/PWUsage/Models/battery-hold-failure.swift`, `cmd/ios-app/PWUsage/PWUsageApp.swift` (navigation alert title "Battery Hold" and its messages)
- Test: `cmd/ios-app/PWUsageTests/battery-hold-tests.swift`, `battery-hold-coordinator-tests.swift`, `battery-hold-preview-tests.swift`

Pinned: alert title "Battery Saver"; "hold"/"holding" as a noun or verb → Battery Saver on/off, "saving your Powerwall at 80%"; "Stopping a hold restores the reserve saved when it started." → "Turning off Battery Saver restores your previous backup reserve."; "Detected load: about X kW" → "Job detected · about X kW"; "Watching home usage for a large load to finish" → "Waiting for a job to finish". The setup section's first line explains it saves the Powerwall charge for when rates spike.

- [ ] **Step 1: Update tests asserting these strings.**
- [ ] **Step 2: Run** the three suites → FAIL.
- [ ] **Step 3: Rewrite.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `copy(ios): Battery Saver in the app`

---

### Task 5: iOS extensions and identifiers

**Files:**
- Modify: `cmd/ios-app/Shared/battery-hold-navigation.swift` (kind, symbol, intent title, `BatteryHoldLink`), `cmd/ios-app/PWUsageWidgets/battery-hold-control.swift`, `battery-hold-live-activity.swift`, `cmd/ios-app/Shared/battery-hold-activity-views.swift`, `battery-hold-activity-presentation.swift`, `today-energy-presentation.swift`, `cmd/ios-app/PWUsage/PWUsageApp.swift:356` (`openNavigationURL` host check)
- Test: `cmd/ios-app/PWUsageTests/battery-hold-navigation-tests.swift`, `battery-hold-activity-presentation-tests.swift`, `battery-hold-activity-render-tests.swift`, `today-energy-widget-tests.swift`

Pinned:
- `BatteryHoldControlIdentity.kind = "fm.rodeo.pwusage.battery-saver"`; `symbolName = "bolt.shield"` (read the README section the existing comment points to first; note the Control Center restart requirement in the commit body).
- `BatteryHoldLink.url` builds host `battery-saver`; `siteID(from:)` and `openNavigationURL` accept hosts `battery-saver` and `battery-hold`.
- Intent title "Open Battery Saver"; control `.displayName("pwusage Battery Saver")`, description "Open pwusage to turn Battery Saver on or off for your Powerwall. Sign in to the app first to choose a site."
- Live Activity: "Load finished" → "Job finished"; "Load dropped, confirming" → "Job ending · confirming"; "Home load" → "Home use".

- [ ] **Step 1: Write the failing tests**

```swift
@Test("Battery Saver links use the new host and still accept the old one")
func batterySaverLinkHosts() {
    #expect(BatteryHoldLink.url(siteID: "s1").absoluteString == "pwusage://battery-saver?site=s1")
    #expect(BatteryHoldLink.siteID(from: URL(string: "pwusage://battery-saver?site=s1")!) == "s1")
    #expect(BatteryHoldLink.siteID(from: URL(string: "pwusage://battery-hold?site=s1")!) == "s1")
}
```

  Plus updated string assertions in the activity and widget suites.
- [ ] **Step 2: Run** the four suites → FAIL.
- [ ] **Step 3: Implement** the identifier, alias and copy changes.
- [ ] **Step 4: Run** `./run-tests.sh` → PASS (also `PWUsageAppModelTests`, whose control-launch tests build URLs through `BatteryHoldLink`).
- [ ] **Step 5: Device note** — after install, re-add the control in Control Center; the icon may need a device restart.
- [ ] **Step 6: Commit** — `copy(ios): Battery Saver control, Live Activity and link host`

---

### Task 6: Web app

**Files:**
- Modify: `cmd/next-app/src/components/site/live/BatteryHoldCard.tsx`, `ConfirmHoldModal.tsx`, `LiveDetailView.tsx`, `DailyTotalsRow.tsx`, `SankeyCard.tsx`, `PeriodCardRow.tsx`, `RunLoadNowWidget.tsx`, `battery-hold-format.ts`, `src/components/site/SettingsView.tsx`, `src/components/ui/LoadHeadroomGlyph.tsx` (labels/aria only), `SiteLiveStats.tsx`, `DashboardCards.tsx`, `NILMChart.tsx`, `LoadAnalysisClientPage.tsx`, tariff list/editor pages, `src/app/support/page.tsx`, `src/app/privacy/page.tsx`
- Test: the co-located `*.test.ts(x)` files asserting these strings (19 files reference old terms)

Pinned: "Load timing" → "Smart Shift"; "Run load now" → "Start a Job Now"; "Load" tile / "Load: x kW" → "Home" / "Home: x kW"; "Load Power (kW)" → "Home use (kW)"; "Detected Load Events" → "Detected Jobs"; "Tag Load Event" → "Name This Job"; "Battery Hold Quick Link (QR)" → "Battery Saver Quick Link (QR)"; tariff UI → rate plan; daily grid "Surplus/Deficit" → "Net export/Net import"; cycle per-period → export cushion / import gap / Even. Privacy page: change terms only, keep meaning, bump "Last updated" to the commit date.

- [ ] **Step 1: Update the string assertions in the affected tests.**
- [ ] **Step 2: Run** `cd cmd/next-app && npm test -- --run` → FAIL on the updated assertions.
- [ ] **Step 3: Rewrite the strings.**
- [ ] **Step 4: Run** `npm test -- --run && npm run lint && npm run build` → all pass.
- [ ] **Step 5: Commit** — `copy(web): Smart Shift, Battery Saver, jobs and rate plans`

---

### Task 7: TRMNL

**Files:**
- Modify: `cmd/next-app/src/lib/trmnl/sections/load-timing.ts`, `src/lib/trmnl-renderer.ts`, `src/lib/trmnl/layout-engine.ts` (titles only), `src/lib/trmnl-component-config.ts` (labels only, not keys), `src/app/trmnl/manage/page.tsx`, `src/app/api/trmnl/markup/route.ts` (copy only)
- Test: co-located TRMNL tests

Pinned: section title "Smart Shift"; "Configure a tariff to see load timing" → "Add a rate plan to see Smart Shift"; "Load timing this cycle" → "Smart Shift this billing cycle".

- [ ] **Step 1: Update tests; add one asserting the no-rate-plan render contains "Add a rate plan to see Smart Shift" and markup length < 500_000.**
- [ ] **Step 2: Run** `npm test -- --run src/lib/trmnl` → FAIL.
- [ ] **Step 3: Rewrite.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `copy(trmnl): Smart Shift and rate plan`

---

### Task 8: Sweep and verification

- [ ] **Step 1: Sweep** — from the repo root:

```bash
rg -n -i '"[^"]*(load timing|battery hold|surplus|deficit|balanced|tariff|load profile|custom load|marginal rate|buy rate)[^"]*"' cmd/ios-app/PWUsage cmd/ios-app/Shared cmd/ios-app/PWUsageWidgets
rg -n -i '>[^<{]*(load timing|battery hold|surplus|deficit|tariff|run load)[^<{]*<|(aria-label|title|label)="[^"]*(load|hold|tariff|surplus)' cmd/next-app/src --glob '!**/*.test.*'
```

  Expected: no user-facing hits. List any intentional survivors (code identifiers, log messages, API field names) in the PR description.
- [ ] **Step 2:** `cd cmd/ios-app && ./run-tests.sh`; `cd cmd/next-app && npm test -- --run && npm run lint && npm run build` → all pass.
- [ ] **Step 3: Manual** — iOS simulator: Smart Shift page, Jobs sheet, Job Details, Battery Saver sheet, Live Activity; `xcrun simctl openurl booted "pwusage://battery-hold?site=<id>"` and `…battery-saver…` both open Battery Saver. Web (`npm run dev:agent`, port 5174): live page, settings, rate plans, analysis. One TRMNL markup render via `/api/trmnl/markup`.
- [ ] **Step 4:** Note anything unverified for the hand-off; do not push.
