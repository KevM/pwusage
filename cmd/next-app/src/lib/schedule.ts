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

    constructor(tariffs: Tariff[]) {
        this.tariffs = tariffs;
    }

    getTariffPeriod(t: Date): TariffPeriod | null {
        for (const tariff of this.tariffs) {
            if (!tariff.seasons) continue;
            for (const season of tariff.seasons) {
                if (!this.matchSeason(t, season)) {
                    continue;
                }

                if (!season.schedules) continue;
                for (const schedule of season.schedules) {
                    if (!this.matchSchedule(t, schedule)) {
                        continue;
                    }

                    const fromHour = schedule.from_hour ?? 0;
                    const toHour = schedule.to_hour ?? 24;

                    const start = new Date(t);
                    start.setHours(fromHour, 0, 0, 0);

                    const end = new Date(t);
                    end.setHours(toHour, 0, 0, 0);

                    return {
                        start,
                        end,
                        tariff,
                        season,
                        schedule
                    };
                }
            }
        }
        return null;
    }

    private matchSchedule(t: Date, schedule: TariffSchedule): boolean {
        if (this.matchDayOfWeek(t, schedule)) {
            if (this.matchHourOfDay(t, schedule)) {
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

    private matchDayOfWeek(t: Date, schedule: TariffSchedule): boolean {
        const twd = this.toTeslaWeekday(t.getDay());

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

    private matchHourOfDay(t: Date, schedule: TariffSchedule): boolean {
        const th = t.getHours();

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

    private matchSeason(t: Date, season: TariffSeason): boolean {
        // JS months are 0-indexed (0=Jan, 11=Dec)
        // Go/DB months are likely 1-indexed (1=Jan, 12=Dec) based on typical SQL/Go conventions.
        // Let's assume DB is 1-indexed.
        const month = t.getMonth() + 1;
        const day = t.getDate();

        let betweenFromTo = true;
        if (season.to_month < season.from_month) {
            betweenFromTo = false;
        }

        if (betweenFromTo) {
            if (month > season.from_month && month < season.to_month) {
                return true;
            }
            if (month === season.from_month && day > season.from_day) {
                return true;
            }
            if (month === season.to_month && day < season.to_day) {
                return true;
            }
        } else {
            // Wrap around year (e.g. Nov to Mar)
            if (month > season.from_month || month < season.to_month) {
                return true;
            }
            if (month === season.from_month && day > season.from_day) {
                return true;
            }
            if (month === season.to_month && day < season.to_day) {
                return true;
            }
        }
        return false;
    }
}
