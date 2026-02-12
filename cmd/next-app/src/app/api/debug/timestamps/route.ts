import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        // Get all today's data with timestamps
        const query = `
            SELECT timestamp, solar_power, load_power
            FROM "EnergyData"
            WHERE site_id = '2252268092126997'
            AND timestamp::date = CURRENT_DATE
            ORDER BY timestamp
            LIMIT 300;
        `;

        const result = await pool.query(query);

        return NextResponse.json({
            count: result.rows.length,
            first10: result.rows.slice(0, 10),
            last10: result.rows.slice(-10),
            currentServerTime: new Date().toISOString(),
            currentDbTime: (await pool.query('SELECT NOW() as now')).rows[0].now
        });
    } catch (error) {
        console.error('Query error:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
