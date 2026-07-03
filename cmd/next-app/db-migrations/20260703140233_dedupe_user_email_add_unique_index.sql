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
