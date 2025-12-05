import { db } from '@/lib/db';
import { PreviewClient } from './client';

export const dynamic = 'force-dynamic';

export default function Page() {
    // Get the first access token for testing
    const row = db.prepare('SELECT access_token FROM TrmnlInstallation LIMIT 1').get() as { access_token: string } | undefined;
    const token = row?.access_token;

    return (
        <div className="p-8">
            <h1 className="text-2xl font-bold mb-6">Trmnl View Preview</h1>
            {token ? (
                <PreviewClient token={token} />
            ) : (
                <div className="text-red-500">
                    No Trmnl installation found. Please install the plugin first.
                </div>
            )}
        </div>
    );
}
