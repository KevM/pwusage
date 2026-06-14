'use client';
import { useState } from 'react';
import type { RollupBackfill } from '@/lib/db';
import { Card, CardContent } from '@/components/ui/Card';

export function IndexingStatus({ siteId, backfill }: { siteId: string; backfill: RollupBackfill | null }) {
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);

  if (backfill && (backfill.status === 'pending' || backfill.status === 'running')) {
    const pct = backfill.days_total > 0 ? Math.round((backfill.days_done / backfill.days_total) * 100) : 0;
    return (
      <Card><CardContent className="py-6">
        <p className="font-semibold mb-2 text-foreground">Indexing your history… {pct}%</p>
        <div className="h-2 rounded-full bg-bg-muted overflow-hidden"><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>
        <p className="text-xs opacity-70 mt-2 text-foreground/80">Reconstructed back to {backfill.cursor_date}. This runs in the background; check back later.</p>
      </CardContent></Card>
    );
  }

  const start = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/site/${siteId}/index-history`, { method: 'POST' });
      if (res.ok) setStarted(true);
    } finally { setBusy(false); }
  };

  return (
    <Card><CardContent className="py-8 text-center text-foreground">
      <p className="text-lg font-semibold mb-2">See your full payback history</p>
      <p className="opacity-70 mb-4 text-foreground/80">We can reconstruct your savings back to install. This runs in the background and may take a while.</p>
      {started
        ? <p className="text-sm text-primary">Indexing started — check back soon.</p>
        : <button onClick={start} disabled={busy} className="rounded-md bg-primary text-white px-4 py-2 disabled:opacity-60 hover:bg-primary/95 cursor-pointer font-medium text-sm transition-colors">{busy ? 'Starting…' : 'Index history'}</button>}
    </CardContent></Card>
  );
}
