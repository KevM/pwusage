import { pool } from '../src/lib/db';

/**
 * Script to recover users who were marked as revoked due to the cache bug on May 13, 2026.
 *
 * Resets all currently revoked users back to active. If any have legitimately
 * invalid tokens, they will be re-revoked on next API call.
 *
 * Usage: npx tsx scripts/recover-revoked-users.ts [--dry-run]
 */

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');

  console.log('Searching for all users with auth_status = revoked...');
  if (isDryRun) console.log('Running in DRY RUN mode - no changes will be made\n');

  // Find all users currently marked as revoked
  const query = `
    SELECT id, email, auth_status, is_active, created_at
    FROM "User"
    WHERE auth_status = 'revoked'
    ORDER BY created_at DESC
  `;

  const { rows: revokedUsers } = await pool.query(query);

  if (revokedUsers.length === 0) {
    console.log('No revoked users found.');
    process.exit(0);
  }

  console.log(`Found ${revokedUsers.length} revoked users:\n`);
  revokedUsers.forEach((user: any) => {
    console.log(`  - ${user.email} (ID: ${user.id})`);
    console.log(`    is_active: ${user.is_active}`);
    console.log(`    Created: ${user.created_at}\n`);
  });

  if (isDryRun) {
    console.log('Dry run complete. Use without --dry-run to apply changes.');
    process.exit(0);
  }

  // Confirm before making changes
  console.log(`\nAbout to reset ${revokedUsers.length} users to auth_status='active'`);
  const confirmed = await promptConfirm('Continue? (yes/no): ');

  if (!confirmed) {
    console.log('Cancelled.');
    process.exit(0);
  }

  // Reset auth_status to 'active' for all revoked users
  const updateQuery = `
    UPDATE "User"
    SET auth_status = 'active', is_active = true
    WHERE auth_status = 'revoked'
  `;

  const { rowCount } = await pool.query(updateQuery);
  console.log(`\n✓ Successfully reset ${rowCount} users to auth_status='active'`);

  // Show verification
  const { rows: updated } = await pool.query(
    `SELECT COUNT(*) as count FROM "User" WHERE auth_status = 'revoked'`
  );
  console.log(`Remaining revoked users: ${updated[0].count}`);

  process.exit(0);
}

function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.once('data', (data) => {
      resolve(data.toString().trim().toLowerCase() === 'yes');
    });
  });
}

main().catch((err) => {
  console.error('Error:', err.message);
  if (err.message?.includes('connect')) {
    console.error('\nMake sure DATABASE_URL is set and the database is accessible.');
  }
  process.exit(1);
});
