// import type { UsageRange, UsageReport, DashboardReport } from "./types";
import { env } from '$env/dynamic/public';

// export const fetchUsageReport = async (range: UsageRange, start: Date): Promise<UsageReport> => {
//     const uri = new URL(env.PUBLIC_API_BASE_URL + '/usage/api/report/' + range );
//     const response = await fetch(uri, {
//         method: 'GET',
//         headers: { 'Content-Type': 'application/json' },
//     });

//     if (!response.ok) {
//         throw new Error(`HTTP error! status: ${response.status}`);
//     }

//     const usageReport: UsageReport = await response.json();
//     usageReport.end = new Date(usageReport.end);
//     usageReport.start = new Date(usageReport.start);
//     return usageReport;
// };

// export const fetchDashboardReport = async (): Promise<DashboardReport> => {
//     const uri = new URL(env.PUBLIC_API_BASE_URL + '/usage/api/dashboard' );
//     const response = await fetch(uri, {
//         method: 'GET',
//         headers: { 'Content-Type': 'application/json' },
//     });

//     if (!response.ok) {
//         throw new Error(`HTTP error! status: ${response.status}`);
//     }

//     const dashboardReport: DashboardReport = await response.json();
//     dashboardReport.start = new Date(dashboardReport.start)
//     dashboardReport.year.start = new Date(dashboardReport.year.start)
//     dashboardReport.month.start = new Date(dashboardReport.month.start)
//     dashboardReport.week.start = new Date(dashboardReport.week.start)
//     dashboardReport.day.start = new Date(dashboardReport.day.start)
//     return dashboardReport;
// };