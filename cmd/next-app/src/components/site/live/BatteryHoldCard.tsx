'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { drawQrWithLogo } from '@/lib/qr-generator';
import { continueUrl } from '@/app/continue/continue-logic';
import { SectionCard } from '@/components/ui/SectionCard';
import { Button } from '@/components/ui/Button';
import { Alert, AlertDescription } from '@/components/ui/Alert';
import { planReserve } from '@/lib/battery-hold-rules';
import { holdButtonLabel, holdReserveText, guardNoticeText } from './battery-hold-format';
import { ConfirmHoldModal, type HoldChoice } from './ConfirmHoldModal';
import { useToast } from '@/components/ui/Toast';

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
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [showHoldModal, setShowHoldModal] = useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(initialNotice);

  // Auto-trigger hold modal if ?action=park is passed in the URL (via QR code)
  useEffect(() => {
    if (searchParams.get('action') === 'park' && soc !== null && !initialHold && !needsReauth) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowHoldModal(true);
    }
  }, [searchParams, soc, initialHold, needsReauth]);

  // Callback ref to render QR code with centered logo as soon as canvas mounts
  const canvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    if (canvas) {
      // Route through the /continue auth gate rather than linking straight at
      // the gated live page. If the scanner has the session it forwards
      // invisibly; if not (e.g. opened from the iOS lock-screen scanner, which
      // has no cookie jar) it shows mitigations instead of a confusing reauth.
      const deepLink = continueUrl(window.location.origin, `/site/${siteId}/live?action=park`);
      drawQrWithLogo(canvas, deepLink)
        .catch(err => console.error('Error generating QR code:', err));
    }
  }, [siteId]);

  async function post(payload: Record<string, unknown>): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    const res = await fetch(`/api/site/${siteId}/battery-hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409 && body?.error === 'needs_reauth') { setNeedsReauth(true); return { ok: false, body }; }
    if (res.status === 422 && body?.error === 'needs_choice') { setError('A reserve choice is required.'); return { ok: false, body }; }
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
        <div className="flex gap-2 items-center flex-wrap">
          <Button variant="outline" disabled={busy} onClick={() => setShowRestoreConfirm(true)}>Restore now</Button>
          <Button variant="outline" size="sm" onClick={() => setShowQrModal(true)}>QR Code</Button>
        </div>
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
        <div className="flex gap-2 items-center flex-wrap">
          <Button disabled={busy} onClick={() => setShowHoldModal(true)}>{holdButtonLabel(soc)}</Button>
          <Button variant="outline" size="sm" onClick={() => setShowQrModal(true)}>QR Code</Button>
        </div>
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

      {showQrModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl p-6 w-full max-w-sm flex flex-col items-center">
            <h3 className="text-lg font-bold mb-1 text-gray-900 dark:text-gray-100">QR Code</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mb-4 text-center">
              Scan this QR code with your mobile device to open this page and automatically initiate a battery hold.
            </p>
            
            <div className="bg-white p-3 rounded-lg border border-gray-100 dark:border-gray-800 shadow-sm mb-4">
              <canvas ref={canvasRef} className="w-48 h-48" />
            </div>

            <div className="flex gap-2 w-full">
              <Button 
                variant="outline" 
                size="sm" 
                className="flex-1"
                onClick={() => {
                  const deepLink = continueUrl(window.location.origin, `/site/${siteId}/live?action=park`);
                  navigator.clipboard.writeText(deepLink)
                    .then(() => toast({ title: 'Link copied', description: 'Battery Hold link copied to clipboard!', variant: 'success' }))
                    .catch(() => toast({ title: 'Copy failed', description: 'Failed to copy link.', variant: 'danger' }));
                }}
              >
                Copy Link
              </Button>
              <Button variant="primary" size="sm" className="flex-1" onClick={() => setShowQrModal(false)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
