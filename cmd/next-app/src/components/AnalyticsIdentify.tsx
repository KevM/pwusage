'use client';

import { useEffect } from 'react';
import { identify } from '@/lib/analytics';

interface Props {
  userId: string | null;
  email: string | null;
}

export function AnalyticsIdentify({ userId, email }: Props) {
  useEffect(() => {
    if (!userId) return;
    const traits: Record<string, string> = {};
    if (email) traits.email = email;
    identify(userId, traits);
  }, [userId, email]);

  return null;
}
