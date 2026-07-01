import fs from 'fs';
import path from 'path';

function getTimestampStr(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

function run() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: npx tsx scripts/create-migration.ts <migration-name>');
    console.error('Example: npx tsx scripts/create-migration.ts add-battery-hold-table');
    process.exit(1);
  }

  const migrationName = args.join('_')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const migrationsDir = path.resolve(__dirname, '../db-migrations');
  if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir, { recursive: true });
  }

  // Find all existing migration files
  const files = fs.readdirSync(migrationsDir);
  
  // Parse existing timestamps/prefixes
  let maxPrefix = BigInt(0);
  for (const file of files) {
    if (!file.endsWith('.sql')) continue;
    // Extract numerical prefix before the first letter/underscore
    // Example: 20260525030000_supabase_cron_trigger.sql -> 20260525030000
    // Example: 20260522_192520_add_fk_indexes.sql -> 20260522192520
    const prefixMatch = file.match(/^(\d{8})_?(\d{6})?/);
    if (prefixMatch) {
      const cleanPrefix = (prefixMatch[1] + (prefixMatch[2] || '000000')).replace(/[^0-9]/g, '');
      try {
        const val = BigInt(cleanPrefix);
        if (val > maxPrefix) {
          maxPrefix = val;
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }
  }

  let finalPrefixStr = getTimestampStr();
  let finalPrefixVal = BigInt(finalPrefixStr);

  // If there's a collision or the generated prefix is not greater than the highest existing prefix,
  // increment by 1 to ensure a strictly monotonic version number.
  if (finalPrefixVal <= maxPrefix) {
    finalPrefixVal = maxPrefix + BigInt(1);
    finalPrefixStr = finalPrefixVal.toString();
  }

  const filename = `${finalPrefixStr}_${migrationName}.sql`;
  const filepath = path.join(migrationsDir, filename);

  const initialContent = `-- Migration: ${migrationName}
-- Created at: ${new Date().toISOString()}

-- TODO: If this migration creates a new table, you MUST enable Row Level Security (RLS)!
-- ALTER TABLE "MyNewTable" ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON "MyNewTable" FROM PUBLIC;
-- REVOKE ALL ON "MyNewTable" FROM anon;
-- REVOKE ALL ON "MyNewTable" FROM authenticated;
-- GRANT ALL ON "MyNewTable" TO service_role;
--
-- If using serial/sequence:
-- GRANT ALL ON SEQUENCE "MyNewTable_id_seq" TO service_role;
`;
  fs.writeFileSync(filepath, initialContent, 'utf8');

  console.log(`\nSuccessfully created new migration file:`);
  console.log(`  File: cmd/next-app/db-migrations/${filename}`);
  console.log(`  Path: ${filepath}\n`);
  console.log(`\x1b[33m%s\x1b[0m`, `⚠️  REMINDER: If this migration creates a new table, you MUST enable Row Level Security (RLS)!`);
  console.log(`   Boilerplate has been added to the top of the file as comments for your convenience.\n`);
}

run();
