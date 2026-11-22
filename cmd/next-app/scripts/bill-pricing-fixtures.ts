import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    buildBillPricingFixture,
    type BillPricingFixtureCaseDef,
    type BillPricingFixtureDayDef,
} from '../src/lib/bill-pricing-fixtures';
import type { TariffSeasonInput, TimePeriodWindowInput } from '../src/lib/tariff-contract';

const FIXTURES_DIR = path.resolve(
    __dirname,
    '../../ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/Fixtures/BillPricing'
);

function dateRange(fromYmd: string, toYmd: string): string[] {
    const [sy, sm, sd] = fromYmd.split('-').map(Number);
    const [ey, em, ed] = toYmd.split('-').map(Number);
    const start = Date.UTC(sy, sm - 1, sd);
    const end = Date.UTC(ey, em - 1, ed);
    const out: string[] = [];
    for (let ms = start; ms <= end; ms += 86_400_000) {
        const dt = new Date(ms);
        const y = dt.getUTCFullYear();
        const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
        const d = String(dt.getUTCDate()).padStart(2, '0');
        out.push(`${y}-${m}-${d}`);
    }
    return out;
}

function makeTouSeason(
    name: string,
    fromMonth: number,
    toMonth: number,
    peakBuy: number,
    peakSell: number,
    offPeakBuy: number,
    offPeakSell: number,
    bounds?: { fromDay?: number; toDay?: number }
): TariffSeasonInput {
    const weekdayPeriods: TimePeriodWindowInput[] = [
        { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 16, toMinute: 0, buyRate: offPeakBuy, sellRate: offPeakSell },
        { touName: 'ON_PEAK', fromHour: 16, fromMinute: 0, toHour: 21, toMinute: 0, buyRate: peakBuy, sellRate: peakSell },
        { touName: 'OFF_PEAK', fromHour: 21, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: offPeakBuy, sellRate: offPeakSell },
    ];
    const weekendPeriods: TimePeriodWindowInput[] = [
        { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: offPeakBuy, sellRate: offPeakSell },
    ];
    return {
        name,
        fromMonth,
        toMonth,
        ...(bounds?.fromDay !== undefined ? { fromDay: bounds.fromDay } : {}),
        ...(bounds?.toDay !== undefined ? { toDay: bounds.toDay } : {}),
        weekdayPeriods,
        weekendPeriods,
    };
}

/**
 * Deterministic 5-minute Wh profile: midday solar export (slots 120..191, i.e. 10:00-16:00),
 * evening peak import (slots 192..251, i.e. 16:00-21:00), light overnight load.
 */
function standardDaySlots(slotIndex: number, dayIndex: number): { solarWh: number; loadWh: number; gridWh: number } {
    if (slotIndex >= 120 && slotIndex < 192) {
        const solarWh = 400 + (dayIndex % 3) * 20;
        const loadWh = 120;
        return { solarWh, loadWh, gridWh: loadWh - solarWh }; // net export (-280..-240 Wh)
    }
    if (slotIndex >= 192 && slotIndex < 252) {
        const solarWh = 20;
        const loadWh = 320 + (dayIndex % 2) * 30;
        return { solarWh, loadWh, gridWh: loadWh - solarWh }; // net import (+300..+330 Wh)
    }
    const solarWh = 0;
    const loadWh = 80;
    return { solarWh, loadWh, gridWh: loadWh };
}

function makeDays(fromYmd: string, toYmd: string, slotValue = standardDaySlots): BillPricingFixtureDayDef[] {
    return dateRange(fromYmd, toYmd).map(day => ({ day, slotValue }));
}

