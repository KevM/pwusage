import { decryptToken, encryptToken, isEncryptedToken, tokenFingerprint } from './token-crypto';

/** The slice of `pg.Pool` the backfill needs, so tests can fake it. */
export interface BackfillQueryable {
    query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface BackfillOptions {
    batchSize?: number;
    dryRun?: boolean;
    onBatch?: (progress: BackfillResult) => void;
}

export interface BackfillResult {
    scanned: number;
    updated: number;
    /** Compare-and-swap lost: the row changed (a rotation or login) mid-backfill. */
    raced: number;
}

interface UserTokenRow {
    id: string;
    access_token: string | null;
    refresh_token: string | null;
}

/**
 * Rows still to do: a non-empty plaintext token, or an encrypted refresh token
 * that lacks its fingerprint. Keyset-paged by id so a skipped row cannot loop.
 */
const SELECT_BATCH_SQL = `
    SELECT id, access_token, refresh_token FROM "User"
    WHERE id > $1
      AND (
        (NULLIF(access_token, '') IS NOT NULL AND access_token NOT LIKE 'enc:v1:%')
        OR (NULLIF(refresh_token, '') IS NOT NULL AND (refresh_token NOT LIKE 'enc:v1:%' OR refresh_token_fp IS NULL))
      )
    ORDER BY id
    LIMIT $2
`;

/**
 * Each write is `WHERE id AND access_token/refresh_token = <values just read>`,
 * so a concurrent Tesla rotation (which already writes encrypted + fingerprint)
 * wins and the backfill skips that row instead of clobbering the new grant.
 */
const UPDATE_SQL = `
    UPDATE "User" SET access_token = $1, refresh_token = $2, refresh_token_fp = $3
    WHERE id = $4 AND access_token IS NOT DISTINCT FROM $5 AND refresh_token IS NOT DISTINCT FROM $6
`;

function protect(value: string | null, column: 'access_token' | 'refresh_token', userId: string): string | null {
    if (!value || isEncryptedToken(value)) return value;
    return encryptToken(value, column, userId);
}

export async function backfillTeslaTokens(db: BackfillQueryable, options: BackfillOptions = {}): Promise<BackfillResult> {
    const batchSize = options.batchSize ?? 100;
    const result: BackfillResult = { scanned: 0, updated: 0, raced: 0 };
    let afterId = '';
    for (;;) {
        const { rows } = await db.query(SELECT_BATCH_SQL, [afterId, batchSize]);
        if (rows.length === 0) break;
        for (const row of rows as unknown as UserTokenRow[]) {
            result.scanned++;
            afterId = row.id;
            if (options.dryRun) continue;
            const accessToken = protect(row.access_token, 'access_token', row.id);
            const refreshToken = protect(row.refresh_token, 'refresh_token', row.id);
            const plainRefresh = row.refresh_token ? decryptToken(row.refresh_token, 'refresh_token', row.id) : null;
            const fingerprint = plainRefresh ? tokenFingerprint(plainRefresh) : null;
            const res = await db.query(UPDATE_SQL, [accessToken, refreshToken, fingerprint, row.id, row.access_token, row.refresh_token]);
            if (res.rowCount) result.updated++;
            else result.raced++;
        }
        options.onBatch?.({ ...result });
        if (rows.length < batchSize) break;
    }
    return result;
}
