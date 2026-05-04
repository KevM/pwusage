/**
 * Pure chart-generation functions for the TRMNL e-ink display.
 *
 * This module contains the SVG path generation, data smoothing,
 * and axis-label logic that was previously embedded in TrmnlRenderer.
 * All functions are side-effect-free for easy unit testing.
 */

import { EnergyData } from '../db';
import { energyToAveragePower, wattsToKilowatts, kilowattsToWatts } from '../energy-utils';
import { buildSocCheckpoints, SocSample } from '../soc-checkpoints';

const CHART_FONT_FAMILY = 'Verdana, Arial, sans-serif';

/* ------------------------------------------------------------------ */
/*  Hour label helpers                                                */
/* ------------------------------------------------------------------ */

export interface HourLabelEntry {
    x: number;
    label: string;
    anchor: 'middle' | 'start';
}

export function buildHourLabelEntries(
    startTime: number,
    endTime: number,
    getX: (ts: number) => number,
    leftInset = 0
): HourLabelEntry[] {
    const entries: HourLabelEntry[] = [];
    for (let h = 0; h <= 24; h += 6) {
        const labelTime = new Date(startTime);
        labelTime.setHours(h, 0, 0, 0);
        if (labelTime.getTime() >= startTime && labelTime.getTime() <= endTime) {
            const x = getX(labelTime.getTime());
            const amPm = h % 24 < 12 ? 'am' : 'pm';
            let displayH = h % 12;
            if (displayH === 0) displayH = 12;
            entries.push({ x, label: `${displayH}${amPm}`, anchor: 'middle' });
        }
    }

    const hasMidnightLabel = entries.some((entry) => entry.label === '12am');
    if (!hasMidnightLabel && entries.length <= 2) {
        const midnightX = leftInset + 2;
        const minLabelSpacingPx = 28;
        return [
            { x: midnightX, label: '12am', anchor: 'start' },
            ...entries.filter((entry) => (entry.x - midnightX) >= minLabelSpacingPx)
        ];
    }

    return entries;
}

/* ------------------------------------------------------------------ */
/*  SoC series builders                                               */
/* ------------------------------------------------------------------ */

export function buildSocSeriesForChart(
    knownSoc: SocSample[],
    latestBatterySoc: number | null | undefined,
    startTime: number,
    endTime: number
): SocSample[] {
    if (knownSoc.length > 1) {
        return knownSoc;
    }

    if (knownSoc.length === 1) {
        const only = knownSoc[0];
        return [
            { timestamp: startTime, soc: only.soc },
            { timestamp: endTime, soc: only.soc }
        ];
    }

    if (typeof latestBatterySoc === 'number') {
        return [
            { timestamp: startTime, soc: latestBatterySoc },
            { timestamp: endTime, soc: latestBatterySoc }
        ];
    }

    return [];
}

