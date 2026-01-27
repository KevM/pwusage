
-- Add discord_message_id column to SystemAnnouncement table
ALTER TABLE "SystemAnnouncement"
ADD COLUMN "discord_message_id" TEXT;
