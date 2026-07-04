# User Email Dedupe + Case-Insensitive Unique Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent duplicate `User` rows for the same email address by deduplicating existing rows and adding a partial unique index on `LOWER(email)`, then hardening the two auth-flow code paths that could still trip it.

**Architecture:** A single idempotent SQL migration merges duplicate-email `User` rows (repointing `Site.user_id` and `SystemAnnouncement.author_id`, unioning `roles`, keeping the row with the freshest credentials) and creates `CREATE UNIQUE INDEX ... ON "User" (LOWER(email)) WHERE email IS NOT NULL`. App-side, the verified OAuth path in `tesla-auth-service.ts` gains the same by-email reconciliation the degraded path already has (PR #92), and the user upsert gets a one-shot retry on Postgres unique-violation (`23505`) for the concurrent-first-login race. This demotes the existing `getByEmail ... ORDER BY id LIMIT 1` band-aid from load-bearing to defense-in-depth.

**Tech Stack:** PostgreSQL (Supabase prod / plain Postgres 16 for local verification via Docker), Next.js app in `cmd/next-app`, Vitest with mocked `pg` pool.

---

## Context for a zero-context engineer

- All app code lives under `cmd/next-app`. Run all npm commands from that directory.
- **Why duplicates exist:** `User.id` is TEXT and is set from whatever identity the OAuth flow could establish at the time — sometimes the Tesla JWT `sub`, sometimes the raw email address (degraded path when Tesla's JWKS key is unpublished). The same human can therefore have one row with `id = <sub>` and another with `id = <their email>`, both carrying the same `email` value. `upsertOnTeslaAuth` only conflicts on `id`, so nothing stops the second row.
- **Schema facts** (from `cmd/next-app/db-migrations/20260123000001_init_schema.sql` and later migrations):
  - `"User"`: `id TEXT PRIMARY KEY`, `email TEXT` (nullable, no uniqueness), `access_token`, `refresh_token`, `token_expires_at BIGINT`, `roles TEXT[]`, `is_active`, `auth_status`, `last_checked_at`, `created_at`, `is_refreshing`, `refresh_lock_expires`.
  - Only two FK references to `"User"(id)` exist in the whole schema: `"Site".user_id` and `"SystemAnnouncement".author_id`. Nothing else stores user ids in the DB. (Session JWTs store user ids too; users whose duplicate row is deleted just get logged out and re-login — acceptable.)
- **Migration conventions** (`CLAUDE.md`, and see `db-migrations/20260522_192520_add_fk_indexes.sql` for the house style): timestamp-prefixed file in `cmd/next-app/db-migrations/`, must be idempotent (safe to run twice), applied by `supabase migration up` which wraps the file in a transaction (so no `CONCURRENTLY`). CI tests migrations against a prod backup on PR; merge to main backs up prod then applies.
- **Test conventions:** Vitest, co-located `*.test.ts`. Repos are tested by mocking the pg pool via `vi.hoisted` + `vi.mock('./db', ...)` (see `src/lib/user-repo.test.ts`). Services are tested via constructor-injected mock deps (see `src/lib/tesla-auth-service.test.ts` — reuse its existing `mockUserRepo`, `mockSiteRepo`, `mockTeslaTokenRepo`, `mockTeslaClient`, `mockImporter` objects).
- **Ground rules:** never run DML against the `.env` `DATABASE_URL` (it's a live-ish dev copy of prod). Do not `git push` — the user pushes. Run git commands without a leading `cd`.

## File Structure

- Create: `cmd/next-app/db-migrations/<timestamp>_dedupe_user_email_add_unique_index.sql` — dedupe + unique index (all DB work in one file)
- Modify: `cmd/next-app/src/lib/db.ts` — add `isUniqueViolation` helper
- Modify: `cmd/next-app/src/lib/db.test.ts` — tests for the helper
- Modify: `cmd/next-app/src/lib/tesla-auth-service.ts` — verified-path email reconciliation (~line 407) and 23505 retry around the upsert (~line 486)
- Modify: `cmd/next-app/src/lib/tesla-auth-service.test.ts` — two new tests
- Modify: `cmd/next-app/src/lib/user-repo.ts` — comment update on `getByEmail` (no behavior change)
- Modify: `Authentication.md` — one short paragraph documenting email uniqueness

---

### Task 1: Setup + duplicate audit (read-only)

**Files:** none created; informational only.

- [ ] **Step 1: Branch off up-to-date main**

```bash
git -C /Users/kevm/github/pwusage checkout main
git -C /Users/kevm/github/pwusage pull
git -C /Users/kevm/github/pwusage checkout -b fix/user-email-unique
cd /Users/kevm/github/pwusage/cmd/next-app && npm install
```

- [ ] **Step 2: Audit real duplicate scale (READ-ONLY — no DML against this database)**

`cmd/next-app/.env` contains `DATABASE_URL` for the dev database (a copy of prod). Run only this SELECT:

```bash
cd /Users/kevm/github/pwusage/cmd/next-app && set -a && source .env && set +a && psql "$DATABASE_URL" -c '
SELECT LOWER(email) AS email_key, COUNT(*) AS n, array_agg(id ORDER BY id) AS ids,
       array_agg(token_expires_at ORDER BY id) AS token_expiries
FROM "User"
WHERE email IS NOT NULL
GROUP BY LOWER(email)
HAVING COUNT(*) > 1;'
```

Expected: zero to a handful of rows. Record the output in your final report — it tells the user exactly which accounts will be merged in prod. If the query errors (no network/credentials), note that and continue; CI validates the migration against a prod backup anyway.

---

### Task 2: The migration — dedupe + unique index

**Files:**
- Create: `cmd/next-app/db-migrations/<timestamp>_dedupe_user_email_add_unique_index.sql` (generate the timestamp with `date +%Y%m%d_%H%M%S`)

- [ ] **Step 1: Create the migration file**

```bash
cd /Users/kevm/github/pwusage/cmd/next-app && touch "db-migrations/$(date +%Y%m%d_%H%M%S)_dedupe_user_email_add_unique_index.sql"
```

- [ ] **Step 2: Write the migration**

Put exactly this content in the new file:

```sql
-- Deduplicate "User" rows sharing an email (case-insensitive), then enforce
-- uniqueness going forward.
--
-- Why duplicates exist: User.id is TEXT set from whatever identity the OAuth
-- flow could establish — the Tesla JWT `sub` on the verified path, or the raw
-- email on the degraded path (unpublished JWKS kid, see tesla-auth-service.ts).
-- The same person can therefore own two rows with the same email, and
-- upsertOnTeslaAuth (conflict target: id) happily creates the second one.
-- getByEmail's `ORDER BY id LIMIT 1` and the degraded-path reconciliation
-- added around PR #92 only paper over this; the durable fix is uniqueness.
--
-- Canonical-row choice per email: the row with the freshest credentials
-- (token_expires_at, then last_checked_at, then lowest id for determinism).
-- Sites and announcements are repointed to it and roles are unioned into it,
-- so nothing is lost from the deleted rows except stale tokens. Users whose
-- duplicate row backed an active session JWT are logged out and re-login.
--
-- Idempotent: a second run finds no duplicate pairs, every DML is a no-op,
-- and the index create is IF NOT EXISTS. `supabase migration up` wraps this
-- file in a transaction; the temp table lives only for that session.

DROP TABLE IF EXISTS user_email_dupes;
CREATE TEMP TABLE user_email_dupes AS
WITH canonical AS (
    SELECT DISTINCT ON (LOWER(email)) id, LOWER(email) AS email_key
    FROM "User"
    WHERE email IS NOT NULL
    ORDER BY LOWER(email),
             token_expires_at DESC NULLS LAST,
             last_checked_at DESC NULLS LAST,
             id ASC
)
SELECT u.id AS dupe_id, c.id AS canonical_id
FROM "User" u
JOIN canonical c ON LOWER(u.email) = c.email_key
WHERE u.id <> c.id;

-- Union roles from all rows in each duplicate group into the canonical row,
-- so e.g. an 'admin' role on the older row survives the merge.
WITH merged AS (
    SELECT d.canonical_id, array_agg(DISTINCT r) AS merged_roles
    FROM user_email_dupes d
    JOIN "User" u ON u.id IN (d.dupe_id, d.canonical_id)
    CROSS JOIN LATERAL unnest(COALESCE(u.roles, ARRAY[]::text[])) AS r
    GROUP BY d.canonical_id
)
UPDATE "User" c
SET roles = merged.merged_roles
FROM merged
WHERE c.id = merged.canonical_id;

UPDATE "Site" s
SET user_id = d.canonical_id
FROM user_email_dupes d
WHERE s.user_id = d.dupe_id;

UPDATE "SystemAnnouncement" a
SET author_id = d.canonical_id
FROM user_email_dupes d
WHERE a.author_id = d.dupe_id;

DELETE FROM "User" u
USING user_email_dupes d
WHERE u.id = d.dupe_id;

-- Partial: multiple rows with NULL email (degraded signups) remain legal.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_email_lower
    ON "User" (LOWER(email))
    WHERE email IS NOT NULL;
```

- [ ] **Step 3: Build a local verification harness (scratchpad, not the repo)**

Create `/private/tmp/claude-501/-Users-kevm-github-pwusage/*/scratchpad/seed.sql` (use your session's scratchpad dir) with a minimal schema plus fixtures that cover every merge behavior:

```sql
CREATE TABLE "User" (
    id TEXT PRIMARY KEY,
    email TEXT,
    access_token TEXT,
    refresh_token TEXT,
    token_expires_at BIGINT,
    roles TEXT[],
    is_active BOOLEAN,
    auth_status TEXT,
    last_checked_at TIMESTAMP
);
CREATE TABLE "Site" (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES "User"(id)
);
CREATE TABLE "SystemAnnouncement" (
    id SERIAL PRIMARY KEY,
    author_id TEXT REFERENCES "User"(id)
);

-- Group 1: case-differing dupes. 'sub-abc' has fresher token -> canonical.
-- Old email-keyed row owns the site, the admin role, and an announcement.
INSERT INTO "User" (id, email, token_expires_at, roles) VALUES
    ('kevin@example.com', 'Kevin@Example.com', 1000, ARRAY['admin']),
    ('sub-abc',           'kevin@example.com', 2000, NULL);
INSERT INTO "Site" (id, user_id) VALUES ('site-1', 'kevin@example.com');
INSERT INTO "SystemAnnouncement" (author_id) VALUES ('kevin@example.com');

-- Group 2: three-way dupe, canonical decided by last_checked_at tie-break.
INSERT INTO "User" (id, email, token_expires_at, last_checked_at) VALUES
    ('a-old',  'multi@example.com', NULL, NULL),
    ('b-mid',  'multi@example.com', 3000, '2026-01-01'),
    ('c-new',  'multi@example.com', 3000, '2026-06-01');
INSERT INTO "Site" (id, user_id) VALUES ('site-2', 'a-old'), ('site-3', 'b-mid');

-- NULL emails: both must survive (partial index must not apply to them).
INSERT INTO "User" (id, email) VALUES ('null-1', NULL), ('null-2', NULL);

-- Non-duplicate user: must be untouched.
INSERT INTO "User" (id, email, roles) VALUES ('solo', 'solo@example.com', ARRAY['user']);
```

- [ ] **Step 4: Run the migration twice against ephemeral Postgres 16 and assert**

```bash
docker run --rm -d --name pg-email-mig -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16
sleep 5
export PGURL=postgresql://postgres:test@localhost:55432/postgres
psql "$PGURL" -v ON_ERROR_STOP=1 -f <scratchpad>/seed.sql
psql "$PGURL" -v ON_ERROR_STOP=1 -f /Users/kevm/github/pwusage/cmd/next-app/db-migrations/<timestamp>_dedupe_user_email_add_unique_index.sql
# Idempotency: second run must succeed with zero effect
psql "$PGURL" -v ON_ERROR_STOP=1 -f /Users/kevm/github/pwusage/cmd/next-app/db-migrations/<timestamp>_dedupe_user_email_add_unique_index.sql
psql "$PGURL" -v ON_ERROR_STOP=1 <<'EOF'
-- Exactly one row per non-null email; both NULL rows survive; solo untouched
SELECT CASE WHEN COUNT(*) = 5 THEN 'PASS' ELSE 'FAIL rowcount' END FROM "User";
SELECT CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL dupes-remain' END
  FROM (SELECT 1 FROM "User" WHERE email IS NOT NULL GROUP BY LOWER(email) HAVING COUNT(*) > 1) x;
-- Canonicals: sub-abc (group 1), c-new (group 2)
SELECT CASE WHEN EXISTS (SELECT 1 FROM "User" WHERE id = 'sub-abc') AND EXISTS (SELECT 1 FROM "User" WHERE id = 'c-new') THEN 'PASS' ELSE 'FAIL canonical' END;
-- Sites repointed
SELECT CASE WHEN (SELECT user_id FROM "Site" WHERE id = 'site-1') = 'sub-abc'
             AND (SELECT user_id FROM "Site" WHERE id = 'site-2') = 'c-new'
             AND (SELECT user_id FROM "Site" WHERE id = 'site-3') = 'c-new'
        THEN 'PASS' ELSE 'FAIL site-repoint' END;
-- Announcement repointed
SELECT CASE WHEN (SELECT author_id FROM "SystemAnnouncement" LIMIT 1) = 'sub-abc' THEN 'PASS' ELSE 'FAIL announcement' END;
-- Roles merged: admin survived onto sub-abc
SELECT CASE WHEN (SELECT roles FROM "User" WHERE id = 'sub-abc') @> ARRAY['admin'] THEN 'PASS' ELSE 'FAIL roles' END;
-- Index enforces uniqueness case-insensitively
DO $$
BEGIN
    INSERT INTO "User" (id, email) VALUES ('intruder', 'KEVIN@example.com');
    RAISE EXCEPTION 'FAIL index-not-enforcing';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS unique enforced';
END $$;
-- NULL emails unaffected by the partial index
INSERT INTO "User" (id, email) VALUES ('null-3', NULL);
SELECT 'PASS null-insert';
EOF
docker rm -f pg-email-mig
```

Expected: every check prints `PASS`; the second migration run exits 0.

If any check fails, fix the migration SQL and rerun from the seed (recreate the container).

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/db-migrations/
git -C /Users/kevm/github/pwusage commit -m "fix(db): dedupe User.email rows and add case-insensitive unique index"
```

---

### Task 3: `isUniqueViolation` helper in db.ts

**Files:**
- Modify: `cmd/next-app/src/lib/db.ts` (append near the bottom, before the re-export line)
- Test: `cmd/next-app/src/lib/db.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing tests** — append to `cmd/next-app/src/lib/db.test.ts`:

```ts
describe('isUniqueViolation', () => {
    it('returns true for a pg unique-violation error (code 23505)', () => {
        const err = Object.assign(new Error('duplicate key value violates unique constraint "idx_user_email_lower"'), { code: '23505' });
        expect(isUniqueViolation(err)).toBe(true);
    });

    it('returns false for other pg errors, plain errors, and non-errors', () => {
        expect(isUniqueViolation(Object.assign(new Error('fk violation'), { code: '23503' }))).toBe(false);
        expect(isUniqueViolation(new Error('boom'))).toBe(false);
        expect(isUniqueViolation(null)).toBe(false);
        expect(isUniqueViolation('23505')).toBe(false);
    });
});
```

Add `isUniqueViolation` to the existing import from `./db` at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/kevm/github/pwusage/cmd/next-app && npx vitest run src/lib/db.test.ts`
Expected: FAIL — `isUniqueViolation` is not exported.

- [ ] **Step 3: Implement** — add to `cmd/next-app/src/lib/db.ts` just above the `export * from './db-types';` line:

```ts
/**
 * True when `error` is a Postgres unique-constraint violation (SQLSTATE 23505),
 * e.g. from idx_user_email_lower on "User"(LOWER(email)).
 */
export function isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null
        && (error as { code?: unknown }).code === '23505';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/db.test.ts`
Expected: PASS (all tests in the file, new and pre-existing).

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/db.ts cmd/next-app/src/lib/db.test.ts
git -C /Users/kevm/github/pwusage commit -m "feat(db): add isUniqueViolation helper for pg 23505 errors"
```

---

### Task 4: Verified-path email reconciliation in tesla-auth-service

The degraded path already reconciles by email (added in PR #92). The verified path (`signatureVerified === true`) does not: if a legacy row keyed by email exists, a verified login with `sub` would insert a second row — which the new index now rejects. Adopt the existing account's id, mirroring the degraded path.

**Files:**
- Modify: `cmd/next-app/src/lib/tesla-auth-service.ts:407-415` (the `if (signatureVerified)` block that assigns `userId`)
- Test: `cmd/next-app/src/lib/tesla-auth-service.test.ts`

- [ ] **Step 1: Write the failing test** — append inside the top-level `describe('TeslaAuthService', ...)` block, reusing its existing mock objects:

```ts
    it('reconciles a verified sub to the existing account that owns the same email', async () => {
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'valid_id_token',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });
        const verifyIdToken = vi.fn().mockResolvedValue({
            nonce: 'good-nonce',
            sub: 'brand-new-sub',
            email: 'user@example.com'
        });

        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'user@example.com' });
        mockTeslaClient.getProducts.mockResolvedValue([
            { energy_site_id: 98765, resource_type: 'battery', site_name: 'Home Powerwall' }
        ]);
        // A legacy account keyed by the email already owns this address.
        mockUserRepo.getByEmail.mockResolvedValue({ id: 'user@example.com' });
        mockUserRepo.getById.mockResolvedValue({ id: 'user@example.com', roles: [] });

        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            importerCreator: vi.fn().mockReturnValue(mockImporter),
            tokenExchange,
            verifyIdToken
        });

        const result = await service.handleTeslaCallback({
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        });

        expect(result.status).toBe('success');
        if (result.status === 'success') {
            expect(result.userId).toBe('user@example.com');
        }
        expect(mockUserRepo.upsertOnTeslaAuth).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'user@example.com' })
        );
        expect(mockSiteRepo.assignSiteToUser).toHaveBeenCalledWith('98765', 'user@example.com');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/tesla-auth-service.test.ts`
Expected: the new test FAILS — `result.userId` is `'brand-new-sub'`, not `'user@example.com'`. All pre-existing tests still pass.

- [ ] **Step 3: Implement** — in `cmd/next-app/src/lib/tesla-auth-service.ts`, replace the verified branch (currently lines 407–415):

```ts
        if (signatureVerified) {
            if (!userEmail && decoded.email) {
                userEmail = decoded.email as string;
            }
            if (decoded.sub) {
                userId = decoded.sub;
            } else if (userEmail) {
                userId = userEmail;
            }
            // Reconcile to an existing account that owns this email (e.g. a
            // legacy row keyed by the email from the pre-fix degraded path).
            // The DB enforces one User row per email (idx_user_email_lower),
            // so adopting the existing id prevents both account splitting and
            // a unique violation on the upsert below.
            if (userEmail && userId) {
                const existingUser = await userRepo.getByEmail(userEmail);
                if (existingUser && existingUser.id !== userId) {
                    console.log('[TeslaAuthService] Reconciled verified sub to existing user account by email:', {
                        email: userEmail,
                        existingUserId: existingUser.id
                    });
                    userId = existingUser.id;
                }
            }
        } else {
```

(`userRepo` is already in scope — it is created at ~line 377, above this block. Leave the `else` degraded branch untouched.)

- [ ] **Step 4: Run the full service test file**

Run: `npx vitest run src/lib/tesla-auth-service.test.ts`
Expected: PASS — new test and all pre-existing tests. Note: pre-existing verified-path tests leave `getByEmail` unmocked (resolves `undefined`), so the new lookup is a no-op for them; if any fail, do NOT weaken the reconciliation — check whether the test asserts a userId that should now legitimately reconcile.

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/tesla-auth-service.ts cmd/next-app/src/lib/tesla-auth-service.test.ts
git -C /Users/kevm/github/pwusage commit -m "fix(auth): reconcile verified-path logins to existing account by email"
```

---

### Task 5: Retry upsert once on unique violation (concurrent-login race)

Both paths now call `getByEmail` before `upsertOnTeslaAuth`, but two concurrent first logins can still race between lookup and insert; the loser now gets a 23505 instead of silently creating a duplicate. Catch it, re-resolve by email, retry once.

**Files:**
- Modify: `cmd/next-app/src/lib/tesla-auth-service.ts` (~line 486, the `userRepo.upsertOnTeslaAuth` call inside the `try` block)
- Test: `cmd/next-app/src/lib/tesla-auth-service.test.ts`

- [ ] **Step 1: Write the failing test** — append inside the top-level describe block:

```ts
    it('retries the user upsert with the existing account id when the email unique index rejects the insert', async () => {
        const tokenExchange = vi.fn().mockResolvedValue({
            id_token: 'valid_id_token',
            access_token: 'access_123',
            refresh_token: 'refresh_123',
            expires_in: 3600
        });
        const verifyIdToken = vi.fn().mockResolvedValue({
            nonce: 'good-nonce',
            sub: 'racing-sub',
            email: 'race@example.com'
        });

        mockTeslaClient.getUserInfo.mockResolvedValue({ email: 'race@example.com' });
        mockTeslaClient.getProducts.mockResolvedValue([
            { energy_site_id: 98765, resource_type: 'battery', site_name: 'Home Powerwall' }
        ]);
        // Pre-upsert lookup sees nothing (the race window)...
        mockUserRepo.getByEmail
            .mockResolvedValueOnce(null)
            // ...but by the time the insert fails, the winner's row exists.
            .mockResolvedValueOnce({ id: 'winner-sub' });
        mockUserRepo.upsertOnTeslaAuth
            .mockRejectedValueOnce(Object.assign(new Error('duplicate key value violates unique constraint "idx_user_email_lower"'), { code: '23505' }))
            .mockResolvedValueOnce(undefined);
        mockUserRepo.getById.mockResolvedValue({ id: 'winner-sub', roles: [] });

        const service = new TeslaAuthService({
            userRepo: mockUserRepo as unknown as UserRepo,
            siteRepo: mockSiteRepo as unknown as SiteRepo,
            teslaTokenRepo: mockTeslaTokenRepo as unknown as TeslaTokenRepo,
            teslaClientCreator: vi.fn().mockReturnValue(mockTeslaClient),
            importerCreator: vi.fn().mockReturnValue(mockImporter),
            tokenExchange,
            verifyIdToken
        });

        const result = await service.handleTeslaCallback({
            code: 'auth_code_xyz',
            state: 'valid_state',
            savedState: 'valid_state',
            savedNonce: 'good-nonce',
            callbackUrl: 'http://localhost/callback'
        });

        expect(result.status).toBe('success');
        if (result.status === 'success') {
            expect(result.userId).toBe('winner-sub');
        }
        expect(mockUserRepo.upsertOnTeslaAuth).toHaveBeenCalledTimes(2);
        expect(mockUserRepo.upsertOnTeslaAuth).toHaveBeenLastCalledWith(
            expect.objectContaining({ userId: 'winner-sub' })
        );
        expect(mockSiteRepo.assignSiteToUser).toHaveBeenCalledWith('98765', 'winner-sub');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/tesla-auth-service.test.ts`
Expected: the new test FAILS (the 23505 rejection propagates or the flow errors out).

- [ ] **Step 3: Implement** — in `cmd/next-app/src/lib/tesla-auth-service.ts`:

Add `isUniqueViolation` to the existing import from `./db` (or add `import { isUniqueViolation } from './db';` if db isn't imported yet).

Replace the plain upsert call (currently ~line 486):

```ts
            await userRepo.upsertOnTeslaAuth({
                userId,
                email: userEmail ?? null,
                accessToken: authData.access_token,
                refreshToken: authData.refresh_token,
                tokenExpiresAt: Date.now() + (authData.expires_in * 1000),
            });
```

with:

```ts
            try {
                await userRepo.upsertOnTeslaAuth({
                    userId,
                    email: userEmail ?? null,
                    accessToken: authData.access_token,
                    refreshToken: authData.refresh_token,
                    tokenExpiresAt: Date.now() + (authData.expires_in * 1000),
                });
            } catch (err) {
                // idx_user_email_lower rejected the insert: a concurrent login
                // created a row with this email after our getByEmail lookup.
                // Adopt that row's id and retry once.
                if (!isUniqueViolation(err) || !userEmail) throw err;
                const existingUser = await userRepo.getByEmail(userEmail);
                if (!existingUser) throw err;
                console.warn('[TeslaAuthService] Upsert hit email unique violation; adopting existing account:', {
                    email: userEmail,
                    existingUserId: existingUser.id
                });
                userId = existingUser.id;
                await userRepo.upsertOnTeslaAuth({
                    userId,
                    email: userEmail ?? null,
                    accessToken: authData.access_token,
                    refreshToken: authData.refresh_token,
                    tokenExpiresAt: Date.now() + (authData.expires_in * 1000),
                });
            }
```

(Everything downstream — `getById(userId)`, `assignSiteToUser(siteId, userId)`, the returned `userId` — reads the reassigned variable, so the adopted id flows through automatically. `userId` is declared with `let`; do not change that.)

- [ ] **Step 4: Run the full service test file**

Run: `npx vitest run src/lib/tesla-auth-service.test.ts`
Expected: PASS, including both new tests from Tasks 4 and 5.

- [ ] **Step 5: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/tesla-auth-service.ts cmd/next-app/src/lib/tesla-auth-service.test.ts
git -C /Users/kevm/github/pwusage commit -m "fix(auth): retry user upsert with reconciled id on email unique violation"
```

---

### Task 6: Demote getByEmail band-aid comment + document uniqueness

**Files:**
- Modify: `cmd/next-app/src/lib/user-repo.ts:46-50` (comment only; keep the SQL as defense-in-depth)
- Modify: `Authentication.md` (one paragraph)

- [ ] **Step 1: Update the getByEmail comment** — replace the `getByEmail` method in `cmd/next-app/src/lib/user-repo.ts` with:

```ts
    async getByEmail(email: string): Promise<User | null> {
        // idx_user_email_lower guarantees at most one row per email; the
        // ORDER BY id LIMIT 1 is retained only as defense-in-depth from the
        // pre-index era (duplicate rows were possible before the dedupe
        // migration).
        const res = await pool.query('SELECT * FROM "User" WHERE LOWER(email) = LOWER($1) ORDER BY id LIMIT 1', [email]);
        if (res.rows.length === 0) return null;
        return res.rows[0] as User;
    }
```

- [ ] **Step 2: Document in Authentication.md** — find the section describing user identity/accounts (search for "getByEmail" or "reconcil"; if absent, add under the Tesla OAuth flow section):

```markdown
### Email uniqueness

`User.email` is unique case-insensitively (partial index `idx_user_email_lower`
on `LOWER(email) WHERE email IS NOT NULL`; rows with NULL email are exempt).
Both OAuth paths (verified and degraded) reconcile logins to an existing
account by email before upserting, and the upsert retries once on a unique
violation to handle concurrent first logins. This prevents the account
splitting that previously occurred when the degraded path keyed a User row by
email and a later verified login keyed a second row by Tesla `sub`.
```

- [ ] **Step 3: Run the user-repo tests**

Run: `npx vitest run src/lib/user-repo.test.ts`
Expected: PASS (comment-only code change).

- [ ] **Step 4: Commit**

```bash
git -C /Users/kevm/github/pwusage add cmd/next-app/src/lib/user-repo.ts Authentication.md
git -C /Users/kevm/github/pwusage commit -m "docs(auth): document User.email uniqueness and demote getByEmail band-aid"
```

---

### Task 7: Full verification

- [ ] **Step 1: Full test suite**

Run: `cd /Users/kevm/github/pwusage/cmd/next-app && npm test -- --run`
Expected: all files pass (baseline before this work: 64 files / 502 tests; expect a few more now).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: exit 0, no errors.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: build completes without errors.

- [ ] **Step 4: Final report — do NOT push**

Leave the branch committed locally. Report to the user: the Task 1 audit output (which prod accounts will merge), the migration filename, and confirmation that tests/lint/build pass. The user pushes and opens the PR; CI will exercise the migration against a prod backup.
