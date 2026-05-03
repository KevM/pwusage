import { TariffV2 } from '../tesla-client';

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

export function parseTariffContent(content: TariffV2, siteName: string): ParsedTariff {
    const tariffName = content.utility ?? siteName;
    const seasons: ParsedSeason[] = [];

    for (const seasonName in content.seasons) {
        const seasonData = content.seasons[seasonName];

        let fixedSeasonName = seasonName;
        const sFrom = seasonData.fromMonth;
        if (seasonName.toLowerCase() === 'summer' && (sFrom >= 10 || sFrom <= 2)) {
            fixedSeasonName = 'Winter';
        } else if (seasonName.toLowerCase() === 'winter' && (sFrom >= 5 && sFrom <= 9)) {
            fixedSeasonName = 'Summer';
        }

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
