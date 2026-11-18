# Rate Plan AI Assistant Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let homeowners export their site's full rate plan timeline (Your rate plan + Fixed comparison plan, metadata, and uncovered gaps) as a self-contained Markdown prompt for their AI assistant, and paste or upload the AI assistant's JSON reply to review a before/after diff and apply changes atomically.

**Architecture:** Build a pure Markdown serializer and JSON parser (`src/lib/tariff-ai-handoff.ts`) over the existing `SiteTariffsTimelineResponse` and `TariffPlanWriteInput` contract. Layer a batch preview and atomic commit service (`src/lib/tariff-ai-handoff-service.ts` + repo support in `src/lib/tariff-timeline-repo.ts`) directly on top of #393's `buildTariffSelectionPreview` and `applyTariffSelectionOnClient` so multi-period actual and reference imports preserve Tesla restoration originals, enforce `reviewHash` conflict checks, record optional bill verification, and enqueue one combined historical re-attribution range. Expose thin Web (`AiRatePlanHandoffModal.tsx`) and iOS (`RatePlanAiHandoffSheet.swift`) review flows.

**Tech Stack:** TypeScript, Next.js App Router, PostgreSQL (`pg`), Vitest, Swift 6 / SwiftUI, Swift Testing.

## Global Constraints

- Approved spec: [`docs/superpowers/specs/2026-11-18-rate-plan-ai-handoff-design.md`](../specs/2026-11-18-rate-plan-ai-handoff-design.md).
- Follow [`docs/voice-and-terms.md`](../../voice-and-terms.md) for all user-facing strings:
  - Button / modal / sheet title: **Check with Your AI Assistant** (title case on buttons/titles; sentence case "Check with your AI assistant" in body copy).
  - Timeline names: **Your rate plan** (`actual`) and **Fixed comparison plan** (`reference`).
  - Source labels: **From Tesla**, **From public utility rates**, **Entered by you**.
  - Never use `"TOU"` or `"tariff"` in user-facing UI strings; use middle dots (`·`) instead of dashes as metadata separators.
- Strictly avoid `any` in TypeScript (`cmd/next-app/AGENTS.md`).
- Zero PII in the exported Markdown: never include `siteId`, `periodId`, `tariffId`, `selectionId`, user IDs, user emails (`updatedBy.email` or `verification.verifiedByEmail`), or coordinates.
- Preserve append-only `Tariff` versioning (`DesignDecisions.md` §2) and #393's `TariffSelection` / `TariffSelectionOriginal` / `TariffSelectionVerification` provenance.
- In Swift (`cmd/ios-app/AGENTS.md`), keep function bodies ≤ 50 lines, types ≤ 350 lines, files ≤ 500 lines, and use Swift Testing (`import Testing`).

---

### Task 1: Contract Types, Markdown Export Serializer, and JSON Parser

**Files:**
- Modify: `cmd/next-app/src/lib/tariff-contract.ts`
- Create: `cmd/next-app/src/lib/tariff-ai-handoff.ts`
- Create: `cmd/next-app/src/lib/tariff-ai-handoff.test.ts`

**Interfaces:**
- Consumes: `SiteTariffsTimelineResponse`, `TariffPeriodDTO`, `TariffSeasonInput`, `TimePeriodWindowInput`, `TariffSelectionPreviewResponse` from `cmd/next-app/src/lib/tariff-contract.ts`; `validateTariffPlanInput`, `TariffPlanWriteInput`, `TariffValidationError`, `addCalendarDays` from `cmd/next-app/src/lib/tariff-timeline.ts`.
- Produces:
  - `AI_HANDOFF_SCHEMA = 'pwusage-rate-plan-handoff/v1'`
  - `TariffAiHandoffExportResponse`, `TariffAiHandoffPreviewRequest`, `TariffAiHandoffPreviewResponse`, `TariffAiHandoffCommitRequest`, `TariffAiHandoffCommitResponse`, `TariffAiHandoffConflictResponse` in `cmd/next-app/src/lib/tariff-contract.ts`
  - `buildRatePlanAiHandoffMarkdown(timeline: SiteTariffsTimelineResponse, exportedDate?: string): string`
  - `parseRatePlanAiHandoffInput(rawInput: string, todaySiteLocal: string): ParsedRatePlanAiHandoff`
  - `isTimeOfUsePeriod(period: Pick<TariffPeriodDTO, 'seasons'>): boolean`

- [ ] **Step 1: Add AI handoff contract types to `cmd/next-app/src/lib/tariff-contract.ts`**

Append the following interfaces to the end of `cmd/next-app/src/lib/tariff-contract.ts`:

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

- [ ] **Step 2: Write the failing unit tests in `cmd/next-app/src/lib/tariff-ai-handoff.test.ts`**

Create `cmd/next-app/src/lib/tariff-ai-handoff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { SiteTariffsTimelineResponse, TariffPeriodDTO, TariffSeasonInput } from './tariff-contract';
import {
  AI_HANDOFF_SCHEMA,
  buildRatePlanAiHandoffMarkdown,
  isTimeOfUsePeriod,
  parseRatePlanAiHandoffInput,
} from './tariff-ai-handoff';
import { TariffValidationError } from './tariff-timeline';

const SUMMER_TOU_SEASONS: TariffSeasonInput[] = [
  {
    name: 'Summer',
    fromMonth: 6,
    toMonth: 9,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 14, toMinute: 0, buyRate: 0.098, sellRate: 0.097 },
      { touName: 'ON_PEAK', fromHour: 14, fromMinute: 0, toHour: 20, toMinute: 0, buyRate: 0.225, sellRate: 0.097 },
      { touName: 'OFF_PEAK', fromHour: 20, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.098, sellRate: 0.097 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.098, sellRate: 0.097 },
    ],
  },
  {
    name: 'Non-Summer',
    fromMonth: 10,
    toMonth: 5,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.098, sellRate: 0.097 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.098, sellRate: 0.097 },
    ],
  },
];

const FLAT_SEASONS: TariffSeasonInput[] = [
  {
    name: 'All Year',
    fromMonth: 1,
    toMonth: 12,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.115, sellRate: 0.097 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.115, sellRate: 0.097 },
    ],
  },
];

function sampleTimeline(): SiteTariffsTimelineResponse {
  const actualPeriod: TariffPeriodDTO = {
    periodId: 42,
    tariffId: 101,
    name: 'Residential Time of Use',
    version: 3,
    source: 'estimated',
    startSource: 'urdb',
    effectiveFrom: '2024-01-01',
    effectiveTo: null,
    isCurrentToday: true,
    updatedBy: { email: 'owner-secret@example.com', isCurrentUser: true },
    seasons: SUMMER_TOU_SEASONS,
    selectionId: 77,
    choiceKind: 'owner',
    urdbLabel: '65a1b2c3d4e5f60001234567',
    verification: {
      verifiedAt: '2026-10-01T15:30:00.000Z',
      verifiedByEmail: 'verifier-secret@example.com',
      verifiedByCurrentUser: true,
    },
  };

  const referencePeriod: TariffPeriodDTO = {
    periodId: 88,
    tariffId: 202,
    name: 'Residential Standard Fixed',
    version: 1,
    source: 'manual',
    startSource: null,
    effectiveFrom: '2023-06-15',
    effectiveTo: null,
    isCurrentToday: true,
    updatedBy: { email: 'owner-secret@example.com', isCurrentUser: true },
    seasons: FLAT_SEASONS,
    selectionId: 78,
    choiceKind: 'owner',
    urdbLabel: null,
    verification: null,
  };

  return {
    version: 2,
    siteId: 'secret-site-id-99999',
    timezone: 'America/Chicago',
    currency: 'USD',
    periods: [actualPeriod],
    referencePeriods: [referencePeriod],
    estimates: {
      status: 'ready',
      utilityName: 'Austin Energy',
      teslaPlanOutOfDate: true,
      newerPlanName: 'Residential TOU 2026',
      newerPlanStart: '2026-03-01',
      newestRevisionStart: '2025-11-01',
      mayBeOutdated: false,
      historyGuide: {
        historyStart: '2023-06-15',
        fillThrough: '2023-12-31',
        unconfirmedDays: 200,
      },
      eligibility: 'us',
    },
    rateCountry: {
      countryCode: 'US',
      source: 'owner',
      updatedAt: '2026-11-01T00:00:00.000Z',
      eligibility: 'us',
    },
    battery: null,
    systemCosts: {
      siteInstalled: '2023-06-15',
      solar: null,
      powerwall: null,
    },
    reattribution: null,
    holidayDates: ['2026-01-01', '2026-07-03'],
    teslaSync: {
      latestTariffId: 55,
      latestTariffName: 'Austin Energy TOU (Old)',
      latestUpdatedAt: '2025-05-10T12:00:00.000Z',
      activeManualUpdatedAt: '2026-10-01T15:30:00.000Z',
      differsFromActiveManual: true,
    },
  };
}

describe('tariff-ai-handoff', () => {
  it('detects Time of Use vs fixed periods', () => {
    expect(isTimeOfUsePeriod({ seasons: SUMMER_TOU_SEASONS })).toBe(true);
    expect(isTimeOfUsePeriod({ seasons: FLAT_SEASONS })).toBe(false);
  });

  it('exports all period metadata, site hints, uncovered gaps, and utility bill fallback while omitting PII', () => {
    const timeline = sampleTimeline();
    const md = buildRatePlanAiHandoffMarkdown(timeline, '2026-11-18');

    // Includes site & period metadata
    expect(md).toContain('Austin Energy');
    expect(md).toContain('America/Chicago');
    expect(md).toContain('2023-06-15');
    expect(md).toContain('Residential Time of Use');
    expect(md).toContain('Version 3');
    expect(md).toContain('From public utility rates');
    expect(md).toContain('Chosen by homeowner');
    expect(md).toContain('65a1b2c3d4e5f60001234567');
    expect(md).toContain('Verified against utility bill on 2026-10-01');
    expect(md).toContain('Austin Energy TOU (Old)');
    expect(md).toContain('Residential TOU 2026');
    expect(md).toContain('2026-03-01');
    // Uncovered gap from siteInstalled (2023-06-15) to day before 2024-01-01 (2023-12-31)
    expect(md).toContain('2023-06-15');
    expect(md).toContain('2023-12-31');
    // Includes utility bill upload instructions and fixed comparison plan requirement
    expect(md).toContain('utility bill');
    expect(md).toContain('Fixed comparison plan');

    // Zero PII
    expect(md).not.toContain('secret-site-id-99999');
    expect(md).not.toContain('owner-secret@example.com');
    expect(md).not.toContain('verifier-secret@example.com');
  });

  it('round-trips exported Markdown through parseRatePlanAiHandoffInput identically', () => {
    const timeline = sampleTimeline();
    const md = buildRatePlanAiHandoffMarkdown(timeline, '2026-11-18');
    const parsed = parseRatePlanAiHandoffInput(md, '2026-11-18');

    expect(parsed.schema).toBe(AI_HANDOFF_SCHEMA);
    expect(parsed.actualPeriods).toHaveLength(1);
    expect(parsed.actualPeriods[0]).toEqual({
      name: 'Residential Time of Use',
      effectiveFrom: '2024-01-01',
      effectiveTo: null,
      seasons: SUMMER_TOU_SEASONS,
    });
    expect(parsed.referencePeriods).toHaveLength(1);
    expect(parsed.referencePeriods[0]).toEqual({
      name: 'Residential Standard Fixed',
      effectiveFrom: '2023-06-15',
      effectiveTo: null,
      seasons: FLAT_SEASONS,
    });
  });

  it('parses fenced JSON amidst AI commentary and extracts notes and sources', () => {
    const reply = `
Here is what I found from the official Austin Energy tariff sheet and your uploaded bill:

