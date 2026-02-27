# Track: History Chart Style Guide Color Alignment

## Objective
Align the `/site/[id]?view=history` usage history chart colors with the app style guide and the live site-data header color semantics, without changing chart data behavior or Tesla/API fetch behavior.

- User-visible change: The history chart legend/lines/tooltip use a palette that better matches the existing header live metrics (solar, grid, load, battery).
- Technical change: Centralize or normalize history chart series color mapping in `NILMChart.tsx` (and optionally a small shared palette helper) instead of ad-hoc hard-coded values.
- Why now: The current history chart uses a conflicting palette (notably purple load + brown grid) that does not match the updated header styling and style guide direction.

## Scope
### In Scope
- `cmd/next-app/src/components/NILMChart.tsx` color mapping for legend dots, line traces, tooltip labels/values, and related chart annotations that depend on series colors
- Small internal `NILMChart.tsx` cleanup to reduce repeated nested JSX/inline color duplication when it directly supports the color alignment change
- `cmd/next-app/src/components/LoadAnalysisClientPage.tsx` only if needed for chart theming props/plumbing (expected minimal or none)
- Optional small shared color helper (for chart/header palette consistency) if it keeps the change small and improves reuse
- Style guide/demo update only if a reusable palette/token helper is introduced and documented

### Out of Scope
- Changes to `/api/site/[id]/analysis` behavior, load detection, or Tesla data ingestion
- Chart layout redesign, feature additions, or non-color visual overhaul
- Tariff schedule logic or tariff region timing calculations
- DB schema/migrations
- TRMNL markup/routes

## Constraints
- Active app code is under `cmd/next-app`
- Next.js App Router + TypeScript + Tailwind CSS
- No `any` types
- Prefer existing style-guide/Tailwind colors first; avoid adding new semantic colors unless necessary
- If style-guide color tokens are insufficient for an acceptable result, pause and get user assistance before adding new colors/tokens
- Keep history route behavior/functionality unchanged (data loading, interactions, toggles, hover/selection)
- Preserve header live-status behavior and existing header color semantics as the reference palette source
- Prefer simplification by configuration/helpers over broad component decomposition unless a new helper clearly improves readability
- Must pass before completion: `npm run lint`, `npm run test`, `npm run build`

## Acceptance Criteria
- [ ] History chart `Load`, `Solar`, `Battery`, and `Grid` series colors align with the live header palette direction (or a documented, approved approximation using existing colors)
- [ ] Chart legend toggles, line traces, and tooltip metric rows use the same per-series mapping consistently
- [ ] Battery SoC color remains readable and intentionally mapped (can match battery family or remain a documented complementary shade)
- [ ] Any sign/direction-based exceptions for `Grid`/`Battery` (import/export, charge/discharge) are documented and intentionally handled
- [ ] No regressions to chart interactions (hover tooltip, series toggles, load event highlighting, SoC sub-chart)
- [ ] `npm run lint` passes
- [ ] `npm run test` passes
- [ ] `npm run build` passes
- [ ] PR summary draft prepared with before/after screenshots for `/site/2252268092126997?view=history`

## Plan

### Step 1: Establish dedicated worktree/branch and capture baseline screenshots
Goal:
- Create/verify a dedicated worktree and branch for this workstream and capture the current history-chart appearance for comparison.

Changes:
- `cmd/next-app/tracks/history-styleguide/Track.md` (execution notes only)

Verification:
- `git worktree list`
- `git branch --show-current` (inside worktree; expected branch like `codex/history-styleguide`)
- Manual screenshot/notes of `/site/2252268092126997?view=history` (light/dark if available)

Status: `pending`
Notes:
- Use one commit per completed step in the dedicated worktree.
- If local dev server conflicts with port `5173`, use the repo’s `dev:agent` flow or `next start` per project notes.

### Step 2: Audit current series color usage and define target palette mapping
Goal:
- Inventory all places the history chart uses series colors and define the exact mapping to header live metric colors (including light/dark and directional caveats).

Changes:
- `cmd/next-app/tracks/history-styleguide/Track.md` (audit notes and mapping decisions)

Verification:
- Manual code inspection of `cmd/next-app/src/components/NILMChart.tsx`
- Manual code inspection of `cmd/next-app/src/components/HeaderLiveStats.tsx`
- Manual inspection of `cmd/next-app/src/app/styleguide/page.tsx` for reusable color/token patterns

