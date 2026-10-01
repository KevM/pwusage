import type { Tariff, TariffSchedule } from './db-types';
import { Schedule } from './schedule';
import { formatTimeRange, formatTouName } from './format-utils';

function days(period: TariffSchedule, periods: TariffSchedule[]): string {
    const weekendOverride = periods.some(p => p.id !== period.id && p.from_day_of_week !== null && p.from_day_of_week >= 5 && p.from_hour === null && p.to_hour === null);
    if (period.from_day_of_week === 0 && period.to_day_of_week === 6) {
        return weekendOverride && (period.from_hour !== null || period.to_hour !== null) ? 'Mon – Fri' : 'Every day';
    }
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    if (period.from_day_of_week === null && period.to_day_of_week === null) return 'Every day';
    const from = names[period.from_day_of_week ?? 0];
    const to = names[period.to_day_of_week ?? 6];
    return from === to ? from : `${from} – ${to}`;
}

export function buildTariffContract(tariffs: Tariff[], timezone: string, now: Date) {
    const active = new Schedule(tariffs, timezone).getTariffPeriod(now);
    const local = new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'numeric', day: 'numeric' }).formatToParts(now);
    const monthDay = Number(local.find(p => p.type === 'month')?.value) * 100 + Number(local.find(p => p.type === 'day')?.value);
    const dateLabel = (month: number, day: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(2000, month - 1, day)));
    return tariffs.map(tariff => ({
        id: tariff.id, name: formatTouName(tariff.name || 'Tariff'),
        seasons: (tariff.seasons ?? []).map(season => {
            const from = season.from_month * 100 + season.from_day;
            const to = season.to_month * 100 + season.to_day;
            const isActive = from <= to ? monthDay >= from && monthDay <= to : monthDay >= from || monthDay <= to;
            return {
                id: season.id, name: formatTouName(season.name || 'Unnamed season'),
                dates: `${dateLabel(season.from_month, season.from_day)} – ${dateLabel(season.to_month, season.to_day)}`,
                isActive,
                periods: (season.schedules ?? []).map(period => ({
                    id: period.id, name: formatTouName(period.name || 'Standard'),
                    days: days(period, season.schedules ?? []),
                    times: formatTimeRange(period.from_hour, period.from_minute, period.to_hour, period.to_minute),
                    buyRate: period.buy_rate ?? season.buy_rate,
                    sellRate: period.sell_rate ?? season.sell_rate,
                    isActive: active?.tariff.id === tariff.id && active.season.id === season.id && active.schedule.id === period.id,
                })),
            };
        }),
    }));
}
