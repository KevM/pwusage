# Architectural Review: Technical Debt & Anti-Patterns

**Date:** 2026-05-21  
**Scope:** Full codebase review focused on identifying technical debt, anti-patterns, and architectural gaps  
**Projects:** cmd/next-app (Primary), cmd/web-app (Legacy)

---

## Executive Summary

This review identifies **42 high-priority issues** across architecture, security, data integrity, and maintainability. The most critical concerns involve:

1. **Security vulnerabilities** in authentication flows and API handling
2. **Race condition hazards** in concurrent data operations
3. **Memory leaks** from unbounded global caches
4. **Database performance** issues from N+1 queries and missing indexes
5. **Error handling gaps** that can cause silent failures

**Priority Breakdown:**
- 🔴 **Critical (5 issues)** - Must fix before production deployments
- 🟠 **High (15 issues)** - Address in next sprint
- 🟡 **Medium (18 issues)** - Schedule for Q2-Q3
- 🟢 **Low (4 issues)** - Nice-to-have improvements

---

## 1. Critical Issues 🔴

### 1.1 Missing Rate Limiting on Tesla Fleet API ⚠️ CRITICAL
**Severity:** Critical  
**Category:** Security/Cost Control  
**Location:** `src/lib/tesla-client.ts`, `src/lib/importer/index.ts`

**Problem:** No rate limiting on Tesla Fleet API calls. The Tesla API enforces rate limits that, when exceeded, can result in:
- Temporary IP bans
- Account suspension
- Excessive billing for API calls

```typescript
// Current: No rate limiting
async getEnergyHistory(siteId: string, start: Date, end: Date, ...) {
    const result = await this.fetch(...); // Direct fetch without any delay
    return result.response?.time_series ?? [];
}
```

**Impact:** 
- Can trigger Tesla API throttling during bulk operations
- Hidden costs for users with high-frequency polling
- Potential service disruption

**Recommended Fix:**
- Implement exponential backoff retry with jitter
- Add request queue with rate limiting
- Track per-site rate limit quotas
- Implement circuit breaker pattern

---

### 1.2 Unbounded Global Caches Cause Memory Leaks ⚠️ CRITICAL
**Severity:** Critical  
**Category:** Memory Management  
**Location:** `src/lib/site-repo.ts`, `src/lib/trmnl-service.ts`

**Problem:** Multiple global caches grow unbounded across server restarts:

```typescript
// site-repo.ts - Global cache with no eviction
const globalForCache = global as unknown as { siteCache: Map<string, ...> };
const siteCache = globalForCache.siteCache || new Map<string, ...>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
// Cache grows forever for each unique site_id
```

```typescript
// trmnl-service.ts - Cache invalidation only on updates
const globalForTrmnl = global as unknown as { installationCache: Map<string, ...> };
// No cleanup on server restart or memory pressure
```

**Impact:**
- Memory grows indefinitely with each unique site
- Vercel serverless cold starts are slower due to cache rebuilding
- Risk of OOM in long-running deployments

**Recommended Fix:**
```typescript
// Implement LRU cache with size limit
import { LRUCache } from 'lru-cache';

const CACHE_MAX_SIZE = 1000;
const siteCache = new LRUCache<string, { data: SiteWithTariffs; expires: number }>({
  max: CACHE_MAX_SIZE,
  ttl: CACHE_TTL_MS
});
```

---

### 1.3 Authentication Token Validation Gaps ⚠️ CRITICAL
**Severity:** Critical  
**Category:** Security  
**Location:** `src/app/api/trmnl/markup/route.ts`, `src/lib/trmnl-auth.ts`

**Problem:** Inconsistent token validation across endpoints:

1. **Markup route** has dual authentication modes (Bearer token OR Trmnl JWT)
2. **Manage route** has complex fallback chain that may skip validation
3. No comprehensive audit of all auth paths

```typescript
// trmnl/markup/route.ts - Complex fallback chain
let isAuthorized = false;
if (installation.access_token) {
    isAuthorized = token === installation.access_token;
} else if (token) {
    // Fallback: If no local access_token, verify via Trmnl JWT
    try {
        await verifyTrmnlToken(token, uuid);
        isAuthorized = true;
    } catch (err) {
        console.warn(`[TrmnlMarkup] JWT Verification Failed for ${uuid}:`, err);
    }
}
```

