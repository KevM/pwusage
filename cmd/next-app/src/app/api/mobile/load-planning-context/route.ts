import { NextResponse } from 'next/server';
import { Temporal } from '@js-temporal/polyfill';
import { createEnergyRepo } from '@/lib/energy-repo-factory';
import { SiteRepo } from '@/lib/site-repo';
import { verifySiteAccess } from '@/lib/auth-checks';
import { withRequestContext } from '@/lib/request-context';
import { buildLoadPlanningContext } from '@/lib/load-planning-context';
import { buildGridHistory, GRID_HISTORY_DAYS } from '@/lib/load-planning-grid-history';
import { getCachedHouseholdPattern, type HouseholdPattern } from '@/lib/household-pattern-cache';
import type { EnergyData } from '@/lib/db-types';

export const dynamic = 'force-dynamic';

const PRIVATE_NO_STORE = 'private, no-store, max-age=0';

/**
 * The 14-day home/battery pattern and the 28-day grid history share one
 * read: `buildLoadPlanningContext` ignores rows before its own window.
 */
function buildHouseholdPattern(rows: EnergyData[], timeZone: string, asOf: Date): HouseholdPattern {
    const context = buildLoadPlanningContext(rows, timeZone, asOf);
    const { slots: gridSlots, ...gridHistory } = buildGridHistory(rows, timeZone, asOf, GRID_HISTORY_DAYS);
    const gridByMinute = new Map(gridSlots.map((slot) => [slot.localMinute, slot]));
    return {
        ...context,
        gridHistory,
        slots: context.slots.map((slot) => {
            const grid = gridByMinute.get(slot.localMinute);
            return {
                ...slot,
                gridNetExportKw: grid?.gridNetExportKw ?? null,
                cautiousGridNetExportKw: grid?.cautiousGridNetExportKw ?? null,
                solarKw: grid?.solarKw ?? null,
            };
        }),
    };
}

function json(body: unknown, status = 200): NextResponse {
    return NextResponse.json(body, {
        status,
        headers: { 'Cache-Control': PRIVATE_NO_STORE },
    });
}

export async function GET(request: Request): Promise<NextResponse> {
    return withRequestContext(async () => {
        try {
            const siteId = new URL(request.url).searchParams.get('siteId');
            if (!siteId) return json({ error: 'Missing siteId' }, 400);
            if (!(await verifySiteAccess(siteId))) return json({ error: 'Unauthorized' }, 401);

            const site = await new SiteRepo().getSite(siteId);
            if (!site) return json({ error: 'Site not found' }, 404);

            const asOf = new Date();
            const historyEndDate = Temporal.Instant.from(asOf.toISOString())
                .toZonedDateTimeISO(site.timezone)
                .toPlainDate();
            const historyStartDate = historyEndDate.subtract({ days: GRID_HISTORY_DAYS });
            const historyEnd = new Date(historyEndDate.toZonedDateTime({ timeZone: site.timezone }).epochMilliseconds);
            const historyStart = new Date(historyStartDate.toZonedDateTime({ timeZone: site.timezone }).epochMilliseconds);

            const pattern = await getCachedHouseholdPattern(siteId, historyEnd, async () => {
                const rows = await createEnergyRepo(site.timezone).getRawEnergyData(siteId, historyStart, historyEnd);
                return buildHouseholdPattern(rows, site.timezone, asOf);
            });
            return json({
                version: 1,
                site: { id: site.id, timezone: site.timezone },
                units: { power: 'kW', localMinute: 'minute-of-day' },
                asOf: asOf.toISOString(),
                ...pattern,
            });
        } catch (error) {
            console.error('[mobile-load-planning-context] request failed:', error);
            return json({ error: 'Failed to fetch mobile load planning context' }, 500);
        }
    });
}
