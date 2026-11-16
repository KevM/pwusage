import type { TariffV2 } from '../tesla-client';
import { parseTariffContent, type ParsedTariff } from './tariff-parser';

/**
 * Stores the Tesla rate plan already saved in `Site.json.tariff_content_v2` for sites that have no
 * Tesla or manual `Tariff` rows (a first import that failed, e.g. on the empty-season bug fixed in #373), without
 * calling Tesla. Parsing and metadata mirror `Importer.ensureSite`, so the next Tesla sync with the
 * same content dedupes against the stored version instead of adding another.
 */

/**
 * Sites with no Tesla or manual `Tariff` row and a non-null stored Tesla plan. URDB `estimated` rows
 * don't count: the estimate job gives a site with no plan reference estimates, which are no plan.
 */
export const STORED_TARIFF_CANDIDATES_SQL = `
  SELECT s.id, s.json
  FROM "Site" s
  WHERE NOT EXISTS (SELECT 1 FROM "Tariff" t WHERE t.site_id = s.id AND t.source <> 'estimated')
    AND jsonb_typeof(s.json -> 'tariff_content_v2') = 'object'
  ORDER BY s.id`;

export interface StoredTariffSite {
  id: string;
  json: { site_name?: string | null; tariff_content_v2?: TariffV2 | null } | null;
}

export interface StoredTariffDeps {
  addTariffVersion(
    siteId: string,
    parsed: ParsedTariff,
    metadata: { name: string | null; code: string | null },
    options: { requireNoTariff: boolean }
  ): Promise<boolean>;
}

export type StoredTariffOutcome = 'would_store' | 'stored' | 'already_has_tariff' | 'no_plan' | 'no_usable_season' | 'failed';

export interface StoredTariffResult {
  siteId: string;
  outcome: StoredTariffOutcome;
  planName?: string | null;
  seasons?: number;
  skippedEmptySeasons?: number;
  error?: string;
}

export async function backfillStoredTariffs(
  sites: StoredTariffSite[],
  deps: StoredTariffDeps,
  options: { apply: boolean }
): Promise<StoredTariffResult[]> {
  const results: StoredTariffResult[] = [];
  for (const site of sites) {
    const content = site.json?.tariff_content_v2;
    if (!content || typeof content !== 'object') {
      results.push({ siteId: site.id, outcome: 'no_plan' });
      continue;
    }
    // Same inputs as Importer.ensureSite, so the content hash matches a later Tesla sync.
    const parsed = parseTariffContent(content, site.json?.site_name ?? 'Utility Tariff');
    const metadata = { name: content.name ?? null, code: content.code ?? null };
    const summary = {
      planName: metadata.name,
      seasons: parsed.seasons.length,
      skippedEmptySeasons: Object.keys(content.seasons ?? {}).length - parsed.seasons.length,
    };
    if (parsed.seasons.length === 0) {
      results.push({ siteId: site.id, outcome: 'no_usable_season', ...summary });
      continue;
    }
    if (!options.apply) {
      results.push({ siteId: site.id, outcome: 'would_store', ...summary });
      continue;
    }
    try {
      // The candidate query ran without a lock; the repo rechecks "no tariff yet" under the site lock.
      const stored = await deps.addTariffVersion(site.id, parsed, metadata, { requireNoTariff: true });
      results.push({ siteId: site.id, outcome: stored ? 'stored' : 'already_has_tariff', ...summary });
    } catch (error: unknown) {
      results.push({ siteId: site.id, outcome: 'failed', ...summary, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
