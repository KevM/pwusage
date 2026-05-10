# EnergyRepo Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the 761-line `energy-repo.ts` god-class into `TeslaTokenRepo`, `LoadTagRepo`, `SiteRepo`, and the retained `EnergyRepo` to establish clear domain boundaries.

**Architecture:** Use the Repository pattern. We extract specific domain operations into their own classes, injecting dependencies (like `SiteRepo` into `TeslaTokenRepo`) via constructors where necessary. Standalone user functions move to `user-repo.ts`.

**Tech Stack:** TypeScript, Next.js, `pg` (PostgreSQL)

---

### Task 1: Move User Functions to `user-repo.ts`

**Files:**
- Modify: `cmd/next-app/src/lib/user-repo.ts`
- Modify: `cmd/next-app/src/lib/energy-repo.ts`

- [ ] **Step 1: Append User token functions to `user-repo.ts`**

```typescript
// Add these to cmd/next-app/src/lib/user-repo.ts

export async function getUserByToken(token: string): Promise<{ id: string, email?: string, roles?: string[] } | null> {
    const res = await pool.query('SELECT id, email, roles FROM "User" WHERE access_token = $1', [token]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
}

export async function getUserTokens(userId: string): Promise<{ access_token: string, refresh_token: string } | null> {
    const res = await pool.query('SELECT access_token, refresh_token FROM "User" WHERE id = $1', [userId]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
}

export async function getUserTokensForSite(siteId: string): Promise<{ access_token: string, refresh_token: string, user_id: string } | null> {
    const res = await pool.query(`
        SELECT u.access_token, u.refresh_token, u.id as user_id 
        FROM "User" u
        JOIN "Site" s ON s.user_id = u.id
        WHERE s.id = $1
    `, [siteId]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
}
```

- [ ] **Step 2: Remove User token functions from `energy-repo.ts`**
Open `cmd/next-app/src/lib/energy-repo.ts` and delete `getUserByToken`, `getUserTokens`, and `getUserTokensForSite`.

- [ ] **Step 3: Fix imports in files using these functions**
Update imports in `cmd/next-app/src/app/api/site-live-data/route.ts`, `cmd/next-app/src/app/api/site/[id]/analysis/route.ts`, `cmd/next-app/src/app/api/site/[id]/refresh-tariffs/route.ts` to import `getUserTokensForSite` from `@/lib/user-repo` instead of `@/lib/energy-repo`.

- [ ] **Step 4: Run typecheck**
Run: `npm run build`
Expected: Passes (or fails with unrelated errors, but no missing exports for `getUserTokensForSite`).

- [ ] **Step 5: Commit**
```bash
git add cmd/next-app/src/lib/user-repo.ts cmd/next-app/src/lib/energy-repo.ts cmd/next-app/src/app/api/
git commit -m "refactor: move user token functions to user-repo.ts"
```

---

### Task 2: Create `load-tag-repo.ts`

**Files:**
- Create: `cmd/next-app/src/lib/load-tag-repo.ts`
- Modify: `cmd/next-app/src/lib/energy-repo.ts`

- [ ] **Step 1: Write `load-tag-repo.ts`**

```typescript
import { pool } from './db';
import { LoadTag } from './db';

export class LoadTagRepo {
    async getLoadTags(siteId: string, start: Date, end: Date): Promise<LoadTag[]> {
        const res = await pool.query(`
            SELECT * FROM "LoadTag"
            WHERE site_id = $1
            AND start_time >= $2
            AND end_time <= $3
        `, [siteId, start, end]);

        return res.rows.map(r => ({
            ...r,
            start_time: new Date(r.start_time),
            end_time: new Date(r.end_time),
            created_at: new Date(r.created_at)
        }));
    }

    async addLoadTag(siteId: string, start: Date, end: Date, tag: string) {
        const exists = await pool.query(`
            SELECT 1 FROM "LoadTag" 
            WHERE site_id = $1 AND start_time = $2 AND end_time = $3 AND tag = $4
        `, [siteId, start, end, tag]);

        if (exists.rowCount && exists.rowCount > 0) return;

        await pool.query(`
            INSERT INTO "LoadTag" (site_id, start_time, end_time, tag)
            VALUES ($1, $2, $3, $4)
        `, [siteId, start, end, tag]);
    }

    async removeLoadTag(siteId: string, start: Date, end: Date, tag: string) {
        await pool.query(`
            DELETE FROM "LoadTag"
            WHERE site_id = $1 AND start_time = $2 AND end_time = $3 AND tag = $4
        `, [siteId, start, end, tag]);
    }

    async cleanupOldTags(cutoffDate: Date): Promise<{ tagsDeleted: number }> {
        const tagsRes = await pool.query(`
            DELETE FROM "LoadTag"
            WHERE end_time < $1
        `, [cutoffDate]);

        return {
            tagsDeleted: tagsRes.rowCount || 0
        };
    }
}
```

