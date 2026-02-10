import { pool } from '@/lib/db';
import { PreviewClient } from './client';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { EnergyRepo } from '@/lib/energy-repo';

export const dynamic = 'force-dynamic';

function getParam(param: string | string[] | undefined): string | undefined {
    if (Array.isArray(param)) return param[0];
    return param;
}

export default async function Page(props: { params: Promise<{ id: string }>, searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
    const params = await props.params;
    const siteId = params.id;
    const searchParams = await props.searchParams;

    // Fetch site details for breadcrumbs
    const repo = new EnergyRepo();
    const site = await repo.getSite(siteId);

    if (!site) {
        return <div className="p-8">Site not found</div>;
    }

    // Fetch Trmnl Installation for this site
    // We join TrmnlInstallation to get the UUID and Token.
    // Note: We don't join User anymore for tokens, we use TrmnlInstallation.
    const query = `
        SELECT 
            i.site_id,
            s.name as site_name,
            i.uuid as trmnl_uuid,
            i.access_token as trmnl_token
        FROM "TrmnlInstallation" i
        JOIN "Site" s ON i.site_id = s.id
        WHERE i.site_id = $1
    `;

    const res = await pool.query(query, [siteId]);
    const installation = res.rows[0];

    const breadcrumbs = [
        { label: site.name, href: `/site/${site.id}` },
        { label: 'Settings', href: `/site/${site.id}/settings` },
        { label: 'Trmnl Preview' }
    ];

    return (
        <div className="p-4 md:px-8 md:pt-2 md:pb-6 lg:px-24 lg:pt-2 lg:pb-6">
            <Breadcrumbs items={breadcrumbs} />
            <div className="max-w-4xl mx-auto">
                <h1 className="text-2xl font-bold mb-6 mt-4 dark:text-white">Trmnl View Preview</h1>

                {installation ? (
                    <PreviewClient installation={installation} siteId={siteId} />
                ) : (
                    <div className="space-y-6">
                        <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800">
                            <p className="mb-2 font-semibold">Preview Mode</p>
                            <p className="text-sm">You are previewing the Trmnl view for this site. No physical Trmnl device is linked yet.</p>
                            <a href="https://trmnl.com/plugin_settings/new?keyname=powerwall_energy_usage" target="_blank" className="text-sm underline hover:text-blue-900 dark:hover:text-blue-100 mt-2 inline-block">Link a Trmnl device &rarr;</a>
                        </div>
                        <PreviewClient siteId={siteId} />
                    </div>
                )}

                <div className="mt-8 pt-8 border-t border-gray-200 dark:border-gray-700">
                    <h2 className="text-lg font-semibold mb-4 dark:text-white">Manual UUID Preview</h2>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">Enter a random UUID to test the &quot;New Installation&quot; (QR Code) screen.</p>
                    <form action={`/site/${siteId}/trmnl/preview`} method="GET" className="flex gap-4">
                        <input
                            type="text"
                            name="uuid"
                            placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
                            className="flex-1 p-2 border rounded dark:bg-slate-800 dark:border-slate-700 dark:text-white"
                            defaultValue={getParam(searchParams?.uuid)}
                        />
                        <button type="submit" className="bg-gray-800 text-white px-4 py-2 rounded hover:bg-gray-700 dark:bg-slate-700 dark:hover:bg-slate-600 transition-colors">
                            Preview UUID
                        </button>
                    </form>
                    {searchParams?.uuid && (
                        <div className="mt-6">
                            <PreviewClient manualUuid={getParam(searchParams.uuid)} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
