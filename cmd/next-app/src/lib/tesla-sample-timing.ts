/** Tesla's `calendar_history` sample interval; a sample's label is its interval's start. */
export const SAMPLE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How long after its label a new 5-minute sample can be relied on to be in
 * Tesla's history. Measured 2026-10-24 on Harrison (15 s polling for ~25 min,
 * plus a 7-minute follow-up): each new sample first appeared 16–97 s after its
 * label, typically 75–85 s, and its values never changed afterwards.
 */
export const TESLA_PUBLISH_LAG_MS = 2 * 60 * 1000;

/** When the sample after `latestLabel` (the newest stored one) is due in Tesla's history. */
export function nextSampleDueAt(latestLabel: Date): Date {
    return new Date(+latestLabel + SAMPLE_INTERVAL_MS + TESLA_PUBLISH_LAG_MS);
}

/**
 * A fetch requested once the day has ended is Tesla's final answer for it:
 * samples never change once published, so refetching would only return the
 * same gaps, and the record it wrote got its final status (complete, or open
 * until it ages into gapped). A request at 23:58 can already hold every sample
 * but was stored as open, so it is not final.
 */
export function isDayFetchFinal(fetchedAt: Date | null, dayEnd: Date): boolean {
    return fetchedAt !== null && +fetchedAt >= +dayEnd;
}
