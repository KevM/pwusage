/**
 * Canonical color tokens for the four energy metrics (solar, grid, battery,
 * load). Every chart, tile, table cell, and badge that talks about an energy
 * metric should pull its color from here — not invent its own.
 *
 * Hex pairs match the NILMChart legend so the live page, NILMChart, and the
 * "Today so far" tiles all read with one visual language. Tailwind classes
 * are provided as the everyday way to apply these in JSX; `hex` is the
 * escape hatch for inline styles and 3rd-party chart libs (e.g. Recharts).
 *
 * To change a metric color, change it here. Don't reach for ad-hoc Tailwind
 * classes at the call site.
 */

export type EnergyMetric = 'solar' | 'grid' | 'battery' | 'load';

export interface EnergyMetricColor {
    /** Hex values for inline styles and chart libs that don't accept classes. */
    hex: { light: string; dark: string };
    /** SVG stroke (use on chart paths and legend line swatches). */
    stroke: string;
    /** Tailwind text color for value labels in the metric's color. */
    text: string;
    /** Tailwind text color for small labels (slightly muted). */
    textMuted: string;
    /** Left-border accent for tiles. */
    borderAccent: string;
    /** Soft tinted background for tiles. */
    tileBg: string;
}

export const energyColors: Record<EnergyMetric, EnergyMetricColor> = {
    solar: {
        hex: { light: '#f59e0b', dark: '#fbbf24' },
        stroke: 'stroke-amber-500 dark:stroke-amber-400',
        text: 'text-amber-700 dark:text-amber-400',
        textMuted: 'text-amber-600 dark:text-amber-400',
        borderAccent: 'border-amber-500',
        tileBg: 'bg-amber-50 dark:bg-slate-800'
    },
    grid: {
        hex: { light: '#6b7280', dark: '#9ca3af' },
        stroke: 'stroke-gray-500 dark:stroke-gray-400',
        text: 'text-gray-700 dark:text-gray-400',
        textMuted: 'text-gray-600 dark:text-gray-400',
        borderAccent: 'border-gray-500',
        tileBg: 'bg-gray-50 dark:bg-slate-800'
    },
    battery: {
        hex: { light: '#10b981', dark: '#4ade80' },
        stroke: 'stroke-emerald-500 dark:stroke-emerald-400',
        text: 'text-emerald-700 dark:text-emerald-400',
        textMuted: 'text-emerald-600 dark:text-emerald-400',
        borderAccent: 'border-emerald-500',
        tileBg: 'bg-emerald-50 dark:bg-slate-800'
    },
    load: {
        hex: { light: '#2563eb', dark: '#60a5fa' },
        stroke: 'stroke-blue-600 dark:stroke-blue-400',
        text: 'text-blue-700 dark:text-blue-400',
        textMuted: 'text-blue-600 dark:text-blue-400',
        borderAccent: 'border-blue-500',
        tileBg: 'bg-blue-50 dark:bg-slate-800'
    }
};

/**
 * Pick the right hex for the active theme. Use only when inline styles are
 * unavoidable — prefer the Tailwind class fields whenever possible.
 */
export function energyHex(metric: EnergyMetric, isDark: boolean): string {
    return isDark ? energyColors[metric].hex.dark : energyColors[metric].hex.light;
}
