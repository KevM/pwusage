// Pin the process timezone so date-formatting in tests is deterministic across
// developer machines and CI. The TRMNL chart hour labels (src/lib/trmnl/charts.ts)
// now compute their ticks in the *site* timezone via buildHourTicks, so this pin
// is belt-and-braces for them: it is kept so tests that pass an explicit timezone
// stay isolated from the process TZ, and so any other UTC-assuming snapshots
// remain stable. UTC matches production (Vercel runs in UTC).
process.env.TZ = 'UTC';

// Unit tests may import services that construct default repository dependencies,
// which import the shared pg pool even when the test never opens a connection.
// Keep those imports hermetic; src/lib/db.test.ts deletes this value to verify
// production code still fails fast when DATABASE_URL is genuinely missing.
process.env.DATABASE_URL ??= 'postgresql://localhost/pwusage_test';

// Tesla tokens are encrypted at rest (src/lib/token-crypto.ts). Fixed test-only
// keys keep repository tests hermetic; they protect nothing.
process.env.TOKEN_ENCRYPTION_KEYS ??= `test1:${Buffer.alloc(32, 7).toString('base64')}`;
process.env.TOKEN_FINGERPRINT_KEY ??= Buffer.alloc(32, 8).toString('base64');
