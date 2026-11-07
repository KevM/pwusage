import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import QRCode from 'qrcode';

import { Button } from '@/components/ui/Button';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';
import { TESTFLIGHT_APP_STORE_URL, TESTFLIGHT_JOIN_URL } from '@/lib/ios-beta';

const DESCRIPTION =
    'Join the pwusage beta for iPhone and iPad on TestFlight. See live power, track your bill and find the cheapest time to start a job.';

export const metadata: Metadata = {
    title: 'iPhone App Beta | Powerwall Usage',
    description: DESCRIPTION,
    alternates: { canonical: '/ios' },
};

interface Screenshot {
    src: string;
    alt: string;
    title: string;
    caption: string;
}

const SCREENSHOTS: Screenshot[] = [
    {
        src: '/ios/home.png',
        alt: 'The pwusage Home screen showing live solar, Home, grid and Powerwall power, and today’s energy totals',
        title: 'Live power',
        caption: 'See what your solar, Home, grid and Powerwall are doing right now, and how today adds up.',
    },
    {
        src: '/ios/bill.png',
        alt: 'The pwusage Current Bill screen showing the bill so far, an estimate for the end of the billing cycle and an outlook by rate period',
        title: 'Your bill, so far',
        caption: 'Follow your bill through the billing cycle, with an estimate for the end of it by rate period.',
    },
    {
        src: '/ios/smart-shift.png',
        alt: 'The Smart Shift screen recommending charging the car at 5:49 PM for about $5.60 less than starting now',
        title: 'Smart Shift',
        caption: 'Find the cheapest time to start a job, like charging the car, and about how much you save.',
    },
];

const EXTRAS: { title: string; body: string }[] = [
    {
        title: 'Battery Saver',
        body: 'Saves your Powerwall charge for when rates spike, then restores your previous backup reserve.',
    },
    {
        title: 'Widgets and Live Activities',
        body: 'Today’s energy on your Home Screen, and Battery Saver on your Lock Screen while it runs.',
    },
    {
        title: 'Control Center',
        body: 'Turn Battery Saver on or off without opening the app.',
    },
    {
        title: 'iPhone and iPad',
        body: 'Runs on iOS and iPadOS 18 or later.',
    },
];

async function makeJoinQrSvg(): Promise<string> {
    return QRCode.toString(TESTFLIGHT_JOIN_URL, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#ffffff' },
    });
}

function PhoneFrame({ src, alt }: { src: string; alt: string }) {
    return (
        <div className="mx-auto w-full max-w-[16rem] rounded-[2.25rem] border border-gray-300 bg-gray-900 p-1.5 shadow-xl dark:border-gray-700">
            <Image
                src={src}
                alt={alt}
                width={660}
                height={1434}
                sizes="(min-width: 768px) 16rem, 70vw"
                className="h-auto w-full rounded-[1.85rem]"
            />
        </div>
    );
}

function JoinButton() {
    return (
        <a href={TESTFLIGHT_JOIN_URL} target="_blank" rel="noopener noreferrer">
            <Button renderAs="span" size="lg" className="whitespace-nowrap">
                Join the Beta on TestFlight
            </Button>
        </a>
    );
}

