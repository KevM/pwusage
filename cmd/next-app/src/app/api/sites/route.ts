import { NextResponse } from 'next/server';
import { EnergyRepo } from '@/lib/energy-repo';

export async function GET() {
    try {
        const repo = new EnergyRepo();
        const sites = await repo.getSites();

        // Map to simple structure
        const result = sites.map(s => ({
            id: s.id,
            name: s.name
        }));

        return NextResponse.json(result);
    } catch (error) {
        console.error('Failed to fetch sites:', error);
        return NextResponse.json({ error: 'Failed to fetch sites' }, { status: 500 });
    }
}
