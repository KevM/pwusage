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
    private formatter: Intl.DateTimeFormat;
    private memo: Map<string, { month: number, day: number, hour: number, weekday: number, year: number }> = new Map();

    constructor(tariffs: Tariff[], timeZone: string) {
        this.tariffs = tariffs;
        this.timeZone = timeZone;
        this.formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: this.timeZone,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            weekday: 'short',
            hour12: false
        });
    }

    private getLocalParts(d: Date): { month: number, day: number, hour: number, weekday: number, year: number } {
        // Memoize based on 15-minute intervals to handle timezone offsets of 30 or 45 mins.
        // Within any 15-minute window, the local hour/day/month/year/weekday will be constant.
        const intervalMs = 15 * 60 * 1000;
        const memoKey = Math.floor(d.getTime() / intervalMs).toString();

        const cached = this.memo.get(memoKey);
        if (cached) return cached;

        // Use cached Intl formatter to get parts according to timezone
        const parts = this.formatter.formatToParts(d);

        const p: Record<string, string> = {};
        for (const part of parts) {
            p[part.type] = part.value;
        }

        const month = parseInt(p.month, 10);
        const day = parseInt(p.day, 10);
        const year = parseInt(p.year, 10);

        let hour = parseInt(p.hour, 10);
        if (hour === 24) hour = 0;

        const wdMap: Record<string, number> = {
            'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6
        };
        const weekday = wdMap[p.weekday] ?? 0;

        const result = { month, day, hour, weekday, year };
        this.memo.set(memoKey, result);
        return result;
    }

    getTariffPeriod(t: Date): TariffPeriod | null {
        const local = this.getLocalParts(t);
        return this.getTariffPeriodByComponents(local.month, local.day, local.hour, local.weekday, t, local.year);
    }

    getTariffPeriodByComponents(month: number, day: number, hour: number, weekday: number, originalDate?: Date, year?: number): TariffPeriod | null {
        // Check for holidays
        // If year is provided, we can calculate dynamic holidays (Thanksgiving, Memorial Day, Labor Day)
        // If not, we might miss them, but getTariffPeriod passes it.

        let effectiveWeekday = weekday;

        if (year) {
            if (this.isHoliday(month, day, year)) {
                effectiveWeekday = 6; // Treat as Saturday (Weekend)
            }
        }

        for (const tariff of this.tariffs) {
            if (!tariff.seasons) continue;
            for (const season of tariff.seasons) {
                if (!this.matchSeason(month, day, season)) {
                    continue;
                }

                if (!season.schedules) continue;

                // Sort schedules: narrower day ranges first (Sat-Sun overrides Every Day),
                // then time-specific windows before all-day within the same day range.
                const sortedSchedules = [...season.schedules].sort((a, b) => {
                    const aDayRange = (a.from_day_of_week !== null && a.to_day_of_week !== null)
                        ? a.to_day_of_week - a.from_day_of_week
                        : 6;
                    const bDayRange = (b.from_day_of_week !== null && b.to_day_of_week !== null)
                        ? b.to_day_of_week - b.from_day_of_week
                        : 6;
                    if (aDayRange !== bDayRange) return aDayRange - bDayRange;

                    const aSpecific = a.from_hour !== null || a.to_hour !== null;
                    const bSpecific = b.from_hour !== null || b.to_hour !== null;
                    if (aSpecific && !bSpecific) return -1;
                    if (!aSpecific && bSpecific) return 1;
                    return 0;
                });

                for (const schedule of sortedSchedules) {
                    if (!this.matchSchedule(effectiveWeekday, hour, schedule)) {
                        continue;
                    }

                    return {
                        start: originalDate || new Date(),
                        end: originalDate || new Date(),
                        tariff,
                        season,
                        schedule
                    };
                }
            }
        }
        return null;
    }

    private isHoliday(month: number, day: number, year: number): boolean {
        // Fixed holidays
        // New Year's Day
        if (month === 1 && day === 1) return true;
        // Independence Day
        if (month === 7 && day === 4) return true;
        // Christmas Day
        if (month === 12 && day === 25) return true;

        // Observed Holidays (Sunday -> Monday)
        // If Jan 1 is Sunday (Weekday 0), Jan 2 (Monday) is observed.
        // If Jul 4 is Sunday, Jul 5 is observed.
        // If Dec 25 is Sunday, Dec 26 is observed.

        // We need to check if TODAY is an observed holiday.
        // Meaning: if Today is Jan 2, and Jan 1 was Sunday.
        if (month === 1 && day === 2) {
            const jan1 = new Date(year, 0, 1); // Month is 0-indexed in JS Date
            if (jan1.getDay() === 0) return true;
        }
        if (month === 7 && day === 5) {
            const jul4 = new Date(year, 6, 4);
            if (jul4.getDay() === 0) return true;
        }
        if (month === 12 && day === 26) {
            const dec25 = new Date(year, 11, 25);
            if (dec25.getDay() === 0) return true;
        }

        // Floating holidays
        // Memorial Day: Last Monday in May

        // Using JS Date for strictly checking day of week of this specific date
        const thisDate = new Date(year, month - 1, day);
        const wd = thisDate.getDay(); // 0=Sun, 1=Mon

        if (month === 5 && wd === 1 && day >= 25) return true;

        // Labor Day: First Monday in September
        if (month === 9 && wd === 1 && day <= 7) return true;

        // Thanksgiving: Fourth Thursday in November
        if (month === 11 && wd === 4) {
            // Check occurrence
            // 1st Thu: 1-7
            // 2nd Thu: 8-14
            // 3rd Thu: 15-21
            // 4th Thu: 22-28
            if (day >= 22 && day <= 28) return true;
        }

        return false;
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
            if (schedule.from_hour <= schedule.to_hour) {
                // Normal range: e.g., 08:00 - 20:00
                return th >= schedule.from_hour && th < schedule.to_hour;
            } else {
                // Midnight-crossing range: e.g., 20:00 - 08:00
                return th >= schedule.from_hour || th < schedule.to_hour;
            }
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
        if (season.from_month === season.to_month) {
            return month === season.from_month && day >= season.from_day && day <= season.to_day;
        }

        let betweenFromTo = true;
        if (season.to_month < season.from_month) {
            betweenFromTo = false;
        }

        if (betweenFromTo) {
            if (month > season.from_month && month < season.to_month) {
                return true;
            }
            if (month === season.from_month && day >= season.from_day) {
                return true;
            }
            if (month === season.to_month && day <= season.to_day) {
                return true;
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

export function getCurrentTariffLabel(site: { tariffs?: Tariff[]; timezone?: string } | null | undefined, atDate: Date = new Date()): string {
    if (!site || !site.tariffs || site.tariffs.length === 0 || !site.timezone) {
        return 'Unknown';
    }
    const schedule = new Schedule(site.tariffs, site.timezone);
    const tariffPeriod = schedule.getTariffPeriod(atDate);
    if (!tariffPeriod) {
        return 'Unknown';
    }
    const season = tariffPeriod.season.name || 'Season';
    const tariffName = tariffPeriod.tariff.name || 'Unknown';
    return `${season} - ${tariffName}`;
}

