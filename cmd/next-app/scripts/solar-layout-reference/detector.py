"""Solar array layout detector.

Infers the plane layout (azimuth, tilt, effective size) of a PV system from its
measured 5-minute production history alone, plus an approximate location.

Model
-----
    P_ac(t) = min( sum_i k_i * POA_eff_i(t) / 1000 , P_clip )

POA_eff_i is the clear-sky (Ineichen, climatological Linke turbidity) plane-of-
array irradiance (Hay-Davies transposition) with AOI losses (physical IAM for
beam, Marion-integrated IAM for diffuse). k_i is the "effective size": kW of AC
output per 1000 W/m^2 of POA, all losses lumped in (temperature, inverter,
wiring, soiling, turbidity error of the clear-sky model).

Pipeline
--------
1. Load + regularise to a 5-min grid, subtract a night baseline.
2. Detect an AC clipping plateau.
3. Model-free clear-sky interval selection (near a rolling upper envelope and
   locally smooth), then model-based re-selection after a first fit.
4. Exhaustive grid search over orientations for 1/2/3 planes via a Gram-matrix
   trick (k solved linearly), then continuous refinement with clipping as a
   censoring nonlinearity.
5. Shading: horizon-profile mask by sun azimuth/elevation learnt from residuals
   (monotone in elevation per azimuth bin), excluded from the fit; iterate.
6. Model selection by day-blocked cross-validated nRMSE with parsimony rules;
   day-bootstrap and near-equivalent-fit ranges for identifiability.
"""

from __future__ import annotations

import json
import warnings
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import pvlib
from scipy.optimize import least_squares

warnings.filterwarnings("ignore", category=RuntimeWarning)

STEP = pd.Timedelta("5min")
ALBEDO = 0.2
# Loss assumption converting effective AC size (at 1000 W/m^2 POA) to DC nameplate.
# Typical clear-sky operating chain: temperature ~-7..-10 %, inverter ~-3 %,
# wiring/mismatch/soiling ~-3..-5 % => ~0.85 (range 0.80-0.90).
DERATE = 0.85
DERATE_RANGE = (0.80, 0.90)

GRID_AZ = np.arange(0, 360, 10.0)
GRID_TILT = np.arange(0, 55, 5.0)
MAX_TILT = 50.0
# Irradiance-dependent cell heating: Tcell - Tamb ~ 27 C per 1000 W/m^2 (roof mount),
# gamma ~ -0.37 %/C  =>  relative output factor (1 - TEMP_C * POA/1000). Without this the
# flattened midday peak is mis-explained by spurious steep E/W/N "planes".
TEMP_C = 0.10
GAMMA = -0.0037
AMB_SEASON = 8.0
AMB_DIURNAL = 4.0


# --------------------------------------------------------------------------- data


def load_series(path: str) -> pd.Series:
    df = pd.read_parquet(path)
    ts = pd.to_datetime(df["timestamp"], utc=True)
    s = pd.Series(df["solar_wh"].to_numpy(float) * 12 / 1000.0, index=ts).sort_index()
    s = s[~s.index.duplicated()]
    full = pd.date_range(s.index[0], s.index[-1], freq=STEP, tz="UTC")
    return s.reindex(full)


def geometry(index: pd.DatetimeIndex, lat: float, lon: float) -> pd.DataFrame:
    """Sun position and clear-sky irradiance at the midpoint of each interval."""
    mid = index + STEP / 2
    loc = pvlib.location.Location(lat, lon, altitude=_altitude(lat, lon))
    sp = loc.get_solarposition(mid)
    cs = loc.get_clearsky(mid, model="ineichen", solar_position=sp)
    out = pd.DataFrame(
        {
            "zenith": sp["apparent_zenith"].to_numpy(),
            "azimuth": sp["azimuth"].to_numpy(),
            "elevation": sp["apparent_elevation"].to_numpy(),
            "ghi": cs["ghi"].to_numpy(),
            "dni": cs["dni"].to_numpy(),
            "dhi": cs["dhi"].to_numpy(),
            "dni_extra": pvlib.irradiance.get_extra_radiation(mid).to_numpy(),
            "tfac": ambient_factor(mid, lon),
        },
        index=index,
    )
    return out


