# Battery hold Live Activity: drawn battery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the battery hold Live Activity a drawn battery (live charge fill + held-reserve line), a pwusage glyph, and live battery % / home load from the first frame.

**Architecture:** The server adds `battery_percent` / `live_at` to the hold's `monitoring` JSONB, seeded at hold start from the `live_status` `parkBattery` already fetched and refreshed on each monitor check through `refreshLiveStatus`. APNs maps it to `batteryPercent`. iOS draws the battery from SwiftUI shapes, with geometry in a pure, tested `BatteryGaugeGeometry`.

**Tech Stack:** Next.js / TypeScript / Vitest (cmd/next-app); SwiftUI, ActivityKit, WidgetKit, Swift Testing, XcodeGen (cmd/ios-app).

**Spec:** `docs/superpowers/specs/2026-10-16-battery-hold-live-activity-battery-design.md`

## Global Constraints

- Content-state schema stays 1; new keys are optional and older payloads omit them.
- Monitor: `MONITOR_SITE_BUDGET_MS` 10s per site, 40s overall, Vercel Hobby 60s cap.
- Live status: `refreshLiveStatus` with `cacheTtlMs` 2 minutes (the claim interval follows it), bounded timeout; a failure never fails the check.
- Detection and phase stay history-based. `waiting_for_data` copy is kept.
- Unknown charge draws no fill. Battery % shown rounded; fill uses the unrounded value clamped 0…100.
- Auto "Safety stop by …" only in the last 60 minutes; timer "Stops …" always.
- iOS 17+ APIs, no new entitlements. Control Center keeps `bolt.batteryblock`.

## Review Focus

- A cached live status older than the TTL (claim lost, another instance in flight): must not be presented as this check's reading → monitor discards a status whose `fetchedAt` is older than the TTL (Task 2 test).
- `live_status` with a non-finite `percentage_charged` or `load_power`, or an unparseable `timestamp`: the field is null, never NaN in JSON (Task 1 test).
- A hung live-status call: the check still records history-based monitoring within the site budget (Task 2 timing test).
- Charge above 100 / below 0 or a hold line at 100%: fill and line stay inside the outline (Task 4 test).
- A monitoring write failure at park: the hold still succeeds and is returned without monitoring (Task 1 test).

---

### Task 1: Server monitoring snapshot with live status (summarize + seed + park)

**Files:**
- Modify: `cmd/next-app/src/lib/battery-hold-monitoring.ts`, `cmd/next-app/src/lib/battery-hold-service.ts`
- Test: `cmd/next-app/src/lib/battery-hold-monitoring.test.ts`, `cmd/next-app/src/lib/battery-hold-service.test.ts`

**Interfaces:**
- Produces: `BatteryHoldMonitoring.battery_percent?: number | null`, `live_at?: string | null`;
  `type HoldLiveStatus = Pick<EnergySiteLiveStatus, 'percentage_charged' | 'load_power' | 'timestamp'>`;
  `summarizeHoldMonitoring(hold, power, now, decision, live?: HoldLiveStatus | null)`;
  `seedHoldMonitoring(hold: BatteryHold, live: HoldLiveStatus, now: Date): BatteryHoldMonitoring`.

Rules: with a finite live load, `home_load_w = round(load_power)`, `sampled_at = live_at ?? now`; Auto `peak_load_w = round(max(history peak, live load))`; timer holds get `home_load_w`/`sampled_at` but no baseline/peak. Seed: phase `watching` (Auto) / `timer`, `baseline_load_w` Auto only. `parkBattery` writes the seed via `repo.recordMonitoring`, returns the hold with it; a write failure logs and returns the hold without monitoring.

- [ ] Tests: live fields filled; non-finite → null; peak is max(history, live); stale history keeps `waiting_for_data` with live figures; timer hold live load only; seed for both modes; park returns hold with monitoring and survives a write failure.
- [ ] Run vitest on both files: FAIL. Implement. Run: PASS. Commit.

### Task 2: Monitor fetches live status for both modes

**Files:**
- Modify: `cmd/next-app/src/lib/battery-hold-monitor-service.ts`
- Test: `battery-hold-monitor-service.test.ts`, `battery-hold-monitor-timing.test.ts`

