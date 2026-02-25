# Track: Add Compact Header Live-Data Sparklines

## Objective
Explore and implement a compact header live-data presentation that adds short 4-hour sparklines for solar, grid, and load that integrate the current live reading with recent history, while replacing the battery percentage text with a battery glyph and preserving header usability on narrow screens.

- User-visible change: Header live data shows battery (glyph-first) plus short sparklines for `solar`, `grid`, and `load` in that order.
- Layout goal: Keep the live-data area no taller than the current header live-data block.
- Priority goal: Preserve header focus on logo, live data, and action buttons; site title text may be hidden/removed on narrow screens if needed.
- Follow-up QA goal: Improve battery glyph vertical centering and make header row stacking transition cleanly across narrowing breakpoints (title hides first, then live data stacks above actions at very narrow widths).

## Scope
Implement compact sparkline-capable header live data in the Next.js app header.

### In Scope
- `cmd/next-app/src/components/HeaderLiveStats.tsx` compact layout/content refactor
- `cmd/next-app/src/components/GlobalHeader.tsx` responsive priority/layout tuning (logo/live/actions first; title can be dropped on narrow screens)
- `cmd/next-app/src/app/api/site-live-data/route.ts` response extension for 4-hour sparkline series
- `cmd/next-app/src/lib/site-live-data-client.ts` client type updates for new sparkline payload
- Small shared UI extraction(s) for compact sparkline rendering and/or battery glyph metric if needed
- Targeted tests for new data shaping/render logic if added

### Out of Scope
- TRMNL markup/live-data rendering changes
- Poll cadence changes (keep existing header polling unless bug fix is required)
- Tesla API live fetch behavior changes beyond adding DB-backed sparkline history to the route response
- Broad header redesign unrelated to compact live-data presentation
- Historical charts outside the header or longer time windows than 4 hours

## Constraints
- Active app is `cmd/next-app` (Next.js App Router, TypeScript, Tailwind)
- Keep `HeaderLiveStats` auth redirect, loading state, error fallback, and polling behavior intact
- Prefer DB-backed history for sparklines (avoid extra Tesla API calls; Tesla cost/cadence constraints)
- Use recent `EnergyData` rows (5-minute resolution expected) for the last 4 hours
- Sparklines must be visually short and compact; do not increase header live-data height versus current design
- Battery metric must be left-most within the metrics row and use a battery glyph instead of percentage text
- Remaining metric order must be `solar`, `grid`, `load`
- Site title text next to logo can be hidden/removed at narrow widths if required to preserve logo/live/actions
- No `any` types
- Final validation required before completion: `npm run lint`, `npm run test`, `npm run build`

## Acceptance Criteria
- [ ] Header live-data metrics are ordered `battery`, `solar`, `grid`, `load`
- [ ] Battery percentage text is replaced by a battery glyph presentation (with existing charge/discharge semantic cues preserved where practical)
- [ ] Solar, grid, and load each render a short sparkline representing the last 4 hours of history plus the current live reading
- [ ] Sparkline data is sourced from DB history (not additional live Tesla history requests per header refresh)
- [ ] Header live-data block remains no taller than the current compact live-data header block (manual visual QA)
- [ ] Header remains usable on narrow screens with logo, live data, and action buttons visible/prioritized; site title may be hidden if necessary
- [ ] Battery glyph is vertically centered relative to the battery metric text row (no visible baseline droop)
- [ ] Wide header layout remains unchanged/usable when space is ample
- [ ] As the window narrows, the site title disappears before live-data/action-button layout begins breaking
- [ ] At very narrow widths, the live-data block stacks above the action buttons (not below them)
- [ ] Existing `HeaderLiveStats` polling, auth redirect (`401 -> /login`), loading, and unavailable behaviors still work
- [ ] `npm run lint` passes
- [ ] `npm run test` passes
- [ ] `npm run build` passes
- [ ] PR summary draft includes manual QA notes (mobile + desktop header layout and sparkline readability)

## Plan

### Step 1: Establish dedicated worktree/branch for `livedata-sparklines` execution
Goal:
- Ensure execution happens in a dedicated git worktree with a commit checkpoint per step

Changes:
- Worktree + branch setup only (no product code changes required)
- `cmd/next-app/tracks/livedata-sparklines/Track.md` (notes/status only)

