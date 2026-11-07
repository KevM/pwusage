import Image from 'next/image';
import Link from 'next/link';

import { Card, CardBody } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';

const GLOSSARY: { term: string; definition: string; example?: string }[] = [
    {
        term: 'Time of Use rate plan',
        definition:
            'A rate plan where the price of grid power depends on the time of day. The day is split into rate periods, each with its own rate.',
        example: 'Example: Peak $0.31/kWh · Off-Peak $0.106/kWh',
    },
    {
        term: 'Rate period',
        definition: 'A window of time in your rate plan with its own rate, like Peak or Off-Peak.',
        example: 'Example: Monday to Friday, 8 AM to 8 PM · Peak',
    },
    {
        term: 'Grid rate',
        definition:
            'What you pay per kWh for power from the grid in a rate period. Most plans credit exported solar at a separate, lower rate.',
    },
    {
        term: 'Energy arbitrage',
        definition:
            'Storing energy when it is cheap and using it when it is expensive. With a Powerwall, that means filling the battery Off-Peak or from solar, and using it during Peak.',
    },
];

export default function AboutPage() {
    return (
        <PageShell maxWidth="lg" padding="default" fullHeight={false}>
            <PageHeader title="About Powerwall Usage" className="mb-8" />

            <div className="space-y-8">
                <p className="text-xl text-gray-700 dark:text-gray-200">
                    Powerwall Usage helps you save money with a Powerwall on a Time of Use rate plan. Time your heavy energy
                    use for when grid power is cheapest, and save your battery for when rates spike. If you have solar, the
                    savings get even better.
                </p>

                <section>
                    <SectionCard className="overflow-hidden">
                        <div className="-m-6">
                            <Image
                                src="/energy-arbitrage.png"
                                alt="Energy arbitrage infographic comparing selling excess solar to the grid with storing it in a battery"
                                width={1024}
                                height={1024}
                                className="w-full h-auto"
                            />
                        </div>
                    </SectionCard>
                    <p className="mt-2 text-center text-sm text-gray-500">
                        The cost difference between selling excess solar and using it from a battery.
                    </p>
                </section>

                <SectionCard title="Time of Use rate plans">
                    <div className="space-y-6 text-gray-700 dark:text-gray-300">
                        <p>
                            Most people are used to paying one flat rate for electricity. On a <strong>Time of Use</strong>{' '}
                            rate plan, the price depends on when you use it. Your utility splits the day into{' '}
                            <em>rate periods</em>, like Peak and Off-Peak, and each rate period has its own rate. Peak is
                            often two or three times the Off-Peak rate.
                        </p>
                        <p>
                            A Powerwall turns that difference into savings. It stores energy when grid power is cheap, or
                            from your solar panels, and powers your home during Peak instead of the grid. That is{' '}
                            <strong>energy arbitrage</strong>, and it is where Powerwall Usage helps the most.
                        </p>

                        <Card className="bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700">
                            <CardBody>
                                <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
                                    Example: selling solar at Peak, then buying power back Off-Peak
                                </h3>
                                <ul className="list-disc space-y-2 pl-6">
                                    <li>
                                        Export 500 kWh of solar during Peak, credited at $0.055/kWh:{' '}
                                        <strong className="text-green-600">$27.50</strong>
                                    </li>
                                    <li>
                                        Buy 500 kWh back Off-Peak at $0.106/kWh:{' '}
                                        <strong className="text-red-600">$53.00</strong>
                                    </li>
                                </ul>
                                <p className="mt-4 font-semibold text-gray-900 dark:text-gray-100">
                                    You pay <span className="text-red-600">$25.50</span> more each month than if your
                                    Powerwall had stored that energy for later.
                                </p>
                            </CardBody>
                        </Card>

                        <p>
                            The trick is knowing when to store, when to use the battery and when to run heavy jobs.{' '}
                            <strong>Powerwall Usage helps you work that out.</strong>
                        </p>
                    </div>
                </SectionCard>

                <SectionCard title="How Powerwall Usage helps">
                    <ul className="list-disc space-y-3 pl-6 text-gray-700 dark:text-gray-300">
                        <li>
                            <strong>Smart Shift</strong> finds the cheapest time to start a job, like charging the car or
                            running the dishwasher, and shows about how much you save.
                        </li>
                        <li>
                            <strong>Battery Saver</strong> saves your Powerwall charge for when rates spike, then restores
                            your previous backup reserve.
                        </li>
                        <li>
                            <strong>Your bill, so far</strong> shows what you have spent in each rate period this billing
                            cycle and estimates the total.
                        </li>
                        <li>
                            Take it with you in the <Link href="/ios" className="text-primary underline">iPhone and iPad app</Link>,
                            now in beta.
                        </li>
                    </ul>
                </SectionCard>

                <SectionCard title="Following your bill">
                    <div className="space-y-4 text-gray-700 dark:text-gray-300">
                        <p>
                            Knowing how much energy you import and export in each rate period shows you where your money
                            goes, and when it is best to use energy in your home.
                        </p>
                        <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
                            <Image
                                src="/estimated-bill-v2.png"
                                alt="Estimated bill example showing the cost in each rate period"
                                width={1024}
                                height={1024}
                                className="w-full h-auto"
                            />
                        </div>
                        <p>
                            Use your estimated bill to keep energy use in your most expensive rate periods as low as you
                            can.
                        </p>
                    </div>
                </SectionCard>

                <SectionCard title="Glossary">
                    <dl className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2">
                        {GLOSSARY.map((entry) => (
                            <Card key={entry.term} className="bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700">
                                <CardBody className="space-y-1">
                                    <dt className="font-bold text-gray-900 dark:text-gray-100">{entry.term}</dt>
                                    <dd className="text-gray-700 dark:text-gray-300">
                                        {entry.definition}
                                        {entry.example ? (
                                            <>
                                                <br />
                                                <span className="text-sm italic text-gray-500">{entry.example}</span>
                                            </>
                                        ) : null}
                                    </dd>
                                </CardBody>
                            </Card>
                        ))}
                    </dl>
                </SectionCard>
            </div>
        </PageShell>
    );
}
