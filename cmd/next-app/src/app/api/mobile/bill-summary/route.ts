import { NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';
import { SiteRepo } from '@/lib/site-repo';
import { verifySiteAccess } from '@/lib/auth-checks';
import { withRequestContext } from '@/lib/request-context';
import { getCurrentCycleStart, getNextCycleStart } from '@/lib/billing-cycle';
import { MOBILE_DASHBOARD_CONTRACT_VERSION, type MobileBillPeriod } from '@/lib/mobile-dashboard-contract';
import { wattsToKilowatts } from '@/lib/energy-utils';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    return withRequestContext(async () => {
        try {
            const siteId = new URL(request.url).searchParams.get('siteId');
            if (!siteId) return NextResponse.json({ error: 'Missing siteId' }, { status: 400 });
            if (!(await verifySiteAccess(siteId))) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }

            const siteRepo = new SiteRepo();
            const site = await siteRepo.getSite(siteId);
            if (!site) return NextResponse.json({ error: 'Site not found' }, { status: 404 });

            const now = new Date();
            const billingDay = site.billing_start_day || 1;
            const cycleStart = getCurrentCycleStart(billingDay, now, site.timezone);
            const cycleEnd = getNextCycleStart(billingDay, cycleStart, site.timezone);
            const energyRepo = new EnergyRepo();
            const [usage, currencyCode, energyDataThrough] = await Promise.all([
                energyRepo.getUsageByTOU(siteId, cycleStart, cycleEnd),
                siteRepo.getSiteCurrencyCode(siteId),
                energyRepo.getLatestTimestamp(siteId),
            ]);
            const estimatedCost = usage.length > 0
                ? usage.reduce((sum, item) => sum + (item.cost ?? 0), 0)
                : null;
            const periods: MobileBillPeriod[] = usage.map((item) => ({
                tariffName: item.tariff?.name || 'Unknown',
                periodName: item.touName || 'Unknown',
                netGridKwh: wattsToKilowatts(item.gridUsage),
                cost: item.cost ?? 0,
            }));

            return NextResponse.json({
                version: MOBILE_DASHBOARD_CONTRACT_VERSION,
                site: { id: site.id, name: site.name, timezone: site.timezone },
                currentBill: {
                    estimatedCost,
                    currency: currencyCode || 'USD',
                    cycleStart: cycleStart.toISOString(),
                    cycleEnd: cycleEnd.toISOString(),
                    periods,
                },
                sources: {
                    calculatedAt: now.toISOString(),
                    energyDataThrough: energyDataThrough?.toISOString() ?? null,
                },
            });
        } catch (error) {
            console.error('[mobile-bill-summary] request failed:', error);
            return NextResponse.json({ error: 'Failed to fetch mobile bill summary' }, { status: 500 });
        }
    });
}
