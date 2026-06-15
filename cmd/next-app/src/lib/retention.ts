// retention.ts
// Data-retention policy for raw EnergyData / LoadTag history.
//
// DATA_RETENTION_DAYS semantics:
//   - a positive integer  → prune data older than that many days
//   - unset / empty / 0 / negative → KEEP FOREVER (null)
//
// "Keep forever" is the new default. Full raw 5-minute history is what lets the
// savings feature re-bucket energy into ANY tariff's TOU windows for plan-vs-plan
// comparisons. A future flat-file archive can reintroduce a finite live window.

/** Parse DATA_RETENTION_DAYS. Unset/empty/0/negative ⇒ null (keep forever). */
export function retentionDays(raw = process.env.DATA_RETENTION_DAYS): number | null {
    const n = parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** Cutoff date for retention-based deletion and backfill discard.
 *  Keep-forever ⇒ the epoch, so no real day is ever "older than" the cutoff. */
export function retentionCutoff(now = Date.now()): Date {
    const days = retentionDays();
    return days == null ? new Date(0) : new Date(now - days * 86_400_000);
}
