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

    const parts = formatter.formatToParts(d);
    const partValues: Record<string, number> = {};
    for (const part of parts) {
        if (part.type !== 'literal') {
            partValues[part.type] = parseInt(part.value);
        }
    }

    const { year, month, day, hour, minute, second } = partValues;
    const siteLocalAsUTC = Date.UTC(year, month - 1, day, hour, minute, second);
    const offset = siteLocalAsUTC - d.getTime();
    const siteMidnightUTC = Date.UTC(year, month - 1, day, 0, 0, 0) - offset;

    return new Date(siteMidnightUTC);
}