\`\`\`json
{
  "schema": "pwusage-rate-plan-handoff/v1",
  "notes": ["Added regulatory charge of $0.012/kWh from bill."],
  "sources": ["https://austinenergy.com/rates", "User-provided utility bill (2026-08)"],
  "actualPeriods": [
    {
      "name": "Residential Time of Use",
      "effectiveFrom": "2024-01-01",
      "effectiveTo": null,
      "seasons": ${JSON.stringify(FLAT_SEASONS)}
    }
  ],
  "referencePeriods": []
}
\`\`\`
Hope this helps!
`;
    const parsed = parseRatePlanAiHandoffInput(reply, '2026-11-18');
    expect(parsed.notes).toEqual(['Added regulatory charge of $0.012/kWh from bill.']);
    expect(parsed.sources).toEqual(['https://austinenergy.com/rates', 'User-provided utility bill (2026-08)']);
    expect(parsed.actualPeriods).toHaveLength(1);
  });

  it('rejects overlapping periods within the same scope', () => {
    const raw = JSON.stringify({
      schema: AI_HANDOFF_SCHEMA,
      actualPeriods: [
        { name: 'Plan A', effectiveFrom: '2024-01-01', effectiveTo: '2024-06-30', seasons: FLAT_SEASONS },
        { name: 'Plan B', effectiveFrom: '2024-06-01', effectiveTo: null, seasons: FLAT_SEASONS },
      ],
      referencePeriods: [],
    });

    expect(() => parseRatePlanAiHandoffInput(raw, '2026-11-18')).toThrow(TariffValidationError);
    expect(() => parseRatePlanAiHandoffInput(raw, '2026-11-18')).toThrow(/overlap/i);
  });

  it('rejects wrong schema or empty periods across both scopes', () => {
    expect(() =>
      parseRatePlanAiHandoffInput(JSON.stringify({ schema: 'wrong/v1', actualPeriods: [], referencePeriods: [] }), '2026-11-18')
    ).toThrow(TariffValidationError);

    expect(() =>
      parseRatePlanAiHandoffInput(JSON.stringify({ schema: AI_HANDOFF_SCHEMA, actualPeriods: [], referencePeriods: [] }), '2026-11-18')
    ).toThrow(/at least one rate plan/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run from `cmd/next-app`:
```bash
npm test -- --run src/lib/tariff-ai-handoff.test.ts
```
Expected: FAIL with module `./tariff-ai-handoff` not found.

- [ ] **Step 4: Implement `cmd/next-app/src/lib/tariff-ai-handoff.ts`**

Create `cmd/next-app/src/lib/tariff-ai-handoff.ts`:

```ts
import type {
  SiteTariffsTimelineResponse,
  TariffPeriodDTO,
  TariffPeriodName,
  TariffSeasonInput,
  TimePeriodWindowInput,
} from './tariff-contract';
import {
  addCalendarDays,
  siteLocalDateString,
  TariffValidationError,
  validateTariffPlanInput,
  type TariffPlanWriteInput,
} from './tariff-timeline';

export const AI_HANDOFF_SCHEMA = 'pwusage-rate-plan-handoff/v1' as const;
const MAX_RAW_INPUT_BYTES = 256 * 1024;
const MAX_PERIODS_PER_SCOPE = 12;
const MAX_NOTES_OR_SOURCES = 10;
const MAX_NOTE_LENGTH = 500;

export interface RatePlanAiHandoffPayload {
  schema: typeof AI_HANDOFF_SCHEMA;
  utilityName: string | null;
  countryCode: string | null;
  currency: string;
  timeZone: string;
  historyStart: string;
  exportedAt: string;
  notes: string[];
  sources: string[];
  actualPeriods: TariffPlanWriteInput[];
  referencePeriods: TariffPlanWriteInput[];
}

export interface ParsedRatePlanAiHandoff {
  schema: typeof AI_HANDOFF_SCHEMA;
  notes: string[];
  sources: string[];
  actualPeriods: TariffPlanWriteInput[];
  referencePeriods: TariffPlanWriteInput[];
}

const PERIOD_LABELS: Record<TariffPeriodName, string> = {
  ON_PEAK: 'Peak (ON_PEAK)',
  PARTIAL_PEAK: 'Mid-Peak (PARTIAL_PEAK)',
  OFF_PEAK: 'Off-Peak (OFF_PEAK)',
  SUPER_OFF_PEAK: 'Super Off-Peak (SUPER_OFF_PEAK)',
};

export function isTimeOfUsePeriod(period: Pick<TariffPeriodDTO, 'seasons'>): boolean {
  for (const season of period.seasons) {
    const allWindows = [...season.weekdayPeriods, ...season.weekendPeriods];
    if (allWindows.length === 0) continue;
    const firstBuy = allWindows[0].buyRate;
    const firstTou = allWindows[0].touName;
    if (allWindows.some(w => Math.abs(w.buyRate - firstBuy) > 1e-6 || w.touName !== firstTou)) {
      return true;
    }
  }
  return false;
}

function formatSourceLabel(period: TariffPeriodDTO): string {
  switch (period.source) {
    case 'tesla':
      return 'From Tesla';
    case 'estimated':
      return 'From public utility rates (OpenEI Utility Rate Database)';
    case 'manual':
      return 'Entered by you';
  }
}

function formatChoiceKindLabel(period: TariffPeriodDTO): string {
  if (period.choiceKind === 'owner' || period.source === 'manual' || period.updatedBy !== null) {
    return 'Chosen by homeowner';
  }
  return 'Automatic';
}

function formatStartSourceLabel(period: TariffPeriodDTO): string {
  switch (period.startSource) {
    case 'urdb':
      return 'Public rate revision start date';
    case 'site_installed':
      return 'Site installation date';
    case 'tesla_import':
      return 'Tesla sync date';
    default:
      return 'Explicitly set';
  }
}

function formatVerificationLabel(period: TariffPeriodDTO): string {
  if (!period.verification) return 'Not yet verified against a utility bill';
  return `Verified against utility bill on ${period.verification.verifiedAt.slice(0, 10)}`;
}

function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function formatWindowTime(w: TimePeriodWindowInput): string {
  if (w.fromHour === 0 && w.fromMinute === 0 && w.toHour === 24 && w.toMinute === 0) {
    return '00:00–24:00 (All day)';
  }
  return `${formatClock(w.fromHour, w.fromMinute)}–${formatClock(w.toHour, w.toMinute)}`;
}

function formatMonthRange(season: TariffSeasonInput): string {
  const fromPart = season.fromDay ? `Month ${season.fromMonth} Day ${season.fromDay}` : `Month ${season.fromMonth}`;
  const toPart = season.toDay ? `Month ${season.toMonth} Day ${season.toDay}` : `Month ${season.toMonth}`;
  return `${fromPart} to ${toPart}`;
}

function stripReadOnlySeasonFields(seasons: TariffSeasonInput[]): TariffSeasonInput[] {
  return seasons.map(s => ({
    name: s.name,
    fromMonth: s.fromMonth,
    toMonth: s.toMonth,
    weekdayPeriods: s.weekdayPeriods.map(w => ({
      touName: w.touName,
      fromHour: w.fromHour,
      fromMinute: w.fromMinute,
      toHour: w.toHour,
      toMinute: w.toMinute,
      buyRate: w.buyRate,
      sellRate: w.sellRate,
    })),
    weekendPeriods: s.weekendPeriods.map(w => ({
      touName: w.touName,
      fromHour: w.fromHour,
      fromMinute: w.fromMinute,
      toHour: w.toHour,
      toMinute: w.toMinute,
      buyRate: w.buyRate,
      sellRate: w.sellRate,
    })),
  }));
}

export function computeUncoveredGaps(
  periods: TariffPeriodDTO[],
  historyStart: string,
  today: string
): Array<{ from: string; to: string }> {
  const sorted = [...periods].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const gaps: Array<{ from: string; to: string }> = [];
  let cursor = historyStart;

  for (const period of sorted) {
    if (period.effectiveFrom > cursor) {
      const gapEnd = addCalendarDays(period.effectiveFrom, -1);
      if (cursor <= gapEnd) {
        gaps.push({ from: cursor, to: gapEnd });
      }
    }
    if (period.effectiveTo === null) {
      cursor = addCalendarDays(today, 366);
      break;
    }
    const nextCursor = addCalendarDays(period.effectiveTo, 1);
    if (nextCursor > cursor) {
      cursor = nextCursor;
    }
  }

  if (cursor <= today) {
    gaps.push({ from: cursor, to: today });
  }
  return gaps;
}

function renderPeriodMarkdown(period: TariffPeriodDTO, currency: string): string {
  const rangeLabel = `${period.effectiveFrom} to ${period.effectiveTo ?? 'Present (ongoing)'}`;
  const activeTag = period.isCurrentToday ? ' · Active today' : '';
  const lines: string[] = [
    `#### ${period.name} (Version ${period.version}${activeTag})`,
    `- **Effective Dates**: ${rangeLabel}`,
    `- **Source**: ${formatSourceLabel(period)}`,
    `- **Selection**: ${formatChoiceKindLabel(period)}`,
    `- **Start Date Provenance**: ${formatStartSourceLabel(period)}`,
    ...(period.urdbLabel ? [`- **OpenEI URDB Label**: \`${period.urdbLabel}\``] : []),
    `- **Verification**: ${formatVerificationLabel(period)}`,
    `- **Schedule Kind**: ${isTimeOfUsePeriod(period) ? 'Time of Use' : 'Fixed / Flat'}`,
    '',
  ];

  for (const season of period.seasons) {
    lines.push(`**Season: ${season.name}** (${formatMonthRange(season)})`);
    lines.push('');
    lines.push(`| Days | Rate Period | Time Window | Grid Buy Rate (${currency}/kWh) | Export Sell Rate (${currency}/kWh) |`);
    lines.push('| --- | --- | --- | --- | --- |');
    for (const w of season.weekdayPeriods) {
      lines.push(`| Mon – Fri | ${PERIOD_LABELS[w.touName]} | ${formatWindowTime(w)} | ${w.buyRate} | ${w.sellRate} |`);
    }
    for (const w of season.weekendPeriods) {
      lines.push(`| Sat – Sun & Holidays | ${PERIOD_LABELS[w.touName]} | ${formatWindowTime(w)} | ${w.buyRate} | ${w.sellRate} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function buildRatePlanAiHandoffMarkdown(
  timeline: SiteTariffsTimelineResponse,
  exportedDate?: string
): string {
  const exportedAt = exportedDate ?? siteLocalDateString(new Date(), timeline.timezone || 'UTC');
  const utilityName = timeline.estimates?.utilityName ?? null;
  const countryCode = timeline.rateCountry?.countryCode ?? null;
  const historyStart = timeline.systemCosts?.siteInstalled || '2015-01-01';
  const currency = timeline.currency || 'USD';

  const actualSortedDesc = [...timeline.periods].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const actualSortedAsc = [...timeline.periods].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const referenceSortedDesc = [...timeline.referencePeriods].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const referenceSortedAsc = [...timeline.referencePeriods].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

  const hasTouActual = timeline.periods.some(isTimeOfUsePeriod);
  const actualGaps = computeUncoveredGaps(timeline.periods, historyStart, exportedAt);

  const payload: RatePlanAiHandoffPayload = {
    schema: AI_HANDOFF_SCHEMA,
    utilityName,
    countryCode,
    currency,
    timeZone: timeline.timezone,
    historyStart,
    exportedAt,
    notes: [],
    sources: [],
    actualPeriods: actualSortedAsc.map(p => ({
      name: p.name,
      effectiveFrom: p.effectiveFrom,
      effectiveTo: p.effectiveTo,
      seasons: stripReadOnlySeasonFields(p.seasons),
    })),
    referencePeriods: referenceSortedAsc.map(p => ({
      name: p.name,
      effectiveFrom: p.effectiveFrom,
      effectiveTo: p.effectiveTo,
      seasons: stripReadOnlySeasonFields(p.seasons),
    })),
  };

  const lines: string[] = [
    '# PWUsage Rate Plan Cross-Check for Your AI Assistant',
    '',
    '## Instructions for the AI Assistant',
    '',
    'You are helping a homeowner verify and update their electric utility rate plans in **PWUsage** (a Tesla Powerwall energy monitoring and savings app).',
    '',
    'PWUsage tracks two rate plan timelines for this site:',
    '1. **Your rate plan (`actualPeriods`)**: The utility rate plans actually used to bill the home from the system installation date (`historyStart`) to the present.',
    '2. **Fixed comparison plan (`referencePeriods`)**: The utility’s standard flat/fixed residential rate plan over the same dates, used as a baseline to calculate Time of Use and solar/battery savings.',
    '',
    '### Your Steps',
    '1. **Check official utility tariff sheets**: Search published rate schedules for the utility listed below. Verify plan names, effective dates, seasonal month boundaries, weekday and weekend rate periods, all-in per-kWh grid buy rates (`buyRate`), and solar export credit rates (`sellRate`).',
    '2. **Ask for a utility bill if online searches are incomplete or ambiguous**: If published tariff sheets are unavailable, omit delivery/regulatory/fuel riders, or leave the homeowner’s exact rate schedule or effective date unclear, **ask the user to upload or paste a recent utility bill** (or a summer and a winter bill for seasonal plans). Extract the all-in per-kWh rates and billing dates from their bill.',
    '   - *Privacy rule*: If the user provides a utility bill, ignore and never output account numbers, meter numbers, customer names, or service addresses.',
    '3. **Fill uncovered historical gaps**: If any date gaps are listed below between `historyStart` and `exportedAt`, ask the user whether an existing plan or a prior rate schedule covered those dates.',
    hasTouActual
      ? '4. **Include the Fixed comparison plan (`referencePeriods`)**: Because the homeowner has a Time of Use rate plan, verify or populate `referencePeriods` with the utility’s standard fixed/flat residential rate plan covering the same dates (use a single all-day `OFF_PEAK` window `0:00`–`24:00` per season; if the flat plan is tiered, blend the baseline tiers for a typical household and note the assumption in `notes`).'
      : '4. **Fixed comparison plan (`referencePeriods`)**: If the homeowner is on or switches to a Time of Use plan, also populate `referencePeriods` with the utility’s standard fixed/flat residential rate plan for savings analysis.',
    '5. **Record sources and notes**: List official tariff sheet URLs or `"User-provided utility bill (YYYY-MM)"` in `sources`, and explain any rider inclusions or tier blending in `notes`.',
    '6. **Return the updated JSON**: Output a single fenced ```json code block matching the exact `pwusage-rate-plan-handoff/v1` schema below so the user can paste your reply back into PWUsage.',
    '',
    '---',
    '',
    '## Site Context & Rate Metadata',
    '',
    `- **Utility**: ${utilityName ?? 'Unknown (ask the homeowner for their electric utility)'}`,
    `- **Country**: ${countryCode ?? 'Unconfirmed'}`,
    `- **Timezone**: ${timeline.timezone}`,
    `- **Currency**: ${currency}`,
    `- **History Start Date (System Installed)**: ${historyStart}`,
    `- **Exported Date**: ${exportedAt}`,
    '- **Holiday Schedule Rule**: Observed holidays use the weekend schedule (`weekendPeriods`).',
  ];

  if (timeline.teslaSync.latestTariffName) {
    const syncDate = timeline.teslaSync.latestUpdatedAt
      ? timeline.teslaSync.latestUpdatedAt.slice(0, 10)
      : 'unknown date';
    lines.push(
      `- **Latest Plan Read from Tesla**: "${timeline.teslaSync.latestTariffName}" (last synced ${syncDate}${
        timeline.teslaSync.differsFromActiveManual ? ' · differs from the active plan in PWUsage' : ''
      })`
    );
  }

  if (timeline.estimates) {
    if (timeline.estimates.teslaPlanOutOfDate && timeline.estimates.newerPlanName) {
      lines.push(
        `- **Public Rate Database Hint**: OpenEI lists a newer revision "${timeline.estimates.newerPlanName}" starting ${
          timeline.estimates.newerPlanStart ?? 'recently'
        }. Verify whether this revision applies.`
      );
    }
    if (timeline.estimates.newestRevisionStart) {
      lines.push(
        `- **Newest Public Revision on Record**: ${timeline.estimates.newestRevisionStart}${
          timeline.estimates.mayBeOutdated ? ' (may be outdated — check utility for newer filings)' : ''
        }`
      );
    }
    if (timeline.estimates.historyGuide) {
      lines.push(
        `- **Unconfirmed Historical Window**: ${timeline.estimates.historyGuide.historyStart} to ${
          timeline.estimates.historyGuide.fillThrough ?? exportedAt
        } (${timeline.estimates.historyGuide.unconfirmedDays} days unconfirmed)`
      );
    }
  }

  lines.push('', '---', '', '## 1. Your Rate Plan (`actualPeriods`)', '');

  if (actualSortedDesc.length === 0) {
    lines.push('No rate plans are currently saved in PWUsage.', '');
  } else {
    for (const period of actualSortedDesc) {
      lines.push(renderPeriodMarkdown(period, currency));
    }
  }

  if (actualGaps.length > 0) {
    lines.push('### Uncovered Date Gaps in Your Rate Plan');
    for (const gap of actualGaps) {
      lines.push(`- **Gap**: ${gap.from} to ${gap.to} (no rate plan assigned for these dates)`);
    }
    lines.push('');
  }

  lines.push('---', '', '## 2. Fixed Comparison Plan (`referencePeriods`)', '');

  if (referenceSortedDesc.length === 0) {
    lines.push(
      hasTouActual
        ? 'No Fixed comparison plan is currently configured. Because Your rate plan uses Time of Use rates, populate `referencePeriods` with the utility’s standard fixed/flat residential rate plan so PWUsage can calculate Time of Use savings.'
        : 'No Fixed comparison plan is currently configured.',
      ''
    );
  } else {
    for (const period of referenceSortedDesc) {
      lines.push(renderPeriodMarkdown(period, currency));
    }
  }

  lines.push(
    '---',
    '',
    '## Re-Import Schema Rules (`pwusage-rate-plan-handoff/v1`)',
    '',
    'When returning corrections, output a single ```json code block adhering to these validation rules:',
    '- `schema`: Must be `"pwusage-rate-plan-handoff/v1"`.',
    '- `actualPeriods` and `referencePeriods`: Arrays of rate plan periods (1–12 periods total across both arrays). Within each array, date ranges must not overlap.',
    '- `name`: 1–64 characters.',
    `- \`effectiveFrom\`: \`YYYY-MM-DD\` between \`2015-01-01\` and 1 year after \`${exportedAt}\`.`,
    '- `effectiveTo`: `YYYY-MM-DD` (on or after `effectiveFrom`) or `null` if the plan is currently ongoing.',
    '- `seasons`: 1–6 seasons per plan. `fromMonth` and `toMonth` are integers `1`..`12` (wrapping across year-end like `fromMonth: 10, toMonth: 5` is supported). All 12 months (`1`..`12`) must be covered across the plan’s seasons without gaps or overlaps.',
    '- `weekdayPeriods` (Mon–Fri) and `weekendPeriods` (Sat–Sun & observed holidays): 1–48 time windows each. Must cover all 24 hours (`0:00` to `24:00`) without gaps or overlaps.',
    '- `fromHour` (`0`..`23`), `toHour` (`0`..`24`), `fromMinute` and `toMinute` (`0` or `30` only — 30-minute increments). A single all-day window is `fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0`.',
    '- `touName`: Must be one of `"ON_PEAK"`, `"PARTIAL_PEAK"`, `"OFF_PEAK"`, or `"SUPER_OFF_PEAK"`.',
    `- \`buyRate\` (all-in grid rate in ${currency}/kWh) and \`sellRate\` (export credit rate in ${currency}/kWh): Numbers between \`0\` and \`10\` with at most 5 decimal places.`,
    '- `notes`: Array of up to 10 short strings explaining any assumptions or bill rider inclusions.',
    '- `sources`: Array of up to 10 URLs or bill citations (e.g. `"User-provided utility bill (2026-08)"`).',
    '',
    '## Current Rate Plans JSON',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    ''
  );

  return lines.join('\n');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractJsonText(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new TariffValidationError('Paste the AI assistant response or JSON block to preview changes.');
  }
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_RAW_INPUT_BYTES) {
    throw new TariffValidationError('The pasted input is too large (maximum 256 KB).');
  }

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(trimmed)) !== null) {
    const body = match[1].trim();
    if (body.startsWith('{')) {
      candidates.push(body);
    }
  }

  if (candidates.length > 0) {
    const matchingSchema = candidates.filter(c => c.includes(AI_HANDOFF_SCHEMA));
    return (matchingSchema.at(-1) ?? candidates.at(-1)) as string;
  }

  return trimmed;
}

