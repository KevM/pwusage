# Consolidate Background Refresh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the duplicated Tesla today/live background refresh implementations while preserving the existing demand-driven triggers and Tesla API cost controls.

**Architecture:** Keep the four legitimate trigger surfaces: live page render, TRMNL request `after()`, client SSE backfill, and pg_cron HTTP routes. Consolidate the duplicated today-data refresh into `src/lib/today-refresh.ts`, add a sibling live-status refresh helper there, and extract DB import-lock acquire/release ceremony into one reusable helper. The DB lock remains the cross-instance guard; in-memory maps remain only a same-instance fast path.

**Tech Stack:** Next.js App Router, TypeScript, Vitest, PostgreSQL via `pg`

---

### Task 1: Add a Reusable Import Lock Helper

**Files:**
- Create: `cmd/next-app/src/lib/import-lock.ts`
- Create: `cmd/next-app/src/lib/import-lock.test.ts`

**Step 1: Write the failing tests**

Create `cmd/next-app/src/lib/import-lock.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withImportLock } from './import-lock';

describe('withImportLock', () => {
    const siteRepo = {
        acquireImportLock: vi.fn(),
        releaseImportLock: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        siteRepo.acquireImportLock.mockResolvedValue(true);
        siteRepo.releaseImportLock.mockResolvedValue(true);
    });

    it('runs the callback after acquiring the lock and releases afterward', async () => {
        const result = await withImportLock(
            siteRepo,
            { siteId: 'site-1', lockDurationMs: 60000, minIntervalMs: 1000, logLabel: 'Test' },
            async () => 'done'
        );

        expect(result).toEqual({ status: 'acquired', value: 'done' });
        expect(siteRepo.acquireImportLock).toHaveBeenCalledWith({
            siteId: 'site-1',
            lockId: expect.any(String),
            lockDurationMs: 60000,
            minIntervalMs: 1000,
            force: undefined,
        });
        expect(siteRepo.releaseImportLock).toHaveBeenCalledWith('site-1', expect.any(String));
    });

    it('does not run the callback when the lock is not acquired', async () => {
        siteRepo.acquireImportLock.mockResolvedValue(false);
        const callback = vi.fn();

        const result = await withImportLock(
            siteRepo,
            { siteId: 'site-1', lockDurationMs: 60000, logLabel: 'Test' },
            callback
        );

        expect(result).toEqual({ status: 'not-acquired' });
        expect(callback).not.toHaveBeenCalled();
        expect(siteRepo.releaseImportLock).not.toHaveBeenCalled();
    });

    it('still releases the lock when the callback throws', async () => {
        await expect(withImportLock(
            siteRepo,
            { siteId: 'site-1', lockDurationMs: 60000, logLabel: 'Test' },
            async () => { throw new Error('boom'); }
        )).rejects.toThrow('boom');

        expect(siteRepo.releaseImportLock).toHaveBeenCalledWith('site-1', expect.any(String));
    });
});
```

**Step 2: Run the focused test to verify it fails**

Run from `cmd/next-app`:

```bash
npm run test -- src/lib/import-lock.test.ts
```

Expected: FAIL because `src/lib/import-lock.ts` does not exist.

**Step 3: Implement the helper**

Create `cmd/next-app/src/lib/import-lock.ts`:

```typescript
import type { SiteRepo } from './site-repo';

type ImportLockRepo = Pick<SiteRepo, 'acquireImportLock' | 'releaseImportLock'>;

export interface ImportLockOptions {
    siteId: string;
    lockDurationMs?: number;
    force?: boolean;
    minIntervalMs?: number;
    logLabel: string;
}

export type ImportLockResult<T> =
    | { status: 'not-acquired' }
    | { status: 'acquired'; value: T };

export async function withImportLock<T>(
    siteRepo: ImportLockRepo,
    options: ImportLockOptions,
    callback: () => Promise<T>
): Promise<ImportLockResult<T>> {
    const lockId = crypto.randomUUID();
    const acquired = await siteRepo.acquireImportLock({
        siteId: options.siteId,
        lockId,
        lockDurationMs: options.lockDurationMs,
        force: options.force,
        minIntervalMs: options.minIntervalMs,
    });

    if (!acquired) {
        return { status: 'not-acquired' };
    }

    try {
        return { status: 'acquired', value: await callback() };
    } finally {
        try {
            await siteRepo.releaseImportLock(options.siteId, lockId);
        } catch (error) {
            console.error(`[${options.logLabel}] Failed to release DB import lock for site ${options.siteId}:`, error);
        }
    }
}
```

