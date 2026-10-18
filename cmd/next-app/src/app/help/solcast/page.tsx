import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';

export const metadata: Metadata = {
    title: 'Set up a Solcast solar forecast | Powerwall Usage',
    description: 'Connect a free Solcast home account so Smart Shift in the pwusage iOS app can compare start times using today\'s solar forecast.',
    alternates: { canonical: '/help/solcast' },
};

const SOLCAST_REGISTER_URL = 'https://toolkit.solcast.com.au/register/hobbyist';
const SOLCAST_TOOLKIT_URL = 'https://toolkit.solcast.com.au';
const SOLCAST_AZIMUTH_URL = 'https://kb.solcast.com.au/azimuth';

const linkClass = 'text-primary underline';

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
    return (
        <li id={`step-${number}`} className="scroll-mt-6">
            <SectionCard
                title={(
                    <span className="flex items-center gap-3">
                        <span
                            aria-hidden="true"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-bg-base"
                        >
                            {number}
                        </span>
                        <span>
                            <span className="sr-only">Step {number}: </span>
                            {title}
                        </span>
                    </span>
                )}
                bodyClassName="space-y-4"
            >
                {children}
            </SectionCard>
        </li>
    );
}

// Stand-in for a real screenshot. `phone` frames are portrait (iOS app),
// `web` frames are landscape (Solcast Toolkit in a browser).
function ScreenshotPlaceholder({ kind, caption }: { kind: 'phone' | 'web'; caption: string }) {
    const frameClass = kind === 'phone'
        ? 'mx-auto aspect-[9/16] w-full max-w-[220px] rounded-[1.75rem]'
        : 'aspect-video w-full rounded-lg';

    return (
        <figure className="space-y-2">
            <div
                role="img"
                aria-label={`Screenshot placeholder: ${caption}`}
                className={`flex items-center justify-center border-2 border-dashed border-foreground/20 bg-foreground/5 p-4 text-center text-sm text-foreground/60 ${frameClass}`}
            >
                Screenshot coming soon
            </div>
            <figcaption className="text-center text-sm text-foreground/70">{caption}</figcaption>
        </figure>
    );
}

// An app message quoted word for word, so readers can match what they see.
function AppMessage({ children }: { children: ReactNode }) {
    return (
        <p className="rounded-md border-l-4 border-primary bg-foreground/5 px-3 py-2 font-medium text-foreground">
            &ldquo;{children}&rdquo;
        </p>
    );
}

function Problem({ title, messages, children }: { title: string; messages: string[]; children: ReactNode }) {
    return (
        <div className="space-y-2">
            <h3 className="font-semibold text-foreground">{title}</h3>
            {messages.map((message) => <AppMessage key={message}>{message}</AppMessage>)}
            <div className="space-y-2">{children}</div>
        </div>
    );
}

