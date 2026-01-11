
import { describe, it, expect, vi } from 'vitest';

describe('Date Parsing Logic', () => {
    // Helper to simulate the incorrect logic
    function parseDateIncorrect(dateStr: string) {
        const date = new Date(dateStr); // UTC Midnight
        // If system is CST (UTC-6), this is previous day 18:00
        const start = new Date(date);
        start.setHours(0, 0, 0, 0); // Local Midnight of PREVIOUS day
        return start;
    }

    // Helper to simulate the correct logic
    function parseDateCorrect(dateStr: string) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const date = new Date(y, m - 1, d); // Local Midnight of CORRECT day
        const start = new Date(date);
        start.setHours(0, 0, 0, 0);
        return start;
    }

    it('should demonstrate the bug: ISO string parsing shifts to previous day in Western timezones', () => {
        // We can't easily change system timezone in Node, but we can check the behavior.
        // If we are in CST (as the user metadata suggests: GMT-0600)

        const input = '2026-01-10';

        // This test assumes the runner is in a timezone behind UTC (like CST)
        // verify current timezone offset
        const offset = new Date().getTimezoneOffset();
        if (offset > 0) { // Positive offset means "behind UTC" in JS (weirdly, but usually minutes behind UTC. Actually JS: UTC = Local + Offset)
            // wait, getTimezoneOffset() returns +360 for CST (UTC-6). 
            // So if offset > 0, we are West of Greenwich.

            const badStart = parseDateIncorrect(input);
            // Expect invalid: Jan 9th
            expect(badStart.getDate()).toBe(9);

            const goodStart = parseDateCorrect(input);
            // Expect valid: Jan 10th
            expect(goodStart.getDate()).toBe(10);
        } else {
            console.warn('Skipping timezone bug test as runner is UTC or East');
        }
    });

    it('Correct logic should always produce the requested local date', () => {
        const input = '2026-01-10';
        const start = parseDateCorrect(input);
        expect(start.getFullYear()).toBe(2026);
        expect(start.getMonth()).toBe(0); // Jan
        expect(start.getDate()).toBe(10);
        expect(start.getHours()).toBe(0);
    });
});
