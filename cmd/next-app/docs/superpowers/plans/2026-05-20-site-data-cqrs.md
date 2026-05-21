# Site Data Access — CQRS Repository Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor all site-domain data access (Site, Tariff, EnergyData, User, TeslaToken, TrmnlInstallation) into a CQRS-pattern repository layer, eliminating raw `pool.query` outside `lib/*-repo.ts`. Mirrors PR #58.

**Architecture:** Single-class-per-aggregate repos with explicit `=== Queries ===` / `=== Commands ===` sections. New `TariffRepo` owns Tariff/TariffSeason/TariffSchedule. The Importer becomes orchestration over repo commands — no SQL.

**Tech Stack:** Next.js (App Router), TypeScript, Vitest, PostgreSQL (`pg` pool), strict TS.

**Spec:** [`2026-05-20-site-data-cqrs-design.md`](../specs/2026-05-20-site-data-cqrs-design.md)

---

## Model Assignment for Subagent-Driven Execution

| Task | Implementation Model | Validation Model |
|---|---|---|
| 1, 2, 3, 4, 5, 6, 8, 10, 11, 12 | Haiku | Sonnet |
| 7, 9 (Importer rewrites) | **Opus** (complex transactions + hot path) | Sonnet |

`subagent-driven-development` should be invoked with these per-task overrides.

---

## Proposed File Changes Map

**New files**
- `cmd/next-app/src/lib/tariff-repo.ts` — Tariff aggregate repo.
- `cmd/next-app/src/lib/tariff-repo.test.ts` — Unit tests.

**Modified repos**
- `cmd/next-app/src/lib/site-repo.ts` — labels + `getSiteJson`, `upsertSite`, `assignSiteToUser`; remove `getInstallationAndSite`.
- `cmd/next-app/src/lib/site-repo.test.ts` — new tests.
- `cmd/next-app/src/lib/energy-repo.ts` — labels + `getLatestTimestamp`, `insertEnergyDataBatch`.
- `cmd/next-app/src/lib/energy-repo.test.ts` — new tests.
- `cmd/next-app/src/lib/user-repo.ts` — fold free functions; labels; `getById`, `upsertOnTeslaAuth`, `updateTokens`.
- `cmd/next-app/src/lib/user-repo.test.ts` — new tests.
- `cmd/next-app/src/lib/tesla-token-repo.ts` — labels; delegate User UPDATEs to `UserRepo`.
- `cmd/next-app/src/lib/tesla-token-repo.test.ts` — adjusted mocks.
- `cmd/next-app/src/lib/load-tag-repo.ts` — labels only.
- `cmd/next-app/src/lib/announcement-repo.ts` — labels only.
- `cmd/next-app/src/lib/trmnl-installation-repo.ts` — `findByUuidWithSite`.
- `cmd/next-app/src/lib/trmnl-installation-repo.test.ts` — new test.

**Modified consumers**
- `cmd/next-app/src/app/profile/page.tsx` — `userRepo.getById`.
- `cmd/next-app/src/app/auth/tesla-callback/route.ts` — `userRepo.upsertOnTeslaAuth`, `siteRepo.assignSiteToUser`, `userRepo.getById`.
- `cmd/next-app/src/app/api/trmnl/markup/route.ts` — `trmnlInstallationRepo.findByUuidWithSite`.
- `cmd/next-app/src/app/products/page.tsx` — `userRepo.getTokens`.
- `cmd/next-app/src/app/api/site-live-data/route.ts` — `userRepo.getTokensForSite`.
- `cmd/next-app/src/app/site/[id]/live/page.tsx` — `userRepo.getTokensForSite`.
- `cmd/next-app/src/app/api/site/[id]/refresh-tariffs/route.ts` — `userRepo.getTokensForSite`.
- `cmd/next-app/src/app/api/trmnl/manage/route.ts` — `userRepo.getTokens`.
- `cmd/next-app/src/app/api/site/[id]/analysis/route.ts` — `userRepo.getTokensForSite`.
- `cmd/next-app/src/lib/today-refresh.ts` — `userRepo.getTokensForSite`.
- `cmd/next-app/src/lib/auth-checks.ts` — `userRepo.getTokensForSite`, `userRepo.isActive`.
- `cmd/next-app/src/lib/auth-jwt.ts` — `userRepo.isActive`.
- `cmd/next-app/src/lib/importer/index.ts` — pure orchestration over repos.

---

## Task 1: Apply CQRS section headers to existing repos (no method changes)

**Files:**
- Modify: `cmd/next-app/src/lib/site-repo.ts`
- Modify: `cmd/next-app/src/lib/energy-repo.ts`
- Modify: `cmd/next-app/src/lib/user-repo.ts`
- Modify: `cmd/next-app/src/lib/tesla-token-repo.ts`
- Modify: `cmd/next-app/src/lib/load-tag-repo.ts`
- Modify: `cmd/next-app/src/lib/announcement-repo.ts`

- [ ] **Step 1: Verify baseline tests pass**

Run: `npm run lint && npm test`
Expected: all green.

- [ ] **Step 2: Insert `// === Queries ===` and `// === Commands ===` headers**

In each repo class, add the two comment headers above the corresponding method groupings. Move no methods. Example for `site-repo.ts`:

```typescript
export class SiteRepo {
    // === Queries ===
    async getInstallationAndSite(...) { ... }
    async getSitesForUser(...) { ... }
    async getSitesWithTariffs(...) { ... }
    async getSite(...) { ... }
    private async loadSitesFromDB(...) { ... }
    private assembleFromRows(...) { ... }
    async getSiteIds() { ... }
    async getSites(...) { ... }

    // === Commands ===
    async updateSiteBillingDay(...) { ... }
    async updateSiteTimezoneDisplayMode(...) { ... }

    // (utilities)
    invalidateCache(siteId: string) { ... }
}
```

For `user-repo.ts`, place headers inside the `UserRepo` class only (free functions sit above the class for now — Task 2 folds them). Existing free function exports stay untouched in this commit.

For `tesla-token-repo.ts`, group as: Queries (`acquireRefreshLock`, `waitForTokenRefresh`), Commands (`updateSiteTokens`, `releaseRefreshLock`, `tokenRefreshHandlers`-factory unchanged).

For `load-tag-repo.ts`: Queries (`getLoadTags`), Commands (`addLoadTag`, `removeLoadTag`, `cleanupOldTags`).

For `announcement-repo.ts`: Queries (`getAll`, `getLatest`, `getById`), Commands (`create`, `update`, `delete`).

For `energy-repo.ts`: Queries (everything ending with a SELECT), Commands (`cleanupOldEnergyData`).

- [ ] **Step 3: Run lint + tests**

