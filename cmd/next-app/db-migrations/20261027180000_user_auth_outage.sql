-- Migration: user_auth_outage
-- Created at: 2026-10-27T18:00:00.000Z

-- Record when a user's Tesla access was lost and when it came back, so an open
-- day on a revoked site can be told apart from a gapped one, re-auth can refetch
-- the outage, and diagnostics can see how long a user was broken.
--
-- A trigger stamps both on auth_status transitions, so every writer (repos,
-- refresh lock, ops scripts) is covered:
--   revoked / no_token / error  -> auth_lost_at = now(), unless already lost
--   active                      -> auth_restored_at = now(), if currently lost
-- "Currently lost" = auth_lost_at after auth_restored_at (or no restore yet).
-- Both are kept after a restore, so the last outage window stays readable.
-- no_sites is not an auth loss and stamps nothing. Idempotent.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS auth_lost_at timestamptz;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS auth_restored_at timestamptz;

CREATE OR REPLACE FUNCTION public.stamp_user_auth_outage() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
    lost boolean := NEW.auth_lost_at IS NOT NULL
        AND (NEW.auth_restored_at IS NULL OR NEW.auth_lost_at > NEW.auth_restored_at);
BEGIN
    IF NEW.auth_status IN ('revoked', 'no_token', 'error') AND NOT lost THEN
        NEW.auth_lost_at := now();
    ELSIF NEW.auth_status = 'active' AND lost THEN
        NEW.auth_restored_at := now();
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.stamp_user_auth_outage() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.stamp_user_auth_outage() TO service_role;

DROP TRIGGER IF EXISTS stamp_user_auth_outage ON "User";
CREATE TRIGGER stamp_user_auth_outage
    BEFORE INSERT OR UPDATE OF auth_status ON "User"
    FOR EACH ROW EXECUTE FUNCTION public.stamp_user_auth_outage();

-- Users already without working access: the loss time is unknown. Use their
-- oldest unsettled day record (when fetching stopped), else last_checked_at.
UPDATE "User" u SET auth_lost_at = COALESCE(
        (SELECT min(a.day_start) FROM "EnergyDayArchive" a JOIN "Site" s ON s.id = a.site_id
          WHERE s.user_id = u.id AND a.status = 'open'),
        u.last_checked_at AT TIME ZONE 'UTC',
        now())
 WHERE u.auth_status IN ('revoked', 'no_token', 'error')
   AND u.auth_lost_at IS NULL;
