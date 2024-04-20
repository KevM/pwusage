import type { PageLoad } from './$types';
import { UsageRange } from '$lib/types';
import { fetchUsageReport } from '$lib/usage_report'; // adjust the path as necessary

export const load: PageLoad = async () => {
	return {
		usage: await fetchUsageReport(UsageRange.month, new Date())
	}
};