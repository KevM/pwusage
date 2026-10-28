import { describe, it, expect } from 'vitest';
import { Schedule } from './schedule';
import { Tariff } from './db';

describe('same-month season spanning the year', () => {
    const tariff: Tariff = {
        id: 1, site_id: 'site', name: 'Utility', updated: new Date('2026-09-10T00:00:00Z'),
        seasons: [{
            id: 1, tariff_id: 1, name: 'Rest of year', from_month: 9, from_day: 11,
            to_month: 9, to_day: 7, buy_rate: .3, sell_rate: .04,
            schedules: [{ id: 1, season_id: 1, name: 'Standard', buy_rate: .3, sell_rate: .04,
                from_day_of_week: 0, to_day_of_week: 6, from_hour: 0, from_minute: 0, to_hour: 24, to_minute: 0 }],
        }],
    };

    it.each(['2026-09-01', '2026-09-07', '2026-09-11', '2026-09-30', '2026-10-01', '2027-01-01', '2027-08-31'])
        ('matches %s within a Sep 11 to Sep 7 year-wrapping season', date => {
            expect(new Schedule([tariff], 'Australia/Melbourne').getTariffPeriod(new Date(`${date}T02:00:00Z`))?.season.id).toBe(1);
        });

    it.each(['2026-09-08', '2026-09-09', '2026-09-10'])
        ('leaves %s for the explicit daily seasons', date => {
            expect(new Schedule([tariff], 'Australia/Melbourne').getTariffPeriod(new Date(`${date}T02:00:00Z`))).toBeNull();
        });

    it('keeps a non-wrapping same-month season confined to its inclusive dates', () => {
        const shorter = { ...tariff, seasons: [{ ...tariff.seasons![0], from_day: 7, to_day: 11 }] };
        const schedule = new Schedule([shorter], 'Australia/Melbourne');
        for (const day of [7, 11]) expect(schedule.getTariffPeriod(new Date(`2026-09-${String(day).padStart(2, '0')}T02:00:00Z`))).not.toBeNull();
        for (const date of ['2026-09-06', '2026-09-12', '2026-10-08']) expect(schedule.getTariffPeriod(new Date(`${date}T02:00:00Z`))).toBeNull();
    });
});

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

function makeMinuteBoundaryTariff(): Tariff[] {
    return [
        {
            id: 101,
            site_id: 'minute-site',
            name: 'Minute Boundary',
            updated: new Date('2026-01-01'),
            seasons: [
                {
                    id: 1010,
                    tariff_id: 101,
                    name: 'All Year',
                    from_month: 1, from_day: 1,
                    to_month: 12, to_day: 31,
                    buy_rate: 0.10, sell_rate: 0.03,
                    schedules: [
                        {
                            id: 1011, season_id: 1010, name: 'Peak',
                            buy_rate: 0.50, sell_rate: 0.10,
                            from_day_of_week: 0, to_day_of_week: 6,
                            from_hour: 16, from_minute: 30,
                            to_hour: 21, to_minute: 30,
                        },
                        {
                            id: 1012, season_id: 1010, name: 'Off-Peak',
                            buy_rate: 0.10, sell_rate: 0.03,
                            from_day_of_week: 0, to_day_of_week: 6,
                            from_hour: null, from_minute: null,
                            to_hour: null, to_minute: null,
                        },
                    ],
                },
            ],
        },
    ];
}

function makeDstBoundaryTariff(): Tariff[] {
    return [
        {
            id: 102,
            site_id: 'dst-site',
            name: 'DST Boundary',
            updated: new Date('2026-01-01'),
            seasons: [
                {
                    id: 1020,
                    tariff_id: 102,
                    name: 'All Year',
                    from_month: 1, from_day: 1,
                    to_month: 12, to_day: 31,
                    buy_rate: 0.10, sell_rate: 0.03,
                    schedules: [
                        {
                            id: 1021, season_id: 1020, name: 'Peak',
                            buy_rate: 0.50, sell_rate: 0.10,
                            from_day_of_week: 0, to_day_of_week: 6,
                            from_hour: 1, from_minute: 30,
                            to_hour: 3, to_minute: 30,
                        },
                        {
                            id: 1022, season_id: 1020, name: 'Off-Peak',
                            buy_rate: 0.10, sell_rate: 0.03,
                            from_day_of_week: 0, to_day_of_week: 6,
                            from_hour: null, from_minute: null,
                            to_hour: null, to_minute: null,
                        },
                    ],
                },
            ],
        },
    ];
}

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

