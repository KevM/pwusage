# Solar layout reference detector (Python)

`detector.py` is the Python + pvlib reference for the solar layout detector,
which now runs on the phone (`cmd/ios-app/PWUsage/Models/Solar/LayoutDetection/`).
It infers a site's panel planes (azimuth, tilt, effective size), AC clip and
shading from 5-minute production history and an approximate location. The
detector was first ported to TypeScript and checked against this reference
(see `docs/superpowers/plans/2026-10-27-auto-solar-forecast-server.md`, Task 8),
then ported to Swift and held to the TypeScript by JSON fixtures
(`docs/superpowers/plans/2026-10-30-on-device-solar-layout.md`). The TypeScript
detector was removed from the server in Phase D of that plan. This reference is
not run in CI or production.

Research data (other households' production exports, results, backtests) is
**not** in the repo and must never be committed. Parity runs are local only.

## Running it locally

```bash
python3.12 -m venv .venv
.venv/bin/pip install pvlib pandas pyarrow scipy
.venv/bin/python detector.py site.parquet --tz America/Chicago --lat 43.39 --lon -87.87 --out result.json
```

Input parquet: columns `timestamp` (UTC, interval start) and `solar_wh` (Wh in
the 5-minute interval).

## Parity with the Swift port

`SolarLayoutResearchParityTests` in `cmd/ios-app/PWUsageTests` reads
`site-*.csv` files (`timestamp,solar_wh`) plus an `inputs.json`
(`{ "sites": { "site-a": { "timezone", "lat", "lon" } } }`) from the folder in
`PWUSAGE_SOLAR_PARITY_DIR`, and writes `<site>.swift.json` beside each CSV.
Convert parquet exports to CSV outside the repo, then run the test:

```bash
.venv/bin/python -c "import glob,pandas as pd; [pd.read_parquet(f)[['timestamp','solar_wh']].assign(timestamp=lambda d: pd.to_datetime(d.timestamp, utc=True).dt.strftime('%Y-%m-%dT%H:%M:%SZ')).to_csv(f[:-8]+'.csv', index=False) for f in glob.glob('site-*.parquet')]"
cd cmd/ios-app && TEST_RUNNER_PWUSAGE_SOLAR_PARITY_DIR=/path/outside/repo ./run-tests.sh
```

Differences in the port, by design: altitude 0 and a fixed Linke turbidity of
3.0 instead of pvlib's lookup tables; a seeded bootstrap; the Marion diffuse
IAM integrated numerically.

## Swift fixtures

The JSON fixtures in `cmd/ios-app/PWUsageTests/Fixtures/SolarLayout` were
written once by the TypeScript detector (seeded synthetic cases, test-only
data). Each holds the input samples as base64 little-endian Float32, the stage
values (sun, POA, selection, fit) and the final result, so the Swift port is
checked stage by stage. The generator was removed with the TypeScript detector;
recover it from git history (`scripts/solar-layout-fixtures.ts`, before Phase D)
if a fixture ever has to be regenerated.