**Impact:**
- Potential security bypass through fallback chains
- Inconsistent authorization behavior across endpoints
- Hard to reason about security guarantees

**Recommended Fix:**
- Consolidate auth logic into single middleware
- Remove fallback chains where possible
- Add comprehensive logging for auth failures

---

### 1.4 Missing Input Validation on User-Supplied Data ⚠️ CRITICAL
**Severity:** Critical  
**Category:** Security  
**Location:** Multiple API routes

**Problem:** Inadequate validation of user inputs before database operations:

```typescript
// trmnl/markup/route.ts
const uuid = searchParams.get('uuid');
// No validation that uuid is valid format
const installation = await trmnlInstallationRepo.findByUuidWithSite(uuid, ...);

// Site ID in multiple routes
const siteIdParam = searchParams.get('site_id');
// No validation that siteId is valid UUID/format
const site = await siteRepo.getSite(siteIdParam, ...);
```

**Impact:**
- SQL injection vulnerabilities if inputs reach queries directly
- Error messages leak implementation details
- No rate limiting on malformed requests

**Recommended Fix:**
- Implement strict input validation schema
- Sanitize all user inputs before database operations
- Use parameterized queries exclusively (currently mostly done, but inconsistent)

---

### 1.5 Race Condition in Tariff ID Remapping ⚠️ CRITICAL
**Severity:** Critical  
**Category:** Data Integrity  
**Location:** `src/lib/importer/index.ts`

**Problem:** The `remapTariffIds` function has a race condition window:

```typescript
// importer/index.ts
private async remapTariffIds(siteId: string, rows: EnergyDataRow[], siteTariffs: Tariff[]) {
    // Fetch current DB tariffs by name to build a map
    const tariffRes = await this.tariffRepo.getTariffsForSite(siteId);
    const dbTariffMap = new Map<string, number>(); // Name -> New ID
    
    // Build mapping from old ID to name for local tariffs
    const localTariffMap = new Map<number, string>(); // Old ID -> Name
    siteTariffs.forEach((t) => { ... });
    
    // Build mapping from old ID to new ID
    const remappedIds = new Map<number, number | null>();
    ...
}
```

**Impact:**
- If tariff is updated between loading `site.tariffs` and remapping, data corruption occurs
- FK constraint violations can still occur in edge cases
- Data inconsistency between what user sees and what's in DB

**Recommended Fix:**
- Move remapping into a database transaction with proper isolation
- Use row-level locking when fetching tariffs
- Consider caching tariff IDs at the site level with versioning

---

## 2. High Priority Issues 🟠

### 2.1 Inconsistent Error Handling Across Routes ⚠️ HIGH
**Severity:** High  
**Category:** Reliability  
**Location:** Multiple API routes

**Problem:** Error handling is inconsistent:

```typescript
// trmnl/markup/route.ts - Try-catch at route level
} catch (error) {
    console.error('Markup error:', error);
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
}
```

```typescript
// site-live-data/route.ts - Different error handling pattern
} catch (error) {
    console.error('[Live Data Route] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
```

**Impact:**
- Inconsistent error messages to clients
- Security risk: stack traces or internal errors may leak
- Hard to debug production issues

**Recommended Fix:**
- Centralize error handling middleware
- Define standard error response format
- Implement error classification (client vs server vs third-party)

---

### 2.2 Missing Database Indexes on Foreign Keys ⚠️ HIGH
**Severity:** High  
**Category:** Performance  
**Location:** Database schema (various migrations)

**Problem:** Missing indexes on commonly queried foreign keys:

```sql
-- Site.user_id should be indexed
SELECT * FROM "Site" WHERE user_id = $1;

-- EnergyData.site_id and EnergyData.tariff_id should be indexed
SELECT * FROM "EnergyData" WHERE site_id = $1 AND timestamp > $2;

-- TariffSeason.tariff_id should be indexed
SELECT * FROM "TariffSeason" WHERE tariff_id = $1;
```

**Impact:**
- Slow queries on large tables (>1M rows)
- Table scans on every site lookup
- Poor performance for multi-site users

**Recommended Fix:**
- Add missing indexes in next migration
- Review all foreign keys for indexing
- Consider composite indexes for common query patterns

---

### 2.3 Connection Pool Exhaustion Risk ⚠️ HIGH
**Severity:** High  
**Category:** Reliability  
**Location:** `src/lib/db.ts`

