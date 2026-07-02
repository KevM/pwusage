/**
 * Timezone-aware date utilities
 */

export function getSiteMidnight(d: Date, tz: string): Date {
    if (isNaN(d.getTime())) {
        console.error(`[getSiteMidnight] Invalid Date received`);
        return new Date();
    }

    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
        hour12: false
    });

    const getParts = (testDate: Date) => {
        const testParts = formatter.formatToParts(testDate);
        const vals: Record<string, number> = {};
        for (const p of testParts) {
            if (p.type !== 'literal') {
                vals[p.type] = parseInt(p.value, 10);
            }
        }
        let hr = vals.hour ?? 0;
        if (hr === 24) hr = 0;
        return {
            year: vals.year,
            month: vals.month,
            day: vals.day,
            hour: hr,
            minute: vals.minute ?? 0,
            second: vals.second ?? 0
        };
    };

    // 1. Get the local date components for the input date `d`
    const { year, month, day } = getParts(d);

    // 2. We want to find the UTC timestamp that corresponds to 00:00:00 on this local day
    const targetLocalMidnightUTC = Date.UTC(year, month - 1, day, 0, 0, 0);

    let guessUTC = targetLocalMidnightUTC;
    for (let i = 0; i < 3; i++) {
        const parts = getParts(new Date(guessUTC));
        const localUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
        const diff = localUTC - targetLocalMidnightUTC;
        if (diff === 0) {
            break;
        }
        guessUTC -= diff;
    }

    return new Date(guessUTC);
}