export default async function IosPage() {
    const qrSvg = await makeJoinQrSvg();

    return (
        <PageShell maxWidth="xl" padding="relaxed" fullHeight={false}>
            <div className="space-y-16">
                <section className="grid items-center gap-10 lg:grid-cols-[2fr_3fr]">
                    <div className="space-y-6">
                        <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                            Now in beta
                        </div>
                        <h1 className="text-4xl font-bold tracking-tight text-primary sm:text-5xl">
                            pwusage for iPhone and iPad
                        </h1>
                        <p className="max-w-xl text-lg text-gray-700 dark:text-gray-300">
                            Time your heavy energy use for when grid power is cheapest, and save your battery for when
                            rates spike. Everything you use on this site, in your pocket.
                        </p>
                        <div className="flex flex-col items-start gap-3">
                            <JoinButton />
                            <span className="text-sm text-gray-500 dark:text-gray-400">
                                Free · Sign in with your Tesla account
                            </span>
                        </div>
                    </div>
                    <div className="rounded-[1.75rem] border border-gray-300 bg-gray-900 p-2 shadow-xl dark:border-gray-700">
                        <Image
                            src="/ios/ipad-home.png"
                            alt="pwusage on iPad showing live power, today’s energy, the current bill and Smart Shift"
                            width={1376}
                            height={1032}
                            sizes="(min-width: 1024px) 36rem, 92vw"
                            className="h-auto w-full rounded-[1.25rem]"
                            priority
                        />
                    </div>
                </section>

                <section aria-labelledby="ios-features" className="space-y-8">
                    <h2 id="ios-features" className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                        What’s in the app
                    </h2>
                    <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
                        {SCREENSHOTS.map((shot) => (
                            <figure key={shot.src} className="space-y-4">
                                <PhoneFrame src={shot.src} alt={shot.alt} />
                                <figcaption className="space-y-1 text-center">
                                    <div className="font-semibold text-gray-900 dark:text-gray-100">{shot.title}</div>
                                    <p className="text-sm text-gray-600 dark:text-gray-400">{shot.caption}</p>
                                </figcaption>
                            </figure>
                        ))}
                    </div>
                    <dl className="grid gap-4 sm:grid-cols-2">
                        {EXTRAS.map((extra) => (
                            <div
                                key={extra.title}
                                className="rounded-xl border border-gray-200 bg-bg-base p-4 dark:border-gray-700"
                            >
                                <dt className="font-semibold text-gray-900 dark:text-gray-100">{extra.title}</dt>
                                <dd className="mt-1 text-sm text-gray-600 dark:text-gray-400">{extra.body}</dd>
                            </div>
                        ))}
                    </dl>
                </section>

                <SectionCard title="How to join the beta">
                    <div className="grid gap-8 md:grid-cols-[1fr_auto] md:items-center">
                        <ol className="list-decimal space-y-3 pl-5 text-gray-700 dark:text-gray-300">
                            <li>
                                Install{' '}
                                <a
                                    href={TESTFLIGHT_APP_STORE_URL}
                                    className="text-primary underline"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    TestFlight
                                </a>{' '}
                                from the App Store on your iPhone or iPad.
                            </li>
                            <li>
                                Open the{' '}
                                <a
                                    href={TESTFLIGHT_JOIN_URL}
                                    className="text-primary underline"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    beta invite
                                </a>{' '}
                                on that device, then tap Accept and Install.
                            </li>
                            <li>Open pwusage and sign in with the same Tesla account you use on this site.</li>
                        </ol>
                        <div className="hidden flex-col items-center gap-2 md:flex">
                            <div
                                className="w-36 rounded-lg bg-white p-2 shadow-sm"
                                role="img"
                                aria-label="QR code for the pwusage TestFlight invite"
                                dangerouslySetInnerHTML={{ __html: qrSvg }}
                            />
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                                On a computer? Scan with your iPhone camera.
                            </span>
                        </div>
                    </div>
                    <p className="mt-6 text-sm text-gray-600 dark:text-gray-400">
                        No Tesla account yet? Tap Try the Demo on the sign-in screen to explore a sample home.
                    </p>
                </SectionCard>

                <SectionCard title="About the beta" bodyClassName="space-y-3 text-gray-700 dark:text-gray-300">
                    <p>
                        This is a test version, so expect rough edges. TestFlight lets you know when a new build is
                        ready.
                    </p>
                    <p>
                        Send feedback from TestFlight, on{' '}
                        <a
                            href="https://discord.gg/KCweVtVNAB"
                            className="text-primary underline"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Discord
                        </a>
                        , or by email at{' '}
                        <a href="mailto:support@fm.rodeo" className="text-primary underline">
                            support@fm.rodeo
                        </a>
                        . The <Link href="/support" className="text-primary underline">support page</Link> lists what to
                        include in a report.
                    </p>
                </SectionCard>

                <div className="flex justify-center">
                    <JoinButton />
                </div>
            </div>
        </PageShell>
    );
}
