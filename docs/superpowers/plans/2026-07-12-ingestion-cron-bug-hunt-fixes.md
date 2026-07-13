# Ingestion / Cron / Billing-Window Bug Hunt Fixes (2026-07-12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the six bugs found in the 2026-07-12 data-ingestion/cron-layer bug hunt: an unauthenticated usage page (IDOR), the check-users cron locking users out on transient Tesla errors, the same cron burning rotated refresh tokens via stale/unlocked refreshes (a plausible "daily reauth" root cause), billing-cycle *end* math that drops days / doubles bills for late-month anchor days, a ×1000 energy inflation for lone-sample days, and a future-cycle raw-row leak in `getUsageByTOU`.

**Architecture:** All fixes are surgical. One new shared helper `getNextCycleStart` in `billing-cycle.ts` replaces three ad-hoc cycle-end derivations; `verifyUserStatus` is rewritten to route through the existing `createTeslaClientForSite` factory (fresh tokens + cross-instance locked refresh) with transient-vs-terminal error semantics; everything else is a small guarded change with a co-located Vitest test.

**Tech Stack:** Next.js app in `cmd/next-app`, Vitest, TypeScript, Temporal polyfill. All npm commands run from `cmd/next-app/`; git commands run from the repo root without a leading `cd` (use `git -C /Users/kevm/github/pwusage` if needed).

---

## Context for a zero-context engineer

- **Auth model:** `site_auth` is an HTTP-only JWT cookie (user id + authorized site ids). `verifySiteAccess(siteId)` in `src/lib/auth-checks.ts` is the standard server-side gate; `src/proxy.ts` only *refreshes* the cookie, it does not gate anything. Compare `src/app/site/[id]/live/page.tsx:34-56` (gated) with `src/app/site/[id]/usage/page.tsx` (not gated at all — Bug 1).
- **Bug 1 (confirmed, security):** `/site/[id]/usage` renders a site's full billing/usage data from the DB with zero authorization — no cookie required. Site ids are numeric Tesla `energy_site_id`s, and the analysis API's 404-before-auth ordering (Bug 6b) is an existence oracle for them.
- **Bug 2 (confirmed):** the daily `check-users` cron (vercel.json, 08:00 UTC) calls `UserRepo.verifyUserStatus`, whose catch-all marks the user `('error', is_active=false)` on ANY failure. `is_active=false` blocks every authenticated route (`auth-checks.ts:42`) and JWT refresh (`auth-jwt.ts:98-102`). A single Tesla 5xx/timeout/exhausted-429 during the nightly sweep locks the user out until the next successful sweep or a manual re-login.
- **Bug 3 (confirmed mechanism):** `verifyAllUserStatuses` bulk-reads every user's tokens once via `getAllUsers({ includeTokens: true })`, then loops with `getLiveStatus` + 200ms pauses. By the time user *N* is verified, its tokens were read minutes ago. Tesla rotates refresh tokens on use, so any refresh performed meanwhile (TRMNL poll, page load) makes the cron's copy stale → its raw, **unlocked** `refreshAccessToken` gets `invalid_grant` → `isTeslaAuthError` → user marked `revoked` → forced re-auth in the morning. The cron also writes tokens via `onTokenUpdate` without the `is_refreshing` lock, racing the locked path in `tesla-token-repo.ts`. Fix both by building the client with `createTeslaClientForSite` (reads tokens fresh at call time, wires the locked refresh handler).
- **Bug 4 (confirmed by probe):** billing cycles re-anchor to the billing day each month (day-31 anchor: Jan 31 → Feb 28 → Mar 31). Cycle *starts* are computed correctly by `getCurrentCycleStart` (clamps into short months). Cycle *ends* are not:
  - `site-service.ts:218` and `trmnl/markup/route.ts:125` use `addMonthsInSiteTimezone(start, 1)`: Temporal's `add({months:1})` from an already-constrained start gives Feb 28 → **Mar 28** (true next start: Mar 31). Days Mar 28–30 belong to no cycle, `isCurrentPeriod` goes false during them, and the "next" navigation loops (nextDateStr Mar 28 resolves back to the Feb cycle). The TRMNL device's cycle totals freeze during those tail days.
  - `usage/page.tsx:60-71` (specific-cycle branch) uses a 35-day pivot then re-applies the query date's day-of-month: probed Jan 31 → **Mar 31** (a "one-month" bill spanning two months), Feb-28 → Apr 30, Mar 31 → May 31. Probe used the app's own `@js-temporal/polyfill`.
- **Bug 5 (confirmed by production-data audit, 2026-07-12):** `transformEnergyPoints` (`src/lib/importer/energy-transformer.ts`) scales values ×1000 when it thinks Tesla returned a whole-day kWh aggregate (`period==='day' && requestedDurationHours>20 && durationHours>20`). For a **single-entry** response `durationHours` defaults to 24, so a lone genuine 5-minute Wh sample matches. A read-only audit of the (prod-copy) dev DB settled the design:
  - **85 poisoned rows exist** (first `2026-02-19`, last `2026-04-27 07:00Z`), all at site-local midnight, all with a field > 20 kWh. Dividing by 1000 recovers values matching the same sites' normal first-sample-of-day magnitudes (e.g. 894,500 Wh → 894.5 Wh vs. that site's typical 830–908 Wh midnight samples). The damage stopped the day commit `2ee99b2` added the `requestedDurationHours > 20` guard for short windows.
  - **Zero rows anywhere look like a legitimate day aggregate** (8–100 kWh alone in its day). The importer only ever requests ≤ one site-day per call (`splitAtSiteMidnight`, 24h chunking), and single-day requests evidently never return day totals — so the ×1000 branch has never scaled a true aggregate; it has only ever created poison. Day aggregates would only appear for multi-day spans, which this codebase never requests.
  - Therefore the fix is **removal**, not disambiguation: delete the scaling (and the now-dead `period`/`requestedDurationHours` plumbing), and repair the 85 rows with an idempotent migration. The 5–20 kWh band is empty in the data, so a 20 kWh-per-field threshold separates poison from real rows with zero collateral.
