import Image from 'next/image';
import Link from 'next/link';

export function NoPowerwallYet() {
    return (
        <section className="mx-auto w-full max-w-2xl rounded-xl border border-blue-200 bg-gradient-to-br from-blue-50 to-slate-50 p-6 dark:border-blue-900/50 dark:from-blue-950/30 dark:to-slate-950/30">
            <h2 className="text-2xl font-bold text-blue-950 dark:text-blue-100">
                No Tesla Energy Products Found
            </h2>
            <p className="mt-3 text-sm text-blue-900/90 dark:text-blue-100/90">
                You are logged in, but your account has no Powerwall or other Tesla Energy site yet. Powerwall Usage is built to help you monitor home energy flow and save money with tariff-aware energy arbitrage.
            </p>

            <div className="mt-2 mx-auto w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                <Image
                    src="/energy-arbitrage.png"
                    alt="Energy arbitrage: storing excess solar and using it in higher-cost periods"
                    width={512}
                    height={512}
                    className="h-auto w-full"
                />
            </div>

            <p className="mt-4 text-center text-sm text-blue-900/90 dark:text-blue-100/90">
                When you add a Powerwall, log in again and your energy site will appear automatically.
            </p>
            <div className="mt-4 flex justify-center">
                <Link href="/about" className="inline-flex items-center rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
                    Learn how pwusage saves money
                </Link>
            </div>
        </section>
    );
}