function parseStringList(raw: unknown, fieldName: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new TariffValidationError(`${fieldName} must be an array of strings.`);
  }
  if (raw.length > MAX_NOTES_OR_SOURCES) {
    throw new TariffValidationError(`${fieldName} can contain at most ${MAX_NOTES_OR_SOURCES} items.`);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new TariffValidationError(`Each item in ${fieldName} must be a string.`);
    }
    const clean = item.trim();
    if (!clean) continue;
    if (clean.length > MAX_NOTE_LENGTH) {
      throw new TariffValidationError(`Each item in ${fieldName} must be at most ${MAX_NOTE_LENGTH} characters.`);
    }
    out.push(clean);
  }
  return out;
}

function parseScopePeriods(
  rawList: unknown,
  scopeLabel: string,
  todaySiteLocal: string
): TariffPlanWriteInput[] {
  if (!Array.isArray(rawList)) {
    throw new TariffValidationError(`${scopeLabel} must be an array of rate plan periods.`);
  }
  if (rawList.length > MAX_PERIODS_PER_SCOPE) {
    throw new TariffValidationError(`${scopeLabel} can contain at most ${MAX_PERIODS_PER_SCOPE} periods.`);
  }

  const validated: TariffPlanWriteInput[] = rawList.map((item, idx) => {
    if (!isPlainObject(item)) {
      throw new TariffValidationError(`${scopeLabel}[${idx}] must be an object.`);
    }
    if (!('effectiveFrom' in item) || typeof item.effectiveFrom !== 'string') {
      throw new TariffValidationError(`${scopeLabel}[${idx}] is missing a valid effectiveFrom date (YYYY-MM-DD).`);
    }
    if (!('effectiveTo' in item) || (item.effectiveTo !== null && typeof item.effectiveTo !== 'string')) {
      throw new TariffValidationError(`${scopeLabel}[${idx}] must specify effectiveTo as YYYY-MM-DD or null.`);
    }
    if (!Array.isArray(item.seasons)) {
      throw new TariffValidationError(`${scopeLabel}[${idx}] must include 1–6 seasons.`);
    }
    return validateTariffPlanInput(
      {
        name: typeof item.name === 'string' ? item.name : '',
        effectiveFrom: item.effectiveFrom.trim(),
        effectiveTo: item.effectiveTo === null ? null : item.effectiveTo.trim(),
        seasons: item.seasons as TariffSeasonInput[],
      },
      todaySiteLocal
    );
  });

  const sorted = [...validated].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev.effectiveTo === null || prev.effectiveTo >= cur.effectiveFrom) {
      throw new TariffValidationError(
        `${scopeLabel} contains overlapping dates: "${prev.name}" (${prev.effectiveFrom} to ${
          prev.effectiveTo ?? 'ongoing'
        }) overlaps "${cur.name}" (starting ${cur.effectiveFrom}).`
      );
    }
  }

  return sorted;
}

export function parseRatePlanAiHandoffInput(
  rawInput: string,
  todaySiteLocal: string
): ParsedRatePlanAiHandoff {
  const jsonText = extractJsonText(rawInput);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new TariffValidationError(
      'Could not parse JSON from the pasted text. Make sure the AI assistant returned a valid ```json block.'
    );
  }

  if (!isPlainObject(parsed)) {
    throw new TariffValidationError('The AI handoff payload must be a JSON object.');
  }
  if (parsed.schema !== AI_HANDOFF_SCHEMA) {
    throw new TariffValidationError(
      `Unsupported or missing schema (expected "${AI_HANDOFF_SCHEMA}").`
    );
  }

  const notes = parseStringList(parsed.notes, 'notes');
  const sources = parseStringList(parsed.sources, 'sources');
  const actualPeriods = parseScopePeriods(parsed.actualPeriods ?? [], 'actualPeriods', todaySiteLocal);
  const referencePeriods = parseScopePeriods(parsed.referencePeriods ?? [], 'referencePeriods', todaySiteLocal);

  if (actualPeriods.length === 0 && referencePeriods.length === 0) {
    throw new TariffValidationError(
      'The imported JSON must include at least one rate plan in actualPeriods or referencePeriods.'
    );
  }

  return {
    schema: AI_HANDOFF_SCHEMA,
    notes,
    sources,
    actualPeriods,
    referencePeriods,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run from `cmd/next-app`:
```bash
npm test -- --run src/lib/tariff-ai-handoff.test.ts
```
Expected: PASS (all 5 tests).

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/tariff-contract.ts cmd/next-app/src/lib/tariff-ai-handoff.ts cmd/next-app/src/lib/tariff-ai-handoff.test.ts
git commit -m "feat(tariffs): add AI rate plan handoff serializer, parser, and contract"
```

---

### Task 2: Batch Preview, Atomic Commit Service, and API Routes

**Files:**
- Modify: `cmd/next-app/src/lib/tariff-timeline-repo.ts`
- Create: `cmd/next-app/src/lib/tariff-ai-handoff-service.ts`
- Create: `cmd/next-app/src/lib/tariff-ai-handoff-service.test.ts`
- Create: `cmd/next-app/src/app/api/site/[id]/tariffs/ai-handoff/route.ts`
- Create: `cmd/next-app/src/app/api/site/[id]/tariffs/ai-handoff/preview/route.ts`
- Create: `cmd/next-app/src/app/api/site/[id]/tariffs/ai-handoff/commit/route.ts`
- Create: `cmd/next-app/src/app/api/site/[id]/tariffs/ai-handoff/route.test.ts`

**Interfaces:**
- Consumes: `parseRatePlanAiHandoffInput`, `buildRatePlanAiHandoffMarkdown` from `cmd/next-app/src/lib/tariff-ai-handoff.ts`; `buildTariffSelectionPreview`, `ExistingTimelineSpanInput` from `cmd/next-app/src/lib/tariff-selection.ts`; `TariffTimelineRepo`, `applyTariffSelectionOnClient`, `loadScopeSelectionSpans` from `cmd/next-app/src/lib/tariff-timeline-repo.ts`.
- Produces:
  - `TariffAiHandoffConflictError`
  - `buildBatchAiHandoffPreview(...)`
  - `previewAiRatePlanHandoff(siteId, viewerUserId, rawBody, deps)`
  - `commitAiRatePlanHandoff(siteId, userId, rawBody, deps)`
  - `GET /api/site/[id]/tariffs/ai-handoff`
  - `POST /api/site/[id]/tariffs/ai-handoff/preview`
  - `POST /api/site/[id]/tariffs/ai-handoff/commit`

- [ ] **Step 1: Write failing service & route tests**

Create `cmd/next-app/src/lib/tariff-ai-handoff-service.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { AI_HANDOFF_SCHEMA } from './tariff-ai-handoff';
import {
  buildBatchAiHandoffPreview,
  commitAiRatePlanHandoff,
  previewAiRatePlanHandoff,
  TariffAiHandoffConflictError,
} from './tariff-ai-handoff-service';
import type { TariffReviewPlanSnapshot, TariffSeasonInput } from './tariff-contract';
import { tariffContentHash } from './importer/tariff-parser';
import { compileSeasonsToParsedTariff, TariffValidationError } from './tariff-timeline';
import type { ExistingTimelineSpanInput } from './tariff-selection';

const FLAT_SEASONS: TariffSeasonInput[] = [
  {
    name: 'All Year',
    fromMonth: 1,
    toMonth: 12,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.08 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.12, sellRate: 0.08 },
    ],
  },
];

