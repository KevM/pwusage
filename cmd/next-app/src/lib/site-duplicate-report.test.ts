import { describe, expect, it } from 'vitest';
import { reportSiteDuplicate, type ReportQueryable } from './site-duplicate-report';

function fakeDb(handlers: Record<string, Record<string, unknown>[]>): ReportQueryable {
    return {
        async query(sql: string) {
            const key = Object.keys(handlers).find(k => sql.includes(k));
            if (!key) throw new Error(`unexpected query: ${sql}`);
            return { rows: handlers[key] };
        },
    } as ReportQueryable;
}

describe('reportSiteDuplicate', () => {
    it('summarises the secondary against the primary and recommends dropping when every day is identical', async () => {
        const db = fakeDb({
            'FROM "Site" WHERE id = ANY': [
                { id: 'P', timezone: 'America/Los_Angeles', tesla_hardware_id: 'HW' },
                { id: 'S', timezone: 'America/Los_Angeles', tesla_hardware_id: 'HW' },
            ],
            '-- day-totals': [
                { site_id: 'P', days: '45', first_day: '2026-09-25', last_day: '2026-11-08' },
                { site_id: 'S', days: '10', first_day: '2026-10-20', last_day: '2026-10-29' },
            ],
            '-- day-overlap': [{ identical: '10', differing: '0', only_secondary: '0' }],
            '-- other-rows': [{ summaries: '30', trmnl: '0', tags: '0' }],
            '-- day-quality': [{ primary_better: '10', equal: '0', secondary_better: '0' }],
            '-- better-days': [],
        });

        const report = await reportSiteDuplicate(db, 'P', 'S');

        expect(report.sameHome).toBe(true);
        expect(report.primary.days).toBe(45);
        expect(report.secondary).toMatchObject({ days: 10, summaries: 30, trmnl: 0, tags: 0 });
        expect(report.overlap).toEqual({ identical: 10, differing: 0, onlySecondary: 0 });
        expect(report.verdict).toBe('secondary-days-are-duplicates');
    });

    it('flags days that exist only on the secondary', async () => {
        const db = fakeDb({
            'FROM "Site" WHERE id = ANY': [
                { id: 'P', timezone: 'UTC', tesla_hardware_id: 'HW' },
                { id: 'S', timezone: 'UTC', tesla_hardware_id: 'HW' },
            ],
            '-- day-totals': [
                { site_id: 'P', days: '45', first_day: '2026-09-25', last_day: '2026-11-08' },
                { site_id: 'S', days: '3', first_day: '2026-08-01', last_day: '2026-08-03' },
            ],
            '-- day-overlap': [{ identical: '0', differing: '0', only_secondary: '3' }],
            '-- other-rows': [{ summaries: '3', trmnl: '1', tags: '2' }],
            '-- day-quality': [{ primary_better: '0', equal: '0', secondary_better: '0' }],
            '-- better-days': [],
        });

        const report = await reportSiteDuplicate(db, 'P', 'S');

        expect(report.overlap.onlySecondary).toBe(3);
        expect(report.verdict).toBe('secondary-has-unique-data');
    });

    it('drops the secondary when its days differ only byte-wise but the primary is at least as complete', async () => {
        const db = fakeDb({
            'FROM "Site" WHERE id = ANY': [
                { id: 'P', timezone: 'UTC', tesla_hardware_id: 'HW' },
                { id: 'S', timezone: 'UTC', tesla_hardware_id: 'HW' },
            ],
            '-- day-totals': [
                { site_id: 'P', days: '45', first_day: '2026-09-25', last_day: '2026-11-08' },
                { site_id: 'S', days: '4', first_day: '2026-10-01', last_day: '2026-10-04' },
            ],
            '-- day-overlap': [{ identical: '0', differing: '4', only_secondary: '0' }],
            '-- day-quality': [{ primary_better: '1', equal: '3', secondary_better: '0' }],
            '-- better-days': [],
            '-- other-rows': [{ summaries: '4', trmnl: '0', tags: '0' }],
        });

        const report = await reportSiteDuplicate(db, 'P', 'S');
        expect(report.quality).toEqual({ primaryBetter: 1, equal: 3, secondaryBetter: 0, secondaryBetterDays: [] });
        expect(report.verdict).toBe('secondary-days-are-duplicates');
    });

    it('lists the days where the secondary is more complete than the primary', async () => {
        const db = fakeDb({
            'FROM "Site" WHERE id = ANY': [
                { id: 'P', timezone: 'UTC', tesla_hardware_id: 'HW' },
                { id: 'S', timezone: 'UTC', tesla_hardware_id: 'HW' },
            ],
            '-- day-totals': [
                { site_id: 'P', days: '45', first_day: '2026-09-25', last_day: '2026-11-08' },
                { site_id: 'S', days: '4', first_day: '2026-10-01', last_day: '2026-10-04' },
            ],
            '-- day-overlap': [{ identical: '0', differing: '4', only_secondary: '0' }],
            '-- day-quality': [{ primary_better: '0', equal: '3', secondary_better: '1' }],
            '-- better-days': [{ day_start: '2026-10-02 05:00:00+00' }],
            '-- other-rows': [{ summaries: '4', trmnl: '0', tags: '0' }],
        });

        const report = await reportSiteDuplicate(db, 'P', 'S');
        expect(report.quality.secondaryBetterDays).toEqual(['2026-10-02 05:00:00+00']);
        expect(report.verdict).toBe('secondary-has-better-days');
    });

    it('refuses to compare sites that are not the same home', async () => {
        const db = fakeDb({
            'FROM "Site" WHERE id = ANY': [
                { id: 'P', timezone: 'UTC', tesla_hardware_id: 'HW1' },
                { id: 'S', timezone: 'UTC', tesla_hardware_id: 'HW2' },
            ],
            '-- day-totals': [],
            '-- day-overlap': [{ identical: '0', differing: '0', only_secondary: '0' }],
            '-- other-rows': [{ summaries: '0', trmnl: '0', tags: '0' }],
            '-- day-quality': [{ primary_better: '0', equal: '0', secondary_better: '0' }],
            '-- better-days': [],
        });

        const report = await reportSiteDuplicate(db, 'P', 'S');
        expect(report.sameHome).toBe(false);
        expect(report.verdict).toBe('not-the-same-home');
    });

    it('throws when a site is missing', async () => {
        const db = fakeDb({ 'FROM "Site" WHERE id = ANY': [{ id: 'P', timezone: 'UTC', tesla_hardware_id: 'HW' }] });
        await expect(reportSiteDuplicate(db, 'P', 'S')).rejects.toThrow(/not found/);
    });
});
