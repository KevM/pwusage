import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeslaClient } from './tesla-client';
import type { DayRecordStatus, EmptyDayState } from './prototypes/day-attribution';

const mocks = vi.hoisted(() => ({
    coverage: vi.fn(),
    insertEnergyDataBatch: vi.fn(),
    archiveHealedDays: vi.fn(),
    updateLastChecked: vi.fn(),
    updateUserStatus: vi.fn(),
}));
const TZ = 'America/Chicago';
const site = { id: 'site', timezone: TZ, installed: new Date('2025-01-01'), user_id: 'owner', tariffs: [{ id: 1, seasons: [] }] };
vi.mock('./site-repo', () => ({ SiteRepo: class { async getSite() { return site; } invalidateCache() {} } }));
vi.mock('./user-repo', () => ({ UserRepo: class { updateLastChecked = mocks.updateLastChecked; updateUserStatus = mocks.updateUserStatus; } }));
vi.mock('./energy-repo', () => ({ EnergyRepo: class {
    insertEnergyDataBatch = mocks.insertEnergyDataBatch;
    static getSiteMidnight = (d: Date, tz: string) => getSiteMidnightReal(d, tz);
} }));
vi.mock('./energy-repo-factory', () => ({
    createEnergyRepo: () => ({ getDailyCoverage: mocks.coverage }),
    compactDayWritesEnabled: () => process.env.COMPACT_DAY_WRITES_ENABLED === 'true',
}));
vi.mock('./import-lock', () => ({ withImportLock: async <T>(_r: unknown, _o: unknown, callback: () => Promise<T>) => ({ status: 'acquired', value: await callback() }) }));
vi.mock('./healed-day-archive', () => ({ archiveHealedDays: mocks.archiveHealedDays }));
vi.mock('./db', () => ({ pool: {} }));

import { getSiteMidnight as getSiteMidnightReal } from './date-utils';
import { Importer } from './importer';

// 2026-10-20 in Chicago (CDT): midnight is 05:00Z.
const day = new Date('2026-10-20T05:00:00Z');
const nextDay = new Date('2026-10-21T05:00:00Z');
const entries = (from: Date, count: number) => Array.from({ length: count }, (_, n) => ({
    timestamp: new Date(+from + n * 300000).toISOString(), total_home_usage: 100, solar_energy_exported: 0,
}));

function teslaClient(options: { soe?: 'fail' } = {}) {
    return {
        // Tesla returns the whole calendar day so far.
        getEnergyHistory: vi.fn(async (_id: string, start: Date) => entries(getSiteMidnightReal(start, TZ), 288)
            .filter(e => +new Date(e.timestamp) <= Date.now())),
        getSoeHistory: vi.fn(async () => {
            if (options.soe === 'fail') throw new Error('SOE unavailable');
            return [{ timestamp: day.toISOString(), percentage_charged: 50 }];
        }),
    };
}

