import { UsageRange } from '$lib/types';
import { fetchUsageReport } from '$lib/usage_report'; // adjust the path as necessary
import type { PageLoad } from './$types';

export const load: PageLoad = async () => {
	return {
		usage: await fetchUsageReport(UsageRange.day, new Date())
	}
};