- **Bug 6 (confirmed logic, low severity):** `getUsageByTOU` (`energy-repo.ts:167`) computes `splitPoint = todayStart < end ? todayStart : end`, ignoring `start`. For a *future* cycle (hand-typed `?date=`), the raw pass fetches `[todayStart, end)` and includes today's rows that precede the cycle. 6b: `analysis/route.ts` runs `siteRepo.getSite` and returns 404 *before* the auth check, so unauthenticated callers can probe which site ids exist.
- **Schedule/TOU background** (needed for test fixtures): `Schedule` (`src/lib/schedule.ts`) is constructed with `(tariffs, timezone)`; tests that don't exercise TOU pass sites with `tariffs: []`.
- **Triage protocol:** if a step's "Expected" outcome doesn't materialize, stop and invoke `superpowers:systematic-debugging`. Never bend a test expectation to match broken behavior.
- **Ground rules:** do NOT `git push` — the user pushes. `npm run lint`, `npm run build`, and `npm test` must all pass before finishing. Pure unit-test work; never run scripts against the `.env` `DATABASE_URL` (it points at the live dev DB with billable Tesla tokens).

## Findings documented but deliberately NOT changed

List these in the results doc (Task 8) as confirmed-and-left-alone; do not fix them here:

1. **`/api/site/[id]/analysis?force=true` steals the import lock and bypasses every throttle on a GET** (`acquireImportLock` force path + `Importer.pendingSyncs` force bypass): repeated force requests trigger unbounded billable Tesla refetches and can steal the lock mid-import. Possibly intentional as a debug tool; needs a product decision (rate-limit or admin-gate), not a drive-by fix.
2. **`Importer.loadInterval` returns unfiltered `energyDatas` while persisting `filteredDatas`** (`importer/index.ts:398-417`): callers would see rows outside the requested window — currently dead payload (no caller consumes `EnsureDataResult.rows`).
3. **`refreshTodayData` reports `no-new-rows` even when `persistHistory` updated overlap rows** (`today-refresh.ts:149-155`): status is cosmetic; callers ignore it today.
4. **`TeslaClient.fetch` never consumes the 429 response body before retrying** — undici keeps the socket alive until GC; harmless at current volume.
5. **`TeslaTokenRepo.releaseRefreshLock`/`updateSiteTokens` don't verify lock ownership**: a refresh that outlives the 60s lock can release a successor's lock or clobber newer tokens. Requires the cross-instance claim pattern (`DesignDecisions.md`); window is tiny.
6. **`upsertOnTeslaAuth` ON CONFLICT doesn't update `token_expires_at`** — the column is written on insert only and read nowhere; flag for schema cleanup.
7. **`getUsageByTOU` pass-1 midpoint fallback uses UTC-day + 12h** for rows with NULL `tariff_schedule_id` — approximate TOU attribution by design; only affects synthetic-fallback rows.
8. **`check-users` cron runtime is unbounded** (sequential `getLiveStatus` per stale user + 200ms sleep); fine at current user count, will not scale past the function timeout.
9. The **2026-07-07 load-timing plan** (`docs/superpowers/plans/2026-07-07-load-timing-bug-hunt-fixes.md`) is still unexecuted — separate effort, untouched by this plan.

## File Structure

- Modify: `cmd/next-app/src/app/site/[id]/usage/page.tsx` — add auth gate (Task 1), fix cycle math (Task 4)
- Modify: `cmd/next-app/src/lib/user-repo.ts` — rewrite `verifyUserStatus`, adjust `verifyAllUserStatuses` (Task 2)
- Modify: `cmd/next-app/src/lib/user-repo.test.ts` — Task 2 tests
- Modify: `cmd/next-app/src/lib/billing-cycle.ts` — add `getNextCycleStart` (Task 3)
- Modify: `cmd/next-app/src/lib/billing-cycle.test.ts` — Task 3 tests
- Modify: `cmd/next-app/src/lib/site-service.ts` — use `getNextCycleStart` (Task 4)
- Modify: `cmd/next-app/src/app/api/trmnl/markup/route.ts` — use `getNextCycleStart` (Task 4)
- Modify: `cmd/next-app/src/lib/importer/energy-transformer.ts` + `energy-transformer.test.ts` — remove ×1000 scaling (Task 5)
- Modify: `cmd/next-app/src/lib/importer/index.ts` + `cmd/next-app/src/lib/importer.test.ts` — drop dead period/duration plumbing (Task 5)
- Create: `cmd/next-app/db-migrations/<timestamp>_repair_x1000_scaled_energy_rows.sql` — repair the 85 poisoned rows (Task 5)
- Modify: `cmd/next-app/src/lib/energy-repo.ts` + `energy-repo.test.ts` — splitPoint clamp (Task 6)
- Modify: `cmd/next-app/src/app/api/site/[id]/analysis/route.ts` — auth before existence check (Task 7)
- Create: `docs/superpowers/plans/2026-07-12-ingestion-cron-bug-hunt-RESULTS.md` — outcome log (Task 8)

---

### Task 0: Branch setup + green baseline

- [ ] **Step 1: Create the working branch from main**

```bash
git -C /Users/kevm/github/pwusage checkout main
git -C /Users/kevm/github/pwusage checkout -b fix/ingestion-cron-bug-hunt
```

Note: this plan file is untracked and follows the checkout; it gets committed in Task 8. Leave the untracked `2026-07-07-load-timing-bug-hunt-fixes.md` and the deleted `.claude/settings.local.json` working-tree state alone.

- [ ] **Step 2: Confirm the suite is green before starting**

Run (from `cmd/next-app`): `npm test`
Expected: all tests pass. If not, stop and report — do not build on a red base.

---

### Task 1: Authorization gate on /site/[id]/usage (confirmed security bug)

**Files:**
- Modify: `cmd/next-app/src/app/site/[id]/usage/page.tsx` (imports + top of the component)

The page has no test harness (server component); the gate for this task is lint + build + the code exactly mirroring the proven pattern in `live/page.tsx:34-56`.

