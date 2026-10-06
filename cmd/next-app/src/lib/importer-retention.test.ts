import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteWithTariffs } from './db';
import { Importer } from './importer';
import type { TeslaClient } from './tesla-client';

const mocks = vi.hoisted(() => ({ site: vi.fn(), policy: vi.fn(), coverage: vi.fn(), insert: vi.fn(), energy: vi.fn(), soe: vi.fn(), lock: vi.fn(), release: vi.fn() }));
vi.mock('./site-repo', () => ({ SiteRepo: class { getSite = mocks.site; acquireImportLock = mocks.lock; releaseImportLock = mocks.release; } }));
vi.mock('./user-repo', () => ({ UserRepo: class { getHistoryRetention = mocks.policy; updateLastChecked = vi.fn(); } }));
vi.mock('./energy-repo', () => ({ EnergyRepo: class { getDailyCoverage = mocks.coverage; insertEnergyDataBatch = mocks.insert; } }));
vi.mock('./tariff-repo', () => ({ TariffRepo: class {} }));
const policy = { history_retention_days: 90, history_retention_grace_until: null, history_retention_transition_pending: false };
const site: SiteWithTariffs = { id: 's1', user_id: 'u1', name: 'Test', timezone: 'America/Chicago', installed: new Date('2025-01-01'), updated: new Date('2026-01-01'), billing_start_day: 1, json: null, tariffs: [{ id: 1, site_id: 's1', updated: new Date('2025-01-01'), name: 'Old tariff', seasons: [] }] };
const cutoff = new Date('2026-07-03T05:00:00Z');
function importer() { return new Importer({ getEnergyHistory: mocks.energy, getSoeHistory: mocks.soe } as unknown as TeslaClient); }

