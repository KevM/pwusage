# User Account Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a self-service, GDPR-compliant account deletion feature allowing web app users to permanently purge their account, sites, and energy data, with intent telemetry and cryptographic challenge verification.

**Architecture:** Database-level `ON DELETE CASCADE` constraints guarantee atomic cleanup of user and site data. An intent API issues a signed HMAC challenge token when the confirmation modal is opened; a `DELETE /api/user` endpoint verifies the challenge token and origin/CSRF boundaries, revokes Tesla tokens (best-effort), purges database records in a transaction, and clears the session cookie.

**Tech Stack:** Next.js 15+ App Router, TypeScript, PostgreSQL (`pg`), Tailwind CSS, Vitest.

## Global Constraints

- Avoid `any` in TypeScript; explicitly type all parameters, responses, and interfaces.
- User-facing copy must adhere to `docs/voice-and-terms.md`.
- All verification steps must run from `cmd/next-app`.
- Follow repository patterns: data access in `*-repo.ts`, orchestration in `*-service.ts`.
- Before completing tasks, full build, lint, and Vitest suite must pass cleanly.

---

### Task 1: Database Migration for Account Deletion Cascades

**Files:**
- Create: `cmd/next-app/db-migrations/20261108130000_user_account_deletion_cascades.sql`
- Test: `cmd/next-app/src/lib/user-account-deletion.postgres.test.ts`

**Interfaces:**
- Consumes: PostgreSQL schema (`User`, `Site`, `Tariff`, `TrmnlInstallation`, `SystemAnnouncement`)
- Produces: Cascade constraints ensuring `DELETE FROM "User" WHERE id = $1` completely purges all owned records without orphaned foreign keys.

- [ ] **Step 1: Write the failing postgres integration test**

Create `cmd/next-app/src/lib/user-account-deletion.postgres.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { pool } from './db';

describe('User Account Deletion Cascades', () => {
    const testUserId = 'test-del-user-' + Date.now();
    const testSiteId = 'test-del-site-' + Date.now();

    beforeEach(async () => {
        // Clean up test fixtures
        await pool.query('DELETE FROM "User" WHERE id = $1', [testUserId]);
    });

    it('cascades deletion from User to Site, Tariff, and child records', async () => {
        // 1. Insert user
        await pool.query('INSERT INTO "User" (id, email) VALUES ($1, $2)', [testUserId, 'del@example.com']);

        // 2. Insert site
        await pool.query(`
            INSERT INTO "Site" (id, user_id, name, installed, timezone)
            VALUES ($1, $2, 'Test Site', NOW(), 'America/Chicago')
        `, [testSiteId, testUserId]);

        // 3. Insert tariff
        const tariffRes = await pool.query(`
            INSERT INTO "Tariff" (site_id, name) VALUES ($1, 'Default Tariff') RETURNING id
        `, [testSiteId]);
        const tariffId = tariffRes.rows[0].id;

        // 4. Insert TrmnlInstallation
        await pool.query(`
            INSERT INTO "TrmnlInstallation" (site_id, uuid) VALUES ($1, $2)
        `, [testSiteId, 'trmnl-uuid-' + Date.now()]);

        // 5. Delete user
        await pool.query('DELETE FROM "User" WHERE id = $1', [testUserId]);

        // 6. Assert all records were purged
        const siteCheck = await pool.query('SELECT * FROM "Site" WHERE id = $1', [testSiteId]);
        expect(siteCheck.rows.length).toBe(0);

        const tariffCheck = await pool.query('SELECT * FROM "Tariff" WHERE id = $1', [tariffId]);
        expect(tariffCheck.rows.length).toBe(0);

        const trmnlCheck = await pool.query('SELECT * FROM "TrmnlInstallation" WHERE site_id = $1', [testSiteId]);
        expect(trmnlCheck.rows.length).toBe(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails without cascade migration**

Run:
```bash
cd cmd/next-app && npx vitest run src/lib/user-account-deletion.postgres.test.ts
```
Expected: FAIL (violates foreign key constraint on `Site.user_id`).

- [ ] **Step 3: Create the migration file**

Create `cmd/next-app/db-migrations/20261108130000_user_account_deletion_cascades.sql`:

```sql
-- Migration: user_account_deletion_cascades
-- Ensures foreign key deletion cascades from User -> Site -> Child tables

-- 1. Site -> User CASCADE
ALTER TABLE "Site"
    DROP CONSTRAINT IF EXISTS "Site_user_id_fkey",
    ADD CONSTRAINT "Site_user_id_fkey"
        FOREIGN KEY (user_id) REFERENCES "User"(id) ON DELETE CASCADE;