const UPDATED_TOU_SEASONS: TariffSeasonInput[] = [
  {
    name: 'All Year',
    fromMonth: 1,
    toMonth: 12,
    weekdayPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 16, toMinute: 0, buyRate: 0.1, sellRate: 0.08 },
      { touName: 'ON_PEAK', fromHour: 16, fromMinute: 0, toHour: 21, toMinute: 0, buyRate: 0.28, sellRate: 0.08 },
      { touName: 'OFF_PEAK', fromHour: 21, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.08 },
    ],
    weekendPeriods: [
      { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.1, sellRate: 0.08 },
    ],
  },
];

function makeExistingSpan(
  name: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  seasons: TariffSeasonInput[],
  source: 'tesla' | 'manual' | 'estimated' = 'tesla'
): ExistingTimelineSpanInput {
  const hash = tariffContentHash(compileSeasonsToParsedTariff(name, seasons));
  const plan: TariffReviewPlanSnapshot = {
    tariffId: 10,
    version: 1,
    periodId: 1,
    selectionId: 5,
    name,
    utilityName: 'Austin Energy',
    source,
    choiceKind: source === 'manual' ? 'owner' : 'automatic',
    urdbLabel: null,
    revisionStart: null,
    contentHash: hash,
    exportRateProvenance: source === 'tesla' ? 'tesla' : 'manual',
    holidaysUseWeekendSchedule: true,
    seasons,
    approximationNotes: [],
    verification: null,
  };
  return { effectiveFrom, effectiveTo, plan };
}