**Step 4: Run the focused test to verify it passes**

Run from `cmd/next-app`:

```bash
npm run test -- src/lib/import-lock.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add cmd/next-app/src/lib/import-lock.ts cmd/next-app/src/lib/import-lock.test.ts
git commit -m "refactor: add import lock helper"
```

---

### Task 2: Move `refreshTodayData` Onto `withImportLock`

**Files:**
- Modify: `cmd/next-app/src/lib/today-refresh.ts`
- Create: `cmd/next-app/src/lib/today-refresh.test.ts`

**Step 1: Write focused tests for current today-refresh behavior**

Create `cmd/next-app/src/lib/today-refresh.test.ts` with mocks for `UserRepo`, `SiteRepo`, `EnergyRepo`, `TeslaTokenRepo`, `TeslaClient`, and `Importer`.

Cover these cases:

```typescript
it('returns no-tokens without acquiring a DB lock when Tesla tokens are missing', async () => {
    userRepoMock.getTokensForSite.mockResolvedValue(null);

    await expect(refreshTodayData('site-1')).resolves.toEqual({ status: 'no-tokens' });
    expect(siteRepoMock.acquireImportLock).not.toHaveBeenCalled();
});

it('maps an active DB lock to in-flight', async () => {
    userRepoMock.getTokensForSite.mockResolvedValue(tokens);
    siteRepoMock.acquireImportLock.mockResolvedValue(false);
    siteRepoMock.getImportStatus.mockResolvedValue({ isImporting: true, lastImportAt: Date.now() });

    await expect(refreshTodayData('site-1')).resolves.toEqual({ status: 'in-flight' });
});

it('fetches today rows, persists through Importer, and releases the DB lock', async () => {
    userRepoMock.getTokensForSite.mockResolvedValue(tokens);
    energyRepoMock.getLatestEnergyData.mockResolvedValue({ timestamp: new Date('2026-07-02T10:00:00Z') });
    importerMock.getTodayData.mockResolvedValue([{ site_id: 'site-1', timestamp: new Date('2026-07-02T10:05:00Z') }]);
    importerMock.persistHistory.mockResolvedValue(1);

    await expect(refreshTodayData('site-1')).resolves.toMatchObject({ status: 'persisted', rowsPersisted: 1 });
    expect(siteRepoMock.releaseImportLock).toHaveBeenCalledWith('site-1', expect.any(String));
});

it('returns error and still releases the lock when Tesla fetch fails', async () => {
    importerMock.getTodayData.mockRejectedValue(new Error('tesla down'));

    await expect(refreshTodayData('site-1')).resolves.toMatchObject({ status: 'error', errorMessage: 'tesla down' });
    expect(siteRepoMock.releaseImportLock).toHaveBeenCalledWith('site-1', expect.any(String));
});
```

Use `vi.resetModules()` or expose a test-only reset only if the global throttle state leaks between tests. Prefer `vi.resetModules()` before importing `refreshTodayData` so the global map starts clean.

**Step 2: Run the focused test**

Run from `cmd/next-app`:

```bash
npm run test -- src/lib/today-refresh.test.ts
```

Expected: FAIL where the new lock-helper expectation has not yet been implemented.

**Step 3: Refactor `refreshTodayData`**

In `cmd/next-app/src/lib/today-refresh.ts`:

- Import `withImportLock` from `./import-lock`.
- Keep the public `RefreshTodayResult` shape.
- Keep the local in-memory `inFlight` and `lastRefreshAt` state.
- Replace `crypto.randomUUID()`, `acquireImportLock`, `try/finally`, and `releaseImportLock` with `withImportLock`.
- Preserve the existing `siteRepo.getImportStatus(siteId)` check when `withImportLock` returns `not-acquired`, so callers still receive `in-flight` vs `throttled`.
- Fix the module docstring so it becomes true once Task 5 routes TRMNL through this module.

Implementation shape:

