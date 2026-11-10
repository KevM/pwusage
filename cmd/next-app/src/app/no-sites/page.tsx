import Link from 'next/link';
import { PageShell } from '@/components/ui/PageShell';
import { PageHeader } from '@/components/ui/PageHeader';
import { P } from '@/components/ui/Typography';

export default function NoSitesPage() {
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
