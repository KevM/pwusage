'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import type { ReservePlan } from '@/lib/battery-hold-rules';
import { holdReserveText } from './battery-hold-format';

export interface HoldChoice {
  mode: 'auto' | 'timer';
  durationHours?: number;
  reserveChoice?: 80 | 100;
}

interface Props {
  soc: number;
  plan: ReservePlan;
  busy?: boolean;
  onConfirm: (choice: HoldChoice) => void;
  onClose: () => void;
}

const DURATION_CHIPS = [2, 4, 6, 8] as const;

export function ConfirmHoldModal({ soc, plan, busy = false, onConfirm, onClose }: Props) {
  const [reserveChoice, setReserveChoice] = useState<80 | 100>(plan.options ? 100 : (plan.target as 80 | 100));
  const [mode, setMode] = useState<'auto' | 'timer'>('auto');
  const [hours, setHours] = useState<number>(4);

  const effectiveTarget = plan.ambiguous ? reserveChoice : plan.target;

  function confirm() {
    onConfirm({
      mode,
      durationHours: mode === 'timer' ? hours : undefined,
      reserveChoice: plan.ambiguous ? reserveChoice : undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-2xl p-6 w-full max-w-md">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white">Hold battery for charging</h3>
          <button onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-900 dark:hover:text-white text-2xl leading-none">&times;</button>
        </div>

        <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
          Battery at {Math.floor(soc)}%. While held, the Powerwall draws the load from solar/grid instead of discharging.
        </p>

        {plan.ambiguous && (
          <fieldset className="mb-4">
            <legend className="text-sm font-medium mb-1">Reserve</legend>
            <p className="text-xs text-gray-500 mb-2">
              80% lets the battery serve the load down to 80%, then holds. 100% holds completely (no discharge).
            </p>
            <div className="flex gap-2">
              {([80, 100] as const).map(v => (
                <label key={v} className={`flex-1 cursor-pointer rounded-md border px-3 py-2 text-sm text-center ${reserveChoice === v ? 'border-primary bg-primary/10 font-semibold' : 'border-gray-300 dark:border-gray-600'}`}>
                  <input type="radio" name="reserve" className="sr-only" checked={reserveChoice === v} onChange={() => setReserveChoice(v)} />
                  {holdReserveText(v)}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <fieldset className="mb-4">
          <legend className="text-sm font-medium mb-2">Duration</legend>
          <label className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm mb-2 cursor-pointer ${mode === 'auto' ? 'border-primary bg-primary/10' : 'border-gray-300 dark:border-gray-600'}`}>
            <input type="radio" name="mode" checked={mode === 'auto'} onChange={() => setMode('auto')} />
            Auto-detect (restores when charging ends)
          </label>
          <label className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer ${mode === 'timer' ? 'border-primary bg-primary/10' : 'border-gray-300 dark:border-gray-600'}`}>
            <input type="radio" name="mode" checked={mode === 'timer'} onChange={() => setMode('timer')} />
            Fixed duration
          </label>

          {mode === 'timer' && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {DURATION_CHIPS.map(h => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHours(h)}
                  className={`rounded-full border px-3 py-1 text-sm ${hours === h ? 'border-primary bg-primary/10 font-semibold' : 'border-gray-300 dark:border-gray-600'}`}
                >
                  {h}h
                </button>
              ))}
              <label className="flex items-center gap-1 text-sm">
                <span className="text-gray-500">custom</span>
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={hours}
                  onChange={e => setHours(Math.max(1, Math.min(24, Number(e.target.value) || 1)))}
                  className="w-16 rounded-md border border-gray-300 dark:border-gray-600 bg-transparent px-2 py-1"
                />
                <span className="text-gray-500">h</span>
              </label>
            </div>
          )}
        </fieldset>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={confirm} disabled={busy}>
            {busy ? 'Holding…' : `Hold at ${holdReserveText(effectiveTarget)}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
