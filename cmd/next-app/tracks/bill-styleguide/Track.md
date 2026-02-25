# Track: Align Estimated Monthly Bill Views With Style Guide

## Objective
Rework the Estimated Monthly Bill views to match the style guide and remove the current disclosure-heavy interaction in favor of a compact, always-visible table/card presentation.

- User-visible change: Bill pages look consistent with the style guide and present tariff/TOU detail in a compact layout without disclosure toggles.
- Technical change: `BillSummary` rendering is refactored away from expandable sections toward reusable style-guide-aligned table/card composition.
- Why now: The current disclosure UI is visually dense/clunky for bill review and does not align with the newer app design system.
- Follow-up polish requested after first pass: remove active tariff badge + blue outline treatment, simplify active TOU badge label to `Active`, remove the bill Rates column, and tighten styling toward style-guide card presentation.

## Scope
Update the bill summary presentation used by both bill entry points:
- `/site/[id]?view=bill` (site tab bill view)
- `/site/[id]/usage?date=YYYY-MM-DD` (full estimated monthly bill page)

### In Scope
- `cmd/next-app/src/components/BillSummary.tsx` layout/interaction refactor
- `cmd/next-app/src/components/site/EstimatedBillView.tsx` layout polish if needed
- Wiring updates in:
  - `cmd/next-app/src/app/site/[id]/page.tsx`
  - `cmd/next-app/src/app/site/[id]/usage/page.tsx`
- Small shared UI extraction(s) in `cmd/next-app/src/components/ui` if repeated compact bill patterns emerge
- Optional style guide documentation/example update if a reusable bill summary/table pattern is introduced

### Out of Scope
- Billing math/calculation logic changes (cost, usage, tariff grouping semantics)
- API/data-fetch changes (`energy-repo`, sync/import logic)
- Tariff selection behavior or date-navigation behavior changes (except visual/layout integration)
- New bill analytics features

## Constraints
- Active Next.js app is under `cmd/next-app`
- Next.js App Router + TypeScript + Tailwind CSS
- Use style guide primitives/components where practical (`SectionCard`, `Table`, `Badge`, `Typography`, etc.)
- No `any` TypeScript types
- Preserve existing bill data grouping and totals semantics
- Avoid disclosure/collapse UI for the main bill detail presentation after the rework
- Must pass before completion: `npm run lint`, `npm run test`, `npm run build`
- Execution will happen in a dedicated worktree with one commit per step

## Acceptance Criteria
- [x] Both bill entry points render a style-guide-aligned compact bill summary layout
- [x] Detail rows are visible without disclosure toggles/collapsible sections
- [ ] Layout remains readable on mobile and desktop (compact table/card approach)
- [x] Active tariff / active TOU context remains clearly indicated where applicable
- [x] Active tariff emphasis no longer uses a badge or custom blue outline/box treatment
- [x] Active TOU badge label reads `Active` (not `Active TOU`)
- [x] Bill detail presentation no longer shows a `Rates` column/field
- [x] Bill totals and per-period values match existing calculations (no intentional data logic changes)
- [ ] Any reusable compact bill UI pattern extracted is documented/used consistently
- [x] `npm run lint` passes
- [x] `npm run test` passes
- [x] `npm run build` passes
- [x] PR summary draft includes route coverage and notes on disclosure removal / compact layout tradeoffs

## Plan

### Step 1: Establish dedicated worktree/branch and bootstrap app dependencies
Goal:
- Ensure the track runs in a dedicated worktree/branch with a working `cmd/next-app` install before implementation begins

Changes:
- `cmd/next-app/tracks/bill-styleguide/Track.md` (status/notes only)

Verification:
- `git worktree list` shows a dedicated worktree for `codex/bill-styleguide` (or equivalent chosen branch)
- `git branch --show-current` in that worktree
- `cd cmd/next-app && npm install`

Status: `done`
Notes:
- Required by track execution policy (one track per dedicated worktree, one commit per step).
- Dedicated worktree created at `/tmp/pwusage-bill-styleguide` on branch `codex/bill-styleguide`.
- Seeded the canonical track file into the worktree from the user-authored untracked track in the primary checkout to preserve canonical path usage during execution.
- Ran `npm install` in `cmd/next-app` successfully (fresh worktree bootstrap).