- [ ] **Step 1: Add the imports**

At the top of `usage/page.tsx`, add:

```ts
import { redirect } from 'next/navigation';
import { verifySiteAccess, getCurrentUser } from '@/lib/auth-checks';
```

- [ ] **Step 2: Gate the page before any data access**

Immediately after `const { date: queryDate, start: queryStart, end: queryEnd } = await searchParams;` and **before** `const siteRepo = new SiteRepo();`, insert:

```ts
    const hasAccess = await verifySiteAccess(id);
    if (!hasAccess) {
        const user = await getCurrentUser();
        if (!user) {
            redirect(`/login?callback=${encodeURIComponent(`/site/${id}/usage`)}`);
        }
        return (
            <PageShell maxWidth="2xl" className="space-y-6">
                <PageHeader title="Estimated Monthly Bill" density="compact" />
                <SectionCard density="compact">
                    <p className="text-sm text-gray-600 dark:text-gray-300">Your account is not authorized for this site.</p>
                </SectionCard>
            </PageShell>
        );
    }
```

(`PageShell`, `PageHeader`, `SectionCard` are already imported by the file — see its existing "Site not found" branch.)

- [ ] **Step 3: Lint and build**

Run: `npm run lint` then `npm run build`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git -C /Users/kevm/github/pwusage add "cmd/next-app/src/app/site/[id]/usage/page.tsx"
git -C /Users/kevm/github/pwusage commit -m "fix(sec): require site authorization on the usage page"
```

---

### Task 2: verifyUserStatus — transient errors must not deactivate; refresh must be fresh and locked

**Files:**
- Modify: `cmd/next-app/src/lib/user-repo.ts` (`verifyUserStatus` ~lines 147-201, `verifyAllUserStatuses` ~lines 203-246)
- Test: `cmd/next-app/src/lib/user-repo.test.ts`

Two defects, one rewrite: (a) the catch-all sets `is_active=false` for transient Tesla failures, locking the user out of the app; (b) the client is built from tokens bulk-read minutes earlier and refreshes without the per-user lock, burning rotated refresh tokens (`invalid_grant` → spurious revocation). The fix routes client construction through `createTeslaClientForSite` (fresh DB token read + locked refresh handler) via an injectable factory, and only deactivates on genuine auth errors.

- [ ] **Step 1: Write the failing tests**

Append to `user-repo.test.ts` (the `queryMock` harness and `UserRepo` import already exist at the top of the file):

```ts
import { TeslaAuthError } from './tesla-client';

describe('UserRepo.verifyUserStatus', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    const UPDATE_STATUS_SQL = 'UPDATE "User" SET auth_status = $1, is_active = $2, last_checked_at = NOW() WHERE id = $3';

    it('keeps the user active when Tesla fails transiently', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] }) // site lookup
            .mockResolvedValueOnce({ rows: [] });                 // updateUserStatus
        const repo = new UserRepo();
        const client = { getLiveStatus: vi.fn().mockRejectedValue(new Error('Tesla API Error: 503 upstream unavailable')) };
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => client as never });
        expect(result.status).toBe('error');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['error', true, 'u1']);
    });

    it('marks the user revoked and inactive on a terminal auth error', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] })
            .mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        const client = { getLiveStatus: vi.fn().mockRejectedValue(new TeslaAuthError('Tesla API Error: 401 invalid token', 401)) };
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => client as never });
        expect(result.status).toBe('revoked');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['revoked', false, 'u1']);
    });

    it('marks the user active on success', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] })
            .mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        const client = { getLiveStatus: vi.fn().mockResolvedValue({ percentage_charged: 50 }) };
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => client as never });
        expect(result.status).toBe('active');
        expect(client.getLiveStatus).toHaveBeenCalledWith('site-1');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['active', true, 'u1']);
    });

    it('marks no_token when the client factory finds no credentials', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 'site-1' }] })
            .mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => null });
        expect(result.status).toBe('no_token');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['no_token', false, 'u1']);
    });

    it('marks no_sites when the user has no sites', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [] })  // site lookup: none
            .mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        const result = await repo.verifyUserStatus({ id: 'u1' }, { createClient: async () => null });
        expect(result.status).toBe('no_sites');
        expect(queryMock).toHaveBeenCalledWith(UPDATE_STATUS_SQL, ['no_sites', false, 'u1']);
    });
});
```

Place the `import { TeslaAuthError } from './tesla-client';` with the other imports at the top of the test file, after the `vi.mock('./db', ...)` block.

- [ ] **Step 2: Run and verify the new tests fail**

Run: `npm test -- src/lib/user-repo --run`
Expected: the transient-error test FAILS (`updateUserStatus` called with `['error', false, 'u1']`), and the tests passing `{ createClient }` FAIL on signature (extra argument ignored, old code reads `user.access_token` — the transient/no_token tests receive wrong statuses). Pre-existing tests pass.

- [ ] **Step 3: Rewrite verifyUserStatus**

In `user-repo.ts`, replace the entire `verifyUserStatus` method with:

```ts
    async verifyUserStatus(
        user: Pick<User, 'id'>,
        deps?: { createClient?: (siteId: string) => Promise<Pick<TeslaClient, 'getLiveStatus'> | null> }
    ): Promise<{ status: string; error?: string }> {
        // Get user's sites to test with
        const sitesRes = await pool.query('SELECT id FROM "Site" WHERE user_id = $1 LIMIT 1', [user.id]);
        if (sitesRes.rows.length === 0) {
            // No sites - can't verify credentials
            await this.updateUserStatus(user.id, 'no_sites', false);
            return { status: 'no_sites' };
        }
        const siteId = sitesRes.rows[0].id;

        // Build the client through the site factory: it re-reads tokens fresh
        // from the DB at call time and wires the cross-instance locked refresh
        // handler. Verifying with tokens bulk-read minutes earlier and a raw
        // unlocked refresh can burn a rotated refresh token (invalid_grant)
        // and falsely revoke a healthy user.
        let createClient = deps?.createClient;
        if (!createClient) {
            const { createTeslaClientForSite } = await import('./tesla-client-factory');
            createClient = createTeslaClientForSite;
        }
        const client = await createClient(siteId);
        if (!client) {
            await this.updateUserStatus(user.id, 'no_token', false);
            return { status: 'no_token' };
        }

        try {
            await client.getLiveStatus(siteId);
            await this.updateUserStatus(user.id, 'active', true);
            return { status: 'active' };
        } catch (err: unknown) {
            console.error(`[UserRepo] Error checking user ${user.id}:`, err);
            const errorMsg = err instanceof Error ? err.message : String(err);

            if (isTeslaAuthError(err)) {
                await this.updateUserStatus(user.id, 'revoked', false);
                return { status: 'revoked', error: errorMsg };
            }

            // Transient failure (Tesla 5xx, network, exhausted 429 retries):
            // record it but do NOT deactivate — is_active=false blocks every
            // authenticated route and JWT refresh, locking the user out over
            // a blip. auth_status='error' keeps the user in the cron's
            // "troubled" bucket so it re-verifies next run.
            await this.updateUserStatus(user.id, 'error', true);
            return { status: 'error', error: errorMsg };
        }
    }
