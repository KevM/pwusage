-- Billing bearer credentials. Raw tokens are returned only on creation.
CREATE TABLE IF NOT EXISTS "BillingIntegrationCredential" (
    id uuid PRIMARY KEY,
    site_id text NOT NULL REFERENCES "Site"(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_integration_credential_user_site_idx
    ON "BillingIntegrationCredential" (user_id, site_id);
CREATE INDEX IF NOT EXISTS billing_integration_credential_site_idx
    ON "BillingIntegrationCredential" (site_id);

ALTER TABLE "BillingIntegrationCredential" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON "BillingIntegrationCredential" FROM PUBLIC, anon, authenticated;
GRANT ALL ON "BillingIntegrationCredential" TO service_role;
