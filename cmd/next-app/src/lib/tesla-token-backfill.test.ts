import { describe, expect, it, vi } from 'vitest';
import { backfillTeslaTokens, type BackfillQueryable } from './tesla-token-backfill';
import { decryptToken, encryptToken, isEncryptedToken, tokenFingerprint } from './token-crypto';

interface Row { id: string; access_token: string | null; refresh_token: string | null }

/** Serves `batches` to successive SELECTs; UPDATEs report `updateCounts` in order. */
function fakeDb(batches: Row[][], updateCounts: number[] = []) {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
        void params;
        if (sql.trimStart().startsWith('SELECT')) return { rows: batches.shift() ?? [], rowCount: 0 };
        return { rows: [], rowCount: updateCounts.shift() ?? 1 };
    });
    return { db: { query } as unknown as BackfillQueryable, query };
}

const updates = (query: { mock: { calls: unknown[][] } }) => query.mock.calls.filter(([sql]) => String(sql).includes('UPDATE'));

describe('backfillTeslaTokens', () => {
    it('encrypts plaintext tokens, sets the fingerprint, and guards on the old plaintext', async () => {
        const { db, query } = fakeDb([[{ id: 'u1', access_token: 'at', refresh_token: 'rt' }]]);
        const result = await backfillTeslaTokens(db, { batchSize: 10 });

        expect(result).toMatchObject({ scanned: 1, updated: 1, raced: 0 });
        const [[sql, params]] = updates(query) as [[string, string[]]];
        expect(sql).toContain('refresh_token_fp = $3');
        // Compare-and-swap on the exact old values so a concurrent rotation wins.
        expect(sql).toMatch(/WHERE id = \$4 AND access_token IS NOT DISTINCT FROM \$5 AND refresh_token IS NOT DISTINCT FROM \$6/);
        expect(decryptToken(params[0], 'access_token', 'u1')).toBe('at');
        expect(decryptToken(params[1], 'refresh_token', 'u1')).toBe('rt');
        expect(isEncryptedToken(params[0]) && isEncryptedToken(params[1])).toBe(true);
        expect(params[2]).toBe(tokenFingerprint('rt'));
        expect(params.slice(3)).toEqual(['u1', 'at', 'rt']);
    });

    it('counts a lost compare-and-swap as raced, not an error', async () => {
        const { db } = fakeDb([[{ id: 'u1', access_token: 'at', refresh_token: 'rt' }]], [0]);
        expect(await backfillTeslaTokens(db, { batchSize: 10 })).toMatchObject({ updated: 0, raced: 1 });
    });

    it('is idempotent: leaves already-encrypted values alone and only adds a missing fingerprint', async () => {
        const encA = encryptToken('at', 'access_token', 'u1');
        const encR = encryptToken('rt', 'refresh_token', 'u1');
        const { db, query } = fakeDb([[{ id: 'u1', access_token: encA, refresh_token: encR }]]);
        await backfillTeslaTokens(db, { batchSize: 10 });
        const [[, params]] = updates(query) as [[string, string[]]];
        expect(params[0]).toBe(encA);
        expect(params[1]).toBe(encR);
        expect(params[2]).toBe(tokenFingerprint('rt'));
    });

    it('handles null refresh tokens and pages through batches by id', async () => {
        const { db, query } = fakeDb([
            [{ id: 'u1', access_token: 'at', refresh_token: null }, { id: 'u2', access_token: 'a2', refresh_token: 'r2' }],
            [{ id: 'u3', access_token: 'a3', refresh_token: 'r3' }],
            [],
        ]);
        const result = await backfillTeslaTokens(db, { batchSize: 2 });
        expect(result).toMatchObject({ scanned: 3, updated: 3 });
        const [[, first]] = updates(query) as [[string, (string | null)[]]];
        expect(first[1]).toBeNull();
        expect(first[2]).toBeNull();
        const selects = query.mock.calls.filter(([sql]) => String(sql).trimStart().startsWith('SELECT'));
        expect(selects[1][1]).toEqual(['u2', 2]);
    });

    it('dry run writes nothing', async () => {
        const { db, query } = fakeDb([[{ id: 'u1', access_token: 'at', refresh_token: 'rt' }], []]);
        const result = await backfillTeslaTokens(db, { batchSize: 10, dryRun: true });
        expect(result).toMatchObject({ scanned: 1, updated: 0 });
        expect(updates(query)).toHaveLength(0);
    });
});
