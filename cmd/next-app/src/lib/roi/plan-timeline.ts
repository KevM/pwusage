import { Schedule } from '../schedule';
import { resolveRates } from '../battery-provenance/rates';
import type { Tariff } from '../db';
import type { ComparisonPlan } from './comparison-tariff-repo';

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

/** The item in effect on `localDate`: the latest whose effective date <= localDate.
 *  `sortedAsc` MUST be ascending by effective date; a null effective date sorts earliest
 *  and carries backward (covers dates before any version). Returns null only when empty. */
export function pickByDate<T>(
    sortedAsc: T[],
    effOf: (item: T) => string | null,
    localDate: string,
): T | null {
    if (sortedAsc.length === 0) return null;
    let chosen = sortedAsc[0]; // earliest — carries backward when date precedes all
    for (const v of sortedAsc) {
        const eff = effOf(v) ?? '0000-01-01';
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
            const v = pickByDate(sortedAsc, x => x.effectiveFrom, localDate);
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

/** A date-resolved FLAT timeline from a Fixed comparison plan's versions.
 *  Comparison plans are Fixed-only today (one buy/sell pair per version), so the rate is
 *  hour-independent; date resolution reuses the shared `pickByDate` rule. */
export function comparisonPlanTimeline(plan: ComparisonPlan): PlanTimeline {
    const sortedAsc = [...plan.versions].sort((a, b) =>
        (a.effective_from ?? '0000-01-01').localeCompare(b.effective_from ?? '0000-01-01'));
    return {
        rateAt(localDate: string): Rate {
            const v = pickByDate(sortedAsc, x => x.effective_from, localDate);
            return v ? { buy: v.buy_rate, sell: v.sell_rate } : ZERO;
        },
    };
}
