// Pin the process timezone so date-formatting in tests is deterministic across
// developer machines and CI. The TRMNL chart hour labels (src/lib/trmnl/charts.ts)
// now compute their ticks in the *site* timezone via buildHourTicks, so this pin
// is belt-and-braces for them: it is kept so tests that pass an explicit timezone
// stay isolated from the process TZ, and so any other UTC-assuming snapshots
// remain stable. UTC matches production (Vercel runs in UTC).
process.env.TZ = 'UTC';