Run: `npm run lint && npm test`
Expected: all green; zero diff in pass count.

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/site-repo.ts cmd/next-app/src/lib/energy-repo.ts cmd/next-app/src/lib/user-repo.ts cmd/next-app/src/lib/tesla-token-repo.ts cmd/next-app/src/lib/load-tag-repo.ts cmd/next-app/src/lib/announcement-repo.ts
git commit -m "refactor(repos): add Queries/Commands section headers"
```

---

## Task 2: Fold UserRepo free functions into the class

**Files:**
- Modify: `cmd/next-app/src/lib/user-repo.ts`
- Modify: `cmd/next-app/src/lib/user-repo.test.ts`
- Modify: `cmd/next-app/src/app/products/page.tsx`
- Modify: `cmd/next-app/src/app/api/site-live-data/route.ts`
- Modify: `cmd/next-app/src/app/site/[id]/live/page.tsx`
- Modify: `cmd/next-app/src/app/api/site/[id]/refresh-tariffs/route.ts`
- Modify: `cmd/next-app/src/app/api/trmnl/manage/route.ts`
- Modify: `cmd/next-app/src/app/api/site/[id]/analysis/route.ts`
- Modify: `cmd/next-app/src/lib/today-refresh.ts`
- Modify: `cmd/next-app/src/lib/auth-checks.ts`
- Modify: `cmd/next-app/src/lib/auth-jwt.ts`

- [ ] **Step 1: Write failing tests for new class methods**

Append to `cmd/next-app/src/lib/user-repo.test.ts`:

```typescript
describe('UserRepo class methods (folded from module functions)', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('getByAccessToken returns user row', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ id: 'u1', email: 'a@b.c', roles: ['user'] }] });
        const repo = new UserRepo();
        const result = await repo.getByAccessToken('tok-123');
        expect(result?.id).toBe('u1');
        expect(queryMock).toHaveBeenCalledWith(
            'SELECT id, email, roles FROM "User" WHERE access_token = $1',
            ['tok-123']
        );
    });

    it('getByAccessToken returns null on no rows', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        const result = await repo.getByAccessToken('nope');
        expect(result).toBeNull();
    });

    it('getTokens returns access + refresh tokens', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{ access_token: 'a', refresh_token: 'r' }]
        });
        const repo = new UserRepo();
        const result = await repo.getTokens('u1');
        expect(result).toEqual({ access_token: 'a', refresh_token: 'r' });
        expect(queryMock).toHaveBeenCalledWith(
            'SELECT access_token, refresh_token FROM "User" WHERE id = $1',
            ['u1']
        );
    });

    it('getTokensForSite joins User and Site', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{ access_token: 'a', refresh_token: 'r', user_id: 'u1' }]
        });
        const repo = new UserRepo();
        const result = await repo.getTokensForSite('site-1');
        expect(result?.user_id).toBe('u1');
        expect(queryMock.mock.calls[0][0]).toContain('FROM "User" u');
        expect(queryMock.mock.calls[0][0]).toContain('JOIN "Site" s ON s.user_id = u.id');
        expect(queryMock.mock.calls[0][1]).toEqual(['site-1']);
    });

    it('isActive returns true when is_active is true', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ is_active: true }] });
        const repo = new UserRepo();
        expect(await repo.isActive('u1')).toBe(true);
    });

    it('isActive returns false when no row found', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        expect(await repo.isActive('missing')).toBe(false);
    });
});
```

- [ ] **Step 2: Verify the new tests fail**

Run: `npx vitest run src/lib/user-repo.test.ts`
Expected: FAIL — `repo.getByAccessToken is not a function` (etc).

- [ ] **Step 3: Fold functions into class; keep `isUserActive` as a thin `cache()`'d wrapper**

Edit `cmd/next-app/src/lib/user-repo.ts`. Replace the entire file's top section:

```typescript
import { cache } from 'react';
import { pool, User, Site } from './db';
import { TeslaClient } from './tesla-client';

export interface UserWithSites extends User {
    sites: Site[];
    has_trmnl_integration?: boolean;
}

export class UserRepo {
    // === Queries ===
    async getAllUsers(options: { includeTokens?: boolean } = {}): Promise<UserWithSites[]> {
        // ...existing implementation unchanged...
    }

    async getByAccessToken(token: string): Promise<{ id: string; email?: string; roles?: string[] } | null> {
        const res = await pool.query('SELECT id, email, roles FROM "User" WHERE access_token = $1', [token]);
        if (res.rows.length === 0) return null;
        return res.rows[0];
    }

    async getTokens(userId: string): Promise<{ access_token: string; refresh_token: string } | null> {
        const res = await pool.query('SELECT access_token, refresh_token FROM "User" WHERE id = $1', [userId]);
        if (res.rows.length === 0) return null;
        return res.rows[0];
    }

    async getTokensForSite(siteId: string): Promise<{ access_token: string; refresh_token: string; user_id: string } | null> {
        const res = await pool.query(`
            SELECT u.access_token, u.refresh_token, u.id as user_id
            FROM "User" u
            JOIN "Site" s ON s.user_id = u.id
            WHERE s.id = $1
        `, [siteId]);
        if (res.rows.length === 0) return null;
        return res.rows[0];
    }

    async isActive(userId: string): Promise<boolean> {
        const res = await pool.query('SELECT is_active FROM "User" WHERE id = $1', [userId]);
        return res.rows.length > 0 && res.rows[0].is_active === true;
    }

    async getUserEmail(userId: string): Promise<string | null> {
        const res = await pool.query('SELECT email FROM "User" WHERE id = $1', [userId]);
        return res.rows.length > 0 ? res.rows[0].email : null;
    }

    async verifyUserStatus(user: User): Promise<{ status: string; error?: string }> {
        // ...existing implementation unchanged for now (will be touched in Task 9)...
    }

    async verifyAllUserStatuses() {
        // ...existing implementation unchanged...
    }

    // === Commands ===
    async updateUserEmail(userId: string, email: string): Promise<void> {
        await pool.query('UPDATE "User" SET email = $1 WHERE id = $2', [email, userId]);
    }

    async updateUserStatus(userId: string, authStatus: string, isActive: boolean) {
        await pool.query(
            'UPDATE "User" SET auth_status = $1, is_active = $2, last_checked_at = NOW() WHERE id = $3',
            [authStatus, isActive, userId]
        );
    }

    async updateLastChecked(userId: string) {
        await pool.query(
            'UPDATE "User" SET last_checked_at = NOW() WHERE id = $1',
            [userId]
        );
    }
}

// Backwards-compat thin wrappers — required because callers used these from
// import-time React Server Component context. The wrapper for `isUserActive`
// preserves React's per-request cache identity.
export const isUserActive = cache(async (userId: string): Promise<boolean> => {
    const repo = new UserRepo();
    return repo.isActive(userId);
});
```

**Important:** delete the four old `export async function getUserByToken / getUserTokens / getUserTokensForSite` functions and the old `isUserActive = cache(...)` block. Keep the `cache()`'d `isUserActive` re-export shown above.

- [ ] **Step 4: Update callers (10 files)**

For each of the call sites listed in the file map for this task, replace:

| Before | After |
|---|---|
| `import { getUserByToken } from '@/lib/user-repo'` | `import { UserRepo } from '@/lib/user-repo'` |
| `getUserByToken(token)` | `new UserRepo().getByAccessToken(token)` |
| `getUserTokens(id)` | `new UserRepo().getTokens(id)` |
| `getUserTokensForSite(id)` | `new UserRepo().getTokensForSite(id)` |
| `isUserActive(id)` | unchanged — keep the `isUserActive` import (it's still exported) |

Exact files to update (grep these and replace per the table):

- `src/app/products/page.tsx`
- `src/app/api/site-live-data/route.ts`
- `src/app/site/[id]/live/page.tsx`
- `src/app/api/site/[id]/refresh-tariffs/route.ts`
- `src/app/api/trmnl/manage/route.ts` (uses dynamic `await import('@/lib/user-repo')` — switch the destructured import accordingly)
- `src/app/api/site/[id]/analysis/route.ts`
- `src/lib/today-refresh.ts`
- `src/lib/auth-checks.ts` (uses `getUserTokensForSite` and `isUserActive` — leave `isUserActive` import alone)
- `src/lib/auth-jwt.ts` (uses `isUserActive` via dynamic import — leave alone)

- [ ] **Step 5: Run tests + lint + build**

Run: `npm test && npm run lint && npm run build`
Expected: all green. Existing tests + the new ones from Step 1 pass.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/user-repo.ts cmd/next-app/src/lib/user-repo.test.ts cmd/next-app/src/app cmd/next-app/src/lib/today-refresh.ts cmd/next-app/src/lib/auth-checks.ts cmd/next-app/src/lib/auth-jwt.ts
git commit -m "refactor(user-repo): fold module functions into class; keep cached isUserActive wrapper"
```

---

## Task 3: Add UserRepo `getById`, `upsertOnTeslaAuth`, `updateTokens` commands

