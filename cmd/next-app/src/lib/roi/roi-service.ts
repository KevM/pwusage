// roi-service.ts
import type { EnergyHourlyRow } from '../db';
import type { PlanTimeline } from './plan-timeline';

const WH_PER_KWH = 1000;

/** Retained for resolve-fixed-baseline.ts (the current Fixed baseline as flat scalars). */
export interface RoiInputs {
    fixedBuyRate: number;
    fixedSellRate: number;
}

export interface ColumnBills {
    noSolar: number;       // load priced at this plan
    solar: number;         // solar-only counterfactual priced at this plan
    solarBattery: number;  // actual import/export priced at this plan
}

/** Price the three system configs against ONE plan timeline, summed over hourly rows.
 *  The N-column matrix (Phase D) maps this over many timelines; C1 uses Fixed + Metered. */
export function priceColumn(timeline: PlanTimeline, rows: EnergyHourlyRow[]): ColumnBills {
    let noSolar = 0, solar = 0, solarBattery = 0;
    for (const r of rows) {
        const { buy, sell } = timeline.rateAt(r.local_date, r.hour);
        const load = Number(r.load_wh) / WH_PER_KWH;
        const soImp = Number(r.solar_only_import_wh) / WH_PER_KWH;
        const soExp = Number(r.solar_only_export_wh) / WH_PER_KWH;
        const actImp = (Number(r.grid_to_home_wh) + Number(r.grid_to_battery_wh)) / WH_PER_KWH;
        const actExp = (Number(r.solar_to_grid_wh) + Number(r.battery_to_grid_wh)) / WH_PER_KWH;
        noSolar += load * buy;
        solar += soImp * buy - soExp * sell;
        solarBattery += actImp * buy - actExp * sell;
    }
    return { noSolar, solar, solarBattery };
}

export interface MatrixTotals {
    A: number; B: number; C: number; D: number; E: number; F: number;
    solarValue: number;           // A − C
    batteryValue: number;         // C − F
    totalSaved: number;           // A − F
    batteryHardwareValue: number; // C − E
    touPlanValue: number;         // E − F
}

/** Six scenario-matrix bills: Fixed column → A,C,E; Metered column → B,D,F. Dollars. */
export function computeMatrixTotals(
    rows: EnergyHourlyRow[],
    fixed: PlanTimeline,
    metered: PlanTimeline,
): MatrixTotals {
    const fx = priceColumn(fixed, rows);
    const me = priceColumn(metered, rows);
    const A = fx.noSolar, C = fx.solar, E = fx.solarBattery;
    const B = me.noSolar, D = me.solar, F = me.solarBattery;
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
    rows: EnergyHourlyRow[],
    fixed: PlanTimeline,
    metered: PlanTimeline,
    config: RoiConfigInputs,
    actualPlan: 'fixed' | 'tou',
    today: Date,
): RoiSummary {
    const matrix = computeMatrixTotals(rows, fixed, metered);
    const firstDate = rows.length
        ? rows.reduce((m, r) => (r.local_date < m ? r.local_date : m), rows[0].local_date)
        : today.toISOString().slice(0, 10);
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
export function monthlyCumulative(
    rows: EnergyHourlyRow[],
    fixed: PlanTimeline,
    metered: PlanTimeline,
): MonthPoint[] {
    const byMonth = new Map<string, EnergyHourlyRow[]>();
    for (const r of rows) {
        const m = r.local_date.slice(0, 7);
        (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(r);
    }
    const months = [...byMonth.keys()].sort();
    let cum = 0;
    return months.map(month => {
        cum += computeMatrixTotals(byMonth.get(month)!, fixed, metered).totalSaved;
        return { month, cumulativeSaved: cum };
    });
}