```typescript
const lockResult = await withImportLock(
    siteRepo,
    {
        siteId,
        lockDurationMs: 60000,
        minIntervalMs: REFRESH_MIN_INTERVAL_MS,
        logLabel: 'TodayRefresh',
    },
    async () => {
        state.inFlight = true;
        state.lastRefreshAt = Date.now();

        try {
            // existing TeslaClient, Importer, latest-row, getTodayData, persistHistory logic
            return result;
        } finally {
            state.inFlight = false;
        }
    }
);

if (lockResult.status === 'not-acquired') {
    const status = await siteRepo.getImportStatus(siteId);
    return status.isImporting ? { status: 'in-flight' } : { status: 'throttled' };
}

return lockResult.value;
```

**Step 4: Run the focused tests**

Run from `cmd/next-app`:

```bash
npm run test -- src/lib/import-lock.test.ts src/lib/today-refresh.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add cmd/next-app/src/lib/today-refresh.ts cmd/next-app/src/lib/today-refresh.test.ts
git commit -m "refactor: route today refresh through import lock helper"
```

---

### Task 3: Add Shared Live Status Refresh

**Files:**
- Modify: `cmd/next-app/src/lib/today-refresh.ts`
- Modify: `cmd/next-app/src/lib/today-refresh.test.ts`

**Step 1: Add failing tests for `refreshLiveStatus`**

Add tests to `cmd/next-app/src/lib/today-refresh.test.ts`:

```typescript
it('refreshLiveStatus returns cached status when the live cache is fresh', async () => {
    siteRepoMock.getSite.mockResolvedValue({
        id: 'site-1',
        live_status_cache: { percentage_charged: 61 },
        last_live_refresh_at: Date.now(),
    });

    await expect(refreshLiveStatus('site-1')).resolves.toEqual({
        status: 'cached',
        liveStatus: { percentage_charged: 61 },
        fetchedAt: expect.any(Number),
    });
    expect(teslaClientMock.getLiveStatus).not.toHaveBeenCalled();
});

it('refreshLiveStatus fetches from Tesla and updates the Site live cache', async () => {
    siteRepoMock.getSite.mockResolvedValue({ id: 'site-1', live_status_cache: null, last_live_refresh_at: null });
    userRepoMock.getTokensForSite.mockResolvedValue(tokens);
    teslaClientMock.getLiveStatus.mockResolvedValue({ percentage_charged: 72 });

    await expect(refreshLiveStatus('site-1', { cacheTtlMs: 16 * 60 * 1000 })).resolves.toMatchObject({
        status: 'refreshed',
        liveStatus: { percentage_charged: 72 },
    });
    expect(siteRepoMock.updateLiveStatusCache).toHaveBeenCalledWith('site-1', { percentage_charged: 72 }, expect.any(Number));
});

it('refreshLiveStatus returns no-tokens without fetching Tesla', async () => {
    siteRepoMock.getSite.mockResolvedValue({ id: 'site-1', live_status_cache: null, last_live_refresh_at: null });
    userRepoMock.getTokensForSite.mockResolvedValue(null);

    await expect(refreshLiveStatus('site-1')).resolves.toEqual({ status: 'no-tokens' });
});

it('refreshLiveStatus returns error on Tesla failure', async () => {
    siteRepoMock.getSite.mockResolvedValue({ id: 'site-1', live_status_cache: null, last_live_refresh_at: null });
    userRepoMock.getTokensForSite.mockResolvedValue(tokens);
    teslaClientMock.getLiveStatus.mockRejectedValue(new Error('live down'));

    await expect(refreshLiveStatus('site-1')).resolves.toMatchObject({ status: 'error', errorMessage: 'live down' });
});
```

**Step 2: Run the focused test**

Run from `cmd/next-app`:

```bash
npm run test -- src/lib/today-refresh.test.ts
```

Expected: FAIL because `refreshLiveStatus` does not exist.

**Step 3: Implement `refreshLiveStatus`**

Add these exports to `cmd/next-app/src/lib/today-refresh.ts`:

```typescript
export interface RefreshLiveStatusOptions {
    cacheTtlMs?: number;
    timeoutMs?: number;
    force?: boolean;
}

export interface RefreshLiveStatusResult {
    status: 'refreshed' | 'cached' | 'in-flight' | 'no-tokens' | 'site-not-found' | 'error';
    liveStatus?: EnergySiteLiveStatus;
    fetchedAt?: number;
    errorMessage?: string;
}
```

