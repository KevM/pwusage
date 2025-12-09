import { NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';
import { cookies } from 'next/headers';

export async function GET() {
    try {
        const cookieStore = await cookies();
        const token = cookieStore.get('access_token')?.value;

        if (!token) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const repo = new EnergyRepo();
        const sites = await repo.getSites();

        // Map to simple structure
        const result = sites.map(s => {
            const info = s.json as any;
            const utility = info?.tariff_content_v2?.utility ?? 'Unknown Utility';
            return {
                id: s.id,
                name: s.name,
                utility
            };
        });

        return NextResponse.json(result);
    } catch (error) {
        console.error('Failed to fetch sites:', error);
        return NextResponse.json({ error: `Failed to fetch sites: ${(error as Error).message}` }, { status: 500 });
    }
}
