-- Migration: user_account_deletion_cascades
-- Ensures deleting a sole-member "Site" cascades to its TRMNL installations, and
-- deleting an admin "User" keeps their system announcements.
-- Note: "Site_user_id_fkey" intentionally stays ON DELETE SET NULL (from
-- 20261109135834_add_site_member.sql) so shared sites survive a member's deletion.

-- site_id had no ON DELETE CASCADE before this. Adding one fails loudly if any orphan exists.
ALTER TABLE "TrmnlInstallation"
    DROP CONSTRAINT IF EXISTS "TrmnlInstallation_site_id_fkey",
    ADD CONSTRAINT "TrmnlInstallation_site_id_fkey"
        FOREIGN KEY (site_id) REFERENCES "Site"(id) ON DELETE CASCADE;

ALTER TABLE "SystemAnnouncement"
    DROP CONSTRAINT IF EXISTS "SystemAnnouncement_author_id_fkey",
    ADD CONSTRAINT "SystemAnnouncement_author_id_fkey"
        FOREIGN KEY (author_id) REFERENCES "User"(id) ON DELETE SET NULL;
