'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateBillingStartDay } from '@/app/site/[id]/settings/actions';

interface SiteSetupProps {
    siteId: string;
}

export function SiteSetup({ siteId }: SiteSetupProps) {
    const router = useRouter();
    const [billingDay, setBillingDay] = useState(1);
    const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');
    const [progress, setProgress] = useState<{ current: string, percent: number }>({ current: '', percent: 0 });
    const [error, setError] = useState<string>('');

    const startSetup = async () => {
        setStatus('running');
        setError('');

        try {
            // 1. Save Billing Day using Server Action
            const formData = new FormData();
            formData.append('siteId', siteId);
            formData.append('billingStartDay', billingDay.toString());

            await updateBillingStartDay(formData);

            // 2. Start Import (Current Cycle Only)
            const now = new Date();
            // Determine start of current billing cycle
            let currentCycleStart = new Date(now.getFullYear(), now.getMonth(), billingDay);
            // If today is before billing day (e.g. today 5th, bill day 10th), we are in the cycle that started last month (Nov 10)
            if (now.getDate() < billingDay) {
                currentCycleStart.setMonth(currentCycleStart.getMonth() - 1);
            }

            const start = currentCycleStart;

            // Set end to now
            const end = now;

            const params = new URLSearchParams({
                siteId,
                start: start.toISOString(),
                end: end.toISOString()
            });

            const response = await fetch(`/api/sync?${params.toString()}`, {
                method: 'GET', // api/sync is a GET request
            });

            if (!response.ok) throw new Error('Import failed to start');

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No response stream');

            const decoder = new TextDecoder();
            // Estimate total days
            const totalDays = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
            let processedDays = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));

                            if (data.status === 'progress') {
                                // sync endpoint returns explicit message, but not structured date/percent
                                // We can just parse the date from the message if needed, or just show the message.
                                // The message is usually "Importing YYYY-MM-DD..."
                                const msg = data.message || '';
                                setProgress({ current: msg, percent: 50 }); // Indeterminate progress for now

                                // enhanced parsing if message contains date
                                const dateMatch = msg.match(/\d{4}-\d{2}-\d{2}/);
                                if (dateMatch) {
                                    processedDays++;
                                    const percent = Math.min(100, Math.round((processedDays / totalDays) * 100));
                                    setProgress({ current: dateMatch[0], percent });
                                }
                            } else if (data.status === 'complete') {
                                break;
                            } else if (data.status === 'error') {
                                throw new Error(data.message);
                            }
                        } catch (e) {
                            // ignore json parse errors
                        }
                    }
                }
            }

            setStatus('complete');
            setTimeout(() => {
                window.location.reload();
            }, 1000);
        } catch (err: any) {
            console.error(err);
            setError(err.message || 'An error occurred');
            setStatus('error');
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white dark:bg-zinc-900 p-8 rounded-xl shadow-2xl max-w-md w-full">
                <h2 className="text-2xl font-bold mb-4">Welcome to Powerwall Usage</h2>
                <p className="text-gray-600 dark:text-gray-400 mb-6">
                    It looks like this is a new site. Let's get things set up.
                </p>

                {status === 'idle' && (
                    <form
                        className="space-y-4"
                        onSubmit={(e) => {
                            e.preventDefault();
                            startSetup();
                        }}
                    >
                        <div>
                            <label className="block text-sm font-medium mb-1">Billing Cycle Start Day</label>
                            <input
                                type="number"
                                min="1"
                                max="31"
                                value={billingDay}
                                onChange={(e) => setBillingDay(parseInt(e.target.value))}
                                className="w-full p-2 border rounded dark:bg-zinc-800 dark:border-zinc-700"
                            />
                            <p className="text-xs text-gray-500 mt-1">Day of the month your electricity bill resets.</p>
                        </div>

                        <button
                            type="submit"
                            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded transition-colors"
                        >
                            Initialize & Import Data
                        </button>
                    </form>
                )}

                {status === 'running' && (
                    <div className="space-y-4">
                        <div className="h-4 bg-gray-200 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-blue-600 transition-all duration-300"
                                style={{ width: `${progress.percent}%` }}
                            />
                        </div>
                        <p className="text-center text-sm text-gray-500">
                            Importing data... {progress.current && `(${progress.current})`}
                        </p>
                    </div>
                )}

                {status === 'complete' && (
                    <div className="text-center text-green-600">
                        <p className="text-xl font-bold">Setup Complete!</p>
                        <p>loading dashboard...</p>
                    </div>
                )}

                {status === 'error' && (
                    <div className="text-center">
                        <p className="text-red-500 mb-4">{error}</p>
                        <button
                            onClick={() => setStatus('idle')}
                            className="bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 text-gray-800 dark:text-white font-bold py-2 px-4 rounded"
                        >
                            Try Again
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
