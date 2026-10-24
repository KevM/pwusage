import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { isUserAdmin } from '@/lib/auth-checks';

export const dynamic = 'force-dynamic';

export interface HealthCheckStatus {
    status: 'ok' | 'warning' | 'error' | 'unknown';
    message?: string;
    details?: Record<string, unknown>;
    products?: { id: number; site_name: string }[];
}

export interface HealthChecks {
    database: HealthCheckStatus;
    schema: HealthCheckStatus;
    tesla: HealthCheckStatus;
    env: HealthCheckStatus;
}

export async function GET() {
    let isAdmin = false;
    try {
        isAdmin = await isUserAdmin();
    } catch (err) {
        console.warn('[HealthCheck] Auth check failed (e.g. DB outage), falling back to non-admin status:', err);
    }

    const checks: HealthChecks = {
        database: { status: 'unknown', message: '' },
        schema: { status: 'unknown', details: {} },
        tesla: { status: 'unknown', message: '' },
        env: { status: 'unknown', details: {} }
    };

    // 1. Database Connection Check
    try {
        const res = await pool.query('SELECT NOW() as time');
        checks.database = {
            status: 'ok',
            message: `Connected. Server time: ${res.rows[0].time}`
        };
    } catch (error) {
        console.error('[HealthCheck] Database connection error:', error);
        checks.database = { status: 'error', message: 'Database connection failed' };
    }

    // 2. Schema/Data Check
    if (checks.database.status === 'ok') {
        try {
            const siteCount = await pool.query('SELECT COUNT(*) FROM "Site"');
            // Day records hold the history; raw rows are a transitional write buffer.
            const dayCount = await pool.query('SELECT COUNT(*) FROM "EnergyDayArchive"');

            checks.schema = {
                status: 'ok',
                details: {
                    sites: parseInt(siteCount.rows[0].count),
                    energyDays: parseInt(dayCount.rows[0].count)
                }
            };
        } catch (error) {
            console.error('[HealthCheck] Schema check error:', error);
            checks.schema = { status: 'error', message: 'Schema check failed' };
        }
    }

    // 3. Tesla API Check
    checks.tesla = { status: 'ok', message: 'API Check Skipped (Requires User Context)' };

    // 4. Env Check
    checks.env = {
        status: process.env.DATABASE_URL ? 'ok' : 'error',
        details: {
            hasDbUrl: !!process.env.DATABASE_URL,
            nodeEnv: process.env.NODE_ENV
        }
    };

    // For public / non-admin callers, return a minimal status object without leaking internal details
    if (!isAdmin) {
        const isHealthy = checks.database.status === 'ok' && checks.schema.status === 'ok' && checks.env.status === 'ok';
        return NextResponse.json(
            { status: isHealthy ? 'ok' : 'error' },
            { status: isHealthy ? 200 : 503 }
        );
    }

    return NextResponse.json(checks, { status: 200 });
}
