-- Integration bearer credentials. Raw tokens are returned only on creation.
CREATE TABLE IF NOT EXISTS "IntegrationCredential" (
    id uuid PRIMARY KEY,
    site_id text NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS integration_credential_user_site_idx
    ON "IntegrationCredential" (user_id, site_id);
CREATE INDEX IF NOT EXISTS integration_credential_site_idx
    ON "IntegrationCredential" (site_id);

ALTER TABLE "IntegrationCredential" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "IntegrationCredential" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "IntegrationCredential" TO service_role;

-- An endpoint can only accept a credential with its own explicit grant.
CREATE TABLE IF NOT EXISTS "IntegrationGrant" (
    credential_id uuid NOT NULL REFERENCES "IntegrationCredential"(id) ON DELETE CASCADE,
    scope text NOT NULL CHECK (scope <> ''),
    PRIMARY KEY (credential_id, scope)
);

ALTER TABLE "IntegrationGrant" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "IntegrationGrant" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "IntegrationGrant" TO service_role;
