
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
    todayGrid?: number;
    todaySolar?: number;
}

export class TrmnlRenderer {

    static get SUN_ICON() {
        // Feather-style sun: Smaller center (r=5), longer distinct rays
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="black" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5" fill="black" stroke="none"/><line x1="12" y1="1" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.78" y2="4.22" /></svg>`;
    }

    static get GRID_ICON() {
        // Zoomed bolt (viewBox 6 0 12 24) to reduce side whitespace and match Sun's visual weight
        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 0 12 24" width="24" height="24"><path d="M7 2v11h3v9l7-12h-4l4-8z" fill="black"/></svg>`;
    }

    // Shared Styles
    private static get styles() {
        return `
            /* Fonts */
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap');

            /* Layout Defaults */
            .view { background-color: white; width: 100%; height: 100%; position: relative; font-family: 'Inter', sans-serif; overflow: hidden; }
            .flex { display: flex; }
            .flex--col { flex-direction: column; }
            .flex--row { flex-direction: row; }
            .items--center { align-items: center; }
            .justify--between { justify-content: space-between; }
            .justify--end { justify-content: flex-end; }
            .text--right { text-align: right; }
            .text--left { text-align: left; }
            .text--center { text-align: center; }
            .content--center { display: flex; flex-direction: column; align-items: center; justify-content: center; width: 100%; }
            
            /* Column Layout */
            .layout { display: flex; width: 100%; height: 100%; }
            .columns { display: flex; flex-direction: row; width: 100%; height: 100%; }
            .column { flex: 1; padding: 10px; display: flex; flex-direction: column; }
            .column--left { border-right: 2px solid black; }
            
            /* Tables */
            .table { width: 100%; border-collapse: collapse; font-size: 20px; }
            .table th { border-bottom: 2px solid black; text-align: right; padding: 4px; white-space: nowrap; }
            .table th:first-child { text-align: left; }
            .table td { border-bottom: 1px solid #ccc; padding: 12px 4px; text-align: right; } /* Increased padding */
            .table td:first-child { text-align: left; }
            
            /* Typography */
            .title { font-weight: bold; display: block; }
            .title--large { font-size: 40px; letter-spacing: 2px; } /* Increased from 32px, added spacing */
            .title--medium { font-size: 28px; }
            .title--small { font-size: 22px; }
            .label { font-size: 18px; text-transform: uppercase; letter-spacing: 0.5px; }
            .date { font-size: 18px; color: #333; }
            .stat-value { font-size: 24px; font-weight: bold; }
            .mb-2 { margin-bottom: 0.5rem; }
            .mb-4 { margin-bottom: 1rem; }
            .mt-4 { margin-top: 1rem; }
            .gap--small { gap: 0.5rem; }
            .gap--medium { gap: 1rem; }

            /* Status Bar (Top Right) */
            .status-bar { display: flex; align-items: center; gap: 32px; margin-left: auto; }
            .status-item { display: flex; align-items: center; gap: 6px; }
            .status-icon svg { width: 28px; height: 28px; display: block; }
            
            /* High Contrast Labels (Replacement for Glyphs) */
            .icon-label {
                background: black;
                color: white;
                font-size: 12px;
                font-weight: bold;
                padding: 4px 6px;
                border-radius: 4px;
                text-transform: uppercase;
                display: inline-block;
                line-height: 1;
            }
            
            /* Battery Icon Styles */
            .battery-container { display: flex; align-items: center; gap: 6px; }
            .battery-icon { width: 42px; height: 24px; border: 2px solid #000; border-radius: 3px; position: relative; padding: 2px; box-sizing: border-box; }
            .battery-icon::after { content: ''; position: absolute; top: 6px; right: -5px; width: 3px; height: 8px; background: #000; border-radius: 0 2px 2px 0; }
            .battery-level { height: 100%; background: #000; transition: width 0.3s; }
            .battery-text { font-size: 18px; font-weight: bold; color: black; }
        `;
    }

