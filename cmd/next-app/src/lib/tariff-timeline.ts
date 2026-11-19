import type { Tariff, TariffSchedule, TariffSelectionChoiceKind, TariffSource } from './db-types';
import type { ParsedSchedule, ParsedSeason, ParsedTariff } from './importer/tariff-parser';
import { matchesScheduleForDay, sortSchedulesBySpecificity } from './schedule';
import type { TariffPeriodName, TariffSeasonInput, TimePeriodWindowInput } from './tariff-contract';

export const MAX_EFFECTIVE_PERIODS_PER_SITE = 50;
const VALID_TOU_NAMES = new Set<TariffPeriodName>(['ON_PEAK', 'PARTIAL_PEAK', 'OFF_PEAK', 'SUPER_OFF_PEAK']);
const MONTH_MAX_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function dayOfYear366(month: number, day: number): number {
  let offset = 0;
  for (let i = 0; i < month - 1; i++) {
    offset += MONTH_MAX_DAYS[i];
  }
  return offset + day - 1;
}
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface TariffPlanWriteInput {
  name: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  seasons: TariffSeasonInput[];
}

export interface ExistingSpan {
  id: number;
  tariffId: number;
  source: TariffSource;
  effectiveFrom: string;
  effectiveTo: string | null;
  updatedByUserId: string | null;
  selectionId?: number | null;
  choiceKind?: TariffSelectionChoiceKind;
}

export interface NewSpanRow {
  tariffId: number;
  source: TariffSource;
  effectiveFrom: string;
  effectiveTo: string | null;
  updatedByUserId: string | null;
  selectionId?: number | null;
  choiceKind?: TariffSelectionChoiceKind;
}

export function spanChoiceKind(
  span: Pick<ExistingSpan, 'source' | 'updatedByUserId' | 'choiceKind'>
): TariffSelectionChoiceKind {
  if (span.choiceKind) return span.choiceKind;
  return span.source === 'manual' || span.updatedByUserId !== null ? 'owner' : 'automatic';
}

export function isProtectedSpan(
  span: Pick<ExistingSpan, 'source' | 'updatedByUserId' | 'choiceKind'>
): boolean {
  return spanChoiceKind(span) === 'owner';
}

export interface SpanMutationPlan {
  deleteIds: number[];
  inserts: NewSpanRow[];
}

export class TariffValidationError extends Error {
  readonly status = 400;
}

export function siteLocalDateString(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function addCalendarDays(yyyyMmDd: string, delta: number): string {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d + delta);
  const dt = new Date(utc);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function assertValidCalendarDate(value: string, field: string): void {
  if (!ISO_DATE_RE.test(value)) throw new TariffValidationError(`Invalid ${field} format (expected YYYY-MM-DD)`);
  const [y, m, d] = value.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() + 1 !== m || check.getUTCDate() !== d) {
    throw new TariffValidationError(`Invalid calendar date for ${field}`);
  }
}

export function validateEffectiveDates(effectiveFrom: string, effectiveTo: string | null, todaySiteLocal: string): void {
  assertValidCalendarDate(effectiveFrom, 'effectiveFrom');
  if (effectiveTo !== null) {
    assertValidCalendarDate(effectiveTo, 'effectiveTo');
    if (effectiveTo < effectiveFrom) {
      throw new TariffValidationError('effectiveTo must be on or after effectiveFrom');
    }
  }
  if (effectiveFrom < '2015-01-01' || effectiveFrom > addCalendarDays(todaySiteLocal, 365)) {
    throw new TariffValidationError('effectiveFrom is outside allowed date bounds');
  }
}

function checkRate(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) {
    throw new TariffValidationError(`${label} must be between 0 and 10`);
  }
  const rounded = Math.round(value * 100_000) / 100_000;
  if (Math.abs(value - rounded) > 1e-9) {
    throw new TariffValidationError(`${label} supports at most 5 decimal places`);
  }
  return rounded;
}

function slotIndex(hour: number, minute: number, allow24 = false, allowMinuteResolution = false): number {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new TariffValidationError('Period boundaries must use integer hours and minutes');
  }
  if (!allowMinuteResolution && minute !== 0 && minute !== 30) {
    throw new TariffValidationError('Period boundaries must use 30-minute increments');
  }
  if (minute < 0 || minute > 59) {
    throw new TariffValidationError('Minute out of range (0..59)');
  }
  if (hour === 24 && minute === 0 && allow24) {
    return allowMinuteResolution ? 1440 : 48;
  }
  if (hour < 0 || hour > 23) throw new TariffValidationError('Hour out of range (0..23)');
  return allowMinuteResolution ? hour * 60 + minute : hour * 2 + (minute === 30 ? 1 : 0);
}

