import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';

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
        checks.database = { status: 'error', message: (error as Error).message };
    }

    // 2. Schema/Data Check
    if (checks.database.status === 'ok') {
        try {
            const siteCount = await pool.query('SELECT COUNT(*) FROM "Site"');
            const dataCount = await pool.query('SELECT COUNT(*) FROM "EnergyData"');


            checks.schema = {
                status: 'ok',
                details: {
                    sites: parseInt(siteCount.rows[0].count),
                    energyDataRows: parseInt(dataCount.rows[0].count)
                }
            };
        } catch (error) {
            checks.schema = { status: 'error', message: (error as Error).message };
        }
    }

    // 3. Tesla API Check
    // With User-centric Auth, we cannot check Tesla API purely from system health endpoint 
    // without a specific user context (which this public/admin endpoint might not have).
    checks.tesla = { status: 'ok', message: 'API Check Skipped (Requires User Context)' };

    // 4. Env Check
    checks.env = {
        status: process.env.DATABASE_URL ? 'ok' : 'error',
        details: {
            hasDbUrl: !!process.env.DATABASE_URL,
            nodeEnv: process.env.NODE_ENV
        }
    };


    // Allow 200 even if some fail, so frontend can display partial results? 
    // Actually, usually 200 is fine if we return JSON structure describing errors.

    return NextResponse.json(checks, { status: 200 });
}