**Files:**
- Modify: `cmd/next-app/src/lib/user-repo.ts`
- Modify: `cmd/next-app/src/lib/user-repo.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `cmd/next-app/src/lib/user-repo.test.ts`:

```typescript
describe('UserRepo new commands', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('getById returns full user row', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [{ id: 'u1', email: 'a@b.c', roles: ['admin'], is_active: true }]
        });
        const repo = new UserRepo();
        const result = await repo.getById('u1');
        expect(result?.email).toBe('a@b.c');
        expect(queryMock).toHaveBeenCalledWith(
            'SELECT * FROM "User" WHERE id = $1',
            ['u1']
        );
    });

    it('getById returns null when not found', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        expect(await repo.getById('nope')).toBeNull();
    });

    it('upsertOnTeslaAuth issues INSERT ... ON CONFLICT', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        const expiresAt = Date.now() + 3600_000;
        await repo.upsertOnTeslaAuth({
            userId: 'u1',
            email: 'a@b.c',
            accessToken: 'at',
            refreshToken: 'rt',
            tokenExpiresAt: expiresAt,
        });
        expect(queryMock.mock.calls[0][0]).toContain('INSERT INTO "User"');
        expect(queryMock.mock.calls[0][0]).toContain('ON CONFLICT (id) DO UPDATE');
        expect(queryMock.mock.calls[0][1]).toEqual(['u1', 'a@b.c', 'at', 'rt', expiresAt]);
    });

    it('updateTokens updates access and refresh tokens', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new UserRepo();
        await repo.updateTokens('u1', 'newA', 'newR');
        expect(queryMock).toHaveBeenCalledWith(
            'UPDATE "User" SET access_token = $1, refresh_token = $2 WHERE id = $3',
            ['newA', 'newR', 'u1']
        );
    });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run src/lib/user-repo.test.ts`
Expected: FAIL — methods not implemented.

- [ ] **Step 3: Implement the three new methods**

In `cmd/next-app/src/lib/user-repo.ts`, add to the `UserRepo` class:

Under `// === Queries ===`:

```typescript
async getById(userId: string): Promise<User | null> {
    const res = await pool.query('SELECT * FROM "User" WHERE id = $1', [userId]);
    if (res.rows.length === 0) return null;
    return res.rows[0] as User;
}
```

Under `// === Commands ===`:

```typescript
async upsertOnTeslaAuth(params: {
    userId: string;
    email: string | null;
    accessToken: string;
    refreshToken: string;
    tokenExpiresAt: number;
}): Promise<void> {
    await pool.query(`
        INSERT INTO "User" (id, email, access_token, refresh_token, token_expires_at, auth_status, is_active)
        VALUES ($1, $2, $3, $4, $5, 'active', true)
        ON CONFLICT (id) DO UPDATE SET
            access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token,
            email = COALESCE(EXCLUDED.email, "User".email),
            auth_status = 'active',
            is_active = true
    `, [params.userId, params.email, params.accessToken, params.refreshToken, params.tokenExpiresAt]);
}

async updateTokens(userId: string, accessToken: string, refreshToken: string): Promise<void> {
    await pool.query(
        'UPDATE "User" SET access_token = $1, refresh_token = $2 WHERE id = $3',
        [accessToken, refreshToken, userId]
    );
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/user-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Run lint + build**

Run: `npm run lint && npm run build`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/user-repo.ts cmd/next-app/src/lib/user-repo.test.ts
git commit -m "feat(user-repo): add getById, upsertOnTeslaAuth, updateTokens"
```

---

## Task 4: Add SiteRepo `assignSiteToUser`, `upsertSite`, `getSiteJson` commands

**Files:**
- Modify: `cmd/next-app/src/lib/site-repo.ts`
- Modify: `cmd/next-app/src/lib/site-repo.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `cmd/next-app/src/lib/site-repo.test.ts`:

```typescript
describe('SiteRepo new commands and queries', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('assignSiteToUser updates Site.user_id', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new SiteRepo();
        await repo.assignSiteToUser('site-1', 'user-1');
        expect(queryMock).toHaveBeenCalledWith(
            'UPDATE "Site" SET user_id = $1 WHERE id = $2',
            ['user-1', 'site-1']
        );
    });

    it('getSiteJson returns parsed json blob', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ json: { site_name: 'Home' } }] });
        const repo = new SiteRepo();
        const result = await repo.getSiteJson('site-1');
        expect(result).toEqual({ site_name: 'Home' });
        expect(queryMock).toHaveBeenCalledWith(
            'SELECT json FROM "Site" WHERE id = $1',
            ['site-1']
        );
    });

    it('getSiteJson returns null when row missing', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new SiteRepo();
        expect(await repo.getSiteJson('missing')).toBeNull();
    });

    it('upsertSite issues INSERT ... ON CONFLICT', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new SiteRepo();
        const installed = new Date('2024-01-01T00:00:00Z');
        await repo.upsertSite({
            id: 'site-1',
            name: 'Home',
            utility: 'PG&E',
            installed,
            timezone: 'America/Chicago',
            json: { foo: 'bar' },
        });
        const [sql, args] = queryMock.mock.calls[0];
        expect(sql).toContain('INSERT INTO "Site"');
        expect(sql).toContain('ON CONFLICT(id) DO UPDATE');
        expect(args).toEqual([
            'site-1', 'Home', 'PG&E', installed, 'America/Chicago', JSON.stringify({ foo: 'bar' })
        ]);
    });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run src/lib/site-repo.test.ts`
Expected: FAIL — methods not defined.

- [ ] **Step 3: Implement the three methods**

In `cmd/next-app/src/lib/site-repo.ts`, add inside `SiteRepo`:

Under `// === Queries ===`:

```typescript
async getSiteJson(siteId: string): Promise<unknown | null> {
    const res = await pool.query('SELECT json FROM "Site" WHERE id = $1', [siteId]);
    if (res.rows.length === 0) return null;
    return res.rows[0].json ?? null;
}
```

Under `// === Commands ===`:

```typescript
async assignSiteToUser(siteId: string, userId: string): Promise<void> {
    await pool.query('UPDATE "Site" SET user_id = $1 WHERE id = $2', [userId, siteId]);
    this.invalidateCache(siteId);
}

async upsertSite(params: {
    id: string;
    name: string;
    utility: string | null;
    installed: Date | string;
    timezone: string;
    json: unknown;
}): Promise<void> {
    await pool.query(`
        INSERT INTO "Site"(id, name, utility, updated, installed, timezone, json)
        VALUES ($1, $2, $3, NOW(), $4, $5, $6)
        ON CONFLICT(id) DO UPDATE SET
            name=EXCLUDED.name,
            utility=EXCLUDED.utility,
            installed=EXCLUDED.installed,
            timezone=EXCLUDED.timezone,
            json=EXCLUDED.json
    `, [params.id, params.name, params.utility, params.installed, params.timezone, JSON.stringify(params.json)]);
    this.invalidateCache(params.id);
}
```

- [ ] **Step 4: Run tests + lint + build**

Run: `npm test && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/site-repo.ts cmd/next-app/src/lib/site-repo.test.ts
git commit -m "feat(site-repo): add assignSiteToUser, upsertSite, getSiteJson"
```

---

## Task 5: Switch `profile/page.tsx` and `auth/tesla-callback/route.ts` to repos

**Files:**
- Modify: `cmd/next-app/src/app/profile/page.tsx`
- Modify: `cmd/next-app/src/app/auth/tesla-callback/route.ts`

- [ ] **Step 1: Replace raw SQL in `profile/page.tsx`**

Locate the block around line 53:

```typescript
const userRes = await pool.query('SELECT * FROM "User" WHERE id = $1', [firstSite.user_id]);
const user = userRes.rows[0];
```

Replace with:

```typescript
const user = await new UserRepo().getById(firstSite.user_id);
```

Update imports at the top of `profile/page.tsx`:
- Remove the `import { pool } from '@/lib/db'` line if it was only used for that query (verify with grep before removing).
- Add `import { UserRepo } from '@/lib/user-repo'`.

- [ ] **Step 2: Replace raw SQL in `auth/tesla-callback/route.ts`**

In `cmd/next-app/src/app/auth/tesla-callback/route.ts`:

Add at the top:
```typescript
import { UserRepo } from '@/lib/user-repo';
import { SiteRepo } from '@/lib/site-repo';
```

Replace the User upsert (lines ~360-369):

```typescript
const userRepo = new UserRepo();
await userRepo.upsertOnTeslaAuth({
    userId,
    email: userEmail,
    accessToken: authData.access_token,
    refreshToken: authData.refresh_token,
    tokenExpiresAt: Date.now() + (authData.expires_in * 1000),
});
```

Replace the roles SELECT (lines ~372-373):

```typescript
const userRow = await userRepo.getById(userId);
const roles = (userRow as { roles?: string[] } | null)?.roles ?? [];
```

Replace the Site user_id UPDATE (line ~388):

```typescript
await new SiteRepo().assignSiteToUser(siteId, userId);
```

