import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const query = vi.fn();
    const isUserAdmin = vi.fn();
    return {
        query,
        isUserAdmin
    };
});

vi.mock('@/lib/db', () => ({
    pool: {
        query: mocks.query
    }
}));

vi.mock('@/lib/auth-checks', () => ({
    isUserAdmin: mocks.isUserAdmin
}));

import { GET } from './route';

describe('/api/health', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isUserAdmin.mockResolvedValue(false);
        mocks.query.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT NOW()')) {
                return { rows: [{ time: '2026-07-04 12:00:00' }] };
            }
            if (sql.includes('FROM "Site"')) {
                return { rows: [{ count: '2' }] };
            }
            if (sql.includes('FROM "EnergyData"')) {
                return { rows: [{ count: '500' }] };
            }
            return { rows: [] };
        });
    });

    it('returns minimal status for non-admin callers without leaking internal details', async () => {
        mocks.isUserAdmin.mockResolvedValue(false);

        const response = await GET();
        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body).toEqual({ status: 'ok' });
        expect(body.database).toBeUndefined();
        expect(body.schema).toBeUndefined();
        expect(body.env).toBeUndefined();
    });

    it('returns sanitized 503 response on database connection error for non-admin callers', async () => {
        mocks.isUserAdmin.mockResolvedValue(false);
        mocks.query.mockRejectedValue(new Error('FATAL: connection to server postgres.internal.host failed'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const response = await GET();
        expect(response.status).toBe(503);
        const body = await response.json();

        expect(body).toEqual({ status: 'error' });
        expect(JSON.stringify(body)).not.toContain('postgres.internal.host');
        expect(consoleSpy).toHaveBeenCalled();
    });

    it('returns 503 error for non-admin callers when schema query fails', async () => {
        mocks.isUserAdmin.mockResolvedValue(false);
        mocks.query.mockImplementation(async (sql: string) => {
            if (sql.includes('SELECT NOW()')) {
                return { rows: [{ time: '2026-07-04 12:00:00' }] };
            }
            if (sql.includes('FROM "Site"')) {
                throw new Error('relation "Site" does not exist');
            }
            return { rows: [] };
        });
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const response = await GET();
        expect(response.status).toBe(503);
        const body = await response.json();

        expect(body).toEqual({ status: 'error' });
        expect(consoleSpy).toHaveBeenCalled();
    });

    it('safely handles auth lookup failure during DB outage and returns 503 instead of 500', async () => {
        mocks.isUserAdmin.mockRejectedValue(new Error('DB connection failed during auth check'));
        mocks.query.mockRejectedValue(new Error('DB connection failed during health check'));
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const response = await GET();
        expect(response.status).toBe(503);
        const body = await response.json();

        expect(body).toEqual({ status: 'error' });
        expect(warnSpy).toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalled();
    });

    it('returns detailed diagnostics for authenticated admin callers', async () => {
        mocks.isUserAdmin.mockResolvedValue(true);

        const response = await GET();
        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body.database.status).toBe('ok');
        expect(body.database.message).toContain('Connected. Server time:');
        expect(body.schema.status).toBe('ok');
        expect(body.schema.details).toEqual({
            sites: 2,
            energyDataRows: 500
        });
        expect(body.env.status).toBe('ok');
        expect(body.env.details.hasDbUrl).toBeDefined();
    });
});