def ambient_factor(mid: pd.DatetimeIndex, lon: float) -> np.ndarray:
    """Relative efficiency from a generic ambient-temperature prior (no weather data):
    seasonal swing ±AMB_SEASON C peaking ~Jul 19, diurnal ±AMB_DIURNAL C peaking 15h solar.
    Absolute level is absorbed into k. Fitting this instead would be degenerate with tilt."""
    doy = mid.dayofyear.to_numpy()
    solar_h = (mid.hour.to_numpy() + mid.minute.to_numpy() / 60 + lon / 15.0) % 24
    dT = AMB_SEASON * np.cos(2 * np.pi * (doy - 200) / 365.0) + AMB_DIURNAL * np.cos(2 * np.pi * (solar_h - 15) / 24.0)
    return 1 + GAMMA * dT


def _altitude(lat, lon):
    try:
        return float(pvlib.location.lookup_altitude(lat, lon))
    except Exception:
        return 0.0


def poa_eff(g: pd.DataFrame | dict, az: float, tilt: float) -> np.ndarray:
    """Effective (post-IAM) POA irradiance in W/m^2 for one plane."""
    tilt = float(np.clip(tilt, 0.0, 89.0))
    zen, saz = np.asarray(g["zenith"]), np.asarray(g["azimuth"])
    aoi = pvlib.irradiance.aoi(tilt, az, zen, saz)
    irr = pvlib.irradiance.get_total_irradiance(
        tilt, az, zen, saz, np.asarray(g["dni"]), np.asarray(g["ghi"]), np.asarray(g["dhi"]),
        dni_extra=np.asarray(g["dni_extra"]), model="haydavies", albedo=ALBEDO,
    )
    iam_b = pvlib.iam.physical(aoi)
    dif = _diffuse_iam(tilt)
    eff = (
        np.nan_to_num(irr["poa_direct"]) * iam_b
        + np.nan_to_num(irr["poa_sky_diffuse"]) * dif["sky"]
        + np.nan_to_num(irr["poa_ground_diffuse"]) * dif["ground"]
    )
    eff = np.clip(np.asarray(eff, float), 0, None)
    eff = eff * (1 - TEMP_C * eff / 1000.0) / (1 - TEMP_C)
    if "tfac" in g:
        eff = eff * np.asarray(g["tfac"])
    return eff


_DIF_CACHE: dict = {}


def _diffuse_iam(tilt):
    key = round(tilt, 1)
    if key not in _DIF_CACHE:
        _DIF_CACHE[key] = pvlib.iam.marion_diffuse("physical", key)
    return _DIF_CACHE[key]


# --------------------------------------------------------------------------- clipping


def detect_clip(p: pd.Series, elev: np.ndarray) -> dict | None:
    """Look for a plateau: many daylight intervals sitting at (nearly) the same max value,
    in runs of >= 3 consecutive intervals on several distinct days."""
    v = p.to_numpy()
    day = (elev > 10) & np.isfinite(v)
    vals = v[day]
    if vals.size < 500:
        return None
    hi = np.nanquantile(vals, 0.9999)
    cand = np.sort(np.unique(np.round(vals[vals > 0.85 * hi], 3)))[::-1]
    best = None
    for c in cand[:60]:
        near = day & (np.abs(v - c) <= max(0.004 * c, 0.013))
        n = int(near.sum())
        if n < 30:
            continue
        # runs of >= 3 consecutive
        r = pd.Series(near.astype(int), index=p.index)
        grp = (r != r.shift()).cumsum()
        runlen = r.groupby(grp).transform("size")
        inrun = near & (runlen.to_numpy() >= 3)
        days = pd.Index(p.index[inrun].date).nunique()
        frac = n / vals.size
        above = int((vals > c * 1.015 + 0.013).sum())
        if days >= 5 and frac > 0.003 and above < 0.05 * n:
            if best is None or n > best["n"]:
                best = {"limit_kw": float(c), "n": n, "days": int(days), "frac_daylight": round(frac, 4)}
    if best is None:
        return None
    # refine: median of values in plateau band
    band = day & (np.abs(v - best["limit_kw"]) <= max(0.004 * best["limit_kw"], 0.013))
    best["limit_kw"] = round(float(np.median(v[band])), 3)
    best["max_observed_kw"] = round(float(np.nanmax(vals)), 3)
    return best


