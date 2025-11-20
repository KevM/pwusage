'use server';

import { SettingsRepo } from '@/lib/settings-repo';
import { revalidatePath } from 'next/cache';

export async function updateBillingStartDay(formData: FormData) {
    const day = parseInt(formData.get('billingStartDay') as string, 10);

    if (isNaN(day) || day < 1 || day > 31) {
        throw new Error('Invalid day');
    }

    const repo = new SettingsRepo();
    repo.setBillingStartDay(day);

    revalidatePath('/settings');
    revalidatePath('/'); // Revalidate home/dashboard if it uses this (it doesn't yet but might)
    revalidatePath('/site/[id]', 'page'); // Revalidate site pages
}
