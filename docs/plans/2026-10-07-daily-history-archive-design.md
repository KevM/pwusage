# Daily history archive design

Approved direction: replace retention deletion with bounded, verified archival;
production compact reads remain disabled during development and Dev rehearsal.

Reuse EnergyDayArchive/EnergyDaySummary and CompactHistoryStore finalization,
reviewed-revision trimming and restore-before-correction. Retention remains the
existing DATA_RETENTION_DAYS (365 by default), measured in site-local calendar
days. Only whole days ending before or at the cutoff are eligible; preserve the
two most recent completed days regardless of configuration. Preserve LoadTags
and every tariff version. Gaps are encoded exactly, never repaired implicitly.
Incomplete tariff attribution may be archived but must retain raw rows.

A database singleton controls pause and archive-only versus trim mode; it starts
paused. A separate deployment switch enables this replacement job. Compact
reads must be enabled before trimming. Remove the cron's legacy deletion path
entirely, including tags. Production activation is separate from implementation.

Use a dedicated transaction advisory lock to serialize runs. Discover one oldest
eligible site-local raw day at a time through indexed site/timestamp queries.
Persist failed-day attempts, next retry and safe reason codes; delayed failures
must not starve other days. Successful trim naturally removes the candidate;
archive-only skips existing modern archives. Recheck pause/mode before trimming.
Capture a single clock and validate configuration before any mutation.

Bound candidate/day count, elapsed time and estimated database response bytes.
Preflight scalar source/archive/tariff sizes before fetching payloads. Reserve
conservative per-phase estimates before work. These are admission estimates,
not exact provider network accounting; report that limitation. Retain existing
per-statement/lock timeouts. Never make Tesla requests. Progress stores the latest
bounded run report and per-day retry records, not raw payloads or SQL errors.

Verify real PostgreSQL discovery, DST, retention edges, exact gaps/sample/bill
parity, tags/tariffs, contention, pause, retry fairness, budget stops, late
correction and full restoration. Production requires a fresh backup and an
explicit first-trim decision after Dev verification.

The run-wide claim lives inside a read-committed transaction, pinning the
backend through Supabase transaction pooling. Its reads see committed pause
changes. Retry/progress writes use separate short transactions, so rollback of
the claim on release does not undo progress. The claim transaction times out
after 60 seconds; a disconnected worker releases the lock automatically.