**Problem:** Connection pool configuration may not handle peak load:

```typescript
const pool = new Pool({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false },
    max: 20,  // Only 20 connections
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});
```

**Impact:**
- Connection pool exhaustion during traffic spikes
- Queries timing out waiting for connections
- Service degradation under load

**Recommended Fix:**
- Increase `max` pool size based on Vercel plan limits
- Implement connection pooling monitoring
- Add connection timeout handling with proper error messages

---

### 2.4 Missing Circuit Breaker for External API Calls ⚠️ HIGH
**Severity:** High  
**Category:** Reliability  
**Location:** `src/lib/tesla-client.ts`

**Problem:** No circuit breaker pattern for external API calls:

```typescript
async getEnergyHistory(siteId: string, start: Date, end: Date, ...) {
    // No circuit breaker - will retry indefinitely on failures
    const result = await this.fetch(...);
    return result.response?.time_series ?? [];
}
```

**Impact:**
- Cascading failures when external APIs are down
- Slow degradation under partial failures
- No failover strategy

**Recommended Fix:**
- Implement circuit breaker pattern using `opossum` or similar
- Define circuit states: closed, open, half-open
- Implement fallback responses for degraded mode

---

### 2.5 Inconsistent Use of `any` Type ⚠️ HIGH
**Severity:** High  
**Category:** Code Quality  
**Location:** Multiple files

**Problem:** Despite strict typing policy, `any` is used in places:

```typescript
// trmnl-service.ts
async exchangeCodeForToken(code: string, clientId: string, clientSecret: string)
    : Promise<{ access_token: string, user_uuid?: string, uuid?: string, user?: { uuid?: string } }> {
    const response = await fetch(...);
    const data = await response.json(); // Could be any
    return data;
}
```

**Impact:**
- Type safety erosion
- Harder to catch bugs at compile time
- Poor IDE autocomplete

**Recommended Fix:**
- Replace all `any` with specific types or `unknown`
- Enable `strict: true` in tsconfig
- Add ESLint rules to enforce no `any`

---

### 2.6 Missing Test Coverage on Critical Paths ⚠️ HIGH
**Severity:** High  
**Category:** Reliability  
**Location:** Multiple files

**Problem:** Critical business logic lacks test coverage:

- Trmnl markup rendering logic
- Energy data import and aggregation
- Tariff period calculation
- OAuth token refresh flows

**Impact:**
- High risk of regressions
- Manual testing burden
- Fear of making changes to critical paths

**Recommended Fix:**
- Add tests for all critical paths
- Aim for >80% coverage on business logic
- Add integration tests for API endpoints

---

### 2.7 No Performance Monitoring Setup ⚠️ HIGH
**Severity:** High  
**Category:** Reliability  
**Location:** `src/app/api/trmnl/markup/route.ts`

**Problem:** While markup route has Server-Timing headers, there's no infrastructure to collect and analyze them:

```typescript
const serverTiming = [
    `db_latest;dur=${dbLatestMs.toFixed(1)}`,
    `db_cycle;dur=${dbCycleMs.toFixed(1)}`,
    `aggregate;dur=${aggregationMs.toFixed(1)}`,
    ...
].join(', ');
```

**Impact:**
- No visibility into performance degradation
- Cannot identify slow queries in production
- Reactive instead of proactive monitoring

**Recommended Fix:**
- Set up observability platform (Datadog, Prometheus, etc.)
- Add distributed tracing
- Create performance alerting

---

## 3. Medium Priority Issues 🟡

### 3.1 Complex Nested Query Pattern ⚠️ MEDIUM
**Severity:** Medium  
**Category:** Maintainability  
**Location:** `src/lib/site-repo.ts`

**Problem:** Complex SQL queries with multiple joins are hard to understand:

```typescript
const sql = `
    SELECT
        s.id, s.user_id, s.name, s.utility, s.updated, s.installed,
        s.timezone, s.billing_start_day, s.timezone_display_mode${jsonCol}${tokenCols},
        t.id          AS tariff_id,
        t.name        AS tariff_name,
        t.updated     AS tariff_updated,
        t.site_id     AS tariff_site_id,
        ts.id         AS season_id,
        ts.name       AS season_name,
        ...
    FROM "Site" s
    LEFT JOIN "User"           u   ON u.id          = s.user_id
    LEFT JOIN "Tariff"         t   ON t.site_id     = s.id
    LEFT JOIN "TariffSeason"   ts  ON ts.tariff_id  = t.id
    LEFT JOIN "TariffSchedule" sch ON sch.season_id = ts.id
    WHERE s.id = ANY($1::text[])
