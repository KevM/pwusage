/**
 * Reusable UI components and sub-renderers for the TRMNL e-ink display.
 *
 * This module contains smaller layout fragments (battery indicators, stats)
 * and alternative layout entry points (Half Vertical, Half Horizontal, Quadrant).
 */

import { RenderContext, TariffGroup } from './types';
import { wattsToKilowatts } from '../energy-utils';
import { CHARGING_ICON, DISCHARGING_ICON } from './icons';
import { escapeHtml } from '../trmnl-renderer';

/* ------------------------------------------------------------------ */
/*  Stat Helpers                                                      */
/* ------------------------------------------------------------------ */

export function sumStat(groups: TariffGroup[], field: 'home' | 'grid' | 'solar' | 'battery'): string {
    let total = 0;
    groups.forEach(g => g.periods.forEach(p => total += p[field]));
    return wattsToKilowatts(total).toFixed(1) + ' kWh';
}

export function summaryStat(ctx: RenderContext, field: 'home' | 'grid' | 'solar'): string {
    const todayValue = field === 'home'
        ? ctx.todayHome
        : (field === 'grid' ? ctx.todayGrid : ctx.todaySolar);

    if (typeof todayValue === 'number') {
        return todayValue.toFixed(1) + ' kWh';
    }

    return sumStat(ctx.tariffGroups, field);
}

export function renderHorizontalStat(label: string, value: string): string {
    return `
        <div class="flex flex--col">
            <span class="label">${label}</span>
            <span class="value value--small">${value}</span>
        </div>
    `;
}

/* ------------------------------------------------------------------ */
/*  Battery Indicators                                                */
/* ------------------------------------------------------------------ */

export function renderBatteryStatus(soc?: number | null, status?: 'charging' | 'discharging' | 'idle'): string {
    const hasData = soc !== undefined && soc !== null;
    const level = hasData ? Math.max(0, Math.min(100, soc!)) : 0;
    const text = hasData ? Math.round(level).toString() : '--';

    let icon = '';
    if (status === 'charging') icon = CHARGING_ICON;
    if (status === 'discharging') icon = DISCHARGING_ICON;

    const fillWidth = (level / 100) * 18;

    const batterySvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="52" height="28" viewBox="0 0 26 14">
            <rect x="0.5" y="0.5" width="22" height="13" rx="2" fill="none" stroke="black" stroke-width="1.5" />
            <path d="M23 4h1.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1 -1.5 1.5H23V4z" fill="black" />
            <rect x="2.5" y="2.5" width="${fillWidth}" height="9" rx="0.5" fill="black" />
        </svg>
    `;

    return `
        <div class="flex flex--row flex--center-y gap--xsmall">
            <span class="value value--large">${text}</span>
            <span class="value value--xsmall">%</span>
            ${batterySvg}
            ${icon ? `<div>${icon}</div>` : ''}
        </div>
    `;
}

export function renderBatteryStatusLarge(
    soc?: number | null,
    status?: 'charging' | 'discharging' | 'idle',
    options?: { scale?: number }
): string {
    const hasData = soc !== undefined && soc !== null;
    const level = hasData ? Math.max(0, Math.min(100, soc!)) : 0;
    const text = hasData ? Math.round(level).toString() : '--';
    const scale = options?.scale ?? 1;

    let icon = '';
    if (status === 'charging') icon = CHARGING_ICON;
    if (status === 'discharging') icon = DISCHARGING_ICON;

    const fillWidth = (level / 100) * 18;

    const batterySvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(96 * scale)}" height="${Math.round(48 * scale)}" viewBox="0 0 26 14">
            <rect x="0.5" y="0.5" width="22" height="13" rx="2" fill="none" stroke="black" stroke-width="1.5" />
            <path d="M23 4h1.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1 -1.5 1.5H23V4z" fill="black" />
            <rect x="2.5" y="2.5" width="${fillWidth}" height="9" rx="0.5" fill="black" />
        </svg>
    `;

    return `
        <div class="flex flex--row flex--center-y gap--small">
            <div class="flex flex--row flex--center-y">
                 <span class="title title--xxlarge" style="font-size: ${Math.round(64 * scale)}px; line-height: 1;">${text}%</span>
            </div>
            <div class="flex flex--row flex--center-y gap--xsmall">
                ${batterySvg}
                ${icon ? `<div>${icon}</div>` : ''}
            </div>
        </div>
    `;
}

