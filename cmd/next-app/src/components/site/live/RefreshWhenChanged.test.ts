import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { shouldRefreshForCycle } from './RefreshWhenChanged';

describe('shouldRefreshForCycle', () => {
    it('refreshes once per changed refresh cycle, including after an earlier one', () => {
        expect(shouldRefreshForCycle(true, 'a', null)).toBe(true);
        // Same cycle re-rendered: already handled.
        expect(shouldRefreshForCycle(true, 'a', 'a')).toBe(false);
        // A later refresh (still mounted) with new data: applies.
        expect(shouldRefreshForCycle(true, 'b', 'a')).toBe(true);
        // Nothing new stored: never refreshes, so no loop.
        expect(shouldRefreshForCycle(false, 'c', 'b')).toBe(false);
    });
});
