import { BreadcrumbItem, Breadcrumbs } from '@/components/Breadcrumbs';

export function PageBreadcrumbs({ items }: { items: BreadcrumbItem[] }) {
    return (
        <div className="mb-6 pt-1">
            <Breadcrumbs items={items} />
        </div>
    );
}