function validateDaySlots(
  periods: TimePeriodWindowInput[],
  label: string,
  allowMinuteResolution = false
): TimePeriodWindowInput[] {
  if (!Array.isArray(periods) || periods.length === 0 || periods.length > 48) {
    throw new TariffValidationError(`${label} must contain 1–48 periods covering 24 hours`);
  }
  const totalSlots = allowMinuteResolution ? 1440 : 48;
  const seen = new Array<boolean>(totalSlots).fill(false);
  const normalized: TimePeriodWindowInput[] = periods.map(p => {
    if (!VALID_TOU_NAMES.has(p.touName)) {
      throw new TariffValidationError(`Invalid period name: ${p.touName}`);
    }
    const startSlot = slotIndex(p.fromHour, p.fromMinute, false, allowMinuteResolution);
    const endSlot = slotIndex(p.toHour, p.toMinute, true, allowMinuteResolution);
    const isSingleAllDay = periods.length === 1 && startSlot === 0 && (endSlot === totalSlots || endSlot === 0);
    if (startSlot === endSlot && !isSingleAllDay) {
      throw new TariffValidationError(`${label} contains a zero-length period`);
    }
    const span = isSingleAllDay
      ? totalSlots
      : (endSlot > startSlot ? endSlot - startSlot : (totalSlots - startSlot) + endSlot);
    for (let offset = 0; offset < span; offset++) {
      const idx = (startSlot + offset) % totalSlots;
      if (seen[idx]) {
        throw new TariffValidationError(`${label} contains overlapping rate periods`);
      }
      seen[idx] = true;
    }
    return {
      touName: p.touName,
      fromHour: p.fromHour,
      fromMinute: p.fromMinute,
      toHour: isSingleAllDay ? 24 : p.toHour,
      toMinute: isSingleAllDay ? 0 : p.toMinute,
      buyRate: checkRate(p.buyRate, 'buyRate'),
      sellRate: checkRate(p.sellRate, 'sellRate'),
    };
  });
  if (seen.some(v => !v)) {
    throw new TariffValidationError(`${label} must cover all 24 hours without gaps`);
  }
  return normalized;
}

export const MAX_PLAN_NAME_LENGTH = 64;

export interface ValidateTariffPlanOptions {
  allowMinuteResolution?: boolean;
}

export function validateTariffPlanInput(
  input: TariffPlanWriteInput,
  todaySiteLocal: string,
  options?: ValidateTariffPlanOptions
): TariffPlanWriteInput {
  const allowMinuteResolution = options?.allowMinuteResolution ?? false;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > MAX_PLAN_NAME_LENGTH) {
    throw new TariffValidationError('Rate plan name must be 1–64 characters');
  }
  validateEffectiveDates(input.effectiveFrom, input.effectiveTo, todaySiteLocal);
  if (!Array.isArray(input.seasons) || input.seasons.length < 1 || input.seasons.length > 6) {
    throw new TariffValidationError('Rate plan must include 1–6 seasons');
  }
  const dayOwners = new Array<boolean>(366).fill(false);
  const seasons: TariffSeasonInput[] = input.seasons.map(season => {
    const seasonName = typeof season.name === 'string' ? season.name.trim() : '';
    if (!seasonName || seasonName.length > 64) {
      throw new TariffValidationError('Each season must have a 1–64 character name');
    }
    if (!Number.isInteger(season.fromMonth) || season.fromMonth < 1 || season.fromMonth > 12
      || !Number.isInteger(season.toMonth) || season.toMonth < 1 || season.toMonth > 12) {
      throw new TariffValidationError('Season months must be integers in 1..12');
    }
    if (season.fromDay !== undefined && (!Number.isInteger(season.fromDay) || season.fromDay < 1 || season.fromDay > MONTH_MAX_DAYS[season.fromMonth - 1])) {
      throw new TariffValidationError('Season fromDay must be a valid day of the start month');
    }
    if (season.toDay !== undefined && (!Number.isInteger(season.toDay) || season.toDay < 1 || season.toDay > MONTH_MAX_DAYS[season.toMonth - 1])) {
      throw new TariffValidationError('Season toDay must be a valid day of the end month');
    }
    const startDoy = dayOfYear366(season.fromMonth, season.fromDay ?? 1);
    const endDoy = dayOfYear366(season.toMonth, season.toDay ?? MONTH_MAX_DAYS[season.toMonth - 1]);
    let d = startDoy;
    for (let guard = 0; guard < 366; guard++) {
      if (dayOwners[d]) {
        throw new TariffValidationError('Seasons must cover all 12 months without overlap');
      }
      dayOwners[d] = true;
      if (d === endDoy) break;
      d = (d + 1) % 366;
    }
    return {
      name: seasonName,
      fromMonth: season.fromMonth,
      ...(season.fromDay !== undefined ? { fromDay: season.fromDay } : {}),
      toMonth: season.toMonth,
      ...(season.toDay !== undefined ? { toDay: season.toDay } : {}),
      weekdayPeriods: validateDaySlots(season.weekdayPeriods, `${seasonName} weekday schedule`, allowMinuteResolution),
      weekendPeriods: validateDaySlots(season.weekendPeriods, `${seasonName} weekend schedule`, allowMinuteResolution),
    };
  });
  if (dayOwners.some(v => !v)) {
    throw new TariffValidationError('Seasons must cover all 12 months without gaps');
  }
  return { name, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo, seasons };
}