-- 2. TrmnlInstallation -> Site CASCADE
ALTER TABLE "TrmnlInstallation"
    DROP CONSTRAINT IF EXISTS "TrmnlInstallation_site_id_fkey",
    ADD CONSTRAINT "TrmnlInstallation_site_id_fkey"
        FOREIGN KEY (site_id) REFERENCES "Site"(id) ON DELETE CASCADE;

-- 3. SystemAnnouncement -> User SET NULL (do not delete announcements when admin is deleted)
ALTER TABLE "SystemAnnouncement"
    DROP CONSTRAINT IF EXISTS "SystemAnnouncement_author_id_fkey",
    ADD CONSTRAINT "SystemAnnouncement_author_id_fkey"
        FOREIGN KEY (author_id) REFERENCES "User"(id) ON DELETE SET NULL;
```

Apply migration to local test database:
```bash
cd cmd/next-app && npx tsx -e "
import { pool } from './src/lib/db';
import * as fs from 'fs';
const sql = fs.readFileSync('db-migrations/20261108130000_user_account_deletion_cascades.sql', 'utf8');
await pool.query(sql);
await pool.end();
console.log('Migration applied');
"
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cmd/next-app && npx vitest run src/lib/user-account-deletion.postgres.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/db-migrations/20261108130000_user_account_deletion_cascades.sql cmd/next-app/src/lib/user-account-deletion.postgres.test.ts
git commit -m "feat(db): add account deletion cascade foreign keys"
```

---

### Task 2: Deletion Challenge Token Utility

**Files:**
- Create: `cmd/next-app/src/lib/deletion-challenge.ts`
- Test: `cmd/next-app/src/lib/deletion-challenge.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface DeletionChallengePayload {
      userId: string;
      exp: number;
      purpose: 'delete-account';
  }
  export function createDeletionChallengeToken(userId: string, ttlMs?: number): string;
  export function verifyDeletionChallengeToken(token: string, expectedUserId: string): boolean;
  ```

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/deletion-challenge.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { createDeletionChallengeToken, verifyDeletionChallengeToken } from './deletion-challenge';

describe('deletion-challenge', () => {
    it('creates a valid challenge token that verifies for the matching user', () => {
        const token = createDeletionChallengeToken('user-123');
        expect(typeof token).toBe('string');
        expect(verifyDeletionChallengeToken(token, 'user-123')).toBe(true);
    });

    it('rejects a token if the user ID does not match', () => {
        const token = createDeletionChallengeToken('user-123');
        expect(verifyDeletionChallengeToken(token, 'user-456')).toBe(false);
    });

    it('rejects a token that has expired', () => {
        const token = createDeletionChallengeToken('user-123', -1000); // expired 1s ago
        expect(verifyDeletionChallengeToken(token, 'user-123')).toBe(false);
    });

    it('rejects a malformed or tampered token', () => {
        const token = createDeletionChallengeToken('user-123');
        const tampered = token.slice(0, -4) + 'abcd';
        expect(verifyDeletionChallengeToken(tampered, 'user-123')).toBe(false);
        expect(verifyDeletionChallengeToken('not.a.token', 'user-123')).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cmd/next-app && npx vitest run src/lib/deletion-challenge.test.ts
```
Expected: FAIL (file not found).

- [ ] **Step 3: Implement minimal code**

