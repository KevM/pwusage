import { describe, it, expect } from 'vitest';
import { Schedule } from './schedule';
import { Tariff } from './db';

// Reproduces the "Harrison" site (We energies / CGS NM):
//   timezone: America/Chicago (site metadata)
//   Winter (Oct 1 – May 31): Off-Peak 20:00–08:00 every day, Off-Peak all-day Sat–Sun, On-Peak 08:00–20:00 every day
//   Summer (Jun 1 – Sep 30): same structure, different rates
// Tesla day-of-week encoding: 0 = Mon … 6 = Sun
const HARRISON_TIMEZONE = 'America/Chicago'; // from site metadata

function makeHarrisonTariff(): Tariff[] {
    return [
        {
            id: 1,
            site_id: 'harrison',
            name: 'We energies',
            updated: new Date('2026-01-01'),
            seasons: [
                {
                    id: 1,
                    tariff_id: 1,
                    name: 'Winter',
                    from_month: 10, from_day: 1,
                    to_month: 5, to_day: 31,
                    buy_rate: 0.10, sell_rate: 0.03,
                    schedules: [
                        // Overnight Off-Peak: every day, 20:00–08:00 (wraps midnight)
                        {
                            id: 1, season_id: 1, name: 'Off-Peak',
                            buy_rate: 0.10, sell_rate: 0.03,
                            from_day_of_week: 0, to_day_of_week: 6,
                            from_hour: 20, from_minute: 0,
                            to_hour: 8, to_minute: 0,
                        },
                        // Weekend Off-Peak: Sat–Sun, all day (null = all day)
                        {
                            id: 2, season_id: 1, name: 'Off-Peak',
                            buy_rate: 0.10, sell_rate: 0.03,
                            from_day_of_week: 5, to_day_of_week: 6,
                            from_hour: null, from_minute: null,
                            to_hour: null, to_minute: null,
                        },
                        // Weekday On-Peak: every day, 08:00–20:00
                        {
                            id: 3, season_id: 1, name: 'On-Peak',
                            buy_rate: 0.31, sell_rate: 0.04,
                            from_day_of_week: 0, to_day_of_week: 6,
                            from_hour: 8, from_minute: 0,
                            to_hour: 20, to_minute: 0,
                        },
                    ],
                },
                {
                    id: 2,
                    tariff_id: 1,
                    name: 'Summer',
                    from_month: 6, from_day: 1,
                    to_month: 9, to_day: 30,
                    buy_rate: 0.10, sell_rate: 0.03,
                    schedules: [
                        {
                            id: 4, season_id: 2, name: 'Off-Peak',
                            buy_rate: 0.10, sell_rate: 0.03,
                            from_day_of_week: 0, to_day_of_week: 6,
                            from_hour: 20, from_minute: 0,
                            to_hour: 8, to_minute: 0,
                        },
                        {
                            id: 5, season_id: 2, name: 'Off-Peak',
                            buy_rate: 0.10, sell_rate: 0.03,
                            from_day_of_week: 5, to_day_of_week: 6,
                            from_hour: null, from_minute: null,
                            to_hour: null, to_minute: null,
                        },
                        {
                            id: 6, season_id: 2, name: 'On-Peak',
                            buy_rate: 0.30, sell_rate: 0.04,
                            from_day_of_week: 0, to_day_of_week: 6,
                            from_hour: 8, from_minute: 0,
                            to_hour: 20, to_minute: 0,
                        },
                    ],
                },
            ],
        },
    ];
}

const TZ = HARRISON_TIMEZONE;

