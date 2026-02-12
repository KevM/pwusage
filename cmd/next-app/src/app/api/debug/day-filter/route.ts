import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const tz = 'America/Chicago';
        const fmtToday = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        });
        const partsToday = fmtToday.formatToParts(new Date());
        const getT = (type: string) => partsToday.find(p => p.type === type)?.value || '';

        // With Z suffix (UTC)
        const dayStartTs = new Date(`${getT('year')}-${getT('month')}-${getT('day')}T00:00:00Z`).getTime();
        const dayEndTs = new Date(`${getT('year')}-${getT('month')}-${getT('day')}T23:59:59Z`).getTime();

        // Query data in this range
        const query = `
            SELECT timestamp, solar_power
            FROM "EnergyData"
            WHERE site_id = '2252268092126997'
            AND timestamp >= to_timestamp($1 / 1000.0)
            AND timestamp <= to_timestamp($2 / 1000.0)
            ORDER BY timestamp;
        `;

        const result = await pool.query(query, [dayStartTs, dayEndTs]);

        return NextResponse.json({
            timezone: tz,
            todayParts: partsToday,
            dayStartTs,
            dayEndTs,
            dayStartISO: new Date(dayStartTs).toISOString(),
            dayEndISO: new Date(dayEndTs).toISOString(),
            rowCount: result.rows.length,
            first5: result.rows.slice(0, 5),
            last5: result.rows.slice(-5),
            currentTime: new Date().toISOString()
        });
    } catch (error) {
        console.error('Query error:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