function dayStore(state: { status: DayRecordStatus | null; fetchedAt: Date | null } | null = null, emptyDays: EmptyDayState[] = []) {
    return {
        writeDay: vi.fn(async () => ({ status: 'written' as const })),
        getDayRecordState: vi.fn(async () => state),
        getEmptyDays: vi.fn(async () => emptyDays),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    // One open day planned: 100 of 288 samples.
    mocks.coverage.mockResolvedValue([{ localDayKey: '2026-10-20', count: 100, first: day, last: new Date(+day + 99 * 300000), maxInteriorGapMs: 300000 }]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('range imports', () => {
    it('with day writes off, upserts raw rows and never writes day records', async () => {
        const store = dayStore();
        const importer = new Importer(teslaClient() as unknown as TeslaClient, store);
        await importer.ensureDataForRange('site', day, nextDay);
        expect(mocks.insertEnergyDataBatch).toHaveBeenCalled();
        expect(store.writeDay).not.toHaveBeenCalled();
    });

    it('with day writes on, writes one v2 day record per fetched day, replacing raw rows', async () => {
        vi.stubEnv('COMPACT_DAY_WRITES_ENABLED', 'true');
        const store = dayStore();
        const client = teslaClient();
        const result = await new Importer(client as unknown as TeslaClient, store)
            .ensureDataForRange('site', day, nextDay, undefined, { archiveHealedDays: true });
        expect(result).toMatchObject({ complete: true, processedWindows: 1, totalWindows: 1 });
        expect(store.writeDay).toHaveBeenCalledOnce();
        const [siteId, start, rows, fetchedAt, , options] = store.writeDay.mock.calls[0] as unknown as [string, Date, { timestamp: Date }[], Date, Date, unknown];
        expect([siteId, start, rows.length, options]).toEqual(['site', day, 288, { replaceRaw: true }]);
        expect(fetchedAt).toBeInstanceOf(Date);
        expect(mocks.insertEnergyDataBatch).not.toHaveBeenCalled();
        // No raw rows to archive: the day record is already the archive.
        expect(mocks.archiveHealedDays).not.toHaveBeenCalled();
    });

    it('with day writes on, serves a capped run\'s missing days before retrying open records', async () => {
        vi.stubEnv('COMPACT_DAY_WRITES_ENABLED', 'true');
        // The older day has no samples; the newer one is an open record with a sub-threshold gap.
        mocks.coverage.mockResolvedValue([{ localDayKey: '2026-10-21', count: 287, first: nextDay, last: new Date(+nextDay + 287 * 300000),
            maxInteriorGapMs: 600000, open: true }]);
        const store = dayStore();
        const result = await new Importer(teslaClient() as unknown as TeslaClient, store)
            .ensureDataForRange('site', day, new Date(+nextDay + 86400000), undefined, { maxWindows: 1 });
        expect(result).toMatchObject({ processedWindows: 1, totalWindows: 2 });
        expect((store.writeDay.mock.calls as unknown as [string, Date][]).map(c => c[1])).toEqual([day]);
    });

    it('never re-requests a day Tesla settled as empty, and looks empty days up only when a missing day is planned', async () => {
        vi.stubEnv('COMPACT_DAY_WRITES_ENABLED', 'true');
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
        // Two old days with nothing stored; Tesla answered the first with no samples long ago.
        const old = new Date('2026-09-01T05:00:00Z'), next = new Date('2026-09-02T05:00:00Z'), after = new Date('2026-09-03T05:00:00Z');
        mocks.coverage.mockResolvedValue([]);
        const store = dayStore(null, [{ dayStart: old, fetchedAt: new Date('2026-09-05T00:00:00Z'), settled: true }]);
        const result = await new Importer(teslaClient() as unknown as TeslaClient, store).ensureDataForRange('site', old, after);
        expect(result).toMatchObject({ totalWindows: 1, processedWindows: 1 });
        expect((store.writeDay.mock.calls as unknown as [string, Date][]).map(c => c[1])).toEqual([next]);
        expect(store.getEmptyDays).toHaveBeenCalledWith('site', old, after, expect.any(Date));
        // A forced refetch requests it anyway, without the lookup.
        const forced = dayStore(null, [{ dayStart: old, fetchedAt: new Date('2026-09-05T00:00:00Z'), settled: true }]);
        await new Importer(teslaClient() as unknown as TeslaClient, forced).ensureDataForRange('site', old, after, undefined, { force: true });
        expect(forced.writeDay).toHaveBeenCalledTimes(2);
        expect(forced.getEmptyDays).not.toHaveBeenCalled();
        // Only open-record retries planned: no empty record can be among them.
        mocks.coverage.mockResolvedValue([{ localDayKey: '2026-09-01', count: 287, first: old, last: new Date(+old + 287 * 300000),
            maxInteriorGapMs: 600000, open: true, fetchedAt: new Date('2026-09-02T06:00:00Z') }]);
        const retries = dayStore();
        await new Importer(teslaClient() as unknown as TeslaClient, retries).ensureDataForRange('site', old, next);
        expect(retries.getEmptyDays).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('with a window cap, rotates retries of recent empty days instead of retrying the newest ones every run', async () => {
        vi.stubEnv('COMPACT_DAY_WRITES_ENABLED', 'true');
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
        // Days 10-20..10-23 (Chicago) are recent empty records; 10-23 was checked most recently, 10-21 longest ago.
        const days = [0, 1, 2, 3].map(n => new Date(+day + n * 86400000));
        const checked = [3, 1, 2, 4].map(h => new Date(Date.UTC(2026, 9, 24, h)));
        mocks.coverage.mockResolvedValue([]);
        const store = dayStore(null, days.map((d, n) => ({ dayStart: d, fetchedAt: checked[n], settled: false })));
        await new Importer(teslaClient() as unknown as TeslaClient, store)
            .ensureDataForRange('site', day, new Date('2026-10-24T05:00:00Z'), undefined, { maxWindows: 3 });
        expect((store.writeDay.mock.calls as unknown as [string, Date][]).map(c => c[1])).toEqual([days[1], days[2], days[0]]);
        vi.useRealTimers();
    });

    it('with day writes on, leaves the stored day untouched when the SOE request fails', async () => {
        vi.stubEnv('COMPACT_DAY_WRITES_ENABLED', 'true');
        const store = dayStore();
        await expect(new Importer(teslaClient({ soe: 'fail' }) as unknown as TeslaClient, store)
            .ensureDataForRange('site', day, nextDay)).rejects.toThrow('SOE unavailable');
        expect(store.writeDay).not.toHaveBeenCalled();
        expect(mocks.insertEnergyDataBatch).not.toHaveBeenCalled();
    });

    it('with day writes on, counts a busy day record claim as a failed window', async () => {
        vi.stubEnv('COMPACT_DAY_WRITES_ENABLED', 'true');
        const store = dayStore();
        store.writeDay.mockResolvedValue({ status: 'busy' } as never);
        await expect(new Importer(teslaClient() as unknown as TeslaClient, store)
            .ensureDataForRange('site', day, nextDay)).rejects.toThrow(/busy/);
    });

    it('with day writes on, refetchDays writes each listed day as a record', async () => {
        vi.stubEnv('COMPACT_DAY_WRITES_ENABLED', 'true');
        const store = dayStore();
        const result = await new Importer(teslaClient() as unknown as TeslaClient, store)
            .refetchDays('site', [{ start: day, end: nextDay }], {});
        expect(result).toMatchObject({ complete: true, processedWindows: 1 });
        expect(store.writeDay).toHaveBeenCalledWith('site', day, expect.any(Array), expect.any(Date), expect.any(Date), { replaceRaw: true });
    });

    it('marks the owner revoked when Tesla rejects the token', async () => {
        vi.stubEnv('COMPACT_DAY_WRITES_ENABLED', 'true');
        const client = teslaClient();
        client.getEnergyHistory.mockRejectedValue(new Error('Tesla API Error: 401 unauthorized'));
        await expect(new Importer(client as unknown as TeslaClient, dayStore()).ensureDataForRange('site', day, nextDay)).rejects.toThrow();
        expect(mocks.updateUserStatus).toHaveBeenCalledWith('owner', 'revoked', false);
    });
});

describe('refreshTodayRecords', () => {
    // 10:00 CDT on 2026-10-21.
    const now = new Date('2026-10-21T15:00:00Z');
    const today = nextDay;
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); });
    afterEach(() => { vi.useRealTimers(); });

    const startsWritten = (store: ReturnType<typeof dayStore>) => (store.writeDay.mock.calls as unknown as [string, Date][]).map(c => c[1]);

    it('writes today\'s open record from the whole day so far', async () => {
        const store = dayStore({ status: 'complete', fetchedAt: new Date(+today + 3600000) });
        const client = teslaClient();
        const result = await new Importer(client as unknown as TeslaClient, store).refreshTodayRecords('site', new Date(+now - 600000));
        expect(startsWritten(store)).toEqual([today]);
        expect(store.writeDay).toHaveBeenCalledWith('site', today, expect.any(Array), expect.any(Date), expect.any(Date), { replaceRaw: true });
        // Tesla returns the whole calendar day; only samples up to now are kept.
        const rows = (store.writeDay.mock.calls[0] as unknown as [string, Date, { timestamp: Date }[]])[2];
        expect(rows.every(r => r.timestamp >= today && r.timestamp <= now)).toBe(true);
        expect(result.rows).toHaveLength(rows.length);
        expect(result.rowsPersisted).toBe(rows.length);
        expect(store.getDayRecordState).toHaveBeenCalledWith('site', day);
        expect(client.getSoeHistory).toHaveBeenCalled();
        expect(mocks.insertEnergyDataBatch).not.toHaveBeenCalled();
    });

    it('rewrites yesterday while its record is open and was fetched before its last sample was published', async () => {
        // Fetched at 23:50 local, before 23:55 was published.
        const store = dayStore({ status: 'open', fetchedAt: new Date(+today - 600000) });
        await new Importer(teslaClient() as unknown as TeslaClient, store).refreshTodayRecords('site', new Date(+today - 600000));
        expect(startsWritten(store)).toEqual([day, today]);
    });

    it('leaves an open yesterday to gap-heal once a fetch after the day ended has answered', async () => {
        const store = dayStore({ status: 'open', fetchedAt: new Date(+today + 120000) });
        await new Importer(teslaClient() as unknown as TeslaClient, store).refreshTodayRecords('site', new Date(+now - 600000));
        expect(startsWritten(store)).toEqual([today]);
    });

    it('writes yesterday without a record only when its stored tail is missing', async () => {
        const store = dayStore(null);
        await new Importer(teslaClient() as unknown as TeslaClient, store).refreshTodayRecords('site', new Date(+today - 3600000));
        expect(startsWritten(store)).toEqual([day, today]);
        const caughtUp = dayStore(null);
        await new Importer(teslaClient() as unknown as TeslaClient, caughtUp).refreshTodayRecords('site', new Date(+today - 300000));
        expect(startsWritten(caughtUp)).toEqual([today]);
    });

    it('writes nothing when the SOE request fails', async () => {
        const store = dayStore({ status: 'open', fetchedAt: null });
        await expect(new Importer(teslaClient({ soe: 'fail' }) as unknown as TeslaClient, store)
            .refreshTodayRecords('site', new Date(+today - 600000))).rejects.toThrow('SOE unavailable');
        expect(store.writeDay).not.toHaveBeenCalled();
    });

    it('counts only rows of days actually written', async () => {
        const store = dayStore({ status: 'complete', fetchedAt: null });
        store.writeDay.mockResolvedValue({ status: 'superseded' } as never);
        const result = await new Importer(teslaClient() as unknown as TeslaClient, store).refreshTodayRecords('site', null);
        expect(result.rowsPersisted).toBe(0);
    });
});
