import type { TrmnlSection } from './types';
import { escapeHtml } from '../../trmnl-renderer';
import * as components from '../components';

export const billSection: TrmnlSection = {
    id: 'bill',
    label: 'Estimated Monthly Bill',
    configKey: 'showEstimatedBill',
    isEnabled: (l) => l.showEstimatedBill,
    render: (ctx, l) => {
        const tariffTables = ctx.billingUnavailable ? `
            <div class="flex flex--col gap--small">
                <span class="label">Pricing unavailable</span>
                <span class="title title--medium">--</span>
                <span class="label label--small">Historical tariff attribution is incomplete</span>
            </div>` : components.renderTariffTables(ctx, l.billRowsTarget, l.billCompactLevel);
        return `
            <div class="flex flex--col w--full">
                ${l.showBillMetaHeader ? `
                <div class="flex flex--row flex--center-y w--full" style="justify-content: space-between; margin-bottom: 4px;">
                    <span class="title title--small" style="font-size: ${l.compactBillMode ? 15 : 17}px; line-height: 1;">${escapeHtml(ctx.siteName)}</span>
                    <span class="value value--small" style="font-size: ${l.compactBillMode ? 13 : 15}px; font-weight: 700; line-height: 1;">${escapeHtml(ctx.dateRange)}</span>
                </div>
                ` : ''}
                ${tariffTables}
            </div>
        `;
    }
};
