// Pin the process timezone so date-formatting in tests is deterministic across
// developer machines and CI. Several render paths — notably the TRMNL chart
// hour labels in src/lib/trmnl/charts.ts (buildHourLabelEntries uses
// Date.setHours, which reads the process TZ) — produce different output
// depending on the local timezone. Without this, snapshots captured on a
// developer's machine in (e.g.) CDT pass locally but fail on CI in UTC.
//
// UTC matches production (Vercel runs in UTC). Note: the chart renderer
// should ideally use the *site* timezone rather than the server timezone —
// see TODO.md for follow-up.
process.env.TZ = 'UTC';
