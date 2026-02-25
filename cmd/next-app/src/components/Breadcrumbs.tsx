'use client';

import Link from 'next/link';

export interface BreadcrumbItem {
    label: string | React.ReactNode;
    href?: string;
}

export function Breadcrumbs({ items }: { items: BreadcrumbItem[] }) {
    if (!items || items.length === 0) return null;

    return (
        <nav aria-label="Breadcrumb">
            <ol className="flex flex-wrap items-center space-x-2 text-sm text-secondary">
                {items.map((item, index) => {
                    const isLast = index === items.length - 1;
                    return (
                        <li key={index} className="flex items-center">
                            {index > 0 && (
                                <svg
                                    className="w-4 h-4 mx-2 text-secondary/70"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                    xmlns="http://www.w3.org/2000/svg"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M9 5l7 7-7 7"
                                    />
                                </svg>
                            )}
                            {item.href && !isLast ? (
                                <Link
                                    href={item.href}
                                    className="rounded px-1 py-0.5 text-secondary hover:text-primary hover:bg-bg-muted transition-colors"
                                >
                                    {item.label}
                                </Link>
                            ) : (
                                <div className={isLast ? 'font-semibold text-primary' : 'text-secondary'}>
                                    {item.label}
                                </div>
                            )}
                        </li>
                    );
                })}
            </ol>
        </nav>
    );
}
