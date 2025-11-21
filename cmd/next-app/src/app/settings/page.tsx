import { SettingsRepo } from '@/lib/settings-repo';
import { updateBillingStartDay } from './actions';
import Link from 'next/link';

export default async function SettingsPage() {
    const repo = new SettingsRepo();
    const currentDay = repo.getBillingStartDay();

    return (
        <div className="flex min-h-screen flex-col items-center p-24">
            <div className="w-full max-w-2xl">
                <Link href="/" className="text-blue-600 hover:underline mb-8 block">&larr; Back to Dashboard</Link>

                <h1 className="text-3xl font-bold mb-8">Settings</h1>

                <div className="bg-white dark:bg-slate-900 p-6 rounded shadow border dark:border-slate-800">
                    <h2 className="text-xl font-semibold mb-4">Billing Configuration</h2>

                    <form action={updateBillingStartDay} className="space-y-4">
                        <div>
                            <label htmlFor="billingStartDay" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                Billing Start Day
                            </label>
                            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">
                                The day of the month your billing cycle begins (1-31).
                            </p>
                            <input
                                type="number"
                                id="billingStartDay"
                                name="billingStartDay"
                                defaultValue={currentDay}
                                min="1"
                                max="31"
                                className="block w-full rounded-md border-gray-300 dark:border-slate-700 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-2 border dark:bg-slate-800 dark:text-white"
                            />
                        </div>

                        <button
                            type="submit"
                            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition-colors"
                        >
                            Save Settings
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
}
