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
  if (period.candidateKind === 'ai_handoff') {
    return 'Imported with AI assistant';
  }
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
    case 'tesla_first_seen':
      return 'Tesla first seen date';
    case 'assumed_jan_1':
      return 'Assumed Jan 1 start date';
    case 'history_start':
      return 'Site history start date';
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
    ...(s.fromDay !== undefined ? { fromDay: s.fromDay } : {}),
    toMonth: s.toMonth,
    ...(s.toDay !== undefined ? { toDay: s.toDay } : {}),
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

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

export function sourcesCiteUtilityBill(sources: string[]): boolean {
  return sources.some(source => /\butility\s+bill\b/i.test(source));
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
