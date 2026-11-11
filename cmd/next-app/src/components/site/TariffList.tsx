import { Fragment } from 'react';
import type { SiteTariffsTimelineResponse, TariffPeriodDTO, TariffPeriodName, TimePeriodWindowInput } from '@/lib/tariff-contract';
import { addCalendarDays } from '@/lib/tariff-timeline';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/Table';
import { Button } from '@/components/ui/Button';

interface TariffListProps {
  timeline: SiteTariffsTimelineResponse | null;
  onRefresh: () => Promise<void>;
  refreshLoading: boolean;
  refreshStatus: { type: 'success' | 'error'; message: string } | null;
  onRetryReattribution?: () => Promise<void>;
  retryLoading?: boolean;
}

const PERIOD_LABELS: Record<TariffPeriodName, string> = {
  ON_PEAK: 'Peak',
  PARTIAL_PEAK: 'Partial-Peak',
  OFF_PEAK: 'Off-Peak',
  SUPER_OFF_PEAK: 'Super Off-Peak',
};

function formatRate(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 5,
    }).format(value);
  } catch {
    return `$${value.toFixed(5).replace(/0+$/, '').replace(/\.$/, '.00')}`;
  }
}

function formatEffectiveDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatEffectiveRange(from: string, to: string | null): string {
  return `${formatEffectiveDate(from)} – ${to ? formatEffectiveDate(to) : 'Present'}`;
}

