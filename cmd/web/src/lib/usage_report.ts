import type { UsageRange, UsageReport } from "./types";
import { env } from '$env/dynamic/private';

export const fetchUsageReport = async (range: UsageRange, start: Date): Promise<UsageReport> => {
    const uri = new URL(env.API_BASE_URL + '/usage/api/report/' + range );
    const response = await fetch(uri, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    const usageReport: UsageReport = await response.json();
    usageReport.end = new Date(usageReport.end);
    usageReport.start = new Date(usageReport.start);
    return usageReport;
};