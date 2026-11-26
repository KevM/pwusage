-- Migration: integration_tokens_as_grants
-- Created at: 2026-11-26T00:35:18.999Z

-- Integration tokens become OAuth grants of kind 'token', so one store, one
-- bearer check and one revocation path cover AI apps and scripts alike.
-- Token hashes are copied unchanged: tokens issued before this deploy keep
-- working. "IntegrationCredential" and "IntegrationGrant" are then dropped.
-- Prod runs this before the new code deploys, so the old code's integration
-- routes fail until the deploy lands; accepted while the feature had a single
-- user (PR #459).

ALTER TABLE "OAuthGrant" ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'app';

DO $$
BEGIN
    ALTER TABLE "OAuthGrant" DROP CONSTRAINT IF EXISTS "OAuthGrant_kind_check";
    ALTER TABLE "OAuthGrant" ADD CONSTRAINT "OAuthGrant_kind_check" CHECK (kind IN ('app', 'token'));
    ALTER TABLE "OAuthToken" DROP CONSTRAINT IF EXISTS "OAuthToken_kind_check";
    ALTER TABLE "OAuthToken" ADD CONSTRAINT "OAuthToken_kind_check"
        CHECK (kind IN ('access', 'refresh', 'integration'));
END
$$;

-- Integration tokens never expire on their own ('infinity'); they end when
-- revoked, on "Sign out everywhere", or when the user loses the home.
DO $$
BEGIN
    -- Absent on a second run: the tables are dropped below.
    IF to_regclass('public."IntegrationCredential"') IS NOT NULL THEN
        INSERT INTO "OAuthGrant"
            (id, user_id, client_id, client_name, client_uri, resource, scopes, created_at, max_expires_at, session_version, kind)
        SELECT c.id, c.user_id, 'pwu_integration', c.name, NULL, 'urn:pwusage:integrations:v1',
               array_agg(g.scope ORDER BY g.scope), c.created_at, 'infinity', u.session_version, 'token'
        FROM "IntegrationCredential" c
        JOIN "IntegrationGrant" g ON g.credential_id = c.id
        JOIN "User" u ON u.id = c.user_id
        GROUP BY c.id, c.user_id, c.name, c.created_at, u.session_version
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO "OAuthGrantSite" (grant_id, site_id)
        SELECT c.id, c.site_id
        FROM "IntegrationCredential" c
        JOIN "OAuthGrant" og ON og.id = c.id AND og.kind = 'token'
        ON CONFLICT DO NOTHING;

        INSERT INTO "OAuthToken" (token_hash, grant_id, kind, expires_at, created_at)
        SELECT c.token_hash, c.id, 'integration', 'infinity', c.created_at
        FROM "IntegrationCredential" c
        JOIN "OAuthGrant" og ON og.id = c.id AND og.kind = 'token'
        ON CONFLICT (token_hash) DO NOTHING;
    END IF;
END
$$;

DROP TABLE IF EXISTS "IntegrationGrant";
DROP TABLE IF EXISTS "IntegrationCredential";

-- An integration token covers exactly one home, so when that home's link goes
-- (the home is deleted) the token grant goes too, taking its token with it.
-- App grants can cover several homes and are left alone.
CREATE OR REPLACE FUNCTION public.oauth_grant_site_drop_orphan_token()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    DELETE FROM "OAuthGrant" g
    WHERE g.id = OLD.grant_id
      AND g.kind = 'token'
      AND NOT EXISTS (SELECT 1 FROM "OAuthGrantSite" gs WHERE gs.grant_id = g.id);
    RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS oauth_grant_site_drop_orphan_token ON "OAuthGrantSite";
CREATE TRIGGER oauth_grant_site_drop_orphan_token
    AFTER DELETE ON "OAuthGrantSite"
    FOR EACH ROW EXECUTE FUNCTION public.oauth_grant_site_drop_orphan_token();

-- Token grants already orphaned by a home deleted before this trigger existed.
DELETE FROM "OAuthGrant" g
WHERE g.kind = 'token'
  AND NOT EXISTS (SELECT 1 FROM "OAuthGrantSite" gs WHERE gs.grant_id = g.id);
