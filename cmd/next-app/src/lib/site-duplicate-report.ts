import type { PoolClient } from 'pg';

/**
 * Read-only comparison of a duplicate `Site` against the real one for the same Powerwall, to decide
 * what a fuller merge must do (design spec section 10, steps 1-2). It never writes.
 */
export type ReportQueryable = Pick<PoolClient, 'query'>;

export type DuplicateVerdict =
    | 'not-the-same-home'
    | 'secondary-has-no-days'
    | 'secondary-days-are-duplicates'
    | 'overlapping-days-differ'
    | 'secondary-has-unique-data';

export interface SiteSideReport {
    id: string;
    days: number;
    firstDay: string | null;
    lastDay: string | null;
    summaries: number;
    trmnl: number;
    tags: number;
}

export interface SiteDuplicateReport {
    sameHome: boolean;
    sameTimezone: boolean;
    primary: SiteSideReport;
    secondary: SiteSideReport;
    overlap: { identical: number; differing: number; onlySecondary: number };
    verdict: DuplicateVerdict;
}

interface SiteRow {
    id: string;
    timezone: string;
    tesla_hardware_id: string | null;
}

interface DayTotalsRow {
    site_id: string;
    days: string;
    first_day: string | null;
    last_day: string | null;
}

interface OtherRowsRow {
    summaries: string;
    trmnl: string;
    tags: string;
}

async function otherRows(db: ReportQueryable, siteId: string): Promise<OtherRowsRow> {
    const { rows } = await db.query<OtherRowsRow>(
        `-- other-rows
         SELECT
            (SELECT count(*) FROM "EnergyDaySummary" WHERE site_id = $1) AS summaries,
            (SELECT count(*) FROM "TrmnlInstallation" WHERE site_id = $1) AS trmnl,
            (SELECT count(*) FROM "LoadTag" WHERE site_id = $1) AS tags`,
        [siteId]);
    return rows[0] ?? { summaries: '0', trmnl: '0', tags: '0' };
}

function chooseVerdict(
    sameHome: boolean,
    secondaryDays: number,
    overlap: SiteDuplicateReport['overlap'],
): DuplicateVerdict {
    if (!sameHome) return 'not-the-same-home';
    if (secondaryDays === 0) return 'secondary-has-no-days';
    if (overlap.onlySecondary > 0) return 'secondary-has-unique-data';
    if (overlap.differing > 0) return 'overlapping-days-differ';
    return 'secondary-days-are-duplicates';
}

export async function reportSiteDuplicate(
    db: ReportQueryable,
    primaryId: string,
    secondaryId: string,
): Promise<SiteDuplicateReport> {
    const sites = await db.query<SiteRow>(
        `SELECT id, timezone, tesla_hardware_id FROM "Site" WHERE id = ANY($1) ORDER BY id`,
        [[primaryId, secondaryId]]);
    const primary = sites.rows.find(r => r.id === primaryId);
    const secondary = sites.rows.find(r => r.id === secondaryId);
    if (!primary) throw new Error(`primary site ${primaryId} not found`);
    if (!secondary) throw new Error(`secondary site ${secondaryId} not found`);

    const totals = await db.query<DayTotalsRow>(
        `-- day-totals
         SELECT site_id, count(*) AS days, min(day_start)::text AS first_day, max(day_start)::text AS last_day
         FROM "EnergyDayArchive" WHERE site_id = ANY($1) GROUP BY site_id`,
        [[primaryId, secondaryId]]);

    // Days match on their start time, and a day is "identical" when its stored checksum matches.
    const overlapRows = await db.query<{ identical: string; differing: string; only_secondary: string }>(
        `-- day-overlap
         SELECT
            count(*) FILTER (WHERE p.day_start IS NOT NULL AND p.checksum = s.checksum) AS identical,
            count(*) FILTER (WHERE p.day_start IS NOT NULL AND p.checksum <> s.checksum) AS differing,
            count(*) FILTER (WHERE p.day_start IS NULL) AS only_secondary
         FROM "EnergyDayArchive" s
         LEFT JOIN "EnergyDayArchive" p ON p.site_id = $1 AND p.day_start = s.day_start
         WHERE s.site_id = $2`,
        [primaryId, secondaryId]);
    const overlapRow = overlapRows.rows[0];

    const side = async (id: string): Promise<SiteSideReport> => {
        const day = totals.rows.find(r => r.site_id === id);
        const other = await otherRows(db, id);
        return {
            id,
            days: Number(day?.days ?? 0),
            firstDay: day?.first_day ?? null,
            lastDay: day?.last_day ?? null,
            summaries: Number(other.summaries),
            trmnl: Number(other.trmnl),
            tags: Number(other.tags),
        };
    };

    const overlap = {
        identical: Number(overlapRow?.identical ?? 0),
        differing: Number(overlapRow?.differing ?? 0),
        onlySecondary: Number(overlapRow?.only_secondary ?? 0),
    };
    const sameHome = Boolean(primary.tesla_hardware_id) && primary.tesla_hardware_id === secondary.tesla_hardware_id;
    const secondaryReport = await side(secondaryId);

    return {
        sameHome,
        sameTimezone: primary.timezone === secondary.timezone,
        primary: await side(primaryId),
        secondary: secondaryReport,
        overlap,
        verdict: chooseVerdict(sameHome, secondaryReport.days, overlap),
    };
}