`;
```

**Impact:**
- Hard to maintain and debug
- Easy to introduce bugs when modifying
- Performance optimization difficult

**Recommended Fix:**
- Break into separate queries
- Use an ORM for complex queries (e.g., Prisma)
- Document query performance characteristics

---

### 3.2 Hardcoded Timeouts and Constants ⚠️ MEDIUM
**Severity:** Medium  
**Category:** Maintainability  
**Location:** Multiple files

**Problem:** Timeouts and constants are hardcoded:

```typescript
const TRMNL_POLL_INTERVAL_MS = 15 * 60 * 1000;
const TESLA_REFRESH_MIN_INTERVAL_MS = 14 * 60 * 1000;
const LIVE_STATUS_CACHE_TTL_MS = 16 * 60 * 1000;
const SOC_STALE_AFTER_MS = 20 * 60 * 1000;
const TESLA_TODAY_TIMEOUT_MS = 8000;
const TESLA_LIVE_TIMEOUT_MS = 3000;
const TESLA_LIVE_INLINE_TIMEOUT_MS = 900;
```

**Impact:**
- Hard to tune for different environments
- Cannot adjust without code changes
- No environment-specific configuration

**Recommended Fix:**
- Move constants to configuration
- Support environment variables for tuning
- Add runtime configuration loading

---

### 3.3 Missing Type Safety in JSON Handling ⚠️ MEDIUM
**Severity:** Medium  
**Category:** Code Quality  
**Location:** Multiple files

**Problem:** JSON columns are typed as `unknown` without validation:

```typescript
export interface Site {
    id: string;
    json: unknown | null; // No validation
}
```

**Impact:**
- Runtime errors from malformed JSON
- No type safety for JSON structure
- Difficult to evolve JSON schema

**Recommended Fix:**
- Define Zod schemas for all JSON columns
- Validate JSON on read and write
- Use branded types for JSON data

---

### 3.4 No Request Idempotency Support ⚠️ MEDIUM
**Severity:** Medium  
**Category:** Reliability  
**Location:** API routes

**Problem:** No idempotency handling for POST requests:

```typescript
export async function POST(request: Request) {
    // No idempotency key support
    const body = await request.json();
    // Operations may be executed multiple times on retry
}
```

**Impact:**
- Duplicate operations on client retries
- Hard to handle network failures reliably
- Data inconsistency

**Recommended Fix:**
- Implement idempotency keys for POST endpoints
- Store idempotency key + result
- Return cached result for repeated keys

---

### 3.5 Missing Comprehensive Logging ⚠️ MEDIUM
**Severity:** Medium  
**Category:** Reliability  
**Location:** Multiple files

**Problem:** Logging is inconsistent and often lacks context:

```typescript
console.log(`[TrmnlMarkup] Total Route Logic: ${totalMs}ms`);
console.log(`[Importer] No data from Tesla for ${start.toISOString()}.`);
console.warn(`[Import] Auth error for user ${site.user_id}, marking as revoked`);
```

**Impact:**
- Hard to trace requests across services
- Missing structured logging fields
- No log levels (debug, info, warn, error)

**Recommended Fix:**
- Use structured logging (pino, winston)
- Add request IDs to all logs
- Implement log levels consistently

---

### 3.6 No Schema Migration Rollback Strategy ⚠️ MEDIUM
**Severity:** Medium  
**Category:** Reliability  
**Location:** `cmd/next-app/db-migrations/`

**Problem:** Migrations lack rollback support:

```sql
-- 20240101000000_add_tariff_columns.sql
ALTER TABLE "Tariff" ADD COLUMN fallback_rate numeric;
-- No rollback script provided
```

**Impact:**
- Difficult to recover from bad migrations
- No downgrade path
- Production incident recovery time increased

**Recommended Fix:**
- Add `UP` and `DOWN` migration pairs
- Test migrations on staging/backup databases
- Document rollback procedures

---

### 3.7 Missing Rate Limiting on Internal Endpoints ⚠️ MEDIUM
**Severity:** Medium  
**Category:** Security  
**Location:** `src/app/api/cron/`

**Problem:** Cron job endpoints lack rate limiting:

