import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteHistoryTable, siteHistoryStatus, type SiteHistoryRow } from './SiteHistoryTable';

const base: SiteHistoryRow = {
    id: '2252268092126997',
    name: 'Harrison',
    timezone: 'America/Chicago',
    installed: new Date('2023-11-14T17:09:47Z'),
    owner_email: 'owner@example.com',
    history_backfill_from: null,
    history_migrated_at: null,
    archived_days: 0,
    first_archived_day: null,
    last_archived_day: null,
    last_energy_at: null,
};

describe('siteHistoryStatus', () => {
    it('is migrated once the script stamped the site', () => {
        expect(siteHistoryStatus({ ...base, history_migrated_at: new Date('2026-10-19T20:00:00Z'), archived_days: 1055 }))
            .toEqual({ status: 'complete', label: 'Migrated' });
    });

    it('is partial when archives exist without a completed migration', () => {
        expect(siteHistoryStatus({ ...base, archived_days: 12 })).toEqual({ status: 'pending', label: 'Partial' });
    });

    it('is not migrated with no archives', () => {
        expect(siteHistoryStatus(base)).toEqual({ status: 'default', label: 'Not migrated' });
    });
});

describe('SiteHistoryTable', () => {
    it('shows the site ID, a copyable migrate command, and archive coverage in the site timezone', () => {
        const html = renderToStaticMarkup(<SiteHistoryTable sites={[{
            ...base,
            history_migrated_at: new Date('2026-10-19T20:00:00Z'),
            history_backfill_from: new Date('2023-11-29T06:00:00Z'),
            archived_days: 1055,
            first_archived_day: new Date('2023-11-14T06:00:00Z'),
            last_archived_day: new Date('2026-10-16T05:00:00Z'),
        }]} />);

        expect(html).toContain('2252268092126997');
        expect(html).toContain('npx tsx scripts/migrate-site-history.ts --site-id 2252268092126997');
        expect(html).toContain('Migrated');
        expect(html).toContain('1,055 days');
        expect(html).toContain('2023-11-14 → 2026-10-16');
        expect(html).toContain('Data from 2023-11-29');
        expect(html).toContain('owner@example.com');
    });

    it('accepts dates serialized as strings', () => {
        const html = renderToStaticMarkup(<SiteHistoryTable sites={[{
            ...base,
            installed: '2023-11-14T17:09:47.000Z',
            archived_days: 3,
            first_archived_day: '2026-10-01T05:00:00.000Z',
            last_archived_day: '2026-10-03T05:00:00.000Z',
        }]} />);

        expect(html).toContain('Installed 2023-11-14');
        expect(html).toContain('2026-10-01 → 2026-10-03');
        expect(html).toContain('Partial');
    });

    it('shows the latest energy sample date, or that the site has none', () => {
        const html = renderToStaticMarkup(<SiteHistoryTable sites={[
            { ...base, last_energy_at: '2026-10-19T04:30:00.000Z' },
            { ...base, id: 'site-2', last_energy_at: null },
        ]} />);

        expect(html).toContain('Last data 2026-10-18');
        expect(html).toContain('No energy data');
    });
});