- [ ] **Step 2: Update `energy-repo.ts`**
Remove `getLoadTags`, `addLoadTag`, `removeLoadTag` from `EnergyRepo`.
Rename `cleanupOldData` to `cleanupOldEnergyData` and remove the tag deletion logic from it:

```typescript
    async cleanupOldEnergyData(cutoffDate: Date): Promise<{ energyDeleted: number }> {
        const energyRes = await pool.query(`
            DELETE FROM "EnergyData"
            WHERE timestamp < $1
        `, [cutoffDate]);

        return {
            energyDeleted: energyRes.rowCount || 0
        };
    }
```

- [ ] **Step 3: Update cleanup cron job**
Modify `cmd/next-app/src/app/api/cron/cleanup/route.ts` to use both repos.

```typescript
import { EnergyRepo } from '@/lib/energy-repo';
import { LoadTagRepo } from '@/lib/load-tag-repo';

// Inside the route:
const energyRepo = new EnergyRepo();
const tagRepo = new LoadTagRepo();
const energyResult = await energyRepo.cleanupOldEnergyData(cutoff);
const tagResult = await tagRepo.cleanupOldTags(cutoff);
// Combine results in log...
```

- [ ] **Step 4: Run typecheck**
Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add cmd/next-app/src/lib/load-tag-repo.ts cmd/next-app/src/lib/energy-repo.ts cmd/next-app/src/app/api/cron/cleanup/route.ts
git commit -m "refactor: extract LoadTagRepo from EnergyRepo"
```

---

### Task 3: Create `site-repo.ts`

**Files:**
- Create: `cmd/next-app/src/lib/site-repo.ts`
- Modify: `cmd/next-app/src/lib/energy-repo.ts`

- [ ] **Step 1: Create `site-repo.ts` and extract site logic**
Create `cmd/next-app/src/lib/site-repo.ts` and copy the site fetching logic, `siteCache`, and interfaces (`SiteQueryOptions`, `SiteIdRow`) from `energy-repo.ts`. *Ensure `import { pool, Site, SiteWithTariffs, Tariff, TrmnlInstallation, TariffSeason, TariffSchedule } from './db';` and `import { getRequestContext } from './request-context';` are included.*

(Extract `getInstallationAndSite`, `getSitesForUser`, `getSitesWithTariffs`, `getSite`, `loadSitesFromDB`, `assembleFromRows`, `getSiteIds`, `getSites`, `updateSiteBillingDay`, `updateSiteTimezoneDisplayMode`, `invalidateCache` to `SiteRepo` class).

- [ ] **Step 2: Update `energy-repo.ts`**
Remove all site-related methods and the `siteCache` logic from `EnergyRepo`.
Inject `SiteRepo` into `EnergyRepo`'s `getUsageByTOU` method by instantiating it internally or passing it in.
```typescript
import { SiteRepo } from './site-repo';

// In getUsageByTOU:
const siteRepo = new SiteRepo();
const site = await siteRepo.getSite(siteId);
```

- [ ] **Step 3: Fix consumer imports for `SiteRepo`**
Replace `EnergyRepo` with `SiteRepo` across the app where site methods are used (e.g. `siteService`, page components fetching sites). We will use subagent-driven-development to iteratively fix TypeScript errors here.

- [ ] **Step 4: Run typecheck to verify**
Run: `npx tsc --noEmit`
Expected: Fix TS errors until it passes.

- [ ] **Step 5: Commit**
```bash
git add .
git commit -m "refactor: extract SiteRepo from EnergyRepo"
```

---

### Task 4: Create `tesla-token-repo.ts`

**Files:**
- Create: `cmd/next-app/src/lib/tesla-token-repo.ts`
- Modify: `cmd/next-app/src/lib/energy-repo.ts`

- [ ] **Step 1: Write `tesla-token-repo.ts`**
Extract `acquireRefreshLock`, `releaseRefreshLock`, `waitForTokenRefresh`, `getLockedRefreshHandler`, and `updateSiteTokens`. Inject `SiteRepo` into its constructor.

```typescript
import { pool } from './db';
import { SiteRepo } from './site-repo';

