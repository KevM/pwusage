import type { SiteWithTariffs } from '../db';
import type { EnergyDataRow, Importer } from '../importer';
import { addDaysInSiteTimezone } from '../date-utils';

export interface FetchedDay { rows: EnergyDataRow[]; fetchedAt: Date }

/**
 * One Tesla request (energy + SOE) for the site-local day starting at `start`,
 * up to `now` for today, ready for `CompactHistoryStore.writeDay`. SOE is
 * required: the write replaces the whole day, so a failed SOE request must leave
 * the stored day (and its SOC) as it was instead of writing nulls. `fetchedAt`
 * is when the request was made, which orders competing writes for the day:
 * published samples never change, so a later request sees at least what an
 * earlier one did, and an earlier, slower request that arrives last is
 * superseded instead of overwriting the newer data.
 */
export async function fetchDayForWrite(importer: Pick<Importer, 'fetchRange'>, site: SiteWithTariffs, start: Date, now = new Date(),
    clock: () => Date = () => new Date()): Promise<FetchedDay> {
    const end = addDaysInSiteTimezone(start, 1, site.timezone);
    // End 1 s before midnight so Tesla stays inside this day (see Importer.loadInterval).
    const until = new Date(Math.min(+end - 1000, +now));
    const fetchedAt = clock();
    const rows = await importer.fetchRange(site, start, until, 'day', { requireSoe: true });
    return { rows: rows.filter(r => r.timestamp >= start && r.timestamp < end), fetchedAt };
}