Remove the `pool` import from the top of the route if no other usages remain (`grep "pool" cmd/next-app/src/app/auth/tesla-callback/route.ts`).

- [ ] **Step 3: Run lint + build**

Run: `npm run lint && npm run build`
Expected: green.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: green (no test for these routes exists; ensure no regression elsewhere).

- [ ] **Step 5: Manual smoke verification**

Start dev server and manually verify the Tesla OAuth callback flow (the engineer should hit `/login`, complete Tesla OAuth, and confirm the redirect to `/products` succeeds). If a real Tesla account is not available, this step is documented and deferred to PR review.

```bash
npm run dev
# open http://localhost:5173/login in browser; complete OAuth
```

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/app/profile/page.tsx cmd/next-app/src/app/auth/tesla-callback/route.ts
git commit -m "refactor: route profile + tesla-callback through UserRepo/SiteRepo"
```

---

## Task 6: Create `TariffRepo` (queries + transactional `replaceTariffsForSite`)

**Files:**
- Create: `cmd/next-app/src/lib/tariff-repo.ts`
- Create: `cmd/next-app/src/lib/tariff-repo.test.ts`

- [ ] **Step 1: Write the failing test skeleton**

Create `cmd/next-app/src/lib/tariff-repo.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, clientQueryMock, releaseMock, connectMock } = vi.hoisted(() => {
    const queryMock = vi.fn();
    const clientQueryMock = vi.fn();
    const releaseMock = vi.fn();
    const connectMock = vi.fn(async () => ({
        query: clientQueryMock,
        release: releaseMock,
    }));
    return { queryMock, clientQueryMock, releaseMock, connectMock };
});

vi.mock('./db', () => ({
    pool: {
        query: queryMock,
        connect: connectMock,
    }
}));

import { TariffRepo } from './tariff-repo';

describe('TariffRepo queries', () => {
    beforeEach(() => {
        queryMock.mockReset();
        clientQueryMock.mockReset();
        releaseMock.mockReset();
    });

    it('getTariffsForSite returns tariffs with seasons + schedules', async () => {
        queryMock.mockResolvedValueOnce({
            rows: [
                { tariff_id: 1, tariff_name: 'Plan', tariff_updated: new Date(), tariff_site_id: 'site-1',
                  season_id: 10, season_name: 'Summer', from_month: 6, from_day: 1, to_month: 9, to_day: 30,
                  season_buy_rate: 0.3, season_sell_rate: 0.1,
                  schedule_id: 100, schedule_name: 'On-Peak', schedule_buy_rate: 0.5, schedule_sell_rate: 0.1,
                  from_day_of_week: 1, from_hour: 16, from_minute: 0,
                  to_day_of_week: 5, to_hour: 21, to_minute: 0 }
            ]
        });
        const repo = new TariffRepo();
        const result = await repo.getTariffsForSite('site-1');
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Plan');
        expect(result[0].seasons?.[0].schedules?.[0].name).toBe('On-Peak');
        expect(queryMock.mock.calls[0][0]).toContain('FROM "Tariff" t');
        expect(queryMock.mock.calls[0][1]).toEqual(['site-1']);
    });
});