### Step 2: Audit current bill summary/disclosure UX and define compact target layout
Goal:
- Inventory where bill disclosures are implemented and define a concrete replacement layout plan for mobile/desktop

Changes:
- `cmd/next-app/tracks/bill-styleguide/Track.md` (audit notes only)

Verification:
- Manual code inspection of:
  - `cmd/next-app/src/components/BillSummary.tsx`
  - `cmd/next-app/src/components/site/EstimatedBillView.tsx`
  - `cmd/next-app/src/app/site/[id]/page.tsx`
  - `cmd/next-app/src/app/site/[id]/usage/page.tsx`

Status: `done`
Notes:
- `BillSummary` currently owns disclosure state via `expandedPeriods` and `togglePeriod`, with repeated expandable blocks for each TOU period and a separate expandable total row.
- `/site/[id]?view=bill` uses `BillSummary` with default collapsible behavior and active tariff/TOU highlighting (`activeTariffId`, `activeTouName`).
- `/site/[id]/usage` uses `BillSummary alwaysExpanded={true}`, which removes chevrons but still renders the disclosure-oriented expanded block layout.
- Current layout is verbose and duplicates large “equation” row structures for each TOU and total; this is the main target for compact table/card redesign.
- Compact replacement target:
  - one card per tariff (active tariff visibly marked)
  - compact rows (table on desktop, stacked rows/cards on mobile if needed)
  - always-visible TOU detail + total row (no disclosures)
  - preserve active TOU emphasis in tab bill view

### Step 3: Add/adjust shared compact bill presentation primitives (if needed)
Goal:
- Introduce the smallest reusable UI helper(s) needed for compact bill rows/cards without coupling to billing math

Changes:
- `cmd/next-app/src/components/ui/*` (only if justified)
- Optional small helper component under `cmd/next-app/src/components/` for bill presentation scaffolding

Verification:
- Targeted lint for any new/changed component files
- Manual code review for mobile/desktop class behavior

Status: `skipped`
Notes:
- Mark `skipped` if existing `SectionCard` + `Table` primitives are sufficient.
- Inspected existing UI primitives and confirmed `SectionCard`, `Table`, and `Badge` cover the compact bill layout needs without introducing new shared billing-specific primitives.
- Will implement compact presentation directly in `BillSummary` using existing style-guide components/classes.

### Step 4: Refactor `BillSummary` to compact non-disclosure layout (shared behavior)
Goal:
- Replace the disclosure-driven layout with a compact always-visible summary while preserving grouping/totals semantics

Changes:
- `cmd/next-app/src/components/BillSummary.tsx`
- Optional related helper files from Step 3

Verification:
- `npm run lint -- src/components/BillSummary.tsx` (plus any helper files)
- Targeted tests if added
- Manual smoke check on both bill entry routes using the dedicated worktree dev server

Status: `done`
Notes:
- Preserve:
  - tariff grouping and TOU grouping semantics
  - active tariff / active TOU highlighting inputs
  - total row calculations
  - `alwaysExpanded` compatibility only if still needed during transition (can be removed if fully obsolete and callers are updated in the same/next step)
- Replaced disclosure-driven UI/state in `BillSummary` with an always-visible compact layout: tariff cards, desktop TOU table, mobile TOU cards, and explicit per-tariff totals.
- Preserved grouping/totals semantics and active tariff/active TOU highlighting inputs; `alwaysExpanded` prop remains accepted for caller compatibility during route cleanup.
- Verification: `npm run lint -- src/components/BillSummary.tsx` passed. Manual route smoke check deferred to Step 5/final QA after wrapper integration changes.

### Step 5: Update route wrappers/pages for style-guide-aligned bill view integration
Goal:
- Align bill page wrappers around the new compact `BillSummary` presentation and remove obsolete props/assumptions

Changes:
- `cmd/next-app/src/components/site/EstimatedBillView.tsx` (if needed)
- `cmd/next-app/src/app/site/[id]/page.tsx` (if needed)
- `cmd/next-app/src/app/site/[id]/usage/page.tsx` (if needed)