    static renderFull(ctx: RenderContext): string {
        const tariffHtml = ctx.tariffGroups.map(group => {
            const periods = group.periods.sort((a, b) => a.touName.localeCompare(b.touName));
            return `
                <div class="mb-4" style="flex-grow: 1;">
                    <!-- <span class="label label--underline mb-2">${group.tariffName}</span> -->
                    <table class="table table--compact">
                        <thead>
                            <tr>
                                <th>Period</th>
                                <th class="text--right">Home</th>
                                <th class="text--right">Solar</th>
                                <th class="text--right">Grid</th>
                                <th class="text--right">Batt</th>
                                <th class="text--right">Cost</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${periods.map(p => {
                const isCurrent = ctx.currentTouName && p.touName === ctx.currentTouName;
                const b = isCurrent ? '<b>' : '';
                const eb = isCurrent ? '</b>' : '';
                return `
                                    <tr>
                                        <td>${b}${p.label}${eb}</td>
                                        <td class="text--right">${b}${(p.home / 1000).toFixed(1)}${eb}</td>
                                        <td class="text--right">${b}${(p.solar / 1000).toFixed(1)}${eb}</td>
                                        <td class="text--right">${b}${(p.grid / 1000).toFixed(1)}${eb}</td>
                                        <td class="text--right">${b}${(p.battery / 1000).toFixed(1)}${eb}</td>
                                        <td class="text--right">${b}${ctx.currency}${p.cost.toFixed(2)}${eb}</td>
                                    </tr>
                                `;
            }).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }).join('');

        return `
            <style>${this.styles}</style>
            <div class="view view--full layout flex--col">
                <!-- Header with Site Name and Status Bar -->
                <div class="flex flex--row items--center justify--between" style="padding: 15px 20px 25px 20px; width: 100%; box-sizing: border-box;">
                    <div class="flex flex--col text--left">
                        <span class="title title--medium" style="line-height: 1.2;">${ctx.siteName}</span>
                        <span class="date" style="line-height: 1.2;">${ctx.dateRange}</span>
                    </div>
                    
                    <div class="status-bar">
                        <!-- Grid Today -->
                         ${ctx.todayGrid !== undefined ? `
                        <div class="status-item">
                            <span class="stat-value">${(ctx.todayGrid).toFixed(1)}</span>
                            <span class="status-icon">${TrmnlRenderer.GRID_ICON}</span>
                        </div>
                         ` : ''}

                         <!-- Solar Today -->
                        ${ctx.todaySolar !== undefined ? `
                        <div class="status-item">
                            <span class="stat-value">${(ctx.todaySolar).toFixed(1)}</span>
                            <span class="status-icon">${TrmnlRenderer.SUN_ICON}</span>
                        </div>
                        ` : ''}

                        <!-- Battery SOC -->
                         ${this.renderBatteryIcon(ctx.batterySoc)}
                    </div>
                </div>

                <div class="layout" style="padding: 0 20px 20px 20px; flex-grow: 1; display: flex; flex-direction: column;">
                    <div class="columns" style="flex-grow: 1;">
                        <div class="column" style="justify-content: space-between;">
                            <div class="markdown gap--medium" style="display: flex; flex-direction: column; flex-grow: 1;">
                                ${tariffHtml}
                                <div class="content-element content content--center mt-4" style="margin-top: auto; padding-bottom: 10px;">
                                    <span class="label mb-2">${ctx.costLabel}</span>
                                    <span class="title title--large">${ctx.displayCost}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    static renderHalfVertical(ctx: RenderContext): string {
        // Condensed view: Just summary of totals and the big cost
        return `
            <style>${this.styles}</style>
            <div class="view view--half-vertical">
                <div style="position: absolute; top: 10px; right: 10px;">
                    ${this.renderBatteryIcon(ctx.batterySoc)}
                </div>
                <div class="layout flex--col items--center" style="padding: 15px;">
                    <span class="title title--small mb-4">${ctx.siteName}</span>
                    
                    <div class="content--center">
                         <span class="label">${ctx.costLabel}</span>
                         <span class="title title--medium">${ctx.displayCost}</span>
                    </div>

                    <div class="grid grid--cols-2 gap--small mt-4" style="width: 100%">
                         ${this.renderMiniStat('Grid', ctx.tariffGroups, 'grid')}
                         ${this.renderMiniStat('Solar', ctx.tariffGroups, 'solar')}
                    </div>
                </div>
            </div>
        `;
    }

    static renderHalfHorizontal(ctx: RenderContext): string {
        return `
            <style>${this.styles}</style>
             <div class="view view--half-horizontal">
                ${this.renderBatteryIcon(ctx.batterySoc)}
                <div class="layout layout--row-between" style="padding: 15px; align-items: center;">
                    <div class="flex flex--col">
                        <span class="title title--small">${ctx.siteName}</span>
                        <span class="label">${ctx.dateRange}</span>
                    </div>
                    <div class="flex flex--col text--right">
                         <span class="label">${ctx.costLabel}</span>
                         <span class="title title--medium">${ctx.displayCost}</span>
                    </div>
                </div>
                 <div class="layout layout--row-between" style="padding: 0 15px;">
                     ${this.renderMiniStatHorizontal('Home', ctx.tariffGroups, 'home')}
                     ${this.renderMiniStatHorizontal('Solar', ctx.tariffGroups, 'solar')}
                     ${this.renderMiniStatHorizontal('Grid', ctx.tariffGroups, 'grid')}
                </div>
            </div>
        `;
    }

    static renderQuadrant(ctx: RenderContext): string {
        return `
            <style>${this.styles}</style>
            <div class="view view--quadrant">
                <div class="layout layout--col-center" style="padding: 10px; justify-content: center; height: 100%;">
                    <span class="label mb-2">${ctx.costLabel}</span>
                    <span class="title title--medium">${ctx.displayCost}</span>
                </div>
            </div>
        `;
    }

    private static renderMiniStat(label: string, groups: TariffGroup[], field: 'home' | 'grid' | 'solar' | 'battery'): string {
        let total = 0;
        groups.forEach(g => g.periods.forEach(p => total += p[field]));
        const val = (total / 1000).toFixed(1);

        return `
            <div class="flex flex--col items--center">
                <span class="label">${label}</span>
                <span class="title title--small">${val} <span class="label">kWh</span></span>
            </div>
        `;
    }

    private static renderMiniStatHorizontal(label: string, groups: TariffGroup[], field: 'home' | 'grid' | 'solar' | 'battery'): string {
        let total = 0;
        groups.forEach(g => g.periods.forEach(p => total += p[field]));
        const val = (total / 1000).toFixed(1);

        return `
            <div class="flex flex--col">
                <span class="label">${label}</span>
                <span class="value">${val} kWh</span>
            </div>
        `;
    }

    private static renderBatteryIcon(soc?: number | null): string {
        // If SOC is missing, we defaults to 0 but maybe show differently? 
        // For now, let's show it even if null so the user sees the element.
        const hasData = soc !== undefined && soc !== null;
        const level = hasData ? Math.max(0, Math.min(100, soc!)) : 0;
        const text = hasData ? `${Math.round(level)}%` : '--%';

        return `
            <div class="battery-container">
                <span class="stat-value">${text}</span>
                <div class="battery-icon">
                    <div class="battery-level" style="width: ${level}%"></div>
                </div>
            </div>
        `;
    }
}
