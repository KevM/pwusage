/**
 * Day record v2 attribution (docs/plans/2026-10-24-day-record-v2.md): a per-day
 * tariff segment timeline replaces per-sample tariff IDs. Pure functions only.
 */
import type { EnergyData } from '../db-types';
import type { Schedule } from '../schedule';
import { rollupDay, type DayRollup, type EnergySample } from './compact-energy';

const SLOT_MS = 300000;
const SLOT_MINUTES = 5;
const MINUTE_MS = 60000;
const MAX_REVISION_LENGTH = 256;
/** Mirrors GAP_HEAL_DAYS: an ended, short day older than this is `gapped`. */
export const DAY_GAP_HEAL_DAYS = 14;

/** `[offset, next offset)` in minutes from day_start; the last segment runs to day_end. */
export interface TariffSegment { offset: number; tariffId: number; scheduleId: number | null }
export interface DayAttribution { timelineRevision: string; segments: TariffSegment[] }
export type DayStatus = 'open' | 'complete' | 'gapped';
/**
 * A stored day record's status: a `DayStatus`, or `empty` for a day Tesla answered
 * with no samples (no payload or summaries; replaced by the first non-empty write).
 */
export type DayRecordStatus = DayStatus | 'empty';

export const currentTariffTimelineRevision = (tariffId: number): string => `current-tariff:${tariffId}`;

const dayMinutes = (start: Date, end: Date): number => {
    const ms = +end - +start;
    if (!Number.isSafeInteger(+start) || !Number.isSafeInteger(+end) || ms <= 0 || ms > 27 * 3600000 || ms % (SLOT_MINUTES * MINUTE_MS)) throw new Error('Invalid day bounds');
    return ms / MINUTE_MS;
};
const sameAttribution = (a: Omit<TariffSegment, 'offset'>, b: Omit<TariffSegment, 'offset'>) => a.tariffId === b.tariffId && a.scheduleId === b.scheduleId;

/** Run-length encodes one attribution per 5-minute slot into canonical segments. */
function encodeSlots(slots: Omit<TariffSegment, 'offset'>[]): TariffSegment[] {
    const segments: TariffSegment[] = [];
    slots.forEach((slot, i) => {
        const last = segments.at(-1);
        if (!last || !sameAttribution(last, slot)) segments.push({ offset: i * SLOT_MINUTES, tariffId: slot.tariffId, scheduleId: slot.scheduleId });
    });
    return segments;
}

/**
 * Prices each slot with `getTariffPeriod(t)` for the sample labeled `t` (labels
 * are interval starts, so no shift). No matching period is `scheduleId: null`
 * under `tariffId`, never a synthetic fallback rate.
 */
export function deriveDayAttribution(schedule: Pick<Schedule, 'getTariffPeriod'>, tariffId: number, start: Date, end: Date): DayAttribution {
    if (!Number.isSafeInteger(tariffId)) throw new Error('Invalid tariff ID');
    const slots = Array.from({ length: dayMinutes(start, end) / SLOT_MINUTES }, (_, i) => {
        const period = schedule.getTariffPeriod(new Date(+start + i * SLOT_MS));
        return period ? { tariffId: Number(period.tariff.id), scheduleId: Number(period.schedule.id) } : { tariffId, scheduleId: null };
    });
    const attribution = { timelineRevision: currentTariffTimelineRevision(tariffId), segments: encodeSlots(slots) };
    validateDayAttribution(attribution, start, end);
    return attribution;
}

/** The schedule a tariff version assigns to the slot labeled `timestamp` (`getTariffPeriod`), or null. */
export type GapPricer = (timestamp: Date, tariffId: number) => number | null;

/**
 * Segments for a v1 day from its per-sample IDs, preserving what each sample was
 * priced with. Slots without a sample take the neighbouring attribution when the
 * samples on both sides agree (or the only neighbour, at the day's edges).
 * Where they disagree the boundary is unknown: with `price`, the gap is priced
 * under the tariff version both neighbours recorded, but only if that version
 * reproduces both neighbours' schedules; otherwise it is `scheduleId: null`.
 */
