# Compact historical reader integration

## Completed behavior

`EnergyRepo` accepts an optional `EnergyHistoryReader`. Detail, cycle aggregates and 15-minute bucket queries delegate to it when supplied. Existing callers still construct the default SQL repository. No routes activate archived history yet.

The prototype `CompactHistoryReader` accepts a site timezone and a snapshot store. The store must return one coherent revision of complete intersecting finalized local days and raw rows in the requested half-open range. The reader checks day boundaries with the site's timezone, site identity, non-overlap, archive checksum/envelope, numeric validity and reconciliation of every daily summary against decoded samples.

Detail combines archived and raw samples sorted by timestamp. Identical raw overlap is included once. Changed or additional raw samples inside a finalized day raise an integrity error requiring a rebuilt revision; neither source wins silently. Missing history remains absent, without a Tesla request or fabricated zero-energy samples.

Whole-day billing uses stored tariff/schedule totals after verification. Partial-day boundaries filter reconstructed samples and regroup only the selected intervals. Local dates remain correct over both DST transitions. Finalized days must carry an explicit completed historical-attribution audit marker. An incomplete marker on a day with selected samples, or any null schedule in selected billing data, raises an incomplete-attribution error rather than reaching the existing midpoint fallback. Detailed charts/analysis still work for those samples.

Chart bucketing matches the existing SQL contract: UTC 15-minute buckets, average interval energy, observed count, latest sample timestamp, separate tariff/schedule groups, and null SoC. Detailed readers preserve the original five-minute SoC. Generated bucket IDs are positional; ordering of tariff groups tied on a timestamp is unspecified by the original SQL, so those IDs are not persistent identities.

Tests compare outputs through the actual web/mobile billing aggregation, TRMNL aggregation/series, and detailed analysis adapter. They cover different historical tariff rates/versions and changed billing ranges. They also cover DST, partial days, mixed archive/raw history, corrupt archives, wrong envelopes, stale summaries, foreign sites, duplicate days, invalid raw values, missing history and late conflicts.

## Limits and next work

This is an opt-in integration prototype, not a production archive backend. Every request currently decodes whole days to prove integrity before using their summaries. Production should persist immutable reconciled archive/summary revisions and query only summaries for whole days, with bounded detail reads where needed. Exact reconciliation here relies on summaries generated from the same JavaScript doubles in the same order; any SQL or decimal accumulation needs a documented reconciliation tolerance.

The store contract requires a consistent snapshot. Two independent queries without a shared transaction/revision are insufficient. No concurrent finalization, importer correction, recovery or database claim behavior has been implemented yet. The next milestone is a restricted SQL store plus transaction-safe finalization/rebuilding, initially preserving raw rows for comparison.

Coverage, has-data, latest timestamp/sample/SoC, gap audit and importer writes still use raw SQL. They must be integrated before deleting any history. Site/service billing and TRMNL combine multiple calls; a production store must also ensure coherent revisions across those calls when corrections occur. Existing raw-only cycle SQL groups by database day while the archive reader uses site-local days; pricing parity is tested for resolved schedules, but null attribution is deliberately refused and needs repair. Historical schedule existence/ownership requires the attribution audit at finalization before setting the completed marker; merely retaining a non-null ID does not prove correct tariff mapping.

No migration, live default reader change, Tesla fetch, tier change, cleanup activation, deployment or PR #126 change was made. This checkpoint does not make history deletion safe.

## Verification

Full suite: 1,044 tests passed and one existing test skipped. Lint and production build passed. Independent review found no blocking issues; its historical-attribution contract clarification was implemented as an explicit completed-audit marker plus interface documentation. Diff checks passed.
