const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Manually load .env since we are standalone
try {
    const envPath = path.resolve(__dirname, '../.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split('\n').forEach(line => {
            const match = line.match(/^([^=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                let value = match[2].trim();
                if (value.startsWith('"') && value.endsWith('"')) {
                    value = value.slice(1, -1);
                }
                process.env[key] = value;
            }
        });
    }
} catch (e) {
    console.warn('.env not found or unreadable', e);
}

// Strip sslmode=require if present for the script usage
let connStr = process.env.DATABASE_URL || '';
if (connStr.includes('sslmode=require')) {
    connStr = connStr.replace('sslmode=require', '');
}

// Force SSL override for script output cleanliness
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const pool = new Pool({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false }
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const sqlEnableRLS = `
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      -- exclude system tables if any
      AND table_name NOT LIKE 'pg_%'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY;', r.table_schema, r.table_name);
  END LOOP;
END;
$$;
`;

const sqlRevokePublic = `
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  LOOP
    -- remove all privileges from PUBLIC; adjust if you need to keep some
    EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC;', r.table_schema, r.table_name);
  END LOOP;
END;
$$;
`;

rl.question('Are you sure you want to ENABLE RLS and REVOKE public rights on all tables? (y/N): ', async (answer) => {
    if (answer.toLowerCase() !== 'y') {
        console.log('Aborted.');
        rl.close();
        process.exit(0);
    }

    try {
        const client = await pool.connect();
        console.log('Connected. Enabling RLS...');

        await client.query('BEGIN');

        console.log('Running: Enable RLS on all tables...');
        await client.query(sqlEnableRLS);

        console.log('Running: Revoke broad rights from PUBLIC...');
        await client.query(sqlRevokePublic);

        await client.query('COMMIT');
        console.log('RLS enabled and public rights revoked successfully.');

        client.release();
        process.exit(0);
    } catch (err) {
        console.error('Error enabling RLS:', err);
        process.exit(1);
    }
});
