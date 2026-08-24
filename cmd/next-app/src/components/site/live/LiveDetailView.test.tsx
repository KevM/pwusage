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
    it('renders Load timing above the Today chart', () => {
        const html = renderView();
        const loadTimingAt = html.indexOf('Load timing this cycle');
        const chartAt = html.indexOf('Test Site');

        expect(loadTimingAt).toBeGreaterThanOrEqual(0);
        expect(chartAt).toBeGreaterThanOrEqual(0);
        expect(loadTimingAt).toBeLessThan(chartAt);
    });

    it('still renders the Today so far section', () => {
        expect(renderView()).toContain('Today so far');
    });
});
