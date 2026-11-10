'use client';

import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Input, Label, Radio } from '@/components/ui/Form';
import { ACCOUNT_DELETE_CONFIRMATION, requestAccountDeletion } from '@/lib/account-deletion-request';

export interface SharedSiteChoice {
    id: string;
    name: string;
    otherMembers: string[];
}

export function AccountDeleteForm({ sharedSites = [] }: { sharedSites?: SharedSiteChoice[] }) {
    // Leaving is the safe default: nobody loses a site unless the user picks that for it.
    const [deleteIds, setDeleteIds] = useState<Set<string>>(new Set());
    const [confirmation, setConfirmation] = useState('');
    const [isDeleting, setIsDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (confirmation !== ACCOUNT_DELETE_CONFIRMATION || isDeleting) return;
        setIsDeleting(true);
        setError(null);
        const result = await requestAccountDeletion([...deleteIds]);
        if (result.ok) {
            window.location.replace('/account-delete/done');
            return;
        }
        setError(result.message);
        setIsDeleting(false);
    }

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
                <Alert variant="danger">
                    <AlertTitle>Account not deleted</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            )}
            {sharedSites.map(site => (
                <fieldset key={site.id} className="space-y-2 rounded-md border border-secondary p-4" disabled={isDeleting}>
                    <legend className="px-1 text-sm font-medium">{site.name} is shared</legend>
                    <p className="text-sm">Also has access: {site.otherMembers.join(', ')}</p>
                    <label className="flex items-start gap-2 text-sm">
                        <Radio
                            name={`site-${site.id}`}
                            checked={!deleteIds.has(site.id)}
                            onChange={() => setDeleteIds(prev => { const next = new Set(prev); next.delete(site.id); return next; })}
                        />
                        <span>Remove me from this site. It stays available to the other members, with its history.</span>
                    </label>
                    <label className="flex items-start gap-2 text-sm">
                        <Radio
                            name={`site-${site.id}`}
                            checked={deleteIds.has(site.id)}
                            onChange={() => setDeleteIds(prev => new Set(prev).add(site.id))}
                        />
                        <span>Delete this site for everyone. The other members lose access and the site&apos;s history is deleted.</span>
                    </label>
                </fieldset>
            ))}
            <div className="space-y-2">
                <Label htmlFor="account-delete-confirmation">
                    Type {ACCOUNT_DELETE_CONFIRMATION} to confirm
                </Label>
                <Input
                    id="account-delete-confirmation"
                    value={confirmation}
                    onChange={event => setConfirmation(event.target.value)}
                    disabled={isDeleting}
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    className="font-mono"
                />
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                {/* A plain link: the cancel route records telemetry, so it must not be prefetched. */}
                <a href="/account-delete/cancel" className="sm:order-first">
                    <Button renderAs="span" variant="outline" className="w-full">Cancel</Button>
                </a>
                <Button
                    type="submit"
                    variant="danger"
                    disabled={confirmation !== ACCOUNT_DELETE_CONFIRMATION || isDeleting}
                >
                    {isDeleting ? 'Deleting Account' : 'Permanently Delete Account'}
                </Button>
            </div>
        </form>
    );
}
