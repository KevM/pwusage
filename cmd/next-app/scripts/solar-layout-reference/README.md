# Solar layout reference detector (Python)

`detector.py` is the Python + pvlib reference for the TypeScript detector in
`src/lib/solar-layout/`. It infers a site's panel planes (azimuth, tilt,
effective size), AC clip and shading from 5-minute production history and an
approximate location. The TypeScript port is checked against it for parity
(see the plan `docs/superpowers/plans/2026-10-27-auto-solar-forecast-server.md`,
Task 8). It is not run in CI or production.

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

## Parity with the TypeScript port

`scripts/solar-layout-parity.ts` reads `site-*.csv` files (`timestamp,solar_wh`)
plus an `inputs.json` (`{ "sites": { "site-a": { "timezone", "lat", "lon" } } }`)
and writes `<site>.ts.json` beside each CSV. Convert parquet exports to CSV
outside the repo with:

```bash
.venv/bin/python -c "import glob,pandas as pd; [pd.read_parquet(f)[['timestamp','solar_wh']].assign(timestamp=lambda d: pd.to_datetime(d.timestamp, utc=True).dt.strftime('%Y-%m-%dT%H:%M:%SZ')).to_csv(f[:-8]+'.csv', index=False) for f in glob.glob('site-*.parquet')]"
npx tsx scripts/solar-layout-parity.ts --dir /path/outside/repo
```

Differences in the port, by design: altitude 0 and a fixed Linke turbidity of
3.0 instead of pvlib's lookup tables; a seeded bootstrap; the Marion diffuse
IAM integrated numerically.