Verification:
- `git worktree list`
- `git branch --show-current`

Status: `done`
Notes:
- Use branch name `codex/livedata-sparklines` (or confirm an existing branch/worktree if already created).
- If this Track is executed from the main workspace, record the blocker and stop until a dedicated worktree is available.
- Created dedicated worktree at `/tmp/wt-livedata-sparklines` on branch `codex/livedata-sparklines`.
- Copied the canonical Track into the worktree so all track state and code changes can be committed from the dedicated branch.

### Step 2: Audit current header dimensions and define sparkline payload/render spec
Goal:
- Convert the requested UI behavior into an implementation-ready spec with size constraints and data contract details

Changes:
- `cmd/next-app/tracks/livedata-sparklines/Track.md` (audit notes and decisions only)

Verification:
- Manual code inspection of `cmd/next-app/src/components/HeaderLiveStats.tsx`
- Manual code inspection of `cmd/next-app/src/components/GlobalHeader.tsx`
- Manual code inspection of `cmd/next-app/src/app/api/site-live-data/route.ts`
- Manual code inspection of `cmd/next-app/src/lib/energy-repo.ts`

Status: `done`
Notes:
- Record the exact current header live-data shell/chip height classes and target compactness approach before editing UI.
- Define sparkline data shape (timestamps + metric values, normalization rules, null/empty behavior).
- Define how the current live reading is merged with DB history (append final point, de-dup near-identical timestamps, precedence rules).
- Decide grid sparkline sign convention (import/export) and how it is visually encoded while keeping the displayed numeric value semantics intact.
- Current compact shell baseline in `HeaderLiveStats` is `px-2.5 py-1.5` with `gap-1.5` (`LiveStatsShell`); new populated layout should stay within that vertical envelope (no larger y-padding or taller metric content).
- `GlobalHeader` already prioritizes logo, live-data slot, and action buttons via flex ordering; the `Powerwall Usage` title is already hidden below `md` (`hidden ... md:block`), so narrow-screen fit can be solved without additional title changes unless Step 6 reveals wrap regressions.
- Sparkline payload contract (proposed): add `sparklines` object to `/api/site-live-data` with `solar`, `grid`, `load` arrays of `{ timestamp: string; watts: number }`.
- Window/merge rule: fetch DB history for `[now-4h, now)`, then append one live point at request time using live status values; if the newest DB row is within ~5 minutes of `now`, keep both only when timestamps differ, otherwise prefer the live point as the final point.
- Grid sign convention for sparkline: preserve signed watts (`+` import, `-` export) in the series so the line can encode direction; displayed chip value can continue using absolute value + semantic color as today.
- Empty/partial history behavior: render available points plus live point; if fewer than 2 points, render a placeholder/flat sparkline in Step 4.

### Step 3: Extend `/api/site-live-data` and client types with 4-hour sparkline series data
Goal:
- Add a DB-backed sparkline payload for the last 4 hours and merge in the current live reading without changing live-data polling/auth behavior

Changes:
- `cmd/next-app/src/app/api/site-live-data/route.ts`
- `cmd/next-app/src/lib/site-live-data-client.ts`
- `cmd/next-app/src/lib/energy-repo.ts` (only if a small helper method improves reuse/readability)
- Optional targeted route/repo tests if test coverage exists or is practical

Verification:
- `npm run lint -- src/app/api/site-live-data/route.ts src/lib/site-live-data-client.ts src/lib/energy-repo.ts`
- Targeted tests for new data shaping logic (if added)
- Manual response inspection via local request to `/api/site-live-data?siteId=<id>` in dev (confirm new sparkline fields present and bounded to ~4 hours)

Status: `done`
Notes:
- Prefer reusing `EnergyRepo.getRawEnergyData(...)` for a `now - 4h` to `now` window, then merge/append the current live reading and map to a compact payload (likely ~48 historical points plus one live point).
- Keep response size reasonable and include only fields needed for header sparklines (`solar`, `grid`, `load`, timestamp).
- Do not block on Tesla history APIs.
- Implemented `/api/site-live-data` `sparklines` payload with signed `watts` points for `solar`, `grid`, and `load`, using `repo.getRawEnergyData(siteId, now-4h, now)`.
- Route now fetches live status, site metadata, and DB history in parallel (`Promise.all`) after auth/token setup, then appends a final live point (exact timestamp replacement only if identical ISO timestamp already exists).
- Added client-side TypeScript types in `src/lib/site-live-data-client.ts` (`SiteLiveSparklinePoint`, `SiteLiveSparklines`) and made `SiteLiveData.sparklines` optional for backward-compatible rendering during rollout.
- Verification: `npm run lint -- src/app/api/site-live-data/route.ts src/lib/site-live-data-client.ts` ✅
- Manual response inspection in browser/dev route was not run in this terminal pass because a concrete `siteId` was not supplied to the runner.