export function segmentsFromV1Rows(rows: EnergyData[], start: Date, end: Date, price?: GapPricer): TariffSegment[] {
    const count = dayMinutes(start, end) / SLOT_MINUTES;
    if (!rows.length) throw new Error('No day samples');
    const known: (Omit<TariffSegment, 'offset'> | undefined)[] = new Array(count);
    for (const row of rows) {
        const ms = +row.timestamp - +start;
        if (ms < 0 || ms >= +end - +start || ms % SLOT_MS) throw new Error('Invalid sample identity/time');
        if (!Number.isSafeInteger(row.tariff_id) || (row.tariff_schedule_id !== null && !Number.isSafeInteger(row.tariff_schedule_id))) throw new Error('Invalid tariff ID');
        known[ms / SLOT_MS] = { tariffId: row.tariff_id, scheduleId: row.tariff_schedule_id };
    }
    const next: (number | undefined)[] = new Array(count);
    for (let i = count - 1; i >= 0; i--) next[i] = known[i] ? i : next[i + 1];
    const slotTime = (i: number) => new Date(+start + i * SLOT_MS);
    const slots: Omit<TariffSegment, 'offset'>[] = [];
    let previousIndex: number | undefined;
    for (let i = 0; i < count; i++) {
        if (known[i]) previousIndex = i;
        const previous = previousIndex === undefined ? undefined : known[previousIndex];
        const after = next[i] === undefined ? undefined : known[next[i]!];
        if (!known[i] && previous && after && !sameAttribution(previous, after)) {
            const tariffId = previous.tariffId;
            const consistent = price && after.tariffId === tariffId
                && price(slotTime(previousIndex!), tariffId) === previous.scheduleId && price(slotTime(next[i]!), tariffId) === after.scheduleId;
            // Otherwise unattributed, under the earlier sample's tariff version.
            slots.push({ tariffId, scheduleId: consistent ? price(slotTime(i), tariffId) : null });
            continue;
        }
        slots.push((previous ?? after)!);
    }
    return encodeSlots(slots);
}

/** Canonical timeline: starts at 0, strictly increasing 5-minute offsets inside the day, no repeated neighbours. */
export function validateDayAttribution(attribution: DayAttribution, start: Date, end: Date): void {
    const minutes = dayMinutes(start, end);
    const { timelineRevision, segments } = attribution ?? {};
    const invalid = typeof timelineRevision !== 'string' || !timelineRevision || timelineRevision.length > MAX_REVISION_LENGTH
        || !Array.isArray(segments) || !segments.length || segments.length > minutes / SLOT_MINUTES
        || segments.some((s, i) => !s || !Number.isSafeInteger(s.offset) || s.offset % SLOT_MINUTES || s.offset >= minutes
            || (i === 0 ? s.offset !== 0 : s.offset <= segments[i - 1].offset || sameAttribution(s, segments[i - 1]))
            || !Number.isSafeInteger(s.tariffId) || (s.scheduleId !== null && !Number.isSafeInteger(s.scheduleId)));
    if (invalid) throw new Error('Invalid day attribution');
}

export const isAttributionComplete = (attribution: DayAttribution): boolean => attribution.segments.every(s => s.scheduleId !== null);

/** Tags each sample with the segment covering its label, as v1 rows. */
export function attributeSamples(samples: EnergySample[], attribution: DayAttribution, start: Date, end: Date): EnergyData[] {
    validateDayAttribution(attribution, start, end);
    const { segments } = attribution;
    let index = 0;
    let previous = -1;
    return samples.map(sample => {
        const ms = +sample.timestamp - +start;
        if (!Number.isSafeInteger(ms) || ms < 0 || +sample.timestamp >= +end || ms <= previous) throw new Error('Invalid sample identity/time');
        previous = ms;
        while (index + 1 < segments.length && segments[index + 1].offset * MINUTE_MS <= ms) index++;
        return { ...sample, tariff_id: segments[index].tariffId, tariff_schedule_id: segments[index].scheduleId };
    });
}

/** `EnergyDaySummary` rows from samples × segments; identical to `rollupDay` over equivalently tagged v1 rows. */
export function rollupSamples(samples: EnergySample[], attribution: DayAttribution, start: Date, end: Date): DayRollup[] {
    return rollupDay(attributeSamples(samples, attribution, start, end), start);
}

/**
 * `complete`: ended with every slot. `open`: not ended, or ended short within the
 * gap-heal window. `gapped`: ended short and older than that window; age alone decides.
 */
export function dayStatus({ end, sampleCount, expectedSlots, now }: { end: Date; sampleCount: number; expectedSlots: number; now: Date }): DayStatus {
    if (!Number.isSafeInteger(sampleCount) || !Number.isSafeInteger(expectedSlots) || sampleCount < 0 || expectedSlots < 1 || sampleCount > expectedSlots) throw new Error('Invalid sample count');
    if (+now < +end) return 'open';
    if (sampleCount === expectedSlots) return 'complete';
    return +now - +end > DAY_GAP_HEAL_DAYS * 24 * 3600000 ? 'gapped' : 'open';
}
