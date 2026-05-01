# Egress Reduction Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3–N sequential DB queries in `EnergyRepo.getSite()` with a single LEFT JOIN, and add a public `getSitesWithTariffs(siteIds[])` batch method — without changing any caller.

**Architecture:** A private `loadSitesFromDB(ids, options)` method runs one JOIN query covering Site + User + Tariff + TariffSeason + TariffSchedule; a private `assembleFromRows(rows)` folds the denormalized result into the nested `SiteWithTariffs` structure. The public `getSitesWithTariffs()` handles cache-check-then-fetch for multiple IDs. `getSite()` becomes a thin wrapper over `getSitesWithTariffs()`.

**Tech Stack:** TypeScript, Vitest, `pg` (node-postgres), Next.js. Run all test commands from `cmd/next-app/`.

---

## File Map

| File | Change |
|------|--------|
| `src/lib/energy-repo.ts` | Replace `getSite()` body; add private `loadSitesFromDB()`, `assembleFromRows()`; add public `getSitesWithTariffs()` |
| `src/lib/energy-repo.test.ts` | Update 5 existing tests to match 1-query JOIN shape; add 6 new tests |

No other files change. All callers of `getSite()` continue working unchanged.

---

## Task 1 — Update existing `getSite` tests to expect the JOIN query

The 4 existing tests in `describe('EnergyRepo site payload selection')` and 2 in `describe('EnergyRepo getSite request-scoped cache')` currently mock 3 sequential `pool.query` calls and assert `queryMock` was called 3 times. After this task they will expect 1 call with the JOIN-shaped row. They **will fail** until Task 2 is complete.

**Files:**
- Modify: `src/lib/energy-repo.test.ts`

- [ ] **Step 1: Add a `makeSiteJoinRow` helper at the top of the test file** (below the `vi.mock` block, before the first `describe`). This returns a complete denormalized row as the JOIN query would — all tariff/season/schedule columns default to `null` (site has no tariffs).

```typescript
function makeSiteJoinRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'site-1',
        user_id: 'user-1',
        name: 'Home',
        utility: null,
        updated: new Date('2026-01-01T00:00:00Z'),
        installed: new Date('2025-01-01T00:00:00Z'),
        timezone: 'America/Chicago',
        billing_start_day: 1,
        timezone_display_mode: null,
        access_token: 'a',
        refresh_token: 'r',
        auth_status: 'active',
        tariff_id: null,
        tariff_name: null,
        tariff_updated: null,
        tariff_site_id: null,
        season_id: null,
        season_name: null,
        from_month: null, from_day: null,
        to_month: null, to_day: null,
        season_buy_rate: null, season_sell_rate: null,
        schedule_id: null,
        schedule_name: null,
        schedule_buy_rate: null, schedule_sell_rate: null,
        from_day_of_week: null, from_hour: null, from_minute: null,
        to_day_of_week: null, to_hour: null, to_minute: null,
        ...overrides,
    };
}
```

- [ ] **Step 2: Replace the `'fetches slim site columns by default'` test** (lines 23–50). The test now mocks one query returning one JOIN row and asserts exactly 1 query with `ANY` in the SQL and no `s.json`.

```typescript
it('fetches slim site columns by default', async () => {
    queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });

    const repo = new EnergyRepo();
    await repo.getSite('site-1');

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ANY($1');
    expect(sql).not.toContain('s.json');
    expect(params).toEqual([['site-1']]);
});
```

- [ ] **Step 3: Replace the `'includes site json only when explicitly requested'` test** (lines 52–77). Mock one query with `json` in the row, assert the SQL contains `s.json`.

```typescript
it('includes site json only when explicitly requested', async () => {
    queryMock.mockResolvedValueOnce({
        rows: [makeSiteJoinRow({ json: { components: { battery: true } } })]
    });

    const repo = new EnergyRepo();
    const site = await repo.getSite('site-1', { includeJson: true });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('s.json');
    expect(site?.json).toEqual({ components: { battery: true } });
});
```

- [ ] **Step 4: Leave the `'fetches slim site rows for user lists'` test unchanged** (lines 79–103). It tests `getSitesForUser()` which is not being changed.

- [ ] **Step 5: Replace the `'does not fetch site json for TRMNL installation lookups'` test** (lines 105–145). The installation JOIN runs first (query 1), then `getSite()` runs the site JOIN (query 2 — now 1 query instead of 3). Two total mocks, not four.