# --------------------------------------------------------------------------- clear-sky selection


def smoothness(p: pd.Series, scale: float) -> np.ndarray:
    d2 = (p.shift(1) - 2 * p + p.shift(-1)).abs() / scale
    return d2.rolling(7, center=True, min_periods=5).max().to_numpy()


def envelope_clear(p: pd.Series, elev: np.ndarray, peak: float, ghi: np.ndarray) -> np.ndarray:
    """Model-free clear mask: output normalised by clear-sky GHI (removes the
    seasonal drift at a fixed UTC slot) within a band of its rolling (±7 day) upper
    envelope at the same slot, and locally smooth."""
    x = p.to_numpy() / np.maximum(ghi, 30.0)
    df = pd.DataFrame({"p": np.where(elev > 2, x, np.nan)}, index=p.index)
    df["day"] = df.index.floor("D")
    df["slot"] = (df.index.hour * 60 + df.index.minute) // 5
    piv = df.pivot_table(index="day", columns="slot", values="p", aggfunc="first")
    env = piv.rolling(15, center=True, min_periods=4).quantile(0.85)
    env = env.T.rolling(3, center=True, min_periods=1).mean().T
    e = env.stack().rename("env")
    df = df.join(e, on=["day", "slot"])
    ratio = df["p"] / df["env"]
    sm = smoothness(p, peak)
    ok = (elev > 5) & (ratio > 0.92).to_numpy() & (ratio < 1.06).to_numpy() & (sm < 0.03)
    ok &= (df["env"] * np.maximum(ghi, 30.0) > 0.03 * peak).to_numpy()
    return ok


def flat_runs(p: np.ndarray, model: np.ndarray, clip: float | None) -> np.ndarray:
    """Flag curtailment-like flat runs: measured constant while the model moves."""
    dp = np.abs(np.diff(p, prepend=np.nan))
    dm = np.abs(np.diff(model, prepend=np.nan))
    # curtailment holds output *below* what the sun allows, so only flag p < model
    flat = (dp < 0.004 * np.nanmax(p)) & (dm > 0.01 * np.nanmax(model)) & (p > 0.1 * np.nanmax(p)) & (p < 0.97 * model)
    if clip:
        flat &= p < 0.98 * clip
    f = pd.Series(flat)
    return (f.rolling(5, center=True, min_periods=1).sum() >= 3).to_numpy()


# --------------------------------------------------------------------------- shading


@dataclass
class ShadeMask:
    az_edges: np.ndarray
    horizon: np.ndarray  # per az bin: shaded at/below this elevation (deg); -inf = none
    hot_bins: list = field(default_factory=list)  # (az_lo, el_lo) isolated strong-deficit bins

    def shaded(self, saz, sel):
        i = np.clip(np.digitize(saz, self.az_edges) - 1, 0, len(self.horizon) - 1)
        s = sel <= self.horizon[i]
        for a0, e0 in self.hot_bins:
            s |= (saz >= a0) & (saz < a0 + 10) & (sel >= e0) & (sel < e0 + 5)
        return s

    def summary(self):
        segs = []
        for a0, h in zip(self.az_edges[:-1], self.horizon):
            if np.isfinite(h):
                segs.append({"sun_az": [float(a0), float(a0 + 10)], "shaded_below_elev": float(h)})
        return {"horizon_profile": _merge_segments(segs),
                "isolated_bins": [{"sun_az": [a, a + 10], "sun_elev": [e, e + 5]} for a, e in self.hot_bins]}


def _merge_segments(segs):
    out = []
    for s in segs:
        if out and out[-1]["sun_az"][1] == s["sun_az"][0] and abs(out[-1]["shaded_below_elev"] - s["shaded_below_elev"]) <= 5:
            out[-1]["sun_az"][1] = s["sun_az"][1]
            out[-1]["shaded_below_elev"] = max(out[-1]["shaded_below_elev"], s["shaded_below_elev"])
        else:
            out.append(dict(s))
    return out