### Step 4: Add a compact header sparkline primitive and battery glyph metric presentation
Goal:
- Introduce the minimal reusable rendering pieces needed for tiny inline sparklines and glyph-first battery display

Changes:
- `cmd/next-app/src/components/ui/*` (new compact sparkline and/or battery glyph metric helper if justified)
- `cmd/next-app/src/components/HeaderLiveStats.tsx` (initial wiring to new primitives as needed)

Verification:
- `npm run lint -- src/components/HeaderLiveStats.tsx` plus targeted lint for any new `src/components/ui` file(s)
- Manual code review for compact sizing classes and light/dark theme readability

Status: `done`
Notes:
- Keep the sparkline primitive intentionally small and header-focused (avoid introducing a full chart system).
- Ensure empty/partial history renders gracefully (fallback line, placeholder, or omitted sparkline).
- Preserve existing semantic coloring where it aids quick scanning.
- Added `src/components/ui/MiniSparkline.tsx`, a small SVG sparkline primitive for header telemetry with:
- empty/1-point fallbacks
- compact `32x12` viewbox sizing
- optional zero baseline rendering (`includeZero`) for signed metrics like grid
- Added `src/components/ui/BatteryStatusGlyph.tsx`, a compact battery glyph that visualizes percentage fill and overlays charge/discharge cues from `powerWatts`.
- Intentionally deferred `HeaderLiveStats` integration to Step 5 to keep this step focused on reusable primitives and rendering math.
- Verification: `npm run lint -- src/components/HeaderLiveStats.tsx src/components/ui/MiniSparkline.tsx src/components/ui/BatteryStatusGlyph.tsx` ✅

### Step 5: Refactor `HeaderLiveStats` metric order/layout for compact sparkline telemetry
Goal:
- Render the requested metric order and fit short sparklines into the existing header live-data footprint without increasing height

Changes:
- `cmd/next-app/src/components/HeaderLiveStats.tsx`
- Optional targeted tests for formatting/render order logic

Verification:
- `npm run lint -- src/components/HeaderLiveStats.tsx`
- Targeted component tests (if added)
- Manual smoke check of loading, unavailable, and populated states (desktop + narrow/mobile)

Status: `done`
Notes:
- Required populated order: `battery` (left-most), `solar`, `grid`, `load`.
- Battery uses a glyph instead of percentage text; retain power/state cue(s) if possible.
- Maintain the compact shell and avoid vertical growth (prefer reduced padding/gaps, horizontal compression, and optional title suppression in `GlobalHeader` handled next).
- Preserve polling interval, abort cleanup, and unauthorized redirect behavior.
- `HeaderLiveStats` now consumes the optional `sparklines` payload and renders populated metrics in the required order: `battery`, `solar`, `grid`, `load`.
- Replaced battery percent text with `BatteryStatusGlyph` (fill level from `percentageCharged`, charge/discharge cue overlay from `batteryPower`), keeping battery semantic color styling and the battery tooltip title with percentage.
- Added short inline `MiniSparkline` renderers for `solar`, `grid`, and `load` using live+history points from `stats.sparklines`; grid sparkline uses `includeZero` to preserve signed import/export shape.
- Preserved existing polling interval (2 minutes), abort handling, auth redirect (`401 -> /login`), and loading/unavailable states.
- Verification: `npm run lint -- src/components/HeaderLiveStats.tsx` ✅
- Manual smoke check of header states/layout was not run by the runner (dev server is available at `http://localhost:5174` for interactive QA).

### Step 6: Tune `GlobalHeader` responsive priorities for narrow screens
Goal:
- Ensure logo, compact live-data telemetry, and action buttons remain the primary header content on narrow screens

Changes:
- `cmd/next-app/src/components/GlobalHeader.tsx`