describe('Importer retention enforcement', () => {
    beforeEach(() => {
        vi.useFakeTimers(); vi.setSystemTime('2026-10-01T18:00:00Z');
        vi.clearAllMocks();
        mocks.site.mockResolvedValue(site); mocks.policy.mockResolvedValue(policy);
        mocks.coverage.mockResolvedValue([]); mocks.energy.mockResolvedValue([]); mocks.soe.mockResolvedValue([]);
        mocks.lock.mockResolvedValue(true); mocks.release.mockResolvedValue(true); mocks.insert.mockResolvedValue(0);
    });
    afterEach(() => vi.useRealTimers());
    it('terminates expired forced requests before locks, coverage, or Tesla calls', async () => {
        const result = await importer().ensureDataForRange('s1', new Date('2026-06-01'), cutoff, undefined, { force: true });
        expect(result).toMatchObject({ complete: true, totalWindows: 0, historyAvailability: { status: 'unavailable', availableFrom: cutoff.toISOString() } });
        expect(mocks.lock).not.toHaveBeenCalled(); expect(mocks.coverage).not.toHaveBeenCalled(); expect(mocks.energy).not.toHaveBeenCalled(); expect(mocks.soe).not.toHaveBeenCalled();
    });
    it('clamps coverage and import planning to the identical local midnight', async () => {
        const instance = importer(); const importSpy = vi.spyOn(instance, 'importRange').mockResolvedValue([]);
        const end = new Date('2026-07-04T05:00:00Z');
        const result = await instance.ensureDataForRange('s1', new Date('2026-07-01'), end);
        expect(mocks.coverage).toHaveBeenCalledExactlyOnceWith('s1', cutoff, end, site.timezone);
        expect(importSpy).toHaveBeenCalledExactlyOnceWith('s1', cutoff, end, 'day');
        expect(result.historyAvailability?.status).toBe('partial');
    });
    it('clamps auditRange before the per-day query and excludes expired days', async () => {
        const result = await importer().auditRange('s1', new Date('2026-07-01'), new Date('2026-07-04T05:00:00Z'));
        expect(mocks.coverage).toHaveBeenCalledExactlyOnceWith('s1', cutoff, new Date('2026-07-04T05:00:00Z'), site.timezone);
        expect(result).toHaveLength(1);
    });
    it('never repairs empty expired days on repeated requests', async () => {
        for (let i = 0; i < 15; i++) await importer().ensureDataForRange('s1', new Date('2026-06-01'), cutoff);
        expect(mocks.coverage).not.toHaveBeenCalled(); expect(mocks.energy).not.toHaveBeenCalled();
        expect(mocks.policy).toHaveBeenCalledTimes(15);
    });
    it('evaluates grace with a fresh clock on later requests', async () => {
        const expiry = new Date('2026-10-02T18:00:00Z');
        mocks.policy.mockResolvedValue({ ...policy, history_retention_grace_until: expiry });
        const instance = importer();
        await instance.auditRange('s1', new Date('2026-06-01'), new Date('2026-06-02'));
        vi.setSystemTime(expiry);
        expect(await instance.auditRange('s1', new Date('2026-06-01'), new Date('2026-06-02'))).toEqual([]);
        expect(mocks.coverage).toHaveBeenCalledTimes(1);
    });
    it.each(['forced ensureDataForRange', 'importRange', 'fetchRange'] as const)('stops expired daily chunks after an entitlement downgrade during %s', async (operation) => {
        mocks.policy.mockResolvedValue({ ...policy, history_retention_days: 365 });
        mocks.energy.mockImplementation(async () => {
            mocks.policy.mockResolvedValue(policy);
            return [{ timestamp: '2026-06-01T05:05:00Z', consumer_energy_imported_from_grid: 100 }];
        });
        const instance = importer();
        const start = new Date('2026-06-01T05:00:00Z');
        const end = new Date('2026-06-04T05:00:00Z');
        const result = operation === 'forced ensureDataForRange'
            ? (await instance.ensureDataForRange('s1', start, end, undefined, { force: true })).rows
            : operation === 'importRange'
                ? await instance.importRange('s1', start, end)
                : await instance.fetchRange(site, start, end);
        expect(result).toEqual([]);
        expect(mocks.energy).toHaveBeenCalledTimes(1);
        expect(mocks.soe).toHaveBeenCalledTimes(1);
        expect(mocks.insert.mock.calls.flatMap(([rows]) => rows)).toEqual([]);
    });
    it('drops rows if grace expires while Tesla is responding', async () => {
        const expiry = new Date('2026-10-01T18:00:01Z');
        mocks.policy.mockResolvedValue({ ...policy, history_retention_grace_until: expiry });
        mocks.energy.mockImplementation(async () => {
            vi.setSystemTime(expiry);
            return [{ timestamp: '2026-06-01T05:05:00Z', total_home_usage: 100 }];
        });
        const rows = await importer().importRange('s1', new Date('2026-06-01T05:00:00Z'), new Date('2026-06-02T05:00:00Z'));
        expect(rows).toEqual([]);
        expect(mocks.insert.mock.calls[0][0]).toEqual([]);
    });
    it('stops later expired chunks when grace ends during a multi-day import', async () => {
        const expiry = new Date('2026-10-01T18:00:01Z');
        mocks.policy.mockResolvedValue({ ...policy, history_retention_grace_until: expiry });
        mocks.energy.mockImplementation(async () => { vi.setSystemTime(expiry); return []; });
        await importer().importRange('s1', new Date('2026-06-01T05:00:00Z'), new Date('2026-06-03T05:00:00Z'));
        expect(mocks.energy).toHaveBeenCalledTimes(1);
    });
    it('filters direct read-only fetch results again when grace expires', async () => {
        const expiry = new Date('2026-10-01T18:00:01Z');
        mocks.policy.mockResolvedValue({ ...policy, history_retention_grace_until: expiry });
        mocks.energy.mockImplementation(async () => { vi.setSystemTime(expiry); return [{ timestamp: '2026-06-01T05:05:00Z' }]; });
        expect(await importer().fetchRange(site, new Date('2026-06-01T05:00:00Z'), new Date('2026-06-03T05:00:00Z'))).toEqual([]);
        expect(mocks.energy).toHaveBeenCalledTimes(1);
    });
    it('splits direct fetches on 23/25-hour local days', async () => {
        mocks.policy.mockResolvedValue({ ...policy, history_retention_days: 365 });
        const instance = importer();
        await instance.fetchRange(site, new Date('2026-03-08T06:00:00Z'), new Date('2026-03-09T05:00:00Z'));
        expect(mocks.energy).toHaveBeenCalledExactlyOnceWith('s1', new Date('2026-03-08T06:00:00Z'), new Date('2026-03-09T05:00:00Z'), 'day', site.timezone);
        mocks.energy.mockClear();
        await instance.fetchRange(site, new Date('2026-11-01T05:00:00Z'), new Date('2026-11-02T06:00:00Z'));
        expect(mocks.energy).toHaveBeenCalledExactlyOnceWith('s1', new Date('2026-11-01T05:00:00Z'), new Date('2026-11-02T06:00:00Z'), 'day', site.timezone);
    });
    it('allows extended history within 365 days', async () => {
        mocks.policy.mockResolvedValue({ ...policy, history_retention_days: 365 });
        await importer().auditRange('s1', new Date('2026-06-01'), new Date('2026-06-02'));
        expect(mocks.coverage).toHaveBeenCalledTimes(1);
    });
    it('bounds direct importRange and fetchRange before calling Tesla', async () => {
        const instance = importer();
        expect(await instance.importRange('s1', new Date('2026-06-01'), cutoff)).toEqual([]);
        expect(await instance.fetchRange(site, new Date('2026-06-01'), cutoff)).toEqual([]);
        expect(mocks.energy).not.toHaveBeenCalled(); expect(mocks.soe).not.toHaveBeenCalled();
    });
    it('fails closed on missing ownership or entitlement read errors', async () => {
        mocks.site.mockResolvedValue({ ...site, user_id: null });
        await expect(importer().ensureDataForRange('s1', cutoff, new Date('2026-07-04'))).rejects.toThrow();
        mocks.site.mockResolvedValue(site); mocks.policy.mockRejectedValue(new Error('database unavailable'));
        await expect(importer().ensureDataForRange('s1', cutoff, new Date('2026-07-04'))).rejects.toThrow('database unavailable');
        expect(mocks.energy).not.toHaveBeenCalled();
    });
    it('filters Tesla rows outside the requested day before returning or persisting', async () => {
        mocks.energy.mockResolvedValue([
            { timestamp: '2026-07-02T05:00:00Z', consumer_energy_imported_from_grid: 100 },
            { timestamp: '2026-07-03T05:05:00Z', consumer_energy_imported_from_grid: 200 },
        ]);
        const rows = await importer().importRange('s1', cutoff, new Date('2026-07-04T05:00:00Z'));
        expect(rows).toHaveLength(1); expect(rows[0].timestamp.toISOString()).toBe('2026-07-03T05:05:00.000Z');
        expect(mocks.insert.mock.calls[0][0]).toHaveLength(1);
    });
});