export function buildSmoothedSocSeriesForChart(
    data: EnergyData[],
    latestBatterySoc: number | null | undefined,
    startTime: number,
    endTime: number
): SocSample[] {
    const baseRows = data
        .map((row) => ({
            timestamp: row.timestamp.getTime(),
            soc: typeof row.battery_soc === 'number' ? row.battery_soc : null as number | null
        }))
        .sort((a, b) => a.timestamp - b.timestamp);

    const knownSoc: SocSample[] = baseRows
        .filter((row): row is { timestamp: number; soc: number } => typeof row.soc === 'number')
        .map((row) => ({ timestamp: row.timestamp, soc: row.soc }));

    if (baseRows.length === 0) {
        return buildSocSeriesForChart(knownSoc, latestBatterySoc, startTime, endTime);
    }

    const knownIndexes: number[] = [];
    for (let i = 0; i < baseRows.length; i++) {
        if (typeof baseRows[i].soc === 'number') knownIndexes.push(i);
    }

    if (knownIndexes.length === 0) {
        if (typeof latestBatterySoc !== 'number') return [];
        return [
            { timestamp: startTime, soc: latestBatterySoc },
            { timestamp: endTime, soc: latestBatterySoc }
        ];
    }

    const firstKnown = knownIndexes[0];
    const lastKnown = knownIndexes[knownIndexes.length - 1];

    // Extend edges so the chart remains continuous over the full time range.
    for (let i = 0; i < firstKnown; i++) {
        baseRows[i].soc = baseRows[firstKnown].soc;
    }
    for (let i = lastKnown + 1; i < baseRows.length; i++) {
        baseRows[i].soc = baseRows[lastKnown].soc;
    }

    // Fill interior gaps by linear interpolation between known samples.
    for (let k = 0; k < knownIndexes.length - 1; k++) {
        const leftIdx = knownIndexes[k];
        const rightIdx = knownIndexes[k + 1];
        const leftSoc = baseRows[leftIdx].soc;
        const rightSoc = baseRows[rightIdx].soc;
        if (leftSoc === null || rightSoc === null) continue;

        const span = rightIdx - leftIdx;
        if (span <= 1) continue;

        for (let i = leftIdx + 1; i < rightIdx; i++) {
            const t = (i - leftIdx) / span;
            baseRows[i].soc = leftSoc + (rightSoc - leftSoc) * t;
        }
    }

    // Match desktop smoothing: light centered moving average.
    const windowRadius = 2;
    const smoothedValues = baseRows.map((_, i) => {
        let sum = 0;
        let count = 0;
        for (let j = i - windowRadius; j <= i + windowRadius; j++) {
            if (j < 0 || j >= baseRows.length) continue;
            const value = baseRows[j].soc;
            if (typeof value === 'number') {
                sum += value;
                count++;
            }
        }
        return count > 0 ? sum / count : null;
    });

    return baseRows
        .map((row, i): SocSample | null => {
            const soc = smoothedValues[i];
            return typeof soc === 'number'
                ? { timestamp: row.timestamp, soc }
                : null;
        })
        .filter((row): row is SocSample => row !== null);
}

/* ------------------------------------------------------------------ */
/*  Energy chart SVG                                                  */
/* ------------------------------------------------------------------ */

export interface EnergyChartOptions {
    chartHeight: number;
    denseLegend?: boolean;
    veryDenseLegend?: boolean;
}