```

The `TeslaClient` and `isTeslaAuthError` imports already exist at the top of `user-repo.ts` (`import { TeslaClient, isTeslaAuthError } from './tesla-client';`). The dynamic import of `tesla-client-factory` avoids a static import cycle (`tesla-client-factory` imports `UserRepo`).

- [ ] **Step 4: Adjust verifyAllUserStatuses**

In `verifyAllUserStatuses`:
- Change `const users = await this.getAllUsers({ includeTokens: true });` to `const users = await this.getAllUsers();` — tokens are now read fresh inside the factory, and bulk-reading them was the staleness bug.
- Update the counting block so a transient `error` no longer counts as inactive:

Replace:

```ts
            const result = await this.verifyUserStatus(user);
            if (result.status === 'active') {
                activeCount++;
            } else if (result.status === 'error') {
                errorCount++;
                inactiveCount++;
            } else {
                inactiveCount++;
            }
```

with:

```ts
            const result = await this.verifyUserStatus(user);
            if (result.status === 'active') {
                activeCount++;
            } else if (result.status === 'error') {
                // Transient failure: user stays active; re-verified next run.
                errorCount++;
            } else {
                inactiveCount++;
            }
```

- [ ] **Step 5: Run the file — all pass**

Run: `npm test -- src/lib/user-repo --run`
Expected: PASS, including the pre-existing `getAllUsers` ordering test (it calls `getAllUsers()` with no options, unaffected).

- [ ] **Step 6: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/user-repo.ts cmd/next-app/src/lib/user-repo.test.ts
git -C /Users/kevm/github/pwusage commit -m "fix(cron): keep users active on transient Tesla errors and verify with fresh locked tokens"
```

---

### Task 3: getNextCycleStart helper (billing-cycle end anchored to the billing day)

**Files:**
- Modify: `cmd/next-app/src/lib/billing-cycle.ts`
- Test: `cmd/next-app/src/lib/billing-cycle.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `billing-cycle.test.ts` (add `getNextCycleStart` to the existing `./billing-cycle` import; `getSiteLocalDate` is already imported from `./date-utils`):

```ts
describe('getNextCycleStart', () => {
    it('constrains into a short month (Jan 31 → Feb 28)', () => {
        const start = getSiteLocalDate(2026, 1, 31, 'UTC');
        expect(getNextCycleStart(31, start, 'UTC')).toEqual(new Date(Date.UTC(2026, 1, 28)));
    });

    it('re-anchors to the full billing day after a constrained start (Feb 28 → Mar 31)', () => {
        // The Feb cycle for a day-31 anchor starts Feb 28 (constrained). The
        // next cycle must start Mar 31 — deriving it as "start + 1 month"
        // gave Mar 28 and left Mar 28-30 in no cycle at all.
        const start = getSiteLocalDate(2026, 2, 28, 'UTC');
        expect(getNextCycleStart(31, start, 'UTC')).toEqual(new Date(Date.UTC(2026, 2, 31)));
    });

    it('constrains into 30-day months (Mar 31 → Apr 30)', () => {
        const start = getSiteLocalDate(2026, 3, 31, 'UTC');
        expect(getNextCycleStart(31, start, 'UTC')).toEqual(new Date(Date.UTC(2026, 3, 30)));
    });

    it('rolls the year over (Dec 15 → Jan 15)', () => {
        const start = getSiteLocalDate(2026, 12, 15, 'UTC');
        expect(getNextCycleStart(15, start, 'UTC')).toEqual(new Date(Date.UTC(2027, 0, 15)));
    });

    it('treats falsy billingStartDay as 1', () => {
        const start = getSiteLocalDate(2026, 3, 1, 'UTC');
        expect(getNextCycleStart(0, start, 'UTC')).toEqual(new Date(Date.UTC(2026, 3, 1)));
    });

    it('returns site-local midnight for non-UTC sites', () => {
        // Feb 28 2026 00:00 PST = 08:00Z; next cycle start Mar 31 00:00 PDT = 07:00Z.
        const start = getSiteLocalDate(2026, 2, 28, 'America/Los_Angeles');
        expect(getNextCycleStart(31, start, 'America/Los_Angeles'))
            .toEqual(new Date(Date.UTC(2026, 2, 31, 7, 0, 0)));
    });
});
```

- [ ] **Step 2: Run and verify it fails to import**

Run: `npm test -- src/lib/billing-cycle --run`
Expected: FAIL — `getNextCycleStart` is not exported.

- [ ] **Step 3: Add the helper**

Append to `billing-cycle.ts` (after `getCurrentCycleStart`):

```ts
/**
 * Returns the start of the billing cycle FOLLOWING the one that starts at
 * `cycleStart`, re-anchored to the configured billing day.
 *
 * Billing cycles re-anchor every month: a day-31 anchor runs Jan 31 → Feb 28
 * → Mar 31. Deriving the end as `cycleStart + 1 month` propagates a short
 * month's constraint forward (Feb 28 + 1 month = Mar 28, not Mar 31), leaving
 * days that belong to no cycle. Instead, advance the month and re-apply the
 * original anchor day; getSiteLocalDate's overflow:'constrain' handles short
 * target months (Jan 31 → Feb 28).
 *
 * `cycleStart` must be an actual cycle start (e.g. from getCurrentCycleStart),
 * so its site-local month is the cycle's anchor month.
 */