Implementation requirements:

- Reuse the existing `withTimeout` helper.
- Add live-specific fields to the existing global state or introduce a second map in the same module:
  - `liveInFlight`
  - `lastLiveRefreshAt`
- Read `Site.live_status_cache` and `Site.last_live_refresh_at` first.
- If the cache is fresh and `force !== true`, return `cached`.
- If a live refresh for the site is already in flight, return `in-flight`.
- Fetch Tesla credentials via `UserRepo.getTokensForSite(siteId)`.
- Construct `TeslaClient` using `TeslaTokenRepo.getLockedRefreshHandler(siteId)`.
- Call `client.getLiveStatus(siteId)` with timeout.
- Persist via `siteRepo.updateLiveStatusCache(siteId, status, Date.now())`.
- Return `refreshed` with the status and timestamp.
- Never throw; return `error` with `errorMessage`.

Default constants:

```typescript
const LIVE_STATUS_CACHE_TTL_MS = 16 * 60 * 1000;
const LIVE_STATUS_REFRESH_MIN_INTERVAL_MS = 14 * 60 * 1000;
const TESLA_LIVE_TIMEOUT_MS = 3000;
```

**Step 4: Run the focused tests**

Run from `cmd/next-app`:

```bash
npm run test -- src/lib/today-refresh.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add cmd/next-app/src/lib/today-refresh.ts cmd/next-app/src/lib/today-refresh.test.ts
git commit -m "refactor: add shared live status refresh"
```

---

### Task 4: Route `Importer.ensureDataForRange` Through `withImportLock`

**Files:**
- Modify: `cmd/next-app/src/lib/importer/index.ts`
- Modify: `cmd/next-app/src/lib/importer.test.ts`

**Step 1: Add/adjust failing importer lock tests**

Extend `cmd/next-app/src/lib/importer.test.ts` with tests that assert:

- `ensureDataForRange` returns `[]` when the DB lock is not acquired.
- `releaseImportLock` is called when the import callback throws.
- `releaseImportLock` is called after successful window import.

Keep the existing pending-sync behavior unchanged.

**Step 2: Run focused importer tests**

Run from `cmd/next-app`:

```bash
npm run test -- src/lib/importer.test.ts
```

Expected: PASS before refactor or FAIL only for newly added stronger lock-helper expectations.

**Step 3: Refactor `ensureDataForRange`**

In `cmd/next-app/src/lib/importer/index.ts`:

- Import `withImportLock` from `../import-lock`.
- Remove local `lockId` and `dbLockAcquired`.
- Keep `Importer.pendingSyncs` exactly as-is.
- Keep `force` behavior exactly as-is.
- Move the existing audit/window/import body into the helper callback.

Implementation shape:

```typescript
const lockResult = await withImportLock(
    this.siteRepo,
    {
        siteId,
        lockDurationMs: 300000,
        force,
        logLabel: 'Importer',
    },
    async () => {
        // existing Audit Start, existingTimestamps, planImport, windows loop
        return allRows;
    }
);

if (lockResult.status === 'not-acquired') {
    logSync(`Skip: DB lock busy for site ${siteId}`);
    return [];
}

return lockResult.value;
```

Important: fetch the site before acquiring the lock only if needed to preserve the current `Site not found` error timing. The current code does `getSite` before `acquireImportLock`; keep that ordering unless a test proves it is unnecessary.

**Step 4: Run focused tests**

Run from `cmd/next-app`:

```bash
npm run test -- src/lib/import-lock.test.ts src/lib/importer.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add cmd/next-app/src/lib/importer/index.ts cmd/next-app/src/lib/importer.test.ts
git commit -m "refactor: use import lock helper in range importer"
```

---

### Task 5: Replace TRMNL's Duplicated Today/Live Background Refresh

**Files:**
- Modify: `cmd/next-app/src/app/api/trmnl/markup/route.ts`
- Modify: `cmd/next-app/src/app/api/trmnl/markup/route.test.ts`
- Modify: `cmd/next-app/src/lib/today-refresh.ts`
- Modify: `cmd/next-app/src/lib/today-refresh.test.ts`

