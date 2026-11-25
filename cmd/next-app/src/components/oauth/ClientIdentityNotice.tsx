import type { ClientIdentity } from '@/lib/oauth/client-identity';

function returnLabel(identity: ClientIdentity): string {
    switch (identity.returnTo.kind) {
        case 'web': return identity.returnTo.host;
        case 'device': return 'an app on this device';
        case 'app': return `an app on this device (${identity.returnTo.scheme}://)`;
    }
}

/**
 * Who is asking, as far as PWUsage can tell. The app's name is its own claim,
 * so the screen leads with what PWUsage can check: who published it (if
 * anyone vouches for it) and where your browser goes after Allow.
 */
export function ClientIdentityNotice({ identity }: { identity: ClientIdentity }) {
    return (
        <div className="space-y-1 rounded-md border border-border px-3 py-2 text-sm">
            {identity.verified ? (
                <p>
                    Published by <span className="font-semibold">{identity.publisherHost}</span>
                </p>
            ) : (
                <p>
                    <span className="font-semibold">Unverified app.</span>{' '}
                    PWUsage can’t confirm who made “{identity.name}”. Only continue if you started this connection.
                </p>
            )}
            <p>
                After you allow, you’ll return to <span className="font-semibold">{returnLabel(identity)}</span>
            </p>
            {identity.homepageHost && (
                <p className="text-muted-foreground">Website: {identity.homepageHost}</p>
            )}
        </div>
    );
}