```typescript
it('does not fetch site json for TRMNL installation lookups', async () => {
    // Query 1: installation JOIN (getInstallationAndSite's own query)
    queryMock.mockResolvedValueOnce({
        rows: [{
            id: 1,
            uuid: 'uuid-1',
            site_id: 'site-1',
            plugin_setting_id: 123,
            created_at: new Date(),
            json: { device: true },
            access_token: 'install-token',
            refresh_token: 'install-refresh',
            tesla_access_token: 'tesla-token',
            tesla_refresh_token: 'tesla-refresh',
            tesla_auth_status: 'active'
        }]
    });
    // Query 2: getSite() JOIN (1 query, no s.json)
    queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });

    const repo = new EnergyRepo();
    const result = await repo.getInstallationAndSite('uuid-1');

    expect(queryMock).toHaveBeenNthCalledWith(
        1,
        expect.not.stringContaining('s.json'),
        ['uuid-1']
    );
    // Second call is the getSite JOIN — also no s.json
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(result?.site.json).toBeUndefined();
});
```

- [ ] **Step 6: Update the `'reuses the request-cache on a second getSite call within the same request'` test** (lines 367–404). Change `expect(callCountAfterFirst).toBe(3)` to `toBe(1)` and update the mock to return one JOIN row.

Find this block and replace it:
```typescript
// OLD — three mocks, assert 3 calls
queryMock
    .mockResolvedValueOnce({ rows: [{ id: 'site-1', ... }] })
    .mockResolvedValueOnce({ rows: [{ access_token: 'a', ... }] })
    .mockResolvedValueOnce({ rows: [] });
// ...
expect(callCountAfterFirst).toBe(3);
```

New version of the full test:
```typescript
it('reuses the request-cache on a second getSite call within the same request', async () => {
    await withRequestContext(async () => {
        const repo = new EnergyRepo();
        repo.invalidateCache('site-1');
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });

        const first = await repo.getSite('site-1');
        const callCountAfterFirst = queryMock.mock.calls.length;
        expect(first?.id).toBe('site-1');
        expect(callCountAfterFirst).toBe(1);

        // Invalidate persistent cache to prove request cache is what saves us
        repo.invalidateCache('site-1');

        const second = await repo.getSite('site-1');
        expect(second?.id).toBe('site-1');
        expect(queryMock.mock.calls.length).toBe(callCountAfterFirst); // no new queries
    });
});
```

- [ ] **Step 7: Update the `'isolates request caches across separate requests'` test** (lines 406–446). Each request mocks one JOIN row instead of three. Change the final assertion from `toBe(3)` to `toBe(1)`.

```typescript
it('isolates request caches across separate requests', async () => {
    // First request populates both caches
    await withRequestContext(async () => {
        const repo = new EnergyRepo();
        repo.invalidateCache('site-1');
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });
        await repo.getSite('site-1');
    });

    // Second request: invalidate persistent cache — must re-query
    await withRequestContext(async () => {
        const repo = new EnergyRepo();
        repo.invalidateCache('site-1');
        queryMock.mockReset();
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });

        await repo.getSite('site-1');
        expect(queryMock.mock.calls.length).toBe(1); // hit DB, not request cache
    });
});
```

- [ ] **Step 8: Run the updated tests to confirm they all fail** (implementation unchanged yet)

```bash
npm test -- src/lib/energy-repo.test.ts
```

Expected: multiple FAIL — `queryMock` called 3 times but expected 1, etc.

---

## Task 2 — Implement `loadSitesFromDB`, `assembleFromRows`, `getSitesWithTariffs`, and refactor `getSite`

**Files:**
- Modify: `src/lib/energy-repo.ts:300-358` (replace `getSite` body; add new methods)

- [ ] **Step 1: Add `getSitesWithTariffs` public method** directly before the existing `getSite` method (before line 300). This is the new batch entry point.

