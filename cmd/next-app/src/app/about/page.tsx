import Image from 'next/image';

import { Card, CardBody } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';

export default function AboutPage() {
    return (
        <PageShell maxWidth="lg" padding="default" fullHeight={false}>
            <PageHeader title="About Powerwall Usage" className="mb-8" />

            <div className="space-y-8">
                <p className="text-xl text-gray-700 dark:text-gray-200">
                    We use the data from your Tesla Powerwall gateway to assist in monitoring your electricity consumption.
                    This helps you make smart decisions about when best to use energy in your home to <strong>save money using energy arbitrage</strong>.
                </p>

                <section>
                    <SectionCard className="overflow-hidden">
                        <div className="-m-6">
                            <Image
                                src="/energy-arbitrage.png"
                                alt="Energy Arbitrage Infographic describing the savings of storing solar energy vs selling it back to the grid"
                                width={1024}
                                height={1024}
                                className="w-full h-auto"
                            />
                        </div>
                    </SectionCard>
                    <p className="mt-2 text-center text-sm text-gray-500">
                        Visualizing the cost difference between selling excess solar and using it from a battery.
                    </p>
                </section>

                <SectionCard title="Why use this app?">
                    <div className="space-y-6 text-gray-700 dark:text-gray-300">
                        <p>
                            Most solar systems include monitoring to help you see how much energy your system is producing.
                            Where this app really shines is with <strong>Time of Use billing</strong>.
                        </p>

                        <div>
                            <h2 className="mb-4 text-2xl font-bold text-gray-900 dark:text-gray-100">Time of Use (TOU) Billing</h2>
                            <p className="mb-4">
                                Most people are used to flat rates for their electricity.
                                <em>Time of Use (TOU)</em> billing is a billing strategy where the cost of electricity varies based on the time of day.
                                Most utilities have a choice to use this billing strategy.
                                Your time of use billing is usually separated into multiple time-based <em>Tariff Periods</em>, such as On-Peak and Off-Peak.
                                Each <em>Tariff Period</em> has its rate or <em>Tariff</em> that you pay for electricity in that period.
                                If you have a solar system and a battery it is likely you can save a lot of money on a TOU plan.
                            </p>
                        </div>

                        <Card className="bg-gray-100 dark:bg-gray-800 border-gray-200 dark:border-gray-700">
                            <CardBody>
                                <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
                                    Example of shifting solar to Off-Peak periods to save money:
                                </h3>
                                <ul className="list-disc space-y-2 pl-6">
                                    <li>On Peak OverProduction nets a credit: 500 kwh * $0.055 / kwh = <strong className="text-green-600">$27.50</strong></li>
                                    <li>Off Peak Consumption: 500 kwh * $0.106 / kwh = <strong className="text-red-600">$53.00</strong></li>
                                </ul>
                                <p className="mt-4 font-semibold text-gray-900 dark:text-gray-100">
                                    Loss: <span className="text-red-600">$53.00</span> - <span className="text-green-600">$27.50</span> = <span className="text-red-600">$25.50</span> per month
                                </p>
                            </CardBody>
                        </Card>

                        <p>
                            Most people simply try to avoid consuming power during the <strong>Peak</strong> billing rates and shift usage to <strong>Off-Peak</strong> rates.
                            However, your solar production happens mostly during the day during your expensive rate periods.
                            Having solar and a battery can help you store excess solar energy and use it when you most benefit from it.
                            <strong>This application helps you figure out when that is.</strong>
                        </p>
                    </div>
                </SectionCard>

                <SectionCard title="Monitoring Your Bill">
                    <div className="space-y-4 text-gray-700 dark:text-gray-300">
                        <p>
                            Knowing how much energy you are importing and exporting during each <em>Tariff Period</em> helps you understand your energy consumption
                            and will help you make smart decisions about when best to use energy in your home.
                        </p>
                        <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
                            <Image
                                src="/estimated-bill-v2.png"
                                alt="Estimated Power Bill Example showing cost breakdown by tariff period"
                                width={1024}
                                height={1024}
                                className="w-full h-auto"
                            />
                        </div>
                        <p>
                            The goal is to use your estimated bill to monitor energy usage and consumption across your tariff periods.
                            With this app you can try to keep usage in your expensive periods to a minimum.
                        </p>
                    </div>
                </SectionCard>

                <SectionCard title="Glossary">
                    <dl className="grid grid-cols-1 gap-x-4 gap-y-4 md:grid-cols-2">
                        <Card className="bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700">
                            <CardBody className="space-y-1">
                                <dt className="font-bold text-gray-900 dark:text-gray-100">Time of Use</dt>
                                <dd className="text-gray-700 dark:text-gray-300">
                                    A billing strategy where the cost of electricity varies based on the time of day.
                                    There is usually multiple <em>Tariff Periods</em> with different rates or <em>Tariffs</em> for consuming energy from the grid and selling your solar overproduction.
                                    <br />
                                    <span className="text-sm italic text-gray-500">Example: On-Peak $0.31 / kWh, Off-Peak $0.106 / kWh</span>
                                </dd>
                            </CardBody>
                        </Card>
                        <Card className="bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700">
                            <CardBody className="space-y-1">
                                <dt className="font-bold text-gray-900 dark:text-gray-100">Tariff</dt>
                                <dd className="text-gray-700 dark:text-gray-300">A rate per kWh for electricity that you purchase from the grid and usually a separate rate for selling back to the grid.</dd>
                            </CardBody>
                        </Card>
                        <Card className="bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700">
                            <CardBody className="space-y-1">
                                <dt className="font-bold text-gray-900 dark:text-gray-100">Tariff Period</dt>
                                <dd className="text-gray-700 dark:text-gray-300">
                                    A range of time and the tariff it is being billed at.
                                    <br />
                                    <span className="text-sm italic text-gray-500">Example: Monday 8am-8pm Tariff: On-Peak</span>
                                </dd>
                            </CardBody>
                        </Card>
                        <Card className="bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700">
                            <CardBody className="space-y-1">
                                <dt className="font-bold text-gray-900 dark:text-gray-100">Arbitrage</dt>
                                <dd className="text-gray-700 dark:text-gray-300">Buying energy at the lowest price possible and selling it at the highest price possible.</dd>
                            </CardBody>
                        </Card>
                    </dl>
                </SectionCard>
            </div>
        </PageShell>
    );
}
