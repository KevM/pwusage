import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LiveDetailView } from './LiveDetailView';

vi.mock('next/navigation', () => ({
    useRouter: () => ({ refresh: () => {} }),
}));

function renderView() {
    return renderToStaticMarkup(
        <LiveDetailView
            siteId="123"
            siteName="Test Site"
            siteTimezone="America/Los_Angeles"
            batterySoC={50}
            batteryPower={0}
            solarPower={0}
            gridPower={0}
            loadPower={0}
            today={[]}
            todayTotals={{ homeKwh: 0, solarKwh: 0, gridNetKwh: 0, importKwh: 0, exportKwh: 0, batteryNetKwh: 0, latestBatterySoc: null }}
            todayChartRows={[]}
            todayStart={new Date('2026-08-24T07:00:00Z')}
            now={new Date('2026-08-24T19:00:00Z')}
            hasTariff={false}
            loadTiming={null}
            batteryHold={null}
            batteryNotice={null}
            sankeySnapshotSvg={null}
            sankeyCumulativeSvg={null}
        />
    );
}

describe('LiveDetailView', () => {
    it('renders Load timing below Today chart and before SankeyCard', () => {
        const html = renderToStaticMarkup(
            <LiveDetailView
                siteId="123"
                siteName="Test Site"
                siteTimezone="America/Los_Angeles"
                batterySoC={50}
                batteryPower={0}
                solarPower={0}
                gridPower={0}
                loadPower={0}
                today={[]}
                todayTotals={{ homeKwh: 0, solarKwh: 0, gridNetKwh: 0, importKwh: 0, exportKwh: 0, batteryNetKwh: 0, latestBatterySoc: null }}
                todayChartRows={[]}
                todayStart={new Date('2026-08-24T07:00:00Z')}
                now={new Date('2026-08-24T19:00:00Z')}
                hasTariff={false}
                loadTiming={null}
                batteryHold={null}
                batteryNotice={null}
                sankeySnapshotSvg="<svg>snapshot</svg>"
                sankeyCumulativeSvg="<svg>cumulative</svg>"
            />
        );
        const chartAt = html.indexOf('Test Site');
        const loadTimingAt = html.indexOf('Load timing this cycle');
        const sankeyAt = html.indexOf('Energy Value Flow');

        expect(chartAt).toBeGreaterThanOrEqual(0);
        expect(loadTimingAt).toBeGreaterThanOrEqual(0);
        expect(sankeyAt).toBeGreaterThanOrEqual(0);
        expect(chartAt).toBeLessThan(loadTimingAt);
        expect(loadTimingAt).toBeLessThan(sankeyAt);
    });

    it('still renders the Today so far section', () => {
        expect(renderView()).toContain('Today so far');
    });
});
