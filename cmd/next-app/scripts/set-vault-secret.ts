import { loadEnvConfig } from '@next/env';
import path from 'path';

// Load env BEFORE importing db
loadEnvConfig(path.resolve(__dirname, '../'));

async function run() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: npx tsx scripts/set-vault-secret.ts <name> <value> [description]');
    console.error('Example: npx tsx scripts/set-vault-secret.ts cron_secret my-secure-token "Vercel API cron secret"');
    process.exit(1);
  }

  const [name, secret, description = ''] = args;

  try {
    const { pool } = await import('../src/lib/db');

    console.log(`Checking if Vault secret "${name}" exists...`);
    const check = await pool.query('SELECT id FROM vault.decrypted_secrets WHERE name = $1', [name]);

    if (check.rows.length > 0) {
      const id = check.rows[0].id;
      console.log(`Secret "${name}" already exists (ID: ${id}). Updating value...`);
      await pool.query(
        'SELECT vault.update_secret($1, $2, $3, $4)',
        [id, secret, name, description]
      );
      console.log(`Successfully updated Vault secret "${name}".`);
    } else {
      console.log(`Secret "${name}" does not exist. Creating new Vault entry...`);
      await pool.query(
        'SELECT vault.create_secret($1, $2, $3)',
        [secret, name, description]
      );
      console.log(`Successfully created Vault secret "${name}".`);
    }

  } catch (error) {
    console.error('Error setting Vault secret:', error);
  } finally {
    process.exit(0);
  }
}

run();