export function renderEnergyChart(
    data: EnergyData[],
    options: EnergyChartOptions
): string {
    const start = Date.now();
    const width = 760;
    const height = Math.max(110, options.chartHeight);
    const denseLegend = Boolean(options.denseLegend);
    const veryDenseLegend = Boolean(options.veryDenseLegend);
    const bottomPadding = height <= 175 ? 28 : 36;

    if (data.length < 2) return '';

    // Determine min/max time from data
    const startTime = data[0].timestamp.getTime();
    const endTime = data[data.length - 1].timestamp.getTime();
    const duration = Math.max(1, endTime - startTime);

    // Calculate scaling bounds (Convert 5-min Wh to average W)
    let maxValue = 1.0;
    let minValue = 0;
    data.forEach(d => {
        const home = energyToAveragePower(d.load_power);
        const solar = energyToAveragePower(d.solar_power);
        const battery = energyToAveragePower(d.battery_power);
        maxValue = Math.max(maxValue, home, solar, battery);
        minValue = Math.min(minValue, home, solar, battery);
    });
    const hasNegative = minValue < 0;
    const maxPositiveKw = Math.max(0.1, wattsToKilowatts(maxValue));
    const minNegativeKw = Math.min(0, wattsToKilowatts(minValue));
    const yMaxKw = Math.max(1, Math.ceil(maxPositiveKw * 1.10));
    let yMinKw = 0;
    if (hasNegative) {
        // Keep negative headroom tight to observed discharge while avoiding extreme ranges.
        const negativeWithMargin = minNegativeKw * 1.15;
        const boundedNegative = Math.max(-5, negativeWithMargin);
        yMinKw = Math.floor(boundedNegative);
        if (yMinKw === 0) yMinKw = -1;
    }
    const yRangeKw = Math.max(0.1, yMaxKw - yMinKw);
    const yTicks = hasNegative
        ? (yMaxKw >= 2 ? [yMinKw, 0, Math.round(yMaxKw / 2), yMaxKw] : [yMinKw, 0, yMaxKw])
        : (yMaxKw >= 2 ? [0, Math.round(yMaxKw / 2), yMaxKw] : [0, yMaxKw]);

    const padding = {
        top: 8,
        right: 10,
        bottom: bottomPadding,
        // Integer kW labels are intentionally short, so a fixed gutter is sufficient.
        left: 32
    };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;

    const getX = (ts: number) => padding.left + ((ts - startTime) / duration) * chartWidth;
    const getY = (w: number) => {
        const kw = wattsToKilowatts(w);
        return padding.top + ((yMaxKw - kw) / yRangeKw) * chartHeight;
    };
    // Series paths (5-min intervals - convert Wh to Average W)
    const homePath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(d.timestamp.getTime())} ${getY(energyToAveragePower(d.load_power))}`).join(' ');
    const solarPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(d.timestamp.getTime())} ${getY(energyToAveragePower(d.solar_power))}`).join(' ');
    const batteryPath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${getX(d.timestamp.getTime())} ${getY(energyToAveragePower(d.battery_power))}`).join(' ');

    // Grid lines (kW)
    const gridLines = yTicks.map(v => {
        const y = getY(kilowattsToWatts(v)); // v is in kW, convert to Average W
        const stroke = v === 0 ? '#bbb' : '#eee';
        const strokeWidth = v === 0 ? '1.25' : '1';
        const yLabelX = padding.left - 4;
        return `<line x1="${padding.left}" y1="${y}" x2="${chartWidth + padding.left}" y2="${y}" stroke="${stroke}" stroke-width="${strokeWidth}" />
                    <text x="${yLabelX}" y="${y + 4}" font-family="${CHART_FONT_FAMILY}" font-size="13" font-weight="700" text-anchor="end">${v}</text>`;
    }).join('');

    // Time labels (Every 6 hours). Ensure 12am is visible early in the day.
    const renderHourLabels = buildHourLabelEntries(
        startTime,
        endTime,
        getX,
        padding.left
    );
    const hourLabelY = height - 6;
    const hourLabelLayer = renderHourLabels
        .map((entry) => {
            const anchor = entry.anchor === 'middle' ? 'middle' : 'start';
            return `<text x="${entry.x}" y="${hourLabelY}" font-family="${CHART_FONT_FAMILY}" font-size="12" font-weight="700" text-anchor="${anchor}">${entry.label}</text>`;
        })
        .join('');

    const legendTextSizePx = veryDenseLegend ? 10 : (denseLegend ? 11 : 12);
    const legendSampleWidthPx = veryDenseLegend ? 10 : (denseLegend ? 12 : 14);
    const legendGroupGapPx = veryDenseLegend ? 8 : (denseLegend ? 10 : 12);
    const legendItemGapPx = veryDenseLegend ? 3 : 4;
    const legendTopPx = veryDenseLegend ? 4 : 6;
    const legendPadding = veryDenseLegend ? '1px 4px' : (denseLegend ? '1px 5px' : '2px 6px');
    const legendOverlay = `
            <div class="flex flex--row" style="position: absolute; top: ${legendTopPx}px; right: 8px; z-index: 2; background: white; padding: ${legendPadding}; border-radius: 2px; gap: ${legendGroupGapPx}px;">
                <div class="flex flex--row flex--center-y" style="gap: ${legendItemGapPx}px;">
                    <span style="display:inline-block; width: ${legendSampleWidthPx}px; border-top: 3px solid black;"></span>
                    <span class="value value--xsmall" style="line-height: 1; font-size: ${legendTextSizePx}px;">Solar</span>
                </div>
                <div class="flex flex--row flex--center-y" style="gap: ${legendItemGapPx}px;">
                    <span style="display:inline-block; width: ${legendSampleWidthPx}px; border-top: 1px solid black;"></span>
                    <span class="value value--xsmall" style="line-height: 1; font-size: ${legendTextSizePx}px;">Home</span>
                </div>
                <div class="flex flex--row flex--center-y" style="gap: ${legendItemGapPx}px;">
                    <span style="display:inline-block; width: ${legendSampleWidthPx}px; border-top: 1px dashed black;"></span>
                    <span class="value value--xsmall" style="line-height: 1; font-size: ${legendTextSizePx}px;">Battery</span>
                </div>
            </div>
        `;

    const svg = `
            <div style="position: relative; width: 100%; height: 100%;">
            <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="display: block;" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
                <!-- Background and Grid -->
                <rect width="${width}" height="${height}" fill="none" />
                ${gridLines}

                <!-- Series -->
                <path d="${solarPath}" fill="none" stroke="black" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
                <path d="${homePath}" fill="none" stroke="black" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />
                <path d="${batteryPath}" fill="none" stroke="black" stroke-width="1" stroke-dasharray="4,4" stroke-linecap="round" stroke-linejoin="round" />
                ${hourLabelLayer}
            </svg>
            ${legendOverlay}
            </div>
        `;
    const renderDuration = Date.now() - start;
    console.log(`[TrmnlRenderer] renderChart completed in ${renderDuration}ms`);
    return svg;
}

/* ------------------------------------------------------------------ */
/*  SoC chart SVG                                                     */
/* ------------------------------------------------------------------ */

export function renderSocChart(
    data: EnergyData[],
    latestBatterySoc?: number | null,
    chartHeight = 102,
    options?: { showXAxis?: boolean }
): string {
    const width = 760;
    const height = Math.max(92, chartHeight);
    const showXAxis = options?.showXAxis !== false;
    const bottomPadding = showXAxis
        ? (height < 96 ? 24 : 30)
        : 10;
    const padding = { top: 10, right: 26, bottom: bottomPadding, left: 24 };
    const chartWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

    const startTime = data.length > 0 ? data[0].timestamp.getTime() : Date.now() - 24 * 60 * 60 * 1000;
    const endTime = data.length > 1 ? data[data.length - 1].timestamp.getTime() : Date.now();
    const duration = Math.max(1, endTime - startTime);
    const getX = (ts: number) => padding.left + ((ts - startTime) / duration) * chartWidth;
    const getSocY = (soc: number) => padding.top + plotHeight - (clamp(soc, 0, 100) / 100) * plotHeight;

    const socSeries = buildSmoothedSocSeriesForChart(data, latestBatterySoc, startTime, endTime);

    if (socSeries.length === 0) {
        return `<span class="label">Battery SoC unavailable</span>`;
    }

    const socPath = socSeries
        .map((point, i) => `${i === 0 ? 'M' : 'L'} ${getX(point.timestamp)} ${getSocY(point.soc)}`)
        .join(' ');

    const hourLabelEntries = buildHourLabelEntries(
        startTime,
        endTime,
        getX,
        padding.left
    );
    const xAxisLabelY = Math.min(height - 4, getSocY(0) + 14);
    const xAxisLabelLayer = showXAxis
        ? hourLabelEntries
            .map((entry) => {
                const anchor = entry.anchor === 'middle' ? 'middle' : 'start';
                return `<text x="${entry.x}" y="${xAxisLabelY}" font-family="${CHART_FONT_FAMILY}" font-size="12" font-weight="700" text-anchor="${anchor}">${entry.label}</text>`;
            })
            .join('')
        : '';

    return `
            <div style="position: relative; width: 100%; height: 100%; min-width: 280px;">
                <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="display: block;" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
                    <line x1="${padding.left}" y1="${getSocY(100)}" x2="${width - padding.right}" y2="${getSocY(100)}" stroke="#eee" stroke-width="1" />
                    <line x1="${padding.left}" y1="${getSocY(50)}" x2="${width - padding.right}" y2="${getSocY(50)}" stroke="#eee" stroke-width="1" />
                    <line x1="${padding.left}" y1="${getSocY(0)}" x2="${width - padding.right}" y2="${getSocY(0)}" stroke="#eee" stroke-width="1" />
                    <path d="${socPath}" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    <text x="${padding.left}" y="${padding.top - 2}" font-family="${CHART_FONT_FAMILY}" font-size="10" font-weight="700" text-anchor="start">Battery Level (%)</text>
                    <text x="${width - 4}" y="${getSocY(100) + 4}" font-family="${CHART_FONT_FAMILY}" font-size="10" font-weight="700" text-anchor="end">100%</text>
                    <text x="${width - 4}" y="${getSocY(50) + 4}" font-family="${CHART_FONT_FAMILY}" font-size="10" font-weight="700" text-anchor="end">50%</text>
                    <text x="${width - 4}" y="${getSocY(0) + 4}" font-family="${CHART_FONT_FAMILY}" font-size="10" font-weight="700" text-anchor="end">0%</text>
                    ${xAxisLabelLayer}
                </svg>
            </div>
        `;
}

/* ------------------------------------------------------------------ */
/*  SoC glyph strip                                                   */
/* ------------------------------------------------------------------ */

export function renderBatterySocGlyphStrip(
    data: EnergyData[],
    latestBatterySoc?: number | null,
    options?: { showXAxis?: boolean }
): string {
    const width = 760;
    const padding = { right: 10, left: 30 };
    const chartWidth = width - padding.left - padding.right;
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const startTime = data.length > 0 ? data[0].timestamp.getTime() : Date.now() - 24 * 60 * 60 * 1000;
    const endTime = data.length > 1 ? data[data.length - 1].timestamp.getTime() : Date.now();
    const duration = Math.max(1, endTime - startTime);
    const getX = (ts: number) => padding.left + ((ts - startTime) / duration) * chartWidth;
    const knownSoc = data
        .map((row): SocSample | null => (
            typeof row.battery_soc === 'number'
                ? { timestamp: row.timestamp.getTime(), soc: row.battery_soc }
                : null
        ))
        .filter((row): row is SocSample => row !== null)
        .sort((a, b) => a.timestamp - b.timestamp);

    const checkpoints = buildSocCheckpoints({
        samples: knownSoc,
        startTime,
        endTime,
        baseAnchorMs: 4 * 60 * 60 * 1000,
        rapidAnchorMs: 2 * 60 * 60 * 1000,
        deltaThreshold: 20,
        rapidSegmentDeltaThreshold: 20
    });

    const points = checkpoints.slice(0, 3);
    if (points.length === 0 && typeof latestBatterySoc !== 'number') {
        return `
                <div class="flex flex--row flex--center-x flex--center-y w--full" style="height: 100%;">
                    <span class="label label--small">Battery SoC unavailable</span>
                </div>
            `;
    }
    const fallbackPoint = typeof latestBatterySoc === 'number'
        ? [{ timestamp: endTime, soc: latestBatterySoc, delta: null as number | null }]
        : [];
    const renderPoints = points.length > 0 ? points : fallbackPoint;
    const showXAxis = Boolean(options?.showXAxis);
    const rowHeight = showXAxis ? 40 : 20;
    const axisY = 24;

    const renderGlyph = (timestamp: number, soc: number, delta: number | null): string => {
        const clampedSoc = clamp(soc, 0, 100);
        const fillWidth = 13.5 * (clampedSoc / 100);
        const marker = delta === null ? '' : (delta >= 0 ? '▲' : '▼');
        const safeX = clamp(getX(timestamp), padding.left + 30, width - padding.right - 20);
        return `
                <g transform="translate(${safeX}, 0)">
                    <text x="-12" y="9" font-family="${CHART_FONT_FAMILY}" font-size="10" text-anchor="end">${Math.round(clampedSoc)}%</text>
                    <rect x="-9" y="1" width="16" height="10" rx="1.6" fill="none" stroke="black" stroke-width="1.2"/>
                    <rect x="7" y="3.8" width="2.6" height="4.4" rx="0.7" fill="black"/>
                    <rect x="-7.2" y="2.6" width="${fillWidth}" height="6.8" rx="0.7" fill="black"/>
                    <text x="12" y="9" font-family="${CHART_FONT_FAMILY}" font-size="10" text-anchor="start">${marker}</text>
                </g>
            `;
    };

    const formatHour = (ts: number): string => {
        const d = new Date(ts);
        const h = d.getHours();
        const amPm = h < 12 ? 'am' : 'pm';
        let displayH = h % 12;
        if (displayH === 0) displayH = 12;
        return `${displayH}${amPm}`;
    };

    const hourLabels: string[] = [];
    if (showXAxis) {
        for (let h = 0; h <= 24; h += 6) {
            const labelTime = new Date(startTime);
            labelTime.setHours(h, 0, 0, 0);
            if (labelTime.getTime() >= startTime && labelTime.getTime() <= endTime) {
                const x = getX(labelTime.getTime());
                hourLabels.push(`<text x="${x}" y="${rowHeight - 2}" font-family="${CHART_FONT_FAMILY}" font-size="10" text-anchor="middle">${formatHour(labelTime.getTime())}</text>`);
            }
        }
    }

    return `
            <div style="width: 100%; min-width: 280px;">
                <svg viewBox="0 0 ${width} ${rowHeight}" width="100%" style="height: auto; display: block;" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
                    ${renderPoints.map((point) => renderGlyph(point.timestamp, point.soc, point.delta)).join('')}
                    ${showXAxis ? `<line x1="${padding.left}" y1="${axisY}" x2="${width - padding.right}" y2="${axisY}" stroke="#000" stroke-width="1" />` : ''}
                    ${hourLabels.join('')}
                </svg>
            </div>
        `;
}