```typescript
async getSitesWithTariffs(siteIds: string[], options?: SiteQueryOptions): Promise<SiteWithTariffs[]> {
    if (siteIds.length === 0) return [];

    const now = Date.now();
    const requestCtx = getRequestContext();
    const results: SiteWithTariffs[] = [];
    const uncachedIds: string[] = [];

    for (const id of siteIds) {
        const reqCached = requestCtx.siteCache.get(id);
        if (reqCached && (!options?.includeJson || reqCached.json !== undefined)) {
            results.push(reqCached);
            continue;
        }
        const cached = siteCache.get(id);
        if (cached && cached.expires > now && (!options?.includeJson || cached.data.json !== undefined)) {
            requestCtx.siteCache.set(id, cached.data);
            results.push(cached.data);
            continue;
        }
        uncachedIds.push(id);
    }

    if (uncachedIds.length > 0) {
        const fresh = await this.loadSitesFromDB(uncachedIds, options);
        for (const site of fresh) {
            siteCache.set(site.id, { data: site, expires: now + CACHE_TTL_MS });
            requestCtx.siteCache.set(site.id, site);
            results.push(site);
        }
    }

    return results;
}
```

- [ ] **Step 2: Replace the entire body of `getSite`** (lines 300–358 — keep the signature, replace everything between the braces):

```typescript
async getSite(siteId: string, options?: SiteQueryOptions): Promise<SiteWithTariffs | undefined> {
    const results = await this.getSitesWithTariffs([siteId], options);
    return results[0];
}
```

- [ ] **Step 3: Add the private `loadSitesFromDB` method** after `getSite` (before `getSiteIds` at line 361):

```typescript
private async loadSitesFromDB(siteIds: string[], options?: SiteQueryOptions): Promise<SiteWithTariffs[]> {
    const jsonCol = options?.includeJson ? ', s.json' : '';
    const sql = `
        SELECT
            s.id, s.user_id, s.name, s.utility, s.updated, s.installed,
            s.timezone, s.billing_start_day, s.timezone_display_mode${jsonCol},
            u.access_token, u.refresh_token, u.auth_status,
            t.id          AS tariff_id,
            t.name        AS tariff_name,
            t.updated     AS tariff_updated,
            t.site_id     AS tariff_site_id,
            ts.id         AS season_id,
            ts.name       AS season_name,
            ts.from_month, ts.from_day, ts.to_month, ts.to_day,
            ts.buy_rate   AS season_buy_rate,
            ts.sell_rate  AS season_sell_rate,
            sch.id        AS schedule_id,
            sch.name      AS schedule_name,
            sch.buy_rate  AS schedule_buy_rate,
            sch.sell_rate AS schedule_sell_rate,
            sch.from_day_of_week, sch.from_hour, sch.from_minute,
            sch.to_day_of_week,   sch.to_hour,  sch.to_minute
        FROM "Site" s
        LEFT JOIN "User"           u   ON u.id          = s.user_id
        LEFT JOIN "Tariff"         t   ON t.site_id     = s.id
        LEFT JOIN "TariffSeason"   ts  ON ts.tariff_id  = t.id
        LEFT JOIN "TariffSchedule" sch ON sch.season_id = ts.id
        WHERE s.id = ANY($1::text[])
    `;
    const res = await pool.query(sql, [siteIds]);
    return this.assembleFromRows(res.rows, options);
}
```

- [ ] **Step 4: Add the private `assembleFromRows` method** immediately after `loadSitesFromDB`:

