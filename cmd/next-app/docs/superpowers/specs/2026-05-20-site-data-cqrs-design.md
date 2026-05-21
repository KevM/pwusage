# Spec: Site Data Access — CQRS Repository Refactor

**Author:** Brainstormed with AI Coding Assistant
**Date:** 2026-05-20
**Status:** Pending User Review
**Spec Path:** `cmd/next-app/docs/superpowers/specs/2026-05-20-site-data-cqrs-design.md`
**Precedent:** `cmd/next-app/docs/superpowers/specs/2026-05-20-trmnl-data-decoupling-design.md` (PR #58)

---

## 1. Goals & Non-Goals

### Goals
1. Apply the TRMNL precedent — `=== Queries ===` / `=== Commands ===` headers in a single class per primary aggregate — across all site-domain repos.
2. Eliminate raw `pool.query` calls outside the `lib/*-repo.ts` layer. Routes, pages, services, and the Importer must go through repos.
3. Introduce a dedicated `TariffRepo` owning Tariff / TariffSeason / TariffSchedule reads and writes (currently split between `SiteRepo`'s JOIN and the Importer's raw SQL).
4. Clean up `UserRepo`: fold the four module-level functions into the class, label sections, and remove embedded SQL from `verifyUserStatus`.
5. Refactor the Importer to pure orchestration over repo commands — no INSERT/UPDATE/DELETE leakage outside repos.

### Non-Goals
- No functional behavior change. This is a pure refactor.
- No DI / constructor-injection retrofit. We keep the existing `new SiteRepo()` instantiation pattern (matches TRMNL precedent, avoids churn at call sites).
- `app/api/health/route.ts`'s diagnostic counts stay inline.
- No new test framework. New tests follow existing `*-repo.test.ts` conventions.

---

## 2. Target Architecture

```
┌─────────────────┐     ┌──────────────────┐
│  Routes / Pages │     │  Cron / Importer │
└────────┬────────┘     └────────┬─────────┘
         │                       │
         ▼                       ▼
┌──────────────────────────────────────────┐
│  Services (orchestration only)           │
│  TrmnlService · SiteService · Importer   │
└────────┬─────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────┐
│  Repos (only layer that touches `pool`)  │
│  SiteRepo · TariffRepo · EnergyRepo      │
│  UserRepo · TrmnlInstallationRepo        │
│  TeslaTokenRepo · LoadTagRepo · …        │
└──────────────────────────────────────────┘
                  │
                  ▼
            ┌──────────┐
            │ Postgres │
            └──────────┘
```

### Layering rules
- **Routes / pages:** HTTP/UI concerns only. May call repos directly for simple reads or call a service for orchestration.
- **Services:** orchestrate multiple repos + external API clients (Tesla, TRMNL). No SQL. The Importer is a service in this sense.
- **Repos:** sole owner of SQL for their table(s). One class, two sections — Queries above, Commands below.
- **No cross-talk between repos at the SQL level.** Either a repo doing a JOIN owns the full result, or the caller composes two repo calls.

### Cross-aggregate JOIN ownership rule
When a single query JOINs across two aggregates, it lives in the repo of the table named first in the result row's primary identity.
- `getInstallationAndSite` (TrmnlInstallation + Site + User) → `TrmnlInstallationRepo.findByUuidWithSite`.
- `UserRepo.getAllUsers` (User + EnergyData + TrmnlInstallation + Site) → stays in `UserRepo` (User-anchored admin overview).
- `SiteRepo.getSitesWithTariffs` (Site + Tariff + TariffSeason + TariffSchedule) → stays in `SiteRepo` (Site-anchored hot path; the alternative of two queries + manual stitching is costlier than the JOIN purity gain).

---

## 3. Repo Inventory & Per-Repo Changes

### A. `SiteRepo` (existing, 272 lines)
Mostly stays. Add labels, lose TRMNL coupling, gain a few commands.

```typescript
export class SiteRepo {
    // === Queries ===
    getSite(siteId, options?)
    getSites(options?)
    getSitesForUser(userId, options?)
    getSitesWithTariffs(siteIds, options?)   // keeps Tariff JOIN
    getSiteIds()
    getSiteJson(siteId)                       // NEW — used by Importer.ensureSite

    // === Commands ===
    updateSiteBillingDay(siteId, day)
    updateSiteTimezoneDisplayMode(siteId, mode)
    upsertSite(...)                          // NEW — moved from Importer.ensureSite
    assignSiteToUser(siteId, userId)         // NEW — moved from auth-callback
    invalidateCache(siteId)
}
```
**Removed:** `getInstallationAndSite` (moves to `TrmnlInstallationRepo`).

### B. `TariffRepo` (NEW)
```typescript
export class TariffRepo {
    // === Queries ===
    getTariffsForSite(siteId): Promise<Tariff[]>      // Tariff + seasons + schedules
    getTariffById(tariffId): Promise<Tariff | undefined>

    // === Commands ===
    replaceTariffsForSite(siteId, tariffs)             // transactional; cascade DELETE then INSERT
}
```
`replaceTariffsForSite` owns its own transaction internally — the Importer never sees a `pg.PoolClient`.

### C. `EnergyRepo` (existing, 465 lines)
Add labels. Add commands for what the Importer writes.

```typescript
export class EnergyRepo {
    // === Queries ===
    getUsageByTOU, getCycleAndTodayTotals, getTodayTotals,
    hasData, getLatestEnergyData, getCycleAggregates,
    getRawEnergyData, getBucketedEnergyData, getRawEnergyDataWithTz,
    getLatestTimestamp                       // NEW — small read pulled out of importer

    // === Commands ===
    insertEnergyDataBatch(rows)              // NEW — bulk INSERT … ON CONFLICT DO UPDATE; pool-scoped (idempotent)
    cleanupOldEnergyData(cutoffDate)
}
```

### D. `UserRepo` (existing, 206 lines — cleanup)
Fold module-level functions into the class. Remove embedded SQL from `verifyUserStatus`.

```typescript
export class UserRepo {
    // === Queries ===
    getById(userId)                          // NEW — replaces app/profile/page.tsx raw SQL
    getUserEmail(userId)
    getByAccessToken(token)                  // FOLDED from getUserByToken
    getTokens(userId)                        // FOLDED from getUserTokens
    getTokensForSite(siteId)                 // FOLDED from getUserTokensForSite
    isActive(userId)                         // FOLDED from isUserActive
    getAllUsers(options?)                    // admin overview with cross-table JOINs

    // === Commands ===
    upsertOnTeslaAuth(userId, email, tokens) // NEW — replaces auth-callback raw User upsert
    updateUserEmail(userId, email)
    updateUserStatus(userId, authStatus, isActive)
    updateLastChecked(userId)
    updateTokens(userId, accessToken, refreshToken)  // NEW — replaces inline UPDATEs in verifyUserStatus / tesla-token-repo
}
```

**`isUserActive` caveat:** the current free function is wrapped in React's `cache()` for per-request memoization. We keep a thin module-level `cache()`'d wrapper that delegates to `repo.isActive()` — preserves behavior, minimal code.

### E. `TeslaTokenRepo` (existing)
Add Q/C labels. Internal `pool.query` token UPDATEs (lines 11, 40, 94, 118) switch to `UserRepo.updateTokens` / `UserRepo.updateUserStatus`. The lock-acquisition SQL stays — that's its specific responsibility.

### F. `TrmnlInstallationRepo` (existing — one addition)
Add `findByUuidWithSite(uuid, options)` to absorb `SiteRepo.getInstallationAndSite`. Internally composes `findByUuid` + `SiteRepo.getSite` — two queries instead of one JOIN. Read amplification accepted; each query is well-bounded and indexed.

### G. Other existing repos (label-only)
`LoadTagRepo`, `AnnouncementRepo`. Add `=== Queries ===` / `=== Commands ===` headers; no structural change.

---

## 4. Refactored Data Flows

### `app/api/trmnl/markup/route.ts`
**Before:** `siteRepo.getInstallationAndSite(uuid, { includeTokens: true })`.
**After:** `trmnlInstallationRepo.findByUuidWithSite(uuid, { includeTokens: true })`.

### `app/auth/tesla-callback/route.ts`
**Before:** raw `INSERT INTO "User" … ON CONFLICT`, `SELECT roles`, `UPDATE "Site" SET user_id`.
**After:**
```ts
await userRepo.upsertOnTeslaAuth({ userId, email, accessToken, refreshToken, tokenExpiresAt });
const roles = (await userRepo.getById(userId))?.roles ?? [];
// in product loop:
await siteRepo.assignSiteToUser(siteId, userId);
```

### `app/profile/page.tsx`
**Before:** `pool.query('SELECT * FROM "User" WHERE id = $1', [firstSite.user_id])`.
**After:** `await userRepo.getById(firstSite.user_id)`.

### `app/api/health/route.ts`
**Out of scope** — diagnostic counts stay inline.

### Callers of the four UserRepo free functions
~10 files switch to instance methods or to the `cache()`'d wrapper for `isUserActive`.

### `lib/tesla-token-repo.ts`
Internal token UPDATEs switch to calling `UserRepo.updateTokens` / `UserRepo.updateUserStatus`.

### `lib/today-refresh.ts`, `lib/auth-checks.ts`, `lib/auth-jwt.ts`
Call sites for the formerly-free functions update to the new instance methods (or the `cache()`'d wrapper).

---

## 5. Importer Rewrite

The Importer is the biggest unit affected. Goal: zero `pool.query` / `client.query` inside `lib/importer/` after refactor.

### Current shape (`lib/importer/index.ts`, ~700 lines)
Three write paths interleaved with API calls + transforms:
- **`ensureSite`** — `SELECT json FROM Site`, `INSERT INTO Site … ON CONFLICT`, then tariff replacement (DELETE schedules → seasons → tariffs, INSERT new ones).
- **EnergyData ingest loop** — `INSERT INTO EnergyData … ON CONFLICT … DO UPDATE` in a hot loop, plus surrounding reads.
- **Misc reads** — `SELECT json FROM Site`, latest-timestamp lookups.

### Target shape

```ts
class Importer {
    constructor(
        private client: TeslaClient,
        private siteRepo = new SiteRepo(),
        private tariffRepo = new TariffRepo(),
        private energyRepo = new EnergyRepo(),
    ) {}

    async ensureSite(siteId: string) {
        const existing = await this.siteRepo.getSiteJson(siteId);
        const product = await this.client.getProducts().find(...);
        await this.siteRepo.upsertSite({...});
        if (productTariffs) {
            await this.tariffRepo.replaceTariffsForSite(siteId, parsed);
        }
    }

    async importDay(siteId, day) {
        const latest = await this.energyRepo.getLatestTimestamp(siteId);
        const rows = await this.client.getEnergyHistory(siteId, day);
        const transformed = transform(rows, ...);
        await this.energyRepo.insertEnergyDataBatch(transformed);
    }
}
```

### Transaction scope — design decision
- `TariffRepo.replaceTariffsForSite` owns its own transaction internally. A single repo call = a single transaction.
- `EnergyRepo.insertEnergyDataBatch` runs on the pool, idempotent via ON CONFLICT — no transaction needed (matches current behavior).
- **The Importer never sees `pg.PoolClient`.** Repos hide transaction details. Simpler call sites, less leakage of pg internals.

### Files touched
- `lib/importer/index.ts` — major rewrite (drops ~150 lines of SQL, gains repo calls).
- `lib/importer/tariff-parser.ts` — untouched (produces the structure TariffRepo writes).

---

## 6. Phasing (one PR, sequenced commits)

One PR matching the TRMNL precedent (#58). Each commit must keep `npm run build`, `npm run lint`, and `npm test` green on its own.

1. **docs:** add design spec + implementation plan.
2. **refactor(repos):** add `=== Queries ===` / `=== Commands ===` headers across `SiteRepo`, `EnergyRepo`, `UserRepo`, `TeslaTokenRepo`, `LoadTagRepo`, `AnnouncementRepo`. No method changes.
3. **refactor(user-repo):** fold the four module-level functions into `UserRepo` methods; keep `cache()`'d `isUserActive` wrapper. Update all callers.
4. **feat(user-repo):** add `getById`, `upsertOnTeslaAuth`, `updateTokens` commands with tests.
5. **feat(site-repo):** add `assignSiteToUser`, `upsertSite`, `getSiteJson` commands with tests.
6. **refactor(profile,auth-callback):** route + page switch to new repo methods; raw SQL deleted.
7. **feat(tariff-repo):** new `TariffRepo` with `getTariffsForSite`, `getTariffById`, `replaceTariffsForSite` (transactional). Full test suite.
8. **refactor(importer): ensure-site** path switches to `SiteRepo.upsertSite` + `TariffRepo.replaceTariffsForSite`. Tariff cascade SQL deleted from importer.
9. **feat(energy-repo):** add `insertEnergyDataBatch`, `getLatestTimestamp` commands with tests.
10. **refactor(importer): day-loop** switches to `EnergyRepo.insertEnergyDataBatch`. Bulk INSERT SQL deleted from importer.
11. **refactor(trmnl,site-repo):** move `getInstallationAndSite` → `TrmnlInstallationRepo.findByUuidWithSite`; markup route updated; `SiteRepo.getInstallationAndSite` deleted.
12. **refactor(tesla-token-repo):** internal token UPDATEs call `UserRepo.updateTokens` / `UserRepo.updateUserStatus`.

### Risk gates within the PR
- **Commit 6** (auth-callback) — sensitive auth flow; manual smoke test of Tesla OAuth before merge.
- **Commit 8** (importer/ensureSite) — touches the tariff replacement transaction; verify cascade DELETE still atomic.
- **Commit 10** (importer/day-loop) — hot path; confirm batched INSERT shape unchanged (one statement, not N).

---

## 7. Test Plan

Tests follow the existing `*-repo.test.ts` pattern: real Postgres, no SQL mocks. Each commit ships its tests with it.

### New repo test files
- `tariff-repo.test.ts` — `replaceTariffsForSite` round-trip + cascade DELETE; `getTariffsForSite`; `getTariffById`.
- `energy-repo.test.ts` — extend with `insertEnergyDataBatch` (ON CONFLICT update + batch size) and `getLatestTimestamp`.
- `user-repo.test.ts` — extend with `getById`, `upsertOnTeslaAuth` (insert + update branches), `updateTokens`, and the folded class methods.
- `site-repo.test.ts` — extend with `assignSiteToUser`, `upsertSite`, `getSiteJson`.
- `trmnl-installation-repo.test.ts` — extend with `findByUuidWithSite` (both `includeTokens` branches).

### Behavior-preservation checks (per commit)
- Commit 2: zero diff in test results.
- Commit 3: all existing tests still pass; new tests for any newly-exposed class method.
- Commit 6: auth-callback manual smoke (Tesla OAuth round-trip from `/login` to dashboard); profile page renders.
- Commit 8: existing importer tests stay green; new `tariff-repo.test.ts` covers the cascade.
- Commit 10: existing importer tests stay green; verify SQL emitted is still one bulk INSERT (not N).

### What we don't test
- No new performance benchmarks. The bulk-INSERT shape check is the only perf guard.
- No new integration tests for the full Tesla OAuth flow — existing manual smoke per `Authentication.md` suffices.

### Verification gate before requesting review
```
npm run build
npm run lint
npm test           # all existing + new tests must pass
npm run dev        # manual: profile page loads; /login → /products works; site/[id] renders; /api/trmnl/markup returns 200
```

---

## 8. Future Work

Out of scope here, queued for a follow-on PR:
- **Service-level extraction.** After this refactor settles, look for repeated repo-access patterns across routes/services and extract them into reusable service functions. The current refactor only flattens SQL into repos; the next step is consolidating common compositions (e.g. "load site + tariffs + tokens for authorized markup request").

---

## 9. Self-Review Check
- **Placeholder scan:** None. All sections concrete.
- **Internal consistency:** Repo method names in Section 3 match the data-flow usages in Section 4 and the commit list in Section 6. Transaction-scope decision (Section 5) consistent with Section 3 (TariffRepo owns its transaction; EnergyRepo batch insert is pool-scoped).
- **Scope check:** Refactor is broad (all site-domain repos + Importer) but coherent under one CQRS theme and one PR. The 12-commit sequence makes the diff reviewable in slices.
- **Ambiguity check:** Cross-aggregate JOIN ownership rule (Section 2) and the `isUserActive` `cache()` wrapper (Section 3D) are the two places ambiguity could arise; both are explicitly resolved.