def learn_shade(saz, sel, ratio, day_ids, thr=0.85) -> ShadeMask:
    """Horizon profile: for each 10-deg sun-azimuth bin, the lowest elevation above
    which the median measured/model ratio is >= thr in every populated 2.5-deg bin."""
    az_edges = np.arange(0, 370, 10.0)
    el_edges = np.arange(0, 92.5, 2.5)
    horizon = np.full(len(az_edges) - 1, -np.inf)
    hot = []
    for i in range(len(az_edges) - 1):
        m = (saz >= az_edges[i]) & (saz < az_edges[i + 1]) & np.isfinite(ratio)
        if m.sum() < 20:
            continue
        meds = []
        for j in range(len(el_edges) - 1):
            mm = m & (sel >= el_edges[j]) & (sel < el_edges[j + 1]) & np.isfinite(ratio)
            if mm.sum() >= 8 and len(np.unique(day_ids[mm])) >= 3:
                meds.append((el_edges[j + 1], np.quantile(ratio[mm], 0.8)))
        # scan from top down: horizon = top edge of highest-elev shaded bin that has only
        # shaded/unpopulated bins below it in a contiguous block from the bottom
        h = -np.inf
        for top, med in meds:  # ascending elevation
            if med < thr:
                h = top
            else:
                break
        if h > 45:  # implausible as a horizon -> probably misfit, cap
            h = 45.0
        horizon[i] = h
    # isolated strong-deficit bins above the horizon (chimney / vent / pole)
    for i in range(len(az_edges) - 1):
        for e0 in np.arange(0, 90, 5.0):
            m = (saz >= az_edges[i]) & (saz < az_edges[i] + 10) & (sel >= e0) & (sel < e0 + 5) & (sel > horizon[i]) & np.isfinite(ratio)
            if m.sum() >= 12 and len(np.unique(day_ids[m])) >= 4 and np.quantile(ratio[m], 0.8) < 0.75:
                hot.append((float(az_edges[i]), float(e0)))
    return ShadeMask(az_edges, horizon, hot)


# --------------------------------------------------------------------------- fitting


def build_grid(g: pd.DataFrame):
    combos = [(a, t) for t in GRID_TILT for a in (GRID_AZ if t > 0 else [180.0])]
    A = np.column_stack([poa_eff(g, a, t) / 1000.0 for a, t in combos])
    return np.array(combos), A


def grid_search(A, y, combos, nplanes, top=20):
    """Return list of (sse, idx tuple, k vector) best candidates for n planes."""
    G = A.T @ A
    b = A.T @ y
    yy = float(y @ y)
    d = np.diag(G)
    k1 = np.where(d > 0, b / d, 0)
    k1 = np.clip(k1, 0, None)
    sse1 = yy - 2 * k1 * b + k1 ** 2 * d
    if nplanes == 1:
        o = np.argsort(sse1)[:top]
        return [(sse1[i], (i,), np.array([k1[i]])) for i in o]
    n = len(b)
    I, J = np.triu_indices(n, 1)
    Gii, Gjj, Gij = d[I], d[J], G[I, J]
    det = Gii * Gjj - Gij ** 2
    with np.errstate(divide="ignore", invalid="ignore"):
        ki = (Gjj * b[I] - Gij * b[J]) / det
        kj = (Gii * b[J] - Gij * b[I]) / det
    sse2 = yy - 2 * (ki * b[I] + kj * b[J]) + ki ** 2 * Gii + 2 * ki * kj * Gij + kj ** 2 * Gjj
    bad = (ki < 0) | (kj < 0) | ~np.isfinite(sse2) | (det < 1e-9 * Gii * Gjj)
    sse2 = np.where(bad, np.inf, sse2)
    if nplanes == 2:
        o = np.argsort(sse2)[:top]
        return [(sse2[q], (I[q], J[q]), np.array([ki[q], kj[q]])) for q in o if np.isfinite(sse2[q])]
    # 3 planes: extend the best pairs greedily with every third column
    o = np.argsort(sse2)[:60]
    res = []
    for q in o:
        if not np.isfinite(sse2[q]):
            continue
        i, j = I[q], J[q]
        ls = np.array([l for l in range(n) if l != i and l != j])
        idx = np.stack([np.full_like(ls, i), np.full_like(ls, j), ls], 1)
        Gs = G[idx[:, :, None], idx[:, None, :]]
        bs = b[idx]
        try:
            ks = np.linalg.solve(Gs + 1e-12 * np.eye(3), bs[..., None])[..., 0]
        except np.linalg.LinAlgError:
            continue
        sse = yy - 2 * (ks * bs).sum(1) + np.einsum("ni,nij,nj->n", ks, Gs, ks)
        sse = np.where((ks < 0).any(1), np.inf, sse)
        l = np.argmin(sse)
        if np.isfinite(sse[l]):
            res.append((sse[l], tuple(sorted(idx[l])), ks[l]))
    res.sort(key=lambda r: r[0])
    uniq, seen = [], set()
    for r in res:
        if r[1] not in seen:
            seen.add(r[1])
            uniq.append(r)
    return uniq[:top]