function formatMonthName(month: number): string {
  return new Date(Date.UTC(2000, month - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
}

function formatSeasonRange(fromMonth: number, toMonth: number): string {
  if (fromMonth === 1 && toMonth === 12) return 'Jan – Dec';
  return `${formatMonthName(fromMonth)} – ${formatMonthName(toMonth)}`;
}

function formatClockTime(hour: number, minute: number): string {
  const normalizedHour = hour === 24 ? 0 : hour;
  const suffix = normalizedHour >= 12 ? 'PM' : 'AM';
  const displayHour = normalizedHour % 12 === 0 ? 12 : normalizedHour % 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function formatWindowRange(w: TimePeriodWindowInput): string {
  if (w.fromHour === 0 && w.fromMinute === 0 && ((w.toHour === 24 && w.toMinute === 0) || (w.toHour === 0 && w.toMinute === 0))) {
    return 'All day';
  }
  return `${formatClockTime(w.fromHour, w.fromMinute)} – ${formatClockTime(w.toHour, w.toMinute)}`;
}

function formatAuthor(period: TariffPeriodDTO): string | null {
  if (!period.updatedBy) return null;
  if (period.updatedBy.isCurrentUser) return 'Edited by you';
  if (period.updatedBy.email) return `Edited by ${period.updatedBy.email}`;
  return 'Edited by former member';
}

function computeGapBetween(newer: TariffPeriodDTO, older: TariffPeriodDTO): { from: string; to: string } | null {
  if (!older.effectiveTo) return null;
  const gapStart = addCalendarDays(older.effectiveTo, 1);
  const gapEnd = addCalendarDays(newer.effectiveFrom, -1);
  if (gapStart > gapEnd) return null;
  return { from: gapStart, to: gapEnd };
}

export function TariffList({
  timeline,
  onRefresh,
  refreshLoading,
  refreshStatus,
  onRetryReattribution,
  retryLoading = false,
}: TariffListProps) {
  const currency = timeline?.currency || 'USD';
  const periods = timeline?.periods ?? [];
  const reattribution = timeline?.reattribution ?? null;
  const differsFromManual = timeline?.teslaSync.differsFromActiveManual ?? false;

  const syncButton = (
    <Button
      onClick={onRefresh}
      disabled={refreshLoading}
      size="sm"
      className="gap-2 shrink-0"
    >
      {refreshLoading ? (
        <>
          <span className="inline-block animate-spin">⟳</span>
          Syncing...
        </>
      ) : (
        'Sync from Tesla'
      )}
    </Button>
  );

  const headerIntro = (
    <div className="space-y-3 pb-4 mb-4 border-b border-gray-100 dark:border-slate-800">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Rates sync from your Powerwall settings in the Tesla app. You can create or edit custom historical rate plans in the PWUsage iOS app.
        </p>
        {refreshStatus && (
          <div
            className={`p-2 rounded text-xs shrink-0 ${
              refreshStatus.type === 'success'
                ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200'
                : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200'
            }`}
          >
            {refreshStatus.message}
          </div>
        )}
      </div>

      {reattribution && (reattribution.status === 'pending' || reattribution.status === 'running') && (
        <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/70 dark:bg-blue-900/20 px-3 py-2 text-xs text-blue-900 dark:text-blue-200">
          Updating historical rates · {reattribution.processedDays} of {reattribution.totalDays} days
        </div>
      )}

      {reattribution && reattribution.status === 'failed' && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50/80 dark:bg-red-900/20 px-3 py-2 text-xs text-red-900 dark:text-red-200">
          <span>Could not finish updating history. Retry to recalculate affected days.</span>
          {onRetryReattribution && (
            <Button
              size="sm"
              variant="outline"
              disabled={retryLoading}
              onClick={onRetryReattribution}
            >
              {retryLoading ? 'Retrying...' : 'Retry'}
            </Button>
          )}
        </div>
      )}

      {differsFromManual && (
        <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          Tesla reported different rounded rates ({timeline?.teslaSync.latestTariffName || 'Utility Plan'}). Your custom rate plan remains active.
        </div>
      )}
    </div>
  );

  if (!timeline || periods.length === 0) {
    return (
      <Card>
        <CardHeader action={syncButton}>
          <CardTitle>Rate Plan</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {headerIntro}
          <p className="text-gray-500 dark:text-gray-400">
            No rate plan found for this site yet. Sync from Tesla or add a custom rate plan in the PWUsage iOS app.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader action={syncButton}>
        <CardTitle>Rate Plan</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {headerIntro}
        <div className="space-y-6">
          {periods.map((period, index) => {
            const older = index + 1 < periods.length ? periods[index + 1] : null;
            const gap = older ? computeGapBetween(period, older) : null;
            const author = formatAuthor(period);
            const metadataParts = [
              formatEffectiveRange(period.effectiveFrom, period.effectiveTo),
              ...(author ? [author] : []),
            ];

            return (
              <Fragment key={period.periodId}>
                <Card className="border-gray-200 dark:border-slate-700 shadow-sm">
                  <CardHeader
                    className="pb-3 border-b border-gray-100 dark:border-slate-800"
                    action={
                      <div className="flex flex-wrap items-center gap-2">
                        {period.isCurrentToday && (
                          <span className="inline-flex items-center rounded-full bg-green-100 dark:bg-green-900/30 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:text-green-200">
                            Active today
                          </span>
                        )}
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            period.source === 'manual'
                              ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-200'
                              : 'bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-gray-300'
                          }`}
                        >
                          {period.source === 'manual' ? 'Custom' : 'Synced from Tesla'}
                        </span>
                      </div>
                    }
                  >
                    <div className="space-y-1">
                      <CardTitle className="text-lg font-semibold">{period.name}</CardTitle>
                      <p className="text-xs text-gray-600 dark:text-gray-300">
                        {metadataParts.join(' · ')}
                      </p>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-4 space-y-4">
                    {period.seasons.map((season, sIndex) => {
                      const rows: Array<{ key: string; days: string; window: TimePeriodWindowInput }> = [
                        ...season.weekdayPeriods.map((window, wIndex) => ({
                          key: `wd-${wIndex}`,
                          days: 'Mon – Fri',
                          window,
                        })),
                        ...season.weekendPeriods.map((window, wIndex) => ({
                          key: `we-${wIndex}`,
                          days: 'Sat – Sun',
                          window,
                        })),
                      ];

                      return (
                        <div
                          key={`${period.periodId}-season-${sIndex}`}
                          className="rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden"
                        >
                          <div className="flex items-center justify-between bg-gray-50 dark:bg-slate-800/60 px-4 py-2 border-b border-gray-200 dark:border-slate-700">
                            <span className="text-sm font-medium text-gray-900 dark:text-white">{season.name}</span>
                            <span className="text-xs text-gray-600 dark:text-gray-300">
                              {formatSeasonRange(season.fromMonth, season.toMonth)}
                            </span>
                          </div>
                          <Table>
                            <TableHeader>
                              <TableRow className="bg-gray-100/70 dark:bg-slate-800/40">
                                <TableHead className="pl-4 text-gray-700 dark:text-gray-300">Rate Period</TableHead>
                                <TableHead className="text-gray-700 dark:text-gray-300">Time</TableHead>
                                <TableHead className="text-gray-700 dark:text-gray-300">Days</TableHead>
                                <TableHead className="text-gray-700 dark:text-gray-300">Buy</TableHead>
                                <TableHead className="pr-4 text-gray-700 dark:text-gray-300">Sell</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody className="divide-y divide-gray-100 dark:divide-slate-800">
                              {rows.map(({ key, days, window }) => (
                                <TableRow key={key}>
                                  <TableCell className="pl-4 font-medium">
                                    {PERIOD_LABELS[window.touName] ?? window.touName}
                                  </TableCell>
                                  <TableCell className="text-gray-700 dark:text-gray-300">
                                    {formatWindowRange(window)}
                                  </TableCell>
                                  <TableCell className="text-gray-700 dark:text-gray-300">
                                    {days}
                                  </TableCell>
                                  <TableCell className="text-red-600 dark:text-red-400">
                                    {formatRate(window.buyRate, currency)}
                                  </TableCell>
                                  <TableCell className="pr-4 text-green-600 dark:text-green-400">
                                    {formatRate(window.sellRate, currency)}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>

                {gap && (
                  <div className="rounded-lg border border-dashed border-gray-300 dark:border-slate-700 bg-gray-50/70 dark:bg-slate-900/40 px-4 py-2 text-xs text-gray-600 dark:text-gray-400">
                    {formatEffectiveDate(gap.from)} – {formatEffectiveDate(gap.to)} · Uses nearest prior plan
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
