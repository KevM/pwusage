# Solar Health: learn each site's baseline instead of assuming 85%

Status: draft for approval (2026-11-13). Follows the
[degradation backtest](../../plans/2026-11-13-solar-degradation-backtest-results.md) and the
[Solar Health design](./2026-11-11-solar-health-design.md).

## Why

The owner's new 10 kW system shows a health score of 109%, sliding to 106%. The math is correct, but
the yardstick is wrong. The score is clear-day output over *nameplate × 85%*, and 85% is a
year-round loss allowance: heat, dirt, wiring and inefficiency on cloudy days. Solar Health scores only the
clearest days, often cool ones, where a healthy array loses much less. The owner's array turned about
94% of nameplate into power when new. "109% healthy" and "implied capacity 10.9 kW" on a 10 kW
system read as a bug, so the user stops trusting the screen.

What the owner wants from the screen, in their words: *is my system working as desired, and is
there any intervention I can take to improve things.* Their proposal is to learn the loss figure
from the site's own history: what the new system produced on clear days after it was switched on.

The backtest supports this for the owner's site. A site factor fitted on the first year cut held-out
clear-day error from 8.0% to 5.1% with no material seasonal bias, against rules set before scoring.

## Goals

- A brand-new healthy system reads **100%**, and the score answers "is it still doing what it did
  when new?"
- One plain line says how well the system turned its rating into power when new, compared with a
  healthy range. That keeps the panel-size check.
- The score shows **from the first clear weeks** as a provisional figure and refines as the seasons
  fill in. It never waits a year.
- What to do comes from findings (soiling, shade, step faults, aging per face), as now.

## Non-goals

- No change to the aging trend estimator or its new matched-pair confidence rule. It works on
  year-over-year ratios, which do not depend on the baseline.
