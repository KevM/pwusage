import type { TrmnlSection } from './types';

export const flowSection: TrmnlSection = {
    id: 'flow',
    label: 'Energy Flow',
    configKey: 'showEnergyFlow',
    isEnabled: (l) => Boolean(l.hasFlowSection),
    render: (ctx, l) => {
        if (!ctx.flowSvg) return '';
        // Fixed-aspect SVG (preserveAspectRatio) scales centered to fill this
        // budgeted box. overflow:hidden clamps it to the height budget so a
        // dense layout can't push the footer off-screen.
        return `
            <div class="flex flex--row flex--center-x flex--center-y w--full" style="height: ${l.flowMinHeight}px; min-height: ${l.flowMinHeight}px; overflow: hidden;">
                ${ctx.flowSvg}
            </div>
        `;
    }
};