```typescript
private assembleFromRows(
    rows: Record<string, unknown>[],
    options?: SiteQueryOptions
): SiteWithTariffs[] {
    const siteMap = new Map<string, SiteWithTariffs>();
    const tariffMap = new Map<number, Tariff>();
    const seasonMap = new Map<number, TariffSeason>();

    for (const row of rows) {
        const siteId = row.id as string;
        if (!siteMap.has(siteId)) {
            siteMap.set(siteId, {
                id: siteId,
                user_id: (row.user_id as string | null) ?? null,
                name: row.name as string,
                utility: (row.utility as string | null) ?? null,
                updated: new Date(row.updated as string | Date),
                installed: new Date(row.installed as string | Date),
                timezone: row.timezone as string,
                billing_start_day: row.billing_start_day as number,
                timezone_display_mode: (row.timezone_display_mode as 'SITE' | 'BROWSER') ?? undefined,
                json: options?.includeJson ? row.json : undefined,
                access_token: (row.access_token as string | null) ?? null,
                refresh_token: (row.refresh_token as string | null) ?? null,
                auth_status: (row.auth_status as string | null) ?? null,
                tariffs: [],
            });
        }
        const site = siteMap.get(siteId)!;

        if (row.tariff_id == null) continue;
        const tariffId = Number(row.tariff_id);
        if (!tariffMap.has(tariffId)) {
            const tariff: Tariff = {
                id: tariffId,
                site_id: row.tariff_site_id as string,
                updated: new Date(row.tariff_updated as string | Date),
                name: (row.tariff_name as string | null) ?? null,
                seasons: [],
            };
            tariffMap.set(tariffId, tariff);
            site.tariffs.push(tariff);
        }
        const tariff = tariffMap.get(tariffId)!;

        if (row.season_id == null) continue;
        const seasonId = Number(row.season_id);
        if (!seasonMap.has(seasonId)) {
            const season: TariffSeason = {
                id: seasonId,
                tariff_id: tariffId,
                name: (row.season_name as string | null) ?? null,
                from_month: row.from_month as number,
                from_day: row.from_day as number,
                to_month: row.to_month as number,
                to_day: row.to_day as number,
                buy_rate: row.season_buy_rate as number,
                sell_rate: row.season_sell_rate as number,
                schedules: [],
            };
            seasonMap.set(seasonId, season);
            tariff.seasons!.push(season);
        }
        const season = seasonMap.get(seasonId)!;

        if (row.schedule_id == null) continue;
        season.schedules!.push({
            id: Number(row.schedule_id),
            season_id: seasonId,
            name: (row.schedule_name as string | null) ?? null,
            buy_rate: row.schedule_buy_rate != null ? Number(row.schedule_buy_rate) : null,
            sell_rate: row.schedule_sell_rate != null ? Number(row.schedule_sell_rate) : null,
            from_day_of_week: row.from_day_of_week as number | null,
            from_hour: row.from_hour as number | null,
            from_minute: row.from_minute as number | null,
            to_day_of_week: row.to_day_of_week as number | null,
            to_hour: row.to_hour as number | null,
            to_minute: row.to_minute as number | null,
        });
    }

    return Array.from(siteMap.values());
}
```

- [ ] **Step 5: Run the Task 1 tests — they should now pass**

```bash
npm test -- src/lib/energy-repo.test.ts
```

Expected: all existing tests pass (green).

- [ ] **Step 6: Commit**

```bash
git add src/lib/energy-repo.ts src/lib/energy-repo.test.ts
git commit -m "feat: replace getSite waterfall queries with single JOIN (Phase 2)

Updates existing tests to 1-query JOIN shape; adds getSitesWithTariffs batch method."
```

---

## Task 3 — Write and pass new `getSitesWithTariffs` tests

These tests cover row assembly edge cases and the batch/cache behaviour of `getSitesWithTariffs`.

**Files:**
- Modify: `src/lib/energy-repo.test.ts` — add new `describe` block at the end of the file

- [ ] **Step 1: Write all new tests for `getSitesWithTariffs`** — add this full block at the end of `energy-repo.test.ts`:

