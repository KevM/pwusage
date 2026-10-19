import { Tariff, TariffSeason, TariffSchedule } from './db';
import { isObservedHoliday, type HolidayRule } from './holidays';

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
    private holidayRules?: HolidayRule[];
    private formatter: Intl.DateTimeFormat;
    private memo: Map<string, { month: number, day: number, hour: number, minute: number, weekday: number, year: number }> = new Map();

    constructor(tariffs: Tariff[], timeZone: string, holidayRules?: HolidayRule[]) {
        this.tariffs = tariffs;
        this.timeZone = timeZone;
        this.holidayRules = holidayRules;
        this.formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: this.timeZone,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            weekday: 'short',
            hour12: false
        });
    }

    private getLocalParts(d: Date): { month: number, day: number, hour: number, minute: number, weekday: number, year: number } {
        // Memoize by minute because some tariffs use minute-level TOU boundaries.
        const intervalMs = 60 * 1000;
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
        const minute = parseInt(p.minute, 10);

        const wdMap: Record<string, number> = {
            'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6
        };
        const weekday = wdMap[p.weekday] ?? 0;

        const result = { month, day, hour, minute, weekday, year };
        this.memo.set(memoKey, result);
        return result;
    }

    get siteTimeZone(): string {
        return this.timeZone;
    }

    /**
     * Local minutes of the day where any schedule window starts or ends, plus
     * midnight (where the date, weekday, season and holidays change). Within a
     * local day the resolved period can only change at one of these minutes.
     */
    boundaryMinutes(): number[] {
        const minutes = new Set<number>([0]);
        for (const tariff of this.tariffs) {
            for (const season of tariff.seasons ?? []) {
                for (const schedule of season.schedules ?? []) {
                    if (schedule.from_hour !== null && schedule.from_hour !== undefined) {
                        minutes.add((schedule.from_hour * 60 + (schedule.from_minute ?? 0)) % 1440);
                    }
                    if (schedule.to_hour !== null && schedule.to_hour !== undefined) {
                        minutes.add((schedule.to_hour * 60 + (schedule.to_minute ?? 0)) % 1440);
                    }
                }
            }
        }
        return [...minutes].sort((a, b) => a - b);
    }

    getTariffPeriod(t: Date): TariffPeriod | null {
        const local = this.getLocalParts(t);
        return this.getTariffPeriodByComponents(local.month, local.day, local.hour, local.weekday, t, local.year, local.minute);
    }

    getTariffPeriodByComponents(month: number, day: number, hour: number, weekday: number, originalDate?: Date, year?: number, minute: number = 0): TariffPeriod | null {
        // Check for holidays
        // If year is provided, we can calculate dynamic holidays (Thanksgiving, Memorial Day, Labor Day)
        // If not, we might miss them, but getTariffPeriod passes it.

        let effectiveWeekday = weekday;

        if (year) {
            if (isObservedHoliday(year, month, day, this.holidayRules)) {
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
                        ? (a.to_day_of_week - a.from_day_of_week + 7) % 7
                        : 6;
                    const bDayRange = (b.from_day_of_week !== null && b.to_day_of_week !== null)
                        ? (b.to_day_of_week - b.from_day_of_week + 7) % 7
                        : 6;
                    if (aDayRange !== bDayRange) return aDayRange - bDayRange;

                    const aSpecific = a.from_hour !== null || a.to_hour !== null;
                    const bSpecific = b.from_hour !== null || b.to_hour !== null;
                    if (aSpecific && !bSpecific) return -1;
                    if (!aSpecific && bSpecific) return 1;
                    return 0;
                });

                for (const schedule of sortedSchedules) {
                    if (!this.matchSchedule(effectiveWeekday, hour, minute, schedule)) {
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


    private matchSchedule(weekday: number, hour: number, minute: number, schedule: TariffSchedule): boolean {
        if (this.matchDayOfWeek(weekday, schedule)) {
            if (this.matchTimeOfDay(hour, minute, schedule)) {
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
            if (schedule.from_day_of_week <= schedule.to_day_of_week) {
                // Normal range: e.g., Mon–Fri (0–4)
                return twd >= schedule.from_day_of_week && twd <= schedule.to_day_of_week;
            }
            // Week-wrapping range: e.g., Sun–Thu (6→3), mirroring
            // midnight-crossing hour windows.
            return twd >= schedule.from_day_of_week || twd <= schedule.to_day_of_week;
        }

        if (schedule.to_day_of_week !== null) {
            return twd <= schedule.to_day_of_week;
        }

        if (schedule.from_day_of_week !== null) {
            return twd >= schedule.from_day_of_week;
        }

        return false;
    }

    private matchTimeOfDay(hour: number, minute: number, schedule: TariffSchedule): boolean {
        const time = hour * 60 + minute;

        if (schedule.from_hour === null && schedule.to_hour === null) {
            return true;
        }

        if (schedule.from_hour !== null && schedule.to_hour !== null) {
            const from = schedule.from_hour * 60 + (schedule.from_minute ?? 0);
            const to = schedule.to_hour * 60 + (schedule.to_minute ?? 0);
            if (from <= to) {
                // Normal range: e.g., 08:00 - 20:00
                return time >= from && time < to;
            } else {
                // Midnight-crossing range: e.g., 20:00 - 08:00
                return time >= from || time < to;
            }
        }

        if (schedule.to_hour !== null) {
            const to = schedule.to_hour * 60 + (schedule.to_minute ?? 0);
            return time < to;
        }

        if (schedule.from_hour !== null) {
            const from = schedule.from_hour * 60 + (schedule.from_minute ?? 0);
            return time >= from;
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