describe('tariff-ai-handoff-service', () => {
  it('skips unchanged periods and previews changed actual and reference periods sequentially', async () => {
    const existingActual = [makeExistingSpan('Tesla Plan', '2024-01-01', null, FLAT_SEASONS, 'tesla')];
    const existingRef = [makeExistingSpan('Ref Flat', '2024-01-01', null, FLAT_SEASONS, 'estimated')];

    const rawInput = JSON.stringify({
      schema: AI_HANDOFF_SCHEMA,
      notes: ['Verified peak hours 4pm-9pm from utility tariff sheet.'],
      sources: ['https://austinenergy.com/rates'],
      actualPeriods: [
        { name: 'Austin TOU 2024', effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31', seasons: UPDATED_TOU_SEASONS },
        { name: 'Austin TOU 2025', effectiveFrom: '2025-01-01', effectiveTo: null, seasons: UPDATED_TOU_SEASONS },
      ],
      referencePeriods: [
        // Exact same content, name, and dates as existingRef -> should be counted as unchanged
        { name: 'Ref Flat', effectiveFrom: '2024-01-01', effectiveTo: null, seasons: FLAT_SEASONS },
      ],
    });

    const preview = buildBatchAiHandoffPreview({
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      todaySiteLocal: '2026-11-18',
      eligibility: 'us',
      rawInput,
      actualSpans: existingActual,
      referenceSpans: existingRef,
    });

    expect(preview.unchangedActualCount).toBe(0);
    expect(preview.unchangedReferenceCount).toBe(1);
    expect(preview.actualPreviews).toHaveLength(2);
    expect(preview.referencePreviews).toHaveLength(0);
    expect(preview.recalculatesHistory).toBe(true);
    expect(preview.notes).toEqual(['Verified peak hours 4pm-9pm from utility tariff sheet.']);
    expect(preview.sources).toEqual(['https://austinenergy.com/rates']);
    // Second period previews against the simulated timeline after the first period split 2024
    expect(preview.actualPreviews[1].effectiveFrom).toBe('2025-01-01');
  });

  it('commits reviewed batch changes via repo.commitAiHandoffSelections and rejects missing reviewHash', async () => {
    const existingActual = [makeExistingSpan('Tesla Plan', '2024-01-01', null, FLAT_SEASONS, 'tesla')];
    const rawInput = JSON.stringify({
      schema: AI_HANDOFF_SCHEMA,
      actualPeriods: [
        { name: 'Austin TOU', effectiveFrom: '2024-01-01', effectiveTo: null, seasons: UPDATED_TOU_SEASONS },
      ],
      referencePeriods: [],
    });

    const repo = {
      getSiteUtilityContext: vi.fn().mockResolvedValue({
        name: 'Austin Energy',
        timezone: 'America/Chicago',
        currency: 'USD',
        rateCountry: 'US',
        eligibility: 'us',
      }),
      loadAiHandoffSpans: vi.fn().mockResolvedValue({
        actualSpans: existingActual,
        referenceSpans: [],
      }),
      commitAiHandoffSelections: vi.fn(),
    };

    const preview = await previewAiRatePlanHandoff('site-1', 'user-1', { rawInput }, {
      now: () => new Date('2026-11-18T12:00:00Z'),
      repo,
    });

    await expect(
      commitAiRatePlanHandoff('site-1', 'user-1', { rawInput, expectedReviewHash: '', verifiedAgainstBill: false }, {
        now: () => new Date('2026-11-18T12:00:00Z'),
        repo,
      })
    ).rejects.toThrow(TariffValidationError);

    repo.commitAiHandoffSelections.mockResolvedValue({
      selectionIds: [11],
      tariffIds: [22],
      appliedActualCount: 1,
      appliedReferenceCount: 0,
      unchanged: false,
      reattributionRange: { fromDate: '2024-01-01', toDate: null },
      timeline: { version: 2, siteId: 'site-1' },
    });

    const committed = await commitAiRatePlanHandoff(
      'site-1',
      'user-1',
      { rawInput, expectedReviewHash: preview.reviewHash, verifiedAgainstBill: true },
      { now: () => new Date('2026-11-18T12:00:00Z'), repo }
    );

    expect(committed.appliedActualCount).toBe(1);
    expect(repo.commitAiHandoffSelections).toHaveBeenCalledTimes(1);
    expect(UnitCheck(ConflictError)).toBe(true);
  });
});

function UnitCheck(ctor: typeof TariffAiHandoffConflictError): boolean {
  return typeof ctor === 'function';
}
```

- [ ] **Step 2: Run test to verify it fails**

Run from `cmd/next-app`:
```bash
npm test -- --run src/lib/tariff-ai-handoff-service.test.ts
```
Expected: FAIL with module `./tariff-ai-handoff-service` not found.

- [ ] **Step 3: Implement `cmd/next-app/src/lib/tariff-ai-handoff-service.ts` and repo methods in `cmd/next-app/src/lib/tariff-timeline-repo.ts`**

Create `cmd/next-app/src/lib/tariff-ai-handoff-service.ts`:

```ts
import { createHash } from 'crypto';
import { tariffContentHash } from './importer/tariff-parser';
import { deriveRatePlanEligibility, type RatePlanEligibility } from './rate-plan-eligibility';
import { parseRatePlanAiHandoffInput } from './tariff-ai-handoff';
import type {
  TariffAiHandoffCommitResponse,
  TariffAiHandoffPreviewResponse,
  TariffReviewPlanSnapshot,
  TariffSelectionPreviewResponse,
  TariffSelectionScope,
} from './tariff-contract';
import {
  buildTariffSelectionPreview,
  type ExistingTimelineSpanInput,
} from './tariff-selection';
import {
  addCalendarDays,
  compileSeasonsToParsedTariff,
  MAX_PLAN_NAME_LENGTH,
  siteLocalDateString,
  TariffValidationError,
  type TariffPlanWriteInput,
} from './tariff-timeline';
import { TariffNotFoundError, TariffTimelineRepo } from './tariff-timeline-repo';

export class TariffAiHandoffConflictError extends Error {
  readonly status = 409;
  readonly code = 'REVIEW_STALE' as const;
  readonly preview: TariffAiHandoffPreviewResponse;

  constructor(preview: TariffAiHandoffPreviewResponse) {
    super('Your rate plans changed while you were reviewing. Review the updated changes before applying.');
    this.name = 'TariffAiHandoffConflictError';
    this.preview = preview;
  }
}

export interface PreparedAiHandoffPeriod {
  scope: TariffSelectionScope;
  period: TariffPlanWriteInput;
  contentHash: string;
  preview: TariffSelectionPreviewResponse;
}

export interface BuiltBatchAiHandoffPreview {
  response: TariffAiHandoffPreviewResponse;
  changedActual: PreparedAiHandoffPeriod[];
  changedReference: PreparedAiHandoffPeriod[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function disambiguateBatchPlanName(
  baseName: string,
  contentHash: string,
  effectiveFrom: string,
  existingSpans: ExistingTimelineSpanInput[],
  assignedInBatch: Array<{ name: string; contentHash: string }>
): string {
  const trimmed = baseName.trim();
  const isNameTaken = (candidate: string): boolean => {
    const lower = candidate.trim().toLowerCase();
    const clashInBatch = assignedInBatch.some(
      a => a.name.trim().toLowerCase() === lower && a.contentHash !== contentHash
    );
    if (clashInBatch) return true;

    return existingSpans.some(span => {
      if (span.plan.source === 'estimated' && span.plan.choiceKind !== 'owner') return false;
      const overlaps =
        (span.effectiveTo === null || span.effectiveTo >= effectiveFrom) &&
        span.effectiveFrom <= effectiveFrom;
      if (overlaps) return false;
      return span.plan.name.trim().toLowerCase() === lower && span.plan.contentHash !== contentHash;
    });
  };

  const withSuffix = (suffix: string) =>
    `${trimmed.slice(0, MAX_PLAN_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
  const candidates = [
    trimmed,
    withSuffix(` (${effectiveFrom.slice(0, 4)})`),
    withSuffix(` (${effectiveFrom})`),
  ];
  for (const c of candidates) {
    if (!isNameTaken(c)) return c;
  }
  for (let i = 2; ; i++) {
    const c = withSuffix(` (${effectiveFrom}, ${i})`);
    if (!isNameTaken(c)) return c;
  }
}

function simulateSpanReplacement(
  spans: ExistingTimelineSpanInput[],
  incoming: TariffPlanWriteInput,
  candidatePlan: TariffReviewPlanSnapshot
): ExistingTimelineSpanInput[] {
  const next: ExistingTimelineSpanInput[] = [];
  for (const span of spans) {
    const overlaps =
      (span.effectiveTo === null || span.effectiveTo >= incoming.effectiveFrom) &&
      (incoming.effectiveTo === null || incoming.effectiveTo >= span.effectiveFrom);
    if (!overlaps) {
      next.push(span);
      continue;
    }
    if (span.effectiveFrom < incoming.effectiveFrom) {
      next.push({
        ...span,
        effectiveTo: addCalendarDays(incoming.effectiveFrom, -1),
      });
    }
    if (incoming.effectiveTo !== null && (span.effectiveTo === null || span.effectiveTo > incoming.effectiveTo)) {
      next.push({
        ...span,
        effectiveFrom: addCalendarDays(incoming.effectiveTo, 1),
      });
    }
  }
  next.push({
    effectiveFrom: incoming.effectiveFrom,
    effectiveTo: incoming.effectiveTo,
    plan: candidatePlan,
  });
  return next.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

function prepareScopePreviews(params: {
  siteId: string;
  timezone: string;
  currency: string;
  todaySiteLocal: string;
  eligibility: string;
  scope: TariffSelectionScope;
  periods: TariffPlanWriteInput[];
  initialSpans: ExistingTimelineSpanInput[];
}): {
  unchangedCount: number;
  prepared: PreparedAiHandoffPeriod[];
} {
  let currentSpans = [...params.initialSpans];
  let unchangedCount = 0;
  const prepared: PreparedAiHandoffPeriod[] = [];
  const assignedNames: Array<{ name: string; contentHash: string }> = [];

  for (const rawPeriod of params.periods) {
    const rawParsed = compileSeasonsToParsedTariff(rawPeriod.name, rawPeriod.seasons);
    const rawHash = tariffContentHash(rawParsed);

    const exactMatch = currentSpans.find(
      s =>
        s.effectiveFrom === rawPeriod.effectiveFrom &&
        s.effectiveTo === rawPeriod.effectiveTo &&
        s.plan.contentHash === rawHash &&
        s.plan.name.trim().toLowerCase() === rawPeriod.name.trim().toLowerCase()
    );
    if (exactMatch) {
      unchangedCount += 1;
      assignedNames.push({ name: exactMatch.plan.name, contentHash: rawHash });
      continue;
    }

    const finalName =
      params.scope === 'actual'
        ? disambiguateBatchPlanName(rawPeriod.name, rawHash, rawPeriod.effectiveFrom, currentSpans, assignedNames)
        : rawPeriod.name.trim();
    const period: TariffPlanWriteInput = { ...rawPeriod, name: finalName };
    const parsed = compileSeasonsToParsedTariff(period.name, period.seasons);
    const contentHash = tariffContentHash(parsed);
    assignedNames.push({ name: finalName, contentHash });

    const candidatePlan: TariffReviewPlanSnapshot = {
      tariffId: null,
      version: null,
      periodId: null,
      selectionId: null,
      name: period.name,
      utilityName: null,
      source: 'manual',
      choiceKind: 'owner',
      urdbLabel: null,
      revisionStart: null,
      contentHash,
      exportRateProvenance: 'manual',
      holidaysUseWeekendSchedule: true,
      seasons: period.seasons,
      approximationNotes: [],
      verification: null,
    };

    const preview = buildTariffSelectionPreview({
      siteId: params.siteId,
      timezone: params.timezone,
      currency: params.currency,
      todaySiteLocal: params.todaySiteLocal,
      holidaysUseWeekendSchedule: true,
      request: {
        scope: params.scope,
        candidate: { kind: 'manual', name: period.name, seasons: period.seasons },
        effectiveFrom: period.effectiveFrom,
        effectiveTo: period.effectiveTo,
      },
      existingSpans: currentSpans,
      candidatePlan,
      eligibility: params.eligibility,
    });

    prepared.push({ scope: params.scope, period, contentHash, preview });
    currentSpans = simulateSpanReplacement(currentSpans, period, candidatePlan);
  }

  return { unchangedCount, prepared };
}

export function buildBatchAiHandoffPreviewWithDetails(params: {
  siteId: string;
  timezone: string;
  currency: string;
  todaySiteLocal: string;
  eligibility: RatePlanEligibility;
  rawInput: string;
  actualSpans: ExistingTimelineSpanInput[];
  referenceSpans: ExistingTimelineSpanInput[];
}): BuiltBatchAiHandoffPreview {
  const parsed = parseRatePlanAiHandoffInput(params.rawInput, params.todaySiteLocal);

  const actualResult = prepareScopePreviews({
    siteId: params.siteId,
    timezone: params.timezone,
    currency: params.currency,
    todaySiteLocal: params.todaySiteLocal,
    eligibility: params.eligibility,
    scope: 'actual',
    periods: parsed.actualPeriods,
    initialSpans: params.actualSpans,
  });

  const referenceResult = prepareScopePreviews({
    siteId: params.siteId,
    timezone: params.timezone,
    currency: params.currency,
    todaySiteLocal: params.todaySiteLocal,
    eligibility: params.eligibility,
    scope: 'reference',
    periods: parsed.referencePeriods,
    initialSpans: params.referenceSpans,
  });

  const actualPreviews = actualResult.prepared.map(p => p.preview);
  const referencePreviews = referenceResult.prepared.map(p => p.preview);

  let fromDate: string | null = null;
  let toDate: string | null = null;
  let hasNullEnd = false;
  let recalculatesFromHistoryStart = false;

  for (const prev of actualPreviews) {
    if (!prev.recalculatesHistory || !prev.recalculationRange) continue;
    if (prev.recalculatesFromHistoryStart) recalculatesFromHistoryStart = true;
    if (fromDate === null || prev.recalculationRange.fromDate < fromDate) {
      fromDate = prev.recalculationRange.fromDate;
    }
    if (prev.recalculationRange.toDate === null) {
      hasNullEnd = true;
      toDate = null;
    } else if (!hasNullEnd && (toDate === null || prev.recalculationRange.toDate > toDate)) {
      toDate = prev.recalculationRange.toDate;
    }
  }

  const recalculatesHistory = fromDate !== null;
  const recalculationRange = fromDate !== null ? { fromDate, toDate: hasNullEnd ? null : toDate } : null;

  const reviewHash = createHash('sha256')
    .update(
      JSON.stringify({
        siteId: params.siteId,
        actualHashes: actualPreviews.map(p => p.reviewHash),
        referenceHashes: referencePreviews.map(p => p.reviewHash),
        unchangedActualCount: actualResult.unchangedCount,
        unchangedReferenceCount: referenceResult.unchangedCount,
      })
    )
    .digest('hex');

  return {
    response: {
      reviewHash,
      siteId: params.siteId,
      currency: params.currency,
      unit: 'kWh',
      timezone: params.timezone,
      notes: parsed.notes,
      sources: parsed.sources,
      unchangedActualCount: actualResult.unchangedCount,
      unchangedReferenceCount: referenceResult.unchangedCount,
      actualPreviews,
      referencePreviews,
      recalculatesHistory,
      recalculatesFromHistoryStart,
      recalculationRange,
      affectsPowerwallPlan: false,
    },
    changedActual: actualResult.prepared,
    changedReference: referenceResult.prepared,
  };
}

export function buildBatchAiHandoffPreview(params: {
  siteId: string;
  timezone: string;
  currency: string;
  todaySiteLocal: string;
  eligibility: RatePlanEligibility;
  rawInput: string;
  actualSpans: ExistingTimelineSpanInput[];
  referenceSpans: ExistingTimelineSpanInput[];
}): TariffAiHandoffPreviewResponse {
  return buildBatchAiHandoffPreviewWithDetails(params).response;
}

export interface TariffAiHandoffServiceDeps {
  now?: () => Date;
  repo?: Pick<
    TariffTimelineRepo,
    'getSiteUtilityContext' | 'loadAiHandoffSpans' | 'commitAiHandoffSelections'
  >;
}

export async function previewAiRatePlanHandoff(
  siteId: string,
  viewerUserId: string,
  rawBody: unknown,
  deps?: TariffAiHandoffServiceDeps
): Promise<TariffAiHandoffPreviewResponse> {
  if (!isPlainObject(rawBody) || typeof rawBody.rawInput !== 'string') {
    throw new TariffValidationError('rawInput is required.');
  }
  const repo = deps?.repo ?? new TariffTimelineRepo();
  const now = (deps?.now ?? (() => new Date()))();
  const site = await repo.getSiteUtilityContext(siteId);
  if (!site) throw new TariffNotFoundError('Site not found');

  const timezone = site.timezone || 'UTC';
  const currency = (site.currency || 'USD').trim().toUpperCase();
  const todaySiteLocal = siteLocalDateString(now, timezone);
  const eligibility = site.eligibility ?? deriveRatePlanEligibility(site.rateCountry ?? null);

  const { actualSpans, referenceSpans } = await repo.loadAiHandoffSpans(siteId, viewerUserId);

  return buildBatchAiHandoffPreview({
    siteId,
    timezone,
    currency,
    todaySiteLocal,
    eligibility,
    rawInput: rawBody.rawInput,
    actualSpans,
    referenceSpans,
  });
}

export async function commitAiRatePlanHandoff(
  siteId: string,
  userId: string,
  rawBody: unknown,
  deps?: TariffAiHandoffServiceDeps
): Promise<TariffAiHandoffCommitResponse> {
  if (!isPlainObject(rawBody) || typeof rawBody.rawInput !== 'string') {
    throw new TariffValidationError('rawInput is required.');
  }
  if (typeof rawBody.expectedReviewHash !== 'string' || rawBody.expectedReviewHash.trim().length === 0) {
    throw new TariffValidationError('expectedReviewHash is required.');
  }
  if (typeof rawBody.verifiedAgainstBill !== 'boolean') {
    throw new TariffValidationError('verifiedAgainstBill must be a boolean.');
  }

  const repo = deps?.repo ?? new TariffTimelineRepo();
  const now = (deps?.now ?? (() => new Date()))();

  return repo.commitAiHandoffSelections(siteId, {
    userId,
    rawInput: rawBody.rawInput,
    expectedReviewHash: rawBody.expectedReviewHash.trim(),
    verifiedAgainstBill: rawBody.verifiedAgainstBill,
    now,
  });
}
```

Next, add `loadAiHandoffSpans` and `commitAiHandoffSelections` to `TariffTimelineRepo` in `cmd/next-app/src/lib/tariff-timeline-repo.ts`:

```ts
  async loadAiHandoffSpans(
    siteId: string,
    viewerUserId: string | null
  ): Promise<{
    actualSpans: ExistingTimelineSpanInput[];
    referenceSpans: ExistingTimelineSpanInput[];
  }> {
    const [actualSpans, referenceSpans] = await Promise.all([
      loadScopeSelectionSpans(pool, siteId, 'actual', viewerUserId),
      loadScopeSelectionSpans(pool, siteId, 'reference', viewerUserId),
    ]);
    return { actualSpans, referenceSpans };
  }

  async commitAiHandoffSelections(
    siteId: string,
    input: {
      userId: string;
      rawInput: string;
      expectedReviewHash: string;
      verifiedAgainstBill: boolean;
      now?: Date;
    }
  ): Promise<import('./tariff-contract').TariffAiHandoffCommitResponse> {
    const { userId, rawInput, expectedReviewHash, verifiedAgainstBill } = input;
    const now = input.now ?? new Date();
    const client = await pool.connect();
    const selectionIds: number[] = [];
    const tariffIds: number[] = [];
    let appliedActualCount = 0;
    let appliedReferenceCount = 0;
    let reattributionFrom: string | null = null;
    let reattributionTo: string | null = null;
    let hasReattribution = false;
    let reattribution: EnqueueReattributionParams | null = null;
    let queued: EnqueuedReattribution | null = null;

    try {
      await client.query('BEGIN');
      const siteRes = await client.query<{
        id: string;
        timezone: string;
        currency: string;
        rate_country?: string | null;
      }>(
        `SELECT id, timezone,
                COALESCE(json -> 'tariff_content_v2' ->> 'currency', json ->> 'currency', 'USD') AS currency,
                rate_country
         FROM "Site" WHERE id = $1 FOR UPDATE`,
        [siteId]
      );
      const site = siteRes.rows[0];
      if (!site) throw new TariffNotFoundError('Site not found');

      const timezone = site.timezone || 'UTC';
      const currency = (site.currency || 'USD').trim().toUpperCase();
      const today = siteLocalDateString(now, timezone);
      const eligibility = deriveRatePlanEligibility(site.rate_country ?? null);

      const actualSpans = await loadScopeSelectionSpans(client, siteId, 'actual', userId);
      const referenceSpans = await loadScopeSelectionSpans(client, siteId, 'reference', userId);

      const built = buildBatchAiHandoffPreviewWithDetails({
        siteId,
        timezone,
        currency,
        todaySiteLocal: today,
        eligibility,
        rawInput,
        actualSpans,
        referenceSpans,
      });

      if (built.response.reviewHash !== expectedReviewHash) {
        throw new TariffAiHandoffConflictError(built.response);
      }

      for (const item of [...built.changedActual, ...built.changedReference]) {
        const res = await applyTariffSelectionOnClient(client, siteId, today, {
          scope: item.scope,
          effectiveFrom: item.period.effectiveFrom,
          effectiveTo: item.period.effectiveTo,
          userId,
          verifiedAgainstBill,
          candidate: {
            kind: 'manual',
            name: item.period.name,
            seasons: item.period.seasons,
            holidaysUseWeekendSchedule: true,
          },
          reviewHash: item.preview.reviewHash,
        });
        selectionIds.push(...res.selectionIds);
        tariffIds.push(...res.tariffIds);
        if (!res.unchanged) {
          if (item.scope === 'actual') appliedActualCount += 1;
          else appliedReferenceCount += 1;
        }
        if (item.scope === 'actual' && res.reattributionRange) {
          if (!hasReattribution) {
            hasReattribution = true;
            reattributionFrom = res.reattributionRange.fromDate;
            reattributionTo = res.reattributionRange.toDate;
          } else {
            reattributionFrom = minDate(reattributionFrom as string, res.reattributionRange.fromDate);
            reattributionTo = maxEnd(reattributionTo, res.reattributionRange.toDate);
          }
        }
      }

      if (hasReattribution && reattributionFrom !== null) {
        reattribution = {
          siteId,
          fromDate: reattributionFrom,
          toDate: reattributionTo,
          requestedByUserId: userId,
          trigger: 'update',
        };
        queued = await enqueueReattributionOnClient(client, reattribution);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    const unchanged = appliedActualCount === 0 && appliedReferenceCount === 0;
    if (!unchanged) {
      new SiteRepo().invalidateCache(siteId);
    }
    if (reattribution && queued) {
      logReattributionEnqueued(reattribution, queued);
    }
    logEvent('info', 'tariff.ai_handoff.committed', {
      appliedActualCount,
      appliedReferenceCount,
      unchanged,
      verifiedAgainstBill,
      accountId: accountFingerprint(userId),
    });

    return {
      selectionIds,
      tariffIds: [...new Set(tariffIds)],
      appliedActualCount,
      appliedReferenceCount,
      unchanged,
      reattributionRange:
        hasReattribution && reattributionFrom !== null
          ? { fromDate: reattributionFrom, toDate: reattributionTo }
          : null,
      timeline: await this.getTimeline(siteId, userId),
    };
  }
```

- [ ] **Step 4: Create the three Next.js API routes and their route test**

Create `cmd/next-app/src/app/api/site/[id]/tariffs/ai-handoff/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import { buildRatePlanAiHandoffMarkdown } from '@/lib/tariff-ai-handoff';
import { TariffNotFoundError, TariffTimelineRepo } from '@/lib/tariff-timeline-repo';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/tariffs/ai-handoff', async () => {
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    try {
      const timeline = await new TariffTimelineRepo().getTimeline(siteId, user.id);
      const markdown = buildRatePlanAiHandoffMarkdown(timeline);
      return json({ markdown, filename: 'pwusage-rate-plan-check.md' }, 200);
    } catch (error) {
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not export rate plans.', ...errorFields(error) }, 500);
    }
  })(req);
}
```

Create `cmd/next-app/src/app/api/site/[id]/tariffs/ai-handoff/preview/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { withIoDeadline } from '@/lib/io-deadline';
import { errorFields, observeRoute, setLogContext } from '@/lib/observability';
import { isCrossOriginRequest } from '@/lib/request-security';
import { previewAiRatePlanHandoff } from '@/lib/tariff-ai-handoff-service';
import { TariffValidationError } from '@/lib/tariff-timeline';
import { TariffNotFoundError } from '@/lib/tariff-timeline-repo';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/tariffs/ai-handoff/preview', async () => {
    if (isCrossOriginRequest(req)) {
      return json({ error: 'Cross-origin requests are not allowed' }, 403);
    }
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid request body.' }, 400);
    }
    try {
      const preview = await withIoDeadline(30_000, () =>
        previewAiRatePlanHandoff(siteId, user.id, body)
      );
      return json(preview, 200);
    } catch (error) {
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not preview AI rate plan changes.', ...errorFields(error) }, 500);
    }
  })(req);
}
```

Create `cmd/next-app/src/app/api/site/[id]/tariffs/ai-handoff/commit/route.ts`:

```ts
import { after, NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, verifySiteAccess } from '@/lib/auth-checks';
import { withIoDeadline } from '@/lib/io-deadline';
import { errorFields, flushLogEvents, observeRoute, setLogContext } from '@/lib/observability';
import { isCrossOriginRequest } from '@/lib/request-security';
import {
  commitAiRatePlanHandoff,
  TariffAiHandoffConflictError,
} from '@/lib/tariff-ai-handoff-service';
import { jsonWithETag } from '@/lib/tariff-etag';
import { REATTRIBUTION_AFTER_MAX_TIME_MS, runSiteReattribution } from '@/lib/tariff-reattribution';
import { TariffValidationError } from '@/lib/tariff-timeline';
import { TariffNotFoundError } from '@/lib/tariff-timeline-repo';
import { startPendingEstimates } from '@/lib/urdb/start-estimates';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0' } });

export function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return observeRoute('/api/site/[id]/tariffs/ai-handoff/commit', async () => {
    if (isCrossOriginRequest(req)) {
      return json({ error: 'Cross-origin requests are not allowed' }, 403);
    }
    const { id: siteId } = await context.params;
    setLogContext({ siteId });
    const user = await getCurrentUser();
    if (!user || !(await verifySiteAccess(siteId))) {
      return json({ error: 'Unauthorized' }, 401);
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid request body.' }, 400);
    }
    try {
      const committed = await withIoDeadline(30_000, () =>
        commitAiRatePlanHandoff(siteId, user.id, body)
      );
      if (!committed.unchanged && committed.reattributionRange !== null) {
        after(async () => {
          try {
            await withIoDeadline(10_000, () =>
              runSiteReattribution({ siteId, trigger: 'after', maxTimeMs: REATTRIBUTION_AFTER_MAX_TIME_MS })
            );
          } finally {
            flushLogEvents();
          }
        });
      }
      startPendingEstimates(siteId, committed.timeline);
      return jsonWithETag(committed, 200);
    } catch (error) {
      if (error instanceof TariffAiHandoffConflictError) {
        return json(
          {
            error: error.message,
            code: error.code,
            preview: error.preview,
          },
          409
        );
      }
      if (error instanceof TariffValidationError) return json({ error: error.message }, 400);
      if (error instanceof TariffNotFoundError) return json({ error: error.message }, 404);
      return json({ error: 'Could not apply AI rate plan changes.', ...errorFields(error) }, 500);
    }
  })(req);
}
```

Create `cmd/next-app/src/app/api/site/[id]/tariffs/ai-handoff/route.test.ts`:

```ts
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  verifySiteAccess: vi.fn(),
  getTimeline: vi.fn(),
  previewAiRatePlanHandoff: vi.fn(),
  commitAiRatePlanHandoff: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({
  getCurrentUser: mocks.getCurrentUser,
  verifySiteAccess: mocks.verifySiteAccess,
}));

vi.mock('@/lib/tariff-timeline-repo', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/tariff-timeline-repo')>();
  return {
    ...actual,
    TariffTimelineRepo: class {
      getTimeline = mocks.getTimeline;
    },
  };
});

vi.mock('@/lib/tariff-ai-handoff-service', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/tariff-ai-handoff-service')>();
  return {
    ...actual,
    previewAiRatePlanHandoff: mocks.previewAiRatePlanHandoff,
    commitAiRatePlanHandoff: mocks.commitAiRatePlanHandoff,
  };
});

vi.mock('@/lib/urdb/start-estimates', () => ({
  startPendingEstimates: vi.fn(),
}));

import { GET } from './route';
import { POST as PREVIEW_POST } from './preview/route';
import { POST as COMMIT_POST } from './commit/route';
import { TariffAiHandoffConflictError } from '@/lib/tariff-ai-handoff-service';

describe('/api/site/[id]/tariffs/ai-handoff routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentUser.mockResolvedValue({ id: 'user-1', email: 'u@example.com' });
    mocks.verifySiteAccess.mockResolvedValue(true);
  });

  it('returns 401 when unauthorized on GET', async () => {
    mocks.verifySiteAccess.mockResolvedValueOnce(false);
    const req = new NextRequest('http://localhost/api/site/site-1/tariffs/ai-handoff');
    const res = await GET(req, { params: Promise.resolve({ id: 'site-1' }) });
    expect(res.status).toBe(401);
  });

  it('exports markdown on GET', async () => {
    mocks.getTimeline.mockResolvedValueOnce({
      version: 2,
      siteId: 'site-1',
      timezone: 'America/Chicago',
      currency: 'USD',
      periods: [],
      referencePeriods: [],
      estimates: null,
      battery: null,
      systemCosts: { siteInstalled: '2023-01-01', solar: null, powerwall: null },
      reattribution: null,
      holidayDates: [],
      teslaSync: { latestTariffId: null, latestTariffName: null, latestUpdatedAt: null, differsFromActiveManual: false },
    });
    const req = new NextRequest('http://localhost/api/site/site-1/tariffs/ai-handoff');
    const res = await GET(req, { params: Promise.resolve({ id: 'site-1' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.filename).toBe('pwusage-rate-plan-check.md');
    expect(body.markdown).toContain('pwusage-rate-plan-handoff/v1');
  });

  it('returns 409 REVIEW_STALE with fresh preview when commit conflicts', async () => {
    const stalePreview = {
      reviewHash: 'fresh-hash',
      siteId: 'site-1',
      currency: 'USD',
      unit: 'kWh' as const,
      timezone: 'America/Chicago',
      notes: [],
      sources: [],
      unchangedActualCount: 0,
      unchangedReferenceCount: 0,
      actualPreviews: [],
      referencePreviews: [],
      recalculatesHistory: false,
      recalculatesFromHistoryStart: false,
      recalculationRange: null,
      affectsPowerwallPlan: false as const,
    };
    mocks.commitAiRatePlanHandoff.mockRejectedValueOnce(new TariffAiHandoffConflictError(stalePreview));

    const req = new NextRequest('http://localhost/api/site/site-1/tariffs/ai-handoff/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify({ rawInput: '{}', expectedReviewHash: 'old-hash', verifiedAgainstBill: false }),
    });
    const res = await COMMIT_POST(req, { params: Promise.resolve({ id: 'site-1' }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.code).toBe('REVIEW_STALE');
    expect(data.preview.reviewHash).toBe('fresh-hash');
  });
});
```

- [ ] **Step 5: Run service and route tests to verify they pass**

Run from `cmd/next-app`:
```bash
npm test -- --run src/lib/tariff-ai-handoff-service.test.ts src/app/api/site/\[id\]/tariffs/ai-handoff/route.test.ts
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/tariff-timeline-repo.ts cmd/next-app/src/lib/tariff-ai-handoff-service.ts cmd/next-app/src/lib/tariff-ai-handoff-service.test.ts cmd/next-app/src/app/api/site/\[id\]/tariffs/ai-handoff
git commit -m "feat(tariffs): add AI handoff batch preview, atomic commit, and API routes"
```

---

### Task 3: Web UI — "Check with Your AI Assistant" Modal in Rate Plan Settings

**Files:**
- Create: `cmd/next-app/src/components/site/AiRatePlanHandoffModal.tsx`
- Modify: `cmd/next-app/src/components/site/TariffList.tsx`
- Modify: `cmd/next-app/src/components/site/SettingsView.tsx`
- Modify: `cmd/next-app/src/components/site/TariffList.test.tsx`

**Interfaces:**
- Consumes: `buildRatePlanAiHandoffMarkdown` from `@/lib/tariff-ai-handoff`; `SiteTariffsTimelineResponse`, `TariffAiHandoffPreviewResponse`, `TariffAiHandoffCommitResponse`, `TariffSelectionPreviewResponse` from `@/lib/tariff-contract`.
- Produces: `AiRatePlanHandoffModal` component and the **Check with Your AI Assistant** action in `TariffList`.

- [ ] **Step 1: Write failing Web component tests in `cmd/next-app/src/components/site/TariffList.test.tsx`**

Add tests to `cmd/next-app/src/components/site/TariffList.test.tsx` verifying:
1. The **Check with Your AI Assistant** button renders on `TariffList`.
2. Opening the modal shows the export Markdown with the utility bill tip (`"You can also attach a PDF or photo of your utility bill"`).
3. Switching to **Import AI Reply**, pasting a reply, and clicking **Preview Changes** renders the AI's `notes`, `sources`, before/after interval diffs, and requires **I reviewed these changes** before **Apply Rate Plan Changes** is enabled.
4. A `409 REVIEW_STALE` response on apply updates the preview and resets both checkboxes.

- [ ] **Step 2: Run the test to verify it fails**

Run from `cmd/next-app`:
```bash
npm test -- --run src/components/site/TariffList.test.tsx
```
Expected: FAIL because `Check with Your AI Assistant` is not rendered yet.

- [ ] **Step 3: Create `cmd/next-app/src/components/site/AiRatePlanHandoffModal.tsx` and wire into `TariffList.tsx` & `SettingsView.tsx`**

Create `cmd/next-app/src/components/site/AiRatePlanHandoffModal.tsx`:

```tsx
'use client';

import { useState, useMemo } from 'react';
import { buildRatePlanAiHandoffMarkdown } from '@/lib/tariff-ai-handoff';
import type {
  SiteTariffsTimelineResponse,
  TariffAiHandoffCommitResponse,
  TariffAiHandoffPreviewResponse,
  TariffPeriodName,
  TariffSelectionPreviewResponse,
} from '@/lib/tariff-contract';
import { Button } from '@/components/ui/Button';

interface AiRatePlanHandoffModalProps {
  timeline: SiteTariffsTimelineResponse;
  isOpen: boolean;
  onClose: () => void;
  onApplied: (nextTimeline: SiteTariffsTimelineResponse) => void;
}

const PERIOD_LABELS: Record<TariffPeriodName, string> = {
  ON_PEAK: 'Peak',
  PARTIAL_PEAK: 'Mid-Peak',
  OFF_PEAK: 'Off-Peak',
  SUPER_OFF_PEAK: 'Super Off-Peak',
};

function formatClock(hour: number, minute: number): string {
  const normalizedHour = hour === 24 ? 0 : hour;
  const suffix = normalizedHour >= 12 ? 'PM' : 'AM';
  const displayHour = normalizedHour % 12 === 0 ? 12 : normalizedHour % 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function renderScopePreviewSection(
  title: string,
  previews: TariffSelectionPreviewResponse[],
  currency: string
) {
  if (previews.length === 0) return null;
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h4>
      {previews.map((preview, pIdx) => (
        <div
          key={`${preview.scope}-${pIdx}`}
          className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 space-y-2 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-gray-900 dark:text-white">
              {preview.candidatePlan?.name ?? 'Rate Plan'}
            </span>
            <span className="text-gray-600 dark:text-gray-300">
              {preview.effectiveFrom} – {preview.effectiveTo ?? 'Present'}
            </span>
          </div>
          {preview.affectedIntervals.map((interval, iIdx) => (
            <div
              key={iIdx}
              className="rounded bg-gray-50 dark:bg-slate-800/60 p-2 space-y-1.5 border border-gray-100 dark:border-slate-700"
            >
              <div className="flex flex-wrap justify-between gap-2 font-medium">
                <span>
                  {interval.before ? `Replaces "${interval.before.name}"` : 'Fills uncovered dates'}
                </span>
                <span>
                  {interval.effectiveFrom} – {interval.effectiveTo ?? 'Present'}
                </span>
              </div>
              {interval.seasons.map((season, sIdx) => (
                <div key={sIdx} className="space-y-1 pt-1 border-t border-gray-200/70 dark:border-slate-700">
                  <p className="font-medium text-gray-700 dark:text-gray-300">
                    {season.afterSeasonName ?? season.beforeSeasonName ?? 'Season'} (Months {season.fromMonth}–{season.toMonth})
                  </p>
                  {season.weekdayRows.map((row, rIdx) => (
                    <div key={`wd-${rIdx}`} className="flex flex-wrap justify-between gap-2 text-gray-600 dark:text-gray-300">
                      <span>
                        Mon – Fri · {formatClock(row.fromHour, row.fromMinute)} – {formatClock(row.toHour, row.toMinute)}
                      </span>
                      <span>
                        {row.before
                          ? `${PERIOD_LABELS[row.before.touName]} ${currency} ${row.before.buyRate}/kWh → `
                          : ''}
                        {row.after
                          ? `${PERIOD_LABELS[row.after.touName]} ${currency} ${row.after.buyRate}/kWh (sell ${row.after.sellRate})`
                          : ''}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function AiRatePlanHandoffModal({
  timeline,
  isOpen,
  onClose,
  onApplied,
}: AiRatePlanHandoffModalProps) {
  const [step, setStep] = useState<'export' | 'import'>('export');
  const [copied, setCopied] = useState(false);
  const [rawInput, setRawInput] = useState('');
  const [preview, setPreview] = useState<TariffAiHandoffPreviewResponse | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isAcknowledged, setIsAcknowledged] = useState(false);
  const [isVerifiedAgainstBill, setIsVerifiedAgainstBill] = useState(false);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const markdown = useMemo(() => buildRatePlanAiHandoffMarkdown(timeline), [timeline]);

  if (!isOpen) return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleDownload = () => {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pwusage-rate-plan-check.md';
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleInputChanged = (value: string) => {
    setRawInput(value);
    setPreview(null);
    setIsAcknowledged(false);
    setIsVerifiedAgainstBill(false);
    setStaleNotice(null);
    setErrorMessage(null);
  };

  const handlePreview = async () => {
    setIsPreviewing(true);
    setErrorMessage(null);
    setStaleNotice(null);
    try {
      const res = await fetch(`/api/site/${timeline.siteId}/tariffs/ai-handoff/preview`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Could not preview rate plan changes.');
        return;
      }
      setPreview(data as TariffAiHandoffPreviewResponse);
      setIsAcknowledged(false);
      setIsVerifiedAgainstBill(false);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not preview rate plan changes.');
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleApply = async () => {
    if (!preview || !isAcknowledged) return;
    setIsApplying(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/site/${timeline.siteId}/tariffs/ai-handoff/commit`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawInput,
          expectedReviewHash: preview.reviewHash,
          verifiedAgainstBill: isVerifiedAgainstBill,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && data.code === 'REVIEW_STALE' && data.preview) {
        setPreview(data.preview as TariffAiHandoffPreviewResponse);
        setIsAcknowledged(false);
        setIsVerifiedAgainstBill(false);
        setStaleNotice(
          data.error ||
            'Your rate plans changed while you were reviewing. Review the updated changes before applying.'
        );
        return;
      }
      if (!res.ok) {
        setErrorMessage(data.error || 'Could not apply rate plan changes.');
        return;
      }
      const committed = data as TariffAiHandoffCommitResponse;
      onApplied(committed.timeline);
      onClose();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not apply rate plan changes.');
    } finally {
      setIsApplying(false);
    }
  };

  const hasChanges =
    preview !== null && (preview.actualPreviews.length > 0 || preview.referencePreviews.length > 0);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-handoff-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 shadow-xl p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-slate-800 pb-3">
          <h3 id="ai-handoff-modal-title" className="text-lg font-semibold text-gray-900 dark:text-white">
            Check with Your AI Assistant
          </h3>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="flex gap-2 border-b border-gray-100 dark:border-slate-800 pb-3">
          <Button
            size="sm"
            variant={step === 'export' ? 'default' : 'outline'}
            onClick={() => setStep('export')}
          >
            1. Export for Your AI Assistant
          </Button>
          <Button
            size="sm"
            variant={step === 'import' ? 'default' : 'outline'}
            onClick={() => setStep('import')}
          >
            2. Import AI Reply
          </Button>
        </div>

        {step === 'export' ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-900/20 p-3 text-xs text-blue-900 dark:text-blue-200 space-y-1">
              <p className="font-medium">How this works</p>
              <p>
                Copy or download this Markdown document and paste it into your AI assistant. You can also attach a PDF or photo of your utility bill so it can check your exact all-in rates.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={handleCopy}>
                {copied ? 'Copied to clipboard' : 'Copy Markdown'}
              </Button>
              <Button size="sm" variant="outline" onClick={handleDownload}>
                Download .md
              </Button>
              <Button size="sm" variant="outline" onClick={() => setStep('import')}>
                Next: Paste AI Reply
              </Button>
            </div>

            <pre
              aria-label="Exported rate plan Markdown"
              className="max-h-80 overflow-y-auto rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/60 p-3 text-xs font-mono whitespace-pre-wrap text-gray-800 dark:text-gray-200"
            >
              {markdown}
            </pre>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="ai-reply-textarea"
                className="block text-xs font-medium text-gray-700 dark:text-gray-300"
              >
                Paste the reply from your AI assistant (full message or JSON block)
              </label>
              <textarea
                id="ai-reply-textarea"
                rows={7}
                value={rawInput}
                onChange={e => handleInputChanged(e.target.value)}
                placeholder="Paste your AI assistant's response containing the ```json block..."
                className="w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 text-xs font-mono text-gray-900 dark:text-white"
              />
              <div className="flex items-center justify-between gap-2">
                <Button
                  size="sm"
                  onClick={handlePreview}
                  disabled={isPreviewing || rawInput.trim().length === 0}
                >
                  {isPreviewing ? 'Previewing...' : 'Preview Changes'}
                </Button>
              </div>
            </div>

            {errorMessage && (
              <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50/80 dark:bg-red-900/20 px-3 py-2 text-xs text-red-900 dark:text-red-200">
                {errorMessage}
              </div>
            )}

            {staleNotice && (
              <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/80 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                {staleNotice}
              </div>
            )}

            {preview && (
              <div className="space-y-4 border-t border-gray-100 dark:border-slate-800 pt-4">
                {(preview.notes.length > 0 || preview.sources.length > 0) && (
                  <div className="rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50 p-3 text-xs space-y-2">
                    {preview.notes.length > 0 && (
                      <div>
                        <p className="font-semibold text-gray-900 dark:text-white">Notes from your AI assistant</p>
                        <ul className="list-disc pl-4 space-y-0.5 text-gray-700 dark:text-gray-300">
                          {preview.notes.map((n, i) => (
                            <li key={i}>{n}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {preview.sources.length > 0 && (
                      <div>
                        <p className="font-semibold text-gray-900 dark:text-white">Sources</p>
                        <ul className="list-disc pl-4 space-y-0.5 text-gray-700 dark:text-gray-300">
                          {preview.sources.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {!hasChanges ? (
                  <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50/70 dark:bg-green-900/20 px-3 py-2 text-xs text-green-900 dark:text-green-200">
                    No rate plan changes found · The imported plans match your current timeline.
                  </div>
                ) : (
                  <>
                    {renderScopePreviewSection('Your Rate Plan Changes', preview.actualPreviews, preview.currency)}
                    {renderScopePreviewSection('Fixed Comparison Plan Changes', preview.referencePreviews, preview.currency)}

                    {preview.actualPreviews.length > 0 && (
                      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                        This changes the rates PWUsage uses for bills and savings estimates. Your Powerwall will continue using the plan saved in Tesla. Check the prices, time periods, export rates, and effective date against your utility bill.
                      </div>
                    )}

                    <div className="space-y-2 text-xs">
                      <label className="flex items-center gap-2 text-gray-800 dark:text-gray-200">
                        <input
                          type="checkbox"
                          checked={isAcknowledged}
                          onChange={e => setIsAcknowledged(e.target.checked)}
                        />
                        <span>I reviewed these changes</span>
                      </label>
                      <label className="flex items-center gap-2 text-gray-800 dark:text-gray-200">
                        <input
                          type="checkbox"
                          checked={isVerifiedAgainstBill}
                          onChange={e => setIsVerifiedAgainstBill(e.target.checked)}
                        />
                        <span>I checked these details against my utility bill</span>
                      </label>
                    </div>

                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        onClick={handleApply}
                        disabled={!isAcknowledged || isApplying}
                      >
                        {isApplying ? 'Applying...' : 'Apply Rate Plan Changes'}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

Update `cmd/next-app/src/components/site/TariffList.tsx` to accept `onTimelineUpdated?: (next: SiteTariffsTimelineResponse) => void`, render the **Check with Your AI Assistant** button next to **Sync from Tesla**, and mount `AiRatePlanHandoffModal` when `timeline` is present. Pass `onTimelineUpdated={setTimelineOverride}` from `SettingsView.tsx`.

- [ ] **Step 4: Run Web tests to verify they pass**

Run from `cmd/next-app`:
```bash
npm test -- --run src/components/site/TariffList.test.tsx src/components/site/SettingsView.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/components/site/AiRatePlanHandoffModal.tsx cmd/next-app/src/components/site/TariffList.tsx cmd/next-app/src/components/site/SettingsView.tsx cmd/next-app/src/components/site/TariffList.test.tsx
git commit -m "feat(web): add Check with Your AI Assistant export and review modal"
```

---

### Task 4: iOS Contract, Networking, and Coordinator Support

**Files:**
- Modify: `cmd/ios-app/PWUsage/Models/Bill/RatePlanSelection.swift`
- Modify: `cmd/ios-app/PWUsage/Networking/MobileTariffDataAPI.swift`
- Modify: `cmd/ios-app/PWUsage/Networking/PWUsageAPI+RatePlanSelection.swift`
- Modify: `cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+Tariffs.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/ActiveRatePlanCardView.swift`
- Modify: `cmd/ios-app/PWUsageTests/MobileTariffsDecodingTests+RatePlanSelection.swift`

**Interfaces:**
- Consumes: `TariffSelectionPreviewResponse`, `TariffReviewDateRange`, `SiteTariffsTimelineResponse` in `cmd/ios-app/PWUsage/Models/Bill/`.
- Produces:
  - `TariffAiHandoffExportResponse`, `TariffAiHandoffPreviewRequest`, `TariffAiHandoffPreviewResponse`, `TariffAiHandoffCommitRequest`, `TariffAiHandoffCommitResponse`
  - `RatePlanSelectionError.aiHandoffReviewStale(TariffAiHandoffPreviewResponse)`
  - `PWUsageAPI.exportRatePlanAiHandoff(siteID:)`, `previewRatePlanAiHandoff(siteID:rawInput:)`, `commitRatePlanAiHandoff(siteID:commit:)`
  - `RatePlanAiHandoffActions` on `TariffTimelineActions`

- [ ] **Step 1: Write failing decoding and transport tests in `cmd/ios-app/PWUsageTests/MobileTariffsDecodingTests+RatePlanSelection.swift`**

Add a `@Test` verifying decoding of `TariffAiHandoffExportResponse`, `TariffAiHandoffPreviewResponse`, `TariffAiHandoffCommitResponse`, and `409 REVIEW_STALE` conflict decoding into `RatePlanSelectionError.aiHandoffReviewStale`.

- [ ] **Step 2: Run targeted iOS tests to verify failure**

Run from repo root:
```bash
./cmd/ios-app/run-tests.sh --quick --only-testing:PWUsageTests/MobileTariffsDecodingTests
```
Expected: FAIL with missing `TariffAiHandoff*` types.

- [ ] **Step 3: Add Swift models, API methods, and `TariffTimelineActions` closures**

In `cmd/ios-app/PWUsage/Models/Bill/RatePlanSelection.swift`, add:

```swift
struct TariffAiHandoffExportResponse: Decodable, Equatable, Sendable {
    let markdown: String
    let filename: String
}

struct TariffAiHandoffPreviewRequest: Encodable, Equatable, Sendable {
    let rawInput: String
}

struct TariffAiHandoffPreviewResponse: Decodable, Equatable, Sendable {
    let reviewHash: String
    let siteId: String
    let currency: String
    let unit: String
    let timezone: String
    let notes: [String]
    let sources: [String]
    let unchangedActualCount: Int
    let unchangedReferenceCount: Int
    let actualPreviews: [TariffSelectionPreviewResponse]
    let referencePreviews: [TariffSelectionPreviewResponse]
    let recalculatesHistory: Bool
    let recalculatesFromHistoryStart: Bool
    let recalculationRange: TariffReviewDateRange?
    let affectsPowerwallPlan: Bool

    var hasChanges: Bool {
        !actualPreviews.isEmpty || !referencePreviews.isEmpty
    }

    func validating(siteID expectedSiteID: String) throws -> Self {
        guard siteId == expectedSiteID else { throw PWUsageAPIError.siteMismatch }
        return self
    }
}

struct TariffAiHandoffCommitRequest: Encodable, Equatable, Sendable {
    let rawInput: String
    let expectedReviewHash: String
    let verifiedAgainstBill: Bool
}

struct TariffAiHandoffCommitResponse: Decodable, Equatable, Sendable {
    let selectionIds: [Int]
    let tariffIds: [Int]
    let appliedActualCount: Int
    let appliedReferenceCount: Int
    let unchanged: Bool
    let reattributionRange: TariffReviewDateRange?
    let timeline: SiteTariffsTimelineResponse
}
```

And extend `RatePlanSelectionError`:
```swift
enum RatePlanSelectionError: Error, Equatable {
    case reviewStale(TariffSelectionPreviewResponse)
    case aiHandoffReviewStale(TariffAiHandoffPreviewResponse)
    case publicPlansUnavailable(RatePlanEligibility)
}
```

In `cmd/ios-app/PWUsage/Networking/PWUsageAPI+RatePlanSelection.swift`, add `exportRatePlanAiHandoff`, `previewRatePlanAiHandoff`, and `commitRatePlanAiHandoff`, and update `RatePlanSelectionConflict.decode(from:)` so a `409 REVIEW_STALE` body with `actualPreviews` decodes as `.aiHandoffReviewStale(batchPreview)`.

Wire the three methods into `MobileTariffDataAPI`, `DashboardCoordinator+Tariffs.swift`, and `TariffTimelineActions`.

- [ ] **Step 4: Run targeted iOS tests to verify they pass**

Run from repo root:
```bash
./cmd/ios-app/run-tests.sh --quick --only-testing:PWUsageTests/MobileTariffsDecodingTests
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/ios-app/PWUsage/Models/Bill/RatePlanSelection.swift cmd/ios-app/PWUsage/Networking/MobileTariffDataAPI.swift cmd/ios-app/PWUsage/Networking/PWUsageAPI+RatePlanSelection.swift cmd/ios-app/PWUsage/State/Home/DashboardCoordinator+Tariffs.swift cmd/ios-app/PWUsage/Views/Bill/ActiveRatePlanCardView.swift cmd/ios-app/PWUsageTests/MobileTariffsDecodingTests+RatePlanSelection.swift
git commit -m "feat(ios): add AI rate plan handoff contract and API methods"
```

---

### Task 5: iOS State Model and "Check with Your AI Assistant" Sheet UI

**Files:**
- Create: `cmd/ios-app/PWUsage/Models/Bill/RatePlanAiHandoffModel.swift`
- Create: `cmd/ios-app/PWUsage/Views/Bill/RatePlanAiHandoffSheet.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/TariffSheetModal.swift`
- Modify: `cmd/ios-app/PWUsage/Views/Bill/TariffSheet.swift`
- Create: `cmd/ios-app/PWUsageTests/RatePlanAiHandoffModelTests.swift`

**Interfaces:**
- Consumes: `TariffAiHandoffExportResponse`, `TariffAiHandoffPreviewResponse`, `TariffAiHandoffCommitRequest`, `TariffAiHandoffCommitResponse`, `RatePlanReviewIntervalSection`, `RatePlanReviewPresentation`.
- Produces: `RatePlanAiHandoffModel`, `RatePlanAiHandoffActions`, `RatePlanAiHandoffSheet`, `TariffSheetModal.aiHandoff`.

- [ ] **Step 1: Write failing state tests in `cmd/ios-app/PWUsageTests/RatePlanAiHandoffModelTests.swift`**

Create `cmd/ios-app/PWUsageTests/RatePlanAiHandoffModelTests.swift`:

```swift
import Foundation
@testable import PWUsage
import Testing

@MainActor
struct RatePlanAiHandoffModelTests {
    private static func makePreview(
        hash: String = "hash-1",
        hasChanges: Bool = true
    ) -> TariffAiHandoffPreviewResponse {
        let singlePreview = TariffSelectionPreviewResponse(
            reviewHash: "sub-1",
            siteId: "site-1",
            scope: .actual,
            effectiveFrom: "2024-01-01",
            effectiveTo: nil,
            currency: "USD",
            unit: "kWh",
            timezone: "America/Chicago",
            holidaysUseWeekendSchedule: true,
            recalculatesHistory: true,
            recalculatesFromHistoryStart: false,
            recalculationRange: TariffReviewDateRange(fromDate: "2024-01-01", toDate: nil),
            affectsPowerwallPlan: false,
            candidatePlan: nil,
            affectedIntervals: [],
            unchangedOutsidePeriods: [],
            restoration: TariffReviewRestorationSummary(
                preservedOriginals: [],
                restoredOriginals: [],
                unavailableRanges: [],
                canApplyRestoration: false
            ),
            approximationNotes: [],
            summary: TariffReviewChangeSummary(
                hasBuyRateChanges: true,
                hasSellRateChanges: false,
                hasRateChanges: true,
                hasPeriodNameChanges: false,
                fillsGap: false,
                replacesExistingPlan: true
            )
        )
        return TariffAiHandoffPreviewResponse(
            reviewHash: hash,
            siteId: "site-1",
            currency: "USD",
            unit: "kWh",
            timezone: "America/Chicago",
            notes: ["Checked summer peak rates."],
            sources: ["User-provided utility bill (2026-08)"],
            unchangedActualCount: 0,
            unchangedReferenceCount: 0,
            actualPreviews: hasChanges ? [singlePreview] : [],
            referencePreviews: [],
            recalculatesHistory: hasChanges,
            recalculatesFromHistoryStart: false,
            recalculationRange: hasChanges ? TariffReviewDateRange(fromDate: "2024-01-01", toDate: nil) : nil,
            affectsPowerwallPlan: false
        )
    }

    @Test("Editing rawInput invalidates loaded preview and resets acknowledgement and bill verification")
    func editingInputInvalidatesReview() async {
        let model = RatePlanAiHandoffModel(
            actions: RatePlanAiHandoffActions(
                exportMarkdown: { TariffAiHandoffExportResponse(markdown: "# Prompt", filename: "check.md") },
                preview: { _ in Self.makePreview() },
                commit: { _ in throw PWUsageAPIError.invalidResponse }
            )
        )
        model.rawInput = "{\"schema\":\"pwusage-rate-plan-handoff/v1\"}"
        await model.loadPreview()
        #expect(model.preview != nil)

        model.isAcknowledged = true
        model.isVerifiedAgainstBill = true
        #expect(model.canApply)

        model.rawInput = "{\"schema\":\"pwusage-rate-plan-handoff/v1\", \"notes\":[\"changed\"]}"
        #expect(model.preview == nil)
        #expect(!model.isAcknowledged)
        #expect(!model.isVerifiedAgainstBill)
        #expect(!model.canApply)
    }

    @Test("Stale review 409 replaces preview and clears both acknowledgement and verification")
    func staleReviewReplacesPreviewAndClearsToggles() async {
        let freshPreview = Self.makePreview(hash: "hash-fresh")
        let model = RatePlanAiHandoffModel(
            actions: RatePlanAiHandoffActions(
                exportMarkdown: { TariffAiHandoffExportResponse(markdown: "# Prompt", filename: "check.md") },
                preview: { _ in Self.makePreview(hash: "hash-initial") },
                commit: { _ in throw RatePlanSelectionError.aiHandoffReviewStale(freshPreview) }
            )
        )
        model.rawInput = "{}"
        await model.loadPreview()
        model.isAcknowledged = true
        model.isVerifiedAgainstBill = true

        let applied = await model.apply()
        #expect(!applied)
        #expect(model.preview?.reviewHash == "hash-fresh")
        #expect(!model.isAcknowledged)
        #expect(!model.isVerifiedAgainstBill)
        #expect(model.isRefreshedAfterConflict)
    }
}
```

- [ ] **Step 2: Run targeted test to verify it fails**

Run from repo root:
```bash
./cmd/ios-app/run-tests.sh --quick --only-testing:PWUsageTests/RatePlanAiHandoffModelTests
```
Expected: FAIL with missing `RatePlanAiHandoffModel`.

- [ ] **Step 3: Implement `RatePlanAiHandoffModel.swift`, `RatePlanAiHandoffSheet.swift`, and wire into `TariffSheet.swift`**

Create `cmd/ios-app/PWUsage/Models/Bill/RatePlanAiHandoffModel.swift`:

```swift
import Foundation
import Observation

struct RatePlanAiHandoffActions: Sendable {
    var exportMarkdown: @MainActor () async throws -> TariffAiHandoffExportResponse
    var preview: @MainActor (String) async throws -> TariffAiHandoffPreviewResponse
    var commit: @MainActor (TariffAiHandoffCommitRequest) async throws -> TariffAiHandoffCommitResponse
}

@MainActor
@Observable
final class RatePlanAiHandoffModel {
    private(set) var markdown: String?
    private(set) var isLoadingMarkdown = false
    private(set) var exportError: String?

    var rawInput = "" {
        didSet {
            guard rawInput != oldValue else { return }
            preview = nil
            isAcknowledged = false
            isVerifiedAgainstBill = false
            isRefreshedAfterConflict = false
            reviewError = nil
        }
    }

    private(set) var preview: TariffAiHandoffPreviewResponse?
    private(set) var isPreviewing = false
    private(set) var isApplying = false
    private(set) var reviewError: String?
    private(set) var isRefreshedAfterConflict = false
    private(set) var committedResponse: TariffAiHandoffCommitResponse?

    var isAcknowledged = false
    var isVerifiedAgainstBill = false

    @ObservationIgnored private let actions: RatePlanAiHandoffActions

    init(actions: RatePlanAiHandoffActions) {
        self.actions = actions
    }

    var canPreview: Bool {
        !isPreviewing && !isApplying && !rawInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var canApply: Bool {
        guard let preview, preview.hasChanges else { return false }
        return isAcknowledged && !isPreviewing && !isApplying
    }

    func loadMarkdownIfNeeded() async {
        guard markdown == nil, !isLoadingMarkdown else { return }
        await reloadMarkdown()
    }

    func reloadMarkdown() async {
        isLoadingMarkdown = true
        exportError = nil
        defer { isLoadingMarkdown = false }
        do {
            markdown = try await actions.exportMarkdown().markdown
        } catch is CancellationError {
            return
        } catch {
            exportError = error.localizedDescription
        }
    }

    func loadPreview() async {
        guard canPreview else { return }
        isPreviewing = true
        reviewError = nil
        isRefreshedAfterConflict = false
        defer { isPreviewing = false }
        do {
            preview = try await actions.preview(rawInput)
            isAcknowledged = false
            isVerifiedAgainstBill = false
        } catch is CancellationError {
            return
        } catch {
            reviewError = error.localizedDescription
        }
    }

    @discardableResult
    func apply() async -> Bool {
        guard canApply, let currentPreview = preview else { return false }
        isApplying = true
        reviewError = nil
        defer { isApplying = false }
        let request = TariffAiHandoffCommitRequest(
            rawInput: rawInput,
            expectedReviewHash: currentPreview.reviewHash,
            verifiedAgainstBill: isVerifiedAgainstBill
        )
        do {
            committedResponse = try await actions.commit(request)
            return true
        } catch RatePlanSelectionError.aiHandoffReviewStale(let fresh) {
            preview = fresh
            isAcknowledged = false
            isVerifiedAgainstBill = false
            isRefreshedAfterConflict = true
        } catch is CancellationError {
            return false
        } catch {
            reviewError = error.localizedDescription
        }
        return false
    }
}
```

Create `cmd/ios-app/PWUsage/Views/Bill/RatePlanAiHandoffSheet.swift` (decomposed into focused subviews under 50 lines per function body, reusing `RatePlanReviewIntervalSection` for each preview in `actualPreviews` and `referencePreviews`, providing **Copy Markdown**, `ShareLink`, **Paste from Clipboard**, **Preview Changes**, and the two confirmation toggles).

Add `case aiHandoff` to `TariffSheetModal.swift` and add a **Check with Your AI Assistant** button in `TariffSheet.swift`.

- [ ] **Step 4: Run iOS lint and targeted tests**

Run from repo root:
```bash
./cmd/ios-app/lint.sh
./cmd/ios-app/run-tests.sh --quick --only-testing:PWUsageTests/RatePlanAiHandoffModelTests --only-testing:PWUsageTests/TariffSheetTests
```
Expected: PASS with 0 SwiftLint violations.

- [ ] **Step 5: Commit**

```bash
git add cmd/ios-app/PWUsage/Models/Bill/RatePlanAiHandoffModel.swift cmd/ios-app/PWUsage/Views/Bill/RatePlanAiHandoffSheet.swift cmd/ios-app/PWUsage/Views/Bill/TariffSheetModal.swift cmd/ios-app/PWUsage/Views/Bill/TariffSheet.swift cmd/ios-app/PWUsageTests/RatePlanAiHandoffModelTests.swift
git commit -m "feat(ios): add Check with Your AI Assistant sheet and review flow"
```

---

### Task 6: Full Verification Across Web and iOS

**Files:**
- Modify: `docs/voice-and-terms.md` (if any new recurring phrase needs recording)

- [ ] **Step 1: Run complete Next.js verification suite**

Run from `cmd/next-app` in this exact order:
```bash
npm run lint
npm run typecheck
npm test -- --run
npm run build
```
Expected: All four pass with 0 errors.

- [ ] **Step 2: Run complete iOS verification suite**

Run from repo root:
```bash
./cmd/ios-app/lint.sh
./cmd/ios-app/run-tests.sh
```
Expected: SwiftLint passes with 0 warnings/errors, and all default iOS test suites pass.
