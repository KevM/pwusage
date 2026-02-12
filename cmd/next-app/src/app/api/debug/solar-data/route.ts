import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        // Check for duplicates
        const dupQuery = `
            SELECT timestamp, COUNT(*) as count
            FROM "EnergyData"
            WHERE site_id = '2252268092126997'
            AND timestamp::date = CURRENT_DATE
            GROUP BY timestamp
            HAVING COUNT(*) > 1
            ORDER BY timestamp;
        `;

        const dups = await pool.query(dupQuery);

        // Look at solar data around 8-11am (where the bounce appears)
        const solarQuery = `
            SELECT timestamp, solar_power, load_power, grid_power
            FROM "EnergyData"
            WHERE site_id = '2252268092126997'
            AND timestamp::date = CURRENT_DATE
            AND EXTRACT(HOUR FROM timestamp) BETWEEN 8 AND 11
            ORDER BY timestamp;
        `;

        const solar = await pool.query(solarQuery);

        // Get total count for today
        const countQuery = `
            SELECT COUNT(*) as total
            FROM "EnergyData"
            WHERE site_id = '2252268092126997'
            AND timestamp::date = CURRENT_DATE;
        `;

        const count = await pool.query(countQuery);

        return NextResponse.json({
            duplicates: dups.rows,
            solarData8to11: solar.rows,
            totalToday: count.rows[0].total
        });
    } catch (error) {
        console.error('Query error:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
