import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const envLocalPath = path.resolve(process.cwd(), '.env.local');
const envPath = path.resolve(process.cwd(), '.env');

if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath });
} else if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set in .env.local or .env');
    process.exit(1);
}

let connStr = process.env.DATABASE_URL;
if (connStr.includes('sslmode=require')) {
    connStr = connStr.replace('sslmode=require', '');
}

const pool = new Pool({
    connectionString: connStr,
    ssl: { rejectUnauthorized: false }
});

interface MissingPluginIdRow {
    id: number;
    uuid: string | null;
    site_id: string;
    site_name: string | null;
    user_id: string | null;
    user_email: string | null;
    created_at: Date;
    recovered_plugin_setting_id: number | null;
}

function formatValue(value: string | number | null): string {
    if (value === null || value === '') return '--';
    return String(value);
}

async function main(): Promise<void> {
    const query = `
        SELECT
            ti.id,
            ti.uuid,
            ti.site_id,
            s.name AS site_name,
            s.user_id,
            u.email AS user_email,
            ti.created_at,
            COALESCE(
                CASE
                    WHEN ti.json IS NULL THEN NULL
                    WHEN ti.json->>'plugin_setting_id' ~ '^[0-9]+$' THEN (ti.json->>'plugin_setting_id')::int
                    ELSE NULL
                END,
                CASE
                    WHEN ti.json IS NULL THEN NULL
                    WHEN ti.json->'user'->>'plugin_setting_id' ~ '^[0-9]+$' THEN (ti.json->'user'->>'plugin_setting_id')::int
                    ELSE NULL
                END,
                CASE
                    WHEN ti.json IS NULL THEN NULL
                    WHEN substring(ti.json->>'installation_callback_url' from '/plugin_settings/([0-9]+)') ~ '^[0-9]+$'
                        THEN (substring(ti.json->>'installation_callback_url' from '/plugin_settings/([0-9]+)'))::int
                    ELSE NULL
                END
            ) AS recovered_plugin_setting_id
        FROM "TrmnlInstallation" ti
        LEFT JOIN "Site" s ON s.id = ti.site_id
        LEFT JOIN "User" u ON u.id = s.user_id
        WHERE ti.plugin_setting_id IS NULL
        ORDER BY ti.created_at DESC, ti.id DESC
    `;

    try {
        const { rows } = await pool.query<MissingPluginIdRow>(query);

        if (rows.length === 0) {
            console.log('No Trmnl installations are missing plugin_setting_id.');
            return;
        }

        const recoverable = rows.filter((row) => row.recovered_plugin_setting_id !== null).length;
        const unrecoverable = rows.length - recoverable;

        console.log(`Found ${rows.length} Trmnl installation(s) with missing plugin_setting_id.`);
        console.log(`Recoverable from JSON/callback URL: ${recoverable}`);
        console.log(`Not recoverable from DB fields: ${unrecoverable}`);
        console.log('');

        for (const row of rows) {
            const createdAt = row.created_at instanceof Date
                ? row.created_at.toISOString()
                : formatValue(String(row.created_at));
            console.log([
                `id=${row.id}`,
                `uuid=${formatValue(row.uuid)}`,
                `site=${formatValue(row.site_name)} (${formatValue(row.site_id)})`,
                `user_id=${formatValue(row.user_id)}`,
                `user_email=${formatValue(row.user_email)}`,
                `created_at=${createdAt}`,
                `recovered_plugin_setting_id=${formatValue(row.recovered_plugin_setting_id)}`
            ].join(' | '));
        }
    } finally {
        await pool.end();
    }
}

main().catch(async (error: unknown) => {
    console.error('Failed to check missing plugin IDs:', error);
    await pool.end();
    process.exit(1);
});
