import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifySiteToken } from '@/lib/auth-jwt';
import Link from 'next/link';
import LoadAnalysisClientPage from '@/components/LoadAnalysisClientPage';
import { EnergyRepo } from '@/lib/energy-repo';

export const dynamic = 'force-dynamic';

export default async function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;

    // Verify ownership via JWT
    const cookieStore = await cookies();
    const siteAuthToken = cookieStore.get('site_auth')?.value;

    if (!siteAuthToken) {
        redirect('/login');
    }

    const authorizedSites = verifySiteToken(siteAuthToken);
    if (!authorizedSites || !authorizedSites.includes(id)) {
        return (
            <div className="flex min-h-screen flex-col items-center justify-center p-8 text-gray-100 bg-gray-950">
                <h1 className="text-2xl font-bold text-red-500 mb-4">Unauthorized</h1>
                <p className="text-gray-400 mb-6">You do not have permission to view high-fidelity data for this site.</p>
                <Link href="/products" className="text-blue-400 hover:text-blue-300 hover:underline">
                    Return to My Products
                </Link>
            </div>
        );
    }

    const repo = new EnergyRepo();
    const site = await repo.getSite(id);

    return <LoadAnalysisClientPage siteId={id} siteName={site?.name || 'Site'} />;
}
