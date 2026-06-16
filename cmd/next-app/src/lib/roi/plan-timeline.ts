import { Schedule } from '../schedule';
import { resolveRates } from '../battery-provenance/rates';
import type { Tariff } from '../db';

export interface Rate { buy: number; sell: number; }

export interface PlanTimeline {
    /** Buy/sell rate ($/kWh) in effect for the given site-local date + clock hour (0..23). */
    rateAt(localDate: string, hour: number): Rate;
}

const ZERO: Rate = { buy: 0, sell: 0 };

/** A timeline whose rate is identical for every date/hour — the Fixed plan / flat baseline. */
export function flatTimeline(buy: number, sell: number): PlanTimeline {
    const rate: Rate = { buy, sell };
    return { rateAt: () => rate };
}

export interface TimelineVersion {
    effectiveFrom: string | null; // 'YYYY-MM-DD'; null = "since the beginning"
    schedule: Schedule;           // parsed schedule for this version
}

/** Pick the version in effect on `localDate`: the latest whose effectiveFrom <= date.
 *  Undated sorts earliest; the earliest carries backward, the latest forward. */
function pickVersion(sortedAsc: TimelineVersion[], localDate: string): TimelineVersion | null {
    if (sortedAsc.length === 0) return null;
    let chosen = sortedAsc[0]; // earliest — carries backward when date precedes all
    for (const v of sortedAsc) {
        const eff = v.effectiveFrom ?? '0000-01-01';
        if (eff <= localDate) chosen = v;
        else break;
    }
    return chosen;
}

/** A date-resolved timeline of parsed Schedules. Hour-aligned TOU windows price exactly. */
export function scheduleTimeline(versions: TimelineVersion[]): PlanTimeline {
    const sortedAsc = [...versions].sort((a, b) =>
        (a.effectiveFrom ?? '0000-01-01').localeCompare(b.effectiveFrom ?? '0000-01-01'));
    return {
        rateAt(localDate: string, hour: number): Rate {
            const v = pickVersion(sortedAsc, localDate);
            if (!v) return ZERO;
            const [y, m, d] = localDate.split('-').map(Number);
            const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat, calendar-only
            const period = v.schedule.getTariffPeriodByComponents(m, d, hour, weekday, undefined, y);
            if (!period) return ZERO;
            const { buyRate, sellRate } = resolveRates(period);
            return { buy: buyRate, sell: sellRate };
        },
    };
}

/** Build a metered timeline from the site's non-reporting Tariff versions. */
export function meteredTimeline(tariffs: Tariff[], timeZone: string): PlanTimeline {
    const versions: TimelineVersion[] = tariffs
        .filter(t => !t.reporting_only)
        .map(t => ({ effectiveFrom: t.effective_from ?? null, schedule: new Schedule([t], timeZone) }));
    return scheduleTimeline(versions);
}
