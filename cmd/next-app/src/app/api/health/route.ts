import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { cookies } from 'next/headers';
import { TeslaClient } from '@/lib/tesla-client';

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
            const usageCount = await pool.query('SELECT COUNT(*) FROM "EnergyUsage"');

            checks.schema = {
                status: 'ok',
                details: {
                    sites: parseInt(siteCount.rows[0].count),
                    energyDataRows: parseInt(dataCount.rows[0].count),
                    energyUsageRows: parseInt(usageCount.rows[0].count)
                }
            };
        } catch (error) {
            checks.schema = { status: 'error', message: (error as Error).message };
        }
    }

    // 3. Tesla API Check
    try {
        const cookieStore = await cookies();
        const accessToken = cookieStore.get('access_token')?.value;
        const refreshToken = cookieStore.get('refresh_token')?.value;

        if (!accessToken) {
            checks.tesla = { status: 'warning', message: 'No access token in cookies' };
        } else {
            const client = new TeslaClient({
                accessToken,
                refreshToken: refreshToken ?? '',
                onTokenUpdate: () => { }
            });

            const products = await client.getProducts();
            checks.tesla = {
                status: 'ok',
                message: `Connected. Found ${products.length} products.`,
                products: products.map(p => ({
                    id: p.energy_site_id,
                    site_name: p.site_name
                }))
            };
        }
    } catch (error) {
        checks.tesla = { status: 'error', message: (error as Error).message };
    }

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