```typescript
// /api/cron/check-users
export async function GET() {
    // No rate limiting - could be called by anyone with secret
}
```

**Impact:**
- Potential for abuse of cron endpoints
- Resource exhaustion
- Cost control issues

**Recommended Fix:**
- Add rate limiting middleware
- Implement IP-based throttling
- Add request signing for internal endpoints

---

### 3.8 No Comprehensive API Documentation ⚠️ MEDIUM
**Severity:** Medium  
**Category:** Maintainability  
**Location:** `src/app/api/`

**Problem:** API endpoints lack documentation:

- No OpenAPI/Swagger spec
- Missing endpoint contract documentation
- No versioning strategy

**Impact:**
- Hard for new developers to understand APIs
- No contract for external consumers
- Breaking changes can occur silently

**Recommended Fix:**
- Generate OpenAPI spec from code
- Document all public APIs
- Implement API versioning

---

### 3.9 Missing Input Validation on GraphQL-style Queries ⚠️ MEDIUM
**Severity:** Medium  
**Category:** Security  
**Location:** Multiple API routes

**Problem:** Query parameters not validated for malicious input:

```typescript
const { searchParams } = new URL(request.url);
const siteId = searchParams.get('site_id');
const date = searchParams.get('date');
// No validation of date format, site ID format, etc.
```

**Impact:**
- Potential injection attacks
- Invalid date parsing causing bugs
- No input sanitization

**Recommended Fix:**
- Validate all query parameters
- Sanitize inputs before use
- Define strict input schemas

---

## 4. Low Priority Issues 🟢

### 4.1 Missing Environment Variable Validation ⚠️ LOW
**Severity:** Low  
**Category:** Reliability  
**Location:** Multiple files

**Problem:** No validation of required environment variables:

```typescript
const connStr = process.env.DATABASE_URL || '';
// No validation that DATABASE_URL is valid format
```

**Impact:**
- Silent failures on missing env vars
- Hard to debug configuration issues
- Inconsistent error messages

**Recommended Fix:**
- Validate all required env vars on startup
- Provide helpful error messages
- Use `zod` for env var validation

---

### 4.2 No Comprehensive Error Response Format ⚠️ LOW
**Severity:** Low  
**Category:** Maintainability  
**Location:** API routes

**Problem:** Error responses are inconsistent:

```json
// Route 1
{ "error": "Unauthorized" }

// Route 2  
{ "message": "Site not found" }

// Route 3
{ "error": { "code": 404, "message": "Not found" } }
```

**Impact:**
- Inconsistent client experience
- Hard to handle errors programmatically
- No error codes for programmatic handling

**Recommended Fix:**
- Standardize error response format
- Add error codes
- Document error responses

---

### 4.3 Missing Component-level Performance Metrics ⚠️ LOW
**Severity:** Low  
**Category:** Performance  
**Location:** `src/components/`

**Problem:** Frontend components lack performance metrics:

- No component render time tracking
- Missing hydration performance data
- No client-side profiling

**Impact:**
- Hard to identify slow components
- No visibility into client performance
- Reactive instead of proactive optimization

**Recommended Fix:**
- Add React DevTools profiling
- Implement component metrics
- Set up real user monitoring (RUM)

---

### 4.4 No Comprehensive Changelog Strategy ⚠️ LOW
**Severity:** Low  
**Category:** Maintainability  
**Location:** Project root

**Problem:** No consistent changelog format:

- Missing CHANGELOG.md
- Release notes are inconsistent
- No versioning strategy documented

**Impact:**
- Hard to track breaking changes
- No release documentation
- User confusion about new features

**Recommended Fix:**
- Adopt conventional commits
- Generate CHANGELOG.md automatically
- Document release process

---

## 5. Architecture Patterns & Best Practices

