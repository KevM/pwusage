'use client';

interface TocItem {
    id: string;
    label: string;
}

interface StyleGuideTocProps {
    items: TocItem[];
}

export function StyleGuideToc({ items }: StyleGuideTocProps) {
    const handleScroll = (id: string) => {
        const target = document.getElementById(id);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    return (
        <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Table of Contents</h2>
            <div className="grid grid-cols-1 gap-1.5 text-sm">
                {items.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        onClick={() => handleScroll(item.id)}
                        className="text-left text-primary hover:underline"
                    >
                        {item.label}
                    </button>
                ))}
            </div>
        </section>
    );
}