export default function SolcastHelpPage() {
    return (
        <PageShell maxWidth="md" padding="default" fullHeight={false}>
            <PageHeader
                title="Add a solar forecast to Smart Shift"
                description="Connect a free Solcast home account and Smart Shift can plan around the sun, not just your current balances. It's optional, and most of the setup happens on Solcast's site."
                className="mb-8"
            />

            <ol className="space-y-6 text-foreground leading-relaxed">
                <Step number={1} title="What Solcast adds">
                    <p>
                        Without a forecast, Smart Shift shows each rate period&apos;s balance as it stands right now.
                        With a Solcast forecast, it can also count the solar your roof is likely to make later today,
                        so it can compare start times knowing when the sun will help.
                    </p>
                    <p>
                        It&apos;s optional: Smart Shift works without it. Solcast is free for home users on its hobbyist plan.
                    </p>
                    <ScreenshotPlaceholder kind="phone" caption="Smart Shift without a forecast, showing the “Connect Solcast” note" />
                </Step>

                <Step number={2} title="Create a free Solcast home account">
                    <p>
                        Go to <a href={SOLCAST_REGISTER_URL} className={linkClass} target="_blank" rel="noopener noreferrer">Solcast&apos;s registration page</a>,
                        choose <strong>Home User</strong>, then tap <strong>Register Now</strong> and fill in the short form.
                        If you&apos;re asked what the account is for, choose the home PV system option.
                    </p>
                    <p>The free home plan includes:</p>
                    <ul className="list-disc space-y-1 pl-6">
                        <li>One home location, with up to two arrays (roof faces).</li>
                        <li>Rooftop solar forecasts for your own, non-commercial use.</li>
                        <li>Up to 10 API requests a day.</li>
                    </ul>
                    <p>
                        Solcast checks that the address is a residential home under 50&nbsp;kW, and may ask for proof that it&apos;s yours.
                    </p>
                    <ScreenshotPlaceholder kind="web" caption="Solcast registration page with the Home User option" />
                </Step>

                <Step number={3} title="Add your rooftop site">
                    <p>
                        Sign in to the <a href={SOLCAST_TOOLKIT_URL} className={linkClass} target="_blank" rel="noopener noreferrer">Solcast Toolkit</a> and
                        add your home PV system. You&apos;ll need four things:
                    </p>
                    <dl className="space-y-3">
                        <div>
                            <dt className="font-semibold">Location</dt>
                            <dd className="text-foreground/80">Your home address (or its latitude and longitude).</dd>
                        </div>
                        <div>
                            <dt className="font-semibold">Capacity (kW)</dt>
                            <dd className="text-foreground/80">
                                The inverter (AC) or panel (DC) rating, whichever is greater. Look for it on your installer&apos;s
                                quote or system paperwork.
                            </dd>
                        </div>
                        <div>
                            <dt className="font-semibold">Tilt</dt>
                            <dd className="text-foreground/80">
                                How steep the panels are, in degrees from flat: 0 is flat, 90 is vertical. Your installer&apos;s
                                design documents usually list it.
                            </dd>
                        </div>
                        <div>
                            <dt className="font-semibold">Azimuth</dt>
                            <dd className="text-foreground/80">
                                The direction the panels face, in degrees from true north. Solcast counts west as positive and
                                east as negative: north is 0, east is −90, west is 90 and south is 180. So south-west is 135
                                and south-east is −135. To estimate it, Solcast suggests{' '}
                                <a href={SOLCAST_AZIMUTH_URL} className={linkClass} target="_blank" rel="noopener noreferrer">measuring on a satellite map</a>;
                                within 5 degrees is close enough.
                            </dd>
                        </div>
                    </dl>
                    <p>
                        <strong>Panels on two roof faces?</strong> Add a second site for the other face. PWUsage supports up to two
                        arrays, the same as Solcast&apos;s home plan. Give the second site exactly the same location as the first:
                        Solcast needs both within 1&nbsp;km of each other.
                    </p>
                    <ScreenshotPlaceholder kind="web" caption="Solcast Toolkit form for adding a home PV system" />
                </Step>

                <Step number={4} title="Copy your API key">
                    <p>
                        In the Toolkit, open the menu under your username and copy your <strong>API key</strong>.
                    </p>
                    <p>
                        Treat it like a password. Don&apos;t post it in Discord, on GitHub or in a screenshot.
                    </p>
                    <ScreenshotPlaceholder kind="web" caption="Toolkit account menu with the API key (blurred)" />
                </Step>

                <Step number={5} title="Connect it in PWUsage">
                    <ol className="list-decimal space-y-2 pl-6">
                        <li>Open <strong>Smart Shift</strong> in the PWUsage app.</li>
                        <li>Tap the <strong>sun button</strong> at the top of the screen to open Solar Forecast settings.</li>
                        <li>
                            Paste your key into <strong>Solcast API key</strong> and tap <strong>Save key</strong>.
                            PWUsage checks the key and looks up your arrays straight away.
                        </li>
                        <li>
                            Turn on the array (or both arrays) that belong to this home. If the list doesn&apos;t appear,
                            tap <strong>Discover arrays</strong>.
                        </li>
                        <li>Tap <strong>Done</strong>.</li>
                    </ol>
                    <p>
                        There&apos;s no Save button for arrays: each one is saved as soon as you turn it on or off.
                    </p>
                    <div className="grid gap-6 sm:grid-cols-2">
                        <ScreenshotPlaceholder kind="phone" caption="The sun button on the Smart Shift screen" />
                        <ScreenshotPlaceholder kind="phone" caption="Solar Forecast settings with a saved key and an array turned on" />
                    </div>
                </Step>

                <Step number={6} title="What to expect">
                    <ul className="list-disc space-y-2 pl-6">
                        <li>Smart Shift now shows today&apos;s solar and uses it to compare start times.</li>
                        <li>
                            Solcast&apos;s home plan allows about 10 requests a day, resetting at midnight UTC. PWUsage budgets
                            them for you: it refreshes the forecast on its own when the saved one gets old, and keeps some
                            requests in reserve for you.
                        </li>
                        <li>
                            Each forecast refresh uses one request per array, and each tap of <strong>Discover arrays</strong> uses one.
                            The <strong>Request usage</strong> section of Solar Forecast settings shows today&apos;s count.
                        </li>
                        <li>
                            Other apps that use the same Solcast account, such as a home automation hub, share the same daily limit.
                        </li>
                        <li>
                            Your key stays on this device. It&apos;s kept in the iOS Keychain, isn&apos;t synced to your other
                            devices and is never sent to the PWUsage server. To use a forecast on another iPhone or iPad,
                            connect it there too.
                        </li>
                        <li>
                            To stop, tap <strong>Disconnect Solar forecast</strong> in Solar Forecast settings. Smart Shift
                            carries on without the forecast.
                        </li>
                    </ul>
                </Step>

                <Step number={7} title="Troubleshooting">
                    <p>These are the messages you might see, word for word, and what to do about them.</p>

                    <Problem
                        title="No array is turned on"
                        messages={['Choose your solar arrays to add a forecast. Your estimate below already works without it.']}
                    >
                        <p>
                            Your key is saved, but no array is selected. Open Solar Forecast settings and turn on at least one array.
                        </p>
                    </Problem>

                    <Problem
                        title="Solcast rejected the key"
                        messages={[
                            'Solcast rejected this API key. Check or replace it.',
                            'Solar forecast unavailable — using tariff and balance data. Solcast rejected the saved key. Retry from Solar forecast settings.',
                        ]}
                    >
                        <p>
                            Copy the key from the Solcast Toolkit again, paste it in Solar Forecast settings and
                            tap <strong>Replace key</strong>. Make sure you copied the whole key.
                        </p>
                    </Problem>

                    <Problem
                        title="Solcast doesn't recognise a Solar System ID"
                        messages={[
                            'Solcast does not recognise that Solar System ID. Tap Discover arrays and choose from the list.',
                            'Solar forecast unavailable — using tariff and balance data. Solcast does not recognise one of your Solar System IDs, so that request counted as an attempt. Choose your arrays again in Solar forecast settings.',
                        ]}
                    >
                        <p>
                            This usually means an ID was typed in by hand, or a site was deleted or re-added in the Toolkit.
                            Tap <strong>Discover arrays</strong> and turn on your arrays from the list.
                        </p>
                    </Problem>

                    <Problem
                        title="Daily limit reached"
                        messages={[
                            'This device has used its Solcast request allowance for today. Try again tomorrow.',
                            'Solcast is limiting requests right now. Your key is saved; try again later.',
                        ]}
                    >
                        <p>
                            Requests reset at midnight UTC, and Smart Shift keeps working without the forecast until then.
                            If you hit the limit often, check whether another app is using the same Solcast account.
                        </p>
                    </Problem>
                </Step>
            </ol>

            <p className="mt-8 text-foreground/80">
                Still stuck? See <Link href="/support" className={linkClass}>pwusage Support</Link>. Never include your
                Solcast API key when you ask for help.
            </p>
        </PageShell>
    );
}
