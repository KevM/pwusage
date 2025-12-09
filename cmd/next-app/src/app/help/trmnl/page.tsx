'use client';

import Image from 'next/image';
import Link from 'next/link';

export default function TrmnlHelpPage() {
    return (
        <div className="max-w-4xl mx-auto px-6 py-12">
            <div className="text-center mb-16">
                <h1 className="text-4xl md:text-5xl font-bold mb-6 text-gray-900 dark:text-gray-100">
                    Your Energy on Display
                </h1>
                <p className="text-xl text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
                    Visualize your home's energy production and consumption at a glance with Trmnl.
                    Always on, zero distractions.
                </p>
            </div>

            <div className="mb-16 rounded-2xl overflow-hidden shadow-2xl border border-gray-200 dark:border-gray-800">
                <div className="relative aspect-video w-full bg-gray-100 dark:bg-gray-900">
                    <Image
                        src="/trmnl-real.jpg"
                        alt="Trmnl E-ink Display showing Energy Dashboard"
                        fill
                        className="object-cover"
                        priority
                    />
                </div>
            </div>

            <div className="grid md:grid-cols-3 gap-8 mb-16">
                <div className="p-6 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
                    <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/30 rounded-lg flex items-center justify-center mb-4 text-blue-600 dark:text-blue-400">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                    </div>
                    <h3 className="text-xl font-semibold mb-2">Smart Insights</h3>
                    <p className="text-gray-600 dark:text-gray-400">
                        See exactly how much solar you produce versus what you consume from the grid in real-time.
                    </p>
                </div>
                <div className="p-6 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
                    <div className="w-12 h-12 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center mb-4 text-green-600 dark:text-green-400">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                    </div>
                    <h3 className="text-xl font-semibold mb-2">Tariff Awareness</h3>
                    <p className="text-gray-600 dark:text-gray-400">
                        Optimize your usage by tracking consumption during On-Peak vs Off-Peak billing periods.
                    </p>
                </div>
                <div className="p-6 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
                    <div className="w-12 h-12 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center mb-4 text-gray-600 dark:text-gray-400">
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                    </div>
                    <h3 className="text-xl font-semibold mb-2">Always On</h3>
                    <p className="text-gray-600 dark:text-gray-400">
                        Zero-distraction e-ink display that blends into your home while keeping you informed.
                    </p>
                </div>
            </div>

            <div className="bg-gray-50 dark:bg-gray-800/50 rounded-2xl p-8 md:p-12 text-center">
                <h2 className="text-3xl font-bold mb-4">Ready to get started?</h2>
                <p className="text-lg text-gray-600 dark:text-gray-300 mb-8 max-w-xl mx-auto">
                    Connect your Trmnl device to your energy dashboard in just a few clicks.
                </p>
                <div className="flex flex-col sm:flex-row gap-4 justify-center">
                    <a
                        href="https://usetrmnl.com/plugin_settings/new?keyname=powerwall_energy_usage"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center px-8 py-3 text-base font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
                    >
                        Setup Device
                    </a>
                    <a
                        href="https://usetrmnl.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center px-8 py-3 text-base font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition-colors"
                    >
                        Learn about Trmnl
                    </a>
                </div>
            </div>
        </div>
    );
}