Verification:
- `npm run lint -- src/components/GlobalHeader.tsx`
- Manual smoke check on routes with and without `siteId` (desktop + narrow/mobile widths)

Status: `skipped`
Notes:
- It is acceptable to hide/remove the `Powerwall Usage` title text beside the logo at narrower breakpoints to preserve space.
- Keep action buttons accessible and avoid wrapping that makes the live-data section taller.
- `GlobalHeader` already satisfies the requested narrow-screen priority constraints without code changes:
- title text is hidden below `md` (`hidden ... md:block`)
- layout ordering already prioritizes logo, action buttons, and live-data slot across breakpoints
- No additional `GlobalHeader` changes were required after the compact sparkline refactor in Step 5.
- Verification: `npm run lint -- src/components/GlobalHeader.tsx` ✅
- Manual mobile/narrow smoke check remains for interactive QA in the running dev server (`http://localhost:5174`).

### Step 7: Final validation, manual QA notes, and PR summary draft
Goal:
- Run full validation and record implementation/testing results and follow-ups

Changes:
- `cmd/next-app/tracks/livedata-sparklines/Track.md` (execution notes/results only)

Verification:
- `npm run lint`
- `npm run test`
- `npm run build`

Status: `done`
Notes:
- Manual QA checklist should include:
- desktop header with site selected
- narrow/mobile header with site selected
- header without `siteId`
- loading state, unavailable state, populated state
- sparkline readability and metric order confirmation
- live point inclusion/placement in each sparkline (not history-only)
- Record any follow-up ideas (e.g., smoothing, color tuning, tooltip/debug aids) separately from acceptance.
- Final validation results in `/tmp/wt-livedata-sparklines/cmd/next-app`:
- `npm run lint` ✅
- `npm run test` ✅ (7 files / 25 tests)
- `npm run build` ✅
- Initial `npm run build` attempt failed with a TypeScript conflict in `MiniSparkline` (`points` prop name collided with native SVG `points` attribute). Fixed in Step 7 by renaming the prop to `series` and updating `HeaderLiveStats` call sites, then reran full validation successfully.
- Dev server remained available during implementation and validation at `http://localhost:5174` using `npx next dev -p 5174` in the dedicated worktree (`.env` symlinked from the main checkout).
- PR summary draft:
- Summary: Add compact header live-data sparklines (solar/grid/load) with a battery glyph-first metric, using live data merged with the last 4 hours of DB history.
- What changed:
- `/api/site-live-data` now returns `sparklines` for `solar`, `grid`, and `load` built from `EnergyData` history plus a final live point.
- `HeaderLiveStats` renders populated metrics in the order `battery`, `solar`, `grid`, `load`, replaces battery percentage text with a battery glyph, and adds short inline sparklines for solar/grid/load.
- Added compact UI primitives `MiniSparkline` and `BatteryStatusGlyph`.
- `GlobalHeader` required no code changes because narrow-screen title suppression and content ordering already matched the requested priorities.
- Non-goals / unchanged: polling cadence, auth redirect behavior, loading/unavailable behavior, and TRMNL rendering remain unchanged.
- Manual QA by runner not completed (terminal-only); interactive QA can be performed against the running dev server.
- Post-PR interactive QA follow-up (user report): fixed sparkline history/live unit mismatch in `/api/site-live-data` by converting historical `EnergyData` interval values (Wh) to average watts before appending live Tesla watt readings. This prevents end-of-line spikes (especially visible on solar).

### Step 8: Re-audit header breakpoint failures and define responsive stacking targets (follow-up QA)
Goal:
- Convert post-PR QA feedback into concrete breakpoint/layout targets for a small responsive header follow-up

Changes:
- `cmd/next-app/tracks/livedata-sparklines/Track.md` (follow-up audit/spec notes only)

Verification:
- Manual code inspection of `cmd/next-app/src/components/GlobalHeader.tsx`
- Manual code inspection of `cmd/next-app/src/components/HeaderLiveStats.tsx`
- Manual visual QA in the worktree dev server across wide, medium, and very narrow widths

