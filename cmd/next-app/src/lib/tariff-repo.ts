import { pool, Tariff, TariffSchedule } from './db';
import { ParsedTariff, tariffContentHash } from './importer/tariff-parser';
import { logEvent } from './observability';
import { SiteRepo } from './site-repo';
import { enqueueReattributionOnClient, logReattributionEnqueued, type EnqueuedReattribution, type EnqueueReattributionParams } from './tariff-reattribution-queue';
import { addCalendarDays, computeSpanMutations, siteLocalDateString } from './tariff-timeline';
import {
  applySpanMutationPlan,
  insertTariffGraph,
  loadExistingSpans,
  recomputeIsCurrentTariff,
} from './tariff-timeline-repo';

export class TariffRepo {
  // === Queries ===
  // No is_current filter on purpose: returns ALL versions, used by the billing
  // name-resolution map so historical EnergyData rows (which keep an older
  // version's tariff_id) still resolve to a tariff name.
  async getTariffsForSite(siteId: string): Promise<Tariff[]> {
    const res = await pool.query('SELECT id, site_id, name, updated FROM "Tariff" WHERE site_id = $1', [siteId]);
    return res.rows;
  }

  async getSchedulesForSite(siteId: string): Promise<TariffSchedule[]> {
    const res = await pool.query(
      `SELECT ts.*,
              COALESCE(ts.buy_rate, s.buy_rate) AS buy_rate,
              COALESCE(ts.sell_rate, s.sell_rate) AS sell_rate
       FROM "TariffSchedule" ts
       JOIN "TariffSeason" s ON ts.season_id = s.id
       JOIN "Tariff" t ON s.tariff_id = t.id
       WHERE t.site_id = $1`,
      [siteId]
    );
    return res.rows.map(row => ({
      id: Number(row.id),
      season_id: Number(row.season_id),
      name: row.name,
      buy_rate: row.buy_rate === null ? null : Number(row.buy_rate),
      sell_rate: row.sell_rate === null ? null : Number(row.sell_rate),
      from_day_of_week: row.from_day_of_week === null ? null : Number(row.from_day_of_week),
      from_hour: row.from_hour === null ? null : Number(row.from_hour),
      from_minute: row.from_minute === null ? null : Number(row.from_minute),
      to_day_of_week: row.to_day_of_week === null ? null : Number(row.to_day_of_week),
      to_hour: row.to_hour === null ? null : Number(row.to_hour),
      to_minute: row.to_minute === null ? null : Number(row.to_minute),
    }));
  }

  // === Commands ===
  /**
   * Append a new Tesla tariff version (Tariff + seasons + schedules) without
   * deleting prior versions or overwriting active manual effective-date spans.
   * Deduplicates against the latest source = 'tesla' version.
   */
  async addTariffVersion(siteId: string, parsed: ParsedTariff): Promise<void> {
    const newHash = tariffContentHash(parsed);
    const client = await pool.connect();
    let changed = false;
    let reattribution: EnqueueReattributionParams | null = null;
    let queued: EnqueuedReattribution | null = null;
    try {
      await client.query('BEGIN');

      // Acquire write lock on the parent Site row to serialize concurrent tariff updates for this site.
      await client.query('SELECT 1 FROM "Site" WHERE id = $1 FOR UPDATE', [siteId]);

      // Deduplicate against the latest 'tesla' tariff so an active manual plan
      // does not cause repeated Tesla syncs to insert duplicate versions.
      const latestTesla = (await client.query<{ id: number; content_hash: string | null }>(
        `SELECT id, content_hash FROM "Tariff" WHERE site_id = $1 AND source = 'tesla' ORDER BY id DESC LIMIT 1`,
        [siteId]
      )).rows[0];
      if (latestTesla?.content_hash === newHash) {
        await client.query('COMMIT');
        return;
      }

      const newTariffId = await insertTariffGraph(client, siteId, parsed, 'tesla', null, false, newHash);
      const siteTz = (await client.query<{ timezone: string }>(
        'SELECT timezone FROM "Site" WHERE id = $1',
        [siteId]
      )).rows[0]?.timezone ?? 'UTC';
      const today = siteLocalDateString(new Date(), siteTz);
      const spans = await loadExistingSpans(client, siteId);
      const coveringToday = spans.find(s => s.effectiveFrom <= today && (s.effectiveTo === null || s.effectiveTo >= today));

      if (coveringToday?.source === 'manual') {
        logEvent('info', 'tariff.tesla_sync.divergence_detected', {
          latestTariffId: newTariffId,
          activeManualTariffId: coveringToday.tariffId,
          contentHashChanged: true,
        });
      } else {
        const nextManual = spans.find(s => s.source === 'manual' && s.effectiveFrom > today);
        const effectiveTo = nextManual ? addCalendarDays(nextManual.effectiveFrom, -1) : null;
        await applySpanMutationPlan(client, siteId, computeSpanMutations(spans, {
          tariffId: newTariffId,
          source: 'tesla',
          effectiveFrom: today,
          effectiveTo,
          updatedByUserId: null,
        }));
        await recomputeIsCurrentTariff(client, siteId, today);
        // Today's samples may already be priced under the previous plan, and when the new span is
        // now the earliest it also reprices the days before it. The cron runner picks the job up.
        reattribution = { siteId, fromDate: today, toDate: effectiveTo, requestedByUserId: null, trigger: 'tesla_sync' };
        queued = await enqueueReattributionOnClient(client, reattribution);
      }

      await client.query('COMMIT');
      changed = true;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    if (changed) {
      new SiteRepo().invalidateCache(siteId);
      if (reattribution && queued) logReattributionEnqueued(reattribution, queued);
    }
  }
}
