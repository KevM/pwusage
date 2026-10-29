-- Dev-only: scrub the prod -> dev copy. CI runs it in the same transaction as
-- the data restore, so beta and the dev pg_cron jobs never see unscrubbed rows.
-- Idempotent; each rule is skipped while its table does not exist.
--
-- Deliberately kept: TrmnlInstallation.access_token (inbound-only) and User
-- emails. User Tesla tokens are cleared: Tesla refresh tokens are single-use, so
-- beta refreshing a copied token races prod for the same grant (see
-- docs/dev-database-copy.md). Sign in on beta to get beta's own grant.
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
    -- Tesla credentials: a copied refresh token is prod's live grant. Whichever
    -- environment rotates it second presents a consumed token, and Tesla's
    -- reuse detection can revoke prod's grant. 'revoked' shows beta's reconnect
    -- state; signing in on beta writes a separate grant.
    IF to_regclass('public."User"') IS NOT NULL THEN
        EXECUTE 'UPDATE public."User" SET access_token = NULL, refresh_token = NULL, auth_status = ''revoked''
            WHERE access_token IS NOT NULL OR refresh_token IS NOT NULL';
    END IF;
    -- Match the refresh state once prod has it: the migration that derives it
    -- from auth_status will not re-run on later copies, and a copy can catch
    -- prod mid-refresh.
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'User' AND column_name = 'tesla_refresh_state') THEN
        EXECUTE 'UPDATE public."User" SET tesla_refresh_state = ''reconnect_required'', is_refreshing = 0,
                refresh_lock_expires = 0, tesla_refresh_attempt_id = NULL
            WHERE tesla_refresh_state IS DISTINCT FROM ''reconnect_required'' OR is_refreshing <> 0';
    END IF;
    -- Live Activity push tokens: beta must never push to copied prod registrations.
    IF to_regclass('public."BatteryHoldActivity"') IS NOT NULL THEN
        EXECUTE 'DELETE FROM public."BatteryHoldActivity"';
    END IF;
END
$$;
