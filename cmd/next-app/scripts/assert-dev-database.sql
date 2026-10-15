-- Dev-only guard. Every script that writes to the prod -> dev copy starts here.
-- It fails closed: it refuses unless the database carries the positive marker
-- row pwusage_env.environment = 'dev', which is created once by hand on the dev
-- project and never by a migration (see docs/database-backups.md). The marker
-- survives the CI copy because the restore drops only the public schema.
--
-- Stop at the first error however psql was invoked, so a refusal here also
-- stops every later statement and every later -f file.
\set ON_ERROR_STOP on

DO $$
BEGIN
    -- Separate checks: the SELECT below is planned only once the table exists.
    IF to_regclass('pwusage_env.environment') IS NULL THEN
        RAISE EXCEPTION 'Refusing to run: this database is not marked as a dev database (pwusage_env.environment is missing)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pwusage_env.environment WHERE name = 'dev') THEN
        RAISE EXCEPTION 'Refusing to run: this database is not marked as a dev database (no ''dev'' row in pwusage_env.environment)';
    END IF;
END
$$;