def model_power(params, g, clip):
    n = len(params) // 3
    tot = np.zeros(len(g["zenith"]))
    for i in range(n):
        az, tilt, k = params[3 * i : 3 * i + 3]
        tot += k * poa_eff(g, az % 360, tilt) / 1000.0
    if clip:
        tot = clip * _softmin(tot / clip)
    return tot


def _softmin(x, s=0.01):
    # smooth min(x, 1) for differentiability
    return x - s * np.logaddexp(0, (x - 1) / s)


def refine(params0, g, y, clip, max_nfev=200):
    n = len(params0) // 3
    lb, ub = [], []
    for i in range(n):
        lb += [-720, 0, 0]
        ub += [720, MAX_TILT, 50]
    p0 = np.array(params0, float)
    p0[1::3] = np.clip(p0[1::3], 0.5, MAX_TILT - 0.5)
    scale = max(np.nanmax(y), 1e-3)

    def f(p):
        return (model_power(p, g, clip) - y) / scale

    r = least_squares(f, p0, bounds=(lb, ub), loss="soft_l1", f_scale=0.08, max_nfev=max_nfev, x_scale=[30, 10, 1] * n)
    p = r.x.copy()
    p[0::3] %= 360
    return p


def gsub(g, mask):
    return {c: np.asarray(g[c])[mask] for c in ["zenith", "azimuth", "dni", "ghi", "dhi", "dni_extra", "tfac"]}


def fit_n(g, y, clip, nplanes, A=None, combos=None, n_starts=3):
    """Grid search + continuous refinement. Returns (params, rmse, grid_candidates)."""
    fitmask = np.ones(len(y), bool) if not clip else (y < 0.97 * clip)
    cands = grid_search(A[fitmask], y[fitmask], combos, nplanes)
    best = None
    for sse, idx, k in cands[:n_starts]:
        p0 = []
        for ii, kk in zip(idx, k):
            p0 += [combos[ii][0], combos[ii][1], kk]
        p = refine(p0, g, y, clip)
        rm = rmse(model_power(p, g, clip), y)
        if best is None or rm < best[1]:
            best = (p, rm)
    return best[0], best[1], cands


def rmse(a, b):
    return float(np.sqrt(np.mean((a - b) ** 2)))


# --------------------------------------------------------------------------- driver