export function getNextCycleStart(
    billingStartDay: number,
    cycleStart: Date,
    timeZone: string
): Date {
    const day = billingStartDay || 1;
    const instant = Temporal.Instant.from(cycleStart.toISOString());
    const zoned = instant.toZonedDateTimeISO(timeZone);
    let year = zoned.year;
    let month = zoned.month + 1;
    if (month > 12) {
        month = 1;
        year += 1;
    }
    return getSiteLocalDate(year, month, day, timeZone);
}
```

- [ ] **Step 4: Run the file — all pass**

Run: `npm test -- src/lib/billing-cycle --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/billing-cycle.ts cmd/next-app/src/lib/billing-cycle.test.ts
git -C /Users/kevm/github/pwusage commit -m "feat(billing): add getNextCycleStart anchored to the billing day"
```

---

### Task 4: Use getNextCycleStart at the three broken cycle-end call sites

**Files:**
- Modify: `cmd/next-app/src/lib/site-service.ts` (line ~218 + import)
- Modify: `cmd/next-app/src/app/api/trmnl/markup/route.ts` (line ~125 + imports)
- Modify: `cmd/next-app/src/app/site/[id]/usage/page.tsx` (lines ~60-80, ~117-118 + imports)

Depends on Task 3. These are page/route orchestration changes; the helper itself is unit-tested, and `site-service.test.ts` exercises `loadSitePageData` — run it after the change. If a site-service test fails by pinning a `start + 1 month` end for a late-month anchor, that expectation encodes the bug: verify against the re-anchoring rule (Feb 28 → Mar 31) before touching it, per the triage protocol.

- [ ] **Step 1: site-service.ts**

- In the import from `'./billing-cycle'`, add `getNextCycleStart`:
  `import { getCurrentCycleStart, getNextCycleStart } from './billing-cycle';`
- Replace `const end = addMonthsInSiteTimezone(start, 1, finalSite.timezone);` with:
  ```ts
  const end = getNextCycleStart(billingDay, start, finalSite.timezone);
  ```
- `prevDate` (line ~233, `addMonthsInSiteTimezone(start, -1, ...)`) stays: it is only a navigation *target date* that `getCurrentCycleStart` re-snaps on the destination page, and Feb 28 correctly resolves to the Feb cycle.
- `addMonthsInSiteTimezone` remains used by `prevDate` — keep its import.

- [ ] **Step 2: trmnl markup route**

In `src/app/api/trmnl/markup/route.ts`:
- Remove `import { addMonthsInSiteTimezone } from '@/lib/date-utils';` (line ~22 — it has no other use in the file; verify with a quick grep before deleting).
- Add `getNextCycleStart` to the existing `'@/lib/billing-cycle'` import next to `getCurrentCycleStart`.
- Replace `const cycleEnd = addMonthsInSiteTimezone(start, 1, site.timezone);` with:
  ```ts
  const cycleEnd = getNextCycleStart(site.billing_start_day || 1, start, site.timezone);
  ```

- [ ] **Step 3: usage page — specific-cycle and default branches**

In `src/app/site/[id]/usage/page.tsx`:

- Add `getNextCycleStart` to the billing-cycle import:
  `import { getCurrentCycleStart, getNextCycleStart } from '@/lib/billing-cycle';`

- Replace the `} else if (queryDate) {` branch (currently the 35-day-pivot block) with:

```ts
    } else if (queryDate) {
        // Specific Billing Cycle Mode: snap the requested date to the cycle
        // containing it, then end at the next cycle start. The billing day
        // re-anchors each month (Jan 31 → Feb 28 → Mar 31); deriving the end
        // from the query date's own day via a 35-day pivot overshot short
        // months (Jan 31 + 35d lands in March → a "one-month" bill spanning
        // Jan 31 – Mar 31).
        const [y, m, d] = queryDate.split('-').map(Number);
        const refDate = [y, m, d].every(Number.isFinite)
            ? getSiteLocalDate(y, m, d, site.timezone) // overflow constrains (2026-02-31 → Feb 28)
            : new Date();
        start = getCurrentCycleStart(site.billing_start_day, refDate, site.timezone);
        end = getNextCycleStart(site.billing_start_day, start, site.timezone);
    } else {
```

- Replace the default (`} else {`) branch body with the equivalent, simpler form:

```ts
    } else {
        // Default to Current Billing Cycle (computed in the site's timezone).
        const now = new Date();
        start = getCurrentCycleStart(site.billing_start_day, now, site.timezone);
        end = getNextCycleStart(site.billing_start_day, start, site.timezone);
    }
```

- Replace `const nextDate = addMonthsInSiteTimezone(start, 1, site.timezone);` (line ~118) with:

```ts
    const nextDate = getNextCycleStart(site.billing_start_day, start, site.timezone);
```

- `prevDate` (`addMonthsInSiteTimezone(start, -1, ...)`) stays, same reasoning as site-service. Keep the `addMonthsInSiteTimezone` import.
- If the `Temporal` import at the top of the file is now only used by the local `getSiteLocalComponents` helper (lines ~94-102), it stays — do not remove it.

- [ ] **Step 4: Run affected suites + lint + build**

Run: `npm test -- src/lib/site-service src/lib/billing-cycle src/lib/trmnl --run`
Expected: PASS (see triage note in the task header if a site-service expectation pins the old end math).
Run: `npm run lint` then `npm run build` — expected clean (the page and route have no unit tests; lint+build are their gate).

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/site-service.ts cmd/next-app/src/app/api/trmnl/markup/route.ts "cmd/next-app/src/app/site/[id]/usage/page.tsx"
git -C /Users/kevm/github/pwusage commit -m "fix(billing): derive cycle ends from the billing-day anchor, not start+1mo"
```

