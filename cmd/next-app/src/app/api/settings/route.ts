import { NextResponse } from 'next/server';
import { SettingsRepo } from '@/lib/settings-repo';

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { billing_start_day } = body;

        if (billing_start_day === undefined || billing_start_day < 1 || billing_start_day > 31) {
            return NextResponse.json({ error: 'Invalid billing start day' }, { status: 400 });
        }

        const repo = new SettingsRepo();
        repo.setBillingStartDay(Number(billing_start_day));

        return NextResponse.json({ success: true, billing_start_day });
    } catch (error) {
        console.error('Settings error:', error);
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}

export async function GET() {
    try {
        const repo = new SettingsRepo();
        const day = repo.getBillingStartDay();
        return NextResponse.json({ billing_start_day: day });
    } catch (error) {
        return NextResponse.json({ error: (error as Error).message }, { status: 500 });
    }
}
