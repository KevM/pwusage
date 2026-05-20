# TRMNL Integration Data Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the database operations for TRMNL installations and users into a CQRS-pattern repository layer, removing all raw inline SQL from controllers.

**Architecture:** Create a new `TrmnlInstallationRepo` repository class to handle all queries and commands on the `"TrmnlInstallation"` table. Update `UserRepo` to handle user email operations. Update `TrmnlService` and routes to consume these repositories.

**Tech Stack:** Next.js (App Router), TypeScript, Vitest, PostgreSQL (pg pool)

---

## Proposed File Changes Map
*   **[NEW]** [trmnl-installation-repo.ts](file:///Users/kevm/github/pwusage/cmd/next-app/src/lib/trmnl-installation-repo.ts): New repo for TRMNL Installation DB logic (CQRS pattern).
*   **[NEW]** [trmnl-installation-repo.test.ts](file:///Users/kevm/github/pwusage/cmd/next-app/src/lib/trmnl-installation-repo.test.ts): Unit tests for the new repository.
*   **[MODIFY]** [user-repo.ts](file:///Users/kevm/github/pwusage/cmd/next-app/src/lib/user-repo.ts): Add query/command email sync helpers.
*   **[MODIFY]** [user-repo.test.ts](file:///Users/kevm/github/pwusage/cmd/next-app/src/lib/user-repo.test.ts): Unit tests for new email sync helpers.
*   **[MODIFY]** [trmnl-service.ts](file:///Users/kevm/github/pwusage/cmd/next-app/src/lib/trmnl-service.ts): Update methods to delegate database operations to `TrmnlInstallationRepo`.
*   **[MODIFY]** [api/trmnl/manage/route.ts](file:///Users/kevm/github/pwusage/cmd/next-app/src/app/api/trmnl/manage/route.ts): Refactor DB query to use repository.
*   **[MODIFY]** [api/trmnl/webhook/route.ts](file:///Users/kevm/github/pwusage/cmd/next-app/src/app/api/trmnl/webhook/route.ts): Refactor DB queries to use `SiteRepo` and `UserRepo`.
*   **[MODIFY]** [api/trmnl/markup/route.ts](file:///Users/kevm/github/pwusage/cmd/next-app/src/app/api/trmnl/markup/route.ts): Refactor advanced-carousel query to use repository.

---

### Task 1: Create TrmnlInstallationRepo and Unit Tests

**Files:**
- Create: `cmd/next-app/src/lib/trmnl-installation-repo.ts`
- Create: `cmd/next-app/src/lib/trmnl-installation-repo.test.ts`

- [ ] **Step 1: Write failing unit test skeleton**
  Create `cmd/next-app/src/lib/trmnl-installation-repo.test.ts` with mock setup and first failing test:
  ```typescript
  import { beforeEach, describe, expect, it, vi } from 'vitest';

  const { queryMock } = vi.hoisted(() => ({
      queryMock: vi.fn()
  }));

  vi.mock('./db', () => ({
      pool: {
          query: queryMock
      }
  }));

  import { TrmnlInstallationRepo } from './trmnl-installation-repo';

  describe('TrmnlInstallationRepo', () => {
      beforeEach(() => {
          queryMock.mockReset();
      });

      it('findByUuid queries correct table', async () => {
          queryMock.mockResolvedValueOnce({ rows: [{ id: 1, uuid: 'uuid-123' }] });
          const repo = new TrmnlInstallationRepo();
          const result = await repo.findByUuid('uuid-123');
          expect(result?.uuid).toBe('uuid-123');
          expect(queryMock).toHaveBeenCalledWith(
              expect.stringContaining('SELECT * FROM "TrmnlInstallation" WHERE uuid = $1'),
              ['uuid-123']
          );
      });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npx vitest run src/lib/trmnl-installation-repo.test.ts`
  Expected: FAIL with compilation error (module not found).

- [ ] **Step 3: Implement minimal repository shell**
  Create `cmd/next-app/src/lib/trmnl-installation-repo.ts`:
  ```typescript
  import { pool, TrmnlInstallation } from './db';

  export class TrmnlInstallationRepo {
      async findByUuid(uuid: string): Promise<TrmnlInstallation | undefined> {
          const { rows } = await pool.query('SELECT * FROM "TrmnlInstallation" WHERE uuid = $1', [uuid]);
          return rows[0] as TrmnlInstallation | undefined;
      }
  }
  ```

- [ ] **Step 4: Run test to verify it passes**
  Run: `npx vitest run src/lib/trmnl-installation-repo.test.ts`
  Expected: PASS

- [ ] **Step 5: Write remaining test cases**
  Append to `cmd/next-app/src/lib/trmnl-installation-repo.test.ts`:
  ```typescript
      it('findBySiteId queries with ordering and limit', async () => {
          queryMock.mockResolvedValueOnce({ rows: [{ id: 2 }] });
          const repo = new TrmnlInstallationRepo();
          await repo.findBySiteId('site-abc');
          expect(queryMock).toHaveBeenCalledWith(
              expect.stringContaining('SELECT * FROM "TrmnlInstallation" WHERE site_id = $1'),
              ['site-abc']
          );
      });

      it('findPendingByPluginId queries correct criteria', async () => {
          queryMock.mockResolvedValueOnce({ rows: [] });
          const repo = new TrmnlInstallationRepo();
          await repo.findPendingByPluginId(999);
          expect(queryMock).toHaveBeenCalledWith(
              expect.stringContaining('plugin_setting_id = $1 AND uuid IS NULL'),
              [999]
          );
      });

      it('findLatestLoosePending queries correctly', async () => {
          queryMock.mockResolvedValueOnce({ rows: [] });
          const repo = new TrmnlInstallationRepo();
          await repo.findLatestLoosePending();
          expect(queryMock).toHaveBeenCalledWith(
              expect.stringContaining('uuid IS NULL AND plugin_setting_id IS NULL')
          );
      });

      it('create inserts correct parameters', async () => {
          queryMock.mockResolvedValueOnce({ rows: [{ id: 10 }] });
          const repo = new TrmnlInstallationRepo();
          const id = await repo.create('site-1', 'uuid-1', 456, { name: 'test' }, 'token-abc');
          expect(id).toBe(10);
          expect(queryMock).toHaveBeenCalledWith(
              expect.stringContaining('INSERT INTO "TrmnlInstallation"'),
              ['site-1', 'uuid-1', 456, { name: 'test' }, 'token-abc']
          );
      });

      it('upsertSettings saves settings payload', async () => {
          queryMock.mockResolvedValueOnce({ rows: [{ id: 12 }] });
          const repo = new TrmnlInstallationRepo();
          await repo.upsertSettings('uuid-1', 'site-1', { a: 1 }, 777);
          expect(queryMock).toHaveBeenCalledWith(
              expect.stringContaining('INSERT INTO "TrmnlInstallation" (uuid, site_id, json, plugin_setting_id)'),
              ['uuid-1', 'site-1', { a: 1 }, 777]
          );
      });

      it('updatePluginId updates plugin mapping', async () => {
          queryMock.mockResolvedValueOnce({ rows: [] });
          const repo = new TrmnlInstallationRepo();
          await repo.updatePluginId('uuid-1', 123);
          expect(queryMock).toHaveBeenCalledWith(
              expect.stringContaining('UPDATE "TrmnlInstallation" SET plugin_setting_id = $1 WHERE uuid = $2'),
              [123, 'uuid-1']
          );
      });

      it('updateJson updates settings config', async () => {
          queryMock.mockResolvedValueOnce({ rows: [] });
          const repo = new TrmnlInstallationRepo();
          await repo.updateJson(42, { cfg: true });
          expect(queryMock).toHaveBeenCalledWith(
              expect.stringContaining('UPDATE "TrmnlInstallation" SET json = $1 WHERE id = $2'),
              [{ cfg: true }, 42]
          );
      });

      it('claimPendingById links pending device', async () => {
          queryMock.mockResolvedValueOnce({ rows: [] });
          const repo = new TrmnlInstallationRepo();
          await repo.claimPendingById(5, 'uuid-abc', 99, { data: 1 });
          expect(queryMock).toHaveBeenCalledWith(
              expect.stringContaining('UPDATE "TrmnlInstallation" SET uuid = $1, plugin_setting_id = $2, json = $3 WHERE id = $4'),
              ['uuid-abc', 99, { data: 1 }, 5]
          );
      });

      it('claimPending updates pending by plugin id', async () => {
          queryMock.mockResolvedValueOnce({ rows: [] });
          const repo = new TrmnlInstallationRepo();
          await repo.claimPending(88, 'uuid-x', { val: 2 });
          expect(queryMock).toHaveBeenCalledWith(
              expect.stringContaining('UPDATE "TrmnlInstallation" SET uuid = $1, json = $2 WHERE plugin_setting_id = $3 AND uuid IS NULL'),
              ['uuid-x', { val: 2 }, 88]
          );
      });

      it('delete removes installation', async () => {
          queryMock.mockResolvedValueOnce({ rows: [] });
          const repo = new TrmnlInstallationRepo();
          await repo.delete('uuid-99');
          expect(queryMock).toHaveBeenCalledWith(
              expect.stringContaining('DELETE FROM "TrmnlInstallation" WHERE uuid = $1'),
              ['uuid-99']
          );
      });
  ```

- [ ] **Step 6: Implement complete TrmnlInstallationRepo**
  Update `cmd/next-app/src/lib/trmnl-installation-repo.ts`:
  ```typescript
  import { pool, TrmnlInstallation } from './db';

  export class TrmnlInstallationRepo {
      // === Queries (Read Operations) ===
      async findByUuid(uuid: string): Promise<TrmnlInstallation | undefined> {
          const { rows } = await pool.query('SELECT * FROM "TrmnlInstallation" WHERE uuid = $1', [uuid]);
          return rows[0] as TrmnlInstallation | undefined;
      }

      async findBySiteId(siteId: string): Promise<TrmnlInstallation | undefined> {
          const { rows } = await pool.query(`
              SELECT * FROM "TrmnlInstallation" 
              WHERE site_id = $1 
              ORDER BY (plugin_setting_id IS NOT NULL) DESC, created_at DESC, id DESC
              LIMIT 1
          `, [siteId]);
          return rows[0] as TrmnlInstallation | undefined;
      }

      async findPendingByPluginId(pluginSettingId: number): Promise<TrmnlInstallation | undefined> {
          const { rows } = await pool.query(
              'SELECT * FROM "TrmnlInstallation" WHERE plugin_setting_id = $1 AND uuid IS NULL',
              [pluginSettingId]
          );
          return rows[0] as TrmnlInstallation | undefined;
      }

      async findLatestLoosePending(): Promise<TrmnlInstallation | undefined> {
          const { rows } = await pool.query(`
              SELECT * FROM "TrmnlInstallation" 
              WHERE uuid IS NULL AND plugin_setting_id IS NULL 
              ORDER BY created_at DESC 
              LIMIT 1
          `);
          return rows[0] as TrmnlInstallation | undefined;
      }

      // === Commands (Write/Mutate Operations) ===
      async create(
          siteId: string,
          uuid: string | null = null,
          pluginSettingId: number | null = null,
          json: unknown = null,
          accessToken: string | null = null
      ): Promise<number> {
          const params = [siteId, uuid || null, pluginSettingId, json, accessToken];
          const query = uuid ? `
              INSERT INTO "TrmnlInstallation" (site_id, uuid, plugin_setting_id, json, access_token)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT(uuid) DO UPDATE SET 
                  site_id = EXCLUDED.site_id,
                  plugin_setting_id = COALESCE(EXCLUDED.plugin_setting_id, "TrmnlInstallation".plugin_setting_id),
                  json = COALESCE(EXCLUDED.json, "TrmnlInstallation".json),
                  access_token = COALESCE(EXCLUDED.access_token, "TrmnlInstallation".access_token)
              RETURNING id
          ` : `
              INSERT INTO "TrmnlInstallation" (site_id, uuid, plugin_setting_id, json, access_token)
              VALUES ($1, $2, $3, $4, $5)
              RETURNING id
          `;
          const { rows } = await pool.query(query, params);
          return rows[0].id;
      }

      async upsertSettings(uuid: string, siteId: string, json: unknown, pluginSettingId: number | null): Promise<number> {
          const query = `
              INSERT INTO "TrmnlInstallation" (uuid, site_id, json, plugin_setting_id)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT(uuid) DO UPDATE SET 
                  site_id = EXCLUDED.site_id,
                  json = EXCLUDED.json,
                  plugin_setting_id = COALESCE(EXCLUDED.plugin_setting_id, "TrmnlInstallation".plugin_setting_id)
              RETURNING id
          `;
          const { rows } = await pool.query(query, [uuid, siteId, json, pluginSettingId]);
          return rows[0].id;
      }

      async updatePluginId(uuid: string, pluginSettingId: number): Promise<void> {
          await pool.query(
              'UPDATE "TrmnlInstallation" SET plugin_setting_id = $1 WHERE uuid = $2',
              [pluginSettingId, uuid]
          );
      }

      async updateJson(id: number, json: unknown): Promise<void> {
          await pool.query(
              'UPDATE "TrmnlInstallation" SET json = $1 WHERE id = $2',
              [json, id]
          );
      }

      async claimPendingById(id: number, uuid: string, pluginSettingId: number, json: unknown): Promise<void> {
          await pool.query(`
              UPDATE "TrmnlInstallation"
              SET uuid = $1, plugin_setting_id = $2, json = $3
              WHERE id = $4
          `, [uuid, pluginSettingId, json, id]);
      }

      async claimPending(pluginSettingId: number, uuid: string, json: unknown): Promise<void> {
          await pool.query(`
              UPDATE "TrmnlInstallation"
              SET uuid = $1, json = $2
              WHERE plugin_setting_id = $3 AND uuid IS NULL
          `, [uuid, json, pluginSettingId]);
      }

      async delete(uuid: string): Promise<void> {
          await pool.query('DELETE FROM "TrmnlInstallation" WHERE uuid = $1', [uuid]);
      }
  }
  ```

- [ ] **Step 7: Run test to verify all tests pass**
  Run: `npx vitest run src/lib/trmnl-installation-repo.test.ts`
  Expected: PASS

- [ ] **Step 8: Commit**
  ```bash
  git add src/lib/trmnl-installation-repo.ts src/lib/trmnl-installation-repo.test.ts
  git commit -m "feat: implement TrmnlInstallationRepo with CQRS pattern"
  ```

---

### Task 2: Update UserRepo

**Files:**
- Modify: `cmd/next-app/src/lib/user-repo.ts`
- Modify: `cmd/next-app/src/lib/user-repo.test.ts`

- [ ] **Step 1: Write failing tests for email synchronization**
  Append to `cmd/next-app/src/lib/user-repo.test.ts`:
  ```typescript
  describe('UserRepo email synchronization', () => {
      beforeEach(() => {
          queryMock.mockReset();
      });

      it('getUserEmail fetches email column', async () => {
          queryMock.mockResolvedValueOnce({ rows: [{ email: 'test@trmnl.com' }] });
          const repo = new UserRepo();
          const email = await repo.getUserEmail('user-123');
          expect(email).toBe('test@trmnl.com');
          expect(queryMock).toHaveBeenCalledWith(
              'SELECT email FROM "User" WHERE id = $1',
              ['user-123']
          );
      });

      it('updateUserEmail updates email column', async () => {
          queryMock.mockResolvedValueOnce({ rows: [] });
          const repo = new UserRepo();
          await repo.updateUserEmail('user-123', 'new@trmnl.com');
          expect(queryMock).toHaveBeenCalledWith(
              'UPDATE "User" SET email = $1 WHERE id = $2',
              ['new@trmnl.com', 'user-123']
          );
      });
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**
  Run: `npx vitest run src/lib/user-repo.test.ts`
  Expected: FAIL (methods not defined).

- [ ] **Step 3: Implement getUserEmail and updateUserEmail in UserRepo**
  Add the following methods at the end of the `UserRepo` class in `cmd/next-app/src/lib/user-repo.ts`:
  ```typescript
      // === Queries ===
      async getUserEmail(userId: string): Promise<string | null> {
          const res = await pool.query('SELECT email FROM "User" WHERE id = $1', [userId]);
          return res.rows.length > 0 ? res.rows[0].email : null;
      }

      // === Commands ===
      async updateUserEmail(userId: string, email: string): Promise<void> {
          await pool.query('UPDATE "User" SET email = $1 WHERE id = $2', [email, userId]);
      }
  ```

- [ ] **Step 4: Run tests to verify they pass**
  Run: `npx vitest run src/lib/user-repo.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  ```bash
  git add src/lib/user-repo.ts src/lib/user-repo.test.ts
  git commit -m "feat: add email sync query and command to UserRepo"
  ```

---

### Task 3: Refactor TrmnlService

**Files:**
- Modify: `cmd/next-app/src/lib/trmnl-service.ts`

- [ ] **Step 1: Replace raw SQL queries with calls to TrmnlInstallationRepo**
  Modify `cmd/next-app/src/lib/trmnl-service.ts` to instantiate and use `TrmnlInstallationRepo` for all database interactions.
  
  Replace lines 1-36 with:
  ```typescript
  import { TrmnlInstallation } from './db';
  import { TrmnlInstallationRepo } from './trmnl-installation-repo';

  export class TrmnlService {
      private dbRepo = new TrmnlInstallationRepo();

      async createInstallation(siteId: string, uuid: string | null = null, pluginSettingId: number | null = null, details: unknown = null, accessToken: string | null = null): Promise<number> {
          return this.dbRepo.create(siteId, uuid, pluginSettingId, details, accessToken);
      }
  ```

  Replace `updateInstallation` (lines 53-60) with:
  ```typescript
      async updateInstallation(uuid: string, pluginSettingId: number) {
          await this.dbRepo.updatePluginId(uuid, pluginSettingId);
          TrmnlService.getCache().delete(uuid);
      }
  ```

  Replace `getInstallationByUuid` raw SQL fetch (lines 70-76) with:
  ```typescript
          } else {
              installation = await this.dbRepo.findByUuid(uuid);

              if (installation) {
                  TrmnlService.getCache().set(uuid, { data: installation, expires: now + TrmnlService.CACHE_TTL_MS });
              }
          }
  ```

  Replace `getInstallationBySiteId` raw SQL fetch (lines 89-95) with:
  ```typescript
      async getInstallationBySiteId(siteId: string, options: { includeTokens?: boolean } = {}): Promise<TrmnlInstallation | undefined> {
          const installation = await this.dbRepo.findBySiteId(siteId);
  ```

  Replace `deleteInstallation` (lines 106-108) with:
  ```typescript
      async deleteInstallation(uuid: string) {
          await this.dbRepo.delete(uuid);
      }
  ```

  Replace `getInstallationByPendingPluginId` (lines 131-134) with:
  ```typescript
      async getInstallationByPendingPluginId(pluginSettingId: number): Promise<TrmnlInstallation | undefined> {
          return this.dbRepo.findPendingByPluginId(pluginSettingId);
      }
  ```

  Replace `getLatestLoosePendingInstallation` (lines 136-145) with:
  ```typescript
      async getLatestLoosePendingInstallation(): Promise<TrmnlInstallation | undefined> {
          return this.dbRepo.findLatestLoosePending();
      }
  ```

  Replace `claimPendingInstallationById` (lines 147-153) with:
  ```typescript
      async claimPendingInstallationById(id: number, uuid: string, pluginSettingId: number, json: unknown) {
          await this.dbRepo.claimPendingById(id, uuid, pluginSettingId, json);
      }
  ```

  Replace `claimPendingInstallation` (lines 155-161) with:
  ```typescript
      async claimPendingInstallation(pluginSettingId: number, uuid: string, json: unknown) {
          await this.dbRepo.claimPending(pluginSettingId, uuid, json);
      }
  ```

- [ ] **Step 2: Run all tests to verify correct delegation**
  Run: `npm run test`
  Expected: All 257 tests PASS.

- [ ] **Step 3: Commit**
  ```bash
  git add src/lib/trmnl-service.ts
  git commit -m "refactor: delegate TrmnlService DB calls to TrmnlInstallationRepo"
  ```

---

### Task 4: Refactor api/trmnl/manage Route

**Files:**
- Modify: `cmd/next-app/src/app/api/trmnl/manage/route.ts`

- [ ] **Step 1: Replace direct pool query with repository call**
  In `cmd/next-app/src/app/api/trmnl/manage/route.ts`:
  *   Remove `pool` import on line 5.
  *   Import `TrmnlInstallationRepo` from `@/lib/trmnl-installation-repo`.
  *   Instantiate `TrmnlInstallationRepo`.
  *   Replace raw query upsert with `upsertSettings`.

  Specifically, replace lines 229-239:
  ```typescript
          const query = `
              INSERT INTO "TrmnlInstallation" (uuid, site_id, json, plugin_setting_id)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT(uuid) DO UPDATE SET 
                  site_id = EXCLUDED.site_id,
                  json = EXCLUDED.json,
                  plugin_setting_id = COALESCE(EXCLUDED.plugin_setting_id, "TrmnlInstallation".plugin_setting_id)
              RETURNING id
          `;

          const { rows } = await pool.query(query, [uuid, site_id, mergedJson, pluginSettingId]);
  ```
  With:
  ```typescript
          const installationRepo = new TrmnlInstallationRepo();
          const savedId = await installationRepo.upsertSettings(uuid, site_id, mergedJson, pluginSettingId);
  ```

  And change the check on line 241 to:
  ```typescript
          if (!savedId) {
  ```

- [ ] **Step 2: Run tests to verify**
  Run: `npm run test`
  Expected: PASS

- [ ] **Step 3: Commit**
  ```bash
  git add src/app/api/trmnl/manage/route.ts
  git commit -m "refactor: replace raw SQL in manage route with TrmnlInstallationRepo"
  ```

---

### Task 5: Refactor api/trmnl/webhook Route

**Files:**
- Modify: `cmd/next-app/src/app/api/trmnl/webhook/route.ts`

- [ ] **Step 1: Replace raw SQL user email queries with UserRepo and SiteRepo**
  In `cmd/next-app/src/app/api/trmnl/webhook/route.ts`:
  *   Remove raw SQL database imports.
  *   Import `SiteRepo` and `UserRepo`.
  *   Instantiate repositories.
  *   Replace raw SQL user-owner lookup and email update with repo methods.

  Replace lines 112-129 (inside the `existing` installation block):
  ```typescript
              // Update user email if not present
              if (user.email && existing.site_id) {
                  const { pool } = await import('@/lib/db');

                  // Get the user_id from the site
                  const siteRes = await pool.query('SELECT user_id FROM "Site" WHERE id = $1', [existing.site_id]);
                  if (siteRes.rows.length > 0 && siteRes.rows[0].user_id) {
                      const userId = siteRes.rows[0].user_id;

                      // Check if user already has an email
                      const userRes = await pool.query('SELECT email FROM "User" WHERE id = $1', [userId]);
                      if (userRes.rows.length > 0 && !userRes.rows[0].email) {
                          // Update user with email from Trmnl
                          await pool.query('UPDATE "User" SET email = $1 WHERE id = $2', [user.email, userId]);
                          console.log(`[TrmnlWebhook] Updated user ${userId} with email from Trmnl: ${user.email}`);
                      }
                  }
              }
  ```
  With:
  ```typescript
              // Update user email if not present
              if (user.email && existing.site_id) {
                  const siteRepo = new SiteRepo();
                  const userRepo = new UserRepo();
                  const site = await siteRepo.getSite(existing.site_id);
                  if (site && site.user_id) {
                      const currentEmail = await userRepo.getUserEmail(site.user_id);
                      if (!currentEmail) {
                          await userRepo.updateUserEmail(site.user_id, user.email);
                          console.log(`[TrmnlWebhook] Updated user ${site.user_id} with email from Trmnl: ${user.email}`);
                      }
                  }
              }
  ```

  Do the same for the `pending` installation block (replace lines 167-184) with:
  ```typescript
                  // Update user email if not present
                  if (user.email && pending.site_id) {
                      const siteRepo = new SiteRepo();
                      const userRepo = new UserRepo();
                      const site = await siteRepo.getSite(pending.site_id);
                      if (site && site.user_id) {
                          const currentEmail = await userRepo.getUserEmail(site.user_id);
                          if (!currentEmail) {
                              await userRepo.updateUserEmail(site.user_id, user.email);
                              console.log(`[TrmnlWebhook] Updated user ${site.user_id} with email from Trmnl: ${user.email}`);
                          }
                      }
                  }
  ```

- [ ] **Step 2: Run tests to verify**
  Run: `npm run test`
  Expected: PASS

- [ ] **Step 3: Commit**
  ```bash
  git add src/app/api/trmnl/webhook/route.ts
  git commit -m "refactor: replace raw SQL user/site sync in webhook route with SiteRepo and UserRepo"
  ```

---

### Task 6: Refactor api/trmnl/markup Route

**Files:**
- Modify: `cmd/next-app/src/app/api/trmnl/markup/route.ts`

- [ ] **Step 1: Replace direct pool query with repository call**
  In `cmd/next-app/src/app/api/trmnl/markup/route.ts`:
  *   Remove `pool` import on line 23.
  *   Import `TrmnlInstallationRepo` from `@/lib/trmnl-installation-repo`.
  *   Instantiate `TrmnlInstallationRepo`.
  *   Replace raw SQL updating `"TrmnlInstallation"` json with `repo.updateJson(installation.id, nextJson)`.

  Specifically, replace lines 153-160:
  ```typescript
                      after(async () => {
                          try {
                              await pool.query('UPDATE "TrmnlInstallation" SET json = $1 WHERE id = $2', [nextJson, installation!.id]);
                          } catch (error) {
                              console.warn(`[TrmnlMarkup] Failed to advance carousel index for installation ${installation!.id}:`, error);
                          }
                      });
  ```
  With:
  ```typescript
                      const trmnlInstallationRepo = new TrmnlInstallationRepo();
                      after(async () => {
                          try {
                              await trmnlInstallationRepo.updateJson(installation!.id, nextJson);
                          } catch (error) {
                              console.warn(`[TrmnlMarkup] Failed to advance carousel index for installation ${installation!.id}:`, error);
                          }
                      });
  ```

- [ ] **Step 2: Run tests to verify**
  Run: `npm run test`
  Expected: PASS

- [ ] **Step 3: Commit**
  ```bash
  git add src/app/api/trmnl/markup/route.ts
  git commit -m "refactor: replace raw SQL updating installation configuration in markup route with TrmnlInstallationRepo"
  ```

---

### Task 7: Final Verification

- [ ] **Step 1: Run complete test suite**
  Run: `npm run test`
  Expected: All tests pass.

- [ ] **Step 2: Run build compiler check**
  Run: `npm run build`
  Expected: Successful compilation, no TypeScript or Next.js build errors.