export const BILL_PRICING_FIXTURE_CASES: BillPricingFixtureCaseDef[] = [
    {
        name: 'single-plan-cycle',
        now: '2026-06-10T18:00:00.000Z',
        billingDay: 1,
        tariffs: [
            {
                periodId: 1,
                tariffId: 101,
                name: 'Xcel TOU',
                source: 'tesla',
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
                seasons: [makeTouSeason('Summer', 1, 12, 0.32, 0.05, 0.11, 0.04)],
            },
        ],
        days: makeDays('2026-06-01', '2026-06-10'),
    },
    {
        name: 'plan-change-mid-cycle',
        now: '2026-06-15T18:00:00.000Z',
        billingDay: 1,
        tariffs: [
            {
                periodId: 1,
                tariffId: 201,
                name: 'Xcel TOU',
                version: 1,
                source: 'tesla',
                effectiveFrom: '2026-01-01',
                effectiveTo: '2026-06-09',
                seasons: [makeTouSeason('Summer', 1, 12, 0.30, 0.05, 0.10, 0.04)],
            },
            {
                periodId: 2,
                tariffId: 202,
                name: 'Xcel TOU',
                version: 2,
                source: 'manual',
                effectiveFrom: '2026-06-10',
                effectiveTo: null,
                seasons: [makeTouSeason('Summer', 1, 12, 0.42, 0.08, 0.14, 0.06)],
            },
        ],
        days: makeDays('2026-06-01', '2026-06-15'),
    },
    {
        name: 'dst-spring-forward',
        now: '2026-03-09T18:00:00.000Z',
        billingDay: 1,
        tariffs: [
            {
                periodId: 1,
                tariffId: 301,
                name: 'Mountain TOU',
                source: 'tesla',
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
                seasons: [makeTouSeason('All Year', 1, 12, 0.28, 0.05, 0.10, 0.04)],
            },
        ],
        days: makeDays('2026-03-07', '2026-03-09'),
    },
    {
        name: 'dst-fall-back',
        now: '2026-11-02T18:00:00.000Z',
        billingDay: 1,
        tariffs: [
            {
                periodId: 1,
                tariffId: 401,
                name: 'Mountain TOU',
                source: 'tesla',
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
                seasons: [makeTouSeason('All Year', 1, 12, 0.28, 0.05, 0.10, 0.04)],
            },
        ],
        days: makeDays('2026-11-01', '2026-11-02'),
    },
    {
        name: 'holiday-weekday',
        now: '2024-07-06T18:00:00.000Z',
        billingDay: 1,
        tariffs: [
            {
                periodId: 1,
                tariffId: 501,
                name: 'Holiday TOU',
                source: 'tesla',
                effectiveFrom: '2024-01-01',
                effectiveTo: null,
                seasons: [makeTouSeason('Summer', 1, 12, 0.40, 0.06, 0.10, 0.04)],
            },
        ],
        days: makeDays('2024-07-01', '2024-07-06'),
    },
    {
        name: 'season-boundary-mid-month',
        now: '2026-06-20T18:00:00.000Z',
        billingDay: 1,
        tariffs: [
            {
                periodId: 1,
                tariffId: 601,
                name: 'Seasonal TOU',
                source: 'tesla',
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
                seasons: [
                    makeTouSeason('Winter', 9, 6, 0.22, 0.04, 0.09, 0.03, { fromDay: 15, toDay: 14 }),
                    makeTouSeason('Summer', 6, 9, 0.38, 0.07, 0.13, 0.05, { fromDay: 15, toDay: 14 }),
                ],
            },
        ],
        days: makeDays('2026-06-10', '2026-06-20'),
    },
    {
        name: 'gapped-day',
        now: '2026-06-05T18:00:00.000Z',
        billingDay: 1,
        tariffs: [
            {
                periodId: 1,
                tariffId: 701,
                name: 'Xcel TOU',
                source: 'tesla',
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
                seasons: [makeTouSeason('Summer', 1, 12, 0.32, 0.05, 0.11, 0.04)],
            },
        ],
        // 2026-06-03 is omitted (missing day); 2026-06-02 has nil slots 10..15.
        days: [
            { day: '2026-06-01', slotValue: standardDaySlots },
            {
                day: '2026-06-02',
                slotValue: (slotIndex, dayIndex) =>
                    slotIndex >= 10 && slotIndex <= 15 ? null : standardDaySlots(slotIndex, dayIndex),
            },
            { day: '2026-06-04', slotValue: standardDaySlots },
            { day: '2026-06-05', slotValue: standardDaySlots },
        ],
    },
    {
        name: 'uncovered-window',
        now: '2026-06-03T18:00:00.000Z',
        billingDay: 1,
        tariffs: [
            {
                periodId: 1,
                tariffId: 801,
                name: 'Gapped Window Plan',
                source: 'tesla',
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
                seasons: [
                    {
                        name: 'All Year',
                        fromMonth: 1,
                        toMonth: 12,
                        weekdayPeriods: [
                            { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 13, toMinute: 0, buyRate: 0.11, sellRate: 0.04 },
                            { touName: 'ON_PEAK', fromHour: 14, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.32, sellRate: 0.05 },
                        ],
                        weekendPeriods: [
                            { touName: 'OFF_PEAK', fromHour: 0, fromMinute: 0, toHour: 13, toMinute: 0, buyRate: 0.11, sellRate: 0.04 },
                            { touName: 'ON_PEAK', fromHour: 14, fromMinute: 0, toHour: 24, toMinute: 0, buyRate: 0.32, sellRate: 0.05 },
                        ],
                    },
                ],
            },
        ],
        days: makeDays('2026-06-01', '2026-06-03'),
    },
    {
        name: 'billing-day-31-february',
        now: '2026-02-15T18:00:00.000Z',
        billingDay: 31,
        tariffs: [
            {
                periodId: 1,
                tariffId: 901,
                name: 'Winter TOU',
                source: 'tesla',
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
                seasons: [makeTouSeason('Winter', 1, 12, 0.26, 0.05, 0.10, 0.04)],
            },
        ],
        days: makeDays('2026-01-31', '2026-02-15'),
    },
    {
        name: 'no-plan',
        now: '2026-06-03T18:00:00.000Z',
        billingDay: 1,
        tariffs: [],
        days: makeDays('2026-06-01', '2026-06-03'),
    },
];

export function writeBillPricingFixtures(): void {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    for (const def of BILL_PRICING_FIXTURE_CASES) {
        const fixture = buildBillPricingFixture(def);
        const outPath = path.join(FIXTURES_DIR, `${def.name}.json`);
        writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
        console.log(`wrote ${path.relative(process.cwd(), outPath)}`);
    }
}

const isMain = process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
    writeBillPricingFixtures();
}
