import Link from 'next/link';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getCurrentUser } from '@/lib/auth-checks';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { Button } from '@/components/ui/Button';
import { safeInternalPath, isIOSUserAgent } from './continue-logic';
import { CameraScanInfographic } from './CameraScanInfographic';

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
    <PageShell maxWidth="xl" fullHeight={false}>
      <SectionCard className="w-full" title="Sign in to continue" description="We couldn't find your session on this device.">
        <div className="space-y-6">
          {/* Primary path: just sign in. */}
          <Link href={signInHref} className="block">
            <Button className="w-full sm:w-auto">Sign in</Button>
          </Link>

          {/* Secondary: for folks who expected to already be signed in. */}
          <div className="space-y-3 border-t border-gray-100 pt-5 dark:border-slate-800">
            {ios ? (
              <>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  Thought you were already logged in? Try scanning the QR code with your <strong className="font-semibold">Camera app</strong> instead.
                </p>
                <CameraScanInfographic />
              </>
            ) : (
              <p className="text-sm text-gray-600 dark:text-gray-300">
                Thought you were already logged in? Your browser may be blocking cookies or using a private window.
              </p>
            )}
          </div>
        </div>
      </SectionCard>
    </PageShell>
  );
}