def detect(path: str, tz: str, lat: float, lon: float, n_boot: int = 40, seed: int = 0, internals: dict | None = None) -> dict:
    rng = np.random.default_rng(seed)
    p = load_series(path)
    geo = geometry(p.index, lat, lon)
    elev = geo["elevation"].to_numpy()
    night = (elev < -6) & np.isfinite(p.to_numpy())
    base = float(np.nanmedian(p.to_numpy()[night])) if night.any() else 0.0
    base = max(base, 0.0)
    p = (p - base).clip(lower=0)
    peak = float(np.nanquantile(p[elev > 10], 0.999))

    clip_info = detect_clip(p, elev)
    clip = clip_info["limit_kw"] if clip_info else None

    v = p.to_numpy()
    day_id = p.index.tz_convert(tz).normalize().tz_localize(None).to_numpy()
    clear0 = envelope_clear(p, elev, peak, geo["ghi"].to_numpy()) & np.isfinite(v)
    if clip:
        # envelope band test is unreliable on the plateau; accept smooth clipped points
        sm = smoothness(p, peak)
        clear0 |= (np.abs(v - clip) < 0.01 * clip) & (sm < 0.03) & (elev > 5)

    # restrict heavy computation to daylight candidate rows
    cand_rows = np.where((elev > 3) & np.isfinite(v))[0]
    gC = geo.iloc[cand_rows]
    vC = v[cand_rows]
    dC = day_id[cand_rows]
    clearC = clear0[cand_rows]
    combos, Afull = build_grid(gC)

    # ---- selection is model-free (envelope + smoothness); the model is only used to
    # (a) learn a persistent-deficit shading mask, (b) drop gross outliers (snow,
    # curtailment plateaus). A tight model-ratio band would bias the selection
    # towards the working model and hide real extra planes.
    saz, sel_el = gC["azimuth"].to_numpy(), gC["elevation"].to_numpy()
    sel = clearC.copy()
    pars, _, _ = fit_n(gsub(gC, sel), vC[sel], clip, 2, Afull[sel], combos)
    shade = None
    for it in range(2):
        mC = model_power(pars, gC, clip)
        ratio = np.where(mC > 0.02 * peak, vC / mC, np.nan)
        shade = learn_shade(saz, sel_el, np.where(clearC, ratio, np.nan), dC)
        sel = clearC & (np.abs(vC - mC) < 0.15 * peak) & ~flat_runs(vC, mC, clip) & ~shade.shaded(saz, sel_el)
        pars, _, _ = fit_n(gsub(gC, sel), vC[sel], clip, 2, Afull[sel], combos)

    # clear days: >= 60% of elevation>10 rows selected
    e10 = (gC["elevation"].to_numpy() > 10) & ~shade.shaded(saz, sel_el)
    dfc = pd.DataFrame({"d": dC, "s": sel & e10, "e": e10})
    frac = dfc.groupby("d").s.sum() / dfc.groupby("d").e.sum()
    clear_days = frac.index[frac >= 0.6].to_numpy()
    use_days = frac.index[frac >= 0.25].to_numpy()  # partially-clear days contribute intervals
    sel &= np.isin(dC, use_days)

    gS, yS, dS, AS = gsub(gC, sel), vC[sel], dC[sel], Afull[sel]

    # ---- fits for 1/2/3 planes on all selected data
    fits = {}
    for n in (1, 2, 3):
        pr, rm, cands = fit_n(gS, yS, clip, n, AS, combos, n_starts=4 if n > 1 else 3)
        fits[n] = {"params": pr, "rmse": rm, "cands": cands}

    # ---- day-blocked CV
    udays = np.unique(dS)
    folds = rng.permutation(len(udays)) % 5
    cv = {1: [], 2: [], 3: []}
    for f in range(5):
        te = np.isin(dS, udays[folds == f])
        tr = ~te
        if te.sum() < 50:
            continue
        for n in (1, 2, 3):
            pr, _, _ = fit_n(gsub(gS, tr), yS[tr], clip, n, AS[tr], combos, n_starts=2)
            pred = model_power(pr, gsub(gS, te), clip)
            cv[n].append((np.sum((pred - yS[te]) ** 2), te.sum(), yS[te].sum()))
    cv_nrmse = {}
    for n in cv:
        s = np.array(cv[n])
        cv_nrmse[n] = float(np.sqrt(s[:, 0].sum() / s[:, 1].sum()) / (s[:, 2].sum() / s[:, 1].sum()))

    nsel = choose_n(fits, cv_nrmse)
    best = fits[nsel]["params"]

    # ---- bootstrap over days (refine from best)
    boots = []
    for b in range(n_boot):
        bd = rng.choice(udays, len(udays), replace=True)
        cnt = pd.Series(bd).value_counts()
        w = pd.Series(dS).map(cnt).fillna(0).to_numpy().astype(int)
        idx = np.repeat(np.arange(len(yS)), w)
        gb = {c: arr[idx] for c, arr in gS.items()}
        pb = refine(best, gb, yS[idx], clip, max_nfev=80)
        boots.append(align(pb, best))
    boots = np.array(boots)

    # ---- near-equivalent fits from the grid (systematic/degeneracy range)
    near = near_equivalent(fits[nsel]["cands"], combos, best, tol=0.03, yS=yS, AS=AS, clip=clip)

    planes = []
    for i in range(nsel):
        az, tilt, k = best[3 * i : 3 * i + 3]
        bz = boots[:, 3 * i : 3 * i + 3]
        az_b = unwrap_rel(bz[:, 0], az)
        pl = {
            "azimuth_deg": round(float(az % 360), 1),
            "azimuth_ci90": [round(float(np.percentile(az_b, 5) % 360), 1), round(float(np.percentile(az_b, 95) % 360), 1)],
            "tilt_deg": round(float(tilt), 1),
            "tilt_ci90": [round(float(np.percentile(bz[:, 1], 5)), 1), round(float(np.percentile(bz[:, 1], 95)), 1)],
            "effective_kw_at_1000": round(float(k), 2),
            "effective_kw_ci90": [round(float(np.percentile(bz[:, 2], 5)), 2), round(float(np.percentile(bz[:, 2], 95)), 2)],
            "dc_kwp_est": round(float(k / DERATE), 2),
            "dc_kwp_range": [round(float(np.percentile(bz[:, 2], 5) / DERATE_RANGE[1]), 2),
                             round(float(np.percentile(bz[:, 2], 95) / DERATE_RANGE[0]), 2)],
            "near_equivalent_fits": near.get(i),
        }
        pl["poorly_identified"] = flags(pl, k, sum(best[2::3]))
        planes.append(pl)

    if internals is not None:
        internals.update(p=p, geo=geo, rows=cand_rows, sel=sel, gC=gC, vC=vC, dC=dC, best=best, clip=clip, shade=shade, fits=fits)
    total_k = float(sum(best[2::3]))
    bt = boots[:, 2::3].sum(1)
    res = {
        "site_file": path,
        "timezone": tz,
        "location": [lat, lon],
        "date_range": [str(p.index[0].tz_convert(tz).date()), str(p.index[-1].tz_convert(tz).date())],
        "n_days_history": int(pd.Index(day_id).nunique()),
        "n_clear_days": int(len(clear_days)),
        "n_days_contributing": int(len(np.unique(dS))),
        "n_intervals_fit": int(sel.sum()),
        "night_baseline_kw_removed": round(base, 3),
        "chosen_n_planes": nsel,
        "planes": planes,
        "total_effective_kw": round(total_k, 2),
        "total_effective_kw_ci90": [round(float(np.percentile(bt, 5)), 2), round(float(np.percentile(bt, 95)), 2)],
        "total_dc_kwp_est": round(total_k / DERATE, 2),
        "loss_assumption": f"DC = effective/{DERATE} (range {DERATE_RANGE[0]}-{DERATE_RANGE[1]}; temp+inverter+wiring+soiling)",
        "ac_clip": clip_info,
        "shading": shade.summary(),
        "fit_rmse_kw": {n: round(fits[n]["rmse"], 3) for n in fits},
        "cv_nrmse_heldout_days": {n: round(cv_nrmse[n], 4) for n in cv_nrmse},
        "all_fits": {n: describe(fits[n]["params"]) for n in fits},
    }
    return res


