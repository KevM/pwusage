import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';



export async function POST() {
    const cookieStore = await cookies();

    // Clear all auth cookies
    // Clear all auth cookies
    cookieStore.delete({ name: 'access_token', path: '/' });
    cookieStore.delete({ name: 'refresh_token', path: '/' });
    cookieStore.delete({ name: 'site_auth', path: '/' });

    redirect('/');
}

export async function GET() {
    return POST();
}