**Step 1: Add route tests for delegation and response headers**

Update `cmd/next-app/src/app/api/trmnl/markup/route.test.ts`:

- Mock `@/lib/today-refresh` with `refreshTodayData` and `refreshLiveStatus`.
- Assert that a site with tokens schedules exactly one `after()` callback when refreshes are due.
- Execute the scheduled callback and assert it calls `refreshTodayData('site-1')` and `refreshLiveStatus('site-1', expect.objectContaining({ force: true }))`.
- Assert `X-Debug-Live-Status` remains one of the existing external values, especially:
  - `cached` when live cache is fresh and no refresh starts.
  - `cached+refreshing` when cached status exists and background refresh starts.
  - `refreshing` when no live status exists and background refresh starts.
  - `skipped` when no Tesla refresh token exists.

**Step 2: Run route tests**

Run from `cmd/next-app`:

```bash
npm run test -- src/app/api/trmnl/markup/route.test.ts
```

Expected: FAIL because route still uses local duplicate helpers.

**Step 3: Add a non-blocking mode to `refreshLiveStatus` if needed**

TRMNL currently does a 900ms inline live-status fetch on cache miss, then background refresh after response. Preserve that behavior without keeping Tesla client construction in the route by adding an option:

```typescript
export interface RefreshLiveStatusOptions {
    cacheTtlMs?: number;
    timeoutMs?: number;
    force?: boolean;
    useCached?: boolean;
}
```

Rules:

- `useCached` defaults to `true`.
- Inline TRMNL cache-miss fetch calls `refreshLiveStatus(site.id, { timeoutMs: 900, useCached: false })`.
- Background TRMNL refresh calls `refreshLiveStatus(site.id, { timeoutMs: 3000, force: true })`.

**Step 4: Refactor the route**

In `cmd/next-app/src/app/api/trmnl/markup/route.ts`:

- Remove imports for `TeslaTokenRepo`, `Importer`, and `TeslaClient`.
- Keep the `EnergySiteLiveStatus` type import if needed.
- Remove local `TeslaRefreshState`, `getTeslaRefreshState`, `TESLA_TODAY_TIMEOUT_MS`, `TESLA_LIVE_TIMEOUT_MS`, `TESLA_LIVE_INLINE_TIMEOUT_MS`, and local `withTimeout`.
- Stop constructing `trmnlClient`.
- Determine Tesla capability from `site.refresh_token`.
- Keep DB-only blocking reads unchanged.
- Keep fresh cached live-status read from `site.live_status_cache` unchanged for render determinism.
- On cache miss, call:

```typescript
const inlineResult = await refreshLiveStatus(site.id, {
    timeoutMs: 900,
    useCached: false,
});
```

- Map `inlineResult.status === 'refreshed'` to the existing `live-inline` `fetchStatus`.
- Map timeout/error statuses to existing `inline-timeout` or error logging behavior.
- For background work, schedule `after(async () => { await Promise.all([...]) })` and call:

```typescript
const todayRefresh = refreshTodayData(siteId, {
    minIntervalMs: TESLA_REFRESH_MIN_INTERVAL_MS,
    timeoutMs: 8000,
});
const liveRefresh = refreshLiveStatus(siteId, {
    timeoutMs: 3000,
    force: true,
});
```

If `refreshTodayData` does not yet accept options, add:

```typescript
export interface RefreshTodayOptions {
    minIntervalMs?: number;
    timeoutMs?: number;
}
```

Default `minIntervalMs` remains 60 seconds for live page and cron callers. TRMNL passes 14 minutes to preserve its existing poll-aligned behavior.

**Step 5: Preserve debug/status mapping**

Route-level mapping should stay intentionally boring:

```typescript
let fetchStatus = hasTeslaTokens ? 'background-throttled' : 'skipped';
let backgroundStatus = hasTeslaTokens ? 'throttled' : 'skipped';

if (shouldScheduleBackgroundRefresh) {
    backgroundStatus = 'started';
    fetchStatus = hasCachedLiveStatus ? 'cached+refreshing' : 'refreshing';
}
```

Use the shared helpers' return statuses only for logging inside the `after()` callback, not for the response that has already been rendered.