Verification:
- `npm run lint -- 'src/app/site/[id]/page.tsx' 'src/app/site/[id]/usage/page.tsx' src/components/site/EstimatedBillView.tsx`
- Manual smoke check:
  - `/site/<id>?view=bill`
  - `/site/<id>/usage?date=<bill-start-date>`

Status: `done`
Notes:
- Keep date navigation and `DataSyncer` behavior unchanged.
- Updated `/site/[id]/usage` to stop passing obsolete `alwaysExpanded={true}` to `BillSummary` now that the component always renders compact visible detail.
- Verified no route wrapper logic/date-navigation changes were introduced.
- Verification: `npm run lint -- 'src/app/site/[id]/page.tsx' 'src/app/site/[id]/usage/page.tsx' src/components/site/EstimatedBillView.tsx` passed. Manual smoke for both routes deferred to final QA/build review.

### Step 6: Update style guide docs/example for compact bill pattern (if a reusable pattern emerged)
Goal:
- Document the compact bill table/card pattern if new shared presentation components or conventions were added

Changes:
- `cmd/next-app/src/app/styleguide/page.tsx` (if needed)

Verification:
- `npm run lint -- src/app/styleguide/page.tsx`
- Manual visual review of the new/updated style guide section

Status: `skipped`
Notes:
- Mark `skipped` if the refactor only composes existing primitives without introducing a reusable pattern worth documenting.
- Skipped because the refactor stayed local to `BillSummary` and reused existing `SectionCard`/`Table`/`Badge` primitives without adding a new shared bill UI component/pattern to document in the style guide.

### Step 7: Final validation and PR-ready summary
Goal:
- Run full validation and prepare a PR summary covering bill-view rework scope, disclosure removal, and risks/follow-ups

Changes:
- `cmd/next-app/tracks/bill-styleguide/Track.md` (execution notes/results only)

Verification:
- `npm run lint`
- `npm run test`
- `npm run build`

Status: `done`
Notes:
- Include manual QA notes for both target pages, mobile/desktop readability, and active tariff/TOU highlighting.
- Include explicit note confirming disclosure/collapse UI removal (or justified exceptions if any remain).
- Validation results:
  - `npm run lint` ✅
  - `npm run test` ✅ (25 tests passed / 7 files)
  - `npm run build` ✅ (Next.js production build completed)
- Disclosure/collapse UI removed from `BillSummary`; both bill entry points now use the compact always-visible tariff/TOU presentation.
- Manual QA (worktree dev server smoke on `/site/[id]?view=bill` and `/site/[id]/usage?date=...`) was not run in this automated session; mobile/desktop readability remains a visual verification follow-up.
- PR summary draft notes (for track review/PR):
  - Reworked `BillSummary` from disclosure-driven rows to compact style-guide-aligned tariff cards with desktop table + mobile card layouts.
  - Preserved tariff/TOU grouping semantics, totals math, and active tariff/TOU highlighting.
  - Updated usage route wrapper to remove obsolete `alwaysExpanded` assumption.
- No billing math/API/data-fetch behavior changes intended.

### Step 8: Polish active-state styling in `BillSummary` per review feedback
Goal:
- Apply follow-up UI polish to the compact bill summary by removing non-style-guide active tariff emphasis, simplifying active TOU badge copy, and removing the Rates column

Changes:
- `cmd/next-app/src/components/BillSummary.tsx`
- Optional route/page wrappers only if a prop or rendering assumption must change (unlikely)

Verification:
- `npm run lint -- src/components/BillSummary.tsx`
- Manual code review confirming:
  - no active tariff badge is rendered
  - active TOU badge text is `Active`
  - no custom blue ring/box treatment remains around the tariff card
  - no `Rates` column/field is shown in the bill summary presentation

