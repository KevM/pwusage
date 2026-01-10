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

    private getLocalParts(d: Date): { month: number, day: number, hour: number, weekday: number, year: number } {
        // Use Intl to get parts according to timezone
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: this.timeZone,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            weekday: 'short',
            hour12: false
        }).formatToParts(d);

        const p: Record<string, string> = {};
        for (const part of parts) {
            p[part.type] = part.value;
        }

        // month: 1-12
        // day: 1-31
        // hour: 0-23
        // weekday: Sun, Mon...
        // year: YYYY

        const month = parseInt(p.month, 10);
        const day = parseInt(p.day, 10);
        const year = parseInt(p.year, 10);

        // Hour in 24h format from "24" or "0" etc? 
        // With hour12: false, it might return "24" for midnight in some implementations or "0".
        // Usually 0-23. Let's verify standard behavior or handle it safely.
        // Actually Intl usually returns 0-23. 
        let hour = parseInt(p.hour, 10);
        if (hour === 24) hour = 0;

        // The original toTeslaWeekday expects a number (0-6).
        // The new implementation passes a string ("Sun", "Mon", etc.).
        // We need to map the string weekday to a number (0-6) first, then pass it to toTeslaWeekday.
        const wdMap: Record<string, number> = {
            'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6
        };
        const weekday = wdMap[p.weekday] ?? 0;

        return { month, day, hour, weekday, year };
    }

    getTariffPeriod(t: Date): TariffPeriod | null {
        const local = this.getLocalParts(t);
        return this.getTariffPeriodForWallClock(local.month, local.day, local.hour, local.weekday, t, local.year);
    }

    getTariffPeriodForWallClock(month: number, day: number, hour: number, weekday: number, originalDate?: Date, year?: number): TariffPeriod | null {
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

                // Sort schedules: Specific time windows first, then broad (24h) windows
                const sortedSchedules = [...season.schedules].sort((a, b) => {
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
