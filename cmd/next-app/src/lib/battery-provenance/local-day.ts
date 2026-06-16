/** 'YYYY-MM-DD' for the given instant in the given IANA timezone. */
export function localDateKey(ts: Date, timeZone: string): string {
    // en-CA renders as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(ts);
}

/** Offset (ms) of `timeZone` from UTC at instant `ts`: localWallClock - utc. */
function tzOffsetMs(ts: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(ts);
    const get = (t: string) => Number(parts.find(p => p.type === t)!.value);
    let hour = get('hour');
    if (hour === 24) hour = 0;
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
    return asUtc - ts.getTime();
}

/** UTC [start, end) instants bounding the given local calendar date. */
export function localDayBoundsUtc(localDate: string, timeZone: string): { start: Date; end: Date } {
    const [y, m, d] = localDate.split('-').map(Number);
    const startGuess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    const start = new Date(startGuess.getTime() - tzOffsetMs(startGuess, timeZone));
    const endGuess = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
    const end = new Date(endGuess.getTime() - tzOffsetMs(endGuess, timeZone));
    return { start, end };
}

/** Add n whole days to a 'YYYY-MM-DD' string (calendar arithmetic, timezone-independent). */
export function addLocalDays(localDate: string, n: number): string {
    const d = new Date(`${localDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/** Local clock hour (0..23) for the instant in the given IANA timezone. */
export function localHour(ts: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hour: '2-digit', hour12: false,
    }).formatToParts(ts);
    let hour = Number(parts.find(p => p.type === 'hour')!.value);
    if (hour === 24) hour = 0; // some ICU builds render local midnight as 24
    return hour;
}

