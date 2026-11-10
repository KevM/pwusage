import Link from 'next/link';
import { PageShell } from '@/components/ui/PageShell';
import { PageHeader } from '@/components/ui/PageHeader';
import { P } from '@/components/ui/Typography';

export default async function NoSitesPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
    const { reason } = await searchParams;
    // A brand-new Tesla account with no energy products is never stored, so it
    // has no session; say so plainly instead of "no longer has access".
    if (reason === 'no-products') {
        return (
            <PageShell maxWidth="lg">
                <PageHeader title="No Powerwall yet" titleTag="h1" />
                <P>Tesla sign-in succeeded, but this account has no Powerwall or other Tesla Energy site yet. We have not saved anything about this account.</P>
                <P>When you add a Powerwall, sign in again and your energy site will appear automatically.</P>
                <Link href="/login" className="underline">Sign in with another Tesla account</Link>
            </PageShell>
        );
    }
    return (
        <PageShell maxWidth="lg">
            <PageHeader title="No Powerwall access" titleTag="h1" />
            <P>Tesla sign-in succeeded, but this account no longer has access to a Powerwall site.</P>
            <P>If someone removed your access in Tesla, ask them to add you again. Then sign in to pwusage.</P>
            <Link href="/login" className="underline">Sign in with another Tesla account</Link>
            <P className="text-sm text-muted-foreground">
                Not planning to use pwusage? <Link href="/login?callback=/account-delete" prefetch={false} className="text-primary underline">Delete your account</Link>.
            </P>
        </PageShell>
    );
}
