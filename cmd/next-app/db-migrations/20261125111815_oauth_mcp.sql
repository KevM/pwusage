-- Migration: oauth_mcp
-- Created at: 2026-11-25T17:18:15.682Z

CREATE TABLE IF NOT EXISTS "OAuthClient" (
    client_id text PRIMARY KEY,
    client_name text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 120),
    redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) >= 1),
    client_uri text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);

CREATE TABLE IF NOT EXISTS "OAuthGrant" (
    id uuid PRIMARY KEY,
    user_id text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    client_id text NOT NULL,
    client_name text NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 120),
    client_uri text,
    resource text NOT NULL,
    scopes text[] NOT NULL CHECK (cardinality(scopes) >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    max_expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS oauth_grant_user_active_idx
    ON "OAuthGrant" (user_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS oauth_grant_client_idx
    ON "OAuthGrant" (client_id);

CREATE TABLE IF NOT EXISTS "OAuthGrantSite" (
    grant_id uuid NOT NULL REFERENCES "OAuthGrant"(id) ON DELETE CASCADE,
    site_id text NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    PRIMARY KEY (grant_id, site_id)
);

CREATE INDEX IF NOT EXISTS oauth_grant_site_site_idx
    ON "OAuthGrantSite" (site_id);

CREATE TABLE IF NOT EXISTS "OAuthAuthCode" (
    code_hash bytea PRIMARY KEY CHECK (octet_length(code_hash) = 32),
    client_id text NOT NULL,
    client_name text NOT NULL,
    client_uri text,
    user_id text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    resource text NOT NULL,
    scopes text[] NOT NULL CHECK (cardinality(scopes) >= 1),
    site_ids text[] NOT NULL CHECK (cardinality(site_ids) >= 1),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    grant_id uuid REFERENCES "OAuthGrant"(id) ON DELETE SET NULL,
    -- The user's session_version when consent was given: "Sign out everywhere"
    -- bumps it, so a code minted under a revoked session cannot be redeemed.
    session_version integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
-- Databases that ran an earlier draft of this migration (the table already existed).
ALTER TABLE "OAuthAuthCode" ADD COLUMN IF NOT EXISTS session_version integer;

CREATE INDEX IF NOT EXISTS oauth_auth_code_expires_idx
    ON "OAuthAuthCode" (expires_at);

CREATE TABLE IF NOT EXISTS "OAuthToken" (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    grant_id uuid NOT NULL REFERENCES "OAuthGrant"(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('access', 'refresh')),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_token_grant_idx
    ON "OAuthToken" (grant_id, kind);
CREATE INDEX IF NOT EXISTS oauth_token_expires_idx
    ON "OAuthToken" (expires_at);

DO $$
DECLARE
    tbl text;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['OAuthClient', 'OAuthGrant', 'OAuthGrantSite', 'OAuthAuthCode', 'OAuthToken'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', tbl);
        EXECUTE format('GRANT ALL ON public.%I TO service_role', tbl);
    END LOOP;
END
$$;