function toParsedSchedules(windows: TimePeriodWindowInput[], fromDow: number, toDow: number): ParsedSchedule[] {
  const out: ParsedSchedule[] = [];
  for (const w of windows) {
    const startMin = w.fromHour * 60 + w.fromMinute;
    const endMin = w.toHour * 60 + w.toMinute;
    if (startMin === 0 && endMin === 1440) {
      out.push({
        name: w.touName, buy_rate: w.buyRate, sell_rate: w.sellRate,
        from_day_of_week: fromDow, to_day_of_week: toDow,
        from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0,
      });
    } else if (endMin > startMin) {
      out.push({
        name: w.touName, buy_rate: w.buyRate, sell_rate: w.sellRate,
        from_day_of_week: fromDow, to_day_of_week: toDow,
        from_hour: w.fromHour, from_minute: w.fromMinute, to_hour: w.toHour, to_minute: w.toMinute,
      });
    } else {
      // Split midnight-crossing windows cleanly for unambiguous SQL inspection while Schedule supports both.
      out.push({
        name: w.touName, buy_rate: w.buyRate, sell_rate: w.sellRate,
        from_day_of_week: fromDow, to_day_of_week: toDow,
        from_hour: w.fromHour, from_minute: w.fromMinute, to_hour: 24, to_minute: 0,
      });
      if (endMin > 0) {
        out.push({
          name: w.touName, buy_rate: w.buyRate, sell_rate: w.sellRate,
          from_day_of_week: fromDow, to_day_of_week: toDow,
          from_hour: 0, from_minute: 0, to_hour: w.toHour, to_minute: w.toMinute,
        });
      }
    }
  }
  return out;
}

export function compileSeasonsToParsedTariff(name: string, seasons: TariffSeasonInput[]): ParsedTariff {
  const parsedSeasons: ParsedSeason[] = seasons.map(season => {
    const allWindows = [...season.weekdayPeriods, ...season.weekendPeriods];
    const minBuy = Math.min(...allWindows.map(w => w.buyRate));
    const minSell = Math.min(...allWindows.map(w => w.sellRate));
    const schedules: ParsedSchedule[] = [
      ...toParsedSchedules(season.weekdayPeriods, 0, 4),
      ...toParsedSchedules(season.weekendPeriods, 5, 6),
    ];
    return {
      name: season.name,
      from_month: season.fromMonth,
      from_day: season.fromDay ?? 1,
      to_month: season.toMonth,
      to_day: season.toDay ?? MONTH_MAX_DAYS[season.toMonth - 1],
      buy_rate: minBuy,
      sell_rate: minSell,
      schedules,
    };
  });
  return { name, seasons: parsedSeasons };
}

/** Tesla period labels vary ("Peak", "Off-Peak", "Mid-Peak"…); map recognised ones to the four known names. */
function normalizeTouName(raw: string | null | undefined): TariffPeriodName {
  if (raw && VALID_TOU_NAMES.has(raw as TariffPeriodName)) return raw as TariffPeriodName;
  switch (raw?.toUpperCase().replace(/[^A-Z]/g, '')) {
    case 'PEAK':
    case 'ONPEAK':
      return 'ON_PEAK';
    case 'PARTIALPEAK':
    case 'MIDPEAK':
    case 'SHOULDER':
      return 'PARTIAL_PEAK';
    case 'SUPEROFFPEAK':
      return 'SUPER_OFF_PEAK';
    default:
      return 'OFF_PEAK';
  }
}

/**
 * Windows for one representative day. Boundaries are kept exact (a Tesla schedule can switch at
 * 06:07), so the result agrees with `Schedule` to the minute; the day is evaluated only at the
 * minutes where some schedule starts or ends.
 */
