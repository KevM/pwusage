import type { TrmnlSection } from './types';
import { escapeHtml } from '../../trmnl-renderer';
import { getSunIcon, getGridIcon } from '../icons';
import * as components from '../components';

export const liveSection: TrmnlSection = {
    id: 'live',
    label: 'Live stats',
    configKey: null,
    isEnabled: (l) => l.hasLiveRow,
    render: (ctx, l) => `
            <div class="w--full" style="position: relative; height: ${l.liveRowHeight}px; min-height: ${l.liveRowHeight}px;">
                ${l.showSiteNameInLiveRow ? `
                <span class="label label--small" style="position: absolute; top: 2px; left: 2px; line-height: 1; z-index: 2;">${escapeHtml(ctx.siteName)}</span>
                ` : ''}
                <div class="flex flex--row flex--center-y flex--center-x ${l.liveGap}" style="height: 100%;">
                    ${l.showLiveGridStat ? `
                    <div class="flex flex--row flex--center-y flex--center-x gap--small">
                        <span class="title title--xxlarge" style="font-size: ${l.liveValueFontPx}px; line-height: 1;">${(ctx.todayGrid as number).toFixed(1)}</span>
                        ${getGridIcon(l.liveIconSize)}
                    </div>
                    ` : ''}

                    ${l.showLiveSolarStat ? `
                    <div class="flex flex--row flex--center-y flex--center-x gap--small">
                        <span class="title title--xxlarge" style="font-size: ${l.liveValueFontPx}px; line-height: 1;">${(ctx.todaySolar as number).toFixed(1)}</span>
                        ${getSunIcon(l.liveIconSize)}
                    </div>
                    ` : ''}

                    ${l.showLiveBatteryStat ? `
                    <div class="flex flex--col flex--center-x">
                        ${components.renderBatteryStatusLarge(ctx.batterySoc, ctx.batteryStatus, { scale: l.liveBatteryScale })}
                    </div>
                    ` : ''}
                </div>
            </div>
        `
};
