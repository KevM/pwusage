
export interface TariffGroup {
    tariffId: number;
    tariffName: string;
    periods: {
        touName: string;
        label: string;
        home: number;
        grid: number;
        solar: number;
        battery: number;
        cost: number;
    }[];
}

export interface RenderContext {
    siteName: string;
    dateRange: string;
    tariffGroups: TariffGroup[];
    totalCost: number;
    currency: string;
    displayCost: string;
    costLabel: string;
    currentTouName?: string;
    batterySoc?: number | null;
    batteryStatus?: 'charging' | 'discharging' | 'idle';
    todayGrid?: number;
    todaySolar?: number;
}

export class TrmnlRenderer {

    static get SUN_ICON() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5" fill="black" stroke="none"/><line x1="12" y1="1" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.78" y2="4.22" /></svg>`;
    }

    static get SUN_ICON_LARGE() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5" fill="black" stroke="none"/><line x1="12" y1="1" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.78" y2="4.22" /></svg>`;
    }

    static get GRID_ICON() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 0 12 24" width="40" height="40"><path d="M7 2v11h3v9l7-12h-4l4-8z" fill="black"/></svg>`;
    }

    static get GRID_ICON_LARGE() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 0 12 24" width="48" height="48"><path d="M7 2v11h3v9l7-12h-4l4-8z" fill="black"/></svg>`;
    }

    static get CHARGING_ICON() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32" fill="black"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" transform="rotate(-90, 12, 12)"/></svg>`;
    }

    static get CHARGING_ICON_LARGE() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="40" height="40" fill="black"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" transform="rotate(-90, 12, 12)"/></svg>`;
    }

    static get DISCHARGING_ICON() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="black" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10M3 12h18M7 16h10M10 20h4" transform="rotate(-90, 12, 12)" /></svg>`;
    }

    static get DISCHARGING_ICON_LARGE() {
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="black" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10M3 12h18M7 16h10M10 20h4" transform="rotate(-90, 12, 12)" /></svg>`;
    }

    static renderFull(ctx: RenderContext): string {
        const tariffTables = ctx.tariffGroups.map(group => {
            const periods = group.periods.sort((a, b) => a.touName.localeCompare(b.touName));

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
                            ${periods.map(p => {
                const isCurrent = ctx.currentTouName && p.touName === ctx.currentTouName;
                // Use value for larger, more readable table text
                const spanClass = 'value--small';
                const labelPrefix = isCurrent ? '> ' : '';

                return `
                                    <tr>
                                        <td><span class="${spanClass}">${labelPrefix}${p.label}</span></td>
                                        <td><span class="${spanClass}">${Math.round(p.home / 1000)}</span></td>
                                        <td><span class="${spanClass}">${Math.round(p.solar / 1000)}</span></td>
                                        <td><span class="${spanClass}">${Math.round(p.grid / 1000)}</span></td>
                                        <td><span class="${spanClass}">${Math.round(p.battery / 1000)}</span></td>
                                        <td><span class="${spanClass}">${ctx.currency}${p.cost.toFixed(2)}</span></td>
                                    </tr>
                                `;
            }).join('')}
                            <tr>
                                <td class="table-col">
                                    <span class="title title--medium"><strong>${ctx.costLabel}</strong></span>
                                </td>
                                <td colspan="4"></td>
                                <td class="table-col">
                                    <span class="title title--medium"><strong>${ctx.displayCost}</strong></span>
                                </td>
                            </tr>
                        </tbody>
                    </table>
            `;
        }).join('');

        const GRID_ICON_ALMOST_LARGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 0 12 24" width="60" height="60"><path d="M7 2v11h3v9l7-12h-4l4-8z" fill="black"/></svg>`;
        const SUN_ICON_ALMOST_LARGE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="60" height="60" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5" fill="black" stroke="none"/><line x1="12" y1="1" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.78" y2="4.22" /></svg>`;

        return `
            <div class="view view--full">
                <div class="layout layout--col gap--distribute h--full">
                     
                     <!-- Live Stats Header -->
                     <!-- Changed gap--distribute to gap--medium and added justify--center to group them better -->
                     <div class="flex flex--row flex--center-y flex--center-x flex--stretch-x gap--xxlarge">
                         ${ctx.todayGrid !== undefined ? `
                         <div class="flex flex--row flex--center-y gap--small">
                             <span class="title title--xxlarge">${(ctx.todayGrid).toFixed(1)}</span>
                             ${GRID_ICON_ALMOST_LARGE}
                         </div>
                         ` : ''}

                         ${ctx.todaySolar !== undefined ? `
                         <div class="flex flex--row flex--center-y gap--small">
                             <span class="title title--xxlarge">${(ctx.todaySolar).toFixed(1)}</span>
                             ${SUN_ICON_ALMOST_LARGE}
                         </div>
                         ` : ''}

                         <div class="flex flex--col">
                             ${this.renderBatteryStatusLarge(ctx.batterySoc, ctx.batteryStatus)}
                         </div>
                     </div>

                     <!-- Tariff Tables -->
                     <div class="flex flex--col w--full m--8 p--8">
                        ${tariffTables}
                     </div>

                     <!-- Footer -->
                     <div class="flex flex--row flex--center-x flex--center-y gap--medium">
                         <span class="title title--small">${ctx.siteName}</span>
                         <span class="label label--small">${ctx.dateRange}</span>
                     </div>
                </div>
            </div>
        `;
    }

    static renderHalfVertical(ctx: RenderContext): string {
        return `
            <div class="view view--half-vertical">
                 <div class="layout layout--col" style="padding: 10px; height: 100%;">
                    
                    <div class="flex flex--row flex--center-y" style="justify-content: space-between; width: 100%; margin-bottom: 10px;">
                         <span class="title title--small">${ctx.siteName}</span>
                         ${this.renderBatteryStatus(ctx.batterySoc, ctx.batteryStatus)}
                    </div>

                    <div class="flex flex--col flex--center-x" style="flex-grow: 1;">
                         <span class="label">${ctx.costLabel}</span>
                         <span class="title title--medium">${ctx.displayCost}</span>
                    </div>

                    <div class="flex flex--row" style="gap: 10px; width: 100%; margin-top: auto;">
                        <div class="flex flex--col flex--center-x" style="flex: 1;">
                            <span class="label">Grid</span>
                            <span class="value">${this.sumStat(ctx.tariffGroups, 'grid')}</span>
                        </div>
                         <div class="flex flex--col flex--center-x" style="flex: 1;">
                            <span class="label">Solar</span>
                            <span class="value">${this.sumStat(ctx.tariffGroups, 'solar')}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    static renderHalfHorizontal(ctx: RenderContext): string {
        return `
            <div class="view view--half-horizontal">
                <div class="layout layout--col" style="padding: 15px; height: 100%;">
                    <div class="flex flex--row flex--center-y" style="justify-content: space-between; width: 100%;">
                        <div class="flex flex--col">
                            <span class="title title--small">${ctx.siteName}</span>
                            <span class="label">${ctx.dateRange}</span>
                        </div>
                        <div class="flex flex--col" style="text-align: right; align-items: flex-end;">
                             <span class="label">${ctx.costLabel}</span>
                             <span class="title title--medium">${ctx.displayCost}</span>
                        </div>
                    </div>

                    <div class="flex flex--row flex--center-y" style="justify-content: space-between; width: 100%; margin-top: auto;">
                          ${this.renderHorizontalStat('Home', this.sumStat(ctx.tariffGroups, 'home'))}
                          ${this.renderHorizontalStat('Solar', this.sumStat(ctx.tariffGroups, 'solar'))}
                          ${this.renderHorizontalStat('Grid', this.sumStat(ctx.tariffGroups, 'grid'))}
                          <div style="margin-left: 10px;">
                             ${this.renderBatteryStatus(ctx.batterySoc, ctx.batteryStatus)}
                          </div>
                    </div>
                </div>
            </div>
        `;
    }

    static renderQuadrant(ctx: RenderContext): string {
        return `
            <div class="view view--quadrant">
                <div class="layout layout--col layout--center" style="padding: 10px; width: 100%; height: 100%;">
                    <span class="label mb-2">${ctx.costLabel}</span>
                    <span class="title title--medium">${ctx.displayCost}</span>
                </div>
            </div>
        `;
    }

    private static sumStat(groups: TariffGroup[], field: 'home' | 'grid' | 'solar' | 'battery'): string {
        let total = 0;
        groups.forEach(g => g.periods.forEach(p => total += p[field]));
        return (total / 1000).toFixed(1) + ' kWh';
    }

    private static renderHorizontalStat(label: string, value: string): string {
        return `
            <div class="flex flex--col">
                <span class="label">${label}</span>
                <span class="value value--small">${value}</span>
            </div>
        `;
    }

    private static renderBatteryStatus(soc?: number | null, status?: 'charging' | 'discharging' | 'idle'): string {
        const hasData = soc !== undefined && soc !== null;
        const level = hasData ? Math.max(0, Math.min(100, soc!)) : 0;
        const text = hasData ? Math.round(level).toString() : '--';

        let icon = '';
        if (status === 'charging') icon = TrmnlRenderer.CHARGING_ICON;
        if (status === 'discharging') icon = TrmnlRenderer.DISCHARGING_ICON;

        // Interactive Battery SVG
        // Width 24px, Height 14px
        // Inner Fill: Max width ~20px (leaving padding)
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

    private static renderBatteryStatusLarge(soc?: number | null, status?: 'charging' | 'discharging' | 'idle'): string {
        const hasData = soc !== undefined && soc !== null;
        const level = hasData ? Math.max(0, Math.min(100, soc!)) : 0;
        const text = hasData ? Math.round(level).toString() : '--';

        // Use STANDARD icons (32px) here instead of LARGE (40px) to ensure visibility and fit
        let icon = '';
        if (status === 'charging') icon = TrmnlRenderer.CHARGING_ICON;
        if (status === 'discharging') icon = TrmnlRenderer.DISCHARGING_ICON;

        // Interactive Battery SVG Large
        // Adjusted to 60x30 to fit nicely with text
        const fillWidth = (level / 100) * 18;

        const batterySvg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="96" height="48" viewBox="0 0 26 14">
                <rect x="0.5" y="0.5" width="22" height="13" rx="2" fill="none" stroke="black" stroke-width="1.5" />
                <path d="M23 4h1.5a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1 -1.5 1.5H23V4z" fill="black" />
                <rect x="2.5" y="2.5" width="${fillWidth}" height="9" rx="0.5" fill="black" />
            </svg>
        `;

        return `
            <div class="flex flex--row flex--center-y gap--small">
                <div class="flex flex--row flex--center-y">
                     <span class="title title--xxlarge">${text}%</span>
                </div>
                <div class="flex flex--row flex--center-y gap--xsmall">
                    ${batterySvg}
                    ${icon ? `<div>${icon}</div>` : ''}
                </div>
            </div>
        `;
    }

    // ... (keep renderHalfVertical/Horizontal/Quadrant same) ...



}

