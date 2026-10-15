-- Dev-only: scrub the prod -> dev copy. CI runs it in the same transaction as
-- the data restore, so beta and the dev pg_cron jobs never see unscrubbed rows.
-- Idempotent; each rule is skipped while its table does not exist.
--
-- Deliberately kept: TrmnlInstallation.access_token (inbound-only), User Tesla
-- tokens and emails. Beta's cron jobs rely on the Tesla tokens.
-- Set here, not only in the guard: psql ignores a \set made inside an included
-- file when deciding whether the including file stops.
\set ON_ERROR_STOP on
\ir assert-dev-database.sql

DO $$
BEGIN
    -- One-time mobile login codes: short-lived, never needed on a copy.
    IF to_regclass('public."MobileLoginHandoff"') IS NOT NULL THEN
        EXECUTE 'DELETE FROM public."MobileLoginHandoff"';
    END IF;
    -- Stored but never used by the app.
    IF to_regclass('public."TrmnlInstallation"') IS NOT NULL THEN
        EXECUTE 'UPDATE public."TrmnlInstallation" SET refresh_token = NULL WHERE refresh_token IS NOT NULL';
    END IF;
END
$$;