export function renderBatterySocStandalone(soc?: number | null): string {
    const hasData = soc !== undefined && soc !== null;
    const level = hasData ? Math.max(0, Math.min(100, soc!)) : 0;
    const text = hasData ? Math.round(level).toString() : '--';
    const fillWidth = (level / 100) * 18;

    const batterySvg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="132" height="66" viewBox="0 0 26 14">
            <rect x="0.5" y="0.5" width="22" height="13" rx="2" fill="none" stroke="black" stroke-width="1.5" />
            <path d="M23 4h1.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1 -1.5 1.5H23V4z" fill="black" />
            <rect x="2.5" y="2.5" width="${fillWidth}" height="9" rx="0.5" fill="black" />
        </svg>
    `;

    return `
        <div class="flex flex--col flex--center-x">
            <div class="flex flex--row flex--center-y gap--small">
                <span class="title title--xxlarge" style="font-size: 84px; line-height: 1;">${text}%</span>
                ${batterySvg}
            </div>
        </div>
    `;
}

/* ------------------------------------------------------------------ */
/*  Alternative Layout Entry Points                                   */
/* ------------------------------------------------------------------ */

export function renderHalfVertical(ctx: RenderContext): string {
    const gridValue = summaryStat(ctx, 'grid');
    const solarValue = summaryStat(ctx, 'solar');

    return `
        <div class="view view--half-vertical">
             <div class="layout layout--col" style="padding: 10px; height: 100%;">${ctx.connectionMessage ? `<span class="label label--small">${escapeHtml(ctx.connectionMessage)}</span>` : ''}
                
                <div class="flex flex--row flex--center-y" style="justify-content: space-between; width: 100%; margin-bottom: 10px;">
                     <span class="title title--small">${escapeHtml(ctx.siteName)}</span>
                     ${renderBatteryStatus(ctx.batterySoc, ctx.batteryStatus)}
                </div>

                <div class="flex flex--col flex--center-x" style="flex-grow: 1;">
                     <span class="label">${escapeHtml(ctx.costLabel)}</span>
                     <span class="title title--medium">${escapeHtml(ctx.displayCost)}</span>
                </div>

                <div class="flex flex--row" style="gap: 10px; width: 100%; margin-top: auto;">
                    <div class="flex flex--col flex--center-x" style="flex: 1;">
                        <span class="label">Grid</span>
                        <span class="value">${gridValue}</span>
                    </div>
                     <div class="flex flex--col flex--center-x" style="flex: 1;">
                        <span class="label">Solar</span>
                        <span class="value">${solarValue}</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

export function renderHalfHorizontal(ctx: RenderContext): string {
    const homeValue = summaryStat(ctx, 'home');
    const solarValue = summaryStat(ctx, 'solar');
    const gridValue = summaryStat(ctx, 'grid');

    return `
        <div class="view view--half-horizontal">
            <div class="layout layout--col" style="padding: 15px; height: 100%;">${ctx.connectionMessage ? `<span class="label label--small">${escapeHtml(ctx.connectionMessage)}</span>` : ''}
                <div class="flex flex--row flex--center-y" style="justify-content: space-between; width: 100%;">
                    <div class="flex flex--col">
                        <span class="title title--small">${escapeHtml(ctx.siteName)}</span>
                        <span class="label">${escapeHtml(ctx.dateRange)}</span>
                    </div>
                    <div class="flex flex--col" style="text-align: right; align-items: flex-end;">
                         <span class="label">${escapeHtml(ctx.costLabel)}</span>
                         <span class="title title--medium">${escapeHtml(ctx.displayCost)}</span>
                    </div>
                </div>

                <div class="flex flex--row flex--center-y" style="justify-content: space-between; width: 100%; margin-top: auto;">
                      ${renderHorizontalStat('Home', homeValue)}
                      ${renderHorizontalStat('Solar', solarValue)}
                      ${renderHorizontalStat('Grid', gridValue)}
                      <div style="margin-left: 10px;">
                         ${renderBatteryStatus(ctx.batterySoc, ctx.batteryStatus)}
                      </div>
                </div>
            </div>
        </div>
    `;
}


export function renderQuadrant(ctx: RenderContext): string {
    return `
        <div class="view view--quadrant">
            <div class="layout layout--col layout--center" style="padding: 10px; width: 100%; height: 100%;">${ctx.connectionMessage ? `<span class="label label--small">${escapeHtml(ctx.connectionMessage)}</span>` : ''}
                <span class="label mb-2">${escapeHtml(ctx.costLabel)}</span>
                <span class="title title--medium">${escapeHtml(ctx.displayCost)}</span>
            </div>
        </div>
    `;
}

export function renderTariffTables(
    ctx: RenderContext,
    billRowsTarget: number,
    billCompactLevel: number
): string {
    return ctx.tariffGroups.map(group => {
        const periods = [...group.periods].sort((a, b) => {
            const aIsCurrent = Boolean(ctx.currentTouName && a.touName === ctx.currentTouName);
            const bIsCurrent = Boolean(ctx.currentTouName && b.touName === ctx.currentTouName);
            if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;
            return a.touName.localeCompare(b.touName);
        });
        const displayedPeriods = periods.slice(0, Math.min(billRowsTarget, periods.length));
        const spanClass = billCompactLevel > 0 ? 'value--xsmall' : 'value--small';
        const totalClass = billCompactLevel > 0 ? 'title title--small' : 'title title--medium';

        return `
                <table class="table w--full">
                    <thead>
                        <tr>
                            <th>Period</th>
                            <th>Home</th>
                            <th>Solar</th>
                            <th>Grid</th>
                            <th>Batt</th>
                            <th>Cost</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${displayedPeriods.map(p => {
            const isCurrent = ctx.currentTouName && p.touName === ctx.currentTouName;
            const labelPrefix = isCurrent ? '> ' : '';
            const periodCostDisplay = p.cost < 0
                ? `+${ctx.currency}${Math.abs(p.cost).toFixed(2)}`
                : `${ctx.currency}${p.cost.toFixed(2)}`;

            return `
                                <tr>
                                    <td><span class="${spanClass}">${labelPrefix}${escapeHtml(p.label)}</span></td>
                                    <td><span class="${spanClass}">${Math.round(wattsToKilowatts(p.home))}</span></td>
                                    <td><span class="${spanClass}">${Math.round(wattsToKilowatts(p.solar))}</span></td>
                                    <td><span class="${spanClass}">${Math.round(wattsToKilowatts(p.grid))}</span></td>
                                    <td><span class="${spanClass}">${Math.round(wattsToKilowatts(p.battery))}</span></td>
                                    <td><span class="${spanClass}">${escapeHtml(periodCostDisplay)}</span></td>
                                </tr>
                            `;
        }).join('')}
                        <tr>
                            <td class="table-col">
                                <span class="${totalClass}"><strong>${escapeHtml(ctx.costLabel)}</strong></span>
                            </td>
                            <td colspan="4"></td>
                            <td class="table-col">
                                <span class="${totalClass}"><strong>${escapeHtml(ctx.displayCost)}</strong></span>
                            </td>
                        </tr>
                    </tbody>
                </table>
        `;
    }).join('');
}