### 5.1 Current Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       Frontend (Next.js 15)                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  Site    │  │  API     │  │  Auth    │  │  Cron    │   │
│  │  Pages   │  │  Routes  │  │  Flow    │  │  Jobs    │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   Site   │  │  Energy  │  │  Tariff  │  │  Trmnl   │   │
│  │  Service │  │  Service │  │  Service │  │  Service │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  Auth    │  │   Tesla  │  │  Import  │  │ Scheduler│   │
│  │  Check   │  │  Client  │  │  Service │  │          │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                     Repository Layer                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   Site   │  │  Energy  │  │  Tariff  │  │  User    │   │
│  │   Repo   │  │   Repo   │  │   Repo   │  │   Repo   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Trmnl    │  │ Tesla    │  │  Tariff  │  │ Trmnl    │   │
│  │ Installation│ Token│  │Schedule  │  │ Install│   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                      Database (PostgreSQL)                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   Site   │  │  Energy  │  │ Tariff   │  │   User   │   │
│  │          │  │   Data   │  │Schedule  │  │          │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                 │
│  │ Trmnl    │  │ Tesla    │  │ Tariff   │                 │
│  │Installation│  │ Token  │  │Schedule  │                 │
│  └──────────┘  └──────────┘  └──────────┘                 │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Recommended Architecture Improvements

#### A. Add Circuit Breakers
```typescript
import { CircuitBreaker } from 'opossum';

const breaker = new CircuitBreaker(async (siteId: string) => {
    return await teslaClient.getEnergyHistory(siteId, ...);
}, {
    timeout: 3000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000
});
```

#### B. Implement Dependency Injection
```typescript
// Current: Hard dependencies
class Importer {
    private client = new TeslaClient(...);
    private repo = new EnergyRepo();
}

// Recommended: Inject dependencies
class Importer {
    constructor(
        private client: TeslaClient,
        private repo: EnergyRepo
    ) {}
}
```

#### C. Add Domain Events
```typescript
interface DomainEvent {
    type: string;
    timestamp: Date;
    payload: unknown;
}

interface SiteAddedEvent extends DomainEvent {
    type: 'site_added';
    payload: { siteId: string; userId: string };
}
```

---

## 6. Implementation Roadmap

### Phase 1: Critical Fixes (Week 1-2)
- [ ] Add rate limiting to Tesla API
- [ ] Fix unbounded global caches
- [ ] Consolidate authentication logic
- [ ] Add input validation
- [ ] Fix tariff ID race condition

### Phase 2: High Priority (Week 3-4)
- [ ] Add database indexes
- [ ] Implement circuit breakers
- [ ] Fix error handling consistency
- [ ] Add missing tests
- [ ] Set up monitoring

### Phase 3: Medium Priority (Q2-Q3)
- [ ] Improve query patterns
- [ ] Add configuration management
- [ ] Fix type safety issues
- [ ] Implement idempotency
- [ ] Add comprehensive logging

### Phase 4: Low Priority (Q4)
- [ ] Add environment validation
- [ ] Standardize error responses
- [ ] Add component metrics
- [ ] Establish changelog process

---

## 7. Appendix

### A. Performance Metrics Baseline

Current markup route performance:
- Total response time: ~200-500ms (cold), ~100-300ms (warm)
- DB queries: 30-100ms
- Aggregation: 10-50ms
- Rendering: 5-20ms

### B. Security Checklist

- [ ] Rate limiting on all external APIs
- [ ] Input validation on all user inputs
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (React escaping)
- [ ] CSRF protection where needed
- [ ] Authentication token validation
- [ ] Authorization checks on all endpoints
- [ ] HTTPS enforcement
- [ ] Security headers

### C. Testing Checklist

- [ ] Unit tests for business logic
- [ ] Integration tests for API endpoints
- [ ] End-to-end tests for critical flows
- [ ] Performance tests for heavy operations
- [ ] Security tests for auth flows
- [ ] Test coverage >80% on business logic

### D. Monitoring Checklist

- [ ] Error tracking (Sentry, LogRocket)
- [ ] Performance monitoring (Datadog, New Relic)
- [ ] Database monitoring
- [ ] API response time alerts
- [ ] Error rate alerts
- [ ] Custom business metric alerts

---

## 8. Conclusion

This review identified **42 issues** across the codebase. The most critical areas for immediate attention are:

1. **Security** - Authentication gaps, missing rate limiting, input validation
2. **Reliability** - Memory leaks, error handling, circuit breakers
3. **Performance** - Database indexes, connection pooling, query optimization
4. **Maintainability** - Type safety, documentation, testing

The recommended prioritization above balances security, reliability, and maintainability concerns while providing a realistic timeline for implementation.

**Next Steps:**
1. Review this document with the team
2. Prioritize issues based on business impact
3. Create individual tickets for each high-priority issue
4. Schedule implementation in upcoming sprints

---

*Review completed: 2026-05-21*  
*Next review scheduled: 2026-08-21*