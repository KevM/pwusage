# Live-Status Cross-Instance Claim + Honest Token Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent concurrent serverless instances from making duplicate billable Tesla `live_status` calls by adding an atomic DB claim to `refreshLiveStatus`, and remove the lying non-null assertions in `SiteService.loadSitePageData`'s Tesla client config.

**Architecture:** `refreshTodayData` already has cross-instance protection via the DB import lock; `refreshLiveStatus` only has in-process state, so two Vercel instances with a cold cache can both call Tesla. The fix reuses the existing `Site.last_live_refresh_at` column as an atomic claim marker (conditional `UPDATE ... WHERE last_live_refresh_at IS NULL OR <= now - interval`, `rowCount` as the verdict — same pattern as `acquireImportLock`). No schema change. A failed fetch releases the claim so retries aren't delayed. Separately, `loadSitePageData` swaps `accessToken!`/`refreshToken!` for explicit fallbacks with a comment documenting the intentional 401 → auth-failure flow.

**Tech Stack:** Next.js app in `cmd/next-app`, Vitest (hoisted `queryMock` for repos; class-constructor mocks returning shared mock objects for `today-refresh.test.ts`).

---

## Context for a zero-context engineer

- All app code lives under `cmd/next-app`; run npm commands from that directory.
- **The duplicate-call problem:** `src/lib/today-refresh.ts` `refreshLiveStatus` throttles with an in-process map (`globalThis.__todayRefreshState`) plus a DB-cached `live_status_cache`/`last_live_refresh_at` on the Site row. In-process state does not span serverless instances, so on a cold/expired cache two concurrent requests (e.g. TRMNL markup poll + web live page) each call the billable Tesla `live_status` endpoint. `refreshTodayData` in the same file shows the house solution: an atomic conditional UPDATE on the Site row (`withImportLock`/`acquireImportLock` in `src/lib/site-repo.ts`). We do NOT reuse the import lock for live status — that would make a live-status refresh block a data import; instead we claim via the `last_live_refresh_at` column itself.
- **Claim semantics (the design, so you don't have to re-derive it):**
  - Claiming sets `last_live_refresh_at = now` atomically iff it is NULL or older than `minIntervalMs`. Winner fetches; losers get `cached`/`throttled` — which is what they'd want anyway.
  - On fetch success, the existing `updateLiveStatusCache` overwrites `last_live_refresh_at` with the actual fetch time (slightly later than the claim time — fine).
  - On fetch failure, the claim is released by restoring the pre-claim value, but only if the row still holds our claim value (compare-and-set), so we never clobber a fresher write from a `force` caller. This preserves the behavior pinned by the existing test "does not report in-flight or lock out cold cache retries after a failed fetch".
  - `force: true` bypasses the claim entirely (explicit caller intent, same as it bypasses the TTL today).
  - Known accepted edge: a timed-out fetch releases the claim while Tesla may still be processing the original request; the retry can cause one extra call. Same exposure as today, just bounded.
- **The non-null assertion problem:** `src/lib/site-service.ts` `loadSitePageData` (~lines 120-140) builds `TeslaClientConfig` with `accessToken: accessToken!` where `site` (and thus both tokens) can be `undefined`. It works only because `Bearer undefined` earns a 401 → `TeslaAuthError` → the `auth-failure` status. The existing test contract (see `site-service.test.ts` "returns not-found when site does not exist...") requires that `ensureSite` still be *attempted* when the site row is missing, so we must NOT short-circuit on missing tokens — just make the config honest and document the flow.
- **Test conventions:**
  - `src/lib/site-repo.test.ts`: hoisted `queryMock` via `vi.mock('./db', ...)`; assert on SQL strings with `expect.stringContaining` and params arrays.
  - `src/lib/today-refresh.test.ts`: module mocks return shared objects (`siteRepoMock`, `teslaClientMock`, ...); each `describe` has a `beforeEach` that calls `vi.resetModules()` and re-primes defaults; tests import the module under test via `await import('./today-refresh')`.
  - `src/lib/site-service.test.ts`: `SiteService` takes injected deps; `teslaClientCreator: vi.fn().mockReturnValue({})` lets you assert the config it receives.
- **Ground rules:** do not `git push` — the user pushes. Run git commands without a leading `cd`. `npm run lint`, `npm run build`, and `npm test` must pass before finishing.

## File Structure

- Modify: `cmd/next-app/src/lib/site-repo.ts` — add `claimLiveRefresh` + `releaseLiveRefreshClaim`
- Modify: `cmd/next-app/src/lib/site-repo.test.ts` — tests for both
- Modify: `cmd/next-app/src/lib/today-refresh.ts` — wire the claim into `refreshLiveStatus`
- Modify: `cmd/next-app/src/lib/today-refresh.test.ts` — mock additions + three new tests
- Modify: `cmd/next-app/src/lib/site-service.ts` — honest token config
- Modify: `cmd/next-app/src/lib/site-service.test.ts` — one new test

---

### Task 1: Branch

- [ ] **Step 1: Branch off up-to-date main**

```bash
git -C /Users/kevm/github/pwusage checkout main
git -C /Users/kevm/github/pwusage pull
git -C /Users/kevm/github/pwusage checkout -b fix/live-status-claim
cd /Users/kevm/github/pwusage/cmd/next-app && npm install
```

---

### Task 2: SiteRepo claim primitives

**Files:**
- Modify: `cmd/next-app/src/lib/site-repo.ts` (add methods next to `acquireImportLock`)
- Test: `cmd/next-app/src/lib/site-repo.test.ts`

- [ ] **Step 1: Write the failing tests** — append to `cmd/next-app/src/lib/site-repo.test.ts` (top-level, following the file's existing describe style):

```ts
describe('SiteRepo live refresh claim', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('claimLiveRefresh returns true when the conditional update wins the row', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 1 });
        const repo = new SiteRepo();

        const claimed = await repo.claimLiveRefresh('site-1', 1_000_000, 60_000);

        expect(claimed).toBe(true);
        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('SET last_live_refresh_at = $1'),
            [1_000_000, 'site-1', 940_000]
        );
        expect(queryMock.mock.calls[0][0]).toContain('last_live_refresh_at IS NULL OR last_live_refresh_at <= $3');
    });

    it('claimLiveRefresh returns false when another instance holds a fresh claim', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 0 });
        const repo = new SiteRepo();

        await expect(repo.claimLiveRefresh('site-1', 1_000_000, 60_000)).resolves.toBe(false);
    });

    it('releaseLiveRefreshClaim restores the previous value only while our claim is still on the row', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 1 });
        const repo = new SiteRepo();

        await repo.releaseLiveRefreshClaim('site-1', 1_000_000, 900_000);

        expect(queryMock).toHaveBeenCalledWith(
            expect.stringContaining('WHERE id = $2 AND last_live_refresh_at = $3'),
            [900_000, 'site-1', 1_000_000]
        );
    });

    it('releaseLiveRefreshClaim restores NULL when there was no previous refresh', async () => {
        queryMock.mockResolvedValueOnce({ rowCount: 1 });
        const repo = new SiteRepo();

        await repo.releaseLiveRefreshClaim('site-1', 1_000_000, null);

        expect(queryMock).toHaveBeenCalledWith(expect.any(String), [null, 'site-1', 1_000_000]);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/kevm/github/pwusage/cmd/next-app && npx vitest run src/lib/site-repo.test.ts`
Expected: FAIL — `claimLiveRefresh` is not a function.

- [ ] **Step 3: Implement** — add to `SiteRepo` in `cmd/next-app/src/lib/site-repo.ts`, directly below `releaseImportLock`:

```ts
    /**
     * Atomically claim the right to refresh a site's live status across
     * serverless instances, using last_live_refresh_at itself as the claim
     * marker (same conditional-UPDATE pattern as acquireImportLock). Returns
     * false when another instance refreshed or claimed within minIntervalMs.
     * A successful fetch overwrites the marker via updateLiveStatusCache; a
     * failed fetch must call releaseLiveRefreshClaim so retries aren't
     * delayed a full interval.
     */
    async claimLiveRefresh(siteId: string, nowMs: number, minIntervalMs: number): Promise<boolean> {
        const result = await pool.query(`
            UPDATE "Site"
            SET last_live_refresh_at = $1
            WHERE id = $2
              AND (last_live_refresh_at IS NULL OR last_live_refresh_at <= $3)
        `, [nowMs, siteId, nowMs - minIntervalMs]);
        this.invalidateCache(siteId);
        return (result.rowCount ?? 0) > 0;
    }

    /**
     * Undo a claimLiveRefresh after a failed fetch. Compare-and-set on the
     * claim value so a fresher write (e.g. a concurrent force refresh that
     * already called updateLiveStatusCache) is never clobbered.
     */
    async releaseLiveRefreshClaim(siteId: string, claimMs: number, previousMs: number | null): Promise<void> {
        await pool.query(`
            UPDATE "Site"
            SET last_live_refresh_at = $1
            WHERE id = $2 AND last_live_refresh_at = $3
        `, [previousMs, siteId, claimMs]);
        this.invalidateCache(siteId);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/site-repo.test.ts`
Expected: PASS (new and pre-existing).

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/site-repo.ts cmd/next-app/src/lib/site-repo.test.ts
git -C /Users/kevm/github/pwusage commit -m "feat(site-repo): atomic live-refresh claim primitives"
```

---

### Task 3: Wire the claim into refreshLiveStatus

**Files:**
- Modify: `cmd/next-app/src/lib/today-refresh.ts` (`refreshLiveStatus`, the block after `state.liveInFlight = true;`)
- Test: `cmd/next-app/src/lib/today-refresh.test.ts`

- [ ] **Step 1: Extend the shared site repo mock** — in `cmd/next-app/src/lib/today-refresh.test.ts`, add two entries to the `siteRepoMock` object literal (defined near the top with `acquireImportLock` etc.):

```ts
    claimLiveRefresh: vi.fn(),
    releaseLiveRefreshClaim: vi.fn(),
```

and add default priming to the `beforeEach` of **both** describe blocks (`refreshTodayData` and `refreshLiveStatus`), next to the other `siteRepoMock` defaults:

```ts
        siteRepoMock.claimLiveRefresh.mockResolvedValue(true);
        siteRepoMock.releaseLiveRefreshClaim.mockResolvedValue(undefined);
```

- [ ] **Step 2: Write the failing tests** — append inside `describe('refreshLiveStatus', ...)`:

```ts
    it('returns throttled without calling Tesla when another instance holds the claim', async () => {
        siteRepoMock.claimLiveRefresh.mockResolvedValue(false);
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        await expect(refreshLiveStatus('site-1')).resolves.toEqual({ status: 'throttled' });
        expect(teslaClientMock.getLiveStatus).not.toHaveBeenCalled();
    });

    it('returns the stale cache when the claim is lost but a cache exists', async () => {
        siteRepoMock.getSite.mockResolvedValue({
            id: 'site-1',
            live_status_cache: { percentage_charged: 55 },
            last_live_refresh_at: Date.now() - 17 * 60 * 1000, // expired vs 16-min TTL
        });
        siteRepoMock.claimLiveRefresh.mockResolvedValue(false);
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        await expect(refreshLiveStatus('site-1')).resolves.toMatchObject({
            status: 'cached',
            liveStatus: { percentage_charged: 55 },
        });
        expect(teslaClientMock.getLiveStatus).not.toHaveBeenCalled();
    });

    it('releases the claim when the Tesla fetch fails', async () => {
        const previous = Date.now() - 20 * 60 * 1000;
        siteRepoMock.getSite.mockResolvedValue({
            id: 'site-1',
            live_status_cache: null,
            last_live_refresh_at: previous,
        });
        teslaClientMock.getLiveStatus.mockRejectedValue(new Error('live down'));
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        await expect(refreshLiveStatus('site-1')).resolves.toMatchObject({ status: 'error' });
        expect(siteRepoMock.releaseLiveRefreshClaim).toHaveBeenCalledWith('site-1', expect.any(Number), previous);
    });

    it('bypasses the claim when force is set', async () => {
        siteRepoMock.claimLiveRefresh.mockResolvedValue(false);
        const { refreshLiveStatus } = await importRefreshLiveStatus();

        await expect(refreshLiveStatus('site-1', { force: true })).resolves.toMatchObject({ status: 'refreshed' });
        expect(siteRepoMock.claimLiveRefresh).not.toHaveBeenCalled();
    });
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx vitest run src/lib/today-refresh.test.ts`
Expected: the four new tests FAIL (`claimLiveRefresh` never called / no throttled result); all pre-existing tests PASS (the defaults from Step 1 keep them green once the implementation lands — right now they pass because nothing calls the new mocks).

- [ ] **Step 4: Implement** — in `cmd/next-app/src/lib/today-refresh.ts`, replace the body of the inner `try` in `refreshLiveStatus` (currently: create client → check no-tokens → `withTimeout(getLiveStatus)` → `updateLiveStatusCache` → return refreshed):

```ts
        state.liveInFlight = true;

        try {
            const client = await createTeslaClientForSite(siteId);
            if (!client) {
                return { status: 'no-tokens' };
            }

            // Cross-instance guard: in-process state above doesn't span
            // serverless instances, so claim the refresh via an atomic
            // conditional UPDATE before making the billable Tesla call.
            // force callers skip it — they explicitly want a fresh fetch.
            const claimMs = Date.now();
            if (options.force !== true) {
                const claimed = await siteRepo.claimLiveRefresh(siteId, claimMs, minIntervalMs);
                if (!claimed) {
                    if (cachedStatus && useCached) {
                        return { status: 'cached', liveStatus: cachedStatus, fetchedAt };
                    }
                    return { status: 'throttled' };
                }
            }

            try {
                const timeoutMs = options.timeoutMs ?? TESLA_LIVE_TIMEOUT_MS;
                const liveStatus = await withTimeout(client.getLiveStatus(siteId), timeoutMs, 'tesla_live');
                const refreshedAt = Date.now();
                state.lastLiveRefreshAt = refreshedAt;

                await siteRepo.updateLiveStatusCache(siteId, liveStatus, refreshedAt);

                return { status: 'refreshed', liveStatus, fetchedAt: refreshedAt };
            } catch (fetchError) {
                // Give the claim back so the next caller can retry immediately
                // instead of waiting out minIntervalMs on a failure.
                if (options.force !== true) {
                    await siteRepo.releaseLiveRefreshClaim(siteId, claimMs, fetchedAt ?? null);
                }
                throw fetchError;
            }
        } finally {
            state.liveInFlight = false;
        }
```

(`siteRepo`, `cachedStatus`, `fetchedAt`, `useCached`, and `minIntervalMs` are all already defined earlier in the function — reuse them; do not redeclare.)

- [ ] **Step 5: Run the file's tests**

Run: `npx vitest run src/lib/today-refresh.test.ts`
Expected: PASS — all new tests and all pre-existing ones, including "does not report in-flight or lock out cold cache retries after a failed fetch" (the release path keeps retries possible) and the fake-timer TTL test.

- [ ] **Step 6: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/today-refresh.ts cmd/next-app/src/lib/today-refresh.test.ts
git -C /Users/kevm/github/pwusage commit -m "fix(live-status): claim refresh across instances to prevent duplicate Tesla calls"
```

---

### Task 4: Honest token config in loadSitePageData

**Files:**
- Modify: `cmd/next-app/src/lib/site-service.ts` (~lines 122-134)
- Test: `cmd/next-app/src/lib/site-service.test.ts`

- [ ] **Step 1: Write the failing test** — append inside `describe('loadSitePageData', ...)` in `cmd/next-app/src/lib/site-service.test.ts`:

```ts
        it('builds the Tesla client with explicit empty credentials when the site row is missing', async () => {
            const mockSiteRepo = {
                getSites: vi.fn(),
                getSite: vi.fn().mockResolvedValue(null)
            };
            mockImporter.ensureSite.mockResolvedValue(null);
            const teslaClientCreator = vi.fn().mockReturnValue({});

            const service = new SiteService({
                siteRepo: mockSiteRepo as unknown as SiteRepo,
                siteAuthToken: 'valid_token',
                isUserActive: vi.fn().mockResolvedValue(true),
                energyRepo: mockEnergyRepo as unknown as EnergyRepo,
                teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
                trmnlService: mockTrmnlService as unknown as TrmnlService,
                teslaClientCreator,
                importerCreator: vi.fn().mockReturnValue(mockImporter)
            });

            await service.loadSitePageData('12345');

            expect(teslaClientCreator).toHaveBeenCalledWith(
                expect.objectContaining({ accessToken: '', refreshToken: undefined })
            );
            // The missing-site recovery path must still be attempted.
            expect(mockImporter.ensureSite).toHaveBeenCalledWith('12345');
        });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/site-service.test.ts`
Expected: the new test FAILS — `teslaClientCreator` currently receives `accessToken: undefined` (via the `!` assertion), not `''`.

- [ ] **Step 3: Implement** — in `cmd/next-app/src/lib/site-service.ts`, replace:

```ts
        const config: TeslaClientConfig = {
            accessToken: accessToken!,
            refreshToken: refreshToken!,
```

with:

```ts
        // Tokens are absent when the site row is missing or the user has no
        // stored credentials. We still build the client and attempt ensureSite:
        // the empty token earns a 401 -> TeslaAuthError -> the 'auth-failure'
        // status below, which is the page's re-auth prompt. Intentional, not
        // accidental — do not "fix" by short-circuiting before ensureSite
        // (tests pin that the recovery attempt happens).
        const config: TeslaClientConfig = {
            accessToken: accessToken ?? '',
            refreshToken: refreshToken ?? undefined,
```

Leave the rest of the config object and everything downstream unchanged.

- [ ] **Step 4: Run the service tests**

Run: `npx vitest run src/lib/site-service.test.ts`
Expected: PASS — new test plus all pre-existing (`not-found`, `needs-setup`, `auth-failure`, `ready` contracts unchanged).

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/site-service.ts cmd/next-app/src/lib/site-service.test.ts
git -C /Users/kevm/github/pwusage commit -m "fix(site-service): replace non-null token assertions with documented explicit fallbacks"
```

---

### Task 5: Full verification

- [ ] **Step 1: Full test suite** — Run: `cd /Users/kevm/github/pwusage/cmd/next-app && npm test -- --run` — Expected: all pass.
- [ ] **Step 2: Lint** — Run: `npm run lint` — Expected: exit 0.
- [ ] **Step 3: Build** — Run: `npm run build` — Expected: completes without errors.
- [ ] **Step 4: Report — do NOT push.** Leave the three commits on `fix/live-status-claim`. Note for the reviewer: the claim briefly advances `last_live_refresh_at` before a fetch completes, so other readers may label the previous cache as slightly fresher than it is for a few seconds (or until release on failure) — cosmetic, affects only the `X-SOC-Age-Minutes` debug header and staleness display, and was judged acceptable versus duplicate billable calls.
