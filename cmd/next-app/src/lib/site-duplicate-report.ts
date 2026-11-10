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
    | 'secondary-has-better-days'
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
    /** Per overlapping day: which side holds the more complete record. */
    quality: { primaryBetter: number; equal: number; secondaryBetter: number; secondaryBetterDays: string[] };
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

// A day the secondary still has open is ignored: it is being collected, and the primary refetches it.
export const SECONDARY_BETTER = `(s.status IS DISTINCT FROM 'open' AND (s.sample_count > p.sample_count OR (s.status = 'complete' AND p.status IS DISTINCT FROM 'complete')))`;
const PRIMARY_BETTER = `(p.sample_count > s.sample_count OR (p.status = 'complete' AND s.status IS DISTINCT FROM 'complete'))`;

/** Whether the primary already holds every day the secondary has, at least as completely. Used by the merge. */
export async function secondaryDayCoverage(
    db: ReportQueryable,
    primaryId: string,
    secondaryId: string,
): Promise<{ secondaryDays: number; notOnPrimary: number; secondaryBetter: number }> {
    const { rows } = await db.query<{ secondary_days: string; not_on_primary: string; secondary_better: string }>(
        `SELECT count(*) AS secondary_days,
            count(*) FILTER (WHERE p.day_start IS NULL) AS not_on_primary,
            count(*) FILTER (WHERE p.day_start IS NOT NULL AND ${SECONDARY_BETTER}) AS secondary_better
         FROM "EnergyDayArchive" s
         LEFT JOIN "EnergyDayArchive" p ON p.site_id = $1 AND p.day_start = s.day_start
         WHERE s.site_id = $2`,
        [primaryId, secondaryId]);
    return {
        secondaryDays: Number(rows[0]?.secondary_days ?? 0),
        notOnPrimary: Number(rows[0]?.not_on_primary ?? 0),
        secondaryBetter: Number(rows[0]?.secondary_better ?? 0),
    };
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
    quality: SiteDuplicateReport['quality'],
): DuplicateVerdict {
    if (!sameHome) return 'not-the-same-home';
    if (secondaryDays === 0) return 'secondary-has-no-days';
    if (overlap.onlySecondary > 0) return 'secondary-has-unique-data';
    // Byte-wise differences are expected between two fetches; only a more complete secondary matters.
    if (quality.secondaryBetter > 0) return 'secondary-has-better-days';
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

    // A secondary day is "better" when it has more samples, or is complete where the primary is not.
    const qualityRows = await db.query<{ primary_better: string; equal: string; secondary_better: string }>(
        `-- day-quality
         SELECT
            count(*) FILTER (WHERE ${PRIMARY_BETTER}) AS primary_better,
            count(*) FILTER (WHERE ${SECONDARY_BETTER}) AS secondary_better,
            count(*) FILTER (WHERE NOT (${PRIMARY_BETTER}) AND NOT (${SECONDARY_BETTER})) AS equal
         FROM "EnergyDayArchive" s
         JOIN "EnergyDayArchive" p ON p.site_id = $1 AND p.day_start = s.day_start
         WHERE s.site_id = $2`,
        [primaryId, secondaryId]);
    const betterDays = await db.query<{ day_start: string }>(
        `-- better-days
         SELECT s.day_start::text AS day_start
         FROM "EnergyDayArchive" s
         JOIN "EnergyDayArchive" p ON p.site_id = $1 AND p.day_start = s.day_start
         WHERE s.site_id = $2 AND ${SECONDARY_BETTER}
         ORDER BY s.day_start LIMIT 50`,
        [primaryId, secondaryId]);
    const qualityRow = qualityRows.rows[0];
    const quality = {
        primaryBetter: Number(qualityRow?.primary_better ?? 0),
        equal: Number(qualityRow?.equal ?? 0),
        secondaryBetter: Number(qualityRow?.secondary_better ?? 0),
        secondaryBetterDays: betterDays.rows.map(r => r.day_start),
    };

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
        quality,
        verdict: chooseVerdict(sameHome, secondaryReport.days, overlap, quality),
    };
}