describe('Schedule observed holidays', () => {
    it('bills observed Independence Day (Fri 2026-07-03, Jul 4 is a Saturday) as weekend Off-Peak', () => {
        const schedule = new Schedule(makeHarrisonTariff(), HARRISON_TIMEZONE);
        // 14:00 Central on Friday Jul 3 2026 — normally On-Peak (08:00-20:00 weekday).
        const period = schedule.getTariffPeriod(new Date('2026-07-03T19:00:00Z'));

        expect(period).not.toBeNull();
        expect(period!.schedule.name).toBe('Off-Peak');
        // Must be the all-day weekend schedule, not the overnight window.
        expect(period!.schedule.from_hour).toBeNull();
    });

    it('bills an ordinary summer Friday afternoon as On-Peak', () => {
        const schedule = new Schedule(makeHarrisonTariff(), HARRISON_TIMEZONE);
        // 14:00 Central on Friday Jul 10 2026.
        const period = schedule.getTariffPeriod(new Date('2026-07-10T19:00:00Z'));

        expect(period).not.toBeNull();
        expect(period!.schedule.name).toBe('On-Peak');
    });

    it('bills a Monday observing a Sunday holiday as weekend Off-Peak (Jul 5 2027)', () => {
        const schedule = new Schedule(makeHarrisonTariff(), HARRISON_TIMEZONE);
        const period = schedule.getTariffPeriod(new Date('2027-07-05T19:00:00Z'));

        expect(period).not.toBeNull();
        expect(period!.schedule.name).toBe('Off-Peak');
    });
});

describe('Schedule minute-level TOU boundaries', () => {
    it('does not enter a half-hour peak period before from_minute', () => {
        const schedule = new Schedule(makeMinuteBoundaryTariff(), 'America/Chicago');
        // Tue Jul 7 2026, 16:15 CDT = 21:15 UTC. Peak starts at 16:30 local.
        const period = schedule.getTariffPeriod(new Date('2026-07-07T21:15:00Z'));

        expect(period).not.toBeNull();
        expect(period!.schedule.name).toBe('Off-Peak');
    });

    it('stays in a half-hour peak period until to_minute', () => {
        const schedule = new Schedule(makeMinuteBoundaryTariff(), 'America/Chicago');
        // Tue Jul 7 2026, 21:15 CDT = Wed 02:15 UTC. Peak ends at 21:30 local.
        const period = schedule.getTariffPeriod(new Date('2026-07-08T02:15:00Z'));

        expect(period).not.toBeNull();
        expect(period!.schedule.name).toBe('Peak');
    });

    it('leaves a half-hour peak period at to_minute', () => {
        const schedule = new Schedule(makeMinuteBoundaryTariff(), 'America/Chicago');
        // Tue Jul 7 2026, 21:30 CDT = Wed 02:30 UTC. End is exclusive.
        const period = schedule.getTariffPeriod(new Date('2026-07-08T02:30:00Z'));

        expect(period).not.toBeNull();
        expect(period!.schedule.name).toBe('Off-Peak');
    });
});

describe('Schedule DST transitions', () => {
    it('keeps a spring-forward period active across the nonexistent local hour', () => {
        const schedule = new Schedule(makeDstBoundaryTariff(), 'America/Chicago');

        expect(schedule.getTariffPeriod(new Date('2026-03-08T07:45:00Z'))?.schedule.name).toBe('Peak');
        expect(schedule.getTariffPeriod(new Date('2026-03-08T08:15:00Z'))?.schedule.name).toBe('Peak');
        expect(schedule.getTariffPeriod(new Date('2026-03-08T08:30:00Z'))?.schedule.name).toBe('Off-Peak');
    });

    it('bills both repeated fall-back local times by local clock time', () => {
        const schedule = new Schedule(makeDstBoundaryTariff(), 'America/Chicago');

        expect(schedule.getTariffPeriod(new Date('2026-11-01T06:45:00Z'))?.schedule.name).toBe('Peak');
        expect(schedule.getTariffPeriod(new Date('2026-11-01T07:45:00Z'))?.schedule.name).toBe('Peak');
        expect(schedule.getTariffPeriod(new Date('2026-11-01T09:30:00Z'))?.schedule.name).toBe('Off-Peak');
    });
});

