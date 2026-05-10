# EnergyRepo Decomposition Design

## Purpose
`energy-repo.ts` has grown into a god-class (761 lines) responsible for Energy Data, Tesla Auth Tokens, Load Tags, Sites, Tariffs, and User queries. This design decomposes it into domain-specific repositories while maintaining the existing class-based repository pattern.

## Architecture

We will extract the non-energy logic into three new classes and move user-specific functions to the existing `user-repo.ts`.

### 1. `tesla-token-repo.ts`
**Purpose:** Manage Tesla API token persistence, locking, and concurrent refresh synchronization.
**Class:** `TeslaTokenRepo`
**Dependencies:** Takes `SiteRepo` via constructor dependency injection.
**Methods Extracted from EnergyRepo:**
- `acquireRefreshLock`
- `releaseRefreshLock`
- `waitForTokenRefresh`
- `getLockedRefreshHandler`
- `updateSiteTokens`

### 2. `load-tag-repo.ts`
**Purpose:** Manage "Load Tags" which represent categorized spans of energy usage.
**Class:** `LoadTagRepo`
**Methods Extracted from EnergyRepo:**
- `getLoadTags`
- `addLoadTag`
- `removeLoadTag`
- `cleanupOldTags` (extracted from `EnergyRepo.cleanupOldData`)

### 3. `site-repo.ts`
**Purpose:** Manage database interactions and caching for Sites, Tariffs, Seasons, and Schedules.
**Class:** `SiteRepo`
**Methods Extracted from EnergyRepo:**
- `getSitesForUser`
- `getInstallationAndSite`
- `getSitesWithTariffs`
- `getSite`
- `loadSitesFromDB` (private)
- `assembleFromRows` (private)
- `getSiteIds`
- `getSites`
- `updateSiteBillingDay`
- `updateSiteTimezoneDisplayMode`
- `invalidateCache`

### 4. `user-repo.ts` (Existing File)
**Purpose:** Manage user queries.
**Functions Moved from EnergyRepo:**
- `getUserByToken`
- `getUserTokens`
- `getUserTokensForSite`

### 5. `energy-repo.ts` (Retained Logic)
**Purpose:** Read/write raw and aggregated `EnergyData`.
**Class:** `EnergyRepo`
**Dependencies:** Will instantiate or take `SiteRepo` to fetch site tariffs for TOU calculations.
**Retained Methods:**
- `getUsageByTOU`
- `getCycleAggregates`
- `getRawEnergyData`
- `getBucketedEnergyData`
- `getRawEnergyDataWithTz`
- `hasData`
- `getLatestEnergyData`
- `cleanupOldEnergyData` (renamed from `cleanupOldData`)

## Testing
- Ensure `npm run test` passes.
- Update `energy-repo.test.ts` to test only `EnergyRepo` methods, and move site-related tests to a new `site-repo.test.ts`.
- Update all 30+ files importing `EnergyRepo` to import the appropriate new repositories.
- The `cleanup` cron route (`/api/cron/cleanup/route.ts`) must be updated to call both `EnergyRepo.cleanupOldEnergyData` and `LoadTagRepo.cleanupOldTags`.