Status: `done`
Notes:
- Prefer style-guide card primitives/default card styling over custom ad-hoc highlight wrappers.
- Preserve active TOU emphasis (copy/style can change) and all billing grouping/totals semantics.
- Remove rate text from desktop/mobile bill detail presentations while keeping billing cost calculations unchanged.
- If active tariff context still needs to be visible after badge/ring removal, use a subtle style-guide-aligned treatment (for example text treatment inside the card header) rather than a badge or custom outline.
- Removed the active tariff badge and custom blue ring styling from tariff `SectionCard` containers.
- Simplified active TOU badge copy from `Active TOU` to `Active` for desktop and mobile layouts.
- Removed the bill `Rates` column (desktop table) and rate text line (mobile cards); billing cost/grouping calculations remain unchanged.
- Verification passed: `npm run lint -- src/components/BillSummary.tsx`.

### Step 9: Re-run final validation and refresh PR summary for follow-up polish
Goal:
- Re-validate the bill summary after the follow-up styling pass and refresh PR notes with the review-driven polish changes

Changes:
- `cmd/next-app/tracks/bill-styleguide/Track.md` (execution notes/results only)
- PR body/update notes (tracked in notes; actual PR update can happen in review/execution workflow)

Verification:
- `npm run lint`
- `npm run test`
- `npm run build`

Status: `done`
Notes:
- Replaces the prior final-validation checkpoint for the updated track scope after Step 8 lands.
- Include explicit note that the active tariff badge and blue outline treatment were removed, active TOU badge copy was simplified to `Active`, and the `Rates` column was removed.
- Full validation re-run passed after Step 8 polish:
  - `npm run lint`
  - `npm run test`
  - `npm run build`
- Worktree-local dev server was started in `cmd/next-app` via `npx next dev -p 5174` using a symlinked `.env` from the primary checkout (`.env` is gitignored), then stopped before `next build` to avoid `.next` conflicts.
- PR summary refresh notes (follow-up polish):
  - Removed active tariff badge and custom blue outline/ring treatment from compact bill tariff cards.
  - Simplified active TOU badge label to `Active` in desktop and mobile bill views.
  - Removed `Rates` column/field from bill detail presentation while preserving cost calculations and totals semantics.

## Execution Log
- 2026-02-25: Created canonical track and completed initial audit/planning for Estimated Monthly Bill view style-guide alignment (`BillSummary`, bill route wrappers, and disclosure-driven layout inventory).
- 2026-02-25: Step 1 done in dedicated worktree (`/tmp/pwusage-bill-styleguide`, branch `codex/bill-styleguide`); bootstrapped `cmd/next-app` dependencies with `npm install` and prepared track-runner execution environment.
- 2026-02-25: Step 3 skipped after auditing existing style-guide primitives; no new shared compact bill UI helper was required before refactoring `BillSummary`.
- 2026-02-25: Step 4 done. Refactored `BillSummary` to compact non-disclosure tariff cards with desktop table/mobile card presentations and always-visible totals; targeted component lint passed.
- 2026-02-25: Step 5 done. Removed obsolete `alwaysExpanded` caller usage in `/site/[id]/usage` and verified route-wrapper/page lint checks pass.
- 2026-02-25: Step 6 skipped. No new reusable style-guide pattern/component was introduced beyond local `BillSummary` composition.
- 2026-02-25: Step 7 done. Full validation passed (`npm run lint`, `npm run test`, `npm run build`) and PR-ready summary notes were recorded; manual visual QA remains a follow-up.
- 2026-02-25: Replanned follow-up polish after first-pass review feedback. Added Step 8 (active badge/ring/card styling adjustments in `BillSummary`) and Step 9 (re-run final validation / refresh PR notes).
- 2026-02-25: Replanned follow-up polish scope again to also remove the `Rates` column from bill detail presentation in the pending `BillSummary` polish step.
- 2026-02-25: Step 8 done. Polished `BillSummary` active-state presentation (removed active tariff badge/ring, simplified active TOU badge copy to `Active`, removed rates column/field) and passed targeted lint.
- 2026-02-25: Step 9 done. Re-ran full validation (`npm run lint`, `npm run test`, `npm run build`) after the polish pass; also started a worktree-local dev server on port 5174 with a symlinked `.env` for optional manual QA and stopped it before build.
- 2026-02-25: Post-review polish after manual QA feedback in PR iteration: changed desktop bill table header `TOU` -> `Period` and removed red/green cost coloring from per-period and total bill amounts in `BillSummary`; re-ran full validation (`npm run lint`, `npm run test`, `npm run build`).
