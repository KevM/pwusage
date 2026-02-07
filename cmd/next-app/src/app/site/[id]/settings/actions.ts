'use server';

import { EnergyRepo } from '@/lib/energy-repo';
import { revalidatePath } from 'next/cache';
import { verifySiteAccess } from '@/lib/auth-checks';

export async function updateBillingStartDay(formData: FormData) {
    const siteId = formData.get('siteId') as string;
    const day = parseInt(formData.get('billingStartDay') as string, 10);

    if (!siteId) {
        throw new Error('Missing site ID');
    }

    if (isNaN(day) || day < 1 || day > 31) {
        throw new Error('Invalid day');
    }

    if (!await verifySiteAccess(siteId)) {
        throw new Error('Unauthorized');
    }

    const repo = new EnergyRepo();
    await repo.updateSiteBillingDay(siteId, day);

    revalidatePath(`/site/${siteId}/settings`);
    revalidatePath(`/site/${siteId}`);
}

export async function updateTimezoneDisplayMode(formData: FormData) {
    const siteId = formData.get('siteId') as string;
    const mode = formData.get('displayMode') as string;

    if (!siteId || (mode !== 'SITE' && mode !== 'BROWSER')) {
        throw new Error('Invalid arguments');
    }

    if (!await verifySiteAccess(siteId)) {
        throw new Error('Unauthorized');
    }

    const repo = new EnergyRepo();
    // We need to add this method to EnergyRepo or just run query here?
    // Let's run query here directly via repo helper or direct db access?
    // Converting to repo method is cleaner.
    await repo.updateSiteTimezoneDisplayMode(siteId, mode as 'SITE' | 'BROWSER');

    revalidatePath(`/site/${siteId}/settings`);
    revalidatePath(`/site/${siteId}`);
}
