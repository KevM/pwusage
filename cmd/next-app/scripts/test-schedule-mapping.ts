
import { Schedule } from '../src/lib/schedule';
import { Tariff, TariffSeason, TariffSchedule } from '../src/lib/db';

function runTest() {
    console.log('Running Tariff Schedule Mapping Test...');

    // 1. Setup Mock Data
    // Scenario: 
    // - Mon-Fri (0-4): 
    //   - 00:00 - 08:00: Off-Peak
    //   - 08:00 - 20:00: On-Peak
    //   - 20:00 - 24:00: Off-Peak
    // - Sat-Sun (5-6):
    //   - All Day: Off-Peak

    const mockSchedules: TariffSchedule[] = [
        {
            id: 1,
            season_id: 1,
            name: 'Off-Peak Weekday Morning',
            buy_rate: 0.11,
            sell_rate: 0.03,
            from_day_of_week: 0, // Mon
            to_day_of_week: 4,   // Fri
            from_hour: 0,
            to_hour: 8,
            from_minute: 0,
            to_minute: 0,
            from_minute: null,
            to_minute: null
        },
        {
            id: 2,
            season_id: 1,
            name: 'On-Peak Weekday',
            buy_rate: 0.23,
            sell_rate: 0.04,
            from_day_of_week: 0, // Mon
            to_day_of_week: 4,   // Fri
            from_hour: 8,
            to_hour: 20,
            from_minute: 0,
            to_minute: 0,
            from_minute: null,
            to_minute: null
        },
        {
            id: 3,
            season_id: 1,
            name: 'Off-Peak Weekday Night',
            buy_rate: 0.11,
            sell_rate: 0.03,
            from_day_of_week: 0, // Mon
            to_day_of_week: 4,   // Fri
            from_hour: 20,
            to_hour: 24,
            from_minute: 0,
            to_minute: 0,
            from_minute: null,
            to_minute: null
        },
        {
            id: 4,
            season_id: 1,
            name: 'Off-Peak Weekend',
            buy_rate: 0.11,
            sell_rate: 0.03,
            from_day_of_week: 5, // Sat
            to_day_of_week: 6,   // Sun
            from_hour: 0,
            to_hour: 24,
            from_minute: 0,
            to_minute: 0,
            from_minute: null,
            to_minute: null
        }
    ];

    const mockSeason: TariffSeason = {
        id: 1,
        tariff_id: 1,
        name: 'All Year',
        from_month: 1,
        from_day: 1,
        to_month: 12,
        to_day: 31,
        buy_rate: 0,
        sell_rate: 0,
        schedules: mockSchedules
    };

    const mockTariff: Tariff = {
        id: 1,
        site_id: 'test-site',
        name: 'Test Tariff',
        updated: new Date().toISOString(),
        seasons: [mockSeason]
    };

    const schedule = new Schedule([mockTariff]);

    // 2. Define Test Cases
    const testCases = [
        {
            desc: 'Monday 07:00 (Weekday Morning)',
            date: new Date('2023-11-20T07:00:00'), // Nov 20 2023 is a Monday
            expected: 'Off-Peak Weekday Morning'
        },
        {
            desc: 'Monday 10:00 (Weekday Day)',
            date: new Date('2023-11-20T10:00:00'),
            expected: 'On-Peak Weekday'
        },
        {
            desc: 'Monday 22:00 (Weekday Night)',
            date: new Date('2023-11-20T22:00:00'),
            expected: 'Off-Peak Weekday Night'
        },
        {
            desc: 'Saturday 12:00 (Weekend)',
            date: new Date('2023-11-25T12:00:00'), // Nov 25 2023 is a Saturday
            expected: 'Off-Peak Weekend'
        },
        {
            desc: 'Sunday 23:59 (Weekend)',
            date: new Date('2023-11-26T23:59:00'), // Nov 26 2023 is a Sunday
            expected: 'Off-Peak Weekend'
        },
        {
            desc: 'Friday 19:59 (Weekday Day - Edge)',
            date: new Date('2023-11-24T19:59:00'), // Nov 24 2023 is a Friday
            expected: 'On-Peak Weekday'
        },
        {
            desc: 'Friday 20:00 (Weekday Night - Edge)',
            date: new Date('2023-11-24T20:00:00'),
            expected: 'Off-Peak Weekday Night'
        }
    ];

    // 3. Run Tests
    let passed = 0;
    let failed = 0;

    for (const tc of testCases) {
        const result = schedule.getTariffPeriod(tc.date);
        const actual = result?.schedule.name;

        if (actual === tc.expected) {
            console.log(`[PASS] ${tc.desc}`);
            passed++;
        } else {
            console.error(`[FAIL] ${tc.desc}`);
            console.error(`   Expected: ${tc.expected}`);
            console.error(`   Actual:   ${actual}`);
            console.error(`   Date:     ${tc.date.toString()}`);
            failed++;
        }
    }

    console.log('---------------------------------------------------');
    console.log(`Total: ${testCases.length}, Passed: ${passed}, Failed: ${failed}`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTest();