Status: `done`
Notes:
- Capture the specific breakpoints where:
- battery glyph appears vertically off-center relative to battery text
- live-data chips begin wrapping awkwardly
- action buttons jump above the live-data row
- Define the desired stacking sequence explicitly:
- wide: current layout (logo / live data / actions)
- medium: site title hidden first
- narrow: live data row above actions row
- Interactive QA feedback (user) confirms the main remaining issues are:
- battery glyph sits slightly low relative to the battery chip text baseline/centerline
- as width shrinks, header content degrades before the title is removed
- on very narrow widths, action buttons appear above the live-data row (undesired)
- Code audit findings:
- `GlobalHeader` title currently shows at `md+` (`hidden ... md:block`); this can leave a range where title still consumes width while live/actions are already crowded.
- Mobile order classes currently set actions `order-2` and live stats `order-3`, which guarantees actions render above live data whenever rows wrap.
- `HeaderLiveStats` battery glyph is rendered inside the `LiveMetricChip` value slot (`span` with text styling), so baseline/line-height behavior can visually drop the SVG unless the value wrapper is forced into centered flex alignment.
- Implementation target for follow-up:
- hide the site title at a wider breakpoint than the current failure point (or otherwise earlier than metric/action breakage)
- ensure narrow stacked order is logo -> live data -> actions
- apply a minimal battery glyph alignment fix without changing battery chip content/order

### Step 9: Vertically center battery glyph within the compact battery metric chip
Goal:
- Fix battery glyph alignment so it is visually centered with the battery metric label/value row

Changes:
- `cmd/next-app/src/components/HeaderLiveStats.tsx`
- `cmd/next-app/src/components/ui/BatteryStatusGlyph.tsx` (only if SVG sizing/viewbox/baseline adjustment is required)
- `cmd/next-app/src/components/ui/LiveMetricChip.tsx` (only if chip alignment behavior needs a small shared adjustment)

Verification:
- `npm run lint -- src/components/HeaderLiveStats.tsx src/components/ui/BatteryStatusGlyph.tsx src/components/ui/LiveMetricChip.tsx`
- Manual visual QA of populated header state at desktop and narrow widths (battery chip alignment)

Status: `done`
Notes:
- Keep battery metric ordering/content the same (`battery` left-most, glyph replacing percentage text).
- Prefer minimal alignment fixes (wrapper alignment class or glyph SVG vertical metrics) before changing chip structure.
- Implemented a minimal alignment fix in `HeaderLiveStats` only:
- battery chip `valueClassName` now forces centered inline flex layout with `leading-none`
- battery glyph wrapper uses `inline-flex items-center self-center leading-none`
- `BatteryStatusGlyph` is rendered as `block` inside the wrapper to avoid inline-SVG baseline droop
- Battery metric content/order remains unchanged (`battery` left-most, glyph replaces percentage text).
- Verification: `npm run lint -- src/components/HeaderLiveStats.tsx src/components/ui/BatteryStatusGlyph.tsx src/components/ui/LiveMetricChip.tsx` ✅
- Manual visual QA remains pending in the running dev server.

### Step 10: Rework `GlobalHeader` responsive ordering so live data stays above action buttons on very narrow screens
Goal:
- Preserve a clean responsive transition: title hides first, then live data stacks above actions when space becomes constrained

Changes:
- `cmd/next-app/src/components/GlobalHeader.tsx`
- `cmd/next-app/src/components/HeaderLiveStats.tsx` (only if a small width/wrapping tweak is needed to support the new stacking behavior)

Verification:
- `npm run lint -- src/components/GlobalHeader.tsx src/components/HeaderLiveStats.tsx`
- Manual visual QA at multiple widths (wide / medium / very narrow) with a selected site

Status: `done`
Notes:
- Desired order behavior:
- wide: logo + title, live data, actions (current successful layout)
- medium: hide title before header content starts breaking
- very narrow: logo row first, live data row second, actions row third (live data above actions)
- Keep action buttons accessible and avoid increasing live-data height unnecessarily.
- Updated `GlobalHeader` responsive behavior:
- site title now renders only at `xl+` (`hidden ... xl:block`) so it drops out earlier as width narrows
- mobile order changed to logo (1) -> live data (2) -> actions (3), while desktop order remains logo / live / actions
- This ensures that when rows stack on narrow widths, the live-data block appears above the action buttons.
- No `HeaderLiveStats` changes were required for this step beyond the Step 9 alignment fix.
- Verification: `npm run lint -- src/components/GlobalHeader.tsx src/components/HeaderLiveStats.tsx` ✅
- Manual visual QA across breakpoints remains pending in the running dev server.

