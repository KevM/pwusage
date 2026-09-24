export type JsMappedValue = string | number | bigint | boolean | Date | null | undefined;

export type JsMappedRow = Record<string, JsMappedValue>;

export interface MonthlyEgressInput {
    bytesPerPoll: number;
    intervalMinutes: number;
    activeHoursPerDay: number;
    phones: number;
    daysPerMonth?: number;
}

export interface MonthlyEgressEstimate {
    requestsPerMonth: number;
    bytesPerMonth: number;
}

export const EGRESS_SENSITIVITY_SCENARIOS = [
    { label: 'proxy', multiplier: 1 },
    { label: '+50%', multiplier: 1.5 },
    { label: '+100%', multiplier: 2 },
] as const;

export type MeasurementArgsResult =
    | { ok: true; siteId: string; asOf: Date; historical: boolean }
    | { ok: false; error: string };

export function parseMeasurementArgs(args: string[], currentTime: Date): MeasurementArgsResult {
    const siteIndex = args.indexOf('--site');
    const siteValue = siteIndex < 0 ? undefined : args[siteIndex + 1]?.trim();
    if (!siteValue || siteValue.startsWith('--')) {
        return { ok: false, error: '--site requires a site ID.' };
    }

    const atIndex = args.indexOf('--at');
    if (atIndex < 0) {
        return { ok: true, siteId: siteValue, asOf: new Date(currentTime), historical: false };
    }

    const atValue = args[atIndex + 1]?.trim();
    const isoWithZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;
    const calendarDate = atValue?.slice(0, 10);
    const parsedDateOnly = calendarDate ? new Date(`${calendarDate}T00:00:00.000Z`) : new Date(Number.NaN);
    if (!atValue || atValue.startsWith('--')) {
        return { ok: false, error: '--at requires an ISO timestamp with Z or a numeric timezone offset.' };
    }
    const calendarDateIsValid = !Number.isNaN(parsedDateOnly.getTime())
        && parsedDateOnly.toISOString().slice(0, 10) === calendarDate;
    if (!isoWithZone.test(atValue) || Number.isNaN(Date.parse(atValue)) || !calendarDateIsValid) {
        return { ok: false, error: '--at must be a valid ISO timestamp with Z or a numeric timezone offset.' };
    }

    return { ok: true, siteId: siteValue, asOf: new Date(atValue), historical: true };
}

export const measuredBundlePollingProfiles = [
    { name: 'Products page', intervalMinutes: 1 },
    { name: 'Web header', intervalMinutes: 5 },
    { name: 'Live detail refresh', intervalMinutes: 30 },
    { name: 'iOS visible poll', intervalMinutes: 5 },
    { name: 'iOS visible poll', intervalMinutes: 30 },
] as const;

/**
 * Estimate UTF-8 bytes for values after repository mapping in JavaScript.
 * This is a result-value proxy: Date ISO formatting and numeric/null
 * conversions may differ from raw PostgreSQL text representations.
 */
export function estimateJsMappedValueRowBytes(row: JsMappedRow): number {
    let byteCount = 0;
    for (const value of Object.values(row)) {
        if (value === null || value === undefined) continue;
        const textValue = value instanceof Date
            ? value.toISOString()
            : String(value);
        byteCount += Buffer.byteLength(textValue, 'utf8');
    }
    return byteCount;
}

export function estimateJsMappedValueRowsBytes(rows: JsMappedRow[]): number {
    return rows.reduce((sum, row) => sum + estimateJsMappedValueRowBytes(row), 0);
}

export function estimateMonthlyEgress(input: MonthlyEgressInput): MonthlyEgressEstimate {
    const daysPerMonth = input.daysPerMonth ?? 30;
    const requestsPerMonth = Math.ceil(
        (input.activeHoursPerDay * 60 / input.intervalMinutes) * daysPerMonth * input.phones
    );
    return {
        requestsPerMonth,
        bytesPerMonth: requestsPerMonth * input.bytesPerPoll,
    };
}