---

### Task 5: Remove the ×1000 day-aggregate scaling and repair the poisoned rows

**Files:**
- Modify: `cmd/next-app/src/lib/importer/energy-transformer.ts`
- Modify: `cmd/next-app/src/lib/importer/energy-transformer.test.ts`
- Modify: `cmd/next-app/src/lib/importer/index.ts` (`processHistory` + two call sites)
- Modify: `cmd/next-app/src/lib/importer.test.ts` (one reflection-based test, ~lines 256-312)
- Create: `cmd/next-app/db-migrations/<timestamp>_repair_x1000_scaled_energy_rows.sql`

Rationale (see the Bug 5 context bullet): the 2026-07-12 DB audit found the ×1000 branch has never matched a real day aggregate — single-day requests (the only kind this importer makes) never return them — and produced exactly 85 poisoned rows before the Apr 27 short-window guard. Remove the scaling and its dead plumbing; repair the rows by migration.

- [ ] **Step 1: Write the failing test**

Append to `energy-transformer.test.ts` inside the existing `describe('transformEnergyPoints', ...)` block (the `makeEntry` helper and `CONTEXT` const already exist). Note it uses the NEW 3-argument signature:

```ts
    it('never scales values — single-day Tesla requests return Wh samples, not kWh aggregates', () => {
        // 2026-07-12 DB audit: the ×1000 "day aggregate" path never matched a
        // real aggregate (single-day requests never return day totals) and
        // produced 85 poisoned rows from lone / day-spaced 5-minute samples
        // (e.g. an install day going live at 23:50). Scaling is removed.
        const lone = [makeEntry({ total_home_usage: 150, timestamp: '2026-01-10T23:50:00.000Z' })];
        expect(transformEnergyPoints(lone, [], CONTEXT)[0].load_power).toBe(150);

        const daySpaced = [
            makeEntry({ total_home_usage: 64, timestamp: '2026-01-10T00:00:00.000Z' }),
            makeEntry({ total_home_usage: 64, timestamp: '2026-01-11T00:00:00.000Z' }),
        ];
        const rows = transformEnergyPoints(daySpaced, [], CONTEXT);
        expect(rows[0].load_power).toBe(64);
        expect(rows[1].load_power).toBe(64);
    });
```

- [ ] **Step 2: Run and verify it fails**

Run: `npm test -- src/lib/importer/energy-transformer --run`
Expected: FAIL — the 3-argument call does not match the current 5-parameter signature (type error / `CONTEXT` lands in `period`), and behaviorally the values would be ×1000. All pre-existing tests pass.

- [ ] **Step 3: Remove the scaling from the transformer**

In `energy-transformer.ts`:

- Change the signature to drop the two now-dead parameters:

```ts
export function transformEnergyPoints(
    history: EnergyHistoryEntry[],
    soeHistory: SoeHistoryEntry[],
    context: TransformContext
): EnergyDataRow[] {
```

- Delete the `durationHours` computation block (the `let durationHours = 24;` declaration and both neighbor-spacing `if`/`else if` branches — it existed only to feed the scale decision) and the scaling block:

```ts
        const shouldScaleDailyAggregate =
            period === 'day' && requestedDurationHours > 20 && durationHours > 20;
        const scale = shouldScaleDailyAggregate ? 1000 : 1;
```

- Remove the `* scale` factor from the four `results.push` fields, leaving:

```ts
            load_power: hHome,
            solar_power: hSolar,
            grid_power: grid,
            battery_power: battery,
```

- [ ] **Step 4: Update the transformer's own tests to the new signature**

In `energy-transformer.test.ts`:

- Delete these two now-obsolete tests entirely: `'scales load_power by 1000 for full-day aggregates (period=day, duration>20h)'` and `'does NOT scale for partial-day singleton (period=day, requestedDurationHours<=20)'` (both are superseded by the Step 1 test).
- In every remaining test, replace the 5-argument calls with 3-argument calls — mechanically drop the two middle scalars:
  - `transformEnergyPoints(history, [], 'day', 1, CONTEXT)` → `transformEnergyPoints(history, [], CONTEXT)` (and the `'day', 1, ctx` variants likewise)
  - `transformEnergyPoints(charge, [], 'day', 1, CONTEXT)[0]` → `transformEnergyPoints(charge, [], CONTEXT)[0]` (same for `discharge`)
  - `transformEnergyPoints([makeEntry()], [], 'day', 1, ctx)` → `transformEnergyPoints([makeEntry()], [], ctx)`
  - the SoC tests' `..., soeHistory, 'day', 1, CONTEXT)` → `..., soeHistory, CONTEXT)`

- [ ] **Step 5: Drop the dead plumbing in the Importer**

In `src/lib/importer/index.ts`:

- `processHistory` loses `period` and `requestedDurationHours`:

```ts
    private async processHistory(
        site: SiteWithTariffs,
        history: EnergyHistoryEntry[],
        soeHistory: SoeHistoryEntry[]
    ): Promise<EnergyDataRow[]> {
        const schedule = new Schedule(site.tariffs, site.timezone);
        return transformEnergyPoints(history, soeHistory, {
            siteId: site.id,
```

(the rest of the method is unchanged).

- In `fetchRange`, the call collapses to:

```ts
                const rows = await this.processHistory(site, history, soeHistory);
```

- In `loadInterval`, the call collapses to:

```ts
            const energyDatas = await this.processHistory(site, history, soeHistory);
```

(`period` remains a parameter of `fetchRange`/`loadInterval`/`importRange` — it is still sent to the Tesla API — it just no longer feeds the transformer.)

- [ ] **Step 6: Update the reflection-based test in importer.test.ts**

The test `'does not multiply partial-day singleton history rows by 1000'` (~lines 256-312) calls `processHistory` through a cast with the old 5-parameter shape. Keep it as a regression test; update the cast and call:

```ts
        const rows = await (importer as unknown as {
            processHistory: (
                siteArg: typeof site,
                history: EnergyHistoryEntry[],
                soeHistory: []
            ) => Promise<Array<{ load_power: number; grid_power: number }>>;
        }).processHistory(site, singletonHistory, []);
```

and rename the test to `'does not multiply singleton history rows by 1000'` (the partial-day qualifier no longer means anything).

- [ ] **Step 7: Run the importer suites — all pass**

Run: `npm test -- src/lib/importer --run`
Expected: PASS (importer.test.ts and the three importer/ module suites; the Step 1 test now passes).

- [ ] **Step 8: Write the repair migration for the 85 poisoned rows**

Create the file (from `cmd/next-app`):

```bash
touch db-migrations/$(date +%Y%m%d_%H%M%S)_repair_x1000_scaled_energy_rows.sql
```

with content:

```sql
-- Repair EnergyData rows that the importer multiplied by 1000 after
-- misclassifying lone 5-minute Wh samples as whole-day kWh aggregates
-- (fixed for short windows by the 2026-04-27 requestedDurationHours guard;
-- the scaling itself is removed entirely in this PR).
--
-- Audit (2026-07-12): 85 affected rows, 2026-02-19 .. 2026-04-27, all at
-- site-local midnight. Every affected row has a field > 20 kWh, and no
-- legitimate row anywhere sits in the 5-20 kWh band, so the threshold
-- separates poison from real data with zero collateral. A real 5-minute
-- sample cannot exceed 20 kWh (that is 240 kW sustained). All four energy
-- fields of an affected row were scaled together, so dividing by 1000
-- restores the original values exactly (battery_soc was never scaled).
--
-- Idempotent: after one pass no affected field exceeds the threshold
-- (max observed post-repair value ~1,068 Wh), so a re-run matches nothing.
UPDATE "EnergyData"
SET load_power    = load_power / 1000,
    solar_power   = solar_power / 1000,
    grid_power    = grid_power / 1000,
    battery_power = battery_power / 1000
WHERE timestamp < '2026-04-28T00:00:00Z'
  AND (load_power > 20000
       OR solar_power > 20000
       OR ABS(grid_power) > 20000
       OR ABS(battery_power) > 20000);
```

Do NOT run this against the `.env` `DATABASE_URL`; CI tests migrations against a prod backup on PR, and they run on merge.

- [ ] **Step 9: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/importer/energy-transformer.ts cmd/next-app/src/lib/importer/energy-transformer.test.ts cmd/next-app/src/lib/importer/index.ts cmd/next-app/src/lib/importer.test.ts cmd/next-app/db-migrations/
git -C /Users/kevm/github/pwusage commit -m "fix(importer): remove x1000 day-aggregate scaling and repair poisoned rows"
```

---

### Task 6: Clamp getUsageByTOU splitPoint to the requested range

**Files:**
- Modify: `cmd/next-app/src/lib/energy-repo.ts` (splitPoint, line ~167)
- Test: `cmd/next-app/src/lib/energy-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `energy-repo.test.ts` (`SiteRepo`/`TariffRepo` are already imported; mirror the spy pattern of the existing `getUsageByTOU historical name resolution` describe):

```ts
describe('EnergyRepo.getUsageByTOU range clamping', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('does not fetch raw rows from before a future cycle start', async () => {
        const repo = new EnergyRepo();
        vi.spyOn(SiteRepo.prototype, 'getSite').mockResolvedValue({
            id: 'site-1', user_id: 'u1', name: 'Home', utility: 'PG&E',
            updated: new Date(), installed: new Date('2026-01-01T00:00:00Z'),
            timezone: 'UTC', billing_start_day: 1, tariffs: [],
        } as never);
        vi.spyOn(TariffRepo.prototype, 'getTariffsForSite').mockResolvedValue([] as never);
        vi.spyOn(TariffRepo.prototype, 'getSchedulesForSite').mockResolvedValue([] as never);
        const aggSpy = vi.spyOn(repo, 'getCycleAggregates').mockResolvedValue([] as never);
        const rawSpy = vi.spyOn(repo, 'getRawEnergyData').mockResolvedValue([] as never);

        // A cycle entirely in the future: splitPoint must not drop below start,
        // or the raw pass fetches [todayMidnight, end) — rows preceding the cycle.
        const start = new Date(Date.now() + 30 * 24 * 3600 * 1000);
        const end = new Date(Date.now() + 60 * 24 * 3600 * 1000);
        await repo.getUsageByTOU('site-1', start, end);

        expect(aggSpy).toHaveBeenCalledWith('site-1', start, start);
        expect(rawSpy).toHaveBeenCalledWith('site-1', start, end);
    });
});
```

Add `afterEach` to the vitest import at the top of the file if it is not already there.

- [ ] **Step 2: Run and verify it fails**

Run: `npm test -- src/lib/energy-repo --run`
Expected: the new test FAILS — `getRawEnergyData` was called with today's site-midnight as its range start instead of the future `start`.

- [ ] **Step 3: Clamp the split point**

In `getUsageByTOU`, replace:

```ts
        // Calculate site-local "today" boundary and split point
        const now = new Date();
        const todayStart = EnergyRepo.getSiteMidnight(now, site.timezone);
        const splitPoint = todayStart < end ? todayStart : end;
```

with:

```ts
        // Calculate site-local "today" boundary and split point, clamped to
        // [start, end]. Without the lower clamp, a request for a cycle that
        // starts in the future fetches raw rows from today's midnight up to
        // `end` — rows that precede the requested range.
        const now = new Date();
        const todayStart = EnergyRepo.getSiteMidnight(now, site.timezone);
        const splitPoint = new Date(
            Math.max(start.getTime(), Math.min(todayStart.getTime(), end.getTime()))
        );
```

- [ ] **Step 4: Run the file — all pass**

