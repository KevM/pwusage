import type { TrmnlSection } from './types';
import { escapeHtml } from '../../trmnl-renderer';
import { formatTouName, formatCentsPerKwhShort } from '../../format-utils';

function netLabel(basis: string, netExportKwh: number): string {
    if (basis === 'neutral') return '';
    const word = netExportKwh > 0 ? 'Surplus' : 'Deficit';
    return `${word} ${Math.round(Math.abs(netExportKwh))} kWh`;
}

export const loadTimingSection: TrmnlSection = {
    id: 'loadTiming',
    label: 'Load timing',
    configKey: 'showLoadTiming',
    isEnabled: (l) => Boolean(l.hasLoadTimingSection),
    render: (ctx, l) => {
        const view = ctx.loadTiming;
        if (!view) return '';

        if (!view.hasTariff) {
            return `
            <div class="flex flex--row flex--center-x flex--center-y w--full" style="min-height: ${l.loadTimingMinHeight}px;">
                <span class="title title--small">Configure a tariff to see load timing</span>
            </div>`;
        }
        if (!view.hasCycleData || view.periods.length === 0) {
            return `
            <div class="flex flex--row flex--center-x flex--center-y w--full" style="min-height: ${l.loadTimingMinHeight}px;">
                <span class="title title--small">No cycle data yet</span>
            </div>`;
        }

        // Step type sizes down at each density so the section fits its budget
        // when co-displayed with chart / bill. Active cell stays one tier
        // larger than inactive at every density so "what's active" reads at
        // a glance without overshooting the height budget.
        const compact = l.loadTimingCompactLevel ?? 0;
        const activeCostClass = compact >= 2
            ? 'title title--small'
            : (compact >= 1 ? 'title title--medium' : 'title title--xxlarge');
        const inactiveCostClass = compact >= 2
            ? 'value value--small'
            : (compact >= 1 ? 'title title--small' : 'title title--medium');

        let banner = '';
        if (view.nextCheaper) {
            banner = `
            <div class="flex flex--row flex--center-x w--full">
                <span class="title title--small">Cheaper: <strong>${escapeHtml(formatTouName(view.nextCheaper.name))}</strong> ${escapeHtml(view.nextCheaper.phrase)} &middot; ${escapeHtml(formatCentsPerKwhShort(view.nextCheaper.marginalCost))}</span>
            </div>`;
        } else if (view.activeIsCheapest) {
            banner = `
            <div class="flex flex--row flex--center-x w--full">
                <span class="title title--medium">Cheapest period now</span>
            </div>`;
        }

        const cells = view.periods.map((p) => {
            const header = p.isActive
                ? `<span class="value value--small"><strong>ACTIVE NOW</strong></span>`
                : (p.nextStartPhrase
                    ? `<span class="label">Next ${escapeHtml(p.nextStartPhrase)}</span>`
                    : `<span class="label">&nbsp;</span>`);
            const name = p.isActive
                ? `<span class="title title--small"><strong>${escapeHtml(formatTouName(p.name))}</strong></span>`
                : `<span class="title title--small">${escapeHtml(formatTouName(p.name))}</span>`;
            const costClass = p.isActive ? activeCostClass : inactiveCostClass;
            const cost = p.marginalCost === null ? '—' : escapeHtml(formatCentsPerKwhShort(p.marginalCost));
            const net = escapeHtml(netLabel(p.basis, p.cycleNetExportKwh));
            return `
                <div class="flex flex--col flex--center-x" style="flex: 1 1 0;">
                    ${header}
                    ${name}
                    <span class="${costClass}">${cost}</span>
                    <span class="label">${net || '&nbsp;'}</span>
                </div>`;
        }).join('');

        // Clamp to the budget (height + min-height + overflow: hidden) the
        // same way the chart section does, so a tall active cell can't push
        // the footer off-screen on dense layouts.
        return `
            <div class="flex flex--col w--full gap--small" style="height: ${l.loadTimingMinHeight}px; min-height: ${l.loadTimingMinHeight}px; overflow: hidden;">
                ${banner}
                <div class="flex flex--row flex--center-x w--full gap--xxlarge" style="flex: 1 1 auto; align-items: flex-start;">
                    ${cells}
                </div>
            </div>`;
    }
};
