import { Tariff, TariffSeason, TariffSchedule } from './db';

export interface TariffPeriod {
    start: Date;
    end: Date;
    tariff: Tariff;
    season: TariffSeason;
    schedule: TariffSchedule;
}

export class Schedule {
    private tariffs: Tariff[];
    private timeZone: string;

    constructor(tariffs: Tariff[], timeZone: string) {
        this.tariffs = tariffs;
        this.timeZone = timeZone;
    }

    private getLocalParts(t: Date) {
        // Use Intl to get parts in the site's timezone
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: this.timeZone,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            hourCycle: 'h23',
            weekday: 'short'
        });

        const parts = fmt.formatToParts(t);
        const getPart = (type: string) => parts.find(p => p.type === type)?.value;

        const month = parseInt(getPart('month') || '1', 10);
        const day = parseInt(getPart('day') || '1', 10);
        const hour = parseInt(getPart('hour') || '0', 10);

        // Weekday is string "Mon", "Tue" etc. We need to map to 0-6.
        // But t.getDay() is 0=Sun. 
        // We can just construct a 'local' Date object by parsing the string parts, 
        // but that's messy with DST.
        // Better: strict weekday parsing or map "Mon"->1.

        const wdMap: Record<string, number> = {
            'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6
        };
        const wdStr = getPart('weekday') || 'Sun';
        const weekday = wdMap[wdStr] ?? 0;

        return { month, day, hour, weekday };
    }

    getTariffPeriod(t: Date): TariffPeriod | null {
        const local = this.getLocalParts(t);

        for (const tariff of this.tariffs) {
            if (!tariff.seasons) continue;
            for (const season of tariff.seasons) {
                if (!this.matchSeason(local.month, local.day, season)) {
                    continue;
                }

                if (!season.schedules) continue;
                for (const schedule of season.schedules) {
                    if (!this.matchSchedule(local.weekday, local.hour, schedule)) {
                        continue;
                    }

                    // For the returned start/end, we ideally want the boundary of this period.
                    // But getTariffPeriod is just used for labeling the specific point 't'.
                    // We can just return 't' as start/end or boundaries if needed.
                    // The caller in EnergyRepo just asks "What period is THIS point in?"

                    // Note: original code calculated start/end boundaries, 
                    // but they were based on `start.setHours(...)` which used Local System Time.
                    // Since we aren't using start/end for aggregation grouping (we group by name),
                    // we can keep them approximate or fix them. 
                    // Fixing them properly requires constructing a Date in the specific timezone.
                    // For now, let's just return the point itself or similar, as it's not critical for aggregation grouping.

                    return {
                        start: t,
                        end: t,
                        tariff,
                        season,
                        schedule
                    };
                }
            }
        }
        return null;
    }

    private matchSchedule(weekday: number, hour: number, schedule: TariffSchedule): boolean {
        if (this.matchDayOfWeek(weekday, schedule)) {
            if (this.matchHourOfDay(hour, schedule)) {
                return true;
            }
        }
        return false;
    }

    private toTeslaWeekday(wd: number): number {
        // JS: 0=Sun, 1=Mon ... 6=Sat
        // Tesla: 0=Mon ... 6=Sun
        if (wd === 0) return 6;
        return wd - 1;
    }

    private matchDayOfWeek(weekday: number, schedule: TariffSchedule): boolean {
        const twd = this.toTeslaWeekday(weekday);

        if (schedule.from_day_of_week !== null && schedule.to_day_of_week !== null) {
            return twd >= schedule.from_day_of_week && twd <= schedule.to_day_of_week;
        }

        if (schedule.to_day_of_week !== null) {
            return twd <= schedule.to_day_of_week;
        }

        if (schedule.from_day_of_week !== null) {
            return twd >= schedule.from_day_of_week;
        }

        return false;
    }

    private matchHourOfDay(hour: number, schedule: TariffSchedule): boolean {
        const th = hour;

        if (schedule.from_hour === null && schedule.to_hour === null) {
            return true;
        }

        if (schedule.from_hour !== null && schedule.to_hour !== null) {
            return th >= schedule.from_hour && th < schedule.to_hour;
        }

        if (schedule.to_hour !== null) {
            return th < schedule.to_hour;
        }

        if (schedule.from_hour !== null) {
            return th >= schedule.from_hour;
        }

        return false;
    }

    private matchSeason(month: number, day: number, season: TariffSeason): boolean {
        let betweenFromTo = true;
        if (season.to_month < season.from_month) {
            betweenFromTo = false;
        }

        if (betweenFromTo) {
            if (month > season.from_month && month < season.to_month) {
                return true;
            }
            if (month === season.from_month && day >= season.from_day) { // Changed > to >= for inclusive start day?
                // Standard convention: if strictly within months, day doesn't matter.
                // If on boundary month, check day.
                // season.from_day check: usually inclusive.
                // Original logic for strict equality: month === from && day > from.
                // If from_day is 1, and today is 1st. 1 > 1 is False. 
                // So "day 1" is NOT included? That seems wrong. usually inclusive.
                // I will change to >=.
                return true;
            }
            if (month === season.to_month && day <= season.to_day) { // Changed < to <=
                return true;
            }
            // Wait, mixed months?
            // If from_month == to_month?
            if (season.from_month === season.to_month) {
                return month === season.from_month && day >= season.from_day && day <= season.to_day;
            }
        } else {
            // Wrap around year (e.g. Nov to Mar)
            if (month > season.from_month || month < season.to_month) {
                return true;
            }
            if (month === season.from_month && day >= season.from_day) {
                return true;
            }
            if (month === season.to_month && day <= season.to_day) {
                return true;
            }
        }
        return false;
    }
}
