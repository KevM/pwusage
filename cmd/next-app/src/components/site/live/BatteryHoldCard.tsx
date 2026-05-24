'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { SectionCard } from '@/components/ui/SectionCard';
import { Button } from '@/components/ui/Button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/Alert';
import { holdButtonLabel } from './battery-hold-format';

interface ActiveHold {
  target_reserve: number;
  original_reserve: number;
  created_at: string;
}

interface Props {
  siteId: string;
  soc: number | null;
  hasTariff: boolean;
  initialHold: ActiveHold | null;
}

export function BatteryHoldCard({ siteId, soc, hasTariff, initialHold }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);

  async function call(action: 'park' | 'restore') {
    setBusy(true); setError(null); setNeedsReauth(false);
    try {
      const res = await fetch(`/api/site/${siteId}/battery-hold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        if (body?.error === 'needs_reauth') { setNeedsReauth(true); return; }
      }
      if (!res.ok) { setError('Something went wrong. Try again.'); return; }
      router.refresh();
    } catch {
      setError('Network error. Try again.');
    } finally {
      setBusy(false);
    }
  }

  let body: React.ReactNode;
  if (needsReauth) {
    body = (
      <Alert variant="warning">
        <AlertTitle>Reconnect Tesla</AlertTitle>
        <AlertDescription>
          Battery control needs the energy command permission.{' '}
          <Link href="/login" className="underline">Reconnect your Tesla account</Link>.
        </AlertDescription>
      </Alert>
    );
  } else if (initialHold) {
    body = (
      <div className="space-y-3">
        <p className="text-sm">
          Holding at <strong>{initialHold.target_reserve === 100 ? '100% (max)' : `${initialHold.target_reserve}%`}</strong>.
          Auto-restores to {initialHold.original_reserve}% when charging ends, or after the safety window.
        </p>
        <Button variant="outline" disabled={busy} onClick={() => call('restore')}>
          {busy ? 'Restoring…' : 'Restore now'}
        </Button>
      </div>
    );
  } else if (!hasTariff || soc === null) {
    body = <p className="text-sm text-gray-500">Battery hold is unavailable until live battery data is present.</p>;
  } else {
    body = (
      <div className="space-y-3">
        <p className="text-sm">
          Parks the Powerwall at its current level so a large load (e.g. EV charging) draws from solar/grid instead of the battery.
        </p>
        <Button disabled={busy} onClick={() => call('park')}>
          {busy ? 'Holding…' : holdButtonLabel(soc)}
        </Button>
      </div>
    );
  }

  return (
    <SectionCard title="Hold battery for charging" density="compact">
      {body}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </SectionCard>
  );
}