**Step 6: Run route and helper tests**

Run from `cmd/next-app`:

```bash
npm run test -- src/lib/today-refresh.test.ts src/app/api/trmnl/markup/route.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add cmd/next-app/src/app/api/trmnl/markup/route.ts cmd/next-app/src/app/api/trmnl/markup/route.test.ts cmd/next-app/src/lib/today-refresh.ts cmd/next-app/src/lib/today-refresh.test.ts
git commit -m "refactor: route trmnl background refresh through shared helpers"
```

---

### Task 6: Use Shared Live Status Refresh on the Live Page

**Files:**
- Modify: `cmd/next-app/src/app/site/[id]/live/page.tsx`
- Test: existing page-level coverage if present; otherwise verify through build and focused typecheck/build.

**Step 1: Remove local live-status helper**

In `cmd/next-app/src/app/site/[id]/live/page.tsx`:

- Remove imports for `TeslaClient`, `TeslaTokenRepo`, and `UserRepo`.
- Remove local `getLiveStatus(siteId)`.
- Import `refreshLiveStatus` from `@/lib/today-refresh`.

**Step 2: Replace the live status promise**

Replace:

```typescript
getLiveStatus(id).catch(() => null),
```

with:

```typescript
refreshLiveStatus(id)
    .then((result) => result.liveStatus ?? null)
    .catch(() => null),
```

The `.catch()` is defensive; `refreshLiveStatus` should not throw.

**Step 3: Run focused checks**

Run from `cmd/next-app`:

```bash
npm run test -- src/lib/today-refresh.test.ts
npm run build
```

Expected: PASS.

**Step 4: Commit**

```bash
git add 'cmd/next-app/src/app/site/[id]/live/page.tsx'
git commit -m "refactor: use shared live status refresh on live page"
```

---

### Task 7: Final Verification and Cleanup

**Files:**
- Modify only if verification finds unused imports, stale comments, or test gaps.

**Step 1: Search for duplicate lock and refresh code**

Run from repo root:

```bash
rg -n "crypto\\.randomUUID\\(\\)|acquireImportLock|releaseImportLock|getTeslaRefreshState|trmnlTeslaRefreshState|Tesla Today Usage Fetch|Drop strict pre-filter" cmd/next-app/src
```

Expected:

- `acquireImportLock` and `releaseImportLock` remain in `site-repo.ts`, `site-repo.test.ts`, and `import-lock.ts` tests/mocks.
- No `getTeslaRefreshState`.
- No TRMNL-local today fetch/persist block.
- The "Drop strict pre-filter" comment appears only where it belongs inside `Importer.persistHistory` or is removed entirely.

**Step 2: Run lint, tests, and build**

Run from `cmd/next-app`:

```bash
npm run lint
npm run test
npm run build
```

Expected: PASS.

**Step 3: Review diff**

Run from repo root:

```bash
git diff --stat main
git diff main -- cmd/next-app/src/lib/today-refresh.ts cmd/next-app/src/app/api/trmnl/markup/route.ts cmd/next-app/src/lib/importer/index.ts
```

Confirm:

- The four trigger surfaces still exist.
- The TRMNL route still renders from DB data before scheduling background work.
- Tesla fetches still happen in background except the existing bounded inline live-status cache miss path.
- The default live page/cron today refresh cadence is still 60 seconds unless an explicit caller overrides it.
- TRMNL keeps the 14-minute poll-aligned cadence by passing options.

**Step 4: Commit cleanup if needed**

```bash
git add cmd/next-app/src
git commit -m "chore: verify consolidated background refresh paths"
```

Only create this commit if Step 1 or Step 2 required code cleanup.

---

## Handoff Notes

Worktree:

```bash
cd /private/tmp/pwusage-consolidate-background-refresh-main
pwd
git branch --show-current
```

Expected branch:

```text
codex/consolidate-background-refresh-main
```

Local prerequisites currently missing in this worktree:

- `cmd/next-app/.env`
- `cmd/next-app/node_modules`

Bootstrap before executing the plan:

```bash
cd /private/tmp/pwusage-consolidate-background-refresh-main/cmd/next-app
npm install
```

Copy or recreate the local `.env` required by this app before running integration-like routes or `npm run build` if the build expects environment configuration.