def clearC_or_model(clear_env, ratio):
    # accept either the model-free envelope test or near-model agreement
    return clear_env | (np.abs(ratio - 1) < 0.06)


def choose_n(fits, cv):
    n = 1
    for m in (2, 3):
        gain = (cv[n] - cv[m]) / cv[n]
        ks = fits[m]["params"][2::3]
        tilts = fits[m]["params"][1::3]
        artefact = np.any((tilts >= MAX_TILT - 2) & (ks < 0.25 * ks.sum()))
        if gain > 0.08 and ks.min() > 0.08 * ks.sum() and distinct(fits[m]["params"]) and not artefact:
            n = m
        else:
            break
    return n


def distinct(params):
    n = len(params) // 3
    for i in range(n):
        for j in range(i + 1, n):
            a1, t1 = params[3 * i], params[3 * i + 1]
            a2, t2 = params[3 * j], params[3 * j + 1]
            daz = abs((a1 - a2 + 180) % 360 - 180)
            if daz < 25 and abs(t1 - t2) < 10:
                return False
    return True


def align(pb, best):
    """Reorder bootstrap planes to match best (by azimuth/tilt distance)."""
    n = len(best) // 3
    if n == 1:
        return pb
    import itertools

    def d(i, j):
        daz = abs((pb[3 * i] - best[3 * j] + 180) % 360 - 180)
        return daz + 2 * abs(pb[3 * i + 1] - best[3 * j + 1])

    bestperm = min(itertools.permutations(range(n)), key=lambda perm: sum(d(perm[j], j) for j in range(n)))
    return np.concatenate([pb[3 * i : 3 * i + 3] for i in bestperm])


