-- Session helpers for the dev history snapshot and restore. Temporary (pg_temp),
-- so nothing is left in the database. Included inside their transactions after
-- the temp tables reloaded_archive and reloaded_summary may be created.

-- A digest of whole rows, ordered by their text, so any column change shows.
CREATE FUNCTION pg_temp.rows_digest(query text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    digest text;
BEGIN
    EXECUTE format('SELECT md5(coalesce(string_agg(r::text, E''\n'' ORDER BY r::text), '''')) FROM (%s) r', query)
    INTO digest;
    RETURN digest;
END
$$;

CREATE FUNCTION pg_temp.archive_digest(site text) RETURNS text LANGUAGE sql AS $$
    SELECT pg_temp.rows_digest(format('SELECT * FROM public."EnergyDayArchive" WHERE site_id = %L', site))
$$;

CREATE FUNCTION pg_temp.summary_digest(site text) RETURNS text LANGUAGE sql AS $$
    SELECT pg_temp.rows_digest(format('SELECT * FROM public."EnergyDaySummary" WHERE site_id = %L', site))
$$;

CREATE FUNCTION pg_temp.reloaded_archive_digest() RETURNS text LANGUAGE sql AS $$
    SELECT pg_temp.rows_digest('SELECT * FROM reloaded_archive')
$$;

CREATE FUNCTION pg_temp.reloaded_summary_digest() RETURNS text LANGUAGE sql AS $$
    SELECT pg_temp.rows_digest('SELECT * FROM reloaded_summary')
$$;

-- The day tables' columns in order: a snapshot only restores into the same shape.
CREATE FUNCTION pg_temp.column_signature() RETURNS text LANGUAGE sql AS $$
    SELECT md5(string_agg(table_name || '.' || column_name || ':' || data_type, ',' ORDER BY table_name, ordinal_position))
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('EnergyDayArchive', 'EnergyDaySummary')
$$;

-- The newest applied migration, or null where the Supabase migration table is absent.
CREATE FUNCTION pg_temp.migration_version() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
    version text;
BEGIN
    IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
        RETURN NULL;
    END IF;
    EXECUTE 'SELECT max(version)::text FROM supabase_migrations.schema_migrations' INTO version;
    RETURN version;
END
$$;