- No change to sites without entered panels (detected-only references keep today's "best year =
  100%" scaling).
- No change to the Smart Shift forecast. It already uses fitted capacity.
- No server or sync changes. Everything is derived on the phone from data it already has.

## Anti-goals

- A healthy new system reading above 100% of an assumed standard. That is the problem being fixed.
- Hiding a system that was poor from day one. Self-calibration must not erase the panel-size check.
- A score that swings with the seasons while it is provisional, enough to read as a fault.

## Approaches considered

1. **Show "% of nameplate" with a healthy range.** Honest physics, rarely above 100%. Rejected by
   the owner: it still compares the array with an assumed standard, not with itself.
2. **Raise the assumed clear-day loss to about 7%.** Rejected: still a standard number, and tuned on
   one site.
3. **Learn the baseline from the site's own first year (chosen).** 100% means "as new". The learned
   loss is shown against a healthy range, so a system that was poor from the start is still flagged.
   The owner picked a provisional score that refines as seasons fill in, over waiting a full year.

## Design

### Terms

- **Clear-day factor:** today's fitted capacity factor against the entered-panel reference
  (`SolarHealthCapacity.site`, nameplate × 85% model). Unchanged.
- **Baseline window:** the first 12 months of production under the current entered layout. It
  starts at the first month with a monthly factor, or at the latest system install date when one is
  entered (a new system starts a new baseline).
- **Baseline:** one factor per calendar month, plus a site-wide baseline factor (the
  clear-day-weighted mean of the months inside the baseline window). A calendar month's baseline is
  its **first** monthly factor on or after the window start, even if that falls after the window.
  Snowy or cloudy months (Dec–Jan at the owner's site) often lack a factor in year one, and this
  lets them get one later instead of falling back to a summer-biased site-wide figure. The extra
  year of aging in such a month is about 1%, which is accepted. *(Builder call.)*
- **Rated efficiency when new:** baseline factor × 0.85, the share of nameplate the array delivered
  on clear days when new. For the owner: about 94%.

### Health score: today versus new

- Score = the latest 12 months against the baseline, month by month. For each calendar month, take
  its most recent factor that is *later* than that month's baseline, compute `current / baseline`,
  then take the clear-day-weighted mean. Comparing like months with like keeps summer heat from
  reading as a fault. A month observed only once (its baseline) is left out instead of comparing it
  with itself. *(Builder call.)*
- When no month has a later observation yet (year one), the score is 100% by definition. The
  screen says the baseline is still being learned (see Provisional).
- Per-direction rows show each face against its own per-month baseline, where the fit separates the
  faces. Months where it does not are skipped for that face. For the owner, the west face's decline
  shows up here.
- No cap. A year that beats the first one reads above 100% (for example "102% of new" after a cool
  year or a rain-wash), because that is true. The owner chose this over clamping. The anti-goal is
  about a new system reading above an assumed standard, not about honest gains against itself.
- Colour: the score turns to the emphasis colour when it drops below 100% minus the band (92%).
  Today's rule is factor < 0.85. *(Builder call.)*

### Provisional, then refined

- While the baseline window is open, or covers fewer than three seasons with a monthly factor,
  the baseline is **provisional**.
- Provisional rated efficiency uses the clear days so far. To damp the season bias, each available
  month is weighted equally (not by clear days), so one long summer does not dominate.
- The UI marks it: "Learning your system · 2 of 4 seasons · 31 clear days." No colour warnings
  while provisional.
- When the window closes with at least three seasons, the baseline is frozen. It is recomputed only
  if the entered layout or location changes. That is the same trigger that already recomputes the
  health pass, because the reference key changes.

### Panel-size check (kept)

- The healthy range for rated efficiency when new is **82–98%** of nameplate on clear days. The
  bounds are a builder call from typical loss budgets (inverter 2–4%, wiring 1–2%, clear-day
  temperature 2–8%, soiling and mismatch 1–4%), not measured across sites. Keep them as named
  constants.
- **Below the range:** the existing low-output finding, reworded to "Output below what panels of
  this size usually make". Today's threshold, factor < 0.85 (72% of nameplate), becomes efficiency
  < 82%. That is slightly stricter, on purpose: a new system at 75% of its rating is worth a look.
  On a frozen baseline it is raised at its current confidence. While provisional, it is raised as
  *initial* only when efficiency is below 75% with at least 10 clear days, so a clearly poor new
  system is not hidden for a year. *(Builder call.)*
- **Above the range:** no fault finding. An input prompt instead: "Your system makes more than its
  entered rating allows. Check the panel count and wattage." The owner's 15-vs-14-panel slip would
  have triggered it.

### Expected energy

- "Potential vs actual" changes from "a healthy system like yours should make X kWh" to "As new,
  your system made about X kWh on a clear day like this." X is the reference × the baseline factor
  for that month (or the site-wide baseline). Same row, same day, more honest comparison.

### Screen (Panel Health section)

```
Panel Health
  Health                   98% of new   (±8%)
  When new                 94% of its 10.0 kW rating · healthy range 82–98%
  East (100°)              100% of new
  West (280°)              96% of new
  Capacity & Ratio Trend  ›
```

Provisional:

```
Panel Health
  Health                   Learning your system
                           2 of 4 seasons · 31 clear days
  When new (so far)        93% of its 10.0 kW rating · healthy range 82–98%
```

"Implied capacity" is removed; "When new" carries that information without implying a bigger
array. The ±8% band stays. Copy follows `docs/voice-and-terms.md`.

### Trend view

The yearly and monthly capacity entries in Capacity & Ratio Trend switch to "% of new" (divided by
the baseline factor), so the chart starts near 100% and slopes with the decline. The chart's y-axis
label becomes "% of new".

### House view

`SolarSystemHouseHealth` fades each roof face by its raw fitted factor, clamped to 1.0. A system
above 100% therefore never fades, and the owner's decline is invisible there. Switch the opacity
input to the face's "% of new" for the selected year, so the house shows the same story as the
score. Detected-only sites keep their current input, which is already best-year-relative.

### Edge cases (builder calls, from the design review)

- **History that does not reach back to install.** The window starts at the later of the latest
  entered install date and the first month with a factor. When that first month is more than 13
  months after install (an older system whose early history is not loaded), "new" is a misnomer.
  The rows then read "% of 2022" and "In 2022: 91% of its rating" for the first year with data. The
  same healthy range is kept, with a note that older panels sit lower. Loading more history moves
  the window earlier and the score updates; that is expected, because it is a better "new".
  "Frozen" means the baseline is deterministic from the stored history. Nothing new is persisted.
- **Adding a system restarts the baseline for the whole site.** One production series cannot
  separate the old array's aging from the new one's. The screen notes "Baseline restarted when the
  2024 system was added". The aging trend still covers the full history.
- **Trend view divides by the site-wide baseline**, which keeps the seasonal shape. Dividing each
  month by its own baseline would flatten year one. Months before the window start are shown,
  greyed.
- **House view** fades a face by its yearly direction factor over that face's site-wide baseline.
  Years before the window start show no fade.
- **The above-range prompt** appears only on a frozen baseline, so a cool spring start does not
  trip it. It is a row in Panel Health with a button wired to the existing edit-layout action, not a
  finding kind.

## Where it lives (for the builder)

- `SolarHealthClassifier`: build the baseline and score from `SolarHealthResult.years` (months
  with year and month already exist). This is pure computation with no new cache, because cached
  years already hold the monthly factors.
- `SolarHealthReport.HealthScore`: replace `factor`/`impliedKw` with score-vs-new, rated efficiency,
  provisional state (seasons covered, clear days) and per-direction score-vs-new. The baseline
  (per-month and site-wide, per direction) should be exposed on the report, so the trend view and
  `SolarSystemHouseHealth` can divide by it without recomputing.
- `SolarHealthSection` / `SolarHealthTrendView`: the rows and labels above.
- Low-output finding: new threshold on rated efficiency, only on a frozen baseline; new
  above-range input prompt.
- Detected-only references: untouched.

## Testing

- Synthetic sites through `SolarHealthPass` (the `SyntheticSolarSite` fixture): a healthy site
  reads 100% in year one and stays within ±1% when stable. A −1.5%/yr site reads about 97% after two
  years. A site at 70% of rating raises low-output once frozen. A wrongly entered panel count
  (+10%) raises the check-your-panels prompt.
- Provisional: a site with only summer months reports provisional, seasons covered and clear days,
  with no warnings.
- Install-date step: a system added later starts a new baseline window.
- The backtest harness reports rated efficiency and score-vs-new for the owner's site as a manual
  check.

## Left to the builder

- Exact weighting details beyond those stated, and the rounding of displayed figures.
- Whether "When new" shows one decimal.
- Final copy, within `docs/voice-and-terms.md`.