Create `cmd/next-app/src/lib/deletion-challenge.ts`:

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface DeletionChallengePayload {
    userId: string;
    exp: number;
    purpose: 'delete-account';
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getSecret(): string {
    return process.env.JWT_SECRET || process.env.AUTH_SECRET || 'pwusage-deletion-fallback-secret';
}

export function createDeletionChallengeToken(userId: string, ttlMs: number = DEFAULT_TTL_MS): string {
    const payload: DeletionChallengePayload = {
        userId,
        exp: Date.now() + ttlMs,
        purpose: 'delete-account',
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = createHmac('sha256', getSecret()).update(encodedPayload).digest('base64url');
    return `${encodedPayload}.${signature}`;
}

export function verifyDeletionChallengeToken(token: string, expectedUserId: string): boolean {
    if (!token || typeof token !== 'string') return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;

    const [encodedPayload, signature] = parts;
    const expectedSig = createHmac('sha256', getSecret()).update(encodedPayload).digest('base64url');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
        return false;
    }

    try {
        const payloadJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
        const payload = JSON.parse(payloadJson) as DeletionChallengePayload;

        if (payload.purpose !== 'delete-account') return false;
        if (payload.userId !== expectedUserId) return false;
        if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return false;

        return true;
    } catch {
        return false;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cmd/next-app && npx vitest run src/lib/deletion-challenge.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/deletion-challenge.ts cmd/next-app/src/lib/deletion-challenge.test.ts
git commit -m "feat(auth): add deletion challenge token generator and validator"
```

---

### Task 3: Account Deletion Service

**Files:**
- Create: `cmd/next-app/src/lib/account-deletion-service.ts`
- Test: `cmd/next-app/src/lib/account-deletion-service.test.ts`

**Interfaces:**
- Consumes: `pool` from `./db`, `logEvent` from `./observability`
- Produces:
  ```typescript
  export class AccountDeletionService {
      deleteAccount(userId: string): Promise<{ success: boolean; sitesDeleted: number }>;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/lib/account-deletion-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountDeletionService } from './account-deletion-service';
import { pool } from './db';

const { logEventMock } = vi.hoisted(() => ({ logEventMock: vi.fn() }));
vi.mock('./observability', () => ({
    logEvent: logEventMock,
    flushLogEvents: vi.fn(),
}));

describe('AccountDeletionService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('deletes user and mobile handoff records in a transaction and logs telemetry', async () => {
        const querySpy = vi.spyOn(pool, 'query');
        // Mock query returns:
        // 1. BEGIN
        // 2. SELECT site IDs
        // 3. SELECT tokens
        // 4. DELETE MobileLoginHandoff
        // 5. DELETE User
        // 6. COMMIT
        querySpy.mockImplementation(async (sql: any, params?: any[]) => {
            if (typeof sql === 'string' && sql.includes('SELECT id FROM "Site"')) {
                return { rows: [{ id: 'site-1' }], rowCount: 1 } as any;
            }
            if (typeof sql === 'string' && sql.includes('SELECT refresh_token FROM "User"')) {
                return { rows: [{ refresh_token: 'fake-refresh-token' }], rowCount: 1 } as any;
            }
            return { rows: [], rowCount: 1 } as any;
        });

        // Mock fetch to simulate Tesla revoke failure (should not throw)
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network timeout'));

        const service = new AccountDeletionService();
        const result = await service.deleteAccount('user-to-delete');

        expect(result.success).toBe(true);
        expect(result.sitesDeleted).toBe(1);
        expect(logEventMock).toHaveBeenCalledWith('info', 'user.account.deleted', expect.objectContaining({
            userId: 'user-to-delete',
            siteCount: 1,
        }));

        querySpy.mockRestore();
        fetchSpy.mockRestore();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cmd/next-app && npx vitest run src/lib/account-deletion-service.test.ts
```
Expected: FAIL (file not found).

- [ ] **Step 3: Implement AccountDeletionService**

Create `cmd/next-app/src/lib/account-deletion-service.ts`:

```typescript
import { pool } from './db';
import { logEvent, flushLogEvents } from './observability';

const TESLA_REVOKE_URL = 'https://fleet-auth.prd.na.vn.cloud.tesla.com/oauth2/v3/revoke';
const EXTERNAL_TIMEOUT_MS = 3000;

export class AccountDeletionService {
    /**
     * Attempts best-effort revocation of Tesla OAuth tokens without blocking local deletion.
     */
    private async revokeTeslaTokensBestEffort(userId: string, refreshToken: string | null): Promise<void> {
        if (!refreshToken) return;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), EXTERNAL_TIMEOUT_MS);

        try {
            const body = new URLSearchParams({
                token: refreshToken,
                token_type_hint: 'refresh_token',
                client_id: process.env.TESLA_CLIENT_ID || '',
            });

            await fetch(TESLA_REVOKE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
                signal: controller.signal,
            });
        } catch (error) {
            logEvent('warn', 'tesla.account-deletion.revoke-failed', {
                userId,
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    async deleteAccount(userId: string): Promise<{ success: boolean; sitesDeleted: number }> {
        // 1. Fetch site count and refresh token prior to deletion
        const [sitesRes, tokenRes] = await Promise.all([
            pool.query('SELECT id FROM "Site" WHERE user_id = $1', [userId]),
            pool.query('SELECT refresh_token FROM "User" WHERE id = $1', [userId]),
        ]);

        const siteCount = sitesRes.rowCount ?? sitesRes.rows.length;
        const refreshToken = tokenRes.rows[0]?.refresh_token || null;

        // 2. Best-effort external revocation
        await this.revokeTeslaTokensBestEffort(userId, refreshToken);

        // 3. Atomic Database Purge
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('DELETE FROM "MobileLoginHandoff" WHERE user_id = $1', [userId]);
            await client.query('DELETE FROM "User" WHERE id = $1', [userId]);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            logEvent('error', 'user.account-deletion.db-failed', {
                userId,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        } finally {
            client.release();
        }

        // 4. Telemetry
        logEvent('info', 'user.account.deleted', {
            userId,
            siteCount,
        });
        flushLogEvents();

        return { success: true, sitesDeleted: siteCount };
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cmd/next-app && npx vitest run src/lib/account-deletion-service.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/lib/account-deletion-service.ts cmd/next-app/src/lib/account-deletion-service.test.ts
git commit -m "feat(service): add AccountDeletionService with best-effort revoke and atomic purge"
```

---

### Task 4: Delete Intent API Route (`POST /api/user/delete-intent`)

**Files:**
- Create: `cmd/next-app/src/app/api/user/delete-intent/route.ts`
- Test: `cmd/next-app/src/app/api/user/delete-intent/route.test.ts`

**Interfaces:**
- Handles `POST /api/user/delete-intent`
- Returns: `{ ok: true, challengeToken?: string }`

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/app/api/user/delete-intent/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from './route';
import { NextRequest } from 'next/server';

const { getCurrentUserMock, logEventMock } = vi.hoisted(() => ({
    getCurrentUserMock: vi.fn(),
    logEventMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock('@/lib/observability', () => ({ logEvent: logEventMock, observeRoute: vi.fn() }));

function makeRequest(body: unknown, origin = 'http://localhost:3000'): NextRequest {
    return new NextRequest(`${origin}/api/user/delete-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', origin },
        body: JSON.stringify(body),
    });
}

describe('POST /api/user/delete-intent', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects unauthenticated requests with 401', async () => {
        getCurrentUserMock.mockResolvedValue(null);
        const res = await POST(makeRequest({ action: 'dialog-opened' }));
        expect(res.status).toBe(401);
    });

    it('emits telemetry and returns challengeToken on dialog-opened', async () => {
        getCurrentUserMock.mockResolvedValue({ id: 'user-abc', email: 'test@example.com' });
        const res = await POST(makeRequest({ action: 'dialog-opened' }));
        expect(res.status).toBe(200);

        const json = await res.json();
        expect(json.ok).toBe(true);
        expect(typeof json.challengeToken).toBe('string');
        expect(logEventMock).toHaveBeenCalledWith('info', 'user.account-deletion.dialog-opened', { userId: 'user-abc' });
    });

    it('emits telemetry on dialog-cancelled without challengeToken', async () => {
        getCurrentUserMock.mockResolvedValue({ id: 'user-abc', email: 'test@example.com' });
        const res = await POST(makeRequest({ action: 'dialog-cancelled' }));
        expect(res.status).toBe(200);

        const json = await res.json();
        expect(json.ok).toBe(true);
        expect(json.challengeToken).toBeUndefined();
        expect(logEventMock).toHaveBeenCalledWith('info', 'user.account-deletion.dialog-cancelled', { userId: 'user-abc' });
    });

    it('rejects invalid actions with 400', async () => {
        getCurrentUserMock.mockResolvedValue({ id: 'user-abc' });
        const res = await POST(makeRequest({ action: 'invalid-action' }));
        expect(res.status).toBe(400);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cmd/next-app && npx vitest run src/app/api/user/delete-intent/route.test.ts
```
Expected: FAIL (route not found).

- [ ] **Step 3: Implement route handler**

Create `cmd/next-app/src/app/api/user/delete-intent/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-checks';
import { logEvent } from '@/lib/observability';
import { createDeletionChallengeToken } from '@/lib/deletion-challenge';

export const dynamic = 'force-dynamic';

function jsonError(error: string, status: number): NextResponse {
    return NextResponse.json({ error }, {
        status,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
    const user = await getCurrentUser();
    if (!user) return jsonError('Unauthorized', 401);

    let body: { action?: string };
    try {
        body = await request.json();
    } catch {
        return jsonError('Invalid request body', 400);
    }

    if (body.action === 'dialog-opened') {
        logEvent('info', 'user.account-deletion.dialog-opened', { userId: user.id });
        const challengeToken = createDeletionChallengeToken(user.id);
        return NextResponse.json({ ok: true, challengeToken }, {
            headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
        });
    }

    if (body.action === 'dialog-cancelled') {
        logEvent('info', 'user.account-deletion.dialog-cancelled', { userId: user.id });
        return NextResponse.json({ ok: true }, {
            headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
        });
    }

    return jsonError('Invalid action', 400);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cmd/next-app && npx vitest run src/app/api/user/delete-intent/route.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/app/api/user/delete-intent/route.ts cmd/next-app/src/app/api/user/delete-intent/route.test.ts
git commit -m "feat(api): add delete-intent route with intent logging and challenge token emission"
```

---

### Task 5: User Deletion API Route (`DELETE /api/user`)

**Files:**
- Create: `cmd/next-app/src/app/api/user/route.ts`
- Test: `cmd/next-app/src/app/api/user/route.test.ts`

**Interfaces:**
- Handles `DELETE /api/user`
- Validates origin & `sec-fetch-site`, verifies session, checks `challengeToken`, checks `confirm === 'DELETE'`, calls `accountDeletionService.deleteAccount()`, clears `site_auth` cookie.

- [ ] **Step 1: Write the failing test**

Create `cmd/next-app/src/app/api/user/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DELETE } from './route';
import { NextRequest } from 'next/server';

const { getCurrentUserMock, verifyChallengeMock, deleteAccountMock } = vi.hoisted(() => ({
    getCurrentUserMock: vi.fn(),
    verifyChallengeMock: vi.fn(),
    deleteAccountMock: vi.fn(),
}));

vi.mock('@/lib/auth-checks', () => ({ getCurrentUser: getCurrentUserMock }));
vi.mock('@/lib/deletion-challenge', () => ({ verifyDeletionChallengeToken: verifyChallengeMock }));
vi.mock('@/lib/account-deletion-service', () => ({
    AccountDeletionService: vi.fn().mockImplementation(() => ({
        deleteAccount: deleteAccountMock,
    })),
}));

function makeDeleteRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
    const defaultHeaders = {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
        ...headers,
    };
    return new NextRequest('http://localhost:3000/api/user', {
        method: 'DELETE',
        headers: defaultHeaders,
        body: JSON.stringify(body),
    });
}

describe('DELETE /api/user', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects cross-origin requests with 403', async () => {
        const req = makeDeleteRequest({}, { origin: 'http://malicious.test' });
        const res = await DELETE(req);
        expect(res.status).toBe(403);
    });

    it('rejects cross-site fetch requests with 403', async () => {
        const req = makeDeleteRequest({}, { 'sec-fetch-site': 'cross-site' });
        const res = await DELETE(req);
        expect(res.status).toBe(403);
    });

    it('rejects unauthenticated requests with 401', async () => {
        getCurrentUserMock.mockResolvedValue(null);
        const req = makeDeleteRequest({ confirm: 'DELETE', challengeToken: 'valid-token' });
        const res = await DELETE(req);
        expect(res.status).toBe(401);
    });

    it('rejects invalid confirmation text with 400', async () => {
        getCurrentUserMock.mockResolvedValue({ id: 'user-1' });
        const req = makeDeleteRequest({ confirm: 'NOT_DELETE', challengeToken: 'token' });
        const res = await DELETE(req);
        expect(res.status).toBe(400);
    });

    it('rejects invalid or expired challenge token with 403', async () => {
        getCurrentUserMock.mockResolvedValue({ id: 'user-1' });
        verifyChallengeMock.mockReturnValue(false);
        const req = makeDeleteRequest({ confirm: 'DELETE', challengeToken: 'bad-token' });
        const res = await DELETE(req);
        expect(res.status).toBe(403);
    });

    it('deletes account and clears site_auth cookie on valid request', async () => {
        getCurrentUserMock.mockResolvedValue({ id: 'user-1' });
        verifyChallengeMock.mockReturnValue(true);
        deleteAccountMock.mockResolvedValue({ success: true, sitesDeleted: 1 });

        const req = makeDeleteRequest({ confirm: 'DELETE', challengeToken: 'good-token' });
        const res = await DELETE(req);
        expect(res.status).toBe(200);

        const cookie = res.cookies.get('site_auth');
        expect(cookie?.maxAge).toBe(0);
        expect(deleteAccountMock).toHaveBeenCalledWith('user-1');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cmd/next-app && npx vitest run src/app/api/user/route.test.ts
```
Expected: FAIL (route not found).

- [ ] **Step 3: Implement DELETE /api/user route handler**

Create `cmd/next-app/src/app/api/user/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth-checks';
import { isSecureRequest } from '@/lib/request-security';
import { verifyDeletionChallengeToken } from '@/lib/deletion-challenge';
import { AccountDeletionService } from '@/lib/account-deletion-service';

export const dynamic = 'force-dynamic';

function jsonError(error: string, status: number): NextResponse {
    return NextResponse.json({ error }, {
        status,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
    // 1. Origin and CSRF defense-in-depth
    const origin = request.headers.get('origin');
    if (origin) {
        let originUrl: URL;
        try {
            originUrl = new URL(origin);
        } catch {
            return jsonError('Cross-origin requests are not allowed', 403);
        }
        if (originUrl.origin !== request.nextUrl.origin) {
            return jsonError('Cross-origin requests are not allowed', 403);
        }
    }

    if (request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
        return jsonError('Cross-origin requests are not allowed', 403);
    }

    // 2. Authentication check
    const user = await getCurrentUser();
    if (!user) return jsonError('Unauthorized', 401);

    // 3. Body parse and confirmation check
    let body: { confirm?: string; challengeToken?: string };
    try {
        body = await request.json();
    } catch {
        return jsonError('Invalid request body', 400);
    }

    if (body.confirm !== 'DELETE') {
        return jsonError('Confirmation text must match DELETE', 400);
    }

    if (!body.challengeToken || !verifyDeletionChallengeToken(body.challengeToken, user.id)) {
        return jsonError('Invalid, expired, or missing deletion challenge token', 403);
    }

    // 4. Perform atomic account deletion
    const deletionService = new AccountDeletionService();
    try {
        await deletionService.deleteAccount(user.id);
    } catch (e) {
        return jsonError('Failed to delete account', 500);
    }

    // 5. Invalidate session cookie and respond
    const response = NextResponse.json({ ok: true }, {
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    });
    response.cookies.set('site_auth', '', {
        httpOnly: true,
        secure: isSecureRequest(request),
        maxAge: 0,
        path: '/',
        sameSite: 'lax',
    });

    return response;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
cd cmd/next-app && npx vitest run src/app/api/user/route.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/app/api/user/route.ts cmd/next-app/src/app/api/user/route.test.ts
git commit -m "feat(api): add DELETE /api/user with CSRF defense, challenge verification, and cookie invalidation"
```

---

### Task 6: Delete Account UI on Profile Page

**Files:**
- Create: `cmd/next-app/src/app/profile/DeleteAccountModal.tsx`
- Create: `cmd/next-app/src/app/profile/DeleteAccountSection.tsx`
- Modify: `cmd/next-app/src/app/profile/page.tsx`
- Test: `cmd/next-app/src/app/profile/DeleteAccountModal.test.tsx`

**Interfaces:**
- Produces:
  `DeleteAccountSection`: Danger Zone section card rendered in `/profile`.
  `DeleteAccountModal`: Interactive dialog handling intent telemetry, typed confirmation, and API execution.

- [ ] **Step 1: Write the failing component test**

Create `cmd/next-app/src/app/profile/DeleteAccountModal.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { DeleteAccountModal } from './DeleteAccountModal';

describe('DeleteAccountModal', () => {
    const onClose = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        globalThis.fetch = vi.fn();
    });

    it('fetches challengeToken on mount when opened', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ ok: true, challengeToken: 'test-challenge-123' }),
        });

        render(<DeleteAccountModal isOpen={true} onClose={onClose} />);

        await waitFor(() => {
            expect(globalThis.fetch).toHaveBeenCalledWith('/api/user/delete-intent', expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ action: 'dialog-opened' }),
            }));
        });
    });

    it('keeps Delete button disabled until user types DELETE', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ ok: true, challengeToken: 'test-challenge-123' }),
        });

        render(<DeleteAccountModal isOpen={true} onClose={onClose} />);

        const deleteButton = screen.getByRole('button', { name: /permanently delete account/i });
        expect(deleteButton).toBeDisabled();

        const input = screen.getByPlaceholderText('DELETE');
        fireEvent.change(input, { target: { value: 'delete' } });
        expect(deleteButton).toBeDisabled();

        fireEvent.change(input, { target: { value: 'DELETE' } });
        expect(deleteButton).not.toBeDisabled();
    });

    it('fires dialog-cancelled intent when Cancel is clicked', async () => {
        (globalThis.fetch as any).mockResolvedValueOnce({
            ok: true,
            json: async () => ({ ok: true, challengeToken: 'test-challenge-123' }),
        });

        render(<DeleteAccountModal isOpen={true} onClose={onClose} />);

        const cancelButton = screen.getByRole('button', { name: /cancel/i });
        fireEvent.click(cancelButton);

        expect(globalThis.fetch).toHaveBeenCalledWith('/api/user/delete-intent', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ action: 'dialog-cancelled' }),
        }));
        expect(onClose).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd cmd/next-app && npx vitest run src/app/profile/DeleteAccountModal.test.tsx