export class TeslaTokenRepo {
    private siteRepo: SiteRepo;

    constructor(siteRepo: SiteRepo) {
        this.siteRepo = siteRepo;
    }
    
    async updateSiteTokens(siteId: string, accessToken: string, refreshToken: string) {
        const site = await this.siteRepo.getSite(siteId);

        if (site && site.user_id) {
            await pool.query('UPDATE "User" SET access_token = $1, refresh_token = $2 WHERE id = $3', [accessToken, refreshToken, site.user_id]);
            console.log(`[TeslaTokenRepo] Updated tokens for USER ${site.user_id} (via site ${siteId})`);
        } else {
            console.warn(`[TeslaTokenRepo] Cannot update tokens for site ${siteId} - No User Linked!`);
        }

        this.siteRepo.invalidateCache(siteId);
    }

    async acquireRefreshLock(siteId: string): Promise<boolean> {
        const now = Date.now();
        const expires = now + 60000;

        const site = await this.siteRepo.getSite(siteId);
        if (site && site.user_id) {
            const result = await pool.query(`
                UPDATE "User"
                SET is_refreshing = 1, refresh_lock_expires = $1
                WHERE id = $2 AND (is_refreshing = 0 OR refresh_lock_expires < $3)
            `, [expires, site.user_id, now]);
            return (result.rowCount ?? 0) > 0;
        }

        return false;
    }

    async releaseRefreshLock(siteId: string) {
        const site = await this.siteRepo.getSite(siteId);
        if (site && site.user_id) {
            await pool.query('UPDATE "User" SET is_refreshing = 0, refresh_lock_expires = 0 WHERE id = $1', [site.user_id]);
        }
    }

    async waitForTokenRefresh(siteId: string, timeoutMs = 20000): Promise<{ access_token: string; refresh_token: string }> {
        const start = Date.now();
        const site = await this.siteRepo.getSite(siteId);
        if (!site || !site.user_id) throw new Error('Site/User not found for refresh wait');

        while (Date.now() - start < timeoutMs) {
            const res = await pool.query(`SELECT access_token, refresh_token, is_refreshing FROM "User" WHERE id = $1`, [site.user_id]);
            const row = res.rows[0];
            if (!row.is_refreshing) {
                return { access_token: row.access_token || '', refresh_token: row.refresh_token || '' };
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw new Error('Timeout waiting for token refresh lock');
    }

    getLockedRefreshHandler(siteId: string) {
        return {
            refreshHandler: async (refreshToken: string) => {
                console.log(`[TokenLock] Attempting to acquire lock for site ${siteId}...`);
                if (await this.acquireRefreshLock(siteId)) {
                    console.log(`[TokenLock] Lock acquired for site ${siteId}. Refreshing...`);
                    try {
                        const { refreshAccessToken } = await import('./tesla-auth');
                        const newTokens = await refreshAccessToken(refreshToken);

                        await this.updateSiteTokens(siteId, newTokens.access_token, newTokens.refresh_token);
                        return newTokens;
                    } finally {
                        await this.releaseRefreshLock(siteId);
                        console.log(`[TokenLock] Lock released for site ${siteId}.`);
                    }
                } else {
                    console.log(`[TokenLock] Lock busy for site ${siteId}. Waiting...`);
                    return this.waitForTokenRefresh(siteId);
                }
            },
            errorHandler: async (error: Error) => {
                const msg = error.message;
                if (msg.includes('401') || msg.includes('login_required') || msg.includes('invalid_grant')) {
                    const site = await this.siteRepo.getSite(siteId);
                    if (site && site.user_id) {
                        console.warn(`[TokenLock] Terminal auth failure for site ${siteId} (User ${site.user_id}). Marking revoked.`);
                        await pool.query('UPDATE "User" SET auth_status = $1, is_active = $2 WHERE id = $3', ['revoked', false, site.user_id]);
                        this.siteRepo.invalidateCache(siteId);
                    }
                }
            }
        };
    }
}
```

- [ ] **Step 2: Update consumers**
Remove these methods from `EnergyRepo`. Search for `getLockedRefreshHandler` and `updateSiteTokens` and replace instances to use `new TeslaTokenRepo(new SiteRepo())`.

- [ ] **Step 3: Run final checks**
Run: `npm run build && npm run test`
Expected: PASS

- [ ] **Step 4: Commit**
```bash
git add cmd/next-app/src/lib/tesla-token-repo.ts cmd/next-app/src/lib/energy-repo.ts
git commit -m "refactor: extract TeslaTokenRepo from EnergyRepo"
```
