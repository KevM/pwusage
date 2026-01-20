import Image from 'next/image';

export default function AboutPage() {
    return (
        <div className="container mx-auto px-4 py-8 max-w-4xl">
            <h1 className="text-4xl font-bold mb-8 text-gray-900 dark:text-gray-100">About Powerwall Usage</h1>

            <div className="prose dark:prose-invert max-w-none">
                <p className="text-xl mb-6">
                    We use the data from your Tesla Powerwall gateway to assist in monitoring your electricity consumption.
                    This helps you make smart decisions about when best to use energy in your home to <strong>save money using energy arbitrage</strong>.
                </p>

                <section className="mb-12">
                    <div className="bg-white dark:bg-gray-900 rounded-xl overflow-hidden shadow-lg border border-gray-200 dark:border-gray-700">
                        <Image
                            src="/energy-arbitrage.png"
                            alt="Energy Arbitrage Infographic describing the savings of storing solar energy vs selling it back to the grid"
                            width={1024}
                            height={1024}
                            className="w-full h-auto"
                        />
                    </div>
                    <p className="text-sm text-center text-gray-500 mt-2">
                        Visualizing the cost difference between selling excess solar and using it from a battery.
                    </p>
                </section>

                <section className="mb-12">
                    <h2 className="text-2xl font-bold mb-4">Why use this app?</h2>
                    <p className="mb-4">
                        Most solar systems include monitoring to help you see how much energy your system is producing.
                        Where this app really shines is with <strong>Time of Use billing</strong>.
                    </p>

                    <h2 className="text-2xl font-bold mb-4">Time of Use (TOU) Billing</h2>
                    <p className="mb-4">
                        Most people are used to flat rates for their electricity.
                        <em>Time of Use (TOU)</em> billing is a billing strategy where the cost of electricity varies based on the time of day.
                        Most utilities have a choice to use this billing strategy.
                        Your time of use billing is usually separated into multiple time-based <em>Tariff Periods</em>, such as On-Peak and Off-Peak.
                        Each <em>Tariff Period</em> has its rate or <em>Tariff</em> that you pay for electricity in that period.
                        If you have a solar system and a battery it is likely you can save a lot of money on a TOU plan.
                    </p>

                    <div className="bg-gray-100 dark:bg-gray-800 p-6 rounded-lg my-6">
                        <h3 className="text-lg font-semibold mb-2">Example of shifting solar to Off-Peak periods to save money:</h3>
                        <ul className="list-disc pl-6 space-y-2">
                            <li>On Peak OverProduction nets a credit: 500 kwh * $0.055 / kwh = <strong className="text-green-600">$27.50</strong></li>
                            <li>Off Peak Consumption: 500 kwh * $0.106 / kwh = <strong className="text-red-600">$53.00</strong></li>
                        </ul>
                        <p className="mt-4 font-semibold">
                            Loss: <span className="text-red-600">$53.00</span> - <span className="text-green-600">$27.50</span> = <span className="text-red-600">$25.50</span> per month
                        </p>
                    </div>

                    <p className="mb-4">
                        Most people simply try to avoid consuming power during the <strong>Peak</strong> billing rates and shift usage to <strong>Off-Peak</strong> rates.
                        However, your solar production happens mostly during the day during your expensive rate periods.
                        Having solar and a battery can help you store excess solar energy and use it when you most benefit from it.
                        <strong>This application helps you figure out when that is.</strong>
                    </p>
                </section>

                <section className="mb-12">
                    <h2 className="text-2xl font-bold mb-6">Monitoring Your Bill</h2>
                    Knowing how much energy you are importing and exporting during each <em>Tariff Period</em> helps you understand your energy consumption
                    and will help you make smart decisions about when best to use energy in your home.
                    <div className="bg-white dark:bg-gray-900 rounded-xl overflow-hidden shadow-lg border border-gray-200 dark:border-gray-700">
                        <Image
                            src="/estimated-bill-v2.png"
                            alt="Estimated Power Bill Example showing cost breakdown by tariff period"
                            width={1024}
                            height={1024}
                            className="w-full h-auto"
                        />
                    </div>
                    <p className="mt-4">
                        The goal is to use your estimated bill to monitor energy usage and consumption across your tariff periods.
                        With this app you can try to keep usage in your expensive periods to a minimum.
                    </p>
                </section>

                <section className="mb-8">
                    <h2 className="text-2xl font-bold mb-4">Glossary</h2>
                    <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-4">
                        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-md">
                            <dt className="font-bold mb-1">Time of Use</dt>
                            <dd>
                                A billing strategy where the cost of electricity varies based on the time of day.
                                There is usually multiple <em>Tariff Periods</em> with different rates or <em>Tariffs</em> for consuming energy from the grid and selling your solar overproduction.
                                <br />
                                <span className="text-sm text-gray-500 italic">Example: On-Peak $0.31 / kWh, Off-Peak $0.106 / kWh</span>
                            </dd>
                        </div>
                        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-md">
                            <dt className="font-bold mb-1">Tariff</dt>
                            <dd>A rate per kWh for electricity that you purchase from the grid and usually a separate rate for selling back to the grid.</dd>
                        </div>
                        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-md">
                            <dt className="font-bold mb-1">Tariff Period</dt>
                            <dd>A range of time and the tariff it is being billed at.
                                <br />
                                <span className="text-sm text-gray-500 italic">Example: Monday 8am-8pm Tariff: On-Peak</span>
                            </dd>
                        </div>
                        <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-md">
                            <dt className="font-bold mb-1">Arbitrage</dt>
                            <dd>Buying energy at the lowest price possible and selling it at the highest price possible.</dd>
                        </div>
                    </dl>
                </section>
            </div>
        </div >
    );
}