### Step 11: Follow-up validation and PR update summary for responsive polish
Goal:
- Validate the follow-up UI polish changes and document updated manual QA coverage for breakpoint behavior

Changes:
- `cmd/next-app/tracks/livedata-sparklines/Track.md` (follow-up execution notes/results only)

Verification:
- `npm run lint`
- `npm run test`
- `npm run build`

Status: `done`
Notes:
- Manual QA checklist for this follow-up should explicitly include:
- battery glyph vertical centering in populated state
- wide layout unchanged
- title-hide transition before breakage
- very narrow layout with live data above action buttons
- Update the open PR summary/comment as needed with the responsive polish changes.
- Follow-up validation results in `/tmp/wt-livedata-sparklines/cmd/next-app`:
- `npm run lint` ✅
- `npm run test` ✅ (7 files / 25 tests)
- `npm run build` ✅
- Manual QA status:
- user already confirmed the earlier solar sparkline trend fix looks better
- battery centering + responsive stacking changes are ready for interactive verification in the running worktree dev server (`http://localhost:5174`)
- Existing PR will be updated by pushing additional commits to `codex/livedata-sparklines` (no new PR needed).
- Follow-up PR summary delta:
- battery glyph vertically centered in the battery live metric chip
- `GlobalHeader` now hides the site title earlier (`xl+` only) and stacks live data above action buttons on small screens

## Execution Log
- 2026-02-25: Created initial execution-ready Track for compact header live-data sparklines (battery glyph + solar/grid/load 4-hour sparklines) based on user requirements. No implementation work performed in this planning run.
- 2026-02-25: Step 1 done in dedicated worktree `/tmp/wt-livedata-sparklines` on `codex/livedata-sparklines`; verified worktree/branch state and canonical Track presence in the worktree.
- 2026-02-25: Step 2 done (audit/spec). Confirmed current header compact shell sizing, verified header title is already hidden on narrow screens, and defined a live+history sparkline payload/merge strategy for solar/grid/load.
- 2026-02-25: Step 3 done. Extended `/api/site-live-data` with DB-backed `sparklines` (`solar/grid/load`) merged with the current live point and updated client TypeScript types; targeted lint passed.
- 2026-02-25: Step 4 done. Added compact header-focused UI primitives (`MiniSparkline`, `BatteryStatusGlyph`) with placeholder handling and optional zero baseline support; targeted lint passed.
- 2026-02-25: Step 5 done. Wired compact header telemetry to use a battery glyph plus `solar/grid/load` inline sparklines (live + history) in the requested order; targeted lint passed.
- 2026-02-25: Step 6 skipped (no code changes needed). `GlobalHeader` already hides the title on narrow screens and preserves requested logo/live/actions priorities; targeted lint passed.
- 2026-02-25: Step 7 done. Full validation (`lint`, `test`, `build`) passed after a final-step TypeScript fix (`MiniSparkline` prop rename `points` -> `series`); added PR summary draft and QA checklist notes.
- 2026-02-25: Post-review QA follow-up. Corrected `/api/site-live-data` sparkline history units (Wh -> average W) to align historical points with the appended live Tesla watt reading after user observed a solar end spike.
- 2026-02-25: Replanned follow-up work after interactive QA feedback. Appended Steps 8-11 for battery glyph vertical centering and breakpoint-specific header stacking behavior (title hides first; live data moves above actions on very narrow screens).
- 2026-02-25: Step 8 done (follow-up QA audit/spec). Captured user-reported alignment and breakpoint failures, traced them to `GlobalHeader` mobile order classes and title breakpoint visibility, and defined the follow-up responsive stacking/alignment targets.
- 2026-02-25: Step 9 done. Applied a minimal battery glyph vertical-centering fix in `HeaderLiveStats` (centered inline-flex value wrapper + block SVG); targeted lint passed.
- 2026-02-25: Step 10 done. Tuned `GlobalHeader` breakpoints to hide the title earlier (`xl+` only) and changed mobile stacking order to logo -> live data -> actions; targeted lint passed.
- 2026-02-25: Step 11 done. Follow-up validation (`lint`, `test`, `build`) passed for battery alignment and responsive header stacking changes; prepared PR update notes for the existing open PR.
