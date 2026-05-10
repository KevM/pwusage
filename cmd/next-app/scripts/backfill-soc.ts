import { loadEnvConfig } from '@next/env';
import path from 'path';

// Load env before importing app modules that depend on DATABASE_URL/tokens.
loadEnvConfig(path.resolve(__dirname, '../'));

interface CliArgs {
    siteId?: string;
    startDate?: string;
    endDate?: string;
    dryRun: boolean;
    overwrite: boolean;
}

interface DayStats {
    date: string;
    soeSamples: number;
    matchedRows: number;
    updatedRows: number;
    teslaMs: number;
    dbMs: number;
    totalMs: number;
}

interface EnergyRowCandidate {
    id: number;
    timestampMs: number;
    batterySoc: number | null;
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        dryRun: false,
        overwrite: false
    };

    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--site' || token === '--site-id') {
            args.siteId = argv[i + 1];
            i++;
        } else if (token === '--start') {
            args.startDate = argv[i + 1];
            i++;
        } else if (token === '--end') {
            args.endDate = argv[i + 1];
            i++;
        } else if (token === '--dry-run') {
            args.dryRun = true;
        } else if (token === '--overwrite') {
            args.overwrite = true;
        }
    }

    return args;
}

function parseDateOnly(value: string, label: string): Date {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
        throw new Error(`Invalid ${label} date "${value}". Use YYYY-MM-DD.`);
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function getLocalDateKey(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const part of parts) {
        if (part.type !== 'literal') map[part.type] = part.value;
    }
    return `${map.year}-${map.month}-${map.day}`;
}

function findNearestCandidate(
    targetMs: number,
    candidates: EnergyRowCandidate[],
    maxDistanceMs: number
): EnergyRowCandidate | null {
    if (candidates.length === 0) return null;

    let lo = 0;
    let hi = candidates.length - 1;
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (candidates[mid].timestampMs < targetMs) lo = mid + 1;
        else hi = mid;
    }

    const near: EnergyRowCandidate[] = [];
    near.push(candidates[lo]);
    if (lo > 0) near.push(candidates[lo - 1]);
    if (lo + 1 < candidates.length) near.push(candidates[lo + 1]);

    let best: EnergyRowCandidate | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of near) {
        const distance = Math.abs(candidate.timestampMs - targetMs);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = candidate;
        }
    }

    if (!best || bestDistance > maxDistanceMs) return null;
    return best;
}

