'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Ends every session and disconnects every connected AI app. True when the server confirmed it. */
export async function requestSignOutEverywhere(fetchFn: FetchFn = fetch): Promise<boolean> {
    try {
        const res = await fetchFn('/api/auth/sign-out-everywhere', { method: 'POST' });
        return res.ok;
    } catch {
        return false;
    }
}

interface PanelProps {
    confirming: boolean;
    busy: boolean;
    error: string;
    onStart: () => void;
    onCancel: () => void;
    onConfirm: () => void;
}

/** Two steps: the first click only asks; the second, on the danger button, signs out. */
export function SignOutEverywherePanel({ confirming, busy, error, onStart, onCancel, onConfirm }: PanelProps) {
    return (
        <div className="space-y-2 border-t border-border pt-3">
            {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            {confirming ? (
                <>
                    <p className="text-sm">
                        This signs you out of PWUsage on every device, including this one, and disconnects every
                        connected AI app. You’ll sign in again and reconnect the apps you still want.
                    </p>
                    <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="danger" disabled={busy} onClick={onConfirm}>
                            Sign out everywhere
                        </Button>
                        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
                            Cancel
                        </Button>
                    </div>
                </>
            ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-xs text-muted-foreground">
                        Signs you out on every device and disconnects every connected AI app.
                    </p>
                    <Button type="button" variant="outline" onClick={onStart}>
                        Sign out everywhere
                    </Button>
                </div>
            )}
        </div>
    );
}

/** Sign out everywhere, behind a confirmation. On success the session is gone, so leave for the signed-out home page. */
export function SignOutEverywhere() {
    const router = useRouter();
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    async function confirm() {
        setBusy(true);
        setError('');
        if (await requestSignOutEverywhere()) {
            // The cookie is cleared; refresh so no signed-in server data stays rendered.
            router.replace('/');
            router.refresh();
            return;
        }
        setError('Couldn’t sign out everywhere. Try again.');
        setBusy(false);
    }

    return (
        <SignOutEverywherePanel
            confirming={confirming}
            busy={busy}
            error={error}
            onStart={() => { setError(''); setConfirming(true); }}
            onCancel={() => setConfirming(false)}
            onConfirm={() => void confirm()}
        />
    );
}