```typescript
describe('EnergyRepo.getSitesWithTariffs', () => {
    beforeEach(() => {
        queryMock.mockReset();
        const repo = new EnergyRepo();
        repo.invalidateCache('site-1');
        repo.invalidateCache('site-2');
    });

    it('returns empty array without querying when called with empty ids', async () => {
        const repo = new EnergyRepo();
        const result = await repo.getSitesWithTariffs([]);
        expect(result).toEqual([]);
        expect(queryMock).not.toHaveBeenCalled();
    });

    it('assembles a site with no tariffs (all tariff columns null)', async () => {
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow()] });

        const repo = new EnergyRepo();
        const [site] = await repo.getSitesWithTariffs(['site-1']);

        expect(site.id).toBe('site-1');
        expect(site.tariffs).toEqual([]);
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('assembles a site with one tariff, one season, two schedules', async () => {
        const base = makeSiteJoinRow({
            tariff_id: 1,
            tariff_name: 'E-TOU-C',
            tariff_updated: new Date('2026-01-01'),
            tariff_site_id: 'site-1',
            season_id: 10,
            season_name: 'Summer',
            from_month: 6, from_day: 1,
            to_month: 9, to_day: 30,
            season_buy_rate: 0.40, season_sell_rate: 0.10,
        });
        queryMock.mockResolvedValueOnce({
            rows: [
                { ...base, schedule_id: 100, schedule_name: 'Peak',     schedule_buy_rate: 0.45, schedule_sell_rate: 0.08,
                  from_day_of_week: 0, from_hour: 16, from_minute: 0, to_day_of_week: 6, to_hour: 21, to_minute: 0 },
                { ...base, schedule_id: 101, schedule_name: 'Off-Peak', schedule_buy_rate: 0.25, schedule_sell_rate: 0.10,
                  from_day_of_week: 0, from_hour: 21, from_minute: 0, to_day_of_week: 6, to_hour: 16, to_minute: 0 },
            ]
        });

        const repo = new EnergyRepo();
        const [site] = await repo.getSitesWithTariffs(['site-1']);

        expect(site.tariffs).toHaveLength(1);
        expect(site.tariffs[0].name).toBe('E-TOU-C');
        expect(site.tariffs[0].seasons).toHaveLength(1);
        expect(site.tariffs[0].seasons![0].schedules).toHaveLength(2);
        expect(site.tariffs[0].seasons![0].schedules![0].name).toBe('Peak');
        expect(site.tariffs[0].seasons![0].schedules![1].name).toBe('Off-Peak');
        expect(queryMock).toHaveBeenCalledTimes(1);
    });

    it('fetches two sites in one query', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [
                makeSiteJoinRow({ id: 'site-1', name: 'Home'  }),
                makeSiteJoinRow({ id: 'site-2', name: 'Cabin', user_id: 'user-2' }),
            ]
        });

        const repo = new EnergyRepo();
        const sites = await repo.getSitesWithTariffs(['site-1', 'site-2']);

        expect(sites).toHaveLength(2);
        expect(queryMock).toHaveBeenCalledTimes(1);
        const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(params).toEqual([['site-1', 'site-2']]);
    });

    it('only fetches uncached ids when some are already in module cache', async () => {
        // Pre-populate module cache for site-1 by doing one getSite call
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow({ id: 'site-1' })] });
        const repo = new EnergyRepo();
        await repo.getSitesWithTariffs(['site-1']);
        queryMock.mockReset();

        // Now request site-1 (cached) and site-2 (cold)
        queryMock.mockResolvedValueOnce({ rows: [makeSiteJoinRow({ id: 'site-2', name: 'Cabin' })] });
        const sites = await repo.getSitesWithTariffs(['site-1', 'site-2']);

        expect(sites).toHaveLength(2);
        expect(queryMock).toHaveBeenCalledTimes(1);
        const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
        expect(params).toEqual([['site-2']]); // only the cold id
    });

    it('returns all from cache without querying when all ids are warm', async () => {
        // Warm both
        queryMock.mockResolvedValueOnce({
            rows: [
                makeSiteJoinRow({ id: 'site-1' }),
                makeSiteJoinRow({ id: 'site-2', name: 'Cabin' }),
            ]
        });
        const repo = new EnergyRepo();
        await repo.getSitesWithTariffs(['site-1', 'site-2']);
        queryMock.mockReset();

        const sites = await repo.getSitesWithTariffs(['site-1', 'site-2']);
        expect(sites).toHaveLength(2);
        expect(queryMock).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run the new tests**

```bash
npm test -- src/lib/energy-repo.test.ts
```

Expected: all tests pass (the implementation from Task 2 already satisfies them). If any fail, investigate the assembly or cache logic.

- [ ] **Step 3: Run the full test suite to check for regressions**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Run the production build**

```bash
npm run build
```

Expected: exits 0 with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/energy-repo.ts src/lib/energy-repo.test.ts
git commit -m "test: add getSitesWithTariffs batch and assembly tests (Phase 2)"
```

---

## Task 4 — Lint and final verification

**Files:** None (read-only verification)

- [ ] **Step 1: Run lint**

```bash
npm run lint
```

Expected: no errors or warnings introduced by the changes.

- [ ] **Step 2: Confirm query count in `getSite` test output**

Check the test output for `'fetches slim site columns by default'` — the assertion `expect(queryMock).toHaveBeenCalledTimes(1)` should be the only call count assertion that appears. Previously it was 3.

- [ ] **Step 3: Done**

Phase 2 is complete. The `getSite()` cold-cache path now issues 1 query (the JOIN) instead of 3–N sequential queries. The new `getSitesWithTariffs(ids[])` method enables single-query batch loading for future callers. No routes, pages, or other callers were changed.