function resolveDayWindows(
  sortedSchedules: TariffSchedule[],
  jsWeekday: number,
  fallbackBuy: number,
  fallbackSell: number
): TimePeriodWindowInput[] {
  const points = new Set<number>([0]);
  for (const sch of sortedSchedules) {
    if (sch.from_hour !== null && sch.from_hour !== undefined) points.add((sch.from_hour * 60 + (sch.from_minute ?? 0)) % 1440);
    if (sch.to_hour !== null && sch.to_hour !== undefined) points.add((sch.to_hour * 60 + (sch.to_minute ?? 0)) % 1440);
  }
  const starts = [...points].sort((x, y) => x - y);

  const windows: TimePeriodWindowInput[] = [];
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : 1440;
    const match = sortedSchedules.find(sch => matchesScheduleForDay(jsWeekday, Math.floor(start / 60), start % 60, sch));
    const cur = {
      touName: normalizeTouName(match?.name),
      buyRate: match?.buy_rate ?? fallbackBuy,
      sellRate: match?.sell_rate ?? fallbackSell,
    };
    const prev = windows[windows.length - 1];
    if (prev && prev.touName === cur.touName && prev.buyRate === cur.buyRate && prev.sellRate === cur.sellRate) {
      prev.toHour = Math.floor(end / 60);
      prev.toMinute = end % 60;
    } else {
      windows.push({
        ...cur,
        fromHour: Math.floor(start / 60),
        fromMinute: start % 60,
        toHour: Math.floor(end / 60),
        toMinute: end % 60,
      });
    }
  });
  return windows;
}

export function decompileTariffToSeasons(tariff: Tariff): TariffSeasonInput[] {
  return (tariff.seasons ?? []).map(season => {
    const sorted = sortSchedulesBySpecificity(season.schedules ?? []);
    return {
      name: season.name || 'Season',
      fromMonth: season.from_month,
      toMonth: season.to_month,
      fromDay: season.from_day,
      toDay: season.to_day,
      // Canonical Monday (JS 1 -> Tesla 0) and Saturday (JS 6 -> Tesla 5) resolve layered Tesla rules into clean windows.
      weekdayPeriods: resolveDayWindows(sorted, 1, season.buy_rate, season.sell_rate),
      weekendPeriods: resolveDayWindows(sorted, 6, season.buy_rate, season.sell_rate),
    };
  });
}

/**
 * True when some weekday differs from Monday, or Sunday from Saturday, in any season: the
 * weekday/weekend form `decompileTariffToSeasons` returns then hides those days, while billing
 * (`Schedule.getTariffPeriod`) prices each actual day. JS days: 0 = Sunday ... 6 = Saturday.
 */
export function tariffHasDaySpecificSchedules(tariff: Tariff): boolean {
  const same = (a: TimePeriodWindowInput[], b: TimePeriodWindowInput[]) => JSON.stringify(a) === JSON.stringify(b);
  return (tariff.seasons ?? []).some(season => {
    const sorted = sortSchedulesBySpecificity(season.schedules ?? []);
    const day = (jsWeekday: number) => resolveDayWindows(sorted, jsWeekday, season.buy_rate, season.sell_rate);
    const monday = day(1);
    const saturday = day(6);
    return [2, 3, 4, 5].some(d => !same(day(d), monday)) || !same(day(0), saturday);
  });
}

function cmpEnd(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function spansOverlap(aFrom: string, aTo: string | null, bFrom: string, bTo: string | null): boolean {
  if (aTo !== null && aTo < bFrom) return false;
  if (bTo !== null && bTo < aFrom) return false;
  return true;
}

export function computeSpanMutations(
  existing: ExistingSpan[],
  incoming: NewSpanRow
): SpanMutationPlan {
  const deleteIds: number[] = [];
  const fragments: NewSpanRow[] = [];

  for (const span of existing) {
    if (!spansOverlap(span.effectiveFrom, span.effectiveTo, incoming.effectiveFrom, incoming.effectiveTo)) {
      continue;
    }
    deleteIds.push(span.id);
    const provenance = {
      ...(span.selectionId !== undefined ? { selectionId: span.selectionId } : {}),
      ...(span.choiceKind !== undefined ? { choiceKind: span.choiceKind } : {}),
    };
    if (span.effectiveFrom < incoming.effectiveFrom) {
      fragments.push({
        tariffId: span.tariffId,
        source: span.source,
        effectiveFrom: span.effectiveFrom,
        effectiveTo: addCalendarDays(incoming.effectiveFrom, -1),
        updatedByUserId: span.updatedByUserId,
        ...provenance,
      });
    }
    if (incoming.effectiveTo !== null && cmpEnd(span.effectiveTo, incoming.effectiveTo) > 0) {
      fragments.push({
        tariffId: span.tariffId,
        source: span.source,
        effectiveFrom: addCalendarDays(incoming.effectiveTo, 1),
        effectiveTo: span.effectiveTo,
        updatedByUserId: span.updatedByUserId,
        ...provenance,
      });
    }
  }

  return { deleteIds, inserts: [...fragments, incoming] };
}