```
Expected: FAIL (component not found).

- [ ] **Step 3: Implement DeleteAccountModal and DeleteAccountSection**

Create `cmd/next-app/src/app/profile/DeleteAccountModal.tsx`:

```tsx
'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/Alert';

interface DeleteAccountModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function DeleteAccountModal({ isOpen, onClose }: DeleteAccountModalProps) {
    const [confirmText, setConfirmText] = useState('');
    const [challengeToken, setChallengeToken] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!isOpen) {
            setConfirmText('');
            setChallengeToken(null);
            setError(null);
            return;
        }

        let isMounted = true;
        fetch('/api/user/delete-intent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'dialog-opened' }),
        })
            .then(res => res.json())
            .then(data => {
                if (isMounted && data.challengeToken) {
                    setChallengeToken(data.challengeToken);
                }
            })
            .catch(() => {
                if (isMounted) setError('Could not initialize deletion verification. Please try again.');
            });

        return () => {
            isMounted = false;
        };
    }, [isOpen]);

    if (!isOpen) return null;

    const handleCancel = () => {
        fetch('/api/user/delete-intent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'dialog-cancelled' }),
        }).catch(() => {});
        onClose();
    };

    const handleDelete = async () => {
        if (confirmText !== 'DELETE' || !challengeToken) return;

        setIsLoading(true);
        setError(null);

        try {
            const res = await fetch('/api/user', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    confirm: 'DELETE',
                    challengeToken,
                }),
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Failed to delete account');
            }

            window.location.href = '/?deleted=true';
        } catch (e) {
            setError(e instanceof Error ? e.message : 'An error occurred during account deletion.');
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 border border-red-200 dark:border-red-900 p-6 shadow-2xl space-y-4">
                <h3 className="text-xl font-bold text-red-600 dark:text-red-400">Permanently Delete Account</h3>

                <p className="text-sm text-gray-600 dark:text-gray-300">
                    This action is <strong className="text-red-600 dark:text-red-400">irreversible</strong>.
                    All your connected sites, energy history archives, rate plans, and settings will be permanently erased immediately.
                </p>

                <p className="text-xs text-muted-foreground bg-slate-100 dark:bg-slate-800 p-3 rounded-md">
                    <strong>Note regarding the iOS app:</strong> Your local device cache will clear automatically when the app next launches. Any solar layout data stored in your private iCloud can be removed under your iOS device&apos;s <em>Settings &gt; Apple Account &gt; iCloud &gt; PWUsage</em>.
                </p>

                {error && (
                    <Alert variant="danger">
                        <AlertTitle>Error</AlertTitle>
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}

                <div className="space-y-2 pt-2">
                    <label htmlFor="confirm-input" className="block text-sm font-medium">
                        To confirm, type <span className="font-mono font-bold select-all">DELETE</span> below:
                    </label>
                    <input
                        id="confirm-input"
                        type="text"
                        value={confirmText}
                        onChange={e => setConfirmText(e.target.value)}
                        placeholder="DELETE"
                        disabled={isLoading}
                        className="w-full rounded-md border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-500"
                    />
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-800">
                    <Button variant="secondary" onClick={handleCancel} disabled={isLoading}>
                        Cancel
                    </Button>
                    <Button
                        variant="danger"
                        onClick={handleDelete}
                        disabled={confirmText !== 'DELETE' || !challengeToken || isLoading}
                    >
                        {isLoading ? 'Deleting Account...' : 'Permanently Delete Account'}
                    </Button>
                </div>
            </div>
        </div>
    );
}
```

Create `cmd/next-app/src/app/profile/DeleteAccountSection.tsx`:

```tsx
'use client';

