import { describe, expect, it } from 'vitest';
import { renderTrmnlDemoMarkup } from './demo-screen';

describe('renderTrmnlDemoMarkup', () => {
    // 2026-11-22 13:20 in Los Angeles.
    const now = new Date('2026-11-22T21:20:00Z');
    const markup = renderTrmnlDemoMarkup(now);

    it('renders a full-screen view with the real renderer', () => {
        expect(markup).toContain('view view--full');
    });

    it('labels the screen as a demo, stamped with the current time', () => {
        expect(markup).toContain('Demo Home @ 1:20pm');
    });

    it('shows the billing cycle that contains now', () => {
        expect(markup).toContain('11/1 - 12/1');
    });

    it('shows the time-of-use bill with off-peak cheaper than on-peak', () => {
        expect(markup).toContain('Off-Peak');
        expect(markup).toContain('On-Peak');
        expect(markup).toContain('Total Cost');
    });

    it('is deterministic for a given time', () => {
        expect(renderTrmnlDemoMarkup(now)).toBe(markup);
    });
});