describe('Schedule – Harrison / We energies smoke tests', () => {
    it('Winter weekday midday → On-Peak', () => {
        // Tue Jan 27 2026, 10:00 CST = 16:00 UTC
        const ts = new Date('2026-01-27T16:00:00Z');
        const tp = new Schedule(makeHarrisonTariff(), TZ).getTariffPeriod(ts);
        expect(tp?.schedule.name).toBe('On-Peak');
        expect(tp?.season.name).toBe('Winter');
    });

    it('Winter weekday evening → Off-Peak', () => {
        // Tue Jan 27 2026, 21:00 CST = Wed 03:00 UTC
        const ts = new Date('2026-01-28T03:00:00Z');
        const tp = new Schedule(makeHarrisonTariff(), TZ).getTariffPeriod(ts);
        expect(tp?.schedule.name).toBe('Off-Peak');
        expect(tp?.season.name).toBe('Winter');
    });

    it('Winter weekday early morning → Off-Peak', () => {
        // Tue Jan 27 2026, 06:00 CST = 12:00 UTC
        const ts = new Date('2026-01-27T12:00:00Z');
        const tp = new Schedule(makeHarrisonTariff(), TZ).getTariffPeriod(ts);
        expect(tp?.schedule.name).toBe('Off-Peak');
        expect(tp?.season.name).toBe('Winter');
    });

    it('Winter Saturday midday → Off-Peak', () => {
        // Sat Jan 31 2026, 10:00 CST = 16:00 UTC
        const ts = new Date('2026-01-31T16:00:00Z');
        const tp = new Schedule(makeHarrisonTariff(), TZ).getTariffPeriod(ts);
        expect(tp?.schedule.name).toBe('Off-Peak');
        expect(tp?.season.name).toBe('Winter');
    });

    it('Winter Sunday midday → Off-Peak', () => {
        // Sun Feb 1 2026, 10:00 CST = 16:00 UTC
        const ts = new Date('2026-02-01T16:00:00Z');
        const tp = new Schedule(makeHarrisonTariff(), TZ).getTariffPeriod(ts);
        expect(tp?.schedule.name).toBe('Off-Peak');
        expect(tp?.season.name).toBe('Winter');
    });

    it('Summer weekday midday → On-Peak', () => {
        // Tue Jul 7 2026, 10:00 CDT = 15:00 UTC
        const ts = new Date('2026-07-07T15:00:00Z');
        const tp = new Schedule(makeHarrisonTariff(), TZ).getTariffPeriod(ts);
        expect(tp?.schedule.name).toBe('On-Peak');
        expect(tp?.season.name).toBe('Summer');
    });

    it('Summer weekday evening → Off-Peak', () => {
        // Tue Jul 7 2026, 21:00 CDT = Wed 02:00 UTC
        const ts = new Date('2026-07-08T02:00:00Z');
        const tp = new Schedule(makeHarrisonTariff(), TZ).getTariffPeriod(ts);
        expect(tp?.schedule.name).toBe('Off-Peak');
        expect(tp?.season.name).toBe('Summer');
    });

    it('Summer Saturday midday → Off-Peak', () => {
        // Sat Jul 11 2026, 12:00 CDT = 17:00 UTC
        const ts = new Date('2026-07-11T17:00:00Z');
        const tp = new Schedule(makeHarrisonTariff(), TZ).getTariffPeriod(ts);
        expect(tp?.schedule.name).toBe('Off-Peak');
        expect(tp?.season.name).toBe('Summer');
    });

    it('both Off-Peak and On-Peak periods exist in each season', () => {
        const tariffs = makeHarrisonTariff();
        for (const season of tariffs[0].seasons!) {
            const names = season.schedules!.map(s => s.name);
            expect(names).toContain('Off-Peak');
            expect(names).toContain('On-Peak');
        }
    });

    it('handles single-month seasons correctly', () => {
        const singleMonthTariff: Tariff[] = [
            {
                id: 2,
                site_id: 'site1',
                updated: new Date(),
                name: 'Single Month Test',
                seasons: [
                    {
                        id: 201,
                        tariff_id: 2,
                        name: 'June Mid',
                        from_month: 6,
                        from_day: 1,
                        to_month: 6,
                        to_day: 15,
                        buy_rate: 0.1,
                        sell_rate: 0.05,
                        schedules: [
                            {
                                id: 2011,
                                season_id: 201,
                                name: 'All Day',
                                buy_rate: 0.1,
                                sell_rate: 0.05,
                                from_day_of_week: 0,
                                to_day_of_week: 6,
                                from_hour: null,
                                to_hour: null,
                                from_minute: null,
                                to_minute: null,
                            }
                        ]
                    }
                ]
            }
        ];

        const schedule = new Schedule(singleMonthTariff, 'UTC');
        
        // June 10 is inside the June 1-15 season
        expect(schedule.getTariffPeriod(new Date('2026-06-10T12:00:00Z'))).not.toBeNull();
        
        // June 20 is outside the June 1-15 season
        expect(schedule.getTariffPeriod(new Date('2026-06-20T12:00:00Z'))).toBeNull();
    });

    it('correctly distinguishes hours in half-hour offset timezone memoization', () => {
        const adelaideTariff: Tariff[] = [
            {
                id: 3,
                site_id: 'site_adelaide',
                updated: new Date(),
                name: 'Adelaide Test',
                seasons: [
                    {
                        id: 301,
                        tariff_id: 3,
                        name: 'All Year',
                        from_month: 1,
                        from_day: 1,
                        to_month: 12,
                        to_day: 31,
                        buy_rate: 0.2,
                        sell_rate: 0.1,
                        schedules: [
                            {
                                id: 3011,
                                season_id: 301,
                                name: 'On-Peak',
                                buy_rate: 0.4,
                                sell_rate: 0.1,
                                from_day_of_week: 0,
                                to_day_of_week: 6,
                                from_hour: 17,
                                to_hour: 24,
                                from_minute: null,
                                to_minute: null,
                            },
                            {
                                id: 3012,
                                season_id: 301,
                                name: 'Off-Peak',
                                buy_rate: 0.2,
                                sell_rate: 0.1,
                                from_day_of_week: 0,
                                to_day_of_week: 6,
                                from_hour: 0,
                                to_hour: 17,
                                from_minute: null,
                                to_minute: null,
                            }
                        ]
                    }
                ]
            }
        ];

        const tz = 'Australia/Adelaide'; // UTC+9:30
        const schedule = new Schedule(adelaideTariff, tz);

        // 16:55 local time = 07:25 UTC. This should be Off-Peak.
        const tOffPeak = new Date('2026-07-01T07:25:00Z');
        
        // 17:05 local time = 07:35 UTC. This should be On-Peak.
        const tOnPeak = new Date('2026-07-01T07:35:00Z');

        // Querying in order Off-Peak first
        const tp1 = schedule.getTariffPeriod(tOffPeak);
        const tp2 = schedule.getTariffPeriod(tOnPeak);

        expect(tp1?.schedule.name).toBe('Off-Peak');
        expect(tp2?.schedule.name).toBe('On-Peak');

        // Querying with a new instance in order On-Peak first to check cache pollution
        const schedule2 = new Schedule(adelaideTariff, tz);
        const tp2_1 = schedule2.getTariffPeriod(tOnPeak);
        const tp2_2 = schedule2.getTariffPeriod(tOffPeak);

        expect(tp2_1?.schedule.name).toBe('On-Peak');
        expect(tp2_2?.schedule.name).toBe('Off-Peak');
    });
});
