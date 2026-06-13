// roi-service.ts
import type { EnergyRollupRow } from '../db';

const WH_PER_KWH = 1000;

export interface RoiInputs {
    fixedBuyRate: number;
    fixedSellRate: number;
}

export interface MatrixTotals {
    A: number; B: number; C: number; D: number; E: number; F: number;
    solarValue: number;        // A − C
    batteryValue: number;      // C − F
    totalSaved: number;        // A − F
    batteryHardwareValue: number; // C − E
    touPlanValue: number;         // E − F
}

/** Sum the six scenario-matrix bills across rollup rows. Costs in dollars. */
export function computeMatrixTotals(rows: EnergyRollupRow[], inputs: RoiInputs): MatrixTotals {
    let A = 0, B = 0, C = 0, D = 0, E = 0, F = 0;
    for (const r of rows) {
        const load = Number(r.load_wh) / WH_PER_KWH;
        const soImp = Number(r.solar_only_import_wh) / WH_PER_KWH;
        const soExp = Number(r.solar_only_export_wh) / WH_PER_KWH;
        const actImp = (Number(r.grid_to_home_wh) + Number(r.grid_to_battery_wh)) / WH_PER_KWH;
        const actExp = (Number(r.solar_to_grid_wh) + Number(r.battery_to_grid_wh)) / WH_PER_KWH;
        const buy = Number(r.buy_rate);
        const sell = Number(r.sell_rate);

        A += load * inputs.fixedBuyRate;
        B += load * buy;
        C += soImp * inputs.fixedBuyRate - soExp * inputs.fixedSellRate;
        D += soImp * buy - soExp * sell;
        E += actImp * inputs.fixedBuyRate - actExp * inputs.fixedSellRate;
        F += actImp * buy - actExp * sell;
    }
    return {
        A, B, C, D, E, F,
        solarValue: A - C,
        batteryValue: C - F,
        totalSaved: A - F,
        batteryHardwareValue: C - E,
        touPlanValue: E - F,
    };
}

export interface RoiConfigInputs { solarCost: number | null; batteryCost: number | null; }

export interface RoiComponent {
    kind: 'solar' | 'battery' | 'combined';
    cost: number;
    savedToDate: number;
    pctRecovered: number;
    annualRate: number;
    breakEvenDate: string | null; // ISO date, null if rate <= 0
}

export interface RoiRecommendation { switchTo: 'fixed'; annualSaving: number; }

export interface RoiSummary {
    matrix: MatrixTotals;
    daysOfData: number;
    lowConfidence: boolean;
    actualPlan: 'fixed' | 'tou';
    components: RoiComponent[];
    recommendation: RoiRecommendation | null;
}

function daysBetween(firstDate: string, today: Date): number {
    const first = new Date(`${firstDate}T00:00:00Z`).getTime();
    return Math.max(1, Math.round((today.getTime() - first) / 86_400_000) + 1);
}

function component(kind: RoiComponent['kind'], cost: number, savedToDate: number, days: number): RoiComponent {
    const annualRate = (savedToDate / days) * 365;
    const remaining = cost - savedToDate;
    let breakEvenDate: string | null = null;
    if (annualRate > 0 && remaining > 0) {
        const days2 = (remaining / annualRate) * 365;
        breakEvenDate = new Date(Date.now() + days2 * 86_400_000).toISOString().slice(0, 10);
    } else if (annualRate > 0) {
        breakEvenDate = new Date().toISOString().slice(0, 10); // already recovered
    }
    return { kind, cost, savedToDate, pctRecovered: cost > 0 ? savedToDate / cost : 0, annualRate, breakEvenDate };
}

export function buildRoiSummary(
    rows: EnergyRollupRow[],
    inputs: RoiInputs,
    config: RoiConfigInputs,
    actualPlan: 'fixed' | 'tou',
    today: Date,
): RoiSummary {
    const matrix = computeMatrixTotals(rows, inputs);
    const firstDate = rows.length ? rows.reduce((m, r) => (r.local_date < m ? r.local_date : m), rows[0].local_date) : today.toISOString().slice(0, 10);
    const days = daysBetween(firstDate, today);

    const components: RoiComponent[] = [];
    if (config.solarCost != null) components.push(component('solar', config.solarCost, matrix.solarValue, days));
    if (config.batteryCost != null) components.push(component('battery', config.batteryCost, matrix.batteryValue, days));
    if (config.solarCost != null && config.batteryCost != null) {
        components.push(component('combined', config.solarCost + config.batteryCost, matrix.totalSaved, days));
    }

    // Plan recommendation: only the TOU→flat direction (robust; cell E overstates flat cost).
    let recommendation: RoiRecommendation | null = null;
    if (actualPlan === 'tou' && matrix.E < matrix.F) {
        const annualSaving = ((matrix.F - matrix.E) / days) * 365;
        recommendation = { switchTo: 'fixed', annualSaving };
    }

    return { matrix, daysOfData: days, lowConfidence: days < 365, actualPlan, components, recommendation };
}

export interface MonthPoint { month: string; cumulativeSaved: number; }

/** Cumulative totalSaved bucketed by 'YYYY-MM', ascending. */
export function monthlyCumulative(rows: EnergyRollupRow[], inputs: RoiInputs): MonthPoint[] {
    const byMonth = new Map<string, EnergyRollupRow[]>();
    for (const r of rows) {
        const m = r.local_date.slice(0, 7);
        (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(r);
    }
    const months = [...byMonth.keys()].sort();
    let cum = 0;
    return months.map(month => {
        cum += computeMatrixTotals(byMonth.get(month)!, inputs).totalSaved;
        return { month, cumulativeSaved: cum };
    });
}
