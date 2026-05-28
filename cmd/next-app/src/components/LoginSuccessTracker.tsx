'use client';

import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { track } from '@/lib/analytics';

export function LoginSuccessTracker() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (searchParams.get('login') !== 'success') return;
    const isNew = searchParams.get('new') === '1';
    track('tesla-login-success', { is_reauth: !isNew });

    // Strip the params so refreshes don't re-fire.
    const next = new URLSearchParams(searchParams.toString());
    next.delete('login');
    next.delete('new');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [searchParams, pathname, router]);

  return null;
}
