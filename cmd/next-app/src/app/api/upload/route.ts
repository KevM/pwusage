
import { put } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { isUserAdmin } from '@/lib/auth-checks';

export async function POST(request: Request) {
    const isAdmin = await isUserAdmin();
    if (!isAdmin) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { searchParams } = new URL(request.url);
        const filename = searchParams.get('filename');

        if (!filename || !request.body) {
            return NextResponse.json({ error: 'Filename and body are required' }, { status: 400 });
        }

        if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
            return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
        }

        const blob = await put(`system-announcements/${filename}`, request.body, {
            access: 'public',
        });

        return NextResponse.json(blob);
    } catch (error) {
        console.error('Upload error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
