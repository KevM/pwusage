export function formatTouName(name: string): string {
    if (!name) return '';
    // Only format if it looks like an enum constant (ALL_CAPS_WITH_UNDERSCORES)
    if (/^[A-Z_]+$/.test(name)) {
        return name
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('-');
    }
    return name;
}

export function formatTimeRange(
    fromHour: number | null,
    fromMinute: number | null,
    toHour: number | null,
    toMinute: number | null
): string {
    if (fromHour === null && toHour === null) return 'All Day';

    const fH = fromHour ?? 0;
    const fM = fromMinute ?? 0;

    // If toHour is null, it usually implies the end of the day (midnight)
    // But we need to be careful. If it's 20:00 - null, it likely means 20:00 - 24:00
    const tH = toHour;
    const tM = toMinute ?? 0;

    const formatTime = (h: number, m: number) => {
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    const startStr = formatTime(fH, fM);

    let endStr = 'Midnight';
    if (tH !== null) {
        endStr = formatTime(tH, tM);
    }

    return `${startStr} - ${endStr}`;
}

export function formatCentsPerKwh(dollars: number): string {
    const cents = dollars * 100;
    const formatted = new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 1
    }).format(cents);
    return `${formatted}¢ per kWh`;
}

export function formatCentsPerKwhShort(dollars: number): string {
    const cents = dollars * 100;
    const formatted = new Intl.NumberFormat('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 1
    }).format(cents);
    return `${formatted}¢/kWh`;
}

/**
 * Today's date as "YYYY-MM-DD" in the given IANA timezone. Client-safe
 * (pure Intl — no Temporal polyfill); falls back to UTC on a bad timezone.
 */
export function todayDateStrInTimeZone(timeZone: string): string {
    try {
        // en-CA formats as YYYY-MM-DD
        return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    } catch {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
    }
}
