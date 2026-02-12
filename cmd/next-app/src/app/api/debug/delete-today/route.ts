import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST() {
    try {
        // Delete all records for today (2026-02-11 in UTC, which covers the entire day in all timezones)
        const deleteQuery = `
            DELETE FROM "EnergyData"
            WHERE site_id = '2252268092126997'
            AND timestamp >= '2026-02-11T00:00:00Z'
            AND timestamp < '2026-02-12T00:00:00Z'
            RETURNING timestamp;
        `;

        const result = await pool.query(deleteQuery);

        return NextResponse.json({
            deleted: result.rowCount,
            message: `Deleted ${result.rowCount} records for today (2026-02-11)`
        });
    } catch (error) {
        console.error('Delete error:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