describe('Schedule – wrapped day-of-week ranges', () => {
    // Tesla day-of-week encoding: 0=Mon … 6=Sun. "Sunday through Thursday" can
    // only be expressed as from 6 wrapping to 3 — the same way hour windows
    // wrap midnight (20:00 → 08:00).
    function makeWrappedTariff(): Tariff[] {
        return [{
            id: 9,
            site_id: 'wrap_site',
            name: 'Wrap Test',
            updated: new Date('2026-01-01'),
            seasons: [{
                id: 901, tariff_id: 9, name: 'All Year',
                from_month: 1, from_day: 1, to_month: 12, to_day: 31,
                buy_rate: 0.2, sell_rate: 0.1,
                schedules: [{
                    id: 9011, season_id: 901, name: 'Sun-Thu',
                    buy_rate: 0.2, sell_rate: 0.1,
                    from_day_of_week: 6, to_day_of_week: 3, // Sun → Thu (wraps)
                    from_hour: null, from_minute: null,
                    to_hour: null, to_minute: null,
                }],
            }],
        }];
    }

    it('matches days inside a wrapped range (Sunday and Wednesday)', () => {
        const schedule = new Schedule(makeWrappedTariff(), 'UTC');
        // Sun Jul 12 2026 and Wed Jul 15 2026 (neither is a holiday)
        expect(schedule.getTariffPeriod(new Date('2026-07-12T12:00:00Z'))?.schedule.name).toBe('Sun-Thu');
        expect(schedule.getTariffPeriod(new Date('2026-07-15T12:00:00Z'))?.schedule.name).toBe('Sun-Thu');
    });

    it('does not match days outside a wrapped range (Friday)', () => {
        const schedule = new Schedule(makeWrappedTariff(), 'UTC');
        // Fri Jul 17 2026
        expect(schedule.getTariffPeriod(new Date('2026-07-17T12:00:00Z'))).toBeNull();
    });
});

describe('Schedule – DST transitions (America/Chicago 2026)', () => {
    // Probe tariff with a boundary at the repeated/skipped hour:
    // "Late-Night" covers local hour 01:00–02:00 every day, all year.
    function makeHourProbeTariff(): Tariff[] {
        return [{
            id: 7,
            site_id: 'dst_site',
            name: 'DST Probe',
            updated: new Date('2026-01-01'),
            seasons: [{
                id: 701, tariff_id: 7, name: 'All Year',
                from_month: 1, from_day: 1, to_month: 12, to_day: 31,
                buy_rate: 0.2, sell_rate: 0.1,
                schedules: [
                    {
                        id: 7011, season_id: 701, name: 'Late-Night',
                        buy_rate: 0.1, sell_rate: 0.05,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: 1, from_minute: 0,
                        to_hour: 2, to_minute: 0,
                    },
                    {
                        id: 7012, season_id: 701, name: 'Rest',
                        buy_rate: 0.3, sell_rate: 0.1,
                        from_day_of_week: 0, to_day_of_week: 6,
                        from_hour: null, from_minute: null,
                        to_hour: null, to_minute: null,
                    },
                ],
            }],
        }];
    }

    it('fall-back: both occurrences of the repeated 01:30 resolve to local hour 1', () => {
        const schedule = new Schedule(makeHourProbeTariff(), 'America/Chicago');
        // Nov 1 2026: clocks fall back 02:00 CDT → 01:00 CST; 01:00–02:00 happens twice.
        const firstOneThirty = new Date('2026-11-01T06:30:00Z');  // 01:30 CDT (UTC-5)
        const secondOneThirty = new Date('2026-11-01T07:30:00Z'); // 01:30 CST (UTC-6)
        expect(schedule.getTariffPeriod(firstOneThirty)?.schedule.name).toBe('Late-Night');
        expect(schedule.getTariffPeriod(secondOneThirty)?.schedule.name).toBe('Late-Night');
        // 02:30 CST is past the window.
        expect(schedule.getTariffPeriod(new Date('2026-11-01T08:30:00Z'))?.schedule.name).toBe('Rest');
    });

    it('spring-forward: instants adjacent to the skipped 02:xx hour resolve correctly', () => {
        const schedule = new Schedule(makeHourProbeTariff(), 'America/Chicago');
        // Mar 8 2026: clocks jump 02:00 CST → 03:00 CDT; local hour 2 never occurs.
        expect(schedule.getTariffPeriod(new Date('2026-03-08T07:30:00Z'))?.schedule.name).toBe('Late-Night'); // 01:30 CST
        expect(schedule.getTariffPeriod(new Date('2026-03-08T08:30:00Z'))?.schedule.name).toBe('Rest');       // 03:30 CDT
    });

    it('season boundary flips at site-local midnight, not UTC midnight', () => {
        const schedule = new Schedule(makeHarrisonTariff(), HARRISON_TIMEZONE);
        // Sun May 31 2026 23:00 CDT = Jun 1 04:00 UTC — locally still May 31 → Winter.
        const lateMay = schedule.getTariffPeriod(new Date('2026-06-01T04:00:00Z'));
        expect(lateMay?.season.name).toBe('Winter');
        // Mon Jun 1 2026 00:30 CDT = Jun 1 05:30 UTC — Summer, overnight Off-Peak.
        const earlyJune = schedule.getTariffPeriod(new Date('2026-06-01T05:30:00Z'));
        expect(earlyJune?.season.name).toBe('Summer');
        expect(earlyJune?.schedule.name).toBe('Off-Peak');
    });
});


