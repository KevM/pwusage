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