async function run(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));

    const { pool } = await import('../src/lib/db');
    const { EnergyRepo } = await import('../src/lib/energy-repo');
    const { SiteRepo } = await import('../src/lib/site-repo');
    const { TeslaTokenRepo } = await import('../src/lib/tesla-token-repo');
    const { TeslaClient } = await import('../src/lib/tesla-client');

    const siteRepo = new SiteRepo();
    const tokenRepo = new TeslaTokenRepo(siteRepo);
    let siteId = args.siteId;
    if (!siteId) {
        const siteIds = await siteRepo.getSiteIds();
        siteId = siteIds[0];
        if (!siteId) throw new Error('No sites found. Provide --site <siteId>.');
        console.log(`No --site provided. Using first site: ${siteId}`);
    }

    const site = await siteRepo.getSite(siteId);
    if (!site) throw new Error(`Site not found: ${siteId}`);
    if (!site.access_token || !site.refresh_token) {
        throw new Error(`Site ${siteId} is missing Tesla tokens (access/refresh).`);
    }

    const handlers = tokenRepo.getLockedRefreshHandler(siteId);
    const client = new TeslaClient({
        accessToken: site.access_token,
        refreshToken: site.refresh_token,
        tokenRefreshHandler: handlers.refreshHandler,
        onTokenError: handlers.errorHandler
    });

    const tz = site.timezone || 'UTC';
    const startPivot = args.startDate
        ? parseDateOnly(args.startDate, 'start')
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const endPivot = args.endDate
        ? parseDateOnly(args.endDate, 'end')
        : new Date();

    let cursor = EnergyRepo.getSiteMidnight(startPivot, tz);
    const endDay = EnergyRepo.getSiteMidnight(endPivot, tz);
    const dayStats: DayStats[] = [];
    let totalSamples = 0;
    let totalMatched = 0;
    let totalUpdated = 0;

    console.log(`Backfill SOE -> EnergyData.battery_soc`);
    console.log(`- site: ${siteId}`);
    console.log(`- timezone: ${tz}`);
    console.log(`- start day: ${getLocalDateKey(cursor, tz)}`);
    console.log(`- end day: ${getLocalDateKey(endDay, tz)}`);
    console.log(`- dry run: ${args.dryRun ? 'yes' : 'no'}`);
    console.log(`- overwrite existing SOC: ${args.overwrite ? 'yes' : 'no'}`);

    while (cursor.getTime() <= endDay.getTime()) {
        const dayStartMs = Date.now();
        const nextDay = EnergyRepo.getSiteMidnight(new Date(cursor.getTime() + 30 * 60 * 60 * 1000), tz);
        const dayKey = getLocalDateKey(cursor, tz);
        const dayEnd = new Date(nextDay.getTime() - 1000);

        const teslaStartMs = Date.now();
        let rows = await client.getSoeHistory(siteId, cursor, dayEnd, 'day', tz);
        if (rows.length === 0) {
            // Tesla sometimes returns empty SOE for day-period boundaries; hourly is a useful fallback.
            rows = await client.getSoeHistory(siteId, cursor, dayEnd, 'hour', tz);
        }
        rows = rows.filter((row) => typeof row.percentage_charged === 'number');
        const teslaMs = Date.now() - teslaStartMs;

        let dayMatched = 0;
        let dayUpdated = 0;
        let dbMs = 0;

        if (rows.length > 0) {
            const db = await pool.connect();
            try {
                const dbStartMs = Date.now();
                const energyRows = await db.query<{ id: number; timestamp: Date; battery_soc: number | null }>(`
                    SELECT id, timestamp, battery_soc
                    FROM "EnergyData"
                    WHERE site_id = $1
                      AND timestamp >= $2::timestamptz - INTERVAL '5 minutes'
                      AND timestamp <= $3::timestamptz + INTERVAL '5 minutes'
                    ORDER BY timestamp ASC
                `, [siteId, cursor.toISOString(), dayEnd.toISOString()]);

                const candidates: EnergyRowCandidate[] = energyRows.rows.map((row) => ({
                    id: row.id,
                    timestampMs: new Date(row.timestamp).getTime(),
                    batterySoc: row.battery_soc
                }));

                const updatesById = new Map<number, number>();
                const maxDistanceMs = 5 * 60 * 1000;

                for (const row of rows) {
                    const ts = new Date(row.timestamp);
                    if (Number.isNaN(ts.getTime())) continue;

                    const candidate = findNearestCandidate(ts.getTime(), candidates, maxDistanceMs);
                    if (!candidate) {
                        continue;
                    }

                    dayMatched++;
                    const currentSoc = candidate.batterySoc;
                    const shouldUpdate = args.overwrite || currentSoc === null || updatesById.has(candidate.id);
                    if (!shouldUpdate) continue;
                    updatesById.set(candidate.id, row.percentage_charged);
                }

                dayUpdated = updatesById.size;

                if (!args.dryRun && updatesById.size > 0) {
                    await db.query('BEGIN');
                    const ids = Array.from(updatesById.keys());
                    const socValues = ids.map((id) => updatesById.get(id) ?? 0);
                    const updated = await db.query(`
                        UPDATE "EnergyData" e
                        SET battery_soc = u.battery_soc
                        FROM (
                            SELECT unnest($1::int[]) AS id, unnest($2::double precision[]) AS battery_soc
                        ) u
                        WHERE e.id = u.id
                          AND ($3::boolean OR e.battery_soc IS NULL)
                    `, [ids, socValues, args.overwrite]);
                    await db.query('COMMIT');
                    dayUpdated = updated.rowCount ?? 0;
                }
                dbMs = Date.now() - dbStartMs;
            } catch (error) {
                if (!args.dryRun) {
                    await db.query('ROLLBACK');
                }
                throw error;
            } finally {
                db.release();
            }
        }

        const stats: DayStats = {
            date: dayKey,
            soeSamples: rows.length,
            matchedRows: dayMatched,
            updatedRows: dayUpdated,
            teslaMs,
            dbMs,
            totalMs: Date.now() - dayStartMs
        };
        dayStats.push(stats);
        totalSamples += stats.soeSamples;
        totalMatched += stats.matchedRows;
        totalUpdated += stats.updatedRows;

        console.log(`- ${dayKey}: samples=${stats.soeSamples}, matched=${stats.matchedRows}, ${args.dryRun ? 'would_update' : 'updated'}=${stats.updatedRows}, tesla_ms=${stats.teslaMs}, db_ms=${stats.dbMs}, total_ms=${stats.totalMs}`);
        cursor = nextDay;
    }

    console.log('\nBackfill complete');
    console.log(`- days: ${dayStats.length}`);
    console.log(`- total SOE samples: ${totalSamples}`);
    console.log(`- total matched rows: ${totalMatched}`);
    console.log(`- total ${args.dryRun ? 'would update' : 'updated'} rows: ${totalUpdated}`);
}

run()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('SOE backfill failed:', error);
        process.exit(1);
    });
