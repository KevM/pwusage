# Seven-day stored-history tariff attribution repair

## Cause

Site `189176704371` had seven complete v2 day records with no schedule IDs,
despite retaining tariff version 119. Their UTC starts were August 31 through
September 6, 2026 at 14:00; their actual Melbourne-local dates are **September
1–7**. Each holds all 288 samples.

The currently configured tariff's fallback season starts September 11 and ends
September 7, wrapping across a year. Separate daily seasons cover September
8–10. `Schedule.matchSeason` treated every same-month range as a non-wrapping
range, making the fallback impossible to match and also excluding other months
of the year. Re-attributing with the old resolver reproduced the missing IDs.

The resolver now distinguishes a same-month range whose start day follows its
end day. It uses the existing year-wrap handling for that case, preserving
ordinary inclusive same-month seasons and the explicit September 8–10 gap.
Seven regression cases failed before the fix; the updated 35-test schedule
suite passes, including exact boundaries and dates in other months/years.

## Production repair performed

The owner's agreed policy is to attribute stored history using the currently
configured tariff's season and schedule rules at each sample date. For these
records, the current tariff and previously recorded tariff are both **119**.
No tariff version, rate, effective date or sample was invented or edited.

The seven original records and summary rows were read without credentials or
user profiles. Float64 summary values were read as binary hex to preserve exact
precision. Existing payload, metadata, summary and latest-projection integrity
were verified locally using the existing recovery/codec functions. The fixed
resolver then generated seven attribution segments and seven summary rows per
day from the same samples.

A single bounded transaction used the existing history-maintenance shared lock
and per-site mutation lock, locked the affected rows, and checked every expected
revision, old metadata checksum and payload checksum before replacing summaries.
Only attribution, its completeness flag, revision and metadata checksum changed
in each archive row. The compressed payload, original fetch/status/coverage
metadata and latest-reading projection were preserved. The transaction checked
all unchanged archive fields and called `verify_compact_day_metadata(..., true)`
after rebuilding each day's summaries.

The exact repair was rehearsed in a disposable, externally disconnected local
Supabase Postgres container using the seven original records and the repository's
history migrations. A stale revision on the seventh day rejected and rolled back
the entire transaction; replay of an already-applied plan was also rejected.

Production application and a separate subsequent read verified:

- **7/7** days fully attributed; **2,016/2,016** stored samples retained.
- **49** summaries, with **0** null schedule IDs.
- **7/7** billing-metadata checks passed.
- All original compressed and uncompressed payload checksums unchanged.
- All original latest-projection checksums unchanged.
- No Tesla fetch, raw-data rewrite or schema migration.

The production data correction preceded merge/deployment of the associated
resolver fix. Deploy that fix to prevent recurrence in future writes/reads.

Temporary input records, generated repair SQL and the local rehearsal database
are removed after verification; no customer samples or repair payloads are
committed. The ordinary private daily backup taken before the repair remains
available independently of this operation.

Repository verification: **1,605 unit tests** passed; **95 focused tests**
(including local PostgreSQL history persistence) passed; lint and the standard
Turbopack production build passed with a dummy local database URL.
