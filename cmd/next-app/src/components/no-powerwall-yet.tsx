import Image from 'next/image';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';
import { SectionCard } from '@/components/ui/SectionCard';

export function NoPowerwallYet() {
    return (
        <SectionCard
            className="mx-auto w-full max-w-2xl border-blue-200 bg-gradient-to-br from-blue-50 to-slate-50 dark:border-blue-900/50 dark:from-blue-950/30 dark:to-slate-950/30"
            title="No Tesla Energy Products Found"
            bodyClassName="space-y-4"
        >
            <p className="text-sm text-blue-900/90 dark:text-blue-100/90">
                You are logged in, but your account has no Powerwall or other Tesla Energy site yet. Powerwall Usage is built to help you monitor home energy flow and save money with tariff-aware energy arbitrage.
            </p>

            <div className="mx-auto w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                <Image
                    src="/energy-arbitrage.png"
                    alt="Energy arbitrage: storing excess solar and using it in higher-cost periods"
                    width={512}
                    height={512}
                    className="h-auto w-full"
                />
            </div>

            <p className="text-center text-sm text-blue-900/90 dark:text-blue-100/90">
                When you add a Powerwall, log in again and your energy site will appear automatically.
            </p>
            <div className="flex justify-center">
                <Link href="/about">
                    <Button renderAs="span" variant="primary">
                        Learn how pwusage saves money
                    </Button>
                </Link>
            </div>
        </SectionCard>
    );
}
