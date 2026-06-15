'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RollupBackfill } from '@/lib/db';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { isBackfillInProcess, isTerminalBackfillError } from '@/lib/roi/savings-status';

const REFRESH_MS = 3 * 60 * 1000; // 3 min: let progress advance without a manual reload

export function IndexingStatus({ siteId, backfill }: { siteId: string; backfill: RollupBackfill | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);

  const inProcess = isBackfillInProcess(backfill);
  const terminal = isTerminalBackfillError(backfill);
  const shouldRefresh = inProcess && !terminal;

  useEffect(() => {
    if (!shouldRefresh) return;
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [shouldRefresh, router]);

  if (inProcess && backfill) {
    const pct = backfill.days_total > 0 ? Math.round((backfill.days_done / backfill.days_total) * 100) : 0;
    const isError = backfill.status === 'error';
    return (
      <Card><CardContent className="py-6">
        <p className="font-semibold mb-2 text-foreground">Indexing your history… {pct}%</p>
        <div className="h-2 rounded-full bg-bg-muted overflow-hidden"><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>
        {!isError && (
          <p className="text-xs opacity-70 mt-2 text-foreground/80">Reconstructed back to {backfill.cursor_date}. This runs in the background; check back later.</p>
        )}
        {isError && !terminal && (
          <p className="text-xs mt-2 text-amber-700 dark:text-amber-300">Paused — will retry automatically. Reconstructed back to {backfill.cursor_date}.</p>
        )}
        {isError && terminal && (
          <p className="text-xs mt-2 text-amber-700 dark:text-amber-300">Reconstruction paused — contact support to resume. Reconstructed back to {backfill.cursor_date}.</p>
        )}
      </CardContent></Card>
    );
  }

  const start = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/site/${siteId}/index-history`, { method: 'POST' });
      if (res.ok) {
        setStarted(true);
        router.refresh();
      }
    } finally { setBusy(false); }
  };

  return (
    <Card><CardContent className="py-8 text-center text-foreground">
      <p className="text-lg font-semibold mb-2">See your full payback history</p>
      <p className="opacity-70 mb-4 text-foreground/80">We can reconstruct your savings back to install. This runs in the background and may take a while.</p>
      {started
        ? <p className="text-sm text-primary">Indexing started — check back soon.</p>
        : <Button onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Index history'}</Button>}
    </CardContent></Card>
  );
}
