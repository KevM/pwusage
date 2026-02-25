'use client';

import Image from 'next/image';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { PageShell } from '@/components/ui/PageShell';
import { SectionCard } from '@/components/ui/SectionCard';

interface FeatureCardProps {
    title: string;
    description: string;
    icon: ReactNode;
    iconToneClassName: string;
}

function FeatureCard({ title, description, icon, iconToneClassName }: FeatureCardProps) {
    return (
        <SectionCard density="compact">
            <div className="space-y-4">
                <div className={`flex h-12 w-12 items-center justify-center rounded-lg ${iconToneClassName}`}>
                    {icon}
                </div>
                <div>
                    <h3 className="mb-2 text-xl font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
                    <p className="text-gray-600 dark:text-gray-400">{description}</p>
                </div>
            </div>
        </SectionCard>
    );
}

export default function TrmnlHelpPage() {
    return (
        <PageShell maxWidth="lg" padding="relaxed" fullHeight={false}>
            <PageHeader
                className="mb-12"
                title={<span className="block text-center">Your Energy on Display</span>}
                description={(
                    <span className="mx-auto block max-w-2xl text-center text-base sm:text-xl">
                        Visualize your home&apos;s energy production and consumption at a glance with Trmnl.
                        Always on, zero distractions.
                    </span>
                )}
            />

            <SectionCard className="mb-12 overflow-hidden" bodyClassName="p-0">
                <div className="relative aspect-video w-full bg-gray-100 dark:bg-gray-900">
                    <Image
                        src="/trmnl-real.jpg"
                        alt="Trmnl E-ink Display showing Energy Dashboard"
                        fill
                        className="object-cover"
                        priority
                    />
                </div>
            </SectionCard>

            <div className="mb-12 grid gap-6 md:grid-cols-3">
                <FeatureCard
                    title="Smart Insights"
                    description="See exactly how much solar you produce versus what you consume from the grid in real-time."
                    iconToneClassName="bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400"
                    icon={(
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                    )}
                />
                <FeatureCard
                    title="Tariff Awareness"
                    description="Optimize your usage by tracking consumption during On-Peak vs Off-Peak billing periods."
                    iconToneClassName="bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400"
                    icon={(
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                    )}
                />
                <FeatureCard
                    title="Always On"
                    description="Zero-distraction e-ink display that blends into your home while keeping you informed."
                    iconToneClassName="bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400"
                    icon={(
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                        </svg>
                    )}
                />
            </div>

            <SectionCard
                title={<span className="block text-center">Ready to get started?</span>}
                className="bg-gray-50 dark:bg-gray-800/50"
                bodyClassName="pt-2"
            >
                <p className="mx-auto mb-8 max-w-xl text-center text-lg text-gray-600 dark:text-gray-300">
                    Connect your Trmnl device to your energy dashboard in just a few clicks.
                </p>
                <div className="flex flex-col justify-center gap-4 sm:flex-row">
                    <a
                        href="https://trmnl.com/plugin_settings/new?keyname=powerwall_energy_usage"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        <Button renderAs="span" size="lg">
                            Setup Device
                        </Button>
                    </a>
                    <a
                        href="https://trmnl.com"
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        <Button renderAs="span" size="lg" variant="outline">
                            Learn about Trmnl
                        </Button>
                    </a>
                </div>
            </SectionCard>
        </PageShell>
    );
}
