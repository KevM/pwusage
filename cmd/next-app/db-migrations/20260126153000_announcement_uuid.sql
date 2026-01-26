-- Change SystemAnnouncement ID to UUID

-- 1. Add new uuid column
ALTER TABLE "SystemAnnouncement" ADD COLUMN uuid UUID DEFAULT gen_random_uuid();

-- 2. Drop old primary key constraint
-- Name might vary, safely try to find and drop or just drop assuming default name
ALTER TABLE "SystemAnnouncement" DROP CONSTRAINT IF EXISTS "SystemAnnouncement_pkey";

-- 3. Drop old id column (integer data will be lost, acceptable per plan)
ALTER TABLE "SystemAnnouncement" DROP COLUMN id;

-- 4. Rename uuid to id
ALTER TABLE "SystemAnnouncement" RENAME COLUMN uuid TO id;

-- 5. Set new primary key
ALTER TABLE "SystemAnnouncement" ADD PRIMARY KEY (id);
