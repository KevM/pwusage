import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';



export async function POST() {
    const cookieStore = await cookies();

    // Clear all auth cookies
    cookieStore.delete('access_token');
    cookieStore.delete('refresh_token');
    cookieStore.delete('site_auth');

    redirect('/');
}

export async function GET() {
    return POST();
}
