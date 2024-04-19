import type { PageServerLoad } from './$types';
import { env } from '$env/dynamic/private';
import { UsageRange } from '$lib/types';
import { fetchUsageReport } from '$lib/usage_report'; // adjust the path as necessary

export const load: PageServerLoad = async () => {
    const base = env.API_BASE_URL;
	return {
		usage: await fetchUsageReport(base,  UsageRange.month, new Date())
	}
};