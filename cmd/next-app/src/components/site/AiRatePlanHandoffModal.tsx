'use client';

import { useState, useMemo } from 'react';
import { buildRatePlanAiHandoffMarkdown } from '@/lib/tariff-ai-handoff';
import type {
  SiteTariffsTimelineResponse,
  TariffAiHandoffCommitResponse,
  TariffAiHandoffPreviewResponse,
  TariffPeriodName,
  TariffSelectionPreviewResponse,
} from '@/lib/tariff-contract';
import { Button } from '@/components/ui/Button';

interface AiRatePlanHandoffModalProps {
  timeline: SiteTariffsTimelineResponse;
  isOpen: boolean;
  onClose: () => void;
  onApplied: (nextTimeline: SiteTariffsTimelineResponse) => void;
}

const PERIOD_LABELS: Record<TariffPeriodName, string> = {
  ON_PEAK: 'Peak',
  PARTIAL_PEAK: 'Mid-Peak',
  OFF_PEAK: 'Off-Peak',
  SUPER_OFF_PEAK: 'Super Off-Peak',
};

function formatClock(hour: number, minute: number): string {
  const normalizedHour = hour === 24 ? 0 : hour;
  const suffix = normalizedHour >= 12 ? 'PM' : 'AM';
  const displayHour = normalizedHour % 12 === 0 ? 12 : normalizedHour % 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function renderScopePreviewSection(
  title: string,
  previews: TariffSelectionPreviewResponse[],
  currency: string
) {
  if (previews.length === 0) return null;
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h4>
      {previews.map((preview, pIdx) => (
        <div
          key={`${preview.scope}-${pIdx}`}
          className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 space-y-2 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold text-gray-900 dark:text-white">
              {preview.candidatePlan?.name ?? 'Rate Plan'}
            </span>
            <span className="text-gray-600 dark:text-gray-300">
              {preview.effectiveFrom} – {preview.effectiveTo ?? 'Present'}
            </span>
          </div>
          {preview.affectedIntervals.map((interval, iIdx) => (
            <div
              key={iIdx}
              className="rounded bg-gray-50 dark:bg-slate-800/60 p-2 space-y-1.5 border border-gray-100 dark:border-slate-700"
            >
              <div className="flex flex-wrap justify-between gap-2 font-medium">
                <span>
                  {interval.before ? `Replaces "${interval.before.name}"` : 'Fills uncovered dates'}
                </span>
                <span>
                  {interval.effectiveFrom} – {interval.effectiveTo ?? 'Present'}
                </span>
              </div>
              {interval.seasons.map((season, sIdx) => (
                <div key={sIdx} className="space-y-1 pt-1 border-t border-gray-200/70 dark:border-slate-700">
                  <p className="font-medium text-gray-700 dark:text-gray-300">
                    {season.afterSeasonName ?? season.beforeSeasonName ?? 'Season'} (Months {season.fromMonth}–{season.toMonth})
                  </p>
                  {season.weekdayRows.map((row, rIdx) => (
                    <div key={`wd-${rIdx}`} className="flex flex-wrap justify-between gap-2 text-gray-600 dark:text-gray-300">
                      <span>
                        Mon – Fri · {formatClock(row.fromHour, row.fromMinute)} – {formatClock(row.toHour, row.toMinute)}
                      </span>
                      <span>
                        {row.before
                          ? `${PERIOD_LABELS[row.before.touName]} ${currency} ${row.before.buyRate}/kWh → `
                          : ''}
                        {row.after
                          ? `${PERIOD_LABELS[row.after.touName]} ${currency} ${row.after.buyRate}/kWh (sell ${row.after.sellRate})`
                          : ''}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function AiRatePlanHandoffModal({
  timeline,
  isOpen,
  onClose,
  onApplied,
}: AiRatePlanHandoffModalProps) {
  const [step, setStep] = useState<'export' | 'import'>('export');
  const [copied, setCopied] = useState(false);
  const [rawInput, setRawInput] = useState('');
  const [preview, setPreview] = useState<TariffAiHandoffPreviewResponse | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isAcknowledged, setIsAcknowledged] = useState(false);
  const [isVerifiedAgainstBill, setIsVerifiedAgainstBill] = useState(false);
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const markdown = useMemo(() => buildRatePlanAiHandoffMarkdown(timeline), [timeline]);

  if (!isOpen) return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleDownload = () => {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pwusage-rate-plan-check.md';
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleInputChanged = (value: string) => {
    setRawInput(value);
    setPreview(null);
    setIsAcknowledged(false);
    setIsVerifiedAgainstBill(false);
    setStaleNotice(null);
    setErrorMessage(null);
  };

  const handlePreview = async () => {
    setIsPreviewing(true);
    setErrorMessage(null);
    setStaleNotice(null);
    try {
      const res = await fetch(`/api/site/${timeline.siteId}/tariffs/ai-handoff/preview`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Could not preview rate plan changes.');
        return;
      }
      setPreview(data as TariffAiHandoffPreviewResponse);
      setIsAcknowledged(false);
      setIsVerifiedAgainstBill(false);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not preview rate plan changes.');
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleApply = async () => {
    if (!preview || !isAcknowledged) return;
    setIsApplying(true);
    setErrorMessage(null);
    try {
      const res = await fetch(`/api/site/${timeline.siteId}/tariffs/ai-handoff/commit`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawInput,
          expectedReviewHash: preview.reviewHash,
          verifiedAgainstBill: isVerifiedAgainstBill,
        }),
      });
      const data = await res.json();
      if (res.status === 409 && data.code === 'REVIEW_STALE' && data.preview) {
        setPreview(data.preview as TariffAiHandoffPreviewResponse);
        setIsAcknowledged(false);
        setIsVerifiedAgainstBill(false);
        setStaleNotice(
          data.error ||
            'Your rate plans changed while you were reviewing. Review the updated changes before applying.'
        );
        return;
      }
      if (!res.ok) {
        setErrorMessage(data.error || 'Could not apply rate plan changes.');
        return;
      }
      const committed = data as TariffAiHandoffCommitResponse;
      onApplied(committed.timeline);
      onClose();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Could not apply rate plan changes.');
    } finally {
      setIsApplying(false);
    }
  };

  const hasChanges =
    preview !== null && (preview.actualPreviews.length > 0 || preview.referencePreviews.length > 0);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-handoff-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-xl bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 shadow-xl p-6 space-y-4">
        <div className="flex items-center justify-between border-b border-gray-100 dark:border-slate-800 pb-3">
          <h3 id="ai-handoff-modal-title" className="text-lg font-semibold text-gray-900 dark:text-white">
            Check with Your AI Assistant
          </h3>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="flex gap-2 border-b border-gray-100 dark:border-slate-800 pb-3">
          <Button
            size="sm"
            variant={step === 'export' ? 'primary' : 'outline'}
            onClick={() => setStep('export')}
          >
            1. Export for Your AI Assistant
          </Button>
          <Button
            size="sm"
            variant={step === 'import' ? 'primary' : 'outline'}
            onClick={() => setStep('import')}
          >
            2. Import AI Reply
          </Button>
        </div>

        {step === 'export' ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-900/20 p-3 text-xs text-blue-900 dark:text-blue-200 space-y-1">
              <p className="font-medium">How this works</p>
              <p>
                Copy or download this Markdown document and paste it into your AI assistant. You can also attach a PDF or photo of your utility bill so it can check your exact all-in rates.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={handleCopy}>
                {copied ? 'Copied to clipboard' : 'Copy Markdown'}
              </Button>
              <Button size="sm" variant="outline" onClick={handleDownload}>
                Download .md
              </Button>
              <Button size="sm" variant="outline" onClick={() => setStep('import')}>
                Next: Paste AI Reply
              </Button>
            </div>

            <pre
              aria-label="Exported rate plan Markdown"
              className="max-h-80 overflow-y-auto rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/60 p-3 text-xs font-mono whitespace-pre-wrap text-gray-800 dark:text-gray-200"
            >
              {markdown}
            </pre>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="ai-reply-textarea"
                className="block text-xs font-medium text-gray-700 dark:text-gray-300"
              >
                Paste the reply from your AI assistant (full message or JSON block)
              </label>
              <textarea
                id="ai-reply-textarea"
                rows={7}
                value={rawInput}
                onChange={e => handleInputChanged(e.target.value)}
                placeholder="Paste your AI assistant's response containing the ```json block..."
                className="w-full rounded-lg border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 text-xs font-mono text-gray-900 dark:text-white"
              />
              <div className="flex items-center justify-between gap-2">
                <Button
                  size="sm"
                  onClick={handlePreview}
                  disabled={isPreviewing || rawInput.trim().length === 0}
                >
                  {isPreviewing ? 'Previewing...' : 'Preview Changes'}
                </Button>
              </div>
            </div>

            {errorMessage && (
              <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50/80 dark:bg-red-900/20 px-3 py-2 text-xs text-red-900 dark:text-red-200">
                {errorMessage}
              </div>
            )}

            {staleNotice && (
              <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/80 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                {staleNotice}
              </div>
            )}

            {preview && (
              <div className="space-y-4 border-t border-gray-100 dark:border-slate-800 pt-4">
                {(preview.notes.length > 0 || preview.sources.length > 0) && (
                  <div className="rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50 p-3 text-xs space-y-2">
                    {preview.notes.length > 0 && (
                      <div>
                        <p className="font-semibold text-gray-900 dark:text-white">Notes from your AI assistant</p>
                        <ul className="list-disc pl-4 space-y-0.5 text-gray-700 dark:text-gray-300">
                          {preview.notes.map((n, i) => (
                            <li key={i}>{n}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {preview.sources.length > 0 && (
                      <div>
                        <p className="font-semibold text-gray-900 dark:text-white">Sources</p>
                        <ul className="list-disc pl-4 space-y-0.5 text-gray-700 dark:text-gray-300">
                          {preview.sources.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {!hasChanges ? (
                  <div className="rounded-lg border border-green-200 dark:border-green-800 bg-green-50/70 dark:bg-green-900/20 px-3 py-2 text-xs text-green-900 dark:text-green-200">
                    No rate plan changes found · The imported plans match your current timeline.
                  </div>
                ) : (
                  <>
                    {renderScopePreviewSection('Your Rate Plan Changes', preview.actualPreviews, preview.currency)}
                    {renderScopePreviewSection('Fixed Comparison Plan Changes', preview.referencePreviews, preview.currency)}

                    {preview.actualPreviews.length > 0 && (
                      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                        This changes the rates PWUsage uses for bills and savings estimates. Your Powerwall will continue using the plan saved in Tesla. Check the prices, time periods, export rates, and effective date against your utility bill.
                      </div>
                    )}

                    <div className="space-y-2 text-xs">
                      <label className="flex items-center gap-2 text-gray-800 dark:text-gray-200">
                        <input
                          type="checkbox"
                          checked={isAcknowledged}
                          onChange={e => setIsAcknowledged(e.target.checked)}
                        />
                        <span>I reviewed these changes</span>
                      </label>
                      <label className="flex items-center gap-2 text-gray-800 dark:text-gray-200">
                        <input
                          type="checkbox"
                          checked={isVerifiedAgainstBill}
                          onChange={e => setIsVerifiedAgainstBill(e.target.checked)}
                        />
                        <span>I checked these details against my utility bill</span>
                      </label>
                    </div>

                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        onClick={handleApply}
                        disabled={!isAcknowledged || isApplying}
                      >
                        {isApplying ? 'Applying...' : 'Apply Rate Plan Changes'}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