Status: `pending`
Notes:
- Explicitly decide how to handle `Grid` and `Battery` direction/state semantics vs single-color line traces:
- If sign-aware line coloring is too large for this workstream, choose an approved static base color aligned with header semantics and document the tradeoff.
- Record whether existing Tailwind/style-guide colors are sufficient; if not, mark blocker and request user help before adding new colors.

### Step 3: Simplify `NILMChart` series rendering structure (targeted cleanup)
Goal:
- Reduce repeated nested JSX and duplicated per-series logic so the color alignment change is smaller, safer, and easier to maintain.

Changes:
- `cmd/next-app/src/components/NILMChart.tsx`

Verification:
- `npm run lint -- src/components/NILMChart.tsx`
- Manual code review confirming repeated legend/line definitions are consolidated (for example via a series config array and mapped rendering)
- Manual QA spot check that toggles/tooltips still behave the same before final color tuning

Status: `pending`
Notes:
- Keep this step tightly scoped:
- Good simplifications: shared series config (`load/solar/battery/grid`), mapped legend rendering, mapped `<Line>` rendering, helper(s) for per-series display labels/colors.
- Avoid risky rewrites of tooltip behavior, event highlighting, or axis/tariff logic in this step.
- Recharts JSX nesting will remain to some extent; the goal is to reduce duplication and local complexity, not replace the chart library.

### Step 4: Centralize chart series color mapping for history view
Goal:
- Implement a single source of truth for history chart series colors (within `NILMChart.tsx` or a small shared helper) to remove scattered hard-coded mismatches.

Changes:
- `cmd/next-app/src/components/NILMChart.tsx`
- Optional: `cmd/next-app/src/lib/*` or `cmd/next-app/src/components/*` helper file if extraction is justified

Verification:
- `npm run lint -- src/components/NILMChart.tsx`
- If a helper is added, targeted lint for that file too
- Manual code review to confirm no orphaned old series color constants remain

Status: `pending`
Notes:
- Keep the step focused on palette consolidation and mapping constants/functions only (not all visual retuning at once).
- Favor commit-sized extraction that makes later color updates low-risk.

### Step 5: Apply mapped colors across legend, traces, tooltip, and SoC-related chart elements
Goal:
- Update the history chart rendering to consistently use the new mapping everywhere users see the series colors.

Changes:
- `cmd/next-app/src/components/NILMChart.tsx`

Verification:
- `npm run lint -- src/components/NILMChart.tsx`
- Manual QA on `/site/2252268092126997?view=history`:
- Confirm legend dots/toggles, line traces, tooltip rows, and SoC visuals use the intended palette in light/dark modes
- Confirm load-event highlight/tariff overlays remain visually distinct after series color changes

Status: `pending`
Notes:
- Be careful not to accidentally change non-series accent colors (tariff overlays, selected load regions) unless needed for readability.
- If readability degrades (especially grid vs event overlays), split/adjust with a follow-up micro-step and document rationale.

### Step 6: Optional style guide/demo documentation update (only if shared palette helper/token is introduced)
Goal:
- Document the reusable energy-series palette mapping if the implementation extracts a shared helper or adds style-guide-facing API.

Changes:
- `cmd/next-app/src/app/styleguide/page.tsx` (if needed)
- `cmd/next-app/tracks/history-styleguide/Track.md` (decision/notes)

Verification:
- `npm run lint -- src/app/styleguide/page.tsx` (if changed)
- Manual review of style guide example/docs section (if changed)

Status: `pending`
Notes:
- Mark `skipped` if the change stays local to `NILMChart.tsx` with no reusable API/token surface.

### Step 7: Final validation, visual regression check, and PR-ready summary
Goal:
- Run full validation, record final color decisions/tradeoffs, and prepare a concise PR summary with screenshots/manual QA notes.

Changes:
- `cmd/next-app/tracks/history-styleguide/Track.md` (execution notes/results only)

Verification:
- `npm run lint`
- `npm run test`
- `npm run build`
- Manual before/after comparison on `/site/2252268092126997?view=history`

Status: `pending`
Notes:
- Include explicit notes on:
- Final `solar/grid/load/battery` mapping (light + dark)
- Any directional behavior retained only in tooltip/header (vs line traces)
- Whether additional style-guide colors are still desired for future refinement

## Execution Log
- 2026-02-25: Created initial execution-ready track plan for history chart style-guide color alignment. Inspected `NILMChart.tsx`, `HeaderLiveStats.tsx`, `LoadAnalysisClientPage.tsx`, and existing track patterns. No implementation work performed in this planning run.