describe('TariffRepo replaceTariffsForSite', () => {
    beforeEach(() => {
        queryMock.mockReset();
        clientQueryMock.mockReset();
        releaseMock.mockReset();
    });

    it('wraps cascade DELETE + INSERT in a single transaction', async () => {
        // tariff id lookup, insert tariff, select inserted tariff id, season insert, season id lookup, schedule insert
        clientQueryMock
            .mockResolvedValueOnce({ rows: [] })               // BEGIN
            .mockResolvedValueOnce({ rows: [{ id: 7 }] })      // SELECT id FROM "Tariff"
            .mockResolvedValueOnce({ rows: [] })               // DELETE TariffSchedule
            .mockResolvedValueOnce({ rows: [] })               // DELETE TariffSeason
            .mockResolvedValueOnce({ rows: [] })               // DELETE Tariff
            .mockResolvedValueOnce({ rows: [] })               // INSERT Tariff
            .mockResolvedValueOnce({ rows: [{ id: 8 }] })      // SELECT tariff id
            .mockResolvedValueOnce({ rows: [] })               // INSERT TariffSeason
            .mockResolvedValueOnce({ rows: [{ id: 9 }] })      // SELECT season id
            .mockResolvedValueOnce({ rows: [] })               // INSERT TariffSchedule
            .mockResolvedValueOnce({ rows: [] });              // COMMIT

        const repo = new TariffRepo();
        await repo.replaceTariffsForSite('site-1', {
            name: 'Plan',
            seasons: [{
                name: 'Summer',
                from_month: 6, from_day: 1, to_month: 9, to_day: 30,
                buy_rate: 0.3, sell_rate: 0.1,
                schedules: [{
                    name: 'On-Peak',
                    buy_rate: 0.5, sell_rate: 0.1,
                    from_day_of_week: 1, from_hour: 16, from_minute: 0,
                    to_day_of_week: 5, to_hour: 21, to_minute: 0,
                }]
            }]
        });

        expect(connectMock).toHaveBeenCalledTimes(1);
        expect(clientQueryMock.mock.calls[0][0]).toBe('BEGIN');
        expect(clientQueryMock.mock.calls.at(-1)?.[0]).toBe('COMMIT');
        expect(releaseMock).toHaveBeenCalled();
    });

    it('rolls back on error and releases client', async () => {
        clientQueryMock
            .mockResolvedValueOnce({ rows: [] })          // BEGIN
            .mockRejectedValueOnce(new Error('boom'));    // SELECT id FROM "Tariff" — throws

        const repo = new TariffRepo();
        await expect(
            repo.replaceTariffsForSite('site-1', { name: 'Plan', seasons: [] })
        ).rejects.toThrow('boom');
        expect(clientQueryMock).toHaveBeenCalledWith('ROLLBACK');
        expect(releaseMock).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run src/lib/tariff-repo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `TariffRepo`**

Create `cmd/next-app/src/lib/tariff-repo.ts`:

```typescript
import { pool, Tariff, TariffSeason } from './db';
import type { PoolClient } from 'pg';

export interface TariffSeed {
    name: string | null;
    seasons: Array<{
        name: string | null;
        from_month: number;
        from_day: number;
        to_month: number;
        to_day: number;
        buy_rate: number;
        sell_rate: number;
        schedules: Array<{
            name: string | null;
            buy_rate: number | null;
            sell_rate: number | null;
            from_day_of_week: number | null;
            from_hour: number | null;
            from_minute: number | null;
            to_day_of_week: number | null;
            to_hour: number | null;
            to_minute: number | null;
        }>;
    }>;
}

export class TariffRepo {
    // === Queries ===
    async getTariffsForSite(siteId: string): Promise<Tariff[]> {
        const sql = `
            SELECT
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
            FROM "Tariff" t
            LEFT JOIN "TariffSeason"   ts  ON ts.tariff_id  = t.id
            LEFT JOIN "TariffSchedule" sch ON sch.season_id = ts.id
            WHERE t.site_id = $1
        `;
        const res = await pool.query(sql, [siteId]);
        return this.assembleTariffs(res.rows);
    }

    async getTariffById(tariffId: number): Promise<Tariff | undefined> {
        const sql = `
            SELECT
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
            FROM "Tariff" t
            LEFT JOIN "TariffSeason"   ts  ON ts.tariff_id  = t.id
            LEFT JOIN "TariffSchedule" sch ON sch.season_id = ts.id
            WHERE t.id = $1
        `;
        const res = await pool.query(sql, [tariffId]);
        const tariffs = this.assembleTariffs(res.rows);
        return tariffs[0];
    }

    // === Commands ===
    async replaceTariffsForSite(siteId: string, seed: TariffSeed): Promise<void> {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const tariffIdsRes = await client.query('SELECT id FROM "Tariff" WHERE site_id = $1', [siteId]);
            const tariffIds = tariffIdsRes.rows as { id: number }[];

            for (const t of tariffIds) {
                await client.query(
                    'DELETE FROM "TariffSchedule" WHERE season_id IN (SELECT id FROM "TariffSeason" WHERE tariff_id = $1)',
                    [t.id]
                );
                await client.query('DELETE FROM "TariffSeason" WHERE tariff_id = $1', [t.id]);
            }
            await client.query('DELETE FROM "Tariff" WHERE site_id = $1', [siteId]);

            await this.insertTariffInTransaction(client, siteId, seed);

            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    private async insertTariffInTransaction(client: PoolClient, siteId: string, seed: TariffSeed): Promise<void> {
        await client.query(`
            INSERT INTO "Tariff"(site_id, name, updated)
            VALUES ($1, $2, NOW())
            ON CONFLICT(site_id, name) DO UPDATE SET name=EXCLUDED.name
        `, [siteId, seed.name]);

        const tariffRowRes = await client.query(
            'SELECT id FROM "Tariff" WHERE site_id = $1 AND name = $2',
            [siteId, seed.name]
        );
        const tariffId = tariffRowRes.rows[0].id;

        for (const season of seed.seasons) {
            await client.query(`
                INSERT INTO "TariffSeason"(tariff_id, name, from_month, from_day, to_month, to_day, buy_rate, sell_rate)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [tariffId, season.name, season.from_month, season.from_day,
                season.to_month, season.to_day, season.buy_rate, season.sell_rate]);

            const seasonRowRes = await client.query(
                'SELECT id FROM "TariffSeason" WHERE tariff_id = $1 AND name = $2',
                [tariffId, season.name]
            );
            const seasonId = seasonRowRes.rows[0].id;

            for (const sch of season.schedules) {
                await client.query(`
                    INSERT INTO "TariffSchedule"(season_id, name, buy_rate, sell_rate,
                        from_day_of_week, from_hour, from_minute,
                        to_day_of_week, to_hour, to_minute)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                `, [seasonId, sch.name, sch.buy_rate, sch.sell_rate,
                    sch.from_day_of_week, sch.from_hour, sch.from_minute,
                    sch.to_day_of_week, sch.to_hour, sch.to_minute]);
            }
        }
    }

    private assembleTariffs(rows: Record<string, unknown>[]): Tariff[] {
        const tariffMap = new Map<number, Tariff>();
        const seasonMap = new Map<number, TariffSeason>();

        for (const row of rows) {
            if (row.tariff_id == null) continue;
            const tariffId = Number(row.tariff_id);
            if (!tariffMap.has(tariffId)) {
                tariffMap.set(tariffId, {
                    id: tariffId,
                    site_id: row.tariff_site_id as string,
                    updated: new Date(row.tariff_updated as string | Date),
                    name: (row.tariff_name as string | null) ?? null,
                    seasons: [],
                });
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

        return Array.from(tariffMap.values());
    }
}
```

- [ ] **Step 4: Verify tests pass**

Run: `npx vitest run src/lib/tariff-repo.test.ts`
Expected: PASS.

- [ ] **Step 5: Run lint + build**

Run: `npm run lint && npm run build`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/tariff-repo.ts cmd/next-app/src/lib/tariff-repo.test.ts
git commit -m "feat(tariff-repo): new repo with queries and transactional replaceTariffsForSite"
```

---

## Task 7: Refactor Importer `ensureSite` to use SiteRepo + TariffRepo

**Files:**
- Modify: `cmd/next-app/src/lib/importer/index.ts`

> **Model recommendation:** Use **Opus** for implementation. This touches the tariff replacement transaction and the canonical-stringify "tariffsChanged" check. Sonnet validates.

- [ ] **Step 1: Read the current `ensureSite` carefully**

Open `cmd/next-app/src/lib/importer/index.ts` and find the `ensureSite` method (~lines 250-366) and the `updateTariffs` private method (~lines 368-420). Understand the current flow:
1. Read `Site.json` to compare canonical tariff content.
2. Upsert `Site` with new info.
3. If tariffs changed: open transaction, cascade DELETE Tariff*, then INSERT new ones via `updateTariffs(client, ...)`.
4. Invalidate site cache.

- [ ] **Step 2: Replace the `existingSiteRes` and upsert blocks**

Locate (lines ~275-319):

```typescript
const existingSiteRes = await pool.query('SELECT json FROM "Site" WHERE id = $1', [siteId]);
const existingSite = existingSiteRes.rows[0];
// ... canonicalize logic stays ...
await pool.query(`
    INSERT INTO "Site"(id, name, utility, updated, installed, timezone, json)
    ...
`, [siteId, info.site_name, info.tariff_content_v2?.utility ?? null, info.installation_date, info.installation_time_zone, JSON.stringify(info)]);
```

Replace with:

```typescript
const existingJson = await this.siteRepo.getSiteJson(siteId);
let tariffsChanged = true;

if (existingJson) {
    try {
        const existingInfo = existingJson as EnergySiteInfo;

        // Use canonical stringify to prevent flapping on key order differences
        const canonicalize = (obj: unknown): string => {
            if (obj === null || typeof obj !== 'object') {
                return JSON.stringify(obj);
            }
            if (Array.isArray(obj)) {
                return '[' + obj.map(canonicalize).join(',') + ']';
            }
            const keys = Object.keys(obj as object).sort();
            return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize((obj as Record<string, unknown>)[k])).join(',') + '}';
        };

        if (canonicalize(existingInfo.tariff_content_v2) === canonicalize(info.tariff_content_v2)) {
            tariffsChanged = false;
        }
    } catch {
        // ignore
    }
}

await this.siteRepo.upsertSite({
    id: siteId,
    name: info.site_name,
    utility: info.tariff_content_v2?.utility ?? null,
    installed: info.installation_date,
    timezone: info.installation_time_zone,
    json: info,
});
```

- [ ] **Step 3: Replace the tariff transaction block with TariffRepo call**

Locate (lines ~321-348):

```typescript
if (tariffsChanged) {
    console.log(`Tariff content changed for site ${siteId}, updating tariffs...`);
    // Use a client for atomicity of tariff replacement
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const tariffIdsRes = await client.query('SELECT id FROM "Tariff" WHERE site_id = $1', [siteId]);
        const tariffIds = tariffIdsRes.rows;
        for (const t of tariffIds) {
            await client.query('DELETE FROM "TariffSchedule" ...', [t.id]);
            await client.query('DELETE FROM "TariffSeason" WHERE tariff_id = $1', [t.id]);
        }
        await client.query('DELETE FROM "Tariff" WHERE site_id = $1', [siteId]);
        await this.updateTariffs(client, siteId, info);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
} else {
    console.log(`Tariff content unchanged for site ${siteId}, skipping tariff update.`);
}
```

Replace with:

```typescript
if (tariffsChanged) {
    console.log(`Tariff content changed for site ${siteId}, updating tariffs...`);
    const parsed = info.tariff_content_v2
        ? parseTariffContent(info.tariff_content_v2, info.site_name ?? 'Utility Tariff')
        : buildDefaultTariff('Default Rate');
    await this.tariffRepo.replaceTariffsForSite(siteId, parsed);
} else {
    console.log(`Tariff content unchanged for site ${siteId}, skipping tariff update.`);
}
```

- [ ] **Step 4: Delete the now-unused `updateTariffs(client, siteId, info)` private method**

Remove the entire `private async updateTariffs(client: PoolClient, siteId: string, info: EnergySiteInfo)` block (~lines 368-420 in the original file). It's been absorbed by `TariffRepo.insertTariffInTransaction`.

- [ ] **Step 5: Update constructor / class fields to hold a `TariffRepo`**

At the top of `Importer` (find where `siteRepo`, `userRepo` are stored), add:

```typescript
import { TariffRepo } from '../tariff-repo';
// ...
private tariffRepo: TariffRepo;
// in constructor:
this.tariffRepo = new TariffRepo();
```

Match the existing field-declaration style — if the existing repos are `private siteRepo = new SiteRepo()` inline initializers, use the same form.

- [ ] **Step 6: Remove unused `pool` import + `PoolClient` import if no other references**

```bash
grep -n "pool\b\|PoolClient" cmd/next-app/src/lib/importer/index.ts
```

If `pool` and `PoolClient` are now only referenced in the EnergyData ingest loop (still untouched in this task), keep them. Otherwise remove the imports.

- [ ] **Step 7: Run tests + lint + build**

Run: `npm test && npm run lint && npm run build`
Expected: green. The existing importer tests must still pass — they exercise tariff parsing and the canonicalize check; behavior is unchanged.

- [ ] **Step 8: Manual smoke verification**

Trigger a site refresh manually:

```bash
npm run dev
# In another shell:
curl -X POST http://localhost:5173/api/site/<a-known-site-id>/refresh-tariffs -b "site_auth=<token>"
```

Confirm DB still has Tariff/TariffSeason/TariffSchedule rows for that site after the call. If you don't have access to a live env, this step is documented in the PR description and verified by reviewer.

- [ ] **Step 9: Commit**

```bash
git add cmd/next-app/src/lib/importer/index.ts
git commit -m "refactor(importer): delegate ensureSite tariff writes to TariffRepo"
```

---

## Task 8: Add `EnergyRepo.getLatestTimestamp` and `EnergyRepo.insertEnergyDataBatch`

**Files:**
- Modify: `cmd/next-app/src/lib/energy-repo.ts`
- Modify: `cmd/next-app/src/lib/energy-repo.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `cmd/next-app/src/lib/energy-repo.test.ts`:

```typescript
describe('EnergyRepo importer commands', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('getLatestTimestamp returns the most recent timestamp for a site', async () => {
        const ts = new Date('2026-05-20T12:00:00Z');
        queryMock.mockResolvedValueOnce({ rows: [{ timestamp: ts }] });
        const repo = new EnergyRepo();
        const result = await repo.getLatestTimestamp('site-1');
        expect(result?.toISOString()).toBe(ts.toISOString());
        expect(queryMock.mock.calls[0][0]).toContain('SELECT MAX(timestamp)');
        expect(queryMock.mock.calls[0][1]).toEqual(['site-1']);
    });

    it('getLatestTimestamp returns null when no rows', async () => {
        queryMock.mockResolvedValueOnce({ rows: [{ timestamp: null }] });
        const repo = new EnergyRepo();
        expect(await repo.getLatestTimestamp('site-1')).toBeNull();
    });

    it('insertEnergyDataBatch issues a single INSERT for all rows', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new EnergyRepo();
        await repo.insertEnergyDataBatch([
            { site_id: 'site-1', tariff_id: 1, tariff_schedule_id: 10, timestamp: new Date('2026-05-20T00:00:00Z'), load_power: 100, solar_power: 50, grid_power: 25, battery_power: 25, battery_soc: 80 },
            { site_id: 'site-1', tariff_id: 1, tariff_schedule_id: 10, timestamp: new Date('2026-05-20T00:05:00Z'), load_power: 110, solar_power: 60, grid_power: 30, battery_power: 20, battery_soc: 81 },
        ]);
        expect(queryMock).toHaveBeenCalledTimes(1);
        const [sql, params] = queryMock.mock.calls[0];
        expect(sql).toContain('INSERT INTO "EnergyData"');
        expect(sql).toContain('ON CONFLICT(timestamp, site_id, tariff_id) DO UPDATE');
        // Single statement: should have 2 rows * 9 params = 18 placeholders.
        expect(params).toHaveLength(18);
    });

    it('insertEnergyDataBatch is a no-op for empty input', async () => {
        const repo = new EnergyRepo();
        await repo.insertEnergyDataBatch([]);
        expect(queryMock).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run src/lib/energy-repo.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement methods**

In `cmd/next-app/src/lib/energy-repo.ts`, under `// === Queries ===`:

```typescript
async getLatestTimestamp(siteId: string): Promise<Date | null> {
    const res = await pool.query(
        'SELECT MAX(timestamp) as timestamp FROM "EnergyData" WHERE site_id = $1',
        [siteId]
    );
    const ts = res.rows[0]?.timestamp;
    return ts ? new Date(ts) : null;
}
```

Under `// === Commands ===` (above `cleanupOldEnergyData`):

```typescript
async insertEnergyDataBatch(rows: Array<{
    site_id: string;
    tariff_id: number;
    tariff_schedule_id: number | null;
    timestamp: Date;
    load_power: number;
    solar_power: number;
    grid_power: number;
    battery_power: number;
    battery_soc: number | null;
}>): Promise<void> {
    if (rows.length === 0) return;

    const valuePlaceholders: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const r of rows) {
        valuePlaceholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(
            r.site_id, r.tariff_id, r.timestamp,
            r.load_power, r.solar_power, r.grid_power, r.battery_power,
            r.battery_soc, r.tariff_schedule_id
        );
    }

    await pool.query(`
        INSERT INTO "EnergyData"(site_id, tariff_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc, tariff_schedule_id)
        VALUES ${valuePlaceholders.join(', ')}
        ON CONFLICT(timestamp, site_id, tariff_id) DO UPDATE SET
            load_power = EXCLUDED.load_power,
            solar_power = EXCLUDED.solar_power,
            grid_power = EXCLUDED.grid_power,
            battery_power = EXCLUDED.battery_power,
            battery_soc = EXCLUDED.battery_soc,
            tariff_schedule_id = EXCLUDED.tariff_schedule_id
    `, params);
}
```

**Cross-check the INSERT shape:** open `cmd/next-app/src/lib/importer/index.ts` and find the existing `INSERT INTO "EnergyData"` block (~line 670). Confirm the column order, ON CONFLICT target, and ON CONFLICT DO UPDATE column list match exactly. If the importer's existing INSERT uses a different `EXCLUDED.*` set or omits a column, adjust the new `insertEnergyDataBatch` to match — behavior must be identical.

- [ ] **Step 4: Run tests + lint + build**

Run: `npm test && npm run lint && npm run build`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/energy-repo.ts cmd/next-app/src/lib/energy-repo.test.ts
git commit -m "feat(energy-repo): add getLatestTimestamp and insertEnergyDataBatch"
```

---

## Task 9: Refactor Importer day-loop to use `EnergyRepo.insertEnergyDataBatch`

**Files:**
- Modify: `cmd/next-app/src/lib/importer/index.ts`
- Modify: `cmd/next-app/src/lib/energy-repo.ts`
- Modify: `cmd/next-app/src/lib/importer/energy-transformer.ts`
- Modify: `cmd/next-app/src/lib/importer.test.ts`

> **Model recommendation:** Use **Opus** for implementation. This is the hot path — wrong shape = perf regression. Sonnet validates.

- [x] **Step 1: Locate the EnergyData insert site**

Open `cmd/next-app/src/lib/importer/index.ts`. The bulk INSERT is around line 670:

```typescript
INSERT INTO "EnergyData"(site_id, tariff_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc, tariff_schedule_id)
VALUES ...
ON CONFLICT(timestamp, site_id, tariff_id) DO UPDATE SET ...
```

Identify the surrounding loop that builds the `params` array and the placeholder string.

- [x] **Step 2: Locate the `latestRes` reader**

Around line 118 there's a `pool.query` reading the latest timestamp:

```typescript
const latestRes = await pool.query(`SELECT MAX(timestamp) ... FROM "EnergyData" WHERE site_id = $1`, [siteId]);
```

Identify it. There may be a second similar read around line 174 — review the whole file for all `pool.query` references and catalog them before editing.

- [x] **Step 3: Replace the bulk INSERT block with the repo call**

Replace the placeholder-building loop + `pool.query` with:

```typescript
await this.repo.insertEnergyDataBatch(rowsToInsert);
```

Where `rowsToInsert` is built by the existing transform/aggregation logic. Match the shape declared in `EnergyRepo.insertEnergyDataBatch`'s signature exactly:

```typescript
{ site_id, tariff_id, tariff_schedule_id, timestamp, load_power, solar_power, grid_power, battery_power, battery_soc }
```

- [x] **Step 4: Replace the latest-timestamp read**

Replace:
```typescript
const latestRes = await pool.query(`SELECT MAX(timestamp) ...`, [siteId]);
const latest = latestRes.rows[0]?.max;
```

With:
```typescript
const latest = await this.repo.getLatestTimestamp(siteId);
```

- [x] **Step 5: Handle the second `pool.query` at ~line 174**

Open the block. If it's reading `EnergyData`, route through `energyRepo`. If it's reading a different table, route through that table's repo. If the read has no equivalent repo method yet, add one (with a test) before completing this task.

- [x] **Step 6: Verify no `pool.query` / `client.query` remains in `lib/importer/`**

```bash
grep -rn "pool\.query\|pool\.connect\|client\.query" cmd/next-app/src/lib/importer/
```

Expected: zero matches.

- [x] **Step 7: Remove unused `pool` and `PoolClient` imports**

```bash
grep -n "^import.*pool\|^import.*PoolClient" cmd/next-app/src/lib/importer/index.ts
```

Delete any import lines whose symbols are no longer referenced.

- [x] **Step 8: Run tests + lint + build**

Run: `npm test && npm run lint && npm run build`
Expected: green. The existing importer tests must still pass.

- [x] **Step 9: Inspect emitted SQL shape**

This is the **perf regression gate**. The import now uses `insertEnergyDataBatch` which emits a single INSERT statement per batch.

Expected output: e.g. `[EnergyRepo] insertEnergyDataBatch: 288 rows in 1 query` — confirming one statement per batch, not N.

- [x] **Step 10: Commit**

```bash
git add cmd/next-app/src/lib/importer/index.ts cmd/next-app/src/lib/energy-repo.ts cmd/next-app/src/lib/importer/energy-transformer.ts
git commit -m "refactor(importer): use EnergyRepo for day-loop insert and latest-timestamp read"
```

---

## Task 10: Move `getInstallationAndSite` to `TrmnlInstallationRepo.findByUuidWithSite`

**Files:**
- Modify: `cmd/next-app/src/lib/trmnl-installation-repo.ts`
- Modify: `cmd/next-app/src/lib/trmnl-installation-repo.test.ts`
- Modify: `cmd/next-app/src/lib/site-repo.ts`
- Modify: `cmd/next-app/src/lib/site-repo.test.ts`
- Modify: `cmd/next-app/src/app/api/trmnl/markup/route.ts`

- [ ] **Step 1: Write failing test for `findByUuidWithSite`**

Append to `cmd/next-app/src/lib/trmnl-installation-repo.test.ts`:

```typescript
import { SiteRepo } from './site-repo';

describe('TrmnlInstallationRepo.findByUuidWithSite', () => {
    beforeEach(() => {
        queryMock.mockReset();
    });

    it('returns installation + site when both exist', async () => {
        // First query: findByUuid
        queryMock.mockResolvedValueOnce({
            rows: [{ id: 1, uuid: 'u-1', site_id: 'site-1', plugin_setting_id: null, created_at: new Date(), json: {}, access_token: null }]
        });
        // Second query: SiteRepo.getSite -> loadSitesFromDB (full JOIN)
        queryMock.mockResolvedValueOnce({
            rows: [{
                id: 'site-1', user_id: 'u', name: 'Home', utility: null,
                updated: new Date(), installed: new Date(), timezone: 'America/Chicago',
                billing_start_day: 1, timezone_display_mode: null,
                access_token: 'a', refresh_token: 'r', auth_status: 'active',
                tariff_id: null, tariff_name: null, tariff_updated: null, tariff_site_id: null,
                season_id: null, season_name: null,
                from_month: null, from_day: null, to_month: null, to_day: null,
                season_buy_rate: null, season_sell_rate: null,
                schedule_id: null, schedule_name: null,
                schedule_buy_rate: null, schedule_sell_rate: null,
                from_day_of_week: null, from_hour: null, from_minute: null,
                to_day_of_week: null, to_hour: null, to_minute: null,
            }]
        });

        const repo = new TrmnlInstallationRepo();
        const result = await repo.findByUuidWithSite('u-1', { includeTokens: true });
        expect(result?.installation.uuid).toBe('u-1');
        expect(result?.site.id).toBe('site-1');
        expect(result?.site.access_token).toBe('a');
    });

    it('returns undefined when installation not found', async () => {
        queryMock.mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        const result = await repo.findByUuidWithSite('missing');
        expect(result).toBeUndefined();
    });

    it('returns undefined when site disappears', async () => {
        queryMock
            .mockResolvedValueOnce({ rows: [{ id: 1, uuid: 'u-1', site_id: 'orphan' }] })
            .mockResolvedValueOnce({ rows: [] });
        const repo = new TrmnlInstallationRepo();
        const result = await repo.findByUuidWithSite('u-1');
        expect(result).toBeUndefined();
    });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `npx vitest run src/lib/trmnl-installation-repo.test.ts`
Expected: FAIL — `findByUuidWithSite is not a function`.

- [ ] **Step 3: Implement `findByUuidWithSite`**

In `cmd/next-app/src/lib/trmnl-installation-repo.ts`, add at the top:

```typescript
import { SiteRepo } from './site-repo';
import type { SiteWithTariffs } from './db';
```

Add to the class under `// === Queries ===`:

```typescript
async findByUuidWithSite(
    uuid: string,
    options: { includeTokens?: boolean } = {}
): Promise<{ installation: TrmnlInstallation; site: SiteWithTariffs } | undefined> {
    const installation = await this.findByUuid(uuid);
    if (!installation) return undefined;

    const site = await new SiteRepo().getSite(installation.site_id, options);
    if (!site) return undefined;

    if (!options.includeTokens) {
        // Strip TRMNL tokens from the returned installation when not requested
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { access_token: _at, refresh_token: _rt, ...safe } = installation;
        return { installation: safe as TrmnlInstallation, site };
    }

    return { installation, site };
}
```

Also add `// === Queries ===` and `// === Commands ===` headers in the class if they're not already present from Task 1.

- [ ] **Step 4: Update `markup` route to use the new method**

In `cmd/next-app/src/app/api/trmnl/markup/route.ts`, find line ~137:

```typescript
const result = await siteRepo.getInstallationAndSite(uuid, { includeTokens: true });
```

Replace with:

```typescript
const result = await trmnlInstallationRepo.findByUuidWithSite(uuid, { includeTokens: true });
```

Adjust imports — remove `SiteRepo` from imports if no other usage in the file; add `TrmnlInstallationRepo`. Verify with grep.

- [ ] **Step 5: Delete `SiteRepo.getInstallationAndSite`**

Remove the method from `cmd/next-app/src/lib/site-repo.ts` (lines ~23-67).

Also remove the related test cases in `cmd/next-app/src/lib/site-repo.test.ts` (around line 109-129 per grep result earlier).

- [ ] **Step 6: Verify no remaining callers**

```bash
grep -rn "getInstallationAndSite" cmd/next-app/src/
```

Expected: zero matches (after the delete in Steps 4 and 5).

- [ ] **Step 7: Run tests + lint + build**

Run: `npm test && npm run lint && npm run build`
Expected: green.

- [ ] **Step 8: Commit**

```bash
git add cmd/next-app/src/lib/trmnl-installation-repo.ts cmd/next-app/src/lib/trmnl-installation-repo.test.ts cmd/next-app/src/lib/site-repo.ts cmd/next-app/src/lib/site-repo.test.ts cmd/next-app/src/app/api/trmnl/markup/route.ts
git commit -m "refactor(trmnl): move getInstallationAndSite to TrmnlInstallationRepo.findByUuidWithSite"
```

---

## Task 11: Route TeslaTokenRepo token writes through UserRepo

**Files:**
- Modify: `cmd/next-app/src/lib/tesla-token-repo.ts`
- Modify: `cmd/next-app/src/lib/tesla-token-repo.test.ts`

- [ ] **Step 1: Identify the inline User UPDATEs**

```bash
grep -n "pool\.query" cmd/next-app/src/lib/tesla-token-repo.ts
```

You should see:
- Line ~11: `UPDATE "User" SET access_token = $1, refresh_token = $2 WHERE id = $3`
- Line ~40: `UPDATE "User" SET is_refreshing = 0, refresh_lock_expires = 0 WHERE id = $1`
- Line ~50: `SELECT access_token, refresh_token, is_refreshing, auth_status FROM "User"`
- Line ~94: `UPDATE "User"` (inside refresh handler)
- Line ~118: `UPDATE "User" SET auth_status = $1, is_active = $2 WHERE id = $3`

Of these, lines 11, 94, and 118 are User token / status writes that have direct equivalents in UserRepo (`updateTokens`, `updateUserStatus`).

Line 40 (refresh-lock release) and line 50 (read for waitForTokenRefresh) are token-repo-specific lock SQL — keep them.

- [ ] **Step 2: Write failing test verifying the new delegation**

Open `cmd/next-app/src/lib/tesla-token-repo.test.ts`. Add a test that:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, updateTokensMock, updateUserStatusMock } = vi.hoisted(() => ({
    queryMock: vi.fn(),
    updateTokensMock: vi.fn(),
    updateUserStatusMock: vi.fn(),
}));

vi.mock('./db', () => ({
    pool: { query: queryMock }
}));

vi.mock('./user-repo', () => ({
    UserRepo: class {
        updateTokens = updateTokensMock;
        updateUserStatus = updateUserStatusMock;
    }
}));

// ... (existing mocks for SiteRepo if used; preserve them)

describe('TeslaTokenRepo delegates User writes', () => {
    beforeEach(() => {
        queryMock.mockReset();
        updateTokensMock.mockReset();
        updateUserStatusMock.mockReset();
    });

    it('updateSiteTokens calls UserRepo.updateTokens', async () => {
        // Set up a SiteRepo stub returning a site with user_id; details depend on the existing test file's pattern.
        // The key assertion:
        // await repo.updateSiteTokens('site-1', 'newA', 'newR');
        // expect(updateTokensMock).toHaveBeenCalledWith('user-1', 'newA', 'newR');
        // (Adapt to match existing tesla-token-repo.test.ts structure.)
    });
});
```

**Important:** Read the existing `tesla-token-repo.test.ts` (whatever its current shape) and adapt the new test to follow the same SiteRepo-mocking pattern.

- [ ] **Step 3: Verify the new test fails**

Run: `npx vitest run src/lib/tesla-token-repo.test.ts`
Expected: FAIL — current code uses inline `pool.query`, so `updateTokensMock` is never called.

- [ ] **Step 4: Update `tesla-token-repo.ts` to delegate**

In `cmd/next-app/src/lib/tesla-token-repo.ts`:

Add import:
```typescript
import { UserRepo } from './user-repo';
```

In the `TeslaTokenRepo` class, add a `userRepo` field (matching the existing field style):
```typescript
private userRepo = new UserRepo();
```

Replace line ~11 (`updateSiteTokens` body's User UPDATE):
```typescript
await pool.query('UPDATE "User" SET access_token = $1, refresh_token = $2 WHERE id = $3', [accessToken, refreshToken, site.user_id]);
```
With:
```typescript
await this.userRepo.updateTokens(site.user_id, accessToken, refreshToken);
```

Replace line ~94 (inside the refresh handler closure):
```typescript
await pool.query('UPDATE "User" SET access_token = ...', [newAccess, newRefresh, site.user_id]);
```
With:
```typescript
await this.userRepo.updateTokens(site.user_id, newAccess, newRefresh);
```

Replace line ~118 (auth status revoke):
```typescript
await pool.query('UPDATE "User" SET auth_status = $1, is_active = $2 WHERE id = $3', ['revoked', false, site.user_id]);
```
With:
```typescript
await this.userRepo.updateUserStatus(site.user_id, 'revoked', false);
```

**Leave lines 40 and 50 untouched** — those are lock-specific SQL that should remain in TeslaTokenRepo.

- [ ] **Step 5: Run tests + lint + build**

Run: `npm test && npm run lint && npm run build`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add cmd/next-app/src/lib/tesla-token-repo.ts cmd/next-app/src/lib/tesla-token-repo.test.ts
git commit -m "refactor(tesla-token-repo): delegate User writes to UserRepo"
```

---

## Task 12: Cleanup verification + PR description

**Files:** None (verification step)

- [ ] **Step 1: Final grep for orphan `pool.query` outside repos**

```bash
grep -rn "pool\.query" cmd/next-app/src/ | grep -v "\\-repo\\.ts" | grep -v "\\.test\\.ts" | grep -v "api/health"
```

Expected: empty output. If anything appears (other than the deliberately-excluded `api/health` diagnostic), surface it and either route through the appropriate repo or document why it stays.

- [ ] **Step 2: Verify no `pool.connect` outside repos**

```bash
grep -rn "pool\.connect" cmd/next-app/src/ | grep -v "\\-repo\\.ts" | grep -v "\\.test\\.ts"
```

Expected: empty output.

- [ ] **Step 3: Full verification gate**

```bash
npm run lint
npm run build
npm test
```

Expected: all green. `npm test` should show all existing tests plus the new ones added across tasks 2-11.

- [ ] **Step 4: Manual smoke**

```bash
npm run dev
```

In the browser, verify:
- `/login` redirect to Tesla still works (if a real account is available)
- `/products` loads after login
- `/site/<id>` loads
- `/profile` loads without 500
- `/api/trmnl/markup` (with a real installation UUID) returns 200

Document any deferred manual tests in the PR description.

- [ ] **Step 5: Push branch + open PR**

```bash
git push -u origin arch-cqrs-refactor
gh pr create --title "Refactor site data access to CQRS repository pattern" --body "$(cat <<'EOF'
## Summary
- Apply the CQRS section convention (`=== Queries ===` / `=== Commands ===`) across all site-domain repos.
- Extract raw SQL from `auth/tesla-callback`, `profile/page`, and the Importer into repos.
- Add `TariffRepo` owning Tariff / TariffSeason / TariffSchedule reads and writes.
- Fold UserRepo's module-level functions into the class; keep a `cache()`'d `isUserActive` wrapper.
- Importer is now pure orchestration — no `pool.query` inside `lib/importer/`.

See spec: `cmd/next-app/docs/superpowers/specs/2026-05-20-site-data-cqrs-design.md`

## Test plan
- [ ] All existing tests pass
- [ ] New tests for TariffRepo (round-trip + ROLLBACK)
- [ ] New tests for EnergyRepo.insertEnergyDataBatch (single-statement shape verified)
- [ ] New tests for UserRepo.{getById, upsertOnTeslaAuth, updateTokens}
- [ ] New tests for SiteRepo.{assignSiteToUser, upsertSite, getSiteJson}
- [ ] New tests for TrmnlInstallationRepo.findByUuidWithSite
- [ ] Manual smoke: Tesla OAuth round-trip, profile, site detail, /api/trmnl/markup

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage**
- §1 Goals → Tasks 1–12 collectively.
- §2 Architecture (cross-aggregate JOIN ownership) → Task 10 (`findByUuidWithSite`).
- §3A SiteRepo → Tasks 1, 4, 10.
- §3B TariffRepo → Task 6.
- §3C EnergyRepo → Tasks 1, 8, 9.
- §3D UserRepo → Tasks 1, 2, 3.
- §3E TeslaTokenRepo → Tasks 1, 11.
- §3F Label-only (LoadTag/Announcement) → Task 1.
- §3G TrmnlInstallationRepo.findByUuidWithSite → Task 10.
- §4 Refactored data flows → Tasks 2 (callers), 5 (profile/auth-callback), 10 (markup), 11 (tesla-token).
- §5 Importer rewrite → Tasks 7 (ensureSite) + 9 (day-loop).
- §6 Phasing (12 commits) → Tasks 1–12 map 1:1, with Task 1 covering "docs spec" implicitly (already committed in `f502433`).
- §7 Test plan → New tests per task; verification gate in Task 12.

**Placeholder scan:** No "TBD" / "implement later" / "similar to" — all code blocks are concrete.

**Type/name consistency:**
- `UserRepo.getByAccessToken` (Task 2) matches caller updates (Task 2 step 4) and is referenced consistently.
- `TariffSeed` (Task 6) shape matches the existing `parseTariffContent` output structure assumed by Task 7's `parsed` variable. Verify in Task 7 implementation that `parseTariffContent` returns this shape; if not, adapt either the interface or the importer's call.
- `EnergyRepo.insertEnergyDataBatch` row shape (Task 8) matches the Importer's existing row construction (Task 9 references the same field names). Cross-check during Task 9 Step 3.
- `SiteRepo.upsertSite` signature (Task 4) accepts `json: unknown` and stringifies internally; Task 7 passes the raw `info` object (not pre-stringified) — confirmed consistent.

**Risk flags (already noted inline):**
- Task 5: manual Tesla OAuth smoke required before merge.
- Task 7: tariff cascade transaction behavior must be identical.
- Task 9: bulk INSERT shape must remain one statement, not N (perf gate Step 9).
