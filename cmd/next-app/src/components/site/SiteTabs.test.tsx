import { describe, expect, it } from 'vitest';
import { tabLabelClass } from './SiteTabs';

describe('tabLabelClass', () => {
    it('shows the active tab label on all viewports', () => {
        expect(tabLabelClass('bill', 'bill')).toBe('inline');
    });

    it('hides inactive tab labels on mobile but shows them on desktop', () => {
        expect(tabLabelClass('history', 'bill')).toBe('hidden sm:inline');
    });

    it('treats each tab independently of the others', () => {
        expect(tabLabelClass('settings', 'savings')).toBe('hidden sm:inline');
        expect(tabLabelClass('savings', 'savings')).toBe('inline');
    });
});
