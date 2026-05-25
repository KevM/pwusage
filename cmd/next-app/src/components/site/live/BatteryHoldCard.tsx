'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import Link from 'next/link';
import { SectionCard } from '@/components/ui/SectionCard';
import { Button } from '@/components/ui/Button';
import { Alert, AlertDescription } from '@/components/ui/Alert';
import { planReserve } from '@/lib/battery-hold-rules';
import { holdButtonLabel, holdReserveText, guardNoticeText } from './battery-hold-format';
import { ConfirmHoldModal, type HoldChoice } from './ConfirmHoldModal';

interface ActiveHold {
  mode: 'auto' | 'timer';
  target_reserve: number;
  original_reserve: number;
  created_at: string;
  safety_expires_at: string;
}

interface Notice {
  current: number;
}

interface Props {
  siteId: string;
  soc: number | null;
  hasTariff: boolean;
  initialHold: ActiveHold | null;
  initialNotice: Notice | null;
}

export function BatteryHoldCard({ siteId, soc, hasTariff, initialHold, initialNotice }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [showHoldModal, setShowHoldModal] = useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(initialNotice);

  async function post(payload: Record<string, unknown>): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    const res = await fetch(`/api/site/${siteId}/battery-hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && body?.error === 'needs_reauth') { setNeedsReauth(true); return { ok: false, body }; }
    if (!res.ok) { setError('Something went wrong. Try again.'); return { ok: false, body }; }
    return { ok: true, body };
  }

  async function park(choice: HoldChoice) {
    setBusy(true); setError(null); setNeedsReauth(false);
    try {
      const { ok } = await post({ action: 'park', ...choice });
      if (ok) { setShowHoldModal(false); router.refresh(); }
    } catch { setError('Network error. Try again.'); } finally { setBusy(false); }
  }

  async function restore() {
    setBusy(true); setError(null); setNeedsReauth(false);
    try {
      const { ok, body } = await post({ action: 'restore' });
      if (ok) {
        setShowRestoreConfirm(false);
        if (body?.status === 'reserve_changed') setNotice({ current: Number(body.current) });
        router.refresh();
      }
    } catch { setError('Network error. Try again.'); } finally { setBusy(false); }
  }

  async function dismissNotice() {
    setNotice(null);
    try { await post({ action: 'dismiss' }); router.refresh(); } catch { /* notice already hidden */ }
  }

  let body: React.ReactNode;
  if (needsReauth) {
    body = (
      <Alert variant="warning">
        <AlertDescription>
          Battery control needs the energy command permission.{' '}
          <Link href="/login" className="underline">Reconnect your Tesla account</Link>.
        </AlertDescription>
      </Alert>
    );
  } else if (initialHold) {
    const restores = initialHold.mode === 'timer'
      ? `restores at ${new Date(initialHold.safety_expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : 'auto-restores when charging ends, or after the safety window';
    body = (
      <div className="space-y-3">
        <p className="text-sm">
          Holding at <strong>{holdReserveText(initialHold.target_reserve)}</strong>. It {restores} (to {initialHold.original_reserve}%).
        </p>
        <Button variant="outline" disabled={busy} onClick={() => setShowRestoreConfirm(true)}>Restore now</Button>
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
        <Button disabled={busy} onClick={() => setShowHoldModal(true)}>{holdButtonLabel(soc)}</Button>
      </div>
    );
  }

  return (
    <SectionCard title="Hold battery for charging" density="compact">
      {notice && (
        <Alert variant="warning" className="mb-3">
          <AlertDescription>
            {guardNoticeText(notice.current)}{' '}
            <button onClick={dismissNotice} className="underline">Dismiss</button>
          </AlertDescription>
        </Alert>
      )}
      {body}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      <p className="mt-3 text-[11px] text-gray-400 leading-normal italic">
        Note: The official Tesla app caches settings aggressively. You may need to force-restart it to see updated reserve levels.
      </p>

      {showHoldModal && soc !== null && (
        <ConfirmHoldModal
          soc={soc}
          plan={planReserve(soc)}
          busy={busy}
          onConfirm={park}
          onClose={() => setShowHoldModal(false)}
        />
      )}

      {showRestoreConfirm && initialHold && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl p-6 w-full max-w-sm">
            <h3 className="text-lg font-bold mb-3">Restore reserve?</h3>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
              This ends the hold and sets the backup reserve back to {initialHold.original_reserve}%.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setShowRestoreConfirm(false)}>Cancel</Button>
              <Button disabled={busy} onClick={restore}>{busy ? 'Restoring…' : 'Restore'}</Button>
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