def unwrap_rel(a, ref):
    return ref + (a - ref + 180) % 360 - 180


def near_equivalent(cands, combos, best, tol, yS, AS, clip):
    """Range of grid orientations per plane whose linear-k RMSE is within tol of the best."""
    if not cands:
        return {}
    s0 = cands[0][0]
    ok = [c for c in cands if c[0] <= s0 * (1 + tol) ** 2]
    n = len(best) // 3
    out = {}
    for i in range(n):
        azs, tilts, ks = [], [], []
        for _, idx, k in ok:
            # match candidate plane to best plane i
            j = min(range(len(idx)), key=lambda j: abs((combos[idx[j]][0] - best[3 * i] + 180) % 360 - 180) + 2 * abs(combos[idx[j]][1] - best[3 * i + 1]))
            azs.append(unwrap_rel(combos[idx[j]][0], best[3 * i]))
            tilts.append(combos[idx[j]][1])
            ks.append(k[j])
        out[i] = {
            "n_grid_fits": len(ok),
            "azimuth": [round(float(min(azs)) % 360, 0), round(float(max(azs)) % 360, 0)],
            "tilt": [float(min(tilts)), float(max(tilts))],
            "eff_kw": [round(float(min(ks)), 2), round(float(max(ks)), 2)],
        }
    return out


def flags(pl, k, ktot):
    f = []
    if pl["tilt_deg"] < 8:
        f.append("azimuth (near-flat plane)")
    lo, hi = pl["azimuth_ci90"]
    w = (hi - lo) % 360
    if w > 30:
        f.append("azimuth")
    if pl["tilt_ci90"][1] - pl["tilt_ci90"][0] > 12:
        f.append("tilt")
    e = pl["effective_kw_ci90"]
    if e[1] - e[0] > 0.3 * max(k, 1e-6):
        f.append("size")
    if pl["tilt_deg"] >= MAX_TILT - 2:
        f.append("tilt at search bound (likely absorbing shade/model error)")
    if k < 0.15 * ktot:
        f.append("small plane (may be artefact)")
    ne = pl.get("near_equivalent_fits") or {}
    if ne:
        aw = (ne["azimuth"][1] - ne["azimuth"][0]) % 360
        if aw > 40:
            f.append("azimuth degenerate with other fits")
        if ne["tilt"][1] - ne["tilt"][0] > 20:
            f.append("tilt degenerate with other fits")
    return f


def describe(params):
    n = len(params) // 3
    return [
        {"azimuth": round(float(params[3 * i] % 360), 1), "tilt": round(float(params[3 * i + 1]), 1), "eff_kw": round(float(params[3 * i + 2]), 2)}
        for i in range(n)
    ]


if __name__ == "__main__":
    import argparse
    import os

    ap = argparse.ArgumentParser()
    ap.add_argument("parquet")
    ap.add_argument("--tz", required=True)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--out")
    ap.add_argument("--boot", type=int, default=40)
    a = ap.parse_args()
    r = detect(a.parquet, a.tz, a.lat, a.lon, n_boot=a.boot)
    js = json.dumps(r, indent=2, default=lambda o: o.item() if hasattr(o, "item") else str(o))
    if a.out:
        os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
        with open(a.out, "w") as fh:
            fh.write(js)
    print(js)