Run: `npm test -- src/lib/energy-repo --run`
Expected: PASS, including the pre-existing historical-name-resolution tests (their ranges are entirely in the past: `min(todayStart, end) = end`, `max(start, end) = end` — identical split as before).

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/energy-repo.ts cmd/next-app/src/lib/energy-repo.test.ts
git -C /Users/kevm/github/pwusage commit -m "fix(energy): clamp getUsageByTOU split point to the requested range"
```

---

### Task 7: Analysis route — authorize before revealing site existence

**Files:**
- Modify: `cmd/next-app/src/app/api/site/[id]/analysis/route.ts` (GET handler, lines ~28-72)

Currently the GET handler runs `siteRepo.getSite(siteId)` and returns 404 before checking the `site_auth` cookie, so unauthenticated callers can probe which site ids exist (404 = absent, 401 = present). Move the auth block first. No route test exists; the gate is lint + build (the auth code itself is unchanged, only re-ordered).

- [ ] **Step 1: Reorder the GET handler**

Inside `GET`, immediately after:

```ts
        const { id: siteId } = await params;
        const searchParams = request.nextUrl.searchParams;
        const dateParam = searchParams.get('date');
        const tzParam = searchParams.get('tz');
```

move the entire `// AUTH CHECK` block (the `cookies`/`SiteService` dynamic imports, the `siteAuthToken` read, the `validateSiteAccess` 403 branch, and the `401` else branch) so it runs next, **before** `const site = await siteRepo.getSite(siteId);`. The moved block is verbatim:

```ts
        // AUTH CHECK
        const { cookies } = await import('next/headers');
        const { SiteService } = await import('@/lib/site-service');

        const cookieStore = await cookies();
        const siteAuthToken = cookieStore.get('site_auth')?.value;
        if (siteAuthToken) {
            // Validate access to THIS specific site
            const siteService = new SiteService({ siteRepo, siteAuthToken });
            if (!await siteService.validateSiteAccess(siteId)) {
                return NextResponse.json({ error: 'Unauthorized site access' }, { status: 403 });
            }
        } else {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
```

Then the site fetch, timezone/date derivation (`const tz = tzParam || site.timezone;` needs `site`, so it stays after the fetch), and the rest follow unchanged. Concretely, the post-auth order is: `getSite` → 404 check → `tz`/`start`/`queryEnd`/`end` derivation → `Invalid date` 400 → auto-heal sync → the rest. Delete the now-duplicated original auth block further down.

- [ ] **Step 2: Lint and build**

Run: `npm run lint` then `npm run build`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git -C /Users/kevm/github/pwusage add "cmd/next-app/src/app/api/site/[id]/analysis/route.ts"
git -C /Users/kevm/github/pwusage commit -m "fix(sec): check analysis-route authorization before site existence"
```

---

### Task 8: Full verification + results log

**Files:**
- Create: `docs/superpowers/plans/2026-07-12-ingestion-cron-bug-hunt-RESULTS.md`

- [ ] **Step 1: Run the full gate (from `cmd/next-app`)**

```bash
npm test
npm run lint
npm run build
```
Expected: all three pass. Fix anything they surface before proceeding.

- [ ] **Step 2: Write the results log**

Create `docs/superpowers/plans/2026-07-12-ingestion-cron-bug-hunt-RESULTS.md`:

```markdown
# Ingestion / Cron / Billing-Window Bug Hunt — Results (2026-07-12)

## Hunt scope
Data-ingestion and background-job layer: importer (index, import-planner,
energy-transformer, soc-interpolation), import-lock, today-refresh,
sync/import/analysis routes, cron routes (check-users, cleanup,
restore-reserve), energy-repo read/write paths, site-repo locks/claims,
tesla-client + factory + token-repo, user-repo, site-service, date-utils,
billing-cycle, plus the usage-page billing-window orchestration.
(Prior hunts covered: recommendation/analytics layer plan on 2026-07-07 —
still unexecuted; time/money date math in #103; live-status / TRMNL billing /
importer completeness in #98; routes+auth in #101/#102.)

## Bugs found and fixed
- /site/[id]/usage rendered without any authorization (IDOR): [outcome]
- check-users cron deactivated users on transient Tesla errors (app lockout): [outcome]
- check-users cron verified with stale bulk-read tokens + unlocked refresh
  (burned rotated refresh tokens → spurious revocations; plausible
  "daily reauth" mechanism): [outcome]
- Billing-cycle ends derived as start+1month / 35-day pivot (dropped days,
  stuck next-navigation, frozen TRMNL cycle totals, two-month "bills" for
  day>=29 anchors): [outcome]
- ×1000 "day aggregate" scaling only ever misfired (85 poisoned rows found in
  prod data, Feb 19 – Apr 27; no real aggregates exist for single-day
  requests): scaling removed, rows repaired by migration: [outcome]
- getUsageByTOU splitPoint ignored `start` (future cycles included today's
  rows): [outcome]
- Analysis route returned 404 before auth (site-id existence oracle): [outcome]

## Known issues documented, deliberately not changed
[copy the 9-item list from the plan's "Findings documented but deliberately
NOT changed" section, noting anything new observed while executing]

## Modules audited with no defects found
import-planner (auditDays/planImport/splitAtSiteMidnight), soc-interpolation,
import-lock, site-repo import-lock/live-refresh claims and upsert, tesla-client
fetch/401-refresh/429-backoff and formatDateWithTimezone (probed on Node 26:
midnight renders 00, GMT+0/GMT+5:30 offsets parse correctly),
tesla-client-factory, date-utils, billing-cycle.getCurrentCycleStart,
sync/import/cleanup/restore-reserve routes, today-refresh throttle+claim flow,
site-service auth flow.
```

Fill in the actual outcomes.

- [ ] **Step 3: Commit (plan + results)**

```bash
git -C /Users/kevm/github/pwusage add docs/superpowers/plans/2026-07-12-ingestion-cron-bug-hunt-fixes.md docs/superpowers/plans/2026-07-12-ingestion-cron-bug-hunt-RESULTS.md
git -C /Users/kevm/github/pwusage commit -m "docs: record ingestion/cron bug-hunt plan and results"
```

- [ ] **Step 4: Stop — do not push**

Report the branch name and a summary of confirmed bugs to the user. The user pushes and opens the PR.
