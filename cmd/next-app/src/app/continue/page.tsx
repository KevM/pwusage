import Link from 'next/link';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-checks';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { safeInternalPath, isIOSUserAgent } from './continue-logic';

export const dynamic = 'force-dynamic';

/**
 * General auth interstitial for deep links / QR codes.
 *
 * Deep links point here (`/continue?to=<internal-path>`) instead of straight at
 * a gated page. If the visitor has a session we forward them invisibly. If not,
 * we explain why and offer device-aware mitigations rather than silently
 * bouncing to Tesla OAuth.
 *
 * The motivating case: the iOS lock-screen / Control Center QR scanner opens
 * links in an ephemeral context with no access to the Safari cookie jar, so
 * `site_auth` is simply absent there. Scanning with the Camera app uses real
 * Safari (with the session) instead -- which is the mitigation we surface.
 */
export default async function ContinuePage({
  searchParams,
}: {
  searchParams: Promise<{ to?: string }>;
}) {
  const { to } = await searchParams;
  const target = safeInternalPath(to);

  // Signed in -> forward straight to the destination. The target page runs its
  // own per-site access check, so we only need "is there a session" here.
  const user = await getCurrentUser();
  if (user) {
    redirect(target);
  }

  const ua = (await headers()).get('user-agent');
  const ios = isIOSUserAgent(ua);
  const signInHref = `/login?callback=${encodeURIComponent(target)}`;

  return (
    <PageShell maxWidth="xl" className="flex items-center justify-center">
      <SectionCard className="w-full" title="Sign in to continue" description="We couldn't find your session on this device.">
        <div className="space-y-4">
          {ios ? (
            <Alert variant="warning">
              <AlertTitle>Opened from the lock-screen scanner?</AlertTitle>
              <AlertDescription>
                The iPhone/iPad lock-screen and Control Center QR scanner opens links in a private window that can&apos;t see your sign-in. Scan the QR code with the <strong>Camera app</strong> instead so it opens in Safari with your session.
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="warning">
              <AlertTitle>No session found</AlertTitle>
              <AlertDescription>
                Your browser may be blocking cookies or using a private window. Sign in to continue.
              </AlertDescription>
            </Alert>
          )}
          <Link href={signInHref}><Button>Sign in</Button></Link>
        </div>
      </SectionCard>
    </PageShell>
  );
}
