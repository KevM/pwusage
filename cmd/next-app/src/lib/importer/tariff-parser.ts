import { createHash } from 'crypto';
import { Season, TariffV2 } from '../tesla-client';

export interface ParsedSchedule {
    name: string;
    buy_rate: number;
    sell_rate: number;
    from_day_of_week: number;
    to_day_of_week: number;
    from_hour: number;
    from_minute: number;
    to_hour: number;
    to_minute: number;
}

export interface ParsedSeason {
    name: string;
    from_month: number;
    from_day: number;
    to_month: number;
    to_day: number;
    buy_rate: number;
    sell_rate: number;
    schedules: ParsedSchedule[];
}

export interface ParsedTariff {
    name: string;
    seasons: ParsedSeason[];
}

/**
 * Tesla can list a season it does not use as an empty object (seen as `"Winter": {}` beside a
 * year-round `"Summer"`). It has no date range, so it can never match a day; storing it would
 * write NULL months into "TariffSeason" and fail the whole tariff insert.
 */
function hasDateRange(season: Partial<Season> | null | undefined): season is Season {
    return !!season && [season.fromMonth, season.fromDay, season.toMonth, season.toDay]
        .every(value => Number.isInteger(value));
}

/**
 * Season names to store, one per dated season. Tesla sometimes labels a season the wrong way round,
 * so a "Summer" starting Oct–Feb becomes "Winter" and a "Winter" starting May–Sep becomes "Summer".
 * Renaming only one of a swapped pair (seen: "Summer" Nov–Mar beside "Winter" Apr–Oct) would give two
 * "Winter" seasons, which TariffSeason's UNIQUE (tariff_id, name) rejects and the import rolls back.
 * Then Tesla's labels are swapped, so both are swapped; if names still collide, Tesla's own names
 * (unique object keys) are kept.
 */
function uniqueSeasonNames(seasons: Array<[string, Season]>): string[] {
    const unique = (names: string[]) => new Set(names).size === names.length;
    const corrected = seasons.map(([name, season]) => {
        const from = season.fromMonth;
        if (name.toLowerCase() === 'summer' && (from >= 10 || from <= 2)) return 'Winter';
        if (name.toLowerCase() === 'winter' && from >= 5 && from <= 9) return 'Summer';
        return name;
    });
    if (unique(corrected)) return corrected;
    const swapped = seasons.map(([name]) => {
        if (name.toLowerCase() === 'summer') return 'Winter';
        if (name.toLowerCase() === 'winter') return 'Summer';
        return name;
    });
    if (unique(swapped)) return swapped;
    return seasons.map(([name]) => name);
}

export function parseTariffContent(content: TariffV2, siteName: string): ParsedTariff {
    const tariffName = content.utility ?? siteName;
    const seasons: ParsedSeason[] = [];
    const datedSeasons = Object.entries(content.seasons ?? {})
        .filter((entry): entry is [string, Season] => hasDateRange(entry[1]));
    const seasonNames = uniqueSeasonNames(datedSeasons);

    for (const [index, [seasonName, seasonData]] of datedSeasons.entries()) {
        const fixedSeasonName = seasonNames[index];

        const buyRates = content.energy_charges?.[seasonName]?.rates ?? {};
        const sellRates = content.sell_tariff?.energy_charges?.[seasonName]?.rates ?? {};
        const schedules: ParsedSchedule[] = [];

        for (const touName in seasonData.tou_periods) {
            const periodGroup = seasonData.tou_periods[touName];
            if (!periodGroup.periods) continue;

            const buyRate = buyRates[touName] ?? 0;
            const sellRate = sellRates[touName] ?? 0;

            for (const p of periodGroup.periods) {
                schedules.push({
                    name: touName,
                    buy_rate: buyRate,
                    sell_rate: sellRate,
                    from_day_of_week: p.fromDayOfWeek,
                    to_day_of_week: p.toDayOfWeek,
                    from_hour: p.fromHour,
                    from_minute: p.fromMinute,
                    to_hour: p.toHour,
                    to_minute: p.toMinute,
                });
            }
        }

        seasons.push({
            name: fixedSeasonName,
            from_month: seasonData.fromMonth,
            from_day: seasonData.fromDay,
            to_month: seasonData.toMonth,
            to_day: seasonData.toDay,
            buy_rate: 0,
            sell_rate: 0,
            schedules,
        });
    }

    return { name: tariffName, seasons };
}

export function buildDefaultTariff(name: string = 'Default Rate'): ParsedTariff {
    return {
        name,
        seasons: [{
            name: 'All Year',
            from_month: 1, from_day: 1,
            to_month: 12, to_day: 31,
            buy_rate: 0, sell_rate: 0,
            schedules: [{
                name: 'Default',
                buy_rate: 0, sell_rate: 0,
                from_day_of_week: 0, to_day_of_week: 6,
                from_hour: 0, from_minute: 0,
                to_hour: 24, to_minute: 0,
            }],
        }],
    };
}

/**
 * Deterministic, order-independent content hash of a parsed tariff. Two parses
 * with the same rates/windows/names produce the same hash regardless of the
 * order seasons/schedules arrive in. Used to skip appending a redundant tariff
 * version when content is unchanged.
 */
export function tariffContentHash(parsed: ParsedTariff): string {
    const normalized = {
        name: parsed.name,
        seasons: [...parsed.seasons]
            .map((s) => ({
                name: s.name,
                from_month: s.from_month, from_day: s.from_day,
                to_month: s.to_month, to_day: s.to_day,
                buy_rate: s.buy_rate, sell_rate: s.sell_rate,
                schedules: [...s.schedules]
                    .map((sc) => ({
                        name: sc.name,
                        buy_rate: sc.buy_rate, sell_rate: sc.sell_rate,
                        from_day_of_week: sc.from_day_of_week, to_day_of_week: sc.to_day_of_week,
                        from_hour: sc.from_hour, from_minute: sc.from_minute,
                        to_hour: sc.to_hour, to_minute: sc.to_minute,
                    }))
                    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
    };
    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