**Interfaces:**
- Consumes: `refreshLiveStatus(siteId, { cacheTtlMs, timeoutMs })` from `today-refresh.ts`; Task 1's `summarizeHoldMonitoring(..., live)`.
- Produces: `MONITOR_LIVE_TTL_MS = 2 * 60_000`, `MONITOR_LIVE_BUDGET_MS = 4000`.

When there is no decision and no pending restore attempt, run `withIoDeadline(MONITOR_LIVE_BUDGET_MS, refreshLiveStatus(...))` concurrently with the Auto history refresh (timer: alone); any failure or `fetchedAt` older than `MONITOR_LIVE_TTL_MS` → null.

- [ ] Tests: timer and Auto holds call `refreshLiveStatus` with `cacheTtlMs: 120000`; the live reading reaches `recordMonitoring`; an error / old cached reading is dropped; no call for expired holds. Timing test mocks a hung `refreshLiveStatus` and still passes.
- [ ] FAIL → implement → PASS. Commit.

### Task 3: APNs payload and delivery doc

**Files:** Modify `battery-hold-apns.ts`, `battery-hold-apns.test.ts`, `docs/battery-hold-live-activity-delivery.md`.

- [ ] Test `batteryPercent` mapped from `monitoring.battery_percent`, null when absent. FAIL → add `batteryPercent: number | null` → PASS. Document `battery_percent`, `live_at`, `batteryPercent` and the live load source. Run `npm run build`, `npm run lint`, `npm test`. Commit.

### Task 4: iOS contract, glyph asset, drawn battery geometry

**Files:**
- Modify: `Shared/battery-hold-activity-attributes.swift`, `PWUsage/Models/battery-hold-monitoring.swift`, `PWUsage/Models/battery-hold-activity-content.swift`
- Create: `Shared/Shared.xcassets/pwusage-glyph.imageset/` (SVG, preserves vector, template), `Shared/battery-gauge.swift`
- Test: `PWUsageTests/battery-hold-activity-contract-tests.swift`, `PWUsageTests/battery-gauge-tests.swift`

**Interfaces:**
- Produces: `ContentState.batteryPercent: Double?`; `BatteryHoldMonitoring.batteryPercent` (`battery_percent`);
  `enum BatteryGaugeStyle { case card, bar, mini }`;
  `struct BatteryGaugeGeometry { init(style:size:charge:holdLevel:); body: CGRect; nub: CGRect; fill: CGRect?; holdLine: CGRect? }` (hold line is a full-height rect in the body for card/bar, extends `tickOverhang` above and below for mini);
  `struct BatteryGaugeView: View { charge: Double?; holdLevel: Int?; style; isStale; isFinal }`.

- [ ] Tests: decode with/without `batteryPercent`; `ContentState(hold:)` carries it; geometry: nil charge → nil fill; 82 → fill width 82% of inner width; >100/<0 clamped; hold 100 stays inside; mini tick overhangs body; final → no hold line.
- [ ] FAIL → implement → PASS (`run-tests.sh` filtered). Commit.

### Task 5: Presentation copy, Lock Screen, Dynamic Island, previews

**Files:** Modify `Shared/battery-hold-activity-presentation.swift`, `PWUsageWidgets/battery-hold-live-activity.swift`, `PWUsageTests/battery-hold-activity-presentation-tests.swift`.

**Interfaces:** `BatteryHoldActivityPresentation.glyphName = "pwusage-glyph"` (replaces `symbolName`); `batteryText(_:) -> String?` ("Battery 82%"); `detail` prefixes "Battery N% · " and lowercases the first letter of the rest; `deadline` hides Auto safety stop until `safetyExpiresAt - now <= 3600`; phase nil keeps "Waiting for the first home load check." (the seed makes it rare; with a charge it reads "Battery 74% · waiting for the first home load check.").

- [ ] Tests: "Battery 82% · watching home load."; no prefix without charge; waiting_for_data keeps the warning with prefix; stale copy unprefixed; Auto deadline nil at 2h, present at 59 min; timer always; glyph name.
- [ ] FAIL → implement → PASS. Restyle the views (layout B, option C, previews: above hold, at hold, unknown, stale, timer, restored). Build widget scheme; full `run-tests.sh`. Commit.