import React, { useState } from 'react';
import { SectionCard } from '@/components/ui/SectionCard';
import { Button } from '@/components/ui/Button';
import { DeleteAccountModal } from './DeleteAccountModal';

export function DeleteAccountSection() {
    const [isModalOpen, setIsModalOpen] = useState(false);

    return (
        <>
            <SectionCard
                title="Danger Zone"
                titleClassName="text-red-600 dark:text-red-400"
                className="border-red-200 dark:border-red-950 mt-8"
                description="Permanently delete your user account, linked energy sites, tariffs, and stored history."
            >
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <p className="text-sm text-muted-foreground">
                        Once deleted, your account and historical energy data cannot be recovered.
                    </p>
                    <Button
                        variant="danger"
                        onClick={() => setIsModalOpen(true)}
                    >
                        Delete Account...
                    </Button>
                </div>
            </SectionCard>
            <DeleteAccountModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
        </>
    );
}
```

Modify `cmd/next-app/src/app/profile/page.tsx`:
Add `import { DeleteAccountSection } from './DeleteAccountSection';` and render `<DeleteAccountSection />` right below the existing `SectionCard` near line 160.

- [ ] **Step 4: Run component test to verify it passes**

Run:
```bash
cd cmd/next-app && npx vitest run src/app/profile/DeleteAccountModal.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/app/profile/DeleteAccountModal.tsx cmd/next-app/src/app/profile/DeleteAccountSection.tsx cmd/next-app/src/app/profile/page.tsx cmd/next-app/src/app/profile/DeleteAccountModal.test.tsx
git commit -m "feat(ui): add Danger Zone account deletion section and confirmation modal to Profile page"
```

---

### Task 7: Homepage Toast Banner & Privacy Policy Documentation

**Files:**
- Modify: `cmd/next-app/src/app/page.tsx`
- Modify: `cmd/next-app/src/app/privacy/page.tsx`
- Modify: `Authentication.md`
- Test: `cmd/next-app/src/app/page.test.tsx` (or vitest test checking deleted banner render)

**Interfaces:**
- Produces:
  Homepage notification banner when `?deleted=true` is present.
  Updated Privacy Policy clarifying self-service deletion on `/profile`.
  Updated `Authentication.md` documenting the deletion flow.

- [ ] **Step 1: Update Homepage to check searchParams for `deleted`**

Modify `cmd/next-app/src/app/page.tsx` to inspect `searchParams` and render an `<Alert variant="info">` or confirmation banner:
```tsx
// Inside Home page component:
{searchParams?.deleted === 'true' && (
    <div className="max-w-xl mx-auto mb-6">
        <Alert variant="info">
            <AlertTitle>Account Deleted</AlertTitle>
            <AlertDescription>
                Your account and all associated data have been permanently deleted.
            </AlertDescription>
        </Alert>
    </div>
)}
```

- [ ] **Step 2: Update Privacy Policy (`cmd/next-app/src/app/privacy/page.tsx`)**

Update line 42 in `cmd/next-app/src/app/privacy/page.tsx`:
```tsx
<p>You can permanently delete your pwusage account and all associated energy history at any time from your Profile page. If you use the iOS app, cached readings clear upon sign-out or session expiration, and any solar layout beta records stored in your private iCloud can be deleted in your iOS device settings. For additional privacy inquiries, email <a href="mailto:support@fm.rodeo" className="text-primary underline">support@fm.rodeo</a>. Backups may retain removed data until their normal expiration.</p>
```

- [ ] **Step 3: Update `Authentication.md`**

Append section under Identity and Secrets Model documenting `DELETE /api/user`:
```markdown
### Account Deletion (`DELETE /api/user`)
- Requires valid `site_auth` session.
- Requires confirmation challenge token issued via `POST /api/user/delete-intent`.
- Performs best-effort token revocation with Tesla OAuth (`/oauth2/v3/revoke`).
- Executes atomic transaction: deletes `MobileLoginHandoff` and cascades `User` -> `Site` -> child tables.
- Clears `site_auth` cookie and logs operational audit event.
```

- [ ] **Step 4: Run tests**

Run:
```bash
cd cmd/next-app && npm test -- --run
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/next-app/src/app/page.tsx cmd/next-app/src/app/privacy/page.tsx Authentication.md
git commit -m "docs: update privacy policy and authentication docs for self-service account deletion"
```

---

### Task 8: Full Verification and Build Check

**Files:**
- Entire repository

- [ ] **Step 1: Run linter**
Run:
```bash
cd cmd/next-app && npm run lint
```
Expected: 0 errors.

- [ ] **Step 2: Run typecheck**
Run:
```bash
cd cmd/next-app && npm run typecheck
```
Expected: 0 type errors.

- [ ] **Step 3: Run Vitest test suite**
Run:
```bash
cd cmd/next-app && npm test -- --run
```
Expected: All tests pass.

- [ ] **Step 4: Run Next.js production build**
Run:
```bash
cd cmd/next-app && npm run build
```
Expected: Build succeeds without errors.
