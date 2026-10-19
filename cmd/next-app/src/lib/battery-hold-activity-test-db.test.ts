import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { activityTestSocket, ensureRoles, safeActivityTestSocket } from './battery-hold-activity-test-db';

describe.skipIf(!safeActivityTestSocket)('isolated PostgreSQL test setup', () => {
    it('creates a role safely when several suites race to create it', async () => {
        // Roles are cluster-wide, so the parallel suites race on CREATE ROLE. The loser
        // of a simultaneous create gets unique_violation, not duplicate_object.
        const role = `race_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
        const pools = Array.from({ length: 12 }, () => new Pool({
            host: activityTestSocket, port: 55440, user: process.env.USER, database: 'postgres', max: 1,
        }));
        try {
            const results = await Promise.allSettled(pools.map((pool) => ensureRoles(pool, [role])));
            expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
            const found = await pools[0].query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
            expect(found.rowCount).toBe(1);
        } finally {
            await pools[0].query(`DROP ROLE IF EXISTS ${role}`);
            await Promise.all(pools.map((pool) => pool.end()));
        }
    });
});
