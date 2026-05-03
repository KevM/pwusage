import { describe, it, expect } from 'vitest';
import { parseTariffContent, buildDefaultTariff } from './tariff-parser';
import { TariffV2 } from '../tesla-client';

const SIMPLE_TARIFF: TariffV2 = {
    code: 'E1',
    name: 'E-1',
    utility: 'PG&E',
    energy_charges: {
        Summer: { rates: { Peak: 0.40, 'Off-Peak': 0.20 } },
    },
    seasons: {
        Summer: {
            fromMonth: 6, fromDay: 1, toMonth: 9, toDay: 30,
            tou_periods: {
                Peak: {
                    periods: [{
                        fromDayOfWeek: 0, toDayOfWeek: 4,
                        fromHour: 16, fromMinute: 0,
                        toHour: 21, toMinute: 0,
                    }],
                },
                'Off-Peak': {
                    periods: [{
                        fromDayOfWeek: 0, toDayOfWeek: 6,
                        fromHour: 0, fromMinute: 0,
                        toHour: 16, toMinute: 0,
                    }],
                },
            },
        },
    },
    sell_tariff: {
        name: 'NEM',
        utility: 'PG&E',
        energy_charges: {
            Summer: { rates: { Peak: 0.10, 'Off-Peak': 0.05 } },
        },
        seasons: {},
    },
};

describe('parseTariffContent', () => {
    it('uses utility field as tariff name', () => {
        const result = parseTariffContent(SIMPLE_TARIFF, 'My Site');
        expect(result.name).toBe('PG&E');
    });

    it('falls back to siteName when utility is missing', () => {
        const t = { ...SIMPLE_TARIFF, utility: undefined as unknown as string };
        expect(parseTariffContent(t, 'My Site').name).toBe('My Site');
    });

    it('parses season date range', () => {
        const result = parseTariffContent(SIMPLE_TARIFF, 'My Site');
        expect(result.seasons[0]).toMatchObject({
            from_month: 6, from_day: 1, to_month: 9, to_day: 30,
        });
    });

    it('assigns buy and sell rates to TOU schedules', () => {
        const result = parseTariffContent(SIMPLE_TARIFF, 'My Site');
        const peak = result.seasons[0].schedules.find(s => s.name === 'Peak');
        expect(peak?.buy_rate).toBe(0.40);
        expect(peak?.sell_rate).toBe(0.10);
    });

    it('maps TOU period time range to schedule fields', () => {
        const result = parseTariffContent(SIMPLE_TARIFF, 'My Site');
        const peak = result.seasons[0].schedules.find(s => s.name === 'Peak');
        expect(peak).toMatchObject({
            from_day_of_week: 0, to_day_of_week: 4,
            from_hour: 16, from_minute: 0,
            to_hour: 21, to_minute: 0,
        });
    });

    it('renames mislabeled Summer to Winter when fromMonth >= 10', () => {
        const t: TariffV2 = {
            ...SIMPLE_TARIFF,
            seasons: {
                Summer: { fromMonth: 10, fromDay: 1, toMonth: 3, toDay: 31, tou_periods: {} },
            },
        };
        expect(parseTariffContent(t, 'Site').seasons[0].name).toBe('Winter');
    });

    it('renames mislabeled Winter to Summer when fromMonth is May–Sep', () => {
        const t: TariffV2 = {
            ...SIMPLE_TARIFF,
            seasons: {
                Winter: { fromMonth: 6, fromDay: 1, toMonth: 9, toDay: 30, tou_periods: {} },
            },
        };
        expect(parseTariffContent(t, 'Site').seasons[0].name).toBe('Summer');
    });

    it('defaults buy/sell rates to 0 when energy_charges missing for season', () => {
        const t: TariffV2 = { ...SIMPLE_TARIFF, energy_charges: {} };
        const result = parseTariffContent(t, 'Site');
        result.seasons[0].schedules.forEach(s => {
            expect(s.buy_rate).toBe(0);
        });
    });

    it('skips tou_periods entries with no periods array', () => {
        const t: TariffV2 = {
            ...SIMPLE_TARIFF,
            seasons: {
                Summer: {
                    fromMonth: 6, fromDay: 1, toMonth: 9, toDay: 30,
                    tou_periods: {
                        Empty: { periods: null as unknown as [] },
                    },
                },
            },
        };
        expect(parseTariffContent(t, 'Site').seasons[0].schedules).toHaveLength(0);
    });
});

describe('buildDefaultTariff', () => {
    it('has one All Year season', () => {
        expect(buildDefaultTariff().seasons).toHaveLength(1);
        expect(buildDefaultTariff().seasons[0].name).toBe('All Year');
    });

    it('season covers Jan 1 – Dec 31', () => {
        const s = buildDefaultTariff().seasons[0];
        expect(s).toMatchObject({ from_month: 1, from_day: 1, to_month: 12, to_day: 31 });
    });

    it('has one Default schedule covering all days and hours', () => {
        const schedule = buildDefaultTariff().seasons[0].schedules[0];
        expect(schedule).toMatchObject({
            name: 'Default',
            from_day_of_week: 0, to_day_of_week: 6,
            from_hour: 0, to_hour: 24,
        });
    });

    it('uses provided name', () => {
        expect(buildDefaultTariff('My Custom Rate').name).toBe('My Custom Rate');
    });
});
