import { DEFAULT_TRMNL_COMPONENT_CONFIG } from './trmnl-component-config';
import { calculateLayoutBudget } from './trmnl/layout-engine';
import { RenderContext } from './trmnl/types';
import * as components from './trmnl/components';
import { SECTION_REGISTRY } from './trmnl/sections/registry';

export type { RenderContext, TariffGroup } from './trmnl/types';

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export class TrmnlRenderer {
    static renderFull(ctx: RenderContext): string {
        const start = Date.now();
        const cfg = ctx.componentConfig ?? DEFAULT_TRMNL_COMPONENT_CONFIG;
        const layout = calculateLayoutBudget(ctx, cfg);

        // Section dispatch is registry-driven: each section owns its enable
        // predicate and markup. The parent template keeps one explicit slot
        // per section id so disabled sections still emit their (empty) slot —
        // collapsing to a single join would drop that whitespace and break
        // the characterization snapshots.
        const html: Record<string, string> = {};
        for (const section of SECTION_REGISTRY) {
            html[section.id] = section.isEnabled(layout) ? section.render(ctx, layout) : '';
        }

        const emptySection = !SECTION_REGISTRY.some((s) => s.isEnabled(layout)) ? `
            <div class="flex flex--row flex--center-x flex--center-y h--full">
                <span class="title title--medium">No components selected</span>
            </div>
        ` : '';

        const markup = `
            <div class="view view--full">
                <div class="layout layout--col gap--small h--full">
                    ${html.live ?? ''}
                    ${html.flow ?? ''}
                    ${html.energyChart ?? ''}
                    ${html.soc ?? ''}
                    ${/* loadTiming rides the bill slot so a disabled section adds zero bytes — a separate template line would inject blank-line whitespace into every feature-off screen */ ''}${html.bill ?? ''}${html.loadTiming ?? ''}
                    ${emptySection}

                     ${!layout.showEstimatedBill ? `
                     <div class="flex flex--row flex--center-x flex--center-y gap--medium">
                         <span class="title title--small">${escapeHtml(ctx.siteName)}</span>
                         <span class="label label--small">${escapeHtml(ctx.dateRange)}</span>
                     </div>
                     ` : ''}
                </div>
            </div>
        `;
        const renderDuration = Date.now() - start;
        console.log(`[TrmnlRenderer] renderFull completed in ${renderDuration}ms`);
        return markup;
    }

    static renderHalfVertical(ctx: RenderContext): string {
        return components.renderHalfVertical(ctx);
    }

    static renderHalfHorizontal(ctx: RenderContext): string {
        return components.renderHalfHorizontal(ctx);
    }

    static renderQuadrant(ctx: RenderContext): string {
        return components.renderQuadrant(ctx);
    }

}
