import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HistoryAvailabilityNotice } from './history-availability-notice';
const boundary = { availableFrom: '2026-07-03T05:00:00Z', effectiveDays: 90 as const };
describe('history availability presentation', () => {
    it('does not show a warning for retained history', () => {
        expect(renderToStaticMarkup(<HistoryAvailabilityNotice availability={{ ...boundary, status: 'available' }} timezone="America/Chicago" />)).toBe('');
    });
    it('labels a partial bill so totals cannot appear complete', () => {
        const html = renderToStaticMarkup(<HistoryAvailabilityNotice availability={{ ...boundary, status: 'partial' }} timezone="America/Chicago" />);
        expect(html).toContain('Partial history');
        expect(html).toContain('do not represent the full selected period');
        expect(html).toContain('Jul 3, 2026');
    });
    it('labels expired history as unavailable, with a date selection recovery', () => {
        const html = renderToStaticMarkup(<HistoryAvailabilityNotice availability={{ ...boundary, status: 'unavailable' }} timezone="America/Chicago" />);
        expect(html).toContain('History unavailable');
        expect(html).toContain('Choose a more recent date');
    });
});
