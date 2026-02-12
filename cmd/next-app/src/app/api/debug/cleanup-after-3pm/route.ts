import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function POST() {
    try {
        // Delete everything after 3pm CST today (2026-02-11 15:00:00 CST = 21:00:00 UTC)
        const cutoffUTC = '2026-02-11T21:00:00Z';

        const deleteQuery = `
            DELETE FROM "EnergyData"
            WHERE site_id = '2252268092126997'
            AND timestamp >= $1
            RETURNING timestamp;
        `;

        const result = await pool.query(deleteQuery, [cutoffUTC]);

        return NextResponse.json({
            deleted: result.rowCount,
            cutoff: cutoffUTC,
            message: `Deleted ${result.rowCount} records after 3pm CST`
        });
    } catch (error) {
        console.error('Delete error:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
