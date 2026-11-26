-- Migration: integration_tokens_as_grants
-- Created at: 2026-11-26T00:35:18.999Z

-- Integration tokens become OAuth grants of kind 'token', so one store, one
-- bearer check and one revocation path cover AI apps and scripts alike.
-- Token hashes are copied unchanged: tokens issued before this deploy keep
-- working. "IntegrationCredential" and "IntegrationGrant" stay until a later
-- migration drops them (see TODO.md). Prod runs this before the new code
-- deploys, so triggers at the end keep tokens the old code creates or revokes
-- in that window in step with the grants.

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

-- Deploy window: the old code still writes the old tables until the new code
-- is live. Its create inserts the credential and then its scope, so copy on the
-- scope insert; its revoke deletes the credential (cascading the scope).
CREATE OR REPLACE FUNCTION public.integration_credential_copy_to_grant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    INSERT INTO "OAuthGrant"
        (id, user_id, client_id, client_name, client_uri, resource, scopes, created_at, max_expires_at, session_version, kind)
    SELECT c.id, c.user_id, 'pwu_integration', c.name, NULL, 'urn:pwusage:integrations:v1',
           ARRAY[NEW.scope], c.created_at, 'infinity', u.session_version, 'token'
    FROM "IntegrationCredential" c
    JOIN "User" u ON u.id = c.user_id
    WHERE c.id = NEW.credential_id
    ON CONFLICT (id) DO UPDATE
        SET scopes = array(SELECT DISTINCT unnest("OAuthGrant".scopes || EXCLUDED.scopes) ORDER BY 1)
        WHERE "OAuthGrant".kind = 'token';

    INSERT INTO "OAuthGrantSite" (grant_id, site_id)
    SELECT c.id, c.site_id FROM "IntegrationCredential" c
    WHERE c.id = NEW.credential_id
    ON CONFLICT DO NOTHING;

    INSERT INTO "OAuthToken" (token_hash, grant_id, kind, expires_at, created_at)
    SELECT c.token_hash, c.id, 'integration', 'infinity', c.created_at
    FROM "IntegrationCredential" c
    WHERE c.id = NEW.credential_id
    ON CONFLICT (token_hash) DO NOTHING;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS integration_grant_copy_to_oauth ON "IntegrationGrant";
CREATE TRIGGER integration_grant_copy_to_oauth
    AFTER INSERT ON "IntegrationGrant"
    FOR EACH ROW EXECUTE FUNCTION public.integration_credential_copy_to_grant();

CREATE OR REPLACE FUNCTION public.integration_credential_revoke_grant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    UPDATE "OAuthGrant" SET revoked_at = COALESCE(revoked_at, now())
    WHERE id = OLD.id AND kind = 'token';
    UPDATE "OAuthToken" SET revoked_at = COALESCE(revoked_at, now())
    WHERE grant_id = OLD.id AND kind = 'integration';
    RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS integration_credential_revoke_oauth ON "IntegrationCredential";
CREATE TRIGGER integration_credential_revoke_oauth
    AFTER DELETE ON "IntegrationCredential"
    FOR EACH ROW EXECUTE FUNCTION public.integration_credential_revoke_grant();
