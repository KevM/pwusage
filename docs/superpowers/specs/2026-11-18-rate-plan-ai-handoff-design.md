# Rate Plan AI Assistant Handoff (Export & Re-import) Design

Status: approved design, 2026-11-18.
Builds on: [Rate plan selection, review, and restoration](../../plans/2026-11-17-rate-plan-selection-design.md) (#393).

## Problem

PWUsage combines rate plans synced from Tesla, public utility rate estimates from the OpenEI Utility Rate Database, and manual user entries. In practice:

- Public utility rate databases can lag recent utility rate filings or omit rider/delivery adjustments.
- A household's Tesla rate plan can be outdated, incomplete, or missing historical transitions.
- Users on a Time of Use rate plan also need an accurate **Fixed comparison plan** (the utility's standard flat/tiered residential rate plan) so PWUsage can calculate realistic savings.

PWUsage cannot browse utility tariff PDFs or read a homeowner's utility bill directly, whereas the user's own AI assistant (ChatGPT, Claude, Gemini, etc.) can search published utility tariff sheets and inspect user-uploaded utility bills.

Giving the user a one-click Markdown export tailored for their AI assistant—paired with a structured JSON re-import that previews a before/after diff and commits through PWUsage's existing review and provenance model—lets homeowners cross-check and fix their rate plan timeline without tedious manual form entry.

## User-Facing Naming and Voice

All copy follows [`docs/voice-and-terms.md`](../../voice-and-terms.md):

- **Entry action**: **Check with Your AI Assistant** (title case for buttons and sheet titles; sentence case "Check with your AI assistant" in prose). This makes clear that the homeowner uses their own AI assistant rather than an AI hosted by PWUsage.
- **Timeline names**:
  - **Your rate plan** (`actual` scope): the plan used to price the household's energy.
  - **Fixed comparison plan** (`reference` scope): the baseline used for savings comparisons.
- **Source labels**: **From Tesla**, **From public utility rates**, **Entered by you**.
- **Terms**: Use "rate plan", "rate period", "grid rate", and middle dots (`·`) for compact metadata. Never use "tariff" or "TOU" in user-facing UI strings; use "Time of Use" only in explainer text.

## 1. Markdown Export & Machine-Readable Schema

### Privacy Guardrails

The export is designed to be pasted into a third-party AI assistant:

- **Included**: Utility name (from `timeline.estimates?.utilityName`, or `"Unknown (ask the homeowner)"`), site currency (e.g., `USD`), site timezone (e.g., `America/Chicago`), site history start date (`timeline.systemCosts.siteInstalled`), current date in site-local time, and the rate plan periods for both timelines.
- **Excluded**: Site IDs (`siteId`), database primary keys (`periodId`, `tariffId`, `selectionId`), user IDs, member email addresses (`updatedBy.email` is never emitted; periods use only the generic source labels), and geographic coordinates.
- **Bill upload privacy instruction**: The prompt explicitly instructs the AI assistant to ignore and omit account numbers, meter numbers, customer names, and service addresses if the user attaches a utility bill.

### Export Document Structure

A pure serializer `buildRatePlanAiHandoffMarkdown(timeline: SiteTariffsTimelineResponse, exportedDate?: string): string` produces a self-contained Markdown document with four sections:

1. **Task Brief for the AI Assistant**:
   - Explains the two timelines (**Your rate plan** in `actualPeriods` and **Fixed comparison plan** in `referencePeriods`).
   - Instructs the assistant to:
     1. Search official published tariff schedules for the utility to verify effective dates, seasonal month boundaries, weekday and weekend rate periods, all-in per-kWh grid rates (`buyRate`), and solar export credit rates (`sellRate`).
     2. Check any uncovered date gaps between `historyStart` and `exportedAt` and ask the user which plan applied during those dates.
     3. **Fixed comparison plan requirement**: If any period in `actualPeriods` is a Time of Use rate plan (more than one distinct `buyRate` or `touName` across the day or year), also verify or populate `referencePeriods` with the utility's standard fixed/flat residential rate plan covering the same date range (represented as a single all-day `OFF_PEAK` window per season, blending baseline tiers if the flat plan is tiered).
     4. **Utility bill fallback**: If online tariff sheets are unavailable, ambiguous, or list delivery/regulatory riders separately from base supply rates, ask the user to upload or paste a recent utility bill (or both a summer and a winter bill for seasonal plans) and extract the all-in per-kWh rates and effective dates from the bill.
     5. Record official tariff URLs or `"User-provided utility bill (YYYY-MM)"` in `sources`, and explain any tier blending or rider assumptions in `notes`.
     6. Output a single fenced ```` ```json ```` block matching the `pwusage-rate-plan-handoff/v1` schema.
2. **Human-Readable Current Timeline Summary**:
   - **Site Context**: Utility, Timezone, Currency, History Start Date, Export Date, and Observed Holiday Rule ("Observed US federal holidays use the weekend schedule").
   - **Your Rate Plan**: Markdown tables for each period (newest first) showing effective range, source label, verification status, and season/day/time/rate rows, plus explicit callouts for any uncovered date gaps between `historyStart` and `exportedAt`.
   - **Fixed Comparison Plan**: Markdown tables for each reference period, or a callout noting that no Fixed comparison plan is configured yet.
3. **Schema Reference (`pwusage-rate-plan-handoff/v1`)**:
   - Concise bulleted rules matching `validateTariffPlanInput` in `cmd/next-app/src/lib/tariff-timeline.ts`:
     - `name`: 1–64 characters, unique per timeline.
     - `effectiveFrom`: `YYYY-MM-DD` (between `2015-01-01` and 365 days after `exportedAt`).
     - `effectiveTo`: `YYYY-MM-DD` (on or after `effectiveFrom`) or `null` for an ongoing plan (`Present`). Periods within `actualPeriods` must not overlap each other; periods within `referencePeriods` must not overlap each other.
     - `seasons`: 1–6 seasons per plan. `fromMonth` and `toMonth` are integers `1`..`12` (wrapping around December→January is allowed, e.g. `fromMonth: 10, toMonth: 5`). Across a plan's seasons, all 12 months `1`..`12` must be covered without gaps or overlaps.
     - `weekdayPeriods` (Mon–Fri) and `weekendPeriods` (Sat–Sun and observed holidays): 1–48 windows per schedule. Must cover all 24 hours (`0:00` to `24:00`) without gaps or overlaps. `fromHour` (`0`..`23`), `toHour` (`0`..`24`), `fromMinute` and `toMinute` (`0` or `30` only). A single all-day window uses `fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0`.
     - `touName`: one of `"ON_PEAK"`, `"PARTIAL_PEAK"`, `"OFF_PEAK"`, `"SUPER_OFF_PEAK"`.
     - `buyRate` (grid rate per kWh) and `sellRate` (export credit rate per kWh): numbers between `0` and `10` with at most 5 decimal places.
     - `notes`: array of short plain-text strings (max 10 items, max 500 characters each).
     - `sources`: array of citation strings or URLs (max 10 items, max 500 characters each).
4. **Current Rate Plans JSON Block**:
   - A single fenced ```` ```json ```` block containing the current timeline serialized in `pwusage-rate-plan-handoff/v1` format, ready for the assistant to inspect, modify, and return.

```json
{
  "schema": "pwusage-rate-plan-handoff/v1",
  "utilityName": "Austin Energy",
  "currency": "USD",
  "timeZone": "America/Chicago",
  "historyStart": "2023-06-15",
  "exportedAt": "2026-11-18",
  "notes": [],
  "sources": [],
  "actualPeriods": [
    {
      "name": "Residential Time of Use",
      "effectiveFrom": "2023-06-15",
      "effectiveTo": null,
      "seasons": [
        {
          "name": "Summer",
          "fromMonth": 6,
          "toMonth": 9,
          "weekdayPeriods": [
            { "touName": "OFF_PEAK", "fromHour": 0, "fromMinute": 0, "toHour": 14, "toMinute": 0, "buyRate": 0.098, "sellRate": 0.097 },
            { "touName": "ON_PEAK", "fromHour": 14, "fromMinute": 0, "toHour": 20, "toMinute": 0, "buyRate": 0.225, "sellRate": 0.097 },
            { "touName": "OFF_PEAK", "fromHour": 20, "fromMinute": 0, "toHour": 24, "toMinute": 0, "buyRate": 0.098, "sellRate": 0.097 }
          ],
          "weekendPeriods": [
            { "touName": "OFF_PEAK", "fromHour": 0, "fromMinute": 0, "toHour": 24, "toMinute": 0, "buyRate": 0.098, "sellRate": 0.097 }
          ]
        },
        {
          "name": "Non-Summer",
          "fromMonth": 10,
          "toMonth": 5,
          "weekdayPeriods": [
            { "touName": "OFF_PEAK", "fromHour": 0, "fromMinute": 0, "toHour": 24, "toMinute": 0, "buyRate": 0.098, "sellRate": 0.097 }
          ],
          "weekendPeriods": [
            { "touName": "OFF_PEAK", "fromHour": 0, "fromMinute": 0, "toHour": 24, "toMinute": 0, "buyRate": 0.098, "sellRate": 0.097 }
          ]
        }
      ]
    }
  ],
  "referencePeriods": []
}
```

## 2. Server Parsing, Batch Diff Preview, and Atomic Commit

### Input Parsing and Validation (`src/lib/tariff-ai-handoff.ts`)

`parseRatePlanAiHandoffInput(rawInput: string, todaySiteLocal: string): ParsedRatePlanAiHandoff`

1. **Extraction**:
   - Trims `rawInput` (rejecting inputs over 256 KB).
   - Looks for a fenced ```` ```json ... ``` ```` block (or a generic ```` ``` ... ``` ```` block whose body starts with `{`). If multiple fenced JSON blocks exist, selects the last block containing `"schema": "pwusage-rate-plan-handoff/v1"`. If no fenced block is present, attempts to parse the trimmed text directly as JSON.
2. **Envelope Validation**:
   - Must be a JSON object with `schema === "pwusage-rate-plan-handoff/v1"`.
   - `actualPeriods` and `referencePeriods` must be arrays (0 to 12 items each; at least one period across both arrays must be present when importing, or a clear `TariffValidationError` is thrown).
   - `notes` and `sources` (optional, default `[]`) are validated as arrays of up to 10 strings (each trimmed, max 500 characters, empty strings dropped).
3. **Period & Non-Overlap Validation**:
   - Each period in `actualPeriods` and `referencePeriods` is validated with `validateTariffPlanInput(period, todaySiteLocal)` from `tariff-timeline.ts`.
   - Within each scope (`actualPeriods` and `referencePeriods` independently), periods are sorted by `effectiveFrom` ascending.
   - If any period overlaps the next (`prev.effectiveTo === null || prev.effectiveTo >= next.effectiveFrom`), throw `TariffValidationError` naming the two overlapping periods and their dates.

### Filtering Unchanged Periods & Building Sequential Previews

To integrate with #393's review model (`buildTariffSelectionPreview` in `src/lib/tariff-selection.ts`):

1. **Unchanged Detection**:
   - For each scope (`actual` and `reference`), compare each imported period against the existing periods in that scope:
     - Compute `parsed = compileSeasonsToParsedTariff(period.name, period.seasons)` and `contentHash = tariffContentHash(parsed)`.
     - If an existing period in that scope has the exact same `effectiveFrom`, `effectiveTo`, `contentHash`, and case-insensitive trimmed `name`, the imported period is classified as **unchanged** and skipped from mutation.
2. **Sequential Preview Simulation**:
   - For each changed/added period in `actualPeriods` (ordered oldest to newest) and `referencePeriods` (ordered oldest to newest):
     - Build a `TariffSelectionPreviewResponse` using `buildTariffSelectionPreview` with `candidate: { kind: 'manual', name: period.name, seasons: period.seasons }`, `effectiveFrom: period.effectiveFrom`, `effectiveTo: period.effectiveTo`.
     - Advance the in-memory simulated snapshot for that scope so subsequent periods in the same batch preview against the updated timeline state.
     - Automatically disambiguate duplicate plan names across different historical versions using `availableEstimateName`-style year/date suffixing if two distinct periods in the same scope share a base name.
3. **Deterministic Batch `reviewHash`**:
   - Compute a SHA-256 `reviewHash` over:
     - The canonical normalized list of changed `actual` and `reference` periods.
     - Each individual preview's `reviewHash` (which already binds the current timeline snapshot, restoration originals, and site eligibility).

### Contract Additions (`src/lib/tariff-contract.ts` & iOS `RatePlanSelection.swift`)

```ts
export interface TariffAiHandoffExportResponse {
  markdown: string;
  filename: string;
}

export interface TariffAiHandoffPreviewRequest {
  rawInput: string;
}

export interface TariffAiHandoffPreviewResponse {
  reviewHash: string;
  siteId: string;
  currency: string;
  unit: 'kWh';
  timezone: string;
  notes: string[];
  sources: string[];
  unchangedActualCount: number;
  unchangedReferenceCount: number;
  actualPreviews: TariffSelectionPreviewResponse[];
  referencePreviews: TariffSelectionPreviewResponse[];
  recalculatesHistory: boolean;
  recalculatesFromHistoryStart: boolean;
  recalculationRange: {
    fromDate: string;
    toDate: string | null;
  } | null;
  affectsPowerwallPlan: false;
}

export interface TariffAiHandoffCommitRequest {
  rawInput: string;
  expectedReviewHash: string;
  verifiedAgainstBill: boolean;
}

export interface TariffAiHandoffCommitResponse {
  selectionIds: number[];
  tariffIds: number[];
  appliedActualCount: number;
  appliedReferenceCount: number;
  unchanged: boolean;
  reattributionRange: { fromDate: string; toDate: string | null } | null;
  timeline: SiteTariffsTimelineResponse;
}

export interface TariffAiHandoffConflictResponse {
  error: string;
  code: 'REVIEW_STALE';
  preview: TariffAiHandoffPreviewResponse;
}
```

### API Endpoints

1. `GET /api/site/[id]/tariffs/ai-handoff`:
   - Authenticates user and verifies site access (`verifySiteAccess(siteId)`).
   - Loads `timeline = await new TariffTimelineRepo().getTimeline(siteId, user.id)`.
   - Returns `{ markdown: buildRatePlanAiHandoffMarkdown(timeline), filename: "pwusage-rate-plan-check.md" }`.
2. `POST /api/site/[id]/tariffs/ai-handoff/preview`:
   - Rejects cross-origin requests (`isCrossOriginRequest(req)`), verifies site access.
   - Calls `TariffAiHandoffService.previewImport(siteId, user.id, body)`.
   - Returns `200` with `TariffAiHandoffPreviewResponse`, or `400` on `TariffValidationError`.
3. `POST /api/site/[id]/tariffs/ai-handoff/commit`:
   - Rejects cross-origin requests, verifies site access.
   - Acquires the `Site` row lock (`SELECT ... FROM "Site" WHERE id = $1 FOR UPDATE`) inside a single database transaction.
   - Recomputes the batch preview against the locked timeline state.
   - If `preview.reviewHash !== body.expectedReviewHash`, rolls back and returns `409` with `{ error: 'Your rate plans changed while you were reviewing. Review the updated changes before applying.', code: 'REVIEW_STALE', preview }`.
   - If `actualPreviews.length === 0 && referencePreviews.length === 0`, commits a no-op and returns `unchanged: true` with the current timeline.
   - Otherwise, applies each changed actual and reference period through the same atomic selection persistence logic used by `commitReviewedSelection`:
     - Inserts immutable `Tariff` versions (`source = 'manual'`).
     - Records `TariffSelection` rows (`choice_kind = 'manual'`, `chosen_by_user_id = user.id`).
     - Captures any replaced Tesla spans in `TariffSelectionOriginalPeriod` so **Restore Original Tesla Rate Plan** works identically for AI-imported overrides.
     - Records `TariffVerification` rows when `verifiedAgainstBill === true`.
     - Runs `applyEstimatesOnClient` and `recomputeIsCurrentTariff`.
     - Enqueues a single combined historical re-attribution range covering all affected `actual` dates, and triggers background `runSiteReattribution` via `after(...)`.
   - Returns `200` with `TariffAiHandoffCommitResponse` and `ETag`.

## 3. Web & iOS User Experience

### Web (`cmd/next-app`)

1. **Entry Point in `TariffList.tsx`**:
   - In the `Rate Plan` card header action area alongside **Sync from Tesla**, add an outline button **Check with Your AI Assistant**.
   - Update the intro paragraph in `TariffList.tsx` so it mentions that you can check and import rate plans with your AI assistant on the web or edit them in the PWUsage iOS app.
2. **Modal (`src/components/site/AiRatePlanHandoffModal.tsx`)**:
   - Accessible dialog with two steps/tabs: **1. Export for Your AI Assistant** and **2. Import AI Reply**.
   - **Step 1 (Export)**:
     - Generates the Markdown client-side directly from the loaded `SiteTariffsTimelineResponse` via `buildRatePlanAiHandoffMarkdown(timeline)` (instant, zero network wait).
     - Displays the tip callout:
       > Paste this into your AI assistant. You can also attach a PDF or photo of your utility bill so it can check your exact all-in rates.
     - Actions: **Copy Markdown** (copies to clipboard with temporary `"Copied to clipboard"` state), **Download .md** (downloads `pwusage-rate-plan-check.md`), and a collapsible/scrollable monospace preview of the Markdown.
     - Footer CTA: **Next: Paste AI Reply**.
   - **Step 2 (Import & Review)**:
     - Textarea for pasting the AI assistant's response, plus an optional **Upload .md or .json file** input that populates the textarea.
     - Button: **Preview Changes** (`POST /api/site/[id]/tariffs/ai-handoff/preview`).
     - **Review State**:
       - If `actualPreviews.length === 0 && referencePreviews.length === 0`, shows a calm banner: *"No rate plan changes found · The imported plans match your current timeline."* (with any AI `notes` or `sources` still shown below for reassurance).
       - If changes exist:
         - Shows **Notes from your AI assistant** and **Sources** if non-empty.
         - Renders before/after interval comparison cards for **Your Rate Plan** (`actualPreviews`) and **Fixed Comparison Plan** (`referencePreviews`), showing effective dates, replaced vs. new plan names and sources, and aligned season/time/rate diffs (`buyRate` and `sellRate`).
         - When `actualPreviews.length > 0`, displays the Powerwall notice:
           > This changes the rates PWUsage uses for bills and savings estimates. Your Powerwall will continue using the plan saved in Tesla. Check the prices, time periods, export rates, and effective date against your utility bill.
         - Checkboxes:
           - Required: **I reviewed these changes**
           - Optional (initially unchecked): **I checked these details against my utility bill**
         - Editing the textarea invalidates the loaded preview.
         - On `409 REVIEW_STALE` during **Apply Changes**, replaces the preview with the fresh server preview, clears both checkboxes, and shows a notice asking the user to review the updated comparison.

### iOS (`cmd/ios-app`)

1. **Entry Point in `TariffSheet.swift` & `TariffSheetModal.swift`**:
   - Add `.aiHandoff` to `TariffSheetModal`.
   - In `TariffSheet`, surface a **Check with Your AI Assistant** button in the rate plan actions area (and toolbar menu) whenever `timeline` is loaded and the server supports rate plan selection (`timeline.rateCountry != nil`).
2. **Model (`cmd/ios-app/PWUsage/Models/Bill/RatePlanAiHandoffModel.swift`)**:
   - `@Observable @MainActor final class RatePlanAiHandoffModel`
   - Holds `markdown: String`, `rawInput: String`, `preview: TariffAiHandoffPreviewResponse?`, `hasReviewedChanges: Bool`, `verifiedAgainstBill: Bool`, `isLoadingMarkdown: Bool`, `isPreviewing: Bool`, `isApplying: Bool`, `staleNotice: String?`, and `errorMessage: String?`.
   - Editing `rawInput` clears `preview`, `hasReviewedChanges`, `verifiedAgainstBill`, and `staleNotice`.
   - Receiving `PWUsageAPIError.ratePlanReviewStale` (or the batch AI handoff stale response) updates `preview`, clears `hasReviewedChanges` and `verifiedAgainstBill`, and sets `staleNotice`.
3. **Sheet View (`cmd/ios-app/PWUsage/Views/Bill/RatePlanAiHandoffSheet.swift`)**:
   - Decomposed into small views respecting SwiftLint's 50-line function body budget.
   - **Step 1 (Export)**:
     - Brief explanation and utility bill attachment tip.
     - **Copy Markdown** (`UIPasteboard.general.string = markdown`) and **Share Markdown…** (`ShareLink(item: markdown, preview: SharePreview("PWUsage Rate Plan Check"))`).
     - **Paste from Clipboard** button and expandable text editor for the AI assistant's response.
     - **Preview Changes** primary button.
   - **Step 2 (Review & Apply)**:
     - Shows AI `notes` and `sources` cards when present.
     - Reuses `RatePlanReviewIntervalSection` from #393 to render every affected interval in **Your Rate Plan** (`actualPreviews`) and **Fixed Comparison Plan** (`referencePreviews`).
     - Shows the Powerwall warning when `actualPreviews` is non-empty, historical recalculation notice when `recalculatesHistory` is true, and the two toggles (**I reviewed these changes** and **I checked these details against my utility bill**).
     - **Apply Changes** commits and updates `TariffSheet`'s `timeline`.

## 4. Testing and Verification

1. **Serializer & Parser Unit Tests (`cmd/next-app/src/lib/tariff-ai-handoff.test.ts`)**:
   - **Round-trip invariant**: Exporting a timeline with actual Time of Use periods, gaps, and reference periods to Markdown and parsing the exported Markdown back produces an identical normalized payload with zero changed periods.
   - **PII check**: Asserts that `siteId`, `periodId`, `tariffId`, and user email addresses never appear in the generated Markdown.
   - **Time of Use detection**: Verifies that a Time of Use actual plan triggers the prominent Fixed comparison plan prompt instructions, and a flat actual plan notes that a separate Fixed comparison plan is optional.
   - **Validation**: Covers fenced JSON extraction amidst surrounding Markdown commentary, multiple code blocks, raw JSON input, invalid schema version, overlapping effective dates within a scope, gaps in 24-hour schedules or 12-month seasons, invalid `touName`, and oversize payloads.
2. **Service & Route Tests (`cmd/next-app/src/lib/tariff-ai-handoff-service.test.ts`, route tests)**:
   - Preview and commit of multi-period `actualPeriods` + `referencePeriods` in one batch.
   - Skipping unchanged periods while applying modified/added periods.
   - Preserving Tesla restoration originals (`TariffSelectionOriginalPeriod`) when an AI-imported period overrides a Tesla period.
   - Recording `TariffVerification` only when `verifiedAgainstBill` is true.
   - Returning `409 REVIEW_STALE` with a fresh preview when the timeline changes between preview and commit.
   - Access control (`401` on unauthorized site, `403` on cross-origin POST).
3. **Web Component Tests**:
   - `AiRatePlanHandoffModal.test.tsx` and `TariffList.test.tsx`: export copy, paste + preview rendering, no-changes state, acknowledgement checkbox gating, bill verification checkbox, and stale conflict reset.
4. **iOS Unit Tests (`cmd/ios-app/PWUsageTests/RatePlanAiHandoffModelTests.swift`)**:
   - Decoding `TariffAiHandoffExportResponse`, `TariffAiHandoffPreviewResponse`, and `TariffAiHandoffCommitResponse`.
   - Input editing invalidates preview and checkboxes.
   - Acknowledgement required before apply; stale conflict replaces preview and resets both checkboxes.